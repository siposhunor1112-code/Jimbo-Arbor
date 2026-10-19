import Database from 'better-sqlite3';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id                     INTEGER PRIMARY KEY,
  email                  TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash          TEXT NOT NULL,
  created_at             TEXT NOT NULL DEFAULT (datetime('now')),
  stripe_customer_id     TEXT UNIQUE,
  stripe_subscription_id TEXT,
  subscription_status    TEXT,
  current_period_end     INTEGER
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id ON sessions(user_id);

CREATE TABLE IF NOT EXISTS templates (
  id            INTEGER PRIMARY KEY,
  title         TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  category      TEXT NOT NULL,
  month         TEXT NOT NULL CHECK (month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  file_key      TEXT,
  original_name TEXT,
  size_bytes    INTEGER,
  link_url      TEXT,
  preview_key   TEXT,
  preview_mime  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK ((file_key IS NULL) <> (link_url IS NULL))
);
CREATE INDEX IF NOT EXISTS templates_month ON templates(month);
`;

export function openDb(file) {
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}
