// Command resetdb drops every table in the public schema of the database at
// $KET_E2E_DSN, so the end-to-end tests start from an empty Ket (the first
// sign-up becomes the administrator). It refuses databases whose name does
// not contain "e2e" or "test", to keep it away from real data.
package main

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"strings"

	_ "github.com/jackc/pgx/v5/stdlib"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, "resetdb:", err)
		os.Exit(1)
	}
}

func run() error {
	dsn := os.Getenv("KET_E2E_DSN")
	if dsn == "" {
		return fmt.Errorf("KET_E2E_DSN is not set")
	}
	u, err := url.Parse(dsn)
	if err != nil {
		return fmt.Errorf("parse KET_E2E_DSN: %w", err)
	}
	name := strings.TrimPrefix(u.Path, "/")
	if !strings.Contains(name, "e2e") && !strings.Contains(name, "test") {
		return fmt.Errorf("database %q does not look like a test database (its name must contain e2e or test)", name)
	}

	db, err := sql.Open("pgx", dsn)
	if err != nil {
		return err
	}
	defer db.Close()

	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `DROP SCHEMA public CASCADE; CREATE SCHEMA public`); err != nil {
		return fmt.Errorf("reset %s: %w", name, err)
	}

	return nil
}
