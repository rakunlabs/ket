CREATE TABLE IF NOT EXISTS assets (
    -- url is the source URL, with "#path" for a file inside a zip.
    url        TEXT PRIMARY KEY,
    data       BYTEA NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
