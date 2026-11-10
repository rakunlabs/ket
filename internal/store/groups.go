package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/jackc/pgx/v5/pgconn"
)

// Group is a named set of users. Sharing a project with a group gives every
// member the group's role on it.
type Group struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	CreatedAt   time.Time `json:"created_at"`
	MemberIDs   []string  `json:"member_ids"`
}

// GroupShare is a group's role on a project.
type GroupShare struct {
	GroupID string `json:"group_id"`
	Name    string `json:"name"`
	Role    string `json:"role"`
}

func uniqueViolation(err error) bool {
	var pgErr *pgconn.PgError
	return errors.As(err, &pgErr) && pgErr.Code == "23505"
}

func cleanGroup(name string) (string, error) {
	name = strings.TrimSpace(name)
	if name == "" || len(name) > 64 {
		return "", errors.New("a group needs a name of 1 to 64 characters")
	}

	return name, nil
}

// Groups lists every group with its members, by name.
func (s *Store) Groups(ctx context.Context) ([]*Group, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT id, name, description, created_at FROM user_groups ORDER BY lower(name)`)
	if err != nil {
		return nil, fmt.Errorf("list groups; %w", err)
	}
	defer rows.Close()

	out := []*Group{}
	byID := map[string]*Group{}
	for rows.Next() {
		g := &Group{MemberIDs: []string{}}
		if err := rows.Scan(&g.ID, &g.Name, &g.Description, &g.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, g)
		byID[g.ID] = g
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	mrows, err := s.db.QueryContext(ctx, `SELECT group_id, user_id FROM group_members ORDER BY user_id`)
	if err != nil {
		return nil, fmt.Errorf("list group members; %w", err)
	}
	defer mrows.Close()
	for mrows.Next() {
		var gid, uid string
		if err := mrows.Scan(&gid, &uid); err != nil {
			return nil, err
		}
		if g := byID[gid]; g != nil {
			g.MemberIDs = append(g.MemberIDs, uid)
		}
	}

	return out, mrows.Err()
}

// Group returns one group with its members.
func (s *Store) Group(ctx context.Context, id string) (*Group, error) {
	g := &Group{MemberIDs: []string{}}
	err := s.db.QueryRowContext(ctx, `SELECT id, name, description, created_at FROM user_groups WHERE id = $1`, id).
		Scan(&g.ID, &g.Name, &g.Description, &g.CreatedAt)
	if err != nil {
		return nil, notFound(err, "group "+id)
	}
	rows, err := s.db.QueryContext(ctx, `SELECT user_id FROM group_members WHERE group_id = $1 ORDER BY user_id`, id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var uid string
		if err := rows.Scan(&uid); err != nil {
			return nil, err
		}
		g.MemberIDs = append(g.MemberIDs, uid)
	}

	return g, rows.Err()
}

// SaveGroup creates a group (empty ID) or renames it, and sets its members
// when members is not nil.
func (s *Store) SaveGroup(ctx context.Context, g *Group, members []string) (*Group, error) {
	name, err := cleanGroup(g.Name)
	if err != nil {
		return nil, err
	}
	desc := strings.TrimSpace(g.Description)

	id := g.ID
	err = s.tx(ctx, func(tx *sql.Tx) error {
		if id == "" {
			if err := tx.QueryRowContext(ctx, `INSERT INTO user_groups (name, description) VALUES ($1, $2) RETURNING id`, name, desc).Scan(&id); err != nil {
				return err
			}
		} else {
			res, err := tx.ExecContext(ctx, `UPDATE user_groups SET name = $2, description = $3 WHERE id = $1`, id, name, desc)
			if err != nil {
				return notFound(err, "group "+id)
			}
			if err := expectRow(res, "group "+id); err != nil {
				return err
			}
		}
		if members == nil {
			return nil
		}
		if _, err := tx.ExecContext(ctx, `DELETE FROM group_members WHERE group_id = $1`, id); err != nil {
			return err
		}
		for _, uid := range members {
			if uid = strings.TrimSpace(uid); uid == "" {
				continue
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, id, uid); err != nil {
				return err
			}
		}

		return nil
	})
	if uniqueViolation(err) {
		return nil, fmt.Errorf("a group named %q already exists; pick another name", name)
	}
	if err != nil {
		return nil, fmt.Errorf("save group; %w", err)
	}

	return s.Group(ctx, id)
}

func (s *Store) DeleteGroup(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM user_groups WHERE id = $1`, id)
	if err != nil {
		return notFound(fmt.Errorf("delete group; %w", err), "group "+id)
	}

	return expectRow(res, "group "+id)
}

