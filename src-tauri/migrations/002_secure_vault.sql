CREATE TABLE vault_header (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    payload TEXT NOT NULL
);

CREATE TABLE secure_records (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
);

PRAGMA user_version = 2;
