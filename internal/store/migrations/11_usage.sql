-- Tokens the built-in assistant spent, per request: who, in which project,
-- with which provider. Estimated rows were counted by Ket because the
-- provider did not report usage.
CREATE TABLE IF NOT EXISTS ai_usage (
    id                BIGSERIAL PRIMARY KEY,
    user_subject      TEXT NOT NULL DEFAULT '',
    project_id        UUID REFERENCES projects(id) ON DELETE SET NULL,
    conversation_id   UUID REFERENCES conversations(id) ON DELETE SET NULL,
    provider          TEXT NOT NULL,
    model             TEXT NOT NULL,
    prompt_tokens     INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    estimated         BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_user_time ON ai_usage (user_subject, created_at);
CREATE INDEX IF NOT EXISTS ai_usage_time ON ai_usage (created_at);

-- A conversation's summary of its older turns: the agent sends it instead
-- of those messages once the history grows past the compaction threshold.
-- summary_upto is the last message seq the summary covers.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS summary_upto BIGINT NOT NULL DEFAULT 0;
