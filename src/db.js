/**
 * SQLite 数据层。better-sqlite3 是同步 API，对这个规模（几个人、几万条消息）
 * 来说是最简单也最快的选择，不需要连接池，也不会有一致性问题。
 */
import Database from 'better-sqlite3';
import { randomBytes } from 'node:crypto';
import { config, ensureDirs } from './config.js';

ensureDirs();

export const db = new Database(config.dbFile);

// WAL 让读写并发不打架；foreign_keys 让级联删除真的生效
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name  TEXT    NOT NULL,
  email         TEXT,
  password_hash TEXT    NOT NULL,
  avatar_file_id TEXT,
  about         TEXT,
  is_admin      INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  user_agent TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS conversations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  type            TEXT    NOT NULL CHECK (type IN ('dm','group')),
  title           TEXT,
  avatar_file_id  TEXT,
  created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at      INTEGER NOT NULL,
  last_message_at INTEGER NOT NULL DEFAULT 0,
  dm_key          TEXT    UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_conv_recent ON conversations(last_message_at DESC);

CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id      INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id              INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role                 TEXT    NOT NULL DEFAULT 'member',
  joined_at            INTEGER NOT NULL,
  last_read_message_id INTEGER NOT NULL DEFAULT 0,
  muted                INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_cm_user ON conversation_members(user_id);

CREATE TABLE IF NOT EXISTS files (
  id         TEXT    PRIMARY KEY,
  owner_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  name       TEXT    NOT NULL,
  mime       TEXT    NOT NULL,
  size       INTEGER NOT NULL,
  sha256     TEXT,
  kind       TEXT    NOT NULL,
  path       TEXT    NOT NULL,
  width      INTEGER,
  height     INTEGER,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_files_owner ON files(owner_id);

CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  kind            TEXT    NOT NULL CHECK (kind IN ('text','image','audio','video','file','system')),
  body            TEXT,
  file_id         TEXT,
  reply_to        INTEGER,
  meta            TEXT,
  created_at      INTEGER NOT NULL,
  edited_at       INTEGER,
  deleted_at      INTEGER,
  deleted_by      INTEGER
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, id DESC);

CREATE TABLE IF NOT EXISTS contacts (
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  alias      TEXT,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, user_id)
);

CREATE TABLE IF NOT EXISTS uploads (
  id         TEXT    PRIMARY KEY,
  owner_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  mime       TEXT    NOT NULL,
  size       INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  chunk_size INTEGER NOT NULL,
  total      INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_uploads_owner ON uploads(owner_id);

/* 用户对自己隐藏的会话（软删除），对方不受影响 */
CREATE TABLE IF NOT EXISTS conversation_hidden (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hidden_before   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (conversation_id, user_id)
);

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

db.exec(SCHEMA);

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

export const now = () => Date.now();

/** 生成 URL 安全、不可猜测的文件 id */
export const newFileId = () => randomBytes(16).toString('hex');

export const getMeta = (key, dflt = null) => {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : dflt;
};
export const setMeta = (key, value) => {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
};

/** 判断是否还没有任何用户（用于第一个注册者成为管理员） */
export const isFirstRun = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0;

/** 两用户之间的 DM 唯一键，保证同一对人只有一个会话 */
export const dmKey = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** JSON 字段安全解析 */
export function parseJSON(text, dflt = null) {
  if (!text) return dflt;
  try {
    return JSON.parse(text);
  } catch {
    return dflt;
  }
}

/* ------------------------------------------------------------------ */
/* 常用查询                                                            */
/* ------------------------------------------------------------------ */

export const userById = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
export const userByUsername = (username) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(username);

export const fileById = (id) => (id ? db.prepare('SELECT * FROM files WHERE id = ?').get(id) : null);
export const conversationById = (id) =>
  db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);

export const isMember = (conversationId, userId) =>
  !!db
    .prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?')
    .get(conversationId, userId);

export const memberIds = (conversationId) =>
  db
    .prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?')
    .all(conversationId)
    .map((r) => r.user_id);

export function addMember(conversationId, userId, role = 'member') {
  db.prepare(
    `INSERT INTO conversation_members (conversation_id, user_id, role, joined_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(conversation_id, user_id) DO NOTHING`,
  ).run(conversationId, userId, role, now());
}

/**
 * 找到（或创建）两人之间的私聊会话。
 * @returns {{conversation: object, created: boolean}}
 */
export const findOrCreateDM = db.transaction((a, b) => {
  const key = dmKey(a, b);
  const existing = db.prepare('SELECT * FROM conversations WHERE dm_key = ?').get(key);
  if (existing) return { conversation: existing, created: false };
  const t = now();
  const info = db
    .prepare(
      `INSERT INTO conversations (type, created_by, created_at, last_message_at, dm_key)
       VALUES ('dm', ?, ?, ?, ?)`,
    )
    .run(a, t, t, key);
  const id = info.lastInsertRowid;
  addMember(id, a);
  addMember(id, b);
  return { conversation: conversationById(id), created: true };
});

/* ------------------------------------------------------------------ */
/* 优雅退出                                                            */
/* ------------------------------------------------------------------ */

let closed = false;
export function closeDb() {
  if (closed) return;
  closed = true;
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  } catch {
    /* 退出路径上不值得再抛错 */
  }
}
