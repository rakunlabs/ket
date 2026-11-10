package hub

// App clients are browser windows with Ket loaded, whether a project is open
// or not. Through them an agent opens and closes project tabs, so it can
// bring a project into a browser before running commands on it.
//
// Wire format, browser → server:
//
//	{"t":"focus"}                       the window got the user's focus
//	{"t":"ping"}
//
// server → browser:
//
//	{"t":"hello","client":"a1"}
//	{"t":"open","project":"<id>","name":"...","activate":true}
//	{"t":"close","project":"<id>"}

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rakunlabs/ket/internal/store"
)

// ErrNoApp is returned when an agent wants to open a project and the user
// has no Ket window open.
var ErrNoApp = errors.New("Ket is not open in the user's browser: ask the user to open Ket (any page), then call open_project again")

// OpenTimeout bounds how long open_project waits for the new tab to connect.
var OpenTimeout = 30 * time.Second

// Client is one browser window with Ket loaded.
type Client struct {
	ID   string
	User string
	conn Conn

	sendMu sync.Mutex
	// focused is when the window last had focus (unix nanos); the most
	// recently focused window gets the tabs an agent opens.
	focused atomic.Int64
	closed  atomic.Bool
}

// Connect registers a browser window of user and sends it the hello frame.
func (h *Hub) Connect(ctx context.Context, conn Conn, user string) (*Client, error) {
	c := &Client{ID: h.id("a"), User: user, conn: conn}
	c.focused.Store(time.Now().UnixNano())

	h.mu.Lock()
	h.clients[user] = append(h.clients[user], c)
	h.mu.Unlock()

	if err := c.send(ctx, map[string]any{"t": "hello", "client": c.ID}); err != nil {
		h.Disconnect(c)
		return nil, err
	}

	return c, nil
}

// Disconnect removes a browser window.
func (h *Hub) Disconnect(c *Client) {
	if !c.closed.CompareAndSwap(false, true) {
		return
	}

	h.mu.Lock()
	defer h.mu.Unlock()

	list := h.clients[c.User]
	for i, other := range list {
		if other == c {
			list = append(list[:i], list[i+1:]...)
			break
		}
	}
	if len(list) == 0 {
		delete(h.clients, c.User)
	} else {
		h.clients[c.User] = list
	}
}

func (c *Client) send(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}

	c.sendMu.Lock()
	defer c.sendMu.Unlock()

	return c.conn.Send(ctx, b)
}

// Handle processes one frame from the window.
func (c *Client) Handle(ctx context.Context, frame []byte) error {
	var in struct {
		T string `json:"t"`
	}
	if err := json.Unmarshal(frame, &in); err != nil {
		return fmt.Errorf("bad frame; %w", err)
	}

	switch in.T {
	case "ping":
		return c.send(ctx, map[string]any{"t": "pong"})
	case "focus":
		c.focused.Store(time.Now().UnixNano())
		return nil
	default:
		return fmt.Errorf("unknown frame type %q", in.T)
	}
}

// focusedClient is the user's most recently focused window.
func (h *Hub) focusedClient(user string) *Client {
	h.mu.Lock()
	defer h.mu.Unlock()

	var best *Client
	for _, c := range h.clients[user] {
		if best == nil || c.focused.Load() >= best.focused.Load() {
			best = c
		}
	}

	return best
}

// Clients is the number of Ket windows user has open.
func (h *Hub) Clients(user string) int {
	h.mu.Lock()
	defer h.mu.Unlock()

	return len(h.clients[user])
}

// OpenProject opens p in a tab of the user's most recently focused window
// and waits until the tab is connected, so commands can run right after.
// activate switches the window to the tab. It reports whether the project
// was already open in some browser.
func (h *Hub) OpenProject(ctx context.Context, user string, p *store.Project, activate bool) (bool, error) {
	c := h.focusedClient(user)
	if c == nil {
		return false, ErrNoApp
	}

	was := h.Sessions(p.ID) > 0
	if err := c.send(ctx, map[string]any{"t": "open", "project": p.ID, "name": p.Name, "activate": activate}); err != nil {
		return false, fmt.Errorf("send to browser; %w", err)
	}
	if was {
		return true, nil
	}

	deadline := time.NewTimer(OpenTimeout)
	defer deadline.Stop()
	tick := time.NewTicker(100 * time.Millisecond)
	defer tick.Stop()

	for {
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-deadline.C:
			return false, fmt.Errorf("the tab for %q did not connect within %s; the browser may have too many tabs open or lack access, ask the user to check Ket", p.Name, OpenTimeout)
		case <-tick.C:
			if h.Sessions(p.ID) > 0 {
				return false, nil
			}
		}
	}
}

// CloseProject closes the project's tab in every window of the user.
func (h *Hub) CloseProject(ctx context.Context, user, projectID string) error {
	h.mu.Lock()
	targets := append([]*Client(nil), h.clients[user]...)
	h.mu.Unlock()

	if len(targets) == 0 {
		return ErrNoApp
	}

	var errs []error
	for _, c := range targets {
		if err := c.send(ctx, map[string]any{"t": "close", "project": projectID}); err != nil {
			errs = append(errs, err)
		}
	}

	return errors.Join(errs...)
}
