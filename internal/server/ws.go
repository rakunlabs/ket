package server

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/coder/websocket"

	"github.com/rakunlabs/ket/internal/access"
)

// wsConn adapts a websocket to hub.Conn.
type wsConn struct{ c *websocket.Conn }

func (w wsConn) Send(ctx context.Context, msg []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()

	return w.c.Write(ctx, websocket.MessageText, msg)
}

func (s *Server) websocket(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()
	p, err := s.access.Project(ctx, r.PathValue("id"), access.Viewer)
	if err != nil {
		http.Error(w, "no such project", http.StatusNotFound)
		return
	}

	// Same-origin only: the Origin host must match the request host.
	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		slog.Debug("websocket accept", "error", err)
		return
	}
	defer c.CloseNow()

	// Renders and STEP blobs can be large.
	c.SetReadLimit(64 << 20)

	// The request context ends with the handler; keep a separate one so a
	// slow send does not race the shutdown of the read loop.
	sctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	defer cancel()

	branch := r.URL.Query().Get("branch")
	if branch != "" {
		b, err := s.Store.GetBranch(ctx, branch)
		if err != nil || b.ProjectID != p.ID {
			_ = c.Close(websocket.StatusPolicyViolation, "no such branch")
			return
		}
	}

	// Read-only users watch; only editors commit and run agent calls.
	viewer := r.URL.Query().Get("viewer") == "true"
	if p.Access == access.Viewer.String() {
		viewer = true
	}
	user := author(r)

	session, err := s.Hub.Join(sctx, p, branch, wsConn{c}, viewer, user)
	if err != nil {
		_ = c.Close(websocket.StatusInternalError, "join failed")
		return
	}
	defer s.Hub.Leave(session)

	slog.Debug("session joined", "project", p.ID, "session", session.ID)
	defer slog.Debug("session left", "project", p.ID, "session", session.ID)

	for {
		_, frame, err := c.Read(ctx)
		if err != nil {
			if !errors.Is(err, context.Canceled) && websocket.CloseStatus(err) == -1 {
				slog.Debug("websocket read", "session", session.ID, "error", err)
			}
			return
		}

		// Handle in a goroutine-free loop: frames of one session are
		// ordered, and results unblock waiting calls immediately.
		if err := session.Handle(sctx, frame); err != nil {
			slog.Warn("websocket frame", "session", session.ID, "error", err)
		}
	}
}

// appWebsocket is the window-level channel: agents open and close project
// tabs through it.
func (s *Server) appWebsocket(w http.ResponseWriter, r *http.Request) {
	ctx := r.Context()

	c, err := websocket.Accept(w, r, nil)
	if err != nil {
		slog.Debug("websocket accept", "error", err)
		return
	}
	defer c.CloseNow()

	sctx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	defer cancel()

	client, err := s.Hub.Connect(sctx, wsConn{c}, s.access.Subject(ctx))
	if err != nil {
		_ = c.Close(websocket.StatusInternalError, "connect failed")
		return
	}
	defer s.Hub.Disconnect(client)

	for {
		_, frame, err := c.Read(ctx)
		if err != nil {
			return
		}
		if err := client.Handle(sctx, frame); err != nil {
			slog.Warn("app websocket frame", "client", client.ID, "error", err)
		}
	}
}
