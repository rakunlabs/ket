package access

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/rakunlabs/ada/middleware/auth/identity"

	"github.com/rakunlabs/ket/internal/auth/users"
	"github.com/rakunlabs/ket/internal/config"
	"github.com/rakunlabs/ket/internal/store"
)

func TestLevels(t *testing.T) {
	dsn := os.Getenv("KET_TEST_DSN")
	if dsn == "" {
		t.Skip("KET_TEST_DSN not set")
	}
	ctx := context.Background()
	st, err := store.New(ctx, config.Store{Postgres: config.Postgres{DSN: dsn, MaxOpenConns: 4, Migrate: true}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	svc, err := users.New(users.Config{Roles: config.DefaultRoles, DefaultRoles: []string{"editor"}}, users.NewMemoryStore())
	if err != nil {
		t.Fatal(err)
	}
	c := New(st, svc)

	as := func(sub string, roles ...string) context.Context {
		return identity.WithContext(ctx, &identity.Identity{Subject: sub, Roles: roles})
	}
	p, _ := st.CreateProject(ctx, "acl", "", "alice")
	legacy, _ := st.CreateProject(ctx, "legacy", "", "")
	t.Cleanup(func() { _ = st.DeleteProject(ctx, p.ID); _ = st.DeleteProject(ctx, legacy.ID) })
	_ = st.SetMember(ctx, p.ID, "bob", store.MemberEditor)
	_ = st.SetMember(ctx, p.ID, "vic", store.MemberEditor)

	cases := []struct {
		who  context.Context
		on   *store.Project
		want Level
	}{
		{as("alice", "editor"), p, Owner},
		{as("alice", "viewer"), p, Viewer}, // a read-only account cannot edit its own project
		{as("bob", "editor"), p, Editor},
		{as("vic", "viewer"), p, Viewer}, // member editor capped by the account role
		{as("eve", "editor"), p, None},
		{as("root", "admin"), p, Owner},
		{as("eve", "editor"), legacy, Editor},
		{as("eve", "viewer"), legacy, Viewer},
		{ctx, p, None},
	}
	for i, tc := range cases {
		got, err := c.Level(tc.who, tc.on)
		if err != nil {
			t.Fatal(err)
		}
		if got != tc.want {
			t.Errorf("case %d: level %s, want %s", i, got, tc.want)
		}
	}

	if _, err := c.Project(as("eve", "editor"), p.ID, Viewer); !errors.Is(err, store.ErrNotFound) {
		t.Errorf("stranger: err = %v, want not found", err)
	}
	if _, err := c.Project(as("bob", "editor"), p.ID, Owner); !errors.Is(err, ErrDenied) {
		t.Errorf("member deleting: err = %v, want denied", err)
	}
	list, _ := c.Visible(as("eve", "editor"))
	for _, x := range list {
		if x.ID == p.ID {
			t.Error("eve must not see alice's project")
		}
	}

	// Without accounts everything is allowed.
	if l, _ := New(st, nil).Level(ctx, p); l != Owner {
		t.Errorf("no auth: %s", l)
	}
}
