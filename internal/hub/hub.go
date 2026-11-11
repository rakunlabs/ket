// Package hub connects browser sessions to projects. The browser owns the
// geometry kernel (OpenCascade in WASM), so every command runs there:
//
//   - A browser that edits commits the op it already applied; the hub
//     writes it to the op log and broadcasts it to the other sessions of the
//     project.
//   - MCP and the built-in agent call a command through the hub; it is sent
//     to one session of the project (the executor), which runs it, commits
//     the op if it is a mutation, and answers with the result.
//
// Wire format (JSON text frames), browser → server:
//
//	{"t":"commit","id":"c1","base":12,"op":{...},"message":"..."}
//	{"t":"undo","id":"u1"} / {"t":"redo","id":"r1"}
//	{"t":"result","id":"<call id>","ok":true,"result":{...}}
//	{"t":"ping"}
//
// server → browser:
//
//	{"t":"hello","session":"s1","head":12,"top":12}
//	{"t":"ack","id":"c1","seq":13} / {"t":"nack","id":"c1","error":"...","head":13}
//	{"t":"op","seq":13,"op":{...},"author":"..."}      another session's op
//	{"t":"head","head":11,"top":13}                    after undo/redo
//	{"t":"call","id":"k1","cmd":"box","args":{...},"author":"ai:..."}
//	{"t":"activity","author":"ai:...","text":"..."}   what an agent is doing
package hub

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"github.com/rakunlabs/ket/internal/config"
	"github.com/rakunlabs/ket/internal/store"
)

// ErrNoSession is returned when a command needs a browser and none has the
// project open.
var ErrNoSession = errors.New("the project is not open in a browser: call open_project (or ask the user to open it in Ket) so commands can run; the geometry kernel runs in the browser")

type Hub struct {
	store *store.Store
	cfg   config.Hub

	mu       sync.Mutex
	projects map[string]*project
	// clients are the open Ket windows by user id.
	clients map[string][]*Client

	nextID atomic.Uint64

	// Build identifies the UI this server serves (a hash of its index.html,
	// which names every content-hashed asset); windows that loaded another
	// build reload themselves. Empty: no check.
	Build string
	// BuildFn, when set, reads the build each time (the UI is served from disk).
	BuildFn func() string
}

// CurrentBuild is the UI build windows should run.
func (h *Hub) CurrentBuild() string {
	if h.BuildFn != nil {
		return h.BuildFn()
	}

	return h.Build
}

type project struct {
	id       string
	branch   string
	sessions []*Session
	// writeMu serializes op log writes of the project so seq stays dense.
	writeMu sync.Mutex
}

func New(st *store.Store, cfg config.Hub) *Hub {
	return &Hub{store: st, cfg: cfg, projects: map[string]*project{}, clients: map[string][]*Client{}}
}

// Conn is the transport of one session (a websocket in production).
type Conn interface {
	Send(ctx context.Context, msg []byte) error
}

// Session is one browser tab with a project open.
type Session struct {
	ID      string
	project *project
	hub     *Hub
	conn    Conn
	// Viewer sessions never execute calls and cannot commit (read-only
	// users, embeds).
	Viewer bool
	// User is who is signed in on this tab; it is the author of the
	// changes made in the UI. Empty without auth.
	User string

	sendMu  sync.Mutex
	pending sync.Map // call id → chan callResult
	agents  sync.Map // author → running call count (*atomic.Int32)
	closed  atomic.Bool
}

type callResult struct {
	OK     bool            `json:"ok"`
	Result json.RawMessage `json:"result,omitempty"`
	Error  string          `json:"error,omitempty"`
}

func (h *Hub) id(prefix string) string {
	return fmt.Sprintf("%s%d", prefix, h.nextID.Add(1))
}

// key is the hub's index for a project's branch: sessions on different
// branches of one project do not see each other's ops.
func key(projectID, branchID string) string { return projectID + "/" + branchID }

// Join registers a session for a branch of a project (main when branchID
// is empty) and sends it the hello frame.
func (h *Hub) Join(ctx context.Context, p *store.Project, branchID string, conn Conn, viewer bool, user string) (*Session, error) {
	if branchID == "" {
		branchID = p.MainBranch
	}
	h.mu.Lock()
	k := key(p.ID, branchID)
	pr := h.projects[k]
	if pr == nil {
		pr = &project{id: p.ID, branch: branchID}
		h.projects[k] = pr
	}
	s := &Session{ID: h.id("s"), project: pr, hub: h, conn: conn, Viewer: viewer, User: user}
	pr.sessions = append(pr.sessions, s)
	h.mu.Unlock()

	st, err := h.store.BranchState(ctx, pr.branch)
	if err != nil {
		h.Leave(s)
		return nil, err
	}

	if err := s.send(ctx, map[string]any{"t": "hello", "session": s.ID, "head": st.Head, "top": st.Top}); err != nil {
		h.Leave(s)
		return nil, err
	}

	return s, nil
}

