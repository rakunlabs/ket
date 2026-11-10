package store

import (
	"context"
	"database/sql"
	"embed"
	"errors"
	"fmt"
	"log/slog"

	"github.com/jackc/pgx/v5/pgconn"
	_ "github.com/jackc/pgx/v5/stdlib"
	"github.com/rakunlabs/muz"

	"github.com/rakunlabs/ket/internal/config"
)

//go:embed migrations
var migrationsFS embed.FS

// ErrNotFound is returned when a row does not exist.
var ErrNotFound = errors.New("not found")

// ErrConflict is returned when an op is written against an outdated head.
var ErrConflict = errors.New("conflict")

type Store struct {
	db *sql.DB
}

func New(ctx context.Context, cfg config.Store) (*Store, error) {
	db, err := sql.Open("pgx", cfg.Postgres.DSN)
	if err != nil {
		return nil, fmt.Errorf("open postgres; %w", err)
	}

	db.SetMaxOpenConns(cfg.Postgres.MaxOpenConns)
	db.SetMaxIdleConns(cfg.Postgres.MaxIdleConns)
	db.SetConnMaxLifetime(cfg.Postgres.ConnMaxLife)

	if err := db.PingContext(ctx); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping postgres; %w", err)
	}

	if cfg.Postgres.Migrate {
		if err := migrate(ctx, db); err != nil {
			_ = db.Close()
			return nil, err
		}
	}

	return &Store{db: db}, nil
}

func migrate(ctx context.Context, db *sql.DB) error {
	m := muz.Migrate{
		Path:      "migrations",
		FS:        migrationsFS,
		Extension: ".sql",
	}

	if err := m.Migrate(ctx, &muz.SQLDriver{
		DB:      db,
		Dialect: muz.DialectPostgres,
		Table:   "migrations",
		LockKey: "muz:postgres:public:migrations",
		Logger:  slog.Default(),
	}); err != nil {
		return fmt.Errorf("migrate; %w", err)
	}

	return nil
}

// DB is the shared connection pool (the auth store uses it too).
func (s *Store) DB() *sql.DB { return s.db }

func (s *Store) Close() {
	if err := s.db.Close(); err != nil {
		slog.Error("close postgres", "error", err)
	}
}

// tx runs fn in a transaction and commits when it returns nil.
func (s *Store) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin; %w", err)
	}

	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}

	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit; %w", err)
	}

	return nil
}

func notFound(err error, what string) error {
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%s; %w", what, ErrNotFound)
	}

	// A malformed id cannot match a row.
	var pgErr *pgconn.PgError
	if errors.As(err, &pgErr) && pgErr.Code == "22P02" {
		return fmt.Errorf("%s; %w", what, ErrNotFound)
	}

	return err
}
