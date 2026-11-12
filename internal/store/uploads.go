package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Upload is a model file someone uploaded to a project (without its data).
type Upload struct {
	ID        string    `json:"id"`
	ProjectID string    `json:"project_id"`
	Name      string    `json:"name"`
	Size      int64     `json:"size"`
	SHA256    string    `json:"sha256"`
	CreatedBy string    `json:"created_by,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

// SaveUpload stores a file for a project. The same content uploaded again
// under the same name returns the earlier upload.
func (s *Store) SaveUpload(ctx context.Context, projectID, name, sha string, data []byte, by string) (*Upload, error) {
	if u, err := s.scanUpload(s.db.QueryRowContext(ctx,
		`SELECT id, project_id, name, size, sha256, coalesce(created_by, ''), created_at FROM uploads
		WHERE project_id = $1 AND name = $2 AND sha256 = $3 LIMIT 1`, projectID, name, sha)); err == nil {
		return u, nil
	}

	var createdBy sql.NullString
	if by != "" {
		createdBy = sql.NullString{String: by, Valid: true}
	}

	return s.scanUpload(s.db.QueryRowContext(ctx,
		`INSERT INTO uploads (project_id, name, size, sha256, data, created_by) VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING id, project_id, name, size, sha256, coalesce(created_by, ''), created_at`,
		projectID, name, len(data), sha, data, createdBy))
}

func (s *Store) scanUpload(row interface{ Scan(...any) error }) (*Upload, error) {
	var u Upload
	if err := row.Scan(&u.ID, &u.ProjectID, &u.Name, &u.Size, &u.SHA256, &u.CreatedBy, &u.CreatedAt); err != nil {
		return nil, notFound(err, "upload")
	}

	return &u, nil
}

// Uploads lists a project's files, newest first.
func (s *Store) Uploads(ctx context.Context, projectID string) ([]Upload, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, project_id, name, size, sha256, coalesce(created_by, ''), created_at FROM uploads
		WHERE project_id = $1 ORDER BY created_at DESC`, projectID)
	if err != nil {
		return nil, fmt.Errorf("list uploads; %w", err)
	}
	defer rows.Close()

	out := []Upload{}
	for rows.Next() {
		u, err := s.scanUpload(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, *u)
	}

	return out, rows.Err()
}

// UploadData returns an upload and its bytes.
func (s *Store) UploadData(ctx context.Context, id string) (*Upload, []byte, error) {
	var u Upload
	var data []byte
	err := s.db.QueryRowContext(ctx,
		`SELECT id, project_id, name, size, sha256, coalesce(created_by, ''), created_at, data FROM uploads WHERE id = $1`, id).
		Scan(&u.ID, &u.ProjectID, &u.Name, &u.Size, &u.SHA256, &u.CreatedBy, &u.CreatedAt, &data)
	if err != nil {
		return nil, nil, notFound(err, "upload "+id)
	}

	return &u, data, nil
}

// DeleteUpload removes a project's file.
func (s *Store) DeleteUpload(ctx context.Context, projectID, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM uploads WHERE id = $1 AND project_id = $2`, id, projectID)
	if err != nil {
		return notFound(err, "upload "+id)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return fmt.Errorf("upload %s; %w", id, ErrNotFound)
	}

	return nil
}