// Leave removes the session and fails its pending calls.
func (h *Hub) Leave(s *Session) {
	if !s.closed.CompareAndSwap(false, true) {
		return
	}

	h.mu.Lock()
	pr := s.project
	for i, other := range pr.sessions {
		if other == s {
			pr.sessions = append(pr.sessions[:i], pr.sessions[i+1:]...)
			break
		}
	}
	if len(pr.sessions) == 0 {
		delete(h.projects, key(pr.id, pr.branch))
	}
	h.mu.Unlock()

	s.pending.Range(func(key, value any) bool {
		value.(chan callResult) <- callResult{Error: "the browser session closed while running the command"}
		s.pending.Delete(key)
		return true
	})
}

// authorOf trusts an agent author only while that agent has a call
// running on this session; anything else is the signed-in user.
func (s *Session) authorOf(claimed string) string {
	if claimed != "" && claimed != "user" {
		if _, ok := s.agents.Load(claimed); ok {
			return claimed
		}
	}
	if s.User != "" {
		return s.User
	}

	return "user"
}

func (s *Session) send(ctx context.Context, v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}

	s.sendMu.Lock()
	defer s.sendMu.Unlock()

	return s.conn.Send(ctx, b)
}

// broadcast sends v to every session of the project except skip.
func (h *Hub) broadcast(ctx context.Context, pr *project, skip *Session, v any) {
	h.mu.Lock()
	targets := make([]*Session, 0, len(pr.sessions))
	for _, s := range pr.sessions {
		if s != skip {
			targets = append(targets, s)
		}
	}
	h.mu.Unlock()

	for _, s := range targets {
		if err := s.send(ctx, v); err != nil {
			slog.Debug("broadcast", "session", s.ID, "error", err)
		}
	}
}

// Sessions is the number of open sessions of a project, on any branch.
func (h *Hub) Sessions(projectID string) int {
	h.mu.Lock()
	defer h.mu.Unlock()

	n := 0
	for _, pr := range h.projects {
		if pr.id == projectID {
			n += len(pr.sessions)
		}
	}

	return n
}

// Branch returns the branch a session runs on.
func (s *Session) Branch() string { return s.project.branch }

type inbound struct {
	T       string          `json:"t"`
	ID      string          `json:"id"`
	Base    int64           `json:"base"`
	Op      json.RawMessage `json:"op"`
	Message string          `json:"message"`
	Author  string          `json:"author"`
	OK      bool            `json:"ok"`
	Result  json.RawMessage `json:"result"`
	Error   string          `json:"error"`
}

// Handle processes one frame from the session's browser.
func (s *Session) Handle(ctx context.Context, frame []byte) error {
	var in inbound
	if err := json.Unmarshal(frame, &in); err != nil {
		return fmt.Errorf("bad frame; %w", err)
	}

	switch in.T {
	case "ping":
		return s.send(ctx, map[string]any{"t": "pong"})
	case "commit":
		if s.Viewer {
			return s.send(ctx, map[string]any{"t": "nack", "id": in.ID, "error": "read-only: you may not change this project"})
		}
		// Calls from agents carry their author; the hub knows which calls
		// it sent, so a tab cannot claim to be an agent.
		author := s.authorOf(in.Author)
		seq, err := s.hub.commit(ctx, s, in.Base, in.Op, author, in.Message)
		if err != nil {
			head, _ := s.hub.store.BranchState(ctx, s.project.branch)
			return s.send(ctx, map[string]any{"t": "nack", "id": in.ID, "error": err.Error(), "head": head.Head})
		}
		return s.send(ctx, map[string]any{"t": "ack", "id": in.ID, "seq": seq})
	case "undo", "redo":
		if s.Viewer {
			return s.send(ctx, map[string]any{"t": "nack", "id": in.ID, "error": "read-only"})
		}
		delta := int64(-1)
		if in.T == "redo" {
			delta = 1
		}
		st, err := s.hub.moveHead(ctx, s.project, delta)
		if err != nil {
			return s.send(ctx, map[string]any{"t": "nack", "id": in.ID, "error": err.Error()})
		}
		return s.send(ctx, map[string]any{"t": "ack", "id": in.ID, "seq": st.Head})
	case "result":
		if ch, ok := s.pending.LoadAndDelete(in.ID); ok {
			ch.(chan callResult) <- callResult{OK: in.OK, Result: in.Result, Error: in.Error}
		}
		return nil
	default:
		return fmt.Errorf("unknown frame type %q", in.T)
	}
}

func (h *Hub) commit(ctx context.Context, from *Session, base int64, op json.RawMessage, author, message string) (int64, error) {
	if len(op) == 0 {
		return 0, errors.New("empty op")
	}

	pr := from.project
	pr.writeMu.Lock()
	o, err := h.store.AppendOp(ctx, pr.branch, base, op, author, message)
	pr.writeMu.Unlock()
	if err != nil {
		return 0, err
	}

	h.broadcast(ctx, pr, from, map[string]any{"t": "op", "seq": o.Seq, "op": o.Op, "author": author, "message": message})

	return o.Seq, nil
}

