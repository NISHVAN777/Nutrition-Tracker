// Local storage: everything lives in D:\Nutrition Tracker\data (git-ignored).
// Uses Node's built-in SQLite, so there are no native modules to compile.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// DATA_DIR lets you point the app at another folder (e.g. a demo copy); default is ./data.
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(root, 'data');
export const IMAGE_DIR = path.join(DATA_DIR, 'images');
fs.mkdirSync(IMAGE_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'nutrition.db'));

db.exec(`
  PRAGMA journal_mode = WAL;

  -- Every AI answer is cached by image hash, so the same photo is never paid for twice.
  CREATE TABLE IF NOT EXISTS analysis_cache (
    cache_key   TEXT PRIMARY KEY,
    image_hash  TEXT NOT NULL,
    analysis    TEXT NOT NULL,
    model       TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS meals (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    logged_at   TEXT NOT NULL,
    day         TEXT NOT NULL,
    meal_type   TEXT NOT NULL,
    servings    REAL NOT NULL DEFAULT 1,
    image_hash  TEXT,
    analysis    TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS meals_day ON meals(day);

  -- One row per AI call: the source of truth for the spending caps.
  CREATE TABLE IF NOT EXISTS api_usage (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    at            TEXT NOT NULL DEFAULT (datetime('now')),
    day           TEXT NOT NULL,
    month         TEXT NOT NULL,
    kind          TEXT NOT NULL,
    input_tokens  INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cost_usd      REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS insight_cache (
    cache_key  TEXT PRIMARY KEY,
    insight    TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

export const DEFAULT_GOALS = {
  calories: 2000,
  protein_g: 75,
  carbs_g: 250,
  fat_g: 65,
  fiber_g: 28,
  sugar_g: 50,
  sodium_mg: 2300,
};

export function getGoals() {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('goals');
  return row ? { ...DEFAULT_GOALS, ...JSON.parse(row.value) } : { ...DEFAULT_GOALS };
}

export function setGoals(goals) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run('goals', JSON.stringify(goals));
}

// Local-time day/month keys, so "today" matches the user's clock.
export function dayKey(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export const monthKey = (d = new Date()) => dayKey(d).slice(0, 7);
