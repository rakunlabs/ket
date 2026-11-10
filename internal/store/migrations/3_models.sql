CREATE TABLE IF NOT EXISTS models (
    uuid       TEXT PRIMARY KEY,
    -- obj is the EasyEDA OBJ text with its inline materials.
    obj        TEXT NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
