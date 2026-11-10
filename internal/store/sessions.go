package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/rakunlabs/ada/middleware/auth/sessionstore"
)

// SessionStore keeps ada login sessions in PostgreSQL, so sign-ins survive
// restarts and every replica sees them. It mirrors the semantics of ada's
// file store: signed cookies, TTL per record, atomic transactions.
type SessionStore struct {
	db      *sql.DB
	codec   *sessionstore.CookieCodec
	options sessionstore.Options
	stop    chan struct{}
}

var _ sessionstore.AtomicDirectStore = (*SessionStore)(nil)

// maxSession bounds one stored session, like ada's stores.
const maxSession = 1 << 20

// Sessions returns a session store signing cookies with key (≥ 32 bytes).
func (s *Store) Sessions(key []byte, opts sessionstore.Options) (*SessionStore, error) {
	if len(key) < 32 {
		return nil, fmt.Errorf("session key must be at least 32 bytes")
	}

	return &SessionStore{db: s.db, codec: sessionstore.NewCookieCodec(key), options: opts, stop: make(chan struct{})}, nil
}

// StartGC removes expired sessions every interval until Close.
func (st *SessionStore) StartGC(interval time.Duration) {
	go func() {
		t := time.NewTicker(interval)
		defer t.Stop()
		for {
			select {
			case <-st.stop:
				return
			case <-t.C:
				if _, err := st.db.Exec(`DELETE FROM auth_sessions WHERE expires_at IS NOT NULL AND expires_at <= now()`); err != nil {
					slog.Warn("session cleanup", "error", err)
				}
			}
		}
	}()
}

func (st *SessionStore) Close() error {
	select {
	case <-st.stop:
	default:
		close(st.stop)
	}

	return nil
}

func (st *SessionStore) newSession(name string) *sessionstore.Session {
	o := st.options

	return sessionstore.NewSession(st, name, &o)
}

func (st *SessionStore) Get(r *http.Request, name string) (*sessionstore.Session, error) {
	cookie, err := sessionstore.ReadSessionCookie(r, name)
	if err != nil {
		if errors.Is(err, http.ErrNoCookie) {
			return st.newSession(name), nil
		}

		return nil, fmt.Errorf("read session cookie; %w", err)
	}
	id, err := st.codec.Decode(name, cookie)
	if err != nil {
		return st.newSession(name), nil
	}
	values, err := st.LoadByID(r.Context(), id)
	if errors.Is(err, sessionstore.ErrNoSession) {
		return st.newSession(name), nil
	}
	if err != nil {
		return nil, err
	}
	sess := st.newSession(name)
	sess.ID = id
	sess.Values = values
	sess.IsNew = false

	return sess, nil
}

func (st *SessionStore) Save(r *http.Request, w http.ResponseWriter, sess *sessionstore.Session) error {
	if sess.Options.MaxAge < 0 {
		var derr error
		if sess.ID != "" {
			derr = st.DeleteByID(r.Context(), sess.ID)
		}
		sessionstore.SetSessionCookie(w, sess.Name(), "", sess.Options)

		return derr
	}
	if sess.ID == "" {
		id, err := sessionstore.GenerateSessionID()
		if err != nil {
			return fmt.Errorf("generate session id; %w", err)
		}
		sess.ID = id
	}
	var ttl time.Duration
	if sess.Options.MaxAge > 0 {
		ttl = time.Duration(sess.Options.MaxAge) * time.Second
	}
	if err := st.SaveByID(r.Context(), sess.ID, sess.Values, ttl); err != nil {
		return err
	}
	sessionstore.SetSessionCookie(w, sess.Name(), st.codec.Encode(sess.Name(), sess.ID), sess.Options)

	return nil
}

func validID(id string) bool { return id != "" && len(id) <= 256 }

func expiry(ttl time.Duration) any {
	if ttl <= 0 {
		return nil
	}

	return time.Now().Add(ttl)
}

