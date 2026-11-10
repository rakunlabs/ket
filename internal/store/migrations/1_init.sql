CREATE TABLE IF NOT EXISTS projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A branch is a line of operations. Every project starts with "main"; AI
-- proposals live on their own branch until merged.
CREATE TABLE IF NOT EXISTS branches (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    -- base_seq is the parent's seq this branch forked from (0 for main).
    parent_id   UUID REFERENCES branches(id) ON DELETE SET NULL,
    base_seq    BIGINT NOT NULL DEFAULT 0,
    head_seq    BIGINT NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (project_id, name)
);

-- ops is the operation log. An op is one command (or one atomic batch)
-- with its arguments; replaying a branch's ops 1..head_seq in order
-- rebuilds the document. Undo moves head_seq back, redo forward; a new op
-- after an undo drops the ops above head_seq.
CREATE TABLE IF NOT EXISTS ops (
    branch_id   UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    seq         BIGINT NOT NULL,
    op          JSONB NOT NULL,
    -- author: "user", "ai:<conversation>" or "mcp:<session>".
    author      TEXT NOT NULL DEFAULT '',
    message     TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (branch_id, seq)
);

-- snapshots cache a full document at a seq so opening a project does not
-- replay the whole log. A snapshot above head_seq is stale.
CREATE TABLE IF NOT EXISTS snapshots (
    branch_id   UUID NOT NULL REFERENCES branches(id) ON DELETE CASCADE,
    seq         BIGINT NOT NULL,
    doc         JSONB NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (branch_id, seq)
);

CREATE TABLE IF NOT EXISTS conversations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id  UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    branch_id   UUID REFERENCES branches(id) ON DELETE SET NULL,
    title       TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS conversations_project_idx ON conversations (project_id, updated_at DESC);

-- messages hold the OpenAI chat format as is (role, content, tool_calls,
-- tool_call_id) so a conversation can be resumed verbatim.
CREATE TABLE IF NOT EXISTS messages (
    conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq             BIGINT NOT NULL,
    message         JSONB NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_id, seq)
);
