package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

type Branch struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	Name      string    `json:"name"`
	ParentID  *string   `json:"parent_id,omitempty"`
	BaseSeq   int64     `json:"base_seq"`
	HeadSeq   int64     `json:"head_seq"`
	CreatedAt time.Time `json:"created_at"`
}

const branchSelect = `SELECT id, project_id, name, parent_id, base_seq, head_seq, created_at FROM branches`

func scanBranch(row interface{ Scan(...any) error }) (*Branch, error) {
	var b Branch
	var parent sql.NullString
	if err := row.Scan(&b.ID, &b.ProjectID, &b.Name, &parent, &b.BaseSeq, &b.HeadSeq, &b.CreatedAt); err != nil {
		return nil, err
	}
	if parent.Valid {
		b.ParentID = &parent.String
	}

	return &b, nil
}

func (s *Store) Branches(ctx context.Context, projectID string) ([]*Branch, error) {
	rows, err := s.db.QueryContext(ctx, branchSelect+` WHERE project_id = $1 ORDER BY created_at`, projectID)
	if err != nil {
		return nil, notFound(fmt.Errorf("list branches; %w", err), "project "+projectID)
	}
	defer rows.Close()

	out := []*Branch{}
	for rows.Next() {
		b, err := scanBranch(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, b)
	}

	return out, rows.Err()
}

func (s *Store) GetBranch(ctx context.Context, id string) (*Branch, error) {
	b, err := scanBranch(s.db.QueryRowContext(ctx, branchSelect+` WHERE id = $1`, id))
	if err != nil {
		return nil, notFound(err, "branch "+id)
	}

	return b, nil
}

// CreateBranch forks a branch off parent at the parent's current head.
// The new branch's log starts with a copy of the parent's ops 1..head, so
// a branch replays on its own.
func (s *Store) CreateBranch(ctx context.Context, parentID, name string) (*Branch, error) {
	var id string
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var projectID string
		var head int64
		if err := tx.QueryRowContext(ctx, `SELECT project_id, head_seq FROM branches WHERE id = $1 FOR UPDATE`, parentID).Scan(&projectID, &head); err != nil {
			return notFound(err, "branch "+parentID)
		}
		if err := tx.QueryRowContext(ctx,
			`INSERT INTO branches (project_id, name, parent_id, base_seq, head_seq) VALUES ($1, $2, $3, $4, $4) RETURNING id`,
			projectID, name, parentID, head).Scan(&id); err != nil {
			return fmt.Errorf("insert branch; %w", err)
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO ops (branch_id, seq, op, author, message, created_at)
			SELECT $1, seq, op, author, message, created_at FROM ops WHERE branch_id = $2 AND seq <= $3`, id, parentID, head); err != nil {
			return fmt.Errorf("copy ops; %w", err)
		}

		return nil
	})
	if err != nil {
		return nil, err
	}

	return s.GetBranch(ctx, id)
}

// DeleteBranch removes a branch that is not main.
func (s *Store) DeleteBranch(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM branches WHERE id = $1 AND name <> 'main'`, id)
	if err != nil {
		return notFound(fmt.Errorf("delete branch; %w", err), "branch "+id)
	}

	return expectRow(res, "branch "+id)
}

// MergeBranch appends a proposal branch's own ops (above its base) to its
// parent and deletes it. It fails when the parent moved since the fork,
// because the proposal was made against an older design.
func (s *Store) MergeBranch(ctx context.Context, id string) (int64, error) {
	var head int64
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var parentID sql.NullString
		var base, bhead int64
		if err := tx.QueryRowContext(ctx, `SELECT parent_id, base_seq, head_seq FROM branches WHERE id = $1 FOR UPDATE`, id).Scan(&parentID, &base, &bhead); err != nil {
			return notFound(err, "branch "+id)
		}
		if !parentID.Valid {
			return fmt.Errorf("main has nothing to merge into; %w", ErrConflict)
		}
		var phead int64
		if err := tx.QueryRowContext(ctx, `SELECT head_seq FROM branches WHERE id = $1 FOR UPDATE`, parentID.String).Scan(&phead); err != nil {
			return notFound(err, "branch "+parentID.String)
		}
		if phead != base {
			return fmt.Errorf("the design changed since the proposal was made (main at %d, proposal from %d); ask for the proposal again; %w", phead, base, ErrConflict)
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM ops WHERE branch_id = $1 AND seq > $2`, parentID.String, phead); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM snapshots WHERE branch_id = $1 AND seq > $2`, parentID.String, phead); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO ops (branch_id, seq, op, author, message, created_at)
			SELECT $1, seq, op, author, message, created_at FROM ops WHERE branch_id = $2 AND seq > $3 AND seq <= $4`,
			parentID.String, id, base, bhead); err != nil {
			return fmt.Errorf("copy ops; %w", err)
		}
		head = bhead
		if _, err := tx.ExecContext(ctx, `UPDATE branches SET head_seq = $2 WHERE id = $1`, parentID.String, bhead); err != nil {
			return err
		}
		_, err := tx.ExecContext(ctx, `DELETE FROM branches WHERE id = $1`, id)

		return err
	})

	return head, err
}
