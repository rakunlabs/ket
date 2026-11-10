CREATE TABLE IF NOT EXISTS parts (
    lcsc       TEXT PRIMARY KEY,
    -- raw is the EasyEDA component response as fetched; parsing happens on
    -- read so parser fixes apply to cached parts too.
    raw        JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
