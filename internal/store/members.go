package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Member roles on a project.
const (
	MemberViewer = "viewer"
	MemberEditor = "editor"
)

type Member struct {
	UserID    string    `json:"user_id"`
	Role      string    `json:"role"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Store) Members(ctx context.Context, projectID string) ([]Member, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT user_id, role, created_at FROM project_members WHERE project_id = $1 ORDER BY created_at`, projectID)
	if err != nil {
		return nil, notFound(fmt.Errorf("list members; %w", err), "project "+projectID)
	}
	defer rows.Close()

	out := []Member{}
	for rows.Next() {
		var m Member
		if err := rows.Scan(&m.UserID, &m.Role, &m.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}

	return out, rows.Err()
}

// MemberRole is a user's role on a project, "" when not a member.
func (s *Store) MemberRole(ctx context.Context, projectID, userID string) (string, error) {
	var role string
	err := s.db.QueryRowContext(ctx,
		`SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`, projectID, userID).Scan(&role)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil
		}
		return "", fmt.Errorf("member role; %w", err)
	}

	return role, nil
}

// SetMember adds a member or changes their role.
func (s *Store) SetMember(ctx context.Context, projectID, userID, role string) error {
	if role != MemberViewer && role != MemberEditor {
		return fmt.Errorf("role must be viewer or editor, not %q", role)
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
		ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`, projectID, userID, role)
	if err != nil {
		return notFound(fmt.Errorf("set member; %w", err), "project "+projectID)
	}

	return nil
}

func (s *Store) RemoveMember(ctx context.Context, projectID, userID string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, projectID, userID)
	if err != nil {
		return fmt.Errorf("remove member; %w", err)
	}

	return expectRow(res, "member "+userID)
}

// SetOwner hands a project to another user.
func (s *Store) SetOwner(ctx context.Context, projectID, userID string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE projects SET owner_id = $2 WHERE id = $1`, projectID, userID)
	if err != nil {
		return notFound(fmt.Errorf("set owner; %w", err), "project "+projectID)
	}

	return expectRow(res, "project "+projectID)
}

// ProjectsFor lists the projects a user can see: owned, shared with them,
// and those without an owner, each with the user's member role.
func (s *Store) ProjectsFor(ctx context.Context, userID string) ([]*Project, map[string]string, error) {
	rows, err := s.db.QueryContext(ctx, projectSelect+`
		LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
		WHERE p.owner_id IS NULL OR p.owner_id = $1 OR m.user_id IS NOT NULL
		ORDER BY p.updated_at DESC`, userID)
	if err != nil {
		return nil, nil, fmt.Errorf("list projects; %w", err)
	}
	defer rows.Close()

	out := []*Project{}
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	roles := map[string]string{}
	mrows, err := s.db.QueryContext(ctx, `SELECT project_id, role FROM project_members WHERE user_id = $1`, userID)
	if err != nil {
		return nil, nil, err
	}
	defer mrows.Close()
	for mrows.Next() {
		var id, role string
		if err := mrows.Scan(&id, &role); err != nil {
			return nil, nil, err
		}
		roles[id] = role
	}

	return out, roles, mrows.Err()
}