func encode(values map[string]any) ([]byte, error) {
	if values == nil {
		values = map[string]any{}
	}
	raw, err := json.Marshal(values)
	if err != nil {
		return nil, err
	}
	if len(raw) > maxSession {
		return nil, fmt.Errorf("session data exceeds maximum length")
	}

	return raw, nil
}

func decode(raw []byte) (map[string]any, error) {
	v := map[string]any{}
	if err := json.Unmarshal(raw, &v); err != nil {
		return nil, err
	}

	return v, nil
}

func (st *SessionStore) LoadByID(ctx context.Context, id string) (map[string]any, error) {
	if !validID(id) {
		return nil, sessionstore.ErrNoSession
	}
	var raw []byte
	err := st.db.QueryRowContext(ctx,
		`SELECT data FROM auth_sessions WHERE id = $1 AND (expires_at IS NULL OR expires_at > now())`, id).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, sessionstore.ErrNoSession
	}
	if err != nil {
		return nil, fmt.Errorf("load session; %w", err)
	}

	return decode(raw)
}

func (st *SessionStore) SaveByID(ctx context.Context, id string, values map[string]any, ttl time.Duration) error {
	if !validID(id) {
		return fmt.Errorf("invalid session id")
	}
	raw, err := encode(values)
	if err != nil {
		return err
	}
	_, err = st.db.ExecContext(ctx,
		`INSERT INTO auth_sessions (id, data, expires_at) VALUES ($1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, expires_at = EXCLUDED.expires_at`, id, raw, expiry(ttl))
	if err != nil {
		return fmt.Errorf("save session; %w", err)
	}

	return nil
}

func (st *SessionStore) DeleteByID(ctx context.Context, id string) error {
	if !validID(id) {
		return nil
	}
	if _, err := st.db.ExecContext(ctx, `DELETE FROM auth_sessions WHERE id = $1`, id); err != nil {
		return fmt.Errorf("delete session; %w", err)
	}

	return nil
}

// TransactByID reads, changes and writes one session under a row lock, so
// concurrent refreshes cannot lose an update. ttl <= 0 keeps the current
// expiry.
func (st *SessionStore) TransactByID(ctx context.Context, id string, ttl time.Duration, fn sessionstore.AtomicTransaction) (map[string]any, error) {
	if !validID(id) {
		return nil, sessionstore.ErrNoSession
	}
	tx, err := st.db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var raw []byte
	var expires sql.NullTime
	err = tx.QueryRowContext(ctx, `SELECT data, expires_at FROM auth_sessions WHERE id = $1 FOR UPDATE`, id).Scan(&raw, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, sessionstore.ErrNoSession
	}
	if err != nil {
		return nil, fmt.Errorf("lock session; %w", err)
	}
	if expires.Valid && !expires.Time.After(time.Now()) {
		if _, err := tx.ExecContext(ctx, `DELETE FROM auth_sessions WHERE id = $1`, id); err != nil {
			return nil, err
		}
		if err := tx.Commit(); err != nil {
			return nil, err
		}

		return nil, sessionstore.ErrNoSession
	}
	current, err := decode(raw)
	if err != nil {
		return nil, err
	}

	replacement, commit, txErr := fn(current)
	if !commit {
		return nil, txErr
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if replacement == nil {
		if _, err := tx.ExecContext(ctx, `DELETE FROM auth_sessions WHERE id = $1`, id); err != nil {
			return nil, err
		}
	} else {
		data, err := encode(replacement)
		if err != nil {
			return nil, err
		}
		exp := any(nil)
		if expires.Valid {
			exp = expires.Time
		}
		if ttl > 0 {
			exp = time.Now().Add(ttl)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE auth_sessions SET data = $2, expires_at = $3 WHERE id = $1`, id, data, exp); err != nil {
			return nil, err
		}
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit session; %w", err)
	}

	return replacement, txErr
}
