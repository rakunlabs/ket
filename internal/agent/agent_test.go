package agent

import (
	"context"
	"encoding/json"
	"errors"
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

func TestRetriesWithoutStreamOptions(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		var req chatRequest
		_ = json.NewDecoder(r.Body).Decode(&req)
		if req.StreamOptions != nil {
			w.WriteHeader(http.StatusBadRequest)
			fmt.Fprint(w, `{"error":{"message":"Unrecognized request argument supplied: stream_options"}}`)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer srv.Close()
	c := &client{p: settings.Provider{Name: "strict", BaseURL: srv.URL, Model: "strict-m"}, http: http.DefaultClient}
	for i := 0; i < 2; i++ {
		m, u, err := c.completeUsage(context.Background(), []Message{{Role: "user", Content: textContent("hi")}}, nil, func(string) {})
		if err != nil || m.Text() != "ok" || !u.Estimated {
			t.Fatalf("round %d: %q %+v %v", i, m.Text(), u, err)
		}
	}
	// The refusal is remembered: the second round asks without the option at once.
	if calls != 3 {
		t.Fatalf("%d requests, want 3", calls)
	}
}

func TestAnsweredFillsMissingToolResults(t *testing.T) {
	h := []Message{
		{Role: "user", Content: textContent("go")},
		{Role: "assistant", ToolCalls: []ToolCall{{ID: "a"}, {ID: "b"}}},
		{Role: "tool", ToolCallID: "a", Content: textContent("done")},
		{Role: "user", Content: textContent("next")},
	}
	got := answered(h)
	if len(got) != 5 || got[3].Role != "tool" || got[3].ToolCallID != "b" || got[4].Text() != "next" {
		t.Fatalf("answered: %+v", got)
	}
	if len(answered(got)) != 5 {
		t.Fatal("answered is not idempotent")
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

// Two servers (two Agents on one database): one turn per conversation, and
// Stop on either server ends it.
func TestTurnLeaseAcrossServers(t *testing.T) {
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

	// A provider that answers only when released: the first turn stays running.
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"}}]}\n\ndata: [DONE]\n\n")
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	set, err := settings.Load(ctx, st, settings.Settings{})
	if err != nil {
		t.Fatal(err)
	}
	cur := set.Get()
	cur.Providers = []settings.Provider{{Name: "slow", BaseURL: srv.URL, Model: "m"}}
	cur.MonthlyTokens = 0
	if _, err := set.Update(ctx, cur, nil, []string{"admin", "editor", "viewer"}, "test"); err != nil {
		t.Fatal(err)
	}
	cat, err := catalog.Load()
	if err != nil {
		t.Fatal(err)
	}
	tools := mcpserver.NewTools(cat, hub.New(st, config.Hub{}), st)
	one, two := New(set, tools, st), New(set, tools, st)

	p, err := st.CreateProject(ctx, "lease test", "", "")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.DeleteProject(ctx, p.ID) })
	conv, err := st.CreateConversation(ctx, p.ID, "")
	if err != nil {
		t.Fatal(err)
	}

	done := make(chan error, 1)
	go func() { done <- one.Run(ctx, conv, "", "first", false, func(Event) {}) }()
	// Wait until the first turn holds the lease. Only looked at, never taken:
	// a probe that takes the lease for a moment can make the first turn find
	// the conversation busy.
	deadline := time.Now().Add(10 * time.Second)
	for {
		_, lost, err := st.TurnStop(ctx, conv.ID, one.id)
		if err != nil {
			t.Fatal(err)
		}
		if !lost {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("the first turn ended before it took the lease: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("the first turn never took the lease")
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := two.Run(ctx, conv, "", "second", false, func(Event) {}); !errors.Is(err, ErrBusy) {
		t.Fatalf("second server: %v, want ErrBusy", err)
	}
	if !two.Stop(conv.ID) {
		t.Fatal("stop on the other server found no running turn")
	}
	// The running turn polls for a stop every second.
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "stopped") {
			t.Fatalf("first turn ended with %v, want stopped", err)
		}
	case <-time.After(5 * stopPoll):
		t.Fatal("the first turn did not stop")
	}
	if ok, _ := st.AcquireTurn(ctx, conv.ID, "someone", time.Second); !ok {
		t.Fatal("the lease was not released")
	}
	_ = st.ReleaseTurn(ctx, conv.ID, "someone")
}
