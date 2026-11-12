package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rakunlabs/ket/internal/catalog"
	"github.com/rakunlabs/ket/internal/config"
	"github.com/rakunlabs/ket/internal/hub"
	"github.com/rakunlabs/ket/internal/mcpserver"
	"github.com/rakunlabs/ket/internal/settings"
	"github.com/rakunlabs/ket/internal/store"
)

// A fake OpenAI-compatible server: streams the given text and, when usage is
// set, a final chunk with token usage (as stream_options.include_usage asks).
func fakeProvider(t *testing.T, reply func(req chatRequest) string, usage bool) (*httptest.Server, *[]chatRequest) {
	t.Helper()
	var mu sync.Mutex
	seen := []chatRequest{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req chatRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		mu.Lock()
		seen = append(seen, req)
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		text := reply(req)
		b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"delta": map[string]any{"content": text}}}})
		fmt.Fprintf(w, "data: %s\n\n", b)
		if usage {
			fmt.Fprintf(w, "data: %s\n\n", `{"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":7}}`)
		}
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	t.Cleanup(srv.Close)

	return srv, &seen
}

func TestUsageFromStream(t *testing.T) {
	srv, seen := fakeProvider(t, func(chatRequest) string { return "ok" }, true)
	c := &client{p: settings.Provider{Name: "fake", BaseURL: srv.URL, Model: "m"}, http: http.DefaultClient}
	m, u, err := c.completeUsage(context.Background(), []Message{{Role: "user", Content: textContent("hi")}}, nil, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if m.Text() != "ok" || u.PromptTokens != 120 || u.CompletionTokens != 7 || u.Estimated {
		t.Fatalf("got %q %+v", m.Text(), u)
	}
	if (*seen)[0].StreamOptions == nil || !(*seen)[0].StreamOptions.IncludeUsage {
		t.Fatal("the request did not ask for usage")
	}
}

func TestUsageEstimatedWhenNotReported(t *testing.T) {
	srv, _ := fakeProvider(t, func(chatRequest) string { return strings.Repeat("word ", 40) }, false)
	c := &client{p: settings.Provider{Name: "fake", BaseURL: srv.URL, Model: "m"}, http: http.DefaultClient}
	_, u, err := c.completeUsage(context.Background(), []Message{{Role: "user", Content: textContent(strings.Repeat("x", 400))}}, nil, func(string) {})
	if err != nil {
		t.Fatal(err)
	}
	if !u.Estimated || u.PromptTokens < 100 || u.CompletionTokens < 40 {
		t.Fatalf("estimate %+v", u)
	}
}

func TestEstimateCountsImages(t *testing.T) {
	img := Message{Role: "user", Content: json.RawMessage(`[{"type":"text","text":"look"},{"type":"image_url","image_url":{"url":"data:x"}}]`)}
	if n := estimateTokens([]Message{img}, nil); n < 800 {
		t.Fatalf("an image should count about 800 tokens, got %d", n)
	}
}

func TestWithSummary(t *testing.T) {
	h := []Message{{Role: "user", Content: textContent("next")}}
	if got := withSummary("", h); len(got) != 1 {
		t.Fatal("no summary: history as is")
	}
	got := withSummary("built a case", h)
	if len(got) != 3 || !strings.Contains(got[0].Text(), "built a case") || got[1].Role != "assistant" || got[2].Text() != "next" {
		t.Fatalf("summary messages: %+v", got)
	}
}

// End to end with PostgreSQL: usage rows, the monthly limit and compaction.
func TestRunRecordsUsageAndCompacts(t *testing.T) {
	dsn := os.Getenv("KET_TEST_DSN")
	if dsn == "" {
		t.Skip("KET_TEST_DSN is not set")
	}
	ctx := context.Background()
	st, err := store.New(ctx, config.Store{Postgres: config.Postgres{DSN: dsn, MaxOpenConns: 4, Migrate: true}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)

	srv, seen := fakeProvider(t, func(req chatRequest) string {
		if strings.Contains(req.Messages[0].Text(), "You condense") {
			return "SUMMARY: the user wants a 40 mm case"
		}
		return strings.Repeat("reply ", 200)
	}, true)
	set, err := settings.Load(ctx, st, settings.Settings{})
	if err != nil {
		t.Fatal(err)
	}
	cur := set.Get()
	cur.Providers = []settings.Provider{{Name: "fake", BaseURL: srv.URL, Model: "m"}}
	cur.CompactTokens = 4000
	cur.MonthlyTokens = 0
	if _, err := set.Update(ctx, cur, nil, []string{"admin", "editor", "viewer"}, "test"); err != nil {
		t.Fatal(err)
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	a := New(set, mcpserver.NewTools(cat, hub.New(st, config.Hub{}), st), st)

	p, err := st.CreateProject(ctx, "agent usage test", "", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteProject(ctx, p.ID) })
	conv, err := st.CreateConversation(ctx, p.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	// Enough turns to pass 4000 tokens.
	for i := 0; i < 20; i++ {
		if err := a.Run(ctx, conv, "", fmt.Sprintf("turn %d: %s", i, strings.Repeat("make it bigger ", 30)), false, func(Event) {}); err != nil {
			t.Fatal(err)
		}
	}
	summary, upto, err := st.ConversationSummary(ctx, conv.ID)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(summary, "40 mm case") || upto == 0 {
		t.Fatalf("no compaction: %q upto %d", summary, upto)
	}
	last := (*seen)[len(*seen)-1]
	if !strings.Contains(last.Messages[1].Text(), "40 mm case") {
		t.Fatal("the summary is not sent in place of the old turns")
	}
	if n := len(last.Messages); n > keepRecent+10 {
		t.Fatalf("after compaction the request still has %d messages", n)
	}
	used, err := st.UsageTotal(ctx, "", monthStart(time.Now()))
	if err != nil || used < 20*127 {
		t.Fatalf("usage %d, %v", used, err)
	}

	// A limit already spent refuses the next turn with a clear message.
	cur.MonthlyTokens = 10
	if _, err := set.Update(ctx, cur, nil, []string{"admin", "editor", "viewer"}, "test"); err != nil {
		t.Fatal(err)
	}
	err = a.Run(ctx, conv, "", "one more", false, func(Event) {})
	if _, ok := err.(ErrOverBudget); !ok {
		t.Fatalf("over budget: got %v", err)
	}
}
