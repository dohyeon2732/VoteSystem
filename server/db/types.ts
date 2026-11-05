export type Scalar = string | number | boolean | null;
export type Where = Record<string, Scalar>;

export interface Db {
  all<T>(table: string, where?: Where, orderBy?: string): Promise<T[]>;
  get<T>(table: string, where: Where): Promise<T | null>;
  insert<T extends object>(table: string, row: T): Promise<T>;
  update(table: string, where: Where, patch: Record<string, unknown>): Promise<void>;
  remove(table: string, where: Where): Promise<void>;
  /** 여러 행을 한 번에 넣는다. */
  insertMany<T extends object>(table: string, rows: T[]): Promise<void>;
  /** id 목록에 해당하는 행을 한 번에 지운다. */
  removeIds(table: string, ids: string[]): Promise<void>;
  /** 테이블의 모든 행을 지운다. */
  removeAll(table: string): Promise<void>;
}

/** Boolean columns per table — SQLite stores them as 0/1, Supabase as boolean. */
export const BOOL_COLUMNS: Record<string, string[]> = {
  election: ['extension_enabled', 'input_locked', 'enforce_time_window'],
  election_day: ['is_extension'],
  slot: ['is_close'],
  member: ['active'],
  entry: ['confirmed'],
};

export const TABLES = [
  'election',
  'election_day',
  'district',
  'station',
  'slot',
  'member',
  'entry',
  'change_request',
  'audit_log',
] as const;

// ---- Row types ----
export interface Election {
  id: string;
  name: string;
  threshold_pct: number;
  extension_enabled: boolean;
  input_locked: boolean;
  enforce_time_window: boolean;
}
export interface ElectionDay { id: string; date: string; is_extension: boolean; sort: number }
export interface District { id: string; name: string; sort: number; base_voters: number }
export interface Station {
  id: string; district_id: string; name: string; sort: number; open_time: string; close_time: string;
}
export interface Slot { id: string; station_id: string; day_id: string; time: string; is_close: boolean }
export interface Member {
  id: string; name: string; role: 'admin' | 'member'; code_hash: string; code_version: number;
  active: boolean; created_at: string; last_login_at: string | null; failed_count: number; locked_until: string | null;
}
export interface Entry {
  id: string; station_id: string; slot_id: string; cumulative: number; leave_cumulative: number;
  entered_by: string; entered_by_name: string; entered_at: string;
  confirmed: boolean; confirmed_by: string | null; confirmed_at: string | null;
}
export interface ChangeRequest {
  id: string; entry_id: string; new_cumulative: number; new_leave_cumulative: number; reason: string;
  requested_by: string; requested_by_name: string; requested_at: string;
  status: 'pending' | 'approved' | 'rejected';
  decided_by: string | null; decided_by_name: string | null; decided_at: string | null; decision_note: string | null;
}
export interface AuditLog {
  id: string; at: string; actor_id: string; actor_name: string; action: string;
  station_id: string | null; slot_id: string | null; before_json: string | null; after_json: string | null; note: string | null;
}
