package agent

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/rakunlabs/ada/middleware/auth/identity"

	"github.com/rakunlabs/ket/internal/settings"
	"github.com/rakunlabs/ket/internal/store"
)

// ErrOverBudget is a user's monthly token limit reached.
type ErrOverBudget struct{ Used, Limit int64 }

func (e ErrOverBudget) Error() string {
	return fmt.Sprintf("you have used %d of your %d assistant tokens this month; an administrator can raise the limit in Settings → AI providers", e.Used, e.Limit)
}

func userOf(ctx context.Context) string {
	if id := identity.FromContext(ctx); id != nil {
		return id.Subject
	}

	return ""
}

func monthStart(now time.Time) time.Time {
	now = now.UTC()

	return time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC)
}

// checkBudget refuses a turn when the user's monthly limit is spent.
func (a *Agent) checkBudget(ctx context.Context) error {
	limit := a.settings.Get().MonthlyTokens
	if limit <= 0 {
		return nil
	}
	used, err := a.store.UsageTotal(ctx, userOf(ctx), monthStart(time.Now()))
	if err != nil {
		return err
	}
	if used >= limit {
		return ErrOverBudget{Used: used, Limit: limit}
	}

	return nil
}

func (a *Agent) record(ctx context.Context, conv *store.Conversation, p settings.Provider, u Usage) {
	err := a.store.RecordUsage(context.WithoutCancel(ctx), store.UsageRow{
		User: userOf(ctx), ProjectID: conv.ProjectID, ConversationID: conv.ID, Provider: p.Name, Model: p.Model,
		PromptTokens: u.PromptTokens, CompletionTokens: u.CompletionTokens, Estimated: u.Estimated,
	})
	if err != nil {
		slog.Warn("record assistant usage", "error", err)
	}
}

// keepRecent is how many of the latest messages stay verbatim after compaction.
const keepRecent = 12

// compact replaces the older part of a long history with a summary the model
// writes, stored with the conversation so later turns reuse it. history holds
// the messages after the stored summary; it returns what to send instead.
func (a *Agent) compact(ctx context.Context, conv *store.Conversation, c *client, p settings.Provider, summary string, upto int64, history []Message, emit func(Event)) (string, int64, []Message) {
	limit := a.settings.Get().CompactTokens
	if limit <= 0 || estimateTokens(history, nil) < limit || len(history) <= keepRecent+2 {
		return summary, upto, history
	}
	// Cut so the kept part starts at a user message or at an assistant message
	// that opens a new round: never between a tool call and its result. One
	// long tool loop has no user messages in it, so rounds count too.
	cut := len(history) - keepRecent
	for cut > 0 && !(history[cut].Role == "user" || (history[cut].Role == "assistant" && history[cut-1].Role != "assistant")) {
		cut--
	}
	if cut <= 0 {
		return summary, upto, history
	}
	old := history[:cut]
	var b strings.Builder
	if summary != "" {
		b.WriteString("Summary so far:\n" + summary + "\n\n")
	}
	for _, m := range old {
		text := m.Text()
		if len(text) > 2000 {
			text = text[:2000] + " …"
		}
		switch m.Role {
		case "assistant":
			for _, tc := range m.ToolCalls {
				args := tc.Function.Arguments
				if len(args) > 400 {
					args = args[:400] + " …"
				}
				fmt.Fprintf(&b, "[assistant called %s %s]\n", tc.Function.Name, args)
			}
			if text != "" {
				fmt.Fprintf(&b, "assistant: %s\n", text)
			}
		case "tool":
			fmt.Fprintf(&b, "[tool result] %s\n", text)
		default:
			if text != "" && !strings.HasPrefix(text, "[earlier render") {
				fmt.Fprintf(&b, "%s: %s\n", m.Role, text)
			}
		}
	}
	prompt := []Message{
		{Role: "system", Content: textContent("You condense a CAD/PCB design conversation for the assistant that continues it. Keep: what the user asked for and decided, requirements and dimensions, what was built (feature, sketch, net, part names), checks and their results, problems still open, and what was about to happen next. Drop: tool output details that can be read again with get_document or get_board. Write plain short lines, at most 400 words.")},
		{Role: "user", Content: textContent(b.String())},
	}
	emit(Event{Type: "text", Delta: "_Summarizing the earlier conversation…_\n\n"})
	reply, u, err := c.completeUsage(ctx, prompt, nil, func(string) {})
	if err != nil {
		slog.Warn("compact conversation", "conversation", conv.ID, "error", err)
		return summary, upto, history
	}
	a.record(ctx, conv, p, u)
	next := strings.TrimSpace(reply.Text())
	if next == "" {
		return summary, upto, history
	}
	newUpto := upto + int64(cut)
	if err := a.store.SetConversationSummary(ctx, conv.ID, next, newUpto); err != nil {
		slog.Warn("store conversation summary", "conversation", conv.ID, "error", err)
	}

	return next, newUpto, history[cut:]
}

// withSummary puts the stored summary in front of the recent messages.
func withSummary(summary string, history []Message) []Message {
	if summary == "" {
		return history
	}
	note := Message{Role: "user", Content: textContent("[Summary of the earlier conversation, written by you; the design itself is current: read it with get_document / get_board.]\n" + summary)}
	// The kept part may start with the assistant (mid-turn): then the note goes straight before it.
	if len(history) > 0 && history[0].Role == "assistant" {
		return append([]Message{note}, history...)
	}
	ack := Message{Role: "assistant", Content: textContent("Understood; continuing from there.")}

	return append([]Message{note, ack}, history...)
}