func (h *Hub) moveHead(ctx context.Context, pr *project, delta int64) (store.BranchState, error) {
	pr.writeMu.Lock()
	st, err := h.store.MoveHead(ctx, pr.branch, delta)
	pr.writeMu.Unlock()
	if err != nil {
		return st, err
	}

	h.broadcast(ctx, pr, nil, map[string]any{"t": "head", "head": st.Head, "top": st.Top})

	return st, nil
}

// Undo and Redo move a branch's head (main when branchID is empty) and
// tell every session on it.
func (h *Hub) Undo(ctx context.Context, p *store.Project, branchID string) (store.BranchState, error) {
	return h.moveHead(ctx, h.projectOf(p, branchID), -1)
}

func (h *Hub) Redo(ctx context.Context, p *store.Project, branchID string) (store.BranchState, error) {
	return h.moveHead(ctx, h.projectOf(p, branchID), 1)
}

// projectOf returns the live branch, or a detached one when no browser has
// it open (undo/redo still work on the log).
func (h *Hub) projectOf(p *store.Project, branchID string) *project {
	if branchID == "" {
		branchID = p.MainBranch
	}
	h.mu.Lock()
	defer h.mu.Unlock()

	if pr := h.projects[key(p.ID, branchID)]; pr != nil {
		return pr
	}

	return &project{id: p.ID, branch: branchID}
}

// executor picks the session that runs calls on a branch: the most
// recently joined non-viewer session there. With branchID empty any branch
// of the project will do, preferring main.
func (h *Hub) executor(p *store.Project, branchID string) *Session {
	h.mu.Lock()
	defer h.mu.Unlock()

	pick := func(pr *project) *Session {
		if pr == nil {
			return nil
		}
		for i := len(pr.sessions) - 1; i >= 0; i-- {
			if s := pr.sessions[i]; !s.Viewer {
				return s
			}
		}
		return nil
	}
	if branchID != "" {
		return pick(h.projects[key(p.ID, branchID)])
	}
	if s := pick(h.projects[key(p.ID, p.MainBranch)]); s != nil {
		return s
	}
	for _, pr := range h.projects {
		if pr.id == p.ID {
			if s := pick(pr); s != nil {
				return s
			}
		}
	}

	return nil
}

// Call runs a command in a browser that has the branch open and waits for
// its result. The result is the command's JSON answer; a failed command
// returns its error message as err.
func (h *Hub) Call(ctx context.Context, p *store.Project, branchID, cmd string, args json.RawMessage, author string) (json.RawMessage, error) {
	s := h.executor(p, branchID)
	if s == nil {
		if branchID != "" && branchID != p.MainBranch {
			return nil, errors.New("the proposal branch is not open in a browser; open the project in Ket (it follows the agent's proposal automatically)")
		}
		return nil, ErrNoSession
	}

	if len(args) == 0 {
		args = json.RawMessage("{}")
	}

	id := h.id("k")
	ch := make(chan callResult, 1)
	s.pending.Store(id, ch)
	defer s.pending.Delete(id)

	n, _ := s.agents.LoadOrStore(author, new(atomic.Int32))
	n.(*atomic.Int32).Add(1)
	defer func() {
		if n.(*atomic.Int32).Add(-1) == 0 {
			s.agents.Delete(author)
		}
	}()

	if err := s.send(ctx, map[string]any{"t": "call", "id": id, "cmd": cmd, "args": args, "author": author}); err != nil {
		return nil, fmt.Errorf("send to browser; %w", err)
	}

	timer := time.NewTimer(h.cfg.CallTimeout)
	defer timer.Stop()

	select {
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-timer.C:
		return nil, fmt.Errorf("the browser did not answer %s within %s", cmd, h.cfg.CallTimeout)
	case r := <-ch:
		if !r.OK {
			if r.Error == "" {
				r.Error = "command failed"
			}
			return r.Result, &CommandError{Message: r.Error, Detail: r.Result}
		}
		return r.Result, nil
	}
}

// Activity shows what an agent is doing to everyone with the project open.
func (h *Hub) Activity(ctx context.Context, projectID, author, text string) {
	h.Notify(ctx, projectID, map[string]any{"t": "activity", "author": author, "text": text})
}

// Notify sends a frame to every session of a project, on any branch.
func (h *Hub) Notify(ctx context.Context, projectID string, frame map[string]any) {
	h.mu.Lock()
	var targets []*project
	for _, pr := range h.projects {
		if pr.id == projectID {
			targets = append(targets, pr)
		}
	}
	h.mu.Unlock()

	for _, pr := range targets {
		h.broadcast(ctx, pr, nil, frame)
	}
}

// CommandError is a command that ran and failed in the browser; Message is
// written for the model to act on.
type CommandError struct {
	Message string
	Detail  json.RawMessage
}

func (e *CommandError) Error() string { return e.Message }
