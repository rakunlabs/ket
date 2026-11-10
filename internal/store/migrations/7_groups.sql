-- Groups of users. A project shared with a group gives every member that
-- role; the best of a user's direct and group roles wins. user_id is the
-- auth store's user id (auth_users.id).
CREATE TABLE IF NOT EXISTS user_groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS user_groups_name ON user_groups (lower(name));

CREATE TABLE IF NOT EXISTS group_members (
    group_id UUID NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    user_id  TEXT NOT NULL,
    PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS group_members_user ON group_members (user_id);

CREATE TABLE IF NOT EXISTS project_groups (
    project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    group_id   UUID NOT NULL REFERENCES user_groups(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, group_id)
);
CREATE INDEX IF NOT EXISTS project_groups_group ON project_groups (group_id);

-- Sign-in identities from OAuth2 / OIDC providers linked to a user.
CREATE TABLE IF NOT EXISTS sso_identities (
    provider   TEXT NOT NULL,
    subject    TEXT NOT NULL,
    user_id    TEXT NOT NULL,
    email      TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, subject)
);
CREATE INDEX IF NOT EXISTS sso_identities_user ON sso_identities (user_id);
