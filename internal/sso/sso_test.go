package sso

import (
	"context"
	"errors"
	"os"
	"slices"
	"testing"

	"github.com/rakunlabs/ada/middleware/auth/identity"

	"github.com/rakunlabs/ket/internal/auth/users"
	"github.com/rakunlabs/ket/internal/config"
	"github.com/rakunlabs/ket/internal/settings"
	"github.com/rakunlabs/ket/internal/store"
)

func TestHarvestRoles(t *testing.T) {
	claims := map[string]any{
		"groups":          []any{"hw", "fw"},
		"realm_access":    map[string]any{"roles": []any{"ket-admin"}},
		"resource_access": map[string]any{"ket": map[string]any{"roles": "a b"}},
	}
	got := HarvestRoles(claims, "groups, realm_access.roles, resource_access.*.roles, missing.x")
	want := []string{"hw", "fw", "ket-admin", "a", "b"}
	if !slices.Equal(got, want) {
		t.Fatalf("got %v want %v", got, want)
	}
	if r := Roles(&identity.Identity{Roles: []string{"hw", "x"}, Claims: claims}, "groups"); !slices.Equal(r, []string{"hw", "x", "fw"}) {
		t.Fatalf("roles %v", r)
	}
}

func TestResolve(t *testing.T) {
	dsn := os.Getenv("KET_TEST_DSN")
	if dsn == "" {
		t.Skip("KET_TEST_DSN is not set")
	}
	ctx := context.Background()
	st, err := store.New(ctx, config.Store{Postgres: config.Postgres{DSN: dsn, MaxOpenConns: 4, Migrate: true}})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(st.Close)
	set := settings.ForTest(st, settings.Settings{})
	svc, err := users.New(users.Config{Roles: config.DefaultRoles, DefaultRoles: []string{"viewer"}, ExternalLogin: true}, users.NewMemoryStore())
	if err != nil {
		t.Fatal(err)
	}
	m := New(set, svc, "/", nil)

	g, err := st.SaveGroup(ctx, &store.Group{Name: "sso-test-hw"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = st.DeleteGroup(ctx, g.ID)
		_, _ = st.DB().Exec(`DELETE FROM sso_identities WHERE provider = 'idp-test'`)
	})

	p := Provider{Name: "idp-test", Enabled: true, RolesClaim: "groups",
		RoleMapping: map[string]string{"ket-editors": "editor"}, DefaultRole: "viewer",
		GroupMapping: map[string]string{"hw": g.ID}}
	who := &identity.Identity{Subject: "sub-1", Email: "ada@example.com", EmailVerified: true, Name: "Ada",
		Claims: map[string]any{"groups": []any{"ket-editors", "hw"}}}

	// Unknown identity, no auto-create: refused.
	var d *Denied
	if _, err := m.Resolve(ctx, p, who); !errors.As(err, &d) {
		t.Fatalf("want refused, got %v", err)
	}

	// Link by verified email to an account an administrator made.
	made, err := svc.Create(ctx, users.CreateRequest{Username: "ada", Email: "Ada@Example.com"})
	if err != nil {
		t.Fatal(err)
	}
	p.LinkByEmail = true
	u, err := m.Resolve(ctx, p, who)
	if err != nil {
		t.Fatal(err)
	}
	if u.ID != made.ID || !slices.Equal(u.Roles, []string{"editor"}) {
		t.Fatalf("linked user %s roles %v", u.Username, u.Roles)
	}
	if gs, _ := st.UserGroups(ctx, u.ID); !slices.Contains(gs, g.ID) {
		t.Fatalf("mapped group missing: %v", gs)
	}

	// Next sign-in uses the link even without email; claims changed.
	p.LinkByEmail = false
	who2 := &identity.Identity{Subject: "sub-1", Claims: map[string]any{"groups": []any{}}}
	u, err = m.Resolve(ctx, p, who2)
	if err != nil {
		t.Fatal(err)
	}
	if !slices.Equal(u.Roles, []string{"viewer"}) {
		t.Fatalf("roles after losing the claim: %v", u.Roles)
	}
	if gs, _ := st.UserGroups(ctx, u.ID); slices.Contains(gs, g.ID) {
		t.Fatal("mapped group must be removed")
	}

	// Auto-create a new person.
	p.AutoCreate = true
	nu, err := m.Resolve(ctx, p, &identity.Identity{Subject: "sub-2", Email: "bo@example.com", EmailVerified: true})
	if err != nil {
		t.Fatal(err)
	}
	if nu.Username != "bo@example.com" || nu.HasPassword() {
		t.Fatalf("created %q password=%v", nu.Username, nu.HasPassword())
	}

	// Domain allow-list.
	p.AllowedDomains = []string{"corp.example"}
	if _, err := m.Resolve(ctx, p, &identity.Identity{Subject: "sub-3", Email: "x@example.com", EmailVerified: true}); !errors.As(err, &d) {
		t.Fatalf("domain: %v", err)
	}
	_ = st.ForgetUser(ctx, made.ID)
	_ = st.ForgetUser(ctx, nu.ID)
}
