// Package agent is the built-in chat assistant. It runs the tool-calling
// loop on the server against any OpenAI-compatible endpoint, with the same
// tools MCP exposes, so the API key never reaches the browser.
package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/rakunlabs/ket/internal/mcpserver"
	"github.com/rakunlabs/ket/internal/settings"
	"github.com/rakunlabs/ket/internal/store"
)

var ErrBusy = errors.New("the assistant is already working in this conversation")

type Agent struct {
	settings *settings.Service
	tools    *mcpserver.Tools
	store    *store.Store
	http     *http.Client

	// OnBranch is told when a proposal branch is created, so open browsers
	// can follow it.
	OnBranch func(ctx context.Context, projectID string, b *store.Branch)

	mu      sync.Mutex
	running map[string]context.CancelFunc
}

func New(set *settings.Service, tools *mcpserver.Tools, st *store.Store) *Agent {
	return &Agent{
		settings: set,
		tools:    tools,
		store:    st,
		http:     &http.Client{Timeout: 10 * time.Minute},
		running:  map[string]context.CancelFunc{},
	}
}

func (a *Agent) onBranch(ctx context.Context, projectID string, b *store.Branch) {
	if a.OnBranch != nil {
		a.OnBranch(ctx, projectID, b)
	}
}

// ProviderInfo is what the UI may know about a provider.
type ProviderInfo struct {
	Name   string `json:"name"`
	Model  string `json:"model"`
	Vision bool   `json:"vision"`
}

// Providers lists the configured providers, the default first.
func (a *Agent) Providers() []ProviderInfo {
	cur := a.settings.Get()
	out := make([]ProviderInfo, 0, len(cur.Providers))
	for _, p := range cur.Providers {
		info := ProviderInfo{Name: p.Name, Model: p.Model, Vision: p.Vision}
		if p.Name == cur.DefaultProvider {
			out = append([]ProviderInfo{info}, out...)
		} else {
			out = append(out, info)
		}
	}

	return out
}

// ErrNoProvider means an administrator has not added an AI provider yet.
var ErrNoProvider = errors.New("no AI provider is set up: an administrator adds one in Settings → AI providers")

func (a *Agent) provider(name string) (settings.Provider, error) {
	cur := a.settings.Get()
	if len(cur.Providers) == 0 {
		return settings.Provider{}, ErrNoProvider
	}
	if name == "" {
		name = cur.DefaultProvider
	}
	if name == "" {
		return cur.Providers[0], nil
	}
	for _, p := range cur.Providers {
		if p.Name == name {
			return p, nil
		}
	}

	return settings.Provider{}, fmt.Errorf("unknown AI provider %q", name)
}

// Test sends a one-line prompt to a provider and reports what happened, for
// the admin page. A stored key is used when p.APIKey is empty.
func (a *Agent) Test(ctx context.Context, p settings.Provider) (string, error) {
	if p.APIKey == "" {
		for _, o := range a.settings.Get().Providers {
			if o.Name == p.Name {
				p.APIKey = o.APIKey
			}
		}
	}
	if p.BaseURL == "" {
		p.BaseURL = "https://api.openai.com/v1"
	}
	ctx, cancel := context.WithTimeout(ctx, 45*time.Second)
	defer cancel()
	c := &client{p: p, http: a.http}
	var text strings.Builder
	start := time.Now()
	_, err := c.complete(ctx, []Message{{Role: "user", Content: textContent("Answer with the single word: ok")}}, nil, func(d string) { text.WriteString(d) })
	if err != nil {
		return "", err
	}

	return fmt.Sprintf("%s answered %q in %.1f s", p.Model, strings.TrimSpace(text.String()), time.Since(start).Seconds()), nil
}

// Event is streamed to the UI while the agent works.
type Event struct {
	Type string `json:"type"` // text, tool_call, tool_result, usage, done, error
	// text
	Delta string `json:"delta,omitempty"`
	// tool_call / tool_result
	ID      string          `json:"id,omitempty"`
	Name    string          `json:"name,omitempty"`
	Args    json.RawMessage `json:"args,omitempty"`
	Text    string          `json:"text,omitempty"`
	IsError bool            `json:"is_error,omitempty"`
	Images  []string        `json:"images,omitempty"` // data URLs
	// error
	Message string `json:"message,omitempty"`
	// usage: tokens of the last request
	Usage *Usage `json:"usage,omitempty"`
}

// Stop cancels a running turn.
func (a *Agent) Stop(conversationID string) bool {
	a.mu.Lock()
	defer a.mu.Unlock()

	if cancel, ok := a.running[conversationID]; ok {
		cancel()
		return true
	}

	return false
}

