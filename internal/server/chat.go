package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"sync"

	"github.com/rakunlabs/ada"

	"github.com/rakunlabs/ket/internal/access"
	"github.com/rakunlabs/ket/internal/agent"
	"github.com/rakunlabs/ket/internal/store"
)

func (s *Server) listConversations(c *ada.Context) error {
	p, err := s.access.Project(c.Request.Context(), c.Request.PathValue("id"), access.Editor)
	if err != nil {
		return httpErr(err)
	}
	list, err := s.Store.ListConversations(c.Request.Context(), p.ID)
	if err != nil {
		return err
	}

	return c.SendJSON(list)
}

func (s *Server) createConversation(c *ada.Context) error {
	ctx := c.Request.Context()
	p, err := s.access.Project(ctx, c.Request.PathValue("id"), access.Editor)
	if err != nil {
		return httpErr(err)
	}

	conv, err := s.Store.CreateConversation(ctx, p.ID, "")
	if err != nil {
		return err
	}

	return c.SetStatus(http.StatusCreated).SendJSON(conv)
}

func (s *Server) getConversation(c *ada.Context) error {
	ctx := c.Request.Context()
	conv, err := s.conversation(ctx, c.Request.PathValue("id"))
	if err != nil {
		return httpErr(err)
	}

	msgs, err := s.Agent.History(ctx, conv.ID)
	if err != nil {
		return err
	}

	return c.SendJSON(map[string]any{"conversation": conv, "messages": msgs})
}

func (s *Server) deleteConversation(c *ada.Context) error {
	conv, err := s.conversation(c.Request.Context(), c.Request.PathValue("id"))
	if err != nil {
		return httpErr(err)
	}
	id := conv.ID
	s.Agent.Stop(id)
	if err := s.Store.DeleteConversation(c.Request.Context(), id); err != nil {
		return httpErr(err)
	}

	return c.SendNoContent()
}

func (s *Server) stopConversation(c *ada.Context) error {
	conv, err := s.conversation(c.Request.Context(), c.Request.PathValue("id"))
	if err != nil {
		return httpErr(err)
	}

	return c.SendJSON(map[string]bool{"stopped": s.Agent.Stop(conv.ID)})
}

// conversation loads a conversation the user may work in (editor on its
// project: the agent changes the design).
func (s *Server) conversation(ctx context.Context, id string) (*store.Conversation, error) {
	conv, err := s.Store.GetConversation(ctx, id)
	if err != nil {
		return nil, err
	}
	if _, err := s.access.Project(ctx, conv.ProjectID, access.Editor); err != nil {
		return nil, err
	}

	return conv, nil
}

// chat runs one user turn and streams agent events as server-sent events.
func (s *Server) chat(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	ctx := r.Context()
	conv, err := s.conversation(ctx, r.PathValue("id"))
	if err != nil {
		code := http.StatusNotFound
		if errors.Is(err, access.ErrDenied) {
			code = http.StatusForbidden
		}
		writeJSONError(w, code, err.Error())
		return
	}

	var in struct {
		Text     string `json:"text"`
		Provider string `json:"provider"`
		// Propose puts the agent's changes on a proposal branch.
		Propose bool `json:"propose"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(&in); err != nil {
		writeJSONError(w, http.StatusBadRequest, "bad body: "+err.Error())
		return
	}
	if strings.TrimSpace(in.Text) == "" {
		writeJSONError(w, http.StatusBadRequest, "text is required")
		return
	}

	rc := http.NewResponseController(w)
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	var mu sync.Mutex
	emit := func(ev agent.Event) {
		b, err := json.Marshal(ev)
		if err != nil {
			return
		}
		mu.Lock()
		defer mu.Unlock()
		_, _ = fmt.Fprintf(w, "data: %s\n\n", b)
		_ = rc.Flush()
	}

	if err := s.Agent.Run(ctx, conv, in.Provider, in.Text, in.Propose, emit); err != nil {
		msg := err.Error()
		if errors.Is(err, agent.ErrBusy) {
			msg = err.Error()
		}
		emit(agent.Event{Type: "error", Message: msg})
	}
}

func writeJSONError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"message": msg})
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// decodeJSON reads a same-origin JSON body (at most 1 MB).
func decodeJSON(r *http.Request, v any) error {
	if ct := r.Header.Get("Content-Type"); ct != "application/json" && !strings.HasPrefix(ct, "application/json;") {
		return errors.New("send Content-Type: application/json")
	}

	return json.NewDecoder(http.MaxBytesReader(nil, r.Body, 1<<20)).Decode(v)
}
