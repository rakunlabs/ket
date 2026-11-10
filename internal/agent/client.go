package agent

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

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
	Model       string    `json:"model"`
	Messages    []Message `json:"messages"`
	Tools       []toolDef `json:"tools,omitempty"`
	Stream      bool      `json:"stream"`
	Temperature *float64  `json:"temperature,omitempty"`
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
	req := chatRequest{Model: c.p.Model, Messages: msgs, Tools: tools, Stream: true}
	if c.p.Temperature > 0 {
		t := c.p.Temperature
		req.Temperature = &t
	}

	body, err := json.Marshal(req)
	if err != nil {
		return Message{}, err
	}

	hr, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimRight(c.p.BaseURL, "/")+"/chat/completions", bytes.NewReader(body))
	if err != nil {
		return Message{}, err
	}
	hr.Header.Set("Content-Type", "application/json")
	hr.Header.Set("Accept", "text/event-stream")
	if c.p.APIKey != "" {
		hr.Header.Set("Authorization", "Bearer "+c.p.APIKey)
	}

	resp, err := c.http.Do(hr)
	if err != nil {
		return Message{}, fmt.Errorf("call %s; %w", c.p.Name, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return Message{}, fmt.Errorf("%s answered %s: %s", c.p.Name, resp.Status, strings.TrimSpace(string(b)))
	}

	// Some servers ignore stream:true and answer one JSON object.
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		var full struct {
			Choices []struct {
				Message Message `json:"message"`
			} `json:"choices"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&full); err != nil {
			return Message{}, fmt.Errorf("decode answer; %w", err)
		}
		if len(full.Choices) == 0 {
			return Message{}, fmt.Errorf("%s answered no choices", c.p.Name)
		}
		m := full.Choices[0].Message
		m.Role = "assistant"
		if t := m.Text(); t != "" {
			onText(t)
		}
		return m, nil
	}

	var (
		text  strings.Builder
		calls []ToolCall
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
		if chunk.Error != nil {
			return Message{}, fmt.Errorf("%s: %s", c.p.Name, chunk.Error.Message)
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
		return Message{}, fmt.Errorf("read stream; %w", err)
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

	return msg, nil
}
