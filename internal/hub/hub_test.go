package hub

import (
	"context"
	"testing"
	"time"

	"github.com/rakunlabs/ket/internal/config"
	"github.com/rakunlabs/ket/internal/store"
)

// A call on a new proposal branch waits for the browser to follow it: the
// tab leaves main and joins the branch a moment after start_proposal.
func TestCallWaitsForProposalBranch(t *testing.T) {
	h := New(nil, config.Hub{CallTimeout: 5 * time.Second})
	p := &store.Project{ID: "p1", MainBranch: "main"}

	conn := &fakeConn{}
	go func() {
		time.Sleep(200 * time.Millisecond)
		h.mu.Lock()
		pr := &project{id: p.ID, branch: "b1"}
		pr.sessions = append(pr.sessions, &Session{ID: "s1", project: pr, hub: h, conn: conn})
		h.projects[key(p.ID, "b1")] = pr
		h.mu.Unlock()
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := h.Call(ctx, p, "b1", "box", nil, "mcp")
		done <- err
	}()

	// The call reaches the session once it has joined; answer it.
	deadline := time.Now().Add(2 * time.Second)
	for {
		conn.mu.Lock()
		n := len(conn.frames)
		conn.mu.Unlock()
		if n > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("the call never reached the session that joined the branch")
		}
		time.Sleep(20 * time.Millisecond)
	}
	f := conn.last()
	if f["t"] != "call" || f["cmd"] != "box" {
		t.Fatalf("frame = %v, want the box call", f)
	}
	h.mu.Lock()
	s := h.projects[key(p.ID, "b1")].sessions[0]
	h.mu.Unlock()
	if err := s.Handle(ctx, []byte(`{"t":"result","id":"`+f["id"].(string)+`","ok":true,"result":{}}`)); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("call: %v", err)
	}
}

func TestCallOnProposalWithoutBrowser(t *testing.T) {
	old := BranchFollowTimeout
	BranchFollowTimeout = 100 * time.Millisecond
	defer func() { BranchFollowTimeout = old }()

	h := New(nil, config.Hub{CallTimeout: time.Second})
	p := &store.Project{ID: "p1", MainBranch: "main"}
	if _, err := h.Call(context.Background(), p, "b1", "box", nil, "mcp"); err == nil {
		t.Fatal("a call on a branch nobody has open must fail")
	}
}
