package store

import (
	"context"
	"database/sql"
	"encoding/json"
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
	// Objects of a 3MF as JSON (id, name, triangles), read at upload.
	Objects json.RawMessage `json:"objects,omitempty"`
}

const uploadColumns = `id, project_id, name, size, sha256, coalesce(created_by, ''), created_at, objects`

// MaxProjectUploads caps the bytes of files one project keeps.
const MaxProjectUploads = 1 << 30

// SaveUpload stores a file for a project. The same content uploaded again
// under the same name returns the earlier upload.
func (s *Store) SaveUpload(ctx context.Context, projectID, name, sha string, data []byte, objects json.RawMessage, by string) (*Upload, error) {
	if u, err := s.scanUpload(s.db.QueryRowContext(ctx,
		`SELECT `+uploadColumns+` FROM uploads WHERE project_id = $1 AND name = $2 AND sha256 = $3 LIMIT 1`, projectID, name, sha)); err == nil {
		return u, nil
	}

	var used int64
	if err := s.db.QueryRowContext(ctx, `SELECT coalesce(sum(size), 0) FROM uploads WHERE project_id = $1`, projectID).Scan(&used); err != nil {
		return nil, fmt.Errorf("upload space; %w", err)
	}
	if used+int64(len(data)) > MaxProjectUploads {
		return nil, fmt.Errorf("the project's files would take %d MB, more than %d MB: delete unused uploads first; %w", (used+int64(len(data)))>>20, MaxProjectUploads>>20, ErrConflict)
	}

	var createdBy sql.NullString
	if by != "" {
		createdBy = sql.NullString{String: by, Valid: true}
	}
	var objs any
	if len(objects) > 0 {
		objs = []byte(objects)
	}

	u, err := s.scanUpload(s.db.QueryRowContext(ctx,
		`INSERT INTO uploads (project_id, name, size, sha256, data, objects, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)
		RETURNING `+uploadColumns,
		projectID, name, len(data), sha, data, objs, createdBy))
	if err != nil {
		return nil, notFound(err, "project "+projectID)
	}

	return u, nil
}

func (s *Store) scanUpload(row interface{ Scan(...any) error }) (*Upload, error) {
	var u Upload
	var objs []byte
	if err := row.Scan(&u.ID, &u.ProjectID, &u.Name, &u.Size, &u.SHA256, &u.CreatedBy, &u.CreatedAt, &objs); err != nil {
		return nil, notFound(err, "upload")
	}
	if len(objs) > 0 {
		u.Objects = objs
	}

	return &u, nil
}

// Uploads lists a project's files, newest first.
func (s *Store) Uploads(ctx context.Context, projectID string) ([]Upload, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT `+uploadColumns+` FROM uploads WHERE project_id = $1 ORDER BY created_at DESC`, projectID)
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

// UploadInfo returns an upload without its bytes.
func (s *Store) UploadInfo(ctx context.Context, id string) (*Upload, error) {
	u, err := s.scanUpload(s.db.QueryRowContext(ctx, `SELECT `+uploadColumns+` FROM uploads WHERE id = $1`, id))
	if err != nil {
		return nil, notFound(err, "upload "+id)
	}

	return u, nil
}

// UploadData returns the bytes of an upload.
func (s *Store) UploadData(ctx context.Context, id string) ([]byte, error) {
	var data []byte
	if err := s.db.QueryRowContext(ctx, `SELECT data FROM uploads WHERE id = $1`, id).Scan(&data); err != nil {
		return nil, notFound(err, "upload "+id)
	}

	return data, nil
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
