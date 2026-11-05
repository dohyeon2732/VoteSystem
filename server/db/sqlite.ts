import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db, Where } from './types.js';
import { BOOL_COLUMNS } from './types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS election (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, threshold_pct REAL NOT NULL DEFAULT 50,
  extension_enabled INTEGER NOT NULL DEFAULT 0, input_locked INTEGER NOT NULL DEFAULT 0,
  enforce_time_window INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS election_day (
  id TEXT PRIMARY KEY, date TEXT NOT NULL UNIQUE, is_extension INTEGER NOT NULL DEFAULT 0, sort INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS district (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, sort INTEGER NOT NULL, base_voters INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS station (
  id TEXT PRIMARY KEY, district_id TEXT NOT NULL, name TEXT NOT NULL, sort INTEGER NOT NULL,
  open_time TEXT NOT NULL, close_time TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS slot (
  id TEXT PRIMARY KEY, station_id TEXT NOT NULL, day_id TEXT NOT NULL, time TEXT NOT NULL,
  is_close INTEGER NOT NULL DEFAULT 0, UNIQUE(station_id, day_id, time));
CREATE TABLE IF NOT EXISTS member (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, role TEXT NOT NULL, code_hash TEXT NOT NULL,
  code_version INTEGER NOT NULL DEFAULT 1, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL,
  last_login_at TEXT, failed_count INTEGER NOT NULL DEFAULT 0, locked_until TEXT);
CREATE TABLE IF NOT EXISTS entry (
  id TEXT PRIMARY KEY, station_id TEXT NOT NULL, slot_id TEXT NOT NULL,
  cumulative INTEGER NOT NULL, leave_cumulative INTEGER NOT NULL,
  entered_by TEXT NOT NULL, entered_by_name TEXT NOT NULL, entered_at TEXT NOT NULL,
  confirmed INTEGER NOT NULL DEFAULT 0, confirmed_by TEXT, confirmed_at TEXT, UNIQUE(station_id, slot_id));
CREATE TABLE IF NOT EXISTS change_request (
  id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, new_cumulative INTEGER NOT NULL, new_leave_cumulative INTEGER NOT NULL,
  reason TEXT NOT NULL, requested_by TEXT NOT NULL, requested_by_name TEXT NOT NULL, requested_at TEXT NOT NULL,
  status TEXT NOT NULL, decided_by TEXT, decided_by_name TEXT, decided_at TEXT, decision_note TEXT);
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, action TEXT NOT NULL,
  station_id TEXT, slot_id TEXT, before_json TEXT, after_json TEXT, note TEXT);
`;

export function createSqliteDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);

  const bools = (table: string) => BOOL_COLUMNS[table] ?? [];
  const toRow = (table: string, obj: Record<string, unknown>) => {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    return out;
  };
  const fromRow = <T>(table: string, row: Record<string, unknown> | undefined): T | null => {
    if (!row) return null;
    const out: Record<string, unknown> = { ...row };
    for (const b of bools(table)) if (b in out) out[b] = !!out[b];
    return out as T;
  };
  const whereSql = (where?: Where) => {
    const keys = Object.keys(where ?? {});
    if (keys.length === 0) return { sql: '', params: [] as unknown[] };
    const parts = keys.map((k) => ((where as Where)[k] === null ? `${k} IS NULL` : `${k} = ?`));
    const params = keys.filter((k) => (where as Where)[k] !== null).map((k) => {
      const v = (where as Where)[k];
      return typeof v === 'boolean' ? (v ? 1 : 0) : v;
    });
    return { sql: ' WHERE ' + parts.join(' AND '), params };
  };

  return {
    async all<T>(table: string, where?: Where, orderBy?: string) {
      const w = whereSql(where);
      const rows = db.prepare(`SELECT * FROM ${table}${w.sql}${orderBy ? ' ORDER BY ' + orderBy : ''}`).all(...(w.params as any[]));
      return rows.map((r) => fromRow<T>(table, r as Record<string, unknown>) as T);
    },
    async get<T>(table: string, where: Where) {
      const w = whereSql(where);
      const row = db.prepare(`SELECT * FROM ${table}${w.sql} LIMIT 1`).get(...(w.params as any[]));
      return fromRow<T>(table, row as Record<string, unknown> | undefined);
    },
    async insert(table, row) {
      const r = toRow(table, row as Record<string, unknown>);
      const keys = Object.keys(r);
      db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(keys.map((k) => r[k]) as any[]));
      return row;
    },
    async update(table, where, patch) {
      const p = toRow(table, patch);
      const keys = Object.keys(p);
      if (keys.length === 0) return;
      const w = whereSql(where);
      db.prepare(`UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')}${w.sql}`).run(...([...keys.map((k) => p[k]), ...w.params] as any[]));
    },
    async remove(table, where) {
      const w = whereSql(where);
      db.prepare(`DELETE FROM ${table}${w.sql}`).run(...(w.params as any[]));
    },
    async insertMany(table, rows) {
      if (!rows.length) return;
      db.exec('BEGIN');
      try {
        for (const row of rows) {
          const r = toRow(table, row as Record<string, unknown>);
          const keys = Object.keys(r);
          db.prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`).run(...(Object.values(r) as any[]));
        }
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    async removeIds(table, ids) {
      for (let i = 0; i < ids.length; i += 500) {
        const chunk = ids.slice(i, i + 500);
        db.prepare(`DELETE FROM ${table} WHERE id IN (${chunk.map(() => '?').join(',')})`).run(...chunk);
      }
    },
    async removeAll(table) {
      db.prepare(`DELETE FROM ${table}`).run();
    },
  };
}
