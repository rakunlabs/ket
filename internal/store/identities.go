package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Identity links a sign-in at an OAuth2 / OIDC provider to a user.
type Identity struct {
	Provider  string    `json:"provider"`
	Subject   string    `json:"subject"`
	UserID    string    `json:"user_id"`
	Email     string    `json:"email"`
	CreatedAt time.Time `json:"created_at"`
	LastLogin time.Time `json:"last_login"`
}

// IdentityUser is the user linked to a provider's subject.
func (s *Store) IdentityUser(ctx context.Context, provider, subject string) (string, error) {
	var uid string
	err := s.db.QueryRowContext(ctx, `UPDATE sso_identities SET last_login = now() WHERE provider = $1 AND subject = $2 RETURNING user_id`, provider, subject).Scan(&uid)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("identity; %w", ErrNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("identity; %w", err)
	}

	return uid, nil
}

// LinkIdentity links a provider's subject to a user. A subject already
// linked keeps its user.
func (s *Store) LinkIdentity(ctx context.Context, id Identity) error {
	_, err := s.db.ExecContext(ctx, `INSERT INTO sso_identities (provider, subject, user_id, email) VALUES ($1, $2, $3, $4)
		ON CONFLICT (provider, subject) DO NOTHING`, id.Provider, id.Subject, id.UserID, id.Email)
	if err != nil {
		return fmt.Errorf("link identity; %w", err)
	}

	return nil
}

// UserIdentities lists the sign-ins linked to a user.
func (s *Store) UserIdentities(ctx context.Context, userID string) ([]Identity, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT provider, subject, user_id, email, created_at, last_login FROM sso_identities WHERE user_id = $1 ORDER BY provider`, userID)
	if err != nil {
		return nil, fmt.Errorf("user identities; %w", err)
	}
	defer rows.Close()
	out := []Identity{}
	for rows.Next() {
		var i Identity
		if err := rows.Scan(&i.Provider, &i.Subject, &i.UserID, &i.Email, &i.CreatedAt, &i.LastLogin); err != nil {
			return nil, err
		}
		out = append(out, i)
	}

	return out, rows.Err()
}

// UnlinkIdentity removes one sign-in link from a user.
func (s *Store) UnlinkIdentity(ctx context.Context, userID, provider, subject string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM sso_identities WHERE user_id = $1 AND provider = $2 AND subject = $3`, userID, provider, subject)
	if err != nil {
		return fmt.Errorf("unlink identity; %w", err)
	}

	return expectRow(res, "identity")
}
