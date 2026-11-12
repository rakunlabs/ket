package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"time"
)

type Conversation struct {
	ID        string `json:"id"`
	ProjectID string `json:"project_id"`
	// BranchID is the proposal branch the agent works on; nil = main.
	BranchID  *string   `json:"branch_id,omitempty"`
	Title     string    `json:"title"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (s *Store) ListConversations(ctx context.Context, projectID string) ([]*Conversation, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT id, project_id, branch_id, title, created_at, updated_at FROM conversations
		WHERE project_id = $1 ORDER BY updated_at DESC`, projectID)
	if err != nil {
		return nil, notFound(fmt.Errorf("list conversations; %w", err), "project "+projectID)
	}
	defer rows.Close()

	out := []*Conversation{}
	for rows.Next() {
		var c Conversation
		if err := rows.Scan(&c.ID, &c.ProjectID, &c.BranchID, &c.Title, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, fmt.Errorf("scan conversation; %w", err)
		}
		out = append(out, &c)
	}

	return out, rows.Err()
}

func (s *Store) GetConversation(ctx context.Context, id string) (*Conversation, error) {
	var c Conversation
	err := s.db.QueryRowContext(ctx,
		`SELECT id, project_id, branch_id, title, created_at, updated_at FROM conversations WHERE id = $1`, id).
		Scan(&c.ID, &c.ProjectID, &c.BranchID, &c.Title, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, notFound(err, "conversation "+id)
	}

	return &c, nil
}

func (s *Store) CreateConversation(ctx context.Context, projectID, title string) (*Conversation, error) {
	var id string
	if err := s.db.QueryRowContext(ctx,
		`INSERT INTO conversations (project_id, title) VALUES ($1, $2) RETURNING id`, projectID, title).Scan(&id); err != nil {
		return nil, notFound(fmt.Errorf("insert conversation; %w", err), "project "+projectID)
	}

	return s.GetConversation(ctx, id)
}

func (s *Store) DeleteConversation(ctx context.Context, id string) error {
	res, err := s.db.ExecContext(ctx, `DELETE FROM conversations WHERE id = $1`, id)
	if err != nil {
		return notFound(fmt.Errorf("delete conversation; %w", err), "conversation "+id)
	}

	return expectRow(res, "conversation "+id)
}

// Messages returns a conversation's messages in order, each in the OpenAI
// chat message format.
func (s *Store) Messages(ctx context.Context, conversationID string) ([]json.RawMessage, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT message FROM messages WHERE conversation_id = $1 ORDER BY seq`, conversationID)
	if err != nil {
		return nil, fmt.Errorf("list messages; %w", err)
	}
	defer rows.Close()

	out := []json.RawMessage{}
	for rows.Next() {
		var m []byte
		if err := rows.Scan(&m); err != nil {
			return nil, fmt.Errorf("scan message; %w", err)
		}
		out = append(out, m)
	}

	return out, rows.Err()
}

// AppendMessages adds messages after the conversation's last one.
func (s *Store) AppendMessages(ctx context.Context, conversationID string, msgs ...json.RawMessage) error {
	if len(msgs) == 0 {
		return nil
	}

	return s.tx(ctx, func(tx *sql.Tx) error {
		// The conversation row serializes appends, so two writers never pick the same seq.
		if _, err := tx.ExecContext(ctx, `SELECT 1 FROM conversations WHERE id = $1 FOR NO KEY UPDATE`, conversationID); err != nil {
			return fmt.Errorf("lock conversation; %w", err)
		}
		var last int64
		if err := tx.QueryRowContext(ctx,
			`SELECT COALESCE(max(seq), 0) FROM messages WHERE conversation_id = $1`, conversationID).Scan(&last); err != nil {
			return fmt.Errorf("last message; %w", err)
		}
		for i, m := range msgs {
			if _, err := tx.ExecContext(ctx,
				`INSERT INTO messages (conversation_id, seq, message) VALUES ($1, $2, $3)`,
				conversationID, last+int64(i)+1, []byte(m)); err != nil {
				return fmt.Errorf("insert message; %w", err)
			}
		}
		_, err := tx.ExecContext(ctx, `UPDATE conversations SET updated_at = now() WHERE id = $1`, conversationID)

		return err
	})
}

func (s *Store) RenameConversation(ctx context.Context, id, title string) error {
	res, err := s.db.ExecContext(ctx, `UPDATE conversations SET title = $2 WHERE id = $1`, id, title)
	if err != nil {
		return fmt.Errorf("rename conversation; %w", err)
	}

	return expectRow(res, "conversation "+id)
}

// SetConversationBranch points a conversation at a proposal branch, or back
// at main with branchID "".
func (s *Store) SetConversationBranch(ctx context.Context, id, branchID string) error {
	var arg any
	if branchID != "" {
		arg = branchID
	}
	res, err := s.db.ExecContext(ctx, `UPDATE conversations SET branch_id = $2 WHERE id = $1`, id, arg)
	if err != nil {
		return fmt.Errorf("set conversation branch; %w", err)
	}

	return expectRow(res, "conversation "+id)
}