// Run handles one user message: it calls the model, runs the tools it asks
// for and repeats until the model answers without tool calls. With propose
// the changes go to a proposal branch the user accepts or rejects.
func (a *Agent) Run(ctx context.Context, conv *store.Conversation, providerName, userText string, propose bool, emit func(Event)) error {
	p, err := a.provider(providerName)
	if err != nil {
		return err
	}

	ctx, cancel := context.WithCancel(ctx)
	defer cancel()

	a.mu.Lock()
	if _, busy := a.running[conv.ID]; busy {
		a.mu.Unlock()
		return ErrBusy
	}
	a.running[conv.ID] = cancel
	a.mu.Unlock()
	defer func() {
		a.mu.Lock()
		delete(a.running, conv.ID)
		a.mu.Unlock()
	}()

	project, err := a.store.GetProject(ctx, conv.ProjectID)
	if err != nil {
		return err
	}

	branchID := ""
	if conv.BranchID != nil {
		if _, err := a.store.GetBranch(ctx, *conv.BranchID); err == nil {
			branchID = *conv.BranchID
		}
	}
	if propose && branchID == "" {
		b, err := a.store.CreateBranch(ctx, project.MainBranch, "proposal-"+conv.ID[:8]+"-"+time.Now().Format("150405"))
		if err != nil {
			return fmt.Errorf("create proposal branch; %w", err)
		}
		branchID = b.ID
		if err := a.store.SetConversationBranch(ctx, conv.ID, b.ID); err != nil {
			return err
		}
		emit(Event{Type: "branch", ID: b.ID, Name: b.Name})
		a.onBranch(ctx, project.ID, b)
	}

	if err := a.checkBudget(ctx); err != nil {
		return err
	}

	all, err := a.history(ctx, conv.ID)
	if err != nil {
		return err
	}
	summary, upto, err := a.store.ConversationSummary(ctx, conv.ID)
	if err != nil {
		return err
	}
	// Messages the summary covers are not sent again.
	history := all
	if upto > 0 && int(upto) <= len(all) {
		history = all[upto:]
	}

	if conv.Title == "" {
		title := userText
		if r := []rune(title); len(r) > 60 {
			title = string(r[:60]) + "…"
		}
		_ = a.store.RenameConversation(ctx, conv.ID, title)
	}

	user := Message{Role: "user", Content: textContent(userText)}
	if err := a.save(ctx, conv.ID, user); err != nil {
		return err
	}
	history = append(history, user)

	tools := a.toolDefs()
	c := &client{p: p, http: a.http}
	author := "ai:" + conv.ID

	maxSteps := a.settings.Get().MaxSteps
	for step := 0; step < maxSteps; step++ {
		summary, upto, history = a.compact(ctx, conv, c, p, summary, upto, history, emit)
		msgs := append([]Message{{Role: "system", Content: textContent(a.system(project, branchID != ""))}}, prune(withSummary(summary, history))...)

		reply, usage, err := c.completeUsage(ctx, msgs, tools, func(delta string) {
			emit(Event{Type: "text", Delta: delta})
		})
		if err != nil {
			if ctx.Err() != nil {
				return errors.New("stopped")
			}
			return err
		}
		a.record(ctx, conv, p, usage)
		emit(Event{Type: "usage", Usage: &usage})
		if step > 0 {
			if err := a.checkBudget(ctx); err != nil {
				_ = a.save(ctx, conv.ID, reply)
				emit(Event{Type: "text", Delta: "\n\n_" + err.Error() + "_"})
				emit(Event{Type: "done"})
				return nil
			}
		}

		if err := a.save(ctx, conv.ID, reply); err != nil {
			return err
		}
		history = append(history, reply)

		if len(reply.ToolCalls) == 0 {
			emit(Event{Type: "done"})
			return nil
		}

		var images []Message
		for _, tc := range reply.ToolCalls {
			emit(Event{Type: "tool_call", ID: tc.ID, Name: tc.Function.Name, Args: rawArgs(tc.Function.Arguments)})

			res := a.tools.Call(ctx, tc.Function.Name, json.RawMessage(tc.Function.Arguments), mcpserver.Call{
				ProjectID: conv.ProjectID,
				BranchID:  branchID,
				Author:    author,
			})

			ev := Event{Type: "tool_result", ID: tc.ID, Name: tc.Function.Name, Text: res.Text, IsError: res.IsError}
			for _, img := range res.Images {
				ev.Images = append(ev.Images, dataURL(img))
			}
			emit(ev)

			text := res.Text
			if res.IsError {
				text = "ERROR: " + text
			}
			if len(res.Images) > 0 {
				if p.Vision {
					text += fmt.Sprintf("\n[%d image(s) attached in the next message]", len(res.Images))
					images = append(images, imageMessage(tc.Function.Name, res.Images))
				} else {
					text += "\n[image omitted: this model has no vision; rely on the numbers above]"
				}
			}

			toolMsg := Message{Role: "tool", ToolCallID: tc.ID, Content: textContent(text)}
			if err := a.save(ctx, conv.ID, toolMsg); err != nil {
				return err
			}
			history = append(history, toolMsg)

			if ctx.Err() != nil {
				return errors.New("stopped")
			}
		}

		// Tool messages cannot carry images on most servers, so renders go
		// in a user message right after the tool results.
		for _, m := range images {
			if err := a.save(ctx, conv.ID, m); err != nil {
				return err
			}
			history = append(history, m)
		}
	}

	emit(Event{Type: "text", Delta: fmt.Sprintf("\n\n_Stopped after %d tool rounds; send a message to continue._", maxSteps)})
	emit(Event{Type: "done"})

	return nil
}

