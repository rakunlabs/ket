package server

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/rakunlabs/ada"
	"github.com/rakunlabs/ada/middleware/auth/identity"
	"github.com/rakunlabs/ada/middleware/auth/oauthserver"
	"github.com/rakunlabs/ada/middleware/auth/sessionstore"

	authkit "github.com/rakunlabs/ket/internal/auth"
	"github.com/rakunlabs/ket/internal/auth/users"
	"github.com/rakunlabs/ket/internal/config"
	"github.com/rakunlabs/ket/internal/settings"
	"github.com/rakunlabs/ket/internal/sso"
	authstore "github.com/rakunlabs/ket/internal/store/auth"
)

// Permissions (see config.DefaultRoles).
const (
	permRead     = "projects:read"
	permWrite    = "projects:write"
	permAI       = "ai:use"
	permSettings = "settings:write"
)

// guard is how routes are protected: every route needs a signed-in user
// (session cookie, OAuth token or personal token) with a permission.
type guard struct {
	kit *authkit.Kit
}

// api authenticates JSON routes (401, no redirect).
func (g guard) api() []func(http.Handler) http.Handler { return g.kit.API() }

// can requires a permission; use it inside an api() group.
func (g guard) can(perm string) func(http.Handler) http.Handler { return g.kit.RequirePermission(perm) }

// with combines the auth chain and a permission for a route.
func (g guard) with(perm string) []func(http.Handler) http.Handler {
	return append(g.kit.API(), g.kit.RequirePermission(perm))
}

// author names who made a change, for the op log.
func author(r *http.Request) string {
	id := identity.FromContext(r.Context())
	if id == nil {
		return "user"
	}
	name := id.Name
	if u, ok := id.Claims["username"].(string); ok && u != "" {
		name = u
	}
	if name == "" {
		name = id.Subject
	}

	return "user:" + name
}

// setupAuth builds the Auth Kit: users, OAuth and login sessions in
// PostgreSQL. Accounts are always on. With no users yet the login page
// offers sign-up and the first account becomes the administrator; sign-up
// and the default role of new accounts come from the admin settings.
func (s *Server) setupAuth(ctx context.Context) (*authkit.Kit, *authstore.Store, error) {
	st, err := authstore.New(s.Store.DB(), authstore.Config{Dialect: authstore.Postgres, TablePrefix: "auth_"})
	if err != nil {
		return nil, nil, fmt.Errorf("auth store; %w", err)
	}

	sessions, err := s.Store.Sessions(s.Settings.SessionKey(), sessionstore.Options{})
	if err != nil {
		return nil, nil, fmt.Errorf("session store; %w", err)
	}
	sessions.StartGC(15 * time.Minute)
	go func() {
		<-ctx.Done()
		_ = sessions.Close()
	}()

	base := s.cfg.Server.BasePath
	cfg := authkit.Config{
		BasePath:  base,
		CipherKey: s.Settings.Secrets().CipherKey,
		Users: users.Config{
			Roles:        config.DefaultRoles,
			DefaultRoles: []string{"editor"},
			Policy: func() users.Policy {
				cur := s.Settings.Get()
				return users.Policy{Signup: cur.Signup, DefaultRoles: []string{cur.DefaultRole}}
			},
			// An enabled SSO provider is another way in, so an administrator
			// without a password still counts as one who can sign in.
			ExternalLoginFn: func() bool { return s.sso.Enabled() },
			OnDelete: func(ctx context.Context, id string) {
				if err := s.Store.ForgetUser(ctx, id); err != nil {
					slog.Warn("forget deleted user", "user", id, "error", err)
				}
			},
			OnFirstAdmin: func(ctx context.Context, u *users.User) {
				n, err := s.Store.ClaimOrphanProjects(ctx, u.ID)
				if err != nil {
					slog.Warn("give projects to the first admin", "error", err)
					return
				}
				if n > 0 {
					slog.Info("projects made before accounts now belong to the first admin", "user", u.Username, "projects", n)
				}
			},
		},
		OAuth: authkit.OAuth{Enabled: true, Scopes: []string{"mcp"}},
	}
	cfg.Login.UI.Title = "Ket"
	cfg.Login.UI.Subtitle = "Parametric CAD and PCB"
	cfg.Login.UI.Version = config.Version
	// The mark and the page's styles are served next to the login page
	// (brand.go): relative URLs work under any base path and proxy prefix.
	cfg.Login.UI.Icon = "./brand/mark-light.svg"
	cfg.Login.UI.CustomCSSURL = "./brand/login.css"
	// The issuer and the MCP resource follow the public URL from the
	// settings; empty derives them from each request.
	cfg.ExternalURL = s.Settings.Get().PublicURL

	kit, err := authkit.New(ctx, cfg, authkit.Stores{Users: st, OAuth: st, Sessions: sessions})
	if err != nil {
		return nil, nil, fmt.Errorf("auth; %w", err)
	}

	go cleanupAuth(ctx, st)

	// SSO providers from the settings: their buttons appear on the login
	// page and change when an administrator saves them.
	s.sso = sso.New(s.Settings, kit.Users, base, kit.SetStrategies)
	if err := s.sso.Load(ctx); err != nil {
		slog.Error("sso providers", "error", err)
	}
	s.Settings.OnChange(func(settings.Settings) {
		// The public URL is part of every redirect URI.
		if err := s.sso.Load(context.Background()); err != nil {
			slog.Error("sso providers", "error", err)
		}
	})

	if kit.Users.NoUsers(ctx) {
		slog.Warn("no accounts yet: the first person to open Ket signs up and becomes the administrator")
	}

	return kit, st, nil
}

