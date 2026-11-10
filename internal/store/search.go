package store

import (
	"context"
	"database/sql"
	"fmt"
	"strings"
)

// ProjectQuery filters and pages the project list.
type ProjectQuery struct {
	// Q matches name or description, case-insensitive, every word.
	Q string
	// Sort: "updated" (default, newest first), "name", "created".
	Sort   string
	Limit  int
	Offset int
	// UserID limits the list to what the user may see (owned, shared with
	// them or a group of theirs, without owner); empty lists every project
	// (administrators).
	UserID string
	// Mine keeps only projects the user owns; Shared only those shared
	// with them.
	Mine   bool
	Shared bool
}

// ProjectPage is one page of projects with the total that match.
type ProjectPage struct {
	Items []*Project `json:"items"`
	Total int        `json:"total"`
}

// MemberRoles are the user's best roles, direct or through a group, on the
// listed projects (id → role).
type MemberRoles map[string]string

// SearchProjects lists projects for q, and the user's member roles on them.
func (s *Store) SearchProjects(ctx context.Context, q ProjectQuery) (*ProjectPage, MemberRoles, error) {
	if q.Limit <= 0 || q.Limit > 100 {
		q.Limit = 20
	}
	if q.Offset < 0 {
		q.Offset = 0
	}

	var where []string
	args := []any{}
	arg := func(v any) string {
		args = append(args, v)
		return fmt.Sprintf("$%d", len(args))
	}

	if q.UserID != "" {
		u := arg(q.UserID)
		shared := fmt.Sprintf(accessRoleSQL, u) + " IS NOT NULL"
		switch {
		case q.Mine:
			where = append(where, "p.owner_id = "+u)
		case q.Shared:
			where = append(where, "(p.owner_id IS DISTINCT FROM "+u+" AND "+shared+")")
		default:
			where = append(where, "(p.owner_id IS NULL OR p.owner_id = "+u+" OR "+shared+")")
		}
	}
	for _, w := range strings.Fields(q.Q) {
		like := arg("%" + escapeLike(strings.ToLower(w)) + "%")
		where = append(where, "(lower(p.name) LIKE "+like+" ESCAPE '\\' OR lower(p.description) LIKE "+like+" ESCAPE '\\')")
	}
	cond := ""
	if len(where) > 0 {
		cond = " WHERE " + strings.Join(where, " AND ")
	}

	order := "p.updated_at DESC"
	switch q.Sort {
	case "name":
		order = "lower(p.name), p.updated_at DESC"
	case "created":
		order = "p.created_at DESC"
	}

	page := &ProjectPage{Items: []*Project{}}
	if err := s.db.QueryRowContext(ctx, `SELECT count(*) FROM projects p`+cond, args...).Scan(&page.Total); err != nil {
		return nil, nil, fmt.Errorf("count projects; %w", err)
	}

	sel := projectSelect + cond + " ORDER BY " + order + " LIMIT " + arg(q.Limit) + " OFFSET " + arg(q.Offset)
	rows, err := s.db.QueryContext(ctx, sel, args...)
	if err != nil {
		return nil, nil, fmt.Errorf("list projects; %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		p, err := scanProject(rows)
		if err != nil {
			return nil, nil, err
		}
		page.Items = append(page.Items, p)
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}

	roles := MemberRoles{}
	if q.UserID != "" && len(page.Items) > 0 {
		ids := make([]string, len(page.Items))
		for i, p := range page.Items {
			ids[i] = p.ID
		}
		mrows, err := s.db.QueryContext(ctx,
			`SELECT p.id, `+fmt.Sprintf(accessRoleSQL, "$1")+` FROM projects p WHERE p.id::text = ANY($2)`, q.UserID, ids)
		if err != nil {
			return nil, nil, err
		}
		defer mrows.Close()
		for mrows.Next() {
			var id string
			var role sql.NullString
			if err := mrows.Scan(&id, &role); err != nil {
				return nil, nil, err
			}
			if role.Valid {
				roles[id] = role.String
			}
		}
		if err := mrows.Err(); err != nil {
			return nil, nil, err
		}
	}

	return page, roles, nil
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}
