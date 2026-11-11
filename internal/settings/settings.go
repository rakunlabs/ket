// Package settings holds what an administrator configures in the UI: AI
// providers, sign-up, the autorouter. Values live in the settings table;
// API keys are encrypted with a key generated on first start. The config
// file keeps only infrastructure (database, address, base path).
package settings

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/rakunlabs/ket/internal/store"
)

// Provider is an OpenAI-compatible chat endpoint.
type Provider struct {
	Name    string `json:"name"`
	BaseURL string `json:"base_url"`
	// APIKey is encrypted in the database and never sent to the browser.
	APIKey      string  `json:"api_key,omitempty"`
	Model       string  `json:"model"`
	Vision      bool    `json:"vision"`
	Temperature float64 `json:"temperature,omitempty"`
	// PreviousName, on update, is the provider's name before a rename, so
	// its stored key follows it. Never stored.
	PreviousName string `json:"previous_name,omitempty"`
}

// Settings is everything the admin page edits.
type Settings struct {
	// PublicURL is how users and MCP clients reach Ket; empty derives it
	// from requests.
	PublicURL string `json:"public_url"`
	// Signup lets anyone create an account on the login page.
	Signup bool `json:"signup"`
	// DefaultRole is given to new accounts.
	DefaultRole string `json:"default_role"`

	Providers []Provider `json:"providers"`
	// DefaultProvider is used when a chat does not pick one.
	DefaultProvider string `json:"default_provider,omitempty"`
	// MaxSteps caps the tool-calling rounds of one user turn.
	MaxSteps int `json:"max_steps"`
}

const (
	keySettings = "settings"
	keySecrets  = "secrets"
)

// Secrets are generated once and kept in the database.
type Secrets struct {
	// SessionKey signs session cookies.
	SessionKey string `json:"session_key"`
	// CipherKey encrypts sessions at rest (ada) and secret settings (here).
	CipherKey string `json:"cipher_key"`
}

func (s *Settings) normalize() {
	if s.DefaultRole == "" {
		s.DefaultRole = "editor"
	}
	if s.MaxSteps <= 0 {
		s.MaxSteps = 40
	}
	if s.Providers == nil {
		s.Providers = []Provider{}
	}
	for i := range s.Providers {
		p := &s.Providers[i]
		p.Name = strings.TrimSpace(p.Name)
		p.BaseURL = strings.TrimRight(strings.TrimSpace(p.BaseURL), "/")
		if p.BaseURL == "" {
			p.BaseURL = "https://api.openai.com/v1"
		}
		if p.Name == "" {
			p.Name = p.Model
		}
	}
	if s.DefaultProvider != "" && !s.hasProvider(s.DefaultProvider) {
		s.DefaultProvider = ""
	}
}

func (s *Settings) hasProvider(name string) bool {
	for _, p := range s.Providers {
		if p.Name == name {
			return true
		}
	}

	return false
}

// Validate reports the first problem an admin has to fix, in words.
func (s *Settings) Validate(roles []string) error {
	seen := map[string]bool{}
	for i, p := range s.Providers {
		if p.Name == "" {
			return fmt.Errorf("provider %d needs a name", i+1)
		}
		if p.Model == "" {
			return fmt.Errorf("provider %q needs a model", p.Name)
		}
		if !strings.HasPrefix(p.BaseURL, "http://") && !strings.HasPrefix(p.BaseURL, "https://") {
			return fmt.Errorf("provider %q: base URL must start with http:// or https://", p.Name)
		}
		if seen[p.Name] {
			return fmt.Errorf("two providers are named %q", p.Name)
		}
		seen[p.Name] = true
	}
	if s.MaxSteps > 500 {
		return errors.New("max steps must be at most 500")
	}
	if s.PublicURL != "" && !strings.HasPrefix(s.PublicURL, "http://") && !strings.HasPrefix(s.PublicURL, "https://") {
		return errors.New("public URL must start with http:// or https://")
	}
	if len(roles) > 0 {
		ok := false
		for _, r := range roles {
			ok = ok || r == s.DefaultRole
		}
		if !ok {
			return fmt.Errorf("default role %q does not exist; roles are %s", s.DefaultRole, strings.Join(roles, ", "))
		}
	}

	return nil
}

// Service caches the settings and saves changes.
type Service struct {
	store   *store.Store
	secrets Secrets
	aead    cipher.AEAD

	mu  sync.RWMutex
	cur Settings

	// onChange hooks run after a save (e.g. the users service picks up
	// the sign-up switch).
	onChange []func(Settings)
}

// Load reads the settings, creating the secrets on first start. seed fills
// settings that were never saved (from an old config file).
func Load(ctx context.Context, st *store.Store, seed Settings) (*Service, error) {
	gen := Secrets{SessionKey: random(32), CipherKey: random(32)}
	if err := st.SettingOnce(ctx, keySecrets, &gen); err != nil {
		return nil, err
	}
	key, err := base64.RawURLEncoding.DecodeString(gen.CipherKey)
	if err != nil || len(key) != 32 {
		return nil, errors.New("settings: stored cipher key is damaged")
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	aead, err := cipher.NewGCM(block)
	if err != nil {
		return nil, err
	}
	s := &Service{store: st, secrets: gen, aead: aead}

	var cur Settings
	switch err := st.Setting(ctx, keySettings, &cur); {
	case errors.Is(err, store.ErrNotFound):
		cur = seed
		cur.normalize()
		if err := s.save(ctx, cur, "system"); err != nil {
			return nil, err
		}
	case err != nil:
		return nil, err
	default:
		if err := s.decrypt(&cur); err != nil {
			return nil, err
		}
	}
	cur.normalize()
	s.cur = cur

	return s, nil
}

func random(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}

	return base64.RawURLEncoding.EncodeToString(b)
}

