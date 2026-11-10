package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

type Project struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	UpdatedAt   time.Time `json:"updated_at"`
	// MainBranch is the id of the project's "main" branch.
	MainBranch string `json:"main_branch"`
	Head       int64  `json:"head"`
	// OwnerID is the user who owns the project; nil = no owner (shared
	// with everyone by role).
	OwnerID *string `json:"owner_id,omitempty"`
	// Access is what the requesting user may do: owner, editor or viewer.
	// Filled in by the server.
	Access string `json:"access,omitempty"`
}

const projectSelect = `SELECT p.id, p.name, p.description, p.created_at, p.updated_at, b.id, b.head_seq, p.owner_id
	FROM projects p JOIN branches b ON b.project_id = p.id AND b.name = 'main'`

func scanProject(row interface{ Scan(...any) error }) (*Project, error) {
	var p Project
	var owner sql.NullString
	if err := row.Scan(&p.ID, &p.Name, &p.Description, &p.CreatedAt, &p.UpdatedAt, &p.MainBranch, &p.Head, &owner); err != nil {
		return nil, err
	}
	if owner.Valid {
		p.OwnerID = &owner.String
	}

	return &p, nil
}

func (s *Store) ListProjects(ctx context.Context) ([]*Project, error) {
	rows, err := s.db.QueryContext(ctx, projectSelect+` ORDER BY p.updated_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("list projects; %w", err)
	}
	defer rows.Close()

	out := []*Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, fmt.Errorf("scan project; %w", err)
		}
		out = append(out, p)
	}

	return out, rows.Err()
}

func (s *Store) GetProject(ctx context.Context, id string) (*Project, error) {
	p, err := scanProject(s.db.QueryRowContext(ctx, projectSelect+` WHERE p.id = $1`, id))
	if err != nil {
		return nil, notFound(err, "project "+id)
	}

	return p, nil
}

// FindProject resolves an id or an exact (case-insensitive) name.
func (s *Store) FindProject(ctx context.Context, idOrName string) (*Project, error) {
	p, err := scanProject(s.db.QueryRowContext(ctx,
		projectSelect+` WHERE p.id::text = $1 OR lower(p.name) = lower($1) ORDER BY p.updated_at DESC LIMIT 1`, idOrName))
	if err != nil {
		return nil, notFound(err, "project "+idOrName)
	}

	return p, nil
}

// CreateProject creates the project and its main branch. ownerID is the
// creating user, or "" without accounts.
func (s *Store) CreateProject(ctx context.Context, name, description, ownerID string) (*Project, error) {
	var id string
	var owner any
	if ownerID != "" {
		owner = ownerID
	}
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx,
			`INSERT INTO projects (name, description, owner_id) VALUES ($1, $2, $3) RETURNING id`, name, description, owner).Scan(&id); err != nil {
			return fmt.Errorf("insert project; %w", err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO branches (project_id, name) VALUES ($1, 'main')`, id); err != nil {
			return fmt.Errorf("insert branch; %w", err)
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	return s.GetProject(ctx, id)
}

func (s *Store) UpdateProject(ctx context.Context, id, name, description string) error {
	res, err := s.db.ExecContext(ctx,
		`UPDATE projects SET name = $2, description = $3, updated_at = now() WHERE id = $1`, id, name, description)
	if err != nil {
		return notFound(fmt.Errorf("update project; %w", err), "project "+id)
	}

	return expectRow(res, "project "+id)
}

func (s *Store) DeleteProject(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM projects WHERE id = $1`, id)
	if err != nil {
		return notFound(fmt.Errorf("delete project; %w", err), "project "+id)
	}

	return expectRow(res, "project "+id)
}

func expectRow(res sql.Result, what string) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return fmt.Errorf("%s; %w", what, ErrNotFound)
	}

	return nil
}

// Op is one entry of a branch's operation log.
type Op struct {
	Seq       int64           `json:"seq"`
	Op        json.RawMessage `json:"op"`
	Author    string          `json:"author"`
	Message   string          `json:"message"`
	CreatedAt time.Time       `json:"created_at"`
}

// BranchState is the head of a branch and whether a redo is possible.
type BranchState struct {
	Head int64 `json:"head"`
	// Top is the highest seq stored; ops in (Head, Top] can be redone.
	Top int64 `json:"top"`
}

// Ops returns the ops in (from, to] of a branch in order.
func (s *Store) Ops(ctx context.Context, branchID string, from, to int64) ([]Op, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT seq, op, author, message, created_at FROM ops
		WHERE branch_id = $1 AND seq > $2 AND seq <= $3 ORDER BY seq`, branchID, from, to)
	if err != nil {
		return nil, fmt.Errorf("list ops; %w", err)
	}
	defer rows.Close()

	out := []Op{}
	for rows.Next() {
		var o Op
		if err := rows.Scan(&o.Seq, &o.Op, &o.Author, &o.Message, &o.CreatedAt); err != nil {
			return nil, fmt.Errorf("scan op; %w", err)
		}
		out = append(out, o)
	}

	return out, rows.Err()
}