func cleanupAuth(ctx context.Context, st *authstore.Store) {
	t := time.NewTicker(15 * time.Minute)
	defer t.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			if err := st.DeleteExpired(ctx, time.Now()); err != nil {
				slog.Warn("auth cleanup", "error", err)
			}
		}
	}
}

// tokenAPI lets a signed-in user create personal access tokens for MCP
// clients that cannot do OAuth (scripts, older clients).
type tokenAPI struct {
	oauth *oauthserver.Server
	store *authstore.Store
}

func (t *tokenAPI) list(c *ada.Context) error {
	list, err := t.store.TokensBySubject(c.Request.Context(), identity.FromContext(c.Request.Context()).Subject)
	if err != nil {
		return err
	}

	out := make([]map[string]any, 0, len(list))
	for _, tok := range list {
		out = append(out, map[string]any{
			"id": tok.ID, "name": tok.Name, "client_id": tok.ClientID, "scopes": tok.Scopes,
			"created_at": tok.CreatedAt, "expires_at": tok.AccessExpiresAt,
		})
	}

	return c.SendJSON(out)
}

func (t *tokenAPI) create(c *ada.Context) error {
	var in struct {
		Name string `json:"name"`
		Days int    `json:"days"`
	}
	if err := c.Bind(&in); err != nil {
		return ada.WrapHTTPError(http.StatusBadRequest, err)
	}
	if in.Name == "" {
		return ada.NewHTTPError(http.StatusBadRequest, "name is required")
	}
	if in.Days < 0 || in.Days > 3650 {
		return ada.NewHTTPError(http.StatusBadRequest, "days must be 0 (never expires) to 3650")
	}

	raw, tok, err := t.oauth.IssueToken(c.Request.Context(), oauthserver.IssueRequest{
		Name:     in.Name,
		Identity: identity.FromContext(c.Request.Context()),
		Scopes:   []string{"mcp"},
		TTL:      time.Duration(in.Days) * 24 * time.Hour,
	})
	if err != nil {
		return err
	}

	// The raw token is shown once.
	return c.SetStatus(http.StatusCreated).SendJSON(map[string]any{"id": tok.ID, "token": raw})
}

func (t *tokenAPI) remove(c *ada.Context) error {
	ctx := c.Request.Context()
	me := identity.FromContext(ctx)
	list, err := t.store.TokensBySubject(ctx, me.Subject)
	if err != nil {
		return err
	}
	for _, tok := range list {
		if tok.ID == c.Request.PathValue("id") {
			if tok.ClientID != "" {
				_ = t.store.DeleteConsent(ctx, me.Subject, tok.ClientID)
			}
			if err := t.store.DeleteToken(ctx, tok.ID); err != nil {
				return err
			}
			return c.SendNoContent()
		}
	}

	return ada.NewHTTPError(http.StatusNotFound, "no such token")
}

// me tells the UI who is signed in and what they may do.
func (s *Server) me(c *ada.Context) error {
	id := identity.FromContext(c.Request.Context())
	if id == nil {
		return ada.NewHTTPError(http.StatusUnauthorized, "sign in")
	}
	username, _ := id.Claims["username"].(string)

	return c.SendJSON(map[string]any{
		"auth":        true,
		"id":          id.Subject,
		"username":    username,
		"name":        id.Name,
		"roles":       id.Roles,
		"permissions": s.guard.kit.Users.Permissions(id.Roles),
	})
}