// UserGroups are the ids of the groups a user is in.
func (s *Store) UserGroups(ctx context.Context, userID string) ([]string, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT group_id FROM group_members WHERE user_id = $1 ORDER BY group_id`, userID)
	if err != nil {
		return nil, fmt.Errorf("user groups; %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}

	return out, rows.Err()
}

// SetUserGroups makes the user a member of exactly add (and keeps the rest)
// minus remove. Used by sign-in sync, which manages only mapped groups.
func (s *Store) SetUserGroups(ctx context.Context, userID string, add, remove []string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		for _, g := range remove {
			if _, err := tx.ExecContext(ctx, `DELETE FROM group_members WHERE group_id::text = $1 AND user_id = $2`, g, userID); err != nil {
				return err
			}
		}
		for _, g := range add {
			_, err := tx.ExecContext(ctx, `INSERT INTO group_members (group_id, user_id)
				SELECT id, $2 FROM user_groups WHERE id::text = $1 ON CONFLICT DO NOTHING`, g, userID)
			if err != nil {
				return err
			}
		}

		return nil
	})
}

// ForgetUser removes a deleted user's group memberships, project shares
// and sign-in links.
func (s *Store) ForgetUser(ctx context.Context, userID string) error {
	for _, q := range []string{
		`DELETE FROM group_members WHERE user_id = $1`,
		`DELETE FROM project_members WHERE user_id = $1`,
		`DELETE FROM sso_identities WHERE user_id = $1`,
	} {
		if _, err := s.db.ExecContext(ctx, q, userID); err != nil {
			return fmt.Errorf("forget user; %w", err)
		}
	}

	return nil
}

// ProjectGroups lists the groups a project is shared with.
func (s *Store) ProjectGroups(ctx context.Context, projectID string) ([]GroupShare, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT g.id, g.name, pg.role FROM project_groups pg
		JOIN user_groups g ON g.id = pg.group_id WHERE pg.project_id = $1 ORDER BY lower(g.name)`, projectID)
	if err != nil {
		return nil, notFound(fmt.Errorf("list project groups; %w", err), "project "+projectID)
	}
	defer rows.Close()
	out := []GroupShare{}
	for rows.Next() {
		var g GroupShare
		if err := rows.Scan(&g.GroupID, &g.Name, &g.Role); err != nil {
			return nil, err
		}
		out = append(out, g)
	}

	return out, rows.Err()
}

// SetProjectGroup shares a project with a group, or changes its role.
func (s *Store) SetProjectGroup(ctx context.Context, projectID, groupID, role string) error {
	if role != MemberViewer && role != MemberEditor {
		return fmt.Errorf("role must be viewer or editor, not %q", role)
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO project_groups (project_id, group_id, role) VALUES ($1, $2, $3)
		ON CONFLICT (project_id, group_id) DO UPDATE SET role = EXCLUDED.role`, projectID, groupID, role)
	if err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23503" {
			return fmt.Errorf("group %s; %w", groupID, ErrNotFound)
		}
		return notFound(fmt.Errorf("share with group; %w", err), "project "+projectID)
	}

	return nil
}

func (s *Store) RemoveProjectGroup(ctx context.Context, projectID, groupID string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM project_groups WHERE project_id = $1 AND group_id = $2`, projectID, groupID)
	if err != nil {
		return notFound(fmt.Errorf("unshare group; %w", err), "group "+groupID)
	}

	return expectRow(res, "group "+groupID)
}

// accessRole is the best role a user has on a project, directly or through
// a group: "editor", "viewer" or "".
const accessRoleSQL = `(SELECT r FROM (
		SELECT role AS r FROM project_members WHERE project_id = p.id AND user_id = %[1]s
		UNION ALL
		SELECT pg.role FROM project_groups pg JOIN group_members gm ON gm.group_id = pg.group_id
		WHERE pg.project_id = p.id AND gm.user_id = %[1]s
	) x ORDER BY r = 'editor' DESC LIMIT 1)`

// AccessRole is the best role a user has on a project through a direct
// share or a group, "" when none.
func (s *Store) AccessRole(ctx context.Context, projectID, userID string) (string, error) {
	var role sql.NullString
	q := `SELECT ` + fmt.Sprintf(accessRoleSQL, "$2") + ` FROM projects p WHERE p.id = $1`
	if err := s.db.QueryRowContext(ctx, q, projectID, userID).Scan(&role); err != nil {
		return "", notFound(fmt.Errorf("access role; %w", err), "project "+projectID)
	}

	return role.String, nil
}
