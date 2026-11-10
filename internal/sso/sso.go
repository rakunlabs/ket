// Package sso signs people in through OAuth2 / OpenID Connect providers
// that an administrator configures in the settings.
//
// The protocol work (state, nonce, PKCE, code exchange, id_token checks) is
// ada's oauth2 strategy. This package keeps the provider settings, decides
// which local user an outside identity becomes (linked before, matched by a
// verified email, or created), and syncs roles and groups from the
// provider's claims on every sign-in. Signed-in SSO users are ordinary local
// users, so roles, sharing, groups and tokens work the same for them.
package sso

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/rakunlabs/ada/middleware/auth/strategy"
	"github.com/rakunlabs/ada/middleware/auth/strategy/oauth2"

	"github.com/rakunlabs/ket/internal/auth/users"
	"github.com/rakunlabs/ket/internal/settings"
	"github.com/rakunlabs/ket/internal/store"
)

const settingKey = "sso"

var namePattern = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,31}$`)

// Provider is one identity provider.
type Provider struct {
	Name        string `json:"name"`
	DisplayName string `json:"display_name"`
	Enabled     bool   `json:"enabled"`

	// IssuerURL turns on OIDC discovery. Explicit endpoints win over it.
	IssuerURL   string   `json:"issuer_url"`
	AuthURL     string   `json:"auth_url"`
	TokenURL    string   `json:"token_url"`
	UserInfoURL string   `json:"userinfo_url"`
	JWKSURL     string   `json:"jwks_url"`
	ClientID    string   `json:"client_id"`
	Scopes      []string `json:"scopes"`
	// TokenAuthMethod is "" (basic), "post", "bearer" or "query".
	TokenAuthMethod string `json:"token_auth_method"`
	DisablePKCE     bool   `json:"disable_pkce"`

	// ClientSecret is encrypted at rest and never sent to the browser.
	ClientSecret string `json:"client_secret,omitempty"`

	// AutoCreate makes an account on the first sign-in of an unknown
	// identity. Off: only people an administrator added can sign in.
	AutoCreate bool `json:"auto_create"`
	// LinkByEmail signs an unknown identity in as the user with the same
	// email, when the provider says the email is verified.
	LinkByEmail bool `json:"link_by_email"`
	// AllowedDomains limits sign-in to these email domains when set.
	AllowedDomains []string `json:"allowed_domains"`

	// RolesClaim lists extra dotted claim paths, comma separated, such as
	// "groups, realm_access.roles, resource_access.*.roles". Their values
	// join the flat "roles" claim and are matched by the mappings below.
	RolesClaim string `json:"roles_claim"`
	// RoleMapping maps a claim value to a Ket role (admin, editor, viewer).
	// When set, the user's roles follow the provider on every sign-in;
	// with no match they get DefaultRole.
	RoleMapping map[string]string `json:"role_mapping"`
	// DefaultRole is given to accounts this provider creates, and with a
	// role mapping to users no mapping matches. Empty: the sign-up default.
	DefaultRole string `json:"default_role"`
	// GroupMapping maps a claim value to a Ket group id. Mapped groups are
	// synced on every sign-in; groups an administrator set by hand stay.
	GroupMapping map[string]string `json:"group_mapping"`
}

// View is the provider as the admin page sees it.
type View struct {
	Provider
	ClientSecret any    `json:"client_secret,omitempty"`
	HasSecret    bool   `json:"has_secret"`
	CallbackURL  string `json:"callback_url"`
	// Status is why an enabled provider does not work, "" when it does.
	Status string `json:"status,omitempty"`
}

// Manager owns the providers and their strategies.
type Manager struct {
	settings *settings.Service
	store    *store.Store
	users    *users.Service
	base     string
	// install replaces the login strategies (authkit.Kit.SetStrategies).
	install func(...strategy.Authenticator)

	mu        sync.RWMutex
	providers []Provider
	errs      map[string]string
	enabled   bool
}

func New(st *settings.Service, u *users.Service, basePath string, install func(...strategy.Authenticator)) *Manager {
	base := "/" + strings.Trim(basePath, "/")
	if base == "/" {
		base = ""
	}

	return &Manager{settings: st, store: st.Store(), users: u, base: base, install: install}
}

// Enabled reports whether any provider is on, so an administrator without
// a password still counts as someone who can sign in.
func (m *Manager) Enabled() bool {
	if m == nil {
		return false
	}
	m.mu.RLock()
	defer m.mu.RUnlock()

	return m.enabled
}

// origin and prefix of the public URL; empty origin derives it from the
// request.
func (m *Manager) public() (string, string) {
	raw := strings.TrimSpace(m.settings.Get().PublicURL)
	u, err := url.Parse(raw)
	if raw == "" || err != nil || u.Scheme == "" || u.Host == "" {
		return "", m.base
	}
	// The public URL is the app's root including any proxy prefix; one
	// without a path is served at the base path.
	prefix := strings.TrimRight(u.Path, "/")
	if prefix == "" {
		prefix = m.base
	}

	return u.Scheme + "://" + u.Host, prefix
}

func (m *Manager) callbackPath() string {
	_, prefix := m.public()

	return prefix + "/login/callback"
}

// CallbackURL is the redirect URI to register at the provider.
func (m *Manager) CallbackURL(name string) string {
	origin, _ := m.public()
	if origin == "" {
		origin = "{your Ket address}"
	}

	return origin + m.callbackPath() + "/" + name
}

// Load reads the providers and installs their sign-in buttons.
func (m *Manager) Load(ctx context.Context) error {
	providers, err := m.read(ctx)
	if err != nil {
		return err
	}

	errs := map[string]string{}
	var list []strategy.Authenticator
	enabled := false
	for _, p := range providers {
		if !p.Enabled {
			continue
		}
		enabled = true
		s, err := m.build(ctx, p)
		if err != nil {
			slog.Error("sso provider is unavailable", "provider", p.Name, "error", err)
			errs[p.Name] = err.Error()
		}
		if s != nil {
			list = append(list, &mapped{Strategy: s, m: m, name: p.Name})
		}
	}

	m.mu.Lock()
	m.providers = providers
	m.errs = errs
	m.enabled = enabled
	m.mu.Unlock()

	if m.install != nil {
		m.install(list...)
	}

	return nil
}

func (m *Manager) read(ctx context.Context) ([]Provider, error) {
	var providers []Provider
	err := m.store.Setting(ctx, settingKey, &providers)
	if errors.Is(err, store.ErrNotFound) {
		return []Provider{}, nil
	}
	if err != nil {
		return nil, err
	}
	for i := range providers {
		plain, err := m.settings.Open(providers[i].ClientSecret)
		if err != nil {
			return nil, fmt.Errorf("sso: the client secret of %q cannot be decrypted; enter it again in Settings → Sign-in", providers[i].Name)
		}
		providers[i].ClientSecret = plain
	}

	return providers, nil
}

func (m *Manager) write(ctx context.Context, providers []Provider, by string) error {
	enc := make([]Provider, len(providers))
	for i, p := range providers {
		sealed, err := m.settings.Seal(p.ClientSecret)
		if err != nil {
			return err
		}
		p.ClientSecret = sealed
		enc[i] = p
	}
	if err := m.store.SetSetting(ctx, settingKey, enc, by); err != nil {
		return err
	}

	return m.Load(ctx)
}

func (m *Manager) build(ctx context.Context, p Provider) (*oauth2.Strategy, error) {
	style, _ := oauth2.ParseAuthHeaderStyle(p.TokenAuthMethod)
	cfg := oauth2.Config{
		ClientID:        p.ClientID,
		ClientSecret:    p.ClientSecret,
		Scopes:          p.Scopes,
		AuthURL:         p.AuthURL,
		TokenURL:        p.TokenURL,
		UserInfoURL:     p.UserInfoURL,
		JWKSURL:         p.JWKSURL,
		DisablePKCE:     p.DisablePKCE,
		AuthHeaderStyle: style,
	}
	// As in pika and dataport: explicit endpoints skip discovery, so a
	// discovery document that differs in a trailing slash cannot disable
	// the provider. Discovery is still used when it is the only source.
	if p.AuthURL == "" || p.TokenURL == "" || (p.UserInfoURL == "" && p.JWKSURL == "") {
		cfg.IssuerURL = p.IssuerURL
	}

	origin, _ := m.public()
	label := p.DisplayName
	if label == "" {
		label = p.Name
	}

	return oauth2.NewWithContext(ctx, p.Name, cfg, oauth2.Options{
		Label: "Sign in with " + label,
		// Strategies installed after Mount are not bound by it, so the
		// callback path is set here; it matches {base}login/callback/{name}.
		CallbackBasePath:               m.callbackPath(),
		CallbackBaseURL:                origin,
		UnsafeTrustAllForwardedHeaders: origin == "",
	})
}

// Views lists the providers for the admin page, without secrets.
func (m *Manager) Views() []View {
	m.mu.RLock()
	defer m.mu.RUnlock()

	out := make([]View, 0, len(m.providers))
	for _, p := range m.providers {
		v := View{Provider: p, HasSecret: p.ClientSecret != "", CallbackURL: m.CallbackURL(p.Name), Status: m.errs[p.Name]}
		v.ClientSecret = nil
		out = append(out, v)
	}

	return out
}

func (m *Manager) provider(name string) (Provider, bool) {
	m.mu.RLock()
	defer m.mu.RUnlock()
	for _, p := range m.providers {
		if p.Name == name {
			return p, true
		}
	}

	return Provider{}, false
}

// Save validates and stores a provider under original (empty: new). A nil
// secret keeps the stored one.
func (m *Manager) Save(ctx context.Context, original string, p Provider, secret *string, by string) error {
	p.Name = strings.ToLower(strings.TrimSpace(p.Name))
	if !namePattern.MatchString(p.Name) {
		return errors.New("name must be lowercase letters, digits, - or _, up to 32 characters (it is part of the callback URL)")
	}
	p.ClientID = strings.TrimSpace(p.ClientID)
	if p.ClientID == "" {
		return errors.New("client ID is required: copy it from the provider's app registration")
	}
	for _, u := range []*string{&p.IssuerURL, &p.AuthURL, &p.TokenURL, &p.UserInfoURL, &p.JWKSURL} {
		*u = strings.TrimSpace(*u)
		if *u != "" && !strings.HasPrefix(*u, "https://") && !strings.HasPrefix(*u, "http://") {
			return fmt.Errorf("%q is not a URL: it must start with https://", *u)
		}
	}
	if p.IssuerURL == "" && (p.AuthURL == "" || p.TokenURL == "") {
		return errors.New("set the issuer URL (OpenID Connect), or both the authorization and token URLs")
	}
	if p.IssuerURL == "" && p.UserInfoURL == "" && p.JWKSURL == "" {
		return errors.New("without an issuer URL, set the userinfo URL so Ket can read who signed in")
	}
	if len(p.Scopes) == 0 {
		p.Scopes = []string{"openid", "email", "profile"}
	}
	if _, ok := oauth2.ParseAuthHeaderStyle(p.TokenAuthMethod); !ok {
		return errors.New("token auth method must be basic, post, bearer or query")
	}
	for i, d := range p.AllowedDomains {
		p.AllowedDomains[i] = strings.ToLower(strings.TrimPrefix(strings.TrimSpace(d), "@"))
	}
	p.AllowedDomains = slices.DeleteFunc(p.AllowedDomains, func(s string) bool { return s == "" })

	roles := map[string]bool{}
	for _, r := range m.users.Roles() {
		roles[r.Name] = true
	}
	for claim, role := range p.RoleMapping {
		if !roles[role] {
			return fmt.Errorf("role mapping %q → %q: no such role", claim, role)
		}
	}
	if p.DefaultRole != "" && !roles[p.DefaultRole] {
		return fmt.Errorf("default role %q does not exist", p.DefaultRole)
	}
	if len(p.GroupMapping) > 0 {
		groups, err := m.store.Groups(ctx)
		if err != nil {
			return err
		}
		for claim, g := range p.GroupMapping {
			if !slices.ContainsFunc(groups, func(x *store.Group) bool { return x.ID == g }) {
				return fmt.Errorf("group mapping %q: the group no longer exists", claim)
			}
		}
	}

	providers, err := m.read(ctx)
	if err != nil {
		return err
	}
	idx := slices.IndexFunc(providers, func(x Provider) bool { return x.Name == original })
	if original != p.Name && slices.ContainsFunc(providers, func(x Provider) bool { return x.Name == p.Name }) {
		return fmt.Errorf("a provider named %q already exists", p.Name)
	}
	switch {
	case secret != nil:
		p.ClientSecret = *secret
	case idx >= 0:
		p.ClientSecret = providers[idx].ClientSecret
	default:
		p.ClientSecret = ""
	}
	if idx >= 0 {
		providers[idx] = p
	} else {
		providers = append(providers, p)
	}

	return m.write(ctx, providers, by)
}

func (m *Manager) Delete(ctx context.Context, name, by string) error {
	providers, err := m.read(ctx)
	if err != nil {
		return err
	}
	n := len(providers)
	providers = slices.DeleteFunc(providers, func(p Provider) bool { return p.Name == name })
	if len(providers) == n {
		return fmt.Errorf("provider %q; %w", name, store.ErrNotFound)
	}

	return m.write(ctx, providers, by)
}
