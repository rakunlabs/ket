-- The objects of an uploaded 3MF (id, name, triangles), read once at upload
-- so listing files does not open every archive again.
ALTER TABLE uploads ADD COLUMN IF NOT EXISTS objects JSONB;
