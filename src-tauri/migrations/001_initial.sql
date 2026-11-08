CREATE TABLE groups (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    parent_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE notes (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    group_id TEXT REFERENCES groups(id) ON DELETE SET NULL,
    kind TEXT NOT NULL DEFAULT 'richtext',
    privacy TEXT NOT NULL DEFAULT 'normal',
    sync_policy TEXT NOT NULL DEFAULT 'localOnly',
    schema_version INTEGER NOT NULL DEFAULT 1,
    content TEXT NOT NULL,
    plain_text TEXT NOT NULL DEFAULT '',
    preview TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1,
    server_revision INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT
);

CREATE INDEX notes_updated ON notes(updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX notes_group ON notes(group_id) WHERE deleted_at IS NULL;

CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    file_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    original_name TEXT NOT NULL,
    byte_length INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

-- Reserved for ciphertext-only sync. This local-only release never queues uploads.
CREATE TABLE sync_outbox (
    operation_id TEXT PRIMARY KEY,
    entity_id TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    base_revision INTEGER NOT NULL,
    operation TEXT NOT NULL,
    cipher_envelope TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE sync_state (
    account_id TEXT PRIMARY KEY,
    cursor INTEGER NOT NULL DEFAULT 0
);

PRAGMA user_version = 1;
