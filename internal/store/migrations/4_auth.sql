-- Auth Kit: users and the OAuth server (MCP clients, personal tokens).
-- Times are unix millis; codes, tokens and secrets are stored as SHA-256.
CREATE TABLE IF NOT EXISTS auth_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_key TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    roles TEXT NOT NULL,
    disabled BOOLEAN NOT NULL,
    attributes TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    redirect_uris TEXT NOT NULL,
    grant_types TEXT NOT NULL,
    auth_method TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
    hash TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    identity TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    code_challenge TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT NOT NULL,
    extra TEXT NOT NULL,
    expires_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_tokens (
    id TEXT PRIMARY KEY,
    client_id TEXT NOT NULL,
    name TEXT NOT NULL,
    subject TEXT NOT NULL,
    identity TEXT NOT NULL,
    scopes TEXT NOT NULL,
    granted_scopes TEXT NOT NULL,
    resource TEXT NOT NULL,
    extra TEXT NOT NULL,
    access_hash TEXT NOT NULL UNIQUE,
    access_expires_at BIGINT NOT NULL,
    refresh_hash TEXT NULL UNIQUE,
    previous_refresh_hash TEXT NULL UNIQUE,
    refresh_expires_at BIGINT NOT NULL,
    rotated_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_consents (
    subject TEXT NOT NULL,
    client_id TEXT NOT NULL,
    scopes TEXT NOT NULL,
    resource TEXT NOT NULL,
    extra_hash TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (subject, client_id)
);

CREATE INDEX IF NOT EXISTS auth_clients_name ON auth_clients (name);
CREATE INDEX IF NOT EXISTS auth_tokens_subject ON auth_tokens (subject);
CREATE INDEX IF NOT EXISTS auth_tokens_client ON auth_tokens (client_id);
