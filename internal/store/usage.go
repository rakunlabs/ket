package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// UsageRow is one request of the built-in assistant.
type UsageRow struct {
	User             string
	ProjectID        string
	ConversationID   string
	Provider         string
	Model            string
	PromptTokens     int
	CompletionTokens int
	Estimated        bool
}

func (s *Store) RecordUsage(ctx context.Context, u UsageRow) error {
	nullable := func(v string) any {
		if v == "" {
			return nil
		}
		return v
	}
	_, err := s.db.ExecContext(ctx,
		`INSERT INTO ai_usage (user_subject, project_id, conversation_id, provider, model, prompt_tokens, completion_tokens, estimated)
		VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
		u.User, nullable(u.ProjectID), nullable(u.ConversationID), u.Provider, u.Model, u.PromptTokens, u.CompletionTokens, u.Estimated)
	if err != nil {
		return fmt.Errorf("record usage; %w", err)
	}

	return nil
}

// UsageTotal is tokens spent since a time, for one user ("" = everyone).
func (s *Store) UsageTotal(ctx context.Context, user string, since time.Time) (int64, error) {
	var n sql.NullInt64
	q := `SELECT SUM(prompt_tokens + completion_tokens) FROM ai_usage WHERE created_at >= $1`
	args := []any{since}
	if user != "" {
		q += ` AND user_subject = $2`
		args = append(args, user)
	}
	if err := s.db.QueryRowContext(ctx, q, args...).Scan(&n); err != nil {
		return 0, fmt.Errorf("usage total; %w", err)
	}

	return n.Int64, nil
}

// UsageSummary is one group of usage: a day and a user, project and provider.
type UsageSummary struct {
	Day              string `json:"day"`
	User             string `json:"user"`
	ProjectID        string `json:"project_id,omitempty"`
	Project          string `json:"project,omitempty"`
	Provider         string `json:"provider"`
	Model            string `json:"model"`
	Requests         int    `json:"requests"`
	PromptTokens     int64  `json:"prompt_tokens"`
	CompletionTokens int64  `json:"completion_tokens"`
	Estimated        bool   `json:"estimated,omitempty"`
}

// UsageSince groups usage by day, user, project and provider, newest first.
func (s *Store) UsageSince(ctx context.Context, since time.Time) ([]UsageSummary, error) {
	rows, err := s.db.QueryContext(ctx,
		`SELECT to_char(u.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, u.user_subject, COALESCE(u.project_id::text, ''), COALESCE(p.name, ''),
			u.provider, u.model, COUNT(*), SUM(u.prompt_tokens), SUM(u.completion_tokens), bool_or(u.estimated)
		FROM ai_usage u LEFT JOIN projects p ON p.id = u.project_id
		WHERE u.created_at >= $1
		GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 1 DESC, 9 DESC`, since)
	if err != nil {
		return nil, fmt.Errorf("usage summary; %w", err)
	}
	defer rows.Close()

	out := []UsageSummary{}
	for rows.Next() {
		var u UsageSummary
		if err := rows.Scan(&u.Day, &u.User, &u.ProjectID, &u.Project, &u.Provider, &u.Model, &u.Requests, &u.PromptTokens, &u.CompletionTokens, &u.Estimated); err != nil {
			return nil, fmt.Errorf("scan usage; %w", err)
		}
		out = append(out, u)
	}

	return out, rows.Err()
}

// ConversationSummary returns the stored summary and the last message seq it covers.
func (s *Store) ConversationSummary(ctx context.Context, id string) (string, int64, error) {
	var text string
	var upto int64
	err := s.db.QueryRowContext(ctx, `SELECT summary, summary_upto FROM conversations WHERE id = $1`, id).Scan(&text, &upto)
	if err != nil {
		return "", 0, notFound(err, "conversation "+id)
	}

	return text, upto, nil
}

func (s *Store) SetConversationSummary(ctx context.Context, id, summary string, upto int64) error {
	res, err := s.db.ExecContext(ctx, `UPDATE conversations SET summary = $2, summary_upto = $3 WHERE id = $1`, id, summary, upto)
	if err != nil {
		return fmt.Errorf("set conversation summary; %w", err)
	}

	return expectRow(res, "conversation "+id)
}