func (a *Agent) system(p *store.Project, proposal bool) string {
	mode := "Your changes apply to the design directly; the user can undo them."
	if proposal {
		mode = "You work on a proposal: your changes go to a separate branch that the user reviews and accepts or rejects. Finish the whole change, verify it, then summarize what to review."
	}

	return a.tools.Guide() + fmt.Sprintf(`

## Session
You are the assistant built into Ket. You are working in project %q (id %s).
%s
The user watches the model update live in the viewport while you work.
Reply in the user's language. Be brief in prose: let the model, the checks
and the renders show the result.`, p.Name, p.ID, mode)
}

func (a *Agent) toolDefs() []toolDef {
	list := a.tools.List(mcpserver.ScopeAgent)
	out := make([]toolDef, 0, len(list))
	for _, t := range list {
		out = append(out, toolDef{Type: "function", Function: toolFun{Name: t.Name, Description: t.Description, Parameters: t.Schema}})
	}

	return out
}

func (a *Agent) history(ctx context.Context, conversationID string) ([]Message, error) {
	raw, err := a.store.Messages(ctx, conversationID)
	if err != nil {
		return nil, err
	}

	out := make([]Message, 0, len(raw))
	for _, r := range raw {
		var m Message
		if err := json.Unmarshal(r, &m); err != nil {
			slog.Warn("skip bad stored message", "conversation", conversationID, "error", err)
			continue
		}
		out = append(out, m)
	}

	return out, nil
}

func (a *Agent) save(ctx context.Context, conversationID string, m Message) error {
	b, err := json.Marshal(m)
	if err != nil {
		return err
	}

	return a.store.AppendMessages(ctx, conversationID, b)
}

// History returns the stored messages for the UI.
func (a *Agent) History(ctx context.Context, conversationID string) ([]Message, error) {
	return a.history(ctx, conversationID)
}

func rawArgs(s string) json.RawMessage {
	if json.Valid([]byte(s)) {
		return json.RawMessage(s)
	}
	b, _ := json.Marshal(s)

	return b
}

func dataURL(img mcpserver.Image) string {
	return "data:" + img.MIME + ";base64," + base64.StdEncoding.EncodeToString(img.Data)
}

func imageMessage(tool string, imgs []mcpserver.Image) Message {
	parts := []map[string]any{{"type": "text", "text": "Images returned by " + tool + ":"}}
	for _, img := range imgs {
		parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": dataURL(img)}})
	}
	b, _ := json.Marshal(parts)

	return Message{Role: "user", Content: b}
}

// keepImages is how many of the latest image messages keep their images;
// older renders are replaced by a note so the context does not fill up.
const keepImages = 2

// prune drops images from all but the latest image messages.
func prune(history []Message) []Message {
	out := make([]Message, len(history))
	copy(out, history)

	seen := 0
	for i := len(out) - 1; i >= 0; i-- {
		m := out[i]
		if m.Role != "user" || len(m.Content) == 0 || m.Content[0] != '[' {
			continue
		}
		var parts []map[string]any
		if json.Unmarshal(m.Content, &parts) != nil {
			continue
		}
		hasImage := false
		for _, p := range parts {
			if p["type"] == "image_url" {
				hasImage = true
			}
		}
		if !hasImage {
			continue
		}
		seen++
		if seen <= keepImages {
			continue
		}
		out[i] = Message{Role: "user", Content: textContent("[earlier render omitted]")}
	}

	return out
}
