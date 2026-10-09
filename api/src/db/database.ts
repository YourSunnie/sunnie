import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Append-only list of migrations. Never edit an entry that has shipped — add a new one.
 * The index of the last applied entry is tracked in `PRAGMA user_version`.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE conversations (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    title TEXT,
    model TEXT,
    summary TEXT,
    summary_upto_seq INTEGER NOT NULL DEFAULT 0,
    core_snapshot TEXT,
    context_tokens INTEGER,
    context_tokens_seq INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE messages (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    model TEXT,
    run_id TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (conversation_id, seq)
  );

  CREATE VIRTUAL TABLE messages_fts USING fts5(
    text, content='messages', content_rowid='pk', tokenize='porter unicode61'
  );
  CREATE TRIGGER messages_ai AFTER INSERT ON messages BEGIN
    INSERT INTO messages_fts(rowid, text) VALUES (new.pk, new.text);
  END;
  CREATE TRIGGER messages_ad AFTER DELETE ON messages BEGIN
    INSERT INTO messages_fts(messages_fts, rowid, text) VALUES ('delete', old.pk, old.text);
  END;

  CREATE TABLE memories (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL DEFAULT 'fact',
    content TEXT NOT NULL,
    source TEXT NOT NULL,
    conversation_id TEXT,
    recall_count INTEGER NOT NULL DEFAULT 0,
    last_recalled_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE VIRTUAL TABLE memories_fts USING fts5(
    content, content='memories', content_rowid='pk', tokenize='porter unicode61'
  );
  CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (new.pk, new.content);
  END;
  CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.pk, old.content);
  END;
  CREATE TRIGGER memories_au AFTER UPDATE OF content ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.pk, old.content);
    INSERT INTO memories_fts(rowid, content) VALUES (new.pk, new.content);
  END;

  CREATE TABLE core_memory (
    block TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE compactions (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    from_seq INTEGER NOT NULL,
    upto_seq INTEGER NOT NULL,
    summary TEXT NOT NULL,
    tokens_before INTEGER NOT NULL,
    memories_saved INTEGER NOT NULL DEFAULT 0,
    model TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE logins (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    site TEXT NOT NULL,
    username TEXT NOT NULL DEFAULT '',
    password TEXT NOT NULL DEFAULT '',
    totp_secret TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE tasks (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    content TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
    note TEXT NOT NULL DEFAULT '',
    due_at TEXT,
    checks INTEGER NOT NULL DEFAULT 0,
    time_zone TEXT,
    conversation_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_due ON tasks (status, due_at);

  ALTER TABLE conversations ADD COLUMN kind TEXT NOT NULL DEFAULT 'chat';
  ALTER TABLE messages ADD COLUMN origin TEXT;
  `,
  `
  ALTER TABLE conversations ADD COLUMN parent_id TEXT;
  CREATE INDEX conversations_parent ON conversations (parent_id);
  `,
  `
  CREATE TABLE runs (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'cancelled', 'failed')),
    input TEXT NOT NULL,
    resumes INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    finish_reason TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX runs_status ON runs (status);

  CREATE TABLE run_actions (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    name TEXT NOT NULL,
    input TEXT NOT NULL,
    finished INTEGER NOT NULL DEFAULT 0,
    lost INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL
  );
  CREATE INDEX run_actions_run ON run_actions (run_id);
  `,
  `
  ALTER TABLE runs ADD COLUMN request_id TEXT;
  ALTER TABLE runs ADD COLUMN outcome TEXT;
  CREATE UNIQUE INDEX runs_request ON runs (conversation_id, request_id) WHERE request_id IS NOT NULL;
  `,
  `
  CREATE TABLE run_steers (
    pk INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    text TEXT NOT NULL,
    time_zone TEXT,
    request_id TEXT,
    taken INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX run_steers_run ON run_steers (run_id, taken);
  CREATE UNIQUE INDEX run_steers_request ON run_steers (run_id, request_id) WHERE request_id IS NOT NULL;
  `,
  `
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    data BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    request_id TEXT UNIQUE,
    created_at TEXT NOT NULL
  );
  ALTER TABLE messages ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE run_steers ADD COLUMN attachment_ids TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE attachment_previews (
    attachment_id TEXT PRIMARY KEY REFERENCES attachments(id) ON DELETE CASCADE,
    media_type TEXT NOT NULL CHECK (media_type IN ('image/jpeg', 'image/png')),
    data BLOB NOT NULL,
    sha256 TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE skill_sources (
    repository TEXT PRIMARY KEY,
    trusted_at TEXT NOT NULL
  );
  `,
  `
  ALTER TABLE messages ADD COLUMN quotes TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE run_steers ADD COLUMN quotes TEXT NOT NULL DEFAULT '[]';
  `,
  `
  CREATE TABLE interests (
    id TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    topic_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (status IN ('active', 'muted')),
    memory_id TEXT,
    last_checked_at TEXT,
    last_report TEXT NOT NULL DEFAULT '',
    seen_urls TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
  );
  CREATE TABLE interest_preferences (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    paused INTEGER NOT NULL DEFAULT 0,
    next_digest_at TEXT
  );
  INSERT INTO interest_preferences (id) VALUES (1);
  `,
  `
  ALTER TABLE attachments ADD COLUMN drive_path TEXT;
  `,
  `
  ALTER TABLE conversations ADD COLUMN reasoning TEXT;
  CREATE TABLE chat_model_defaults (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    model TEXT NOT NULL,
    reasoning TEXT NOT NULL
  );
  `,
  `
  CREATE TABLE home_pins (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('weather', 'headline', 'note')),
    title TEXT NOT NULL,
    text TEXT NOT NULL,
    link TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE home_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    time_zone TEXT,
    last_brief_at TEXT,
    brief_run_id TEXT
  );
  INSERT INTO home_state (id) VALUES (1);
  CREATE INDEX messages_run ON messages (run_id);
  `,
  `
  CREATE TABLE push_devices (
    token TEXT PRIMARY KEY,
    environment TEXT NOT NULL CHECK (environment IN ('sandbox', 'production')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // Home becomes a list of widgets. Pins move over; the brief's two keep a row (expired until
  // first written) so their place on Home is settled before the first brief.
  `
  CREATE TABLE home_widgets (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    body TEXT NOT NULL,
    action TEXT,
    source TEXT NOT NULL CHECK (source IN ('builtin', 'agent', 'api')),
    position INTEGER NOT NULL,
    hidden INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  INSERT INTO home_widgets (id, title, body, source, position, expires_at, created_at, updated_at) VALUES
    ('headline', '', '{"type":"headline","text":"-"}', 'agent', 0, '1970-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('weather', '', '{"type":"weather","place":"-"}', 'agent', 1, '1970-01-01T00:00:00.000Z', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('upnext', 'Up next', '{"type":"upnext"}', 'builtin', 2, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('updates', 'Updates', '{"type":"updates"}', 'builtin', 1000, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    ('following', 'Following', '{"type":"following"}', 'builtin', 1001, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
  UPDATE home_widgets SET (title, body, expires_at, updated_at) =
    (SELECT title, json_object('type', 'headline', 'text', text), expires_at, updated_at FROM home_pins WHERE kind = 'headline' ORDER BY updated_at DESC LIMIT 1)
    WHERE id = 'headline' AND EXISTS (SELECT 1 FROM home_pins WHERE kind = 'headline');
  UPDATE home_widgets SET (title, body, expires_at, updated_at) =
    (SELECT title, json_object('type', 'weather', 'place', title, 'summary', replace(text, char(10), ' · ')), expires_at, updated_at FROM home_pins WHERE kind = 'weather' ORDER BY updated_at DESC LIMIT 1)
    WHERE id = 'weather' AND EXISTS (SELECT 1 FROM home_pins WHERE kind = 'weather');
  INSERT INTO home_widgets (id, title, body, action, source, position, expires_at, created_at, updated_at)
    SELECT 'note-' || lower(hex(randomblob(4))), title, json_object('type', 'markdown', 'text', text),
      CASE WHEN link IS NOT NULL THEN json_object('type', 'open_url', 'url', link) END,
      'agent', 2 + row_number() OVER (ORDER BY updated_at DESC), expires_at, created_at, updated_at
    FROM home_pins WHERE kind = 'note';
  DROP TABLE home_pins;
  `,
  // The latest snapshot of each record the user's phone shares (health, calendar, …).
  `
  CREATE TABLE phone_data (
    source TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    time_zone TEXT,
    captured_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  `,
  // A memory's embedding: derived data, made again whenever the model or the content differs.
  `
  CREATE TABLE memory_vectors (
    memory_id TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    vector BLOB NOT NULL
  );
  `,
  // Home holds only what Sunnie or a program wrote: the app's own widgets (up next, updates,
  // following) are gone. 'builtin' stays allowed by the CHECK; nothing writes it any more.
  `
  DELETE FROM home_widgets WHERE source = 'builtin';
  `,
  // The introduction that opens a new user's first chat: one row, from the greeting until it ends.
  `
  CREATE TABLE introduction (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    conversation_id TEXT NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT
  );
  `,
  // Home is four columns across, and a widget spans one to four of them. Every widget so far was
  // the full width.
  `
  ALTER TABLE home_widgets ADD COLUMN columns INTEGER NOT NULL DEFAULT 4 CHECK (columns BETWEEN 1 AND 4);
  `,
  // The brief's own headline and weather are retired (the user found them ugly): their rows go,
  // kept places included, and nothing writes those types again.
  `
  DELETE FROM home_widgets WHERE json_extract(body, '$.type') IN ('headline', 'weather');
  `,
  // The run redesigning a widget for the width the user picked on Home; the app shows it as
  // "resizing" while that run is going.
  `
  ALTER TABLE home_widgets ADD COLUMN resize_run_id TEXT;
  `,
  // The skills shipped with Sunnie that the user turned on; the rest stay off.
  `
  CREATE TABLE skill_switches (
    name TEXT PRIMARY KEY,
    enabled_at TEXT NOT NULL
  );
  `,
  // What the user set in a reply's interactive card (a stepper, a checklist); the reply's text is
  // never rewritten. `reported_at`: when Sunnie last heard about it.
  `
  CREATE TABLE card_state (
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    card INTEGER NOT NULL,
    state TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    reported_at TEXT,
    PRIMARY KEY (message_id, card)
  );
  `,
  // What the user set in a Home widget's interactive parts.
  `
  ALTER TABLE home_widgets ADD COLUMN state TEXT;
  `,
];

export type Db = DatabaseSync;

/** `path` may be ':memory:' for tests. */
export function openDatabase(path: string): Db {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      db.exec(MIGRATIONS[v]!);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
