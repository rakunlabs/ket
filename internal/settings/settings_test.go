package settings

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/rakunlabs/ket/internal/config"
	"github.com/rakunlabs/ket/internal/store"
)

func TestSettings(t *testing.T) {
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
	// Fresh table for this test; restore what was there.
	var saved []byte
	_ = st.DB().QueryRow(`SELECT value FROM settings WHERE key = 'settings'`).Scan(&saved)
	_, _ = st.DB().Exec(`DELETE FROM settings WHERE key = 'settings'`)
	t.Cleanup(func() {
		_, _ = st.DB().Exec(`DELETE FROM settings WHERE key = 'settings'`)
		if saved != nil {
			_, _ = st.DB().Exec(`INSERT INTO settings (key, value) VALUES ('settings', $1)`, saved)
		}
	})

	seed := Settings{Providers: []Provider{{Name: "oa", Model: "gpt-x", APIKey: "sk-secret"}}}
	s, err := Load(ctx, st, seed)
	if err != nil {
		t.Fatal(err)
	}
	cur := s.Get()
	if cur.Providers[0].BaseURL != "https://api.openai.com/v1" || cur.DefaultRole != "editor" || cur.MaxSteps != 40 {
		t.Fatalf("defaults: %+v", cur)
	}

	// Keys are encrypted at rest and never in the public view.
	var raw string
	_ = st.DB().QueryRow(`SELECT value::text FROM settings WHERE key = 'settings'`).Scan(&raw)
	if strings.Contains(raw, "sk-secret") || !strings.Contains(raw, "enc:v1:") {
		t.Fatalf("stored settings leak the key: %s", raw)
	}
	pub := s.Public()
	if pub.Providers[0].APIKey != "" || !pub.Providers[0].HasKey {
		t.Fatalf("public view: %+v", pub.Providers[0])
	}

	// Saving without a key keeps the stored one; clear_keys removes it.
	var seen Settings
	s.OnChange(func(v Settings) { seen = v })
	next := s.Get()
	next.Providers[0].APIKey = ""
	next.Providers[0].Model = "gpt-y"
	if _, err := s.Update(ctx, next, nil, []string{"admin", "editor"}, "test"); err != nil {
		t.Fatal(err)
	}
	if s.Get().Providers[0].APIKey != "sk-secret" || seen.Providers[0].Model != "gpt-y" {
		t.Fatal("update lost the key or skipped the hook")
	}
	again, err := Load(ctx, st, Settings{})
	if err != nil || again.Get().Providers[0].APIKey != "sk-secret" {
		t.Fatalf("reload: %v", err)
	}
	next = s.Get()
	next.Providers[0].APIKey = ""
	_, _ = s.Update(ctx, next, []string{"oa"}, nil, "test")
	if s.Get().Providers[0].APIKey != "" {
		t.Fatal("clear_keys did not clear")
	}

	// Validation speaks to the admin.
	bad := s.Get()
	bad.Providers = append(bad.Providers, Provider{Name: "oa", Model: "m"})
	if _, err := s.Update(ctx, bad, nil, nil, "test"); err == nil || !strings.Contains(err.Error(), `two providers are named "oa"`) {
		t.Fatalf("duplicate: %v", err)
	}
	bad = s.Get()
	bad.DefaultRole = "boss"
	if _, err := s.Update(ctx, bad, nil, []string{"admin", "editor"}, "test"); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("role: %v", err)
	}
}
