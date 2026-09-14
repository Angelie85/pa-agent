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
