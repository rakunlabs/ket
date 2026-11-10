package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Part returns the cached raw EasyEDA response for an LCSC number.
func (s *Store) Part(ctx context.Context, lcsc string) (json.RawMessage, time.Time, error) {
	var raw []byte
	var at time.Time
	err := s.db.QueryRowContext(ctx, `SELECT raw, fetched_at FROM parts WHERE lcsc = $1`, lcsc).Scan(&raw, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, time.Time{}, fmt.Errorf("part %s; %w", lcsc, ErrNotFound)
	}
	if err != nil {
		return nil, time.Time{}, fmt.Errorf("get part; %w", err)
	}

	return raw, at, nil
}

func (s *Store) SavePart(ctx context.Context, lcsc string, raw json.RawMessage) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO parts (lcsc, raw) VALUES ($1, $2)
		ON CONFLICT (lcsc) DO UPDATE SET raw = EXCLUDED.raw, fetched_at = now()`, lcsc, []byte(raw))
	if err != nil {
		return fmt.Errorf("save part; %w", err)
	}

	return nil
}

// Model returns a cached 3D model (OBJ text) by EasyEDA uuid.
func (s *Store) Model(ctx context.Context, uuid string) (string, error) {
	var obj string
	err := s.db.QueryRowContext(ctx, `SELECT obj FROM models WHERE uuid = $1`, uuid).Scan(&obj)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fmt.Errorf("model %s; %w", uuid, ErrNotFound)
	}
	if err != nil {
		return "", fmt.Errorf("get model; %w", err)
	}

	return obj, nil
}

func (s *Store) SaveModel(ctx context.Context, uuid, obj string) error {
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO models (uuid, obj) VALUES ($1, $2) ON CONFLICT (uuid) DO UPDATE SET obj = EXCLUDED.obj, fetched_at = now()`, uuid, obj)
	if err != nil {
		return fmt.Errorf("save model; %w", err)
	}

	return nil
}