// Secrets are the generated keys (session signing, encryption).
func (s *Service) Secrets() Secrets { return s.secrets }

// SessionKey is the raw cookie signing key.
func (s *Service) SessionKey() []byte {
	k, _ := base64.RawURLEncoding.DecodeString(s.secrets.SessionKey)

	return k
}

// Get returns a copy of the current settings, secrets included (server use).
func (s *Service) Get() Settings {
	s.mu.RLock()
	defer s.mu.RUnlock()

	c := s.cur
	c.Providers = append([]Provider(nil), s.cur.Providers...)

	return c
}

// OnChange registers a hook run after every save.
func (s *Service) OnChange(fn func(Settings)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onChange = append(s.onChange, fn)
}

// Update validates and saves next. A provider whose APIKey is empty keeps
// its stored key (the UI never sees keys), unless ClearKey lists it.
func (s *Service) Update(ctx context.Context, next Settings, clearKey []string, roles []string, by string) (Settings, error) {
	next.normalize()
	old := s.Get()
	for i := range next.Providers {
		p := &next.Providers[i]
		was := p.PreviousName
		if was == "" {
			was = p.Name
		}
		p.PreviousName = ""
		if p.APIKey != "" || contains(clearKey, p.Name) {
			continue
		}
		for _, o := range old.Providers {
			if o.Name == was {
				p.APIKey = o.APIKey
			}
		}
	}
	if err := next.Validate(roles); err != nil {
		return Settings{}, err
	}
	if err := s.save(ctx, next, by); err != nil {
		return Settings{}, err
	}

	s.mu.Lock()
	s.cur = next
	hooks := append([]func(Settings){}, s.onChange...)
	s.mu.Unlock()
	for _, h := range hooks {
		h(next)
	}

	return next, nil
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}

	return false
}

func (s *Service) save(ctx context.Context, v Settings, by string) error {
	enc := v
	enc.Providers = make([]Provider, len(v.Providers))
	for i, p := range v.Providers {
		if p.APIKey != "" {
			c, err := s.seal(p.APIKey)
			if err != nil {
				return err
			}
			p.APIKey = c
		}
		enc.Providers[i] = p
	}

	return s.store.SetSetting(ctx, keySettings, enc, by)
}

func (s *Service) decrypt(v *Settings) error {
	for i := range v.Providers {
		if v.Providers[i].APIKey == "" {
			continue
		}
		plain, err := s.open(v.Providers[i].APIKey)
		if err != nil {
			return fmt.Errorf("settings: API key of %q cannot be decrypted; enter it again in the admin settings", v.Providers[i].Name)
		}
		v.Providers[i].APIKey = plain
	}

	return nil
}

const sealedPrefix = "enc:v1:"

func (s *Service) seal(plain string) (string, error) {
	nonce := make([]byte, s.aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}

	return sealedPrefix + base64.RawStdEncoding.EncodeToString(s.aead.Seal(nonce, nonce, []byte(plain), []byte("ket-settings"))), nil
}

func (s *Service) open(sealed string) (string, error) {
	if !strings.HasPrefix(sealed, sealedPrefix) {
		return "", errors.New("not sealed")
	}
	raw, err := base64.RawStdEncoding.DecodeString(strings.TrimPrefix(sealed, sealedPrefix))
	if err != nil || len(raw) < s.aead.NonceSize() {
		return "", errors.New("damaged")
	}
	plain, err := s.aead.Open(nil, raw[:s.aead.NonceSize()], raw[s.aead.NonceSize():], []byte("ket-settings"))
	if err != nil {
		return "", err
	}

	return string(plain), nil
}

// Public is what the admin page may see: keys replaced by a flag.
type Public struct {
	Settings
	Providers []PublicProvider `json:"providers"`
	UpdatedAt time.Time        `json:"updated_at,omitzero"`
}

type PublicProvider struct {
	Provider
	HasKey bool `json:"has_key"`
}

// Public strips secrets.
func (s *Service) Public() Public {
	cur := s.Get()
	out := Public{Settings: cur, Providers: make([]PublicProvider, len(cur.Providers))}
	for i, p := range cur.Providers {
		has := p.APIKey != ""
		p.APIKey = ""
		out.Providers[i] = PublicProvider{Provider: p, HasKey: has}
	}
	out.Settings.Providers = nil

	return out
}

// Seal encrypts a secret for storage (SSO client secrets).
func (s *Service) Seal(plain string) (string, error) {
	if plain == "" {
		return "", nil
	}

	return s.seal(plain)
}

// Open decrypts a value from Seal.
func (s *Service) Open(sealed string) (string, error) {
	if sealed == "" {
		return "", nil
	}

	return s.open(sealed)
}

// Store is the database the settings live in.
func (s *Service) Store() *store.Store { return s.store }

// ForTest is a service over st with fixed settings, that never reads or
// writes the settings row (for tests of packages built on it).
func ForTest(st *store.Store, cur Settings) *Service {
	key := make([]byte, 32)
	block, _ := aes.NewCipher(key)
	aead, _ := cipher.NewGCM(block)
	cur.normalize()

	return &Service{store: st, aead: aead, cur: cur}
}
