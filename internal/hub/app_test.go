package hub

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"testing"

	"github.com/rakunlabs/ket/internal/config"
	"github.com/rakunlabs/ket/internal/store"
)

type fakeConn struct {
	mu     sync.Mutex
	frames []map[string]any
}

func (f *fakeConn) Send(_ context.Context, msg []byte) error {
	var m map[string]any
	if err := json.Unmarshal(msg, &m); err != nil {
		return err
	}
	f.mu.Lock()
	f.frames = append(f.frames, m)
	f.mu.Unlock()

	return nil
}

func (f *fakeConn) last() map[string]any {
	f.mu.Lock()
	defer f.mu.Unlock()

	return f.frames[len(f.frames)-1]
}

func TestAppClients(t *testing.T) {
	ctx := context.Background()
	h := New(nil, config.Hub{})
	p := &store.Project{ID: "p1", Name: "case"}

	if _, err := h.OpenProject(ctx, "u1", p, true); !errors.Is(err, ErrNoApp) {
		t.Fatalf("open without a window: err = %v, want ErrNoApp", err)
	}

	a, b := &fakeConn{}, &fakeConn{}
	ca, err := h.Connect(ctx, a, "u1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := h.Connect(ctx, b, "u1"); err != nil {
		t.Fatal(err)
	}
	if a.last()["t"] != "hello" {
		t.Fatalf("first frame = %v, want hello", a.last())
	}
	if n := h.Clients("u1"); n != 2 {
		t.Fatalf("clients = %d, want 2", n)
	}

	// The most recently focused window gets new tabs.
	if err := ca.Handle(ctx, []byte(`{"t":"focus"}`)); err != nil {
		t.Fatal(err)
	}
	if got := h.focusedClient("u1"); got != ca {
		t.Fatalf("focused client = %v, want %v", got.ID, ca.ID)
	}

	if err := h.CloseProject(ctx, "u1", "p1"); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*fakeConn{a, b} {
		if f := c.last(); f["t"] != "close" || f["project"] != "p1" {
			t.Fatalf("close frame = %v", f)
		}
	}

	h.Disconnect(ca)
	h.Disconnect(ca)
	if n := h.Clients("u1"); n != 1 {
		t.Fatalf("clients after disconnect = %d, want 1", n)
	}
	if h.Clients("u2") != 0 {
		t.Fatal("another user sees u1's windows")
	}
}
