import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const DATA_DIR = process.env.DATA_DIR || 'data';
const DB_PATH = join(DATA_DIR, 'assistant.db');
mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    message TEXT NOT NULL,
    fire_at TEXT NOT NULL,
    fired INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_reminders_due
    ON reminders (fired, fire_at);
`);

// --- Tasks ---
export const addTask = (title) =>
  db.prepare('INSERT INTO tasks (title) VALUES (?) RETURNING id, title').get(title);

export const listTasks = ({ includeDone = false } = {}) =>
  db
    .prepare(
      `SELECT id, title, done FROM tasks ${includeDone ? '' : 'WHERE done = 0'} ORDER BY id`
    )
    .all();

export const completeTask = (id) =>
  db.prepare('UPDATE tasks SET done = 1 WHERE id = ? RETURNING id, title').get(id);

export const deleteTask = (id) =>
  db.prepare('DELETE FROM tasks WHERE id = ? RETURNING id, title').get(id);

// --- Reminders ---
// fire_at is stored as an ISO 8601 UTC string so lexicographic comparison works.
export const addReminder = ({ userId, message, fireAt }) =>
  db
    .prepare(
      'INSERT INTO reminders (user_id, message, fire_at) VALUES (?, ?, ?) RETURNING id, user_id, message, fire_at'
    )
    .get(userId, message, fireAt);

export const listReminders = ({ userId, includeFired = false } = {}) => {
  const clauses = [];
  const params = [];
  if (userId) {
    clauses.push('user_id = ?');
    params.push(userId);
  }
  if (!includeFired) clauses.push('fired = 0');
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT id, user_id, message, fire_at, fired FROM reminders ${where} ORDER BY fire_at`
    )
    .all(...params);
};

export const getDueReminders = (nowIso) =>
  db
    .prepare(
      'SELECT id, user_id, message, fire_at FROM reminders WHERE fired = 0 AND fire_at <= ? ORDER BY fire_at'
    )
    .all(nowIso);

export const markReminderFired = (id) =>
  db.prepare('UPDATE reminders SET fired = 1 WHERE id = ?').run(id);

export const deleteReminder = (id) =>
  db
    .prepare('DELETE FROM reminders WHERE id = ? RETURNING id, message, fire_at')
    .get(id);

// --- Key/value (Google tokens, etc.) ---
export const kvGet = (key) => {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
};

export const kvSet = (key, value) => {
  db.prepare(
    'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, JSON.stringify(value));
};

export default db;
