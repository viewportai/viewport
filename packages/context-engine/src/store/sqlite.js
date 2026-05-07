const fs = require('node:fs');
const Database = require('better-sqlite3');

function openStore(dbPath) {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS context_entries (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      scope TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      trust_state TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      superseded_by TEXT
    );

    CREATE TABLE IF NOT EXISTS context_candidates (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      trust_state TEXT NOT NULL,
      source TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'created',
      priority_score INTEGER NOT NULL DEFAULT 0,
      assigned_to TEXT,
      reviewed_by TEXT,
      review_reason TEXT,
      reviewed_at TEXT,
      tombstoned_at TEXT
    );

    CREATE TABLE IF NOT EXISTS context_edges (
      from_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      to_id TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS context_bundles (
      id TEXT PRIMARY KEY,
      digest TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS context_entries_fts
      USING fts5(id UNINDEXED, title, body);
  `);

  return db;
}

function resetStore(dbPath) {
  if (fs.existsSync(dbPath)) {
    fs.rmSync(dbPath);
  }

  for (const suffix of ['-wal', '-shm']) {
    if (fs.existsSync(`${dbPath}${suffix}`)) {
      fs.rmSync(`${dbPath}${suffix}`);
    }
  }

  return openStore(dbPath);
}

module.exports = { openStore, resetStore };
