-- Model files people upload (STL, 3MF, STEP), for import features. They are
-- addressed as ket:asset/<id>/<name>; the project keeps only that reference.
CREATE TABLE IF NOT EXISTS uploads (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    size       BIGINT NOT NULL,
    sha256     TEXT NOT NULL,
    data       BYTEA NOT NULL,
    created_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS uploads_project ON uploads (project_id, created_at DESC);
