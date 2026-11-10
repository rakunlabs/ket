package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
)

// Setting reads a setting into v. It returns ErrNotFound when the key was
// never set.
func (s *Store) Setting(ctx context.Context, key string, v any) error {
	var raw []byte
	err := s.db.QueryRowContext(ctx, `SELECT value FROM settings WHERE key = $1`, key).Scan(&raw)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("setting %s; %w", key, ErrNotFound)
	}
	if err != nil {
		return fmt.Errorf("get setting %s; %w", key, err)
	}

	return json.Unmarshal(raw, v)
}

// SetSetting stores v as JSON under key.
func (s *Store) SetSetting(ctx context.Context, key string, v any, by string) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return fmt.Errorf("encode setting %s; %w", key, err)
	}
	_, err = s.db.ExecContext(ctx,
		`INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
		ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
		key, raw, by)
	if err != nil {
		return fmt.Errorf("set setting %s; %w", key, err)
	}

	return nil
}

// SettingOnce stores v under key unless it exists, and reads back what is
// stored. Concurrent first starts agree on one value (e.g. a generated key).
func (s *Store) SettingOnce(ctx context.Context, key string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	if _, err := s.db.ExecContext(ctx,
		`INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, 'system') ON CONFLICT (key) DO NOTHING`, key, raw); err != nil {
		return fmt.Errorf("init setting %s; %w", key, err)
	}

	return s.Setting(ctx, key, v)
}

// ClaimOrphanProjects gives every project without an owner to userID. Used
// once, when the first administrator signs up.
func (s *Store) ClaimOrphanProjects(ctx context.Context, userID string) (int64, error) {
	res, err := s.db.ExecContext(ctx, `UPDATE projects SET owner_id = $1 WHERE owner_id IS NULL`, userID)
	if err != nil {
		return 0, fmt.Errorf("claim projects; %w", err)
	}

	return res.RowsAffected()
}
