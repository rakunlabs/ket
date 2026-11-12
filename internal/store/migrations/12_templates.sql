-- Templates and reusable blocks: .ket project files the server keeps.
-- kind template: a starting point for a new project (its ops become the
-- project's first operation, import_project). kind block: a piece to put
-- into a design with insert_block (a power input, a boss pattern).
CREATE TABLE IF NOT EXISTS templates (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        TEXT NOT NULL CHECK (kind IN ('template', 'block')),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    data        TEXT NOT NULL,
    created_by  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (kind, name)
);
