package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/rakunlabs/ket/internal/settings"
)

// Message is an OpenAI chat message. Content is a string or a list of
// parts (text / image_url), kept raw so it round-trips through storage.
type Message struct {
	Role       string          `json:"role"`
	Content    json.RawMessage `json:"content,omitempty"`
	ToolCalls  []ToolCall      `json:"tool_calls,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
	Name       string          `json:"name,omitempty"`
}

type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
}

type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

func textContent(s string) json.RawMessage {
	b, _ := json.Marshal(s)
	return b
}

// Text returns the message's text, joining text parts.
func (m Message) Text() string {
	if len(m.Content) == 0 {
		return ""
	}
	var s string
	if json.Unmarshal(m.Content, &s) == nil {
		return s
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(m.Content, &parts) == nil {
		var b strings.Builder
		for _, p := range parts {
			if p.Type == "text" {
				b.WriteString(p.Text)
			}
		}
		return b.String()
	}

	return ""
}

type toolDef struct {
	Type     string  `json:"type"`
	Function toolFun `json:"function"`
}

type toolFun struct {
	Name        string          `json:"name"`
	Description string          `json:"description,omitempty"`
	Parameters  json.RawMessage `json:"parameters"`
}

type chatRequest struct {
	Model         string         `json:"model"`
	Messages      []Message      `json:"messages"`
	Tools         []toolDef      `json:"tools,omitempty"`
	Stream        bool           `json:"stream"`
	StreamOptions *streamOptions `json:"stream_options,omitempty"`
	Temperature   *float64       `json:"temperature,omitempty"`
}

type streamOptions struct {
	IncludeUsage bool `json:"include_usage"`
}

// Usage is what a provider reports for one request. Servers that do not
// report it leave it zero; Estimated is set when Ket counted instead.
type Usage struct {
	PromptTokens     int  `json:"prompt_tokens"`
	CompletionTokens int  `json:"completion_tokens"`
	Estimated        bool `json:"estimated,omitempty"`
}

type streamChunk struct {
	Choices []struct {
		Delta struct {
			Content   string `json:"content"`
			Reasoning string `json:"reasoning_content"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage *Usage `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type client struct {
	p    settings.Provider
	http *http.Client
}

// complete streams one assistant turn. onText receives content deltas as
// they arrive; the full message (with tool calls) is returned at the end.
func (c *client) complete(ctx context.Context, msgs []Message, tools []toolDef, onText func(string)) (Message, error) {
	m, _, err := c.completeUsage(ctx, msgs, tools, onText)
	return m, err
}

// completeUsage is complete with the token usage of the request: as the
// provider reports it (stream_options.include_usage), else estimated.
func (c *client) completeUsage(ctx context.Context, msgs []Message, tools []toolDef, onText func(string)) (Message, Usage, error) {
	ask := !noUsageOption(c.p)
	m, u, err := c.request(ctx, msgs, tools, onText, ask)
	// A strict server refuses the stream_options field: ask once more without it, and remember.
	var bad errBadRequest
	if ask && errors.As(err, &bad) && (strings.Contains(strings.ToLower(bad.body), "stream_options") || strings.Contains(strings.ToLower(bad.body), "include_usage")) {
		rememberNoUsageOption(c.p)
		m, u, err = c.request(ctx, msgs, tools, onText, false)
	}
	if err == nil && u.PromptTokens == 0 && u.CompletionTokens == 0 {
		u = Usage{PromptTokens: estimateTokens(msgs, tools), CompletionTokens: estimateTokens([]Message{m}, nil), Estimated: true}
	}
	return m, u, err
}

// errBadRequest is a 4xx answer, with its body for the caller to read.
type errBadRequest struct {
	msg  string
	body string
}

func (e errBadRequest) Error() string { return e.msg }

// Providers (base URL + model) that refused stream_options, for this process.
var noUsage sync.Map

func usageKey(p settings.Provider) string { return p.BaseURL + "|" + p.Model }

func noUsageOption(p settings.Provider) bool {
	_, ok := noUsage.Load(usageKey(p))
	return ok
}

func rememberNoUsageOption(p settings.Provider) { noUsage.Store(usageKey(p), true) }

func (c *client) request(ctx context.Context, msgs []Message, tools []toolDef, onText func(string), askUsage bool) (Message, Usage, error) {
	req := chatRequest{Model: c.p.Model, Messages: msgs, Tools: tools, Stream: true}
	if askUsage {
		req.StreamOptions = &streamOptions{IncludeUsage: true}
	}
	if c.p.Temperature > 0 {
		t := c.p.Temperature
		req.Temperature = &t
	}

	body, err := json.Marshal(req)
	if err != nil {
		return Message{}, Usage{}, err
	}

	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.p.BaseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Message{}, Usage{}, err
	}
	hr.Header.Set("Content-Type", "application/json")
	hr.Header.Set("Accept", "text/event-stream")
	if c.p.APIKey != "" {
		hr.Header.Set("Authorization", "Bearer "+c.p.APIKey)
	}

	resp, err := c.http.Do(hr)
	if err != nil {
		return Message{}, Usage{}, fmt.Errorf("call %s; %w", c.p.Name, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		msg := fmt.Sprintf("%s answered %s: %s", c.p.Name, resp.Status, strings.TrimSpace(string(b)))
		if resp.StatusCode >= 400 && resp.StatusCode < 500 {
			return Message{}, Usage{}, errBadRequest{msg: msg, body: string(b)}
		}
		return Message{}, Usage{}, errors.New(msg)
	}

	// Some servers ignore stream:true and answer one JSON object.
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		var full struct {
			Choices []struct {
				Message Message `json:"message"`
			} `json:"choices"`
			Usage *Usage `json:"usage"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&full); err != nil {
			return Message{}, Usage{}, fmt.Errorf("decode answer; %w", err)
		}
		if len(full.Choices) == 0 {
			return Message{}, Usage{}, fmt.Errorf("%s answered no choices", c.p.Name)
		}
		m := full.Choices[0].Message
		m.Role = "assistant"
		if t := m.Text(); t != "" {
			onText(t)
		}
		var u Usage
		if full.Usage != nil {
			u = *full.Usage
		}
		return m, u, nil
	}

	var (
		text  strings.Builder
		calls []ToolCall
		usage Usage
	)

	sc := bufio.NewScanner(resp.Body)
	sc.Buffer(make([]byte, 64*1024), 8*1024*1024)
	for sc.Scan() {
		line := sc.Text()
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		data := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if data == "[DONE]" {
			break
		}

		var chunk streamChunk
		if err := json.Unmarshal([]byte(data), &chunk); err != nil {
			continue
		}
		if chunk.Usage != nil {
			usage = *chunk.Usage
		}
		if chunk.Error != nil {
			return Message{}, Usage{}, fmt.Errorf("%s: %s", c.p.Name, chunk.Error.Message)
		}

		for _, ch := range chunk.Choices {
			if ch.Delta.Content != "" {
				text.WriteString(ch.Delta.Content)
				onText(ch.Delta.Content)
			}
			for _, tc := range ch.Delta.ToolCalls {
				for len(calls) <= tc.Index {
					calls = append(calls, ToolCall{Type: "function"})
				}
				call := &calls[tc.Index]
				if tc.ID != "" {
					call.ID = tc.ID
				}
				if tc.Function.Name != "" {
					call.Function.Name += tc.Function.Name
				}
				call.Function.Arguments += tc.Function.Arguments
			}
		}
	}
	if err := sc.Err(); err != nil {
		return Message{}, Usage{}, fmt.Errorf("read stream; %w", err)
	}

	msg := Message{Role: "assistant"}
	if text.Len() > 0 {
		msg.Content = textContent(text.String())
	}
	for i := range calls {
		if calls[i].ID == "" {
			calls[i].ID = fmt.Sprintf("call_%d", i)
		}
		if calls[i].Function.Arguments == "" {
			calls[i].Function.Arguments = "{}"
		}
	}
	msg.ToolCalls = calls

	return msg, usage, nil
}

// estimateTokens counts about four characters per token, images as a fixed
// cost: for servers that do not report usage, and for compaction thresholds.
func estimateTokens(msgs []Message, tools []toolDef) int {
	n := 0
	for _, m := range msgs {
		n += 4
		if len(m.Content) > 0 && m.Content[0] == '[' {
			var parts []map[string]any
			if json.Unmarshal(m.Content, &parts) == nil {
				for _, p := range parts {
					if p["type"] == "image_url" {
						n += 800
					} else if s, ok := p["text"].(string); ok {
						n += len(s) / 4
					}
				}
				continue
			}
		}
		n += len(m.Text()) / 4
		for _, tc := range m.ToolCalls {
			n += (len(tc.Function.Name) + len(tc.Function.Arguments)) / 4
		}
	}
	for _, t := range tools {
		n += (len(t.Function.Name) + len(t.Function.Description) + len(t.Function.Parameters)) / 4
	}

	return n
}
