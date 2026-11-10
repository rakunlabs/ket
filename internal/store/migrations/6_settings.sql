-- Settings edited in the admin UI. value is JSON; secret values (API keys,
-- signing keys) are stored encrypted by the server (see settings.go).
CREATE TABLE IF NOT EXISTS settings (
    key        TEXT PRIMARY KEY,
    value      JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by TEXT NOT NULL DEFAULT ''
);

-- Login sessions (ada sessionstore): values are JSON, encrypted by ada when
-- a cipher is set. expires_at NULL never expires.
CREATE TABLE IF NOT EXISTS auth_sessions (
    id         TEXT PRIMARY KEY,
    data       JSONB NOT NULL,
    expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS auth_sessions_expires ON auth_sessions (expires_at);

-- Faster project search (name and description, case-insensitive).
CREATE INDEX IF NOT EXISTS projects_updated ON projects (updated_at DESC);
