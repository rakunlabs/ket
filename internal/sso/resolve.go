package sso

import (
	"context"
	"errors"
	"fmt"
	"html"
	"log/slog"
	"net/http"
	"regexp"
	"slices"
	"strings"

	"github.com/rakunlabs/ada/middleware/auth/identity"
	"github.com/rakunlabs/ada/middleware/auth/strategy"
	"github.com/rakunlabs/ada/middleware/auth/strategy/oauth2"

	"github.com/rakunlabs/ket/internal/auth/users"
	"github.com/rakunlabs/ket/internal/store"
)

// Denied is a refused sign-in; its message is shown to the person and never
// names other accounts.
type Denied struct{ Reason string }

func (e *Denied) Error() string { return e.Reason }

func denied(reason string) error { return &Denied{Reason: reason} }

// mapped is a provider's strategy whose identities become local users.
type mapped struct {
	*oauth2.Strategy
	m    *Manager
	name string
}

func (s *mapped) Login(w http.ResponseWriter, r *http.Request) (*identity.Identity, strategy.Outcome, error) {
	id, out, err := s.Strategy.Login(w, r)
	if err != nil || out != strategy.OutcomeContinue || id == nil {
		return id, out, err
	}

	p, ok := s.m.provider(s.name)
	if !ok || !p.Enabled {
		refuse(w, "This sign-in provider is turned off.")
		return nil, strategy.OutcomeFailed, nil
	}

	u, err := s.m.Resolve(r.Context(), p, id)
	if err != nil {
		var d *Denied
		if errors.As(err, &d) {
			slog.Info("sso sign-in refused", "provider", p.Name, "subject", id.Subject, "reason", d.Reason)
			refuse(w, d.Reason)
			return nil, strategy.OutcomeFailed, nil
		}
		slog.Error("sso sign-in", "provider", p.Name, "error", err)
		refuse(w, "Sign-in failed. Try again, or ask an administrator.")
		return nil, strategy.OutcomeFailed, nil
	}

	local := s.m.users.Identity(u)
	local.Provider = s.name

	return local, strategy.OutcomeContinue, nil
}

// refuse answers in the sign-in popup with the reason and a way back.
func refuse(w http.ResponseWriter, reason string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusForbidden)
	_, _ = fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><title>Sign-in refused</title>
