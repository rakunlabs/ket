-- Per-project sharing. owner_id is the user who created the project (NULL:
-- created without accounts, open to everyone by their role). Members get
-- viewer or editor access; their global role still caps what they can do.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_id TEXT;

CREATE TABLE IF NOT EXISTS project_members (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL,
    role       TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS project_members_user ON project_members (user_id);
