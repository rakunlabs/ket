-- One assistant turn per conversation across every server: a turn holds a
-- lease (renewed while it runs; it lapses on its own if the server dies).
-- stop_requested lets any server stop a turn another server is running.
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS running_by TEXT NOT NULL DEFAULT '';
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS running_until TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS stop_requested BOOLEAN NOT NULL DEFAULT false;
