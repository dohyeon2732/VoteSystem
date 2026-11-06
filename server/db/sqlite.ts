import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Db, StationCounts, RosterCount, VoteOps, Where } from './types.js';
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
CREATE TABLE IF NOT EXISTS voter (
  id TEXT PRIMARY KEY, sid_hash TEXT NOT NULL UNIQUE, name_enc TEXT NOT NULL, dept_enc TEXT NOT NULL,
  district_id TEXT NOT NULL, kind TEXT NOT NULL, voted_at TEXT, voted_station_id TEXT, voted_event_id TEXT,
  batch_id TEXT, source TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS voter_batch_idx ON voter(batch_id);
CREATE TABLE IF NOT EXISTS ballot_event (
  id TEXT PRIMARY KEY, voter_id TEXT NOT NULL, voter_sid_hash TEXT NOT NULL, station_id TEXT NOT NULL,
  kind TEXT NOT NULL, ref_event_id TEXT, is_leave INTEGER NOT NULL, at TEXT NOT NULL,
  actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, window_id TEXT, source TEXT NOT NULL, reason TEXT);
CREATE INDEX IF NOT EXISTS ballot_event_station_idx ON ballot_event(station_id, window_id);
CREATE INDEX IF NOT EXISTS ballot_event_ref_idx ON ballot_event(ref_event_id);
CREATE TABLE IF NOT EXISTS tally_window (
  id TEXT PRIMARY KEY, station_id TEXT NOT NULL, date TEXT NOT NULL, opened_at TEXT NOT NULL, boundary_at TEXT NOT NULL,
  status TEXT NOT NULL, check_count INTEGER NOT NULL, leave_count INTEGER NOT NULL, tag_count INTEGER, accepted_count INTEGER,
  adjustment INTEGER NOT NULL DEFAULT 0, adjust_reason TEXT, closed_by TEXT NOT NULL, closed_by_name TEXT NOT NULL,
  matched_at TEXT, matched_by_name TEXT);
CREATE TABLE IF NOT EXISTS shift (
  id TEXT PRIMARY KEY, member_id TEXT NOT NULL, station_id TEXT NOT NULL, date TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS voter_access_log (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, member_id TEXT NOT NULL, member_name TEXT NOT NULL, station_id TEXT,
  action TEXT NOT NULL, sid_hash8 TEXT, result TEXT, note TEXT);
`;

/** v1.0 로컬 DB에 v1.1 열을 더한다. */
const ADD_COLUMNS: [string, string, string][] = [
  ['election', 'result_announced_on', 'TEXT'],
  ['election', 'retention_days', 'INTEGER NOT NULL DEFAULT 7'],
  ['election', 'purged_at', 'TEXT'],
  ['election', 'roster_upload', 'TEXT'],
  ['election', 'last_backup_at', 'TEXT'],
  ['member', 'pledged_at', 'TEXT'],
];

export function createSqliteDb(path: string): Db {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  for (const [table, col, type] of ADD_COLUMNS) {
    const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  const tx = <T>(fn: () => T): T => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const one = (sql: string, ...p: unknown[]) => db.prepare(sql).get(...(p as any[])) as Record<string, any> | undefined;
  const run = (sql: string, ...p: unknown[]) => db.prepare(sql).run(...(p as any[]));
  const NET = `CASE WHEN kind = 'issue' THEN 1 ELSE -1 END`;

  const votes: VoteOps = {
    async issue(i) {
      return tx(() => {
        const v = one('SELECT kind, voted_at, voted_station_id, batch_id FROM voter WHERE id = ?', i.voter_id);
        if (!v || v.voted_at || v.batch_id) return { ok: false as const, voted_at: v?.voted_at ?? null, voted_station_id: v?.voted_station_id ?? null };
        run('UPDATE voter SET voted_at = ?, voted_station_id = ?, voted_event_id = ? WHERE id = ?', i.at, i.station_id, i.event_id, i.voter_id);
        const isLeave = v.kind === 'associate';
        run(`INSERT INTO ballot_event (id, voter_id, voter_sid_hash, station_id, kind, ref_event_id, is_leave, at, actor_id, actor_name, window_id, source, reason)
             VALUES (?, ?, ?, ?, 'issue', NULL, ?, ?, ?, ?, ?, ?, ?)`,
          i.event_id, i.voter_id, i.sid_hash, i.station_id, isLeave ? 1 : 0, i.at, i.actor_id, i.actor_name, i.window_id, i.source, i.reason);
        return { ok: true as const, is_leave: isLeave };
      });
    },
    async cancel(c) {
      return tx(() => {
        const e = one(`SELECT * FROM ballot_event WHERE id = ? AND kind = 'issue'`, c.issue_id);
        if (!e) return { ok: false as const, reason: 'not_found' };
        if (one('SELECT 1 AS x FROM ballot_event WHERE ref_event_id = ?', e.id)) return { ok: false as const, reason: 'already_canceled' };
        if (e.window_id) {
          const w = one('SELECT status FROM tally_window WHERE id = ?', e.window_id);
          if (w?.status !== 'reconciling') return { ok: false as const, reason: 'window_closed' };
        }
        run(`INSERT INTO ballot_event (id, voter_id, voter_sid_hash, station_id, kind, ref_event_id, is_leave, at, actor_id, actor_name, window_id, source, reason)
             VALUES (?, ?, ?, ?, 'cancel', ?, ?, ?, ?, ?, ?, ?, ?)`,
          c.cancel_id, e.voter_id, e.voter_sid_hash, e.station_id, e.id, e.is_leave, c.at, c.actor_id, c.actor_name, e.window_id, e.source, c.reason);
        run('UPDATE voter SET voted_at = NULL, voted_station_id = NULL, voted_event_id = NULL WHERE sid_hash = ? AND voted_event_id = ?', e.voter_sid_hash, e.id);
        return { ok: true as const };
      });
    },
    async assignWindow(stationId, windowId, boundaryAt) {
      tx(() => {
        run(`UPDATE ballot_event SET window_id = ? WHERE station_id = ? AND window_id IS NULL AND kind = 'issue' AND at <= ?`, windowId, stationId, boundaryAt);
        run(`UPDATE ballot_event SET window_id = ? WHERE station_id = ? AND window_id IS NULL AND kind = 'cancel'
             AND ref_event_id IN (SELECT id FROM ballot_event WHERE window_id = ?)`, windowId, stationId, windowId);
      });
    },
    async windowCounts(windowId) {
      const r = one(`SELECT COALESCE(SUM(${NET}), 0) AS net, COALESCE(SUM(CASE WHEN is_leave = 1 THEN ${NET} ELSE 0 END), 0) AS leave_net
                     FROM ballot_event WHERE window_id = ?`, windowId)!;
      return { net: Number(r.net), leave_net: Number(r.leave_net) };
    },
    async liveCounts() {
      return db.prepare(`SELECT station_id, SUM(${NET}) AS net, SUM(CASE WHEN is_leave = 1 THEN ${NET} ELSE 0 END) AS leave_net,
        SUM(CASE WHEN window_id IS NULL THEN ${NET} ELSE 0 END) AS open_net,
        SUM(CASE WHEN window_id IS NULL AND is_leave = 1 THEN ${NET} ELSE 0 END) AS open_leave_net
        FROM ballot_event GROUP BY station_id`).all() as unknown as StationCounts[];
    },
    async rosterCounts() {
      return db.prepare(`SELECT district_id, kind, COUNT(*) AS total, COUNT(voted_at) AS voted FROM voter WHERE batch_id IS NULL GROUP BY district_id, kind`).all() as unknown as RosterCount[];
    },
    async resetChecks() {
      tx(() => {
        run('DELETE FROM ballot_event'); run('DELETE FROM tally_window');
        run('UPDATE voter SET voted_at = NULL, voted_station_id = NULL, voted_event_id = NULL WHERE voted_at IS NOT NULL');
      });
    },
    async rebuildVoterState() {
      return tx(() => {
        run('UPDATE voter SET voted_at = NULL, voted_station_id = NULL, voted_event_id = NULL WHERE voted_at IS NOT NULL');
        const r = run(`UPDATE voter SET (voted_at, voted_station_id, voted_event_id) = (
            SELECT e.at, e.station_id, e.id FROM ballot_event e WHERE e.kind = 'issue' AND e.voter_sid_hash = voter.sid_hash
              AND NOT EXISTS (SELECT 1 FROM ballot_event c WHERE c.ref_event_id = e.id) LIMIT 1)
          WHERE EXISTS (SELECT 1 FROM ballot_event e WHERE e.kind = 'issue' AND e.voter_sid_hash = voter.sid_hash
              AND NOT EXISTS (SELECT 1 FROM ballot_event c WHERE c.ref_event_id = e.id))`);
        return Number(r.changes);
      });
    },
    async purge() {
      tx(() => { run('DELETE FROM ballot_event'); run('DELETE FROM voter'); run('UPDATE voter_access_log SET sid_hash8 = NULL'); });
    },
  };

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
    votes,
    async all<T>(table: string, where?: Where, orderBy?: string, limit?: number) {
      const w = whereSql(where);
      const rows = db.prepare(`SELECT * FROM ${table}${w.sql}${orderBy ? ' ORDER BY ' + orderBy : ''}${limit ? ' LIMIT ' + Math.floor(limit) : ''}`).all(...(w.params as any[]));
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
    async count(table, where) {
      const w = whereSql(where);
      return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}${w.sql}`).get(...(w.params as any[])) as { n: number }).n);
    },
    async allIn<T>(table: string, column: string, values: string[], where?: Where) {
      const out: T[] = [];
      const w = whereSql(where);
      for (let i = 0; i < values.length; i += 500) {
        const chunk = values.slice(i, i + 500);
        if (!chunk.length) continue;
        const sql = `SELECT * FROM ${table}${w.sql ? w.sql + ' AND ' : ' WHERE '}${column} IN (${chunk.map(() => '?').join(',')})`;
        for (const r of db.prepare(sql).all(...([...w.params, ...chunk] as any[]))) out.push(fromRow<T>(table, r as Record<string, unknown>) as T);
      }
      return out;
    },
  };
}
