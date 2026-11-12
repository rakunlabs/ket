package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

// Template is a .ket project file kept by the server: a template to start
// projects from, or a block to insert into designs.
type Template struct {
	ID          string    `json:"id"`
	Kind        string    `json:"kind"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Data        string    `json:"data,omitempty"`
	Bytes       int       `json:"bytes"`
	CreatedBy   string    `json:"created_by,omitempty"`
	UpdatedAt   time.Time `json:"updated_at"`
}

// ErrExists is a template or block with that name already there.
var ErrExists = errors.New("already exists")

// ListTemplates lists templates of a kind ("" = both), without their data.
func (s *Store) ListTemplates(ctx context.Context, kind string) ([]*Template, error) {
	q := `SELECT id, kind, name, description, length(data), COALESCE(created_by, ''), updated_at FROM templates`
	args := []any{}
	if kind != "" {
		q += ` WHERE kind = $1`
		args = append(args, kind)
	}
	q += ` ORDER BY kind, lower(name)`
	rows, err := s.db.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, fmt.Errorf("list templates; %w", err)
	}
	defer rows.Close()
	out := []*Template{}
	for rows.Next() {
		var t Template
		if err := rows.Scan(&t.ID, &t.Kind, &t.Name, &t.Description, &t.Bytes, &t.CreatedBy, &t.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan template; %w", err)
		}
		out = append(out, &t)
	}

	return out, rows.Err()
}

// GetTemplate finds one by id (of the kind, when given), or by kind and name.
// A name that is both a template and a block needs the kind.
func (s *Store) GetTemplate(ctx context.Context, kind, idOrName string) (*Template, error) {
	var t Template
	idOrName = strings.TrimSpace(idOrName)
	const cols = `SELECT id, kind, name, description, data, length(data), COALESCE(created_by, ''), updated_at FROM templates`
	var row *sql.Row
	if _, err := uuid.Parse(idOrName); err == nil {
		row = s.db.QueryRowContext(ctx, cols+` WHERE id = $1::uuid AND ($2 = '' OR kind = $2)`, idOrName, kind)
	} else {
		var n int
		if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM templates WHERE name = $1 AND ($2 = '' OR kind = $2)`, idOrName, kind).Scan(&n); err != nil {
			return nil, fmt.Errorf("find template; %w", err)
		}
		if n > 1 {
			return nil, fmt.Errorf("%q is both a template and a block: say which kind (or use its id)", idOrName)
		}
		row = s.db.QueryRowContext(ctx, cols+` WHERE name = $1 AND ($2 = '' OR kind = $2)`, idOrName, kind)
	}
	err := row.Scan(&t.ID, &t.Kind, &t.Name, &t.Description, &t.Data, &t.Bytes, &t.CreatedBy, &t.UpdatedAt)
	if err != nil {
		return nil, notFound(err, "template "+idOrName)
	}

	return &t, nil
}

func (s *Store) SaveTemplate(ctx context.Context, t *Template, replace bool) (*Template, error) {
	t.Name = strings.TrimSpace(t.Name)
	q := `INSERT INTO templates (kind, name, description, data, created_by) VALUES ($1, $2, $3, $4, NULLIF($5, ''))`
	if replace {
		q += ` ON CONFLICT (kind, name) DO UPDATE SET description = EXCLUDED.description, data = EXCLUDED.data, updated_at = now()`
	}
	q += ` RETURNING id`
	var id string
	if err := s.db.QueryRowContext(ctx, q, t.Kind, t.Name, t.Description, t.Data, t.CreatedBy).Scan(&id); err != nil {
		if uniqueViolation(err) {
			return nil, fmt.Errorf("a %s named %q %w", t.Kind, t.Name, ErrExists)
		}
		return nil, fmt.Errorf("save template; %w", err)
	}

	return s.GetTemplate(ctx, "", id)
}

func (s *Store) DeleteTemplate(ctx context.Context, id string) error {
	if _, err := uuid.Parse(id); err != nil {
		return fmt.Errorf("template %s; %w", id, ErrNotFound)
	}
	res, err := s.db.ExecContext(ctx, `DELETE FROM templates WHERE id = $1::uuid`, id)
	if err != nil {
		return fmt.Errorf("delete template; %w", err)
	}

	return expectRow(res, "template "+id)
}

// TemplateOp is the first op of a project started from t: an import_project
// of its file, replayed in the browser like any other op. nil for no template.
func TemplateOp(t *Template) json.RawMessage {
	if t == nil {
		return nil
	}
	op, _ := json.Marshal(map[string]any{"cmd": "import_project", "args": map[string]any{"data": t.Data}})

	return op
}
