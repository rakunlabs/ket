-- Usage rows outlive what they were for: a deleted conversation or project
-- must not take its tokens off a user's monthly total, nor fail the insert.
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_project_id_fkey;
ALTER TABLE ai_usage DROP CONSTRAINT IF EXISTS ai_usage_conversation_id_fkey;