func (s *Store) BranchState(ctx context.Context, branchID string) (BranchState, error) {
	var st BranchState
	err := s.db.QueryRowContext(ctx,
		`SELECT b.head_seq, COALESCE((SELECT max(seq) FROM ops WHERE branch_id = b.id), 0)
		FROM branches b WHERE b.id = $1`, branchID).Scan(&st.Head, &st.Top)
	if err != nil {
		return st, notFound(err, "branch "+branchID)
	}

	return st, nil
}

// AppendOp writes op at base+1 when the branch head is still base. Ops
// above the head (an undone tail) are dropped: a new edit ends redo.
func (s *Store) AppendOp(ctx context.Context, branchID string, base int64, op json.RawMessage, author, message string) (Op, error) {
	var out Op
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var head int64
		var projectID string
		if err := tx.QueryRowContext(ctx,
			`SELECT head_seq, project_id FROM branches WHERE id = $1 FOR UPDATE`, branchID).Scan(&head, &projectID); err != nil {
			return notFound(err, "branch "+branchID)
		}
		if head != base {
			return fmt.Errorf("branch is at %d, op was made at %d; %w", head, base, ErrConflict)
		}

		if _, err := tx.ExecContext(ctx, `DELETE FROM ops WHERE branch_id = $1 AND seq > $2`, branchID, head); err != nil {
			return fmt.Errorf("drop undone ops; %w", err)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM snapshots WHERE branch_id = $1 AND seq > $2`, branchID, head); err != nil {
			return fmt.Errorf("drop stale snapshots; %w", err)
		}

		out = Op{Seq: head + 1, Op: op, Author: author, Message: message}
		if err := tx.QueryRowContext(ctx,
			`INSERT INTO ops (branch_id, seq, op, author, message) VALUES ($1, $2, $3, $4, $5) RETURNING created_at`,
			branchID, out.Seq, []byte(op), author, message).Scan(&out.CreatedAt); err != nil {
			return fmt.Errorf("insert op; %w", err)
		}

		if _, err := tx.ExecContext(ctx, `UPDATE branches SET head_seq = $2 WHERE id = $1`, branchID, out.Seq); err != nil {
			return fmt.Errorf("move head; %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE projects SET updated_at = now() WHERE id = $1`, projectID); err != nil {
			return fmt.Errorf("touch project; %w", err)
		}

		return nil
	})

	return out, err
}

// MoveHead sets the branch head by delta (-1 undo, +1 redo) within
// [0, top] and returns the new state.
func (s *Store) MoveHead(ctx context.Context, branchID string, delta int64) (BranchState, error) {
	var st BranchState
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := tx.QueryRowContext(ctx,
			`SELECT b.head_seq, COALESCE((SELECT max(seq) FROM ops WHERE branch_id = b.id), 0)
			FROM branches b WHERE b.id = $1 FOR UPDATE`, branchID).Scan(&st.Head, &st.Top); err != nil {
			return notFound(err, "branch "+branchID)
		}

		next := st.Head + delta
		if next < 0 || next > st.Top {
			return fmt.Errorf("nothing to %s; %w", map[bool]string{true: "undo", false: "redo"}[delta < 0], ErrConflict)
		}
		st.Head = next

		_, err := tx.ExecContext(ctx, `UPDATE branches SET head_seq = $2 WHERE id = $1`, branchID, next)

		return err
	})

	return st, err
}
