package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// AcquireTurn takes a conversation's turn lease for owner until now+ttl.
// It fails (false) while another owner holds an unexpired lease.
func (s *Store) AcquireTurn(ctx context.Context, conversationID, owner string, ttl time.Duration) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE conversations SET running_by = $2, running_until = now() + $3 * interval '1 millisecond', stop_requested = false
		WHERE id = $1 AND (running_until IS NULL OR running_until < now() OR running_by = $2)`,
		conversationID, owner, ttl.Milliseconds())
	if err != nil {
		return false, fmt.Errorf("acquire turn; %w", err)
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}

	return n == 1, nil
}

// RenewTurn extends the lease and reports whether a stop was asked for.
// lost is true when the lease is no longer owner's.
func (s *Store) RenewTurn(ctx context.Context, conversationID, owner string, ttl time.Duration) (stop, lost bool, err error) {
	err = s.db.QueryRowContext(ctx,
		`UPDATE conversations SET running_until = now() + $3 * interval '1 millisecond'
		WHERE id = $1 AND running_by = $2 RETURNING stop_requested`,
		conversationID, owner, ttl.Milliseconds()).Scan(&stop)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return false, true, nil
		}
		return false, false, fmt.Errorf("renew turn; %w", err)
	}

	return stop, false, nil
}

// ReleaseTurn ends owner's lease.
func (s *Store) ReleaseTurn(ctx context.Context, conversationID, owner string) error {
	_, err := s.db.ExecContext(ctx,
		`UPDATE conversations SET running_by = '', running_until = NULL, stop_requested = false WHERE id = $1 AND running_by = $2`,
		conversationID, owner)
	if err != nil {
		return fmt.Errorf("release turn; %w", err)
	}

	return nil
}

// RequestStop asks whoever runs the conversation's turn to stop. False when none runs.
func (s *Store) RequestStop(ctx context.Context, conversationID string) (bool, error) {
	res, err := s.db.ExecContext(ctx,
		`UPDATE conversations SET stop_requested = true WHERE id = $1 AND running_until > now()`, conversationID)
	if err != nil {
		return false, fmt.Errorf("request stop; %w", err)
	}
	n, err := res.RowsAffected()

	return n == 1, err
}