<body style="font:14px/1.5 system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#222220;background:#fdfdfb">
<h1 style="font-size:18px">Sign-in refused</h1><p>%s</p>
<button onclick="window.close()" style="font:inherit;padding:4px 12px;border:1px solid #93938b;background:#fbff81;border-radius:3px;cursor:pointer">Close</button>
</body>`, html.EscapeString(reason))
}

// Resolve maps an identity from the provider to a local user:
//
//  1. an identity linked before signs in as that user;
//  2. with LinkByEmail, a verified email that matches exactly one user;
//  3. with AutoCreate, a new account.
//
// Anything else is refused. Roles and mapped groups are synced afterwards.
func (m *Manager) Resolve(ctx context.Context, p Provider, id *identity.Identity) (*users.User, error) {
	if id.Subject == "" {
		return nil, denied("The provider did not say who you are (no subject).")
	}
	email := strings.ToLower(strings.TrimSpace(id.Email))

	if len(p.AllowedDomains) > 0 {
		_, domain, _ := strings.Cut(email, "@")
		if email == "" || !id.EmailVerified || !slices.Contains(p.AllowedDomains, domain) {
			return nil, denied("Your email domain may not sign in to Ket.")
		}
	}

	u, err := m.find(ctx, p, id, email)
	if err != nil {
		return nil, err
	}
	if u.Disabled {
		return nil, denied("Your account is disabled. Ask an administrator.")
	}

	return m.sync(ctx, p, u, Roles(id, p.RolesClaim))
}

func (m *Manager) find(ctx context.Context, p Provider, id *identity.Identity, email string) (*users.User, error) {
	uid, err := m.store.IdentityUser(ctx, p.Name, id.Subject)
	switch {
	case err == nil:
		u, err := m.users.Store().GetUser(ctx, uid)
		if !errors.Is(err, users.ErrNotFound) {
			return u, err
		}
		// The user was deleted: treat the identity as new.
	case !errors.Is(err, store.ErrNotFound):
		return nil, err
	}

	if p.LinkByEmail && email != "" && id.EmailVerified {
		all, err := m.users.Store().ListUsers(ctx)
		if err != nil {
			return nil, err
		}
		var match []*users.User
		for _, u := range all {
			if strings.EqualFold(strings.TrimSpace(u.Email), email) {
				match = append(match, u)
			}
		}
		switch len(match) {
		case 1:
			if err := m.store.LinkIdentity(ctx, store.Identity{Provider: p.Name, Subject: id.Subject, UserID: match[0].ID, Email: email}); err != nil {
				return nil, err
			}
			slog.Info("sso identity linked by email", "provider", p.Name, "user", match[0].Username)
			return match[0], nil
		case 0:
		default:
			return nil, denied("More than one account uses your email. Ask an administrator to link your sign-in.")
		}
	}

	if !p.AutoCreate {
		return nil, denied("No Ket account is linked to this sign-in. Ask an administrator for access.")
	}

	return m.create(ctx, p, id, email)
}

var usernameCleaner = regexp.MustCompile(`[^a-zA-Z0-9._@+-]+`)

func (m *Manager) create(ctx context.Context, p Provider, id *identity.Identity, email string) (*users.User, error) {
	base := ""
	if email != "" && id.EmailVerified {
		base = email
	} else if v, ok := id.Claims["preferred_username"].(string); ok {
		base = v
	}
	base = usernameCleaner.ReplaceAllString(base, "")
	if len(base) < 2 {
		base = usernameCleaner.ReplaceAllString(p.Name+"-"+id.Subject, "")
	}
	if len(base) > 56 {
		base = base[:56]
	}
	verified := ""
	if id.EmailVerified {
		verified = email
	}
	var roles []string
	if p.DefaultRole != "" {
		roles = []string{p.DefaultRole}
	}

	for i := range 20 {
		name := base
		if i > 0 {
			name = fmt.Sprintf("%s-%d", base, i+1)
		}
		// No password: the person signs in through the provider.
		u, err := m.users.Create(ctx, users.CreateRequest{Username: name, Name: id.Name, Email: verified, Roles: roles})
		if errors.Is(err, users.ErrExists) {
			continue
		}
		if err != nil {
			return nil, err
		}
		if err := m.store.LinkIdentity(ctx, store.Identity{Provider: p.Name, Subject: id.Subject, UserID: u.ID, Email: email}); err != nil {
			return nil, err
		}
		slog.Info("sso account created", "provider", p.Name, "user", name)

		return u, nil
	}

	return nil, errors.New("sso: could not pick a free username")
}

// sync applies the role and group mappings from the claim values. Only
// groups named in GroupMapping are added or removed.
func (m *Manager) sync(ctx context.Context, p Provider, u *users.User, claims []string) (*users.User, error) {
	if len(p.RoleMapping) > 0 {
		var want []string
		for claim, role := range p.RoleMapping {
			if slices.Contains(claims, claim) && !slices.Contains(want, role) {
				want = append(want, role)
			}
		}
		if len(want) == 0 && p.DefaultRole != "" {
			want = []string{p.DefaultRole}
		}
		slices.Sort(want)
		have := slices.Clone(u.Roles)
		slices.Sort(have)
		if len(want) > 0 && !slices.Equal(want, have) {
			next, err := m.users.Update(ctx, u.ID, users.UpdateRequest{Roles: &want})
			switch {
			case errors.Is(err, users.ErrLastAdmin):
				slog.Warn("sso would demote the last administrator; keeping their roles", "user", u.Username)
			case err != nil:
				return nil, fmt.Errorf("sync roles; %w", err)
			default:
				u = next
			}
		}
	}

	if len(p.GroupMapping) > 0 {
		var add, remove []string
		for claim, g := range p.GroupMapping {
			if slices.Contains(claims, claim) {
				add = append(add, g)
			} else {
				remove = append(remove, g)
			}
		}
		// A group mapped from two claims stays when either matches.
		remove = slices.DeleteFunc(remove, func(g string) bool { return slices.Contains(add, g) })
		if err := m.store.SetUserGroups(ctx, u.ID, add, remove); err != nil {
			return nil, fmt.Errorf("sync groups; %w", err)
		}
	}

	return u, nil
}

// Roles is the identity's flat "roles" claim with the values at the extra
// claim paths (pika's effective roles).
func Roles(id *identity.Identity, paths string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, src := range [][]string{id.Roles, HarvestRoles(id.Claims, paths)} {
		for _, r := range src {
			if r != "" && !seen[r] {
				seen[r] = true
				out = append(out, r)
			}
		}
	}

	return out
}

// HarvestRoles collects strings at each comma-separated dotted path, such as
// "groups" or "realm_access.roles". A "*" segment walks every value of a
// map ("resource_access.*.roles"). Leaves may be arrays or space-separated
// strings.
func HarvestRoles(claims map[string]any, paths string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, path := range strings.Split(paths, ",") {
		var segs []string
		for _, s := range strings.Split(path, ".") {
			if s = strings.TrimSpace(s); s != "" {
				segs = append(segs, s)
			}
		}
		if len(segs) == 0 {
			continue
		}
		walk(claims, segs, func(roles []string) {
			for _, r := range roles {
				if r != "" && !seen[r] {
					seen[r] = true
					out = append(out, r)
				}
			}
		})
	}

	return out
}

func walk(node any, segs []string, emit func([]string)) {
	if len(segs) == 0 {
		emit(leaf(node))
		return
	}
	m, ok := node.(map[string]any)
	if !ok {
		return
	}
	if segs[0] == "*" {
		for _, v := range m {
			walk(v, segs[1:], emit)
		}
		return
	}
	if next, ok := m[segs[0]]; ok {
		walk(next, segs[1:], emit)
	}
}

func leaf(v any) []string {
	switch t := v.(type) {
	case []any:
		out := make([]string, 0, len(t))
		for _, item := range t {
			if s, ok := item.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case []string:
		return t
	case string:
		return strings.Fields(t)
	}

	return nil
}
