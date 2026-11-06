export type Scalar = string | number | boolean | null;
export type Where = Record<string, Scalar>;

export interface Db {
  /** limit을 주지 않으면 모든 행을 돌려준다 (Supabase는 1,000행씩 나눠 읽음). */
  all<T>(table: string, where?: Where, orderBy?: string, limit?: number): Promise<T[]>;
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
  /** 조건에 맞는 행 수. */
  count(table: string, where?: Where): Promise<number>;
  /** column 값이 values 중 하나인 행. */
  allIn<T>(table: string, column: string, values: string[], where?: Where): Promise<T[]>;
  /** 선거인명부 체크 관련 원자 연산 (Supabase는 Postgres 함수, 로컬은 SQLite 트랜잭션). */
  votes: VoteOps;
}

export interface IssueInput {
  event_id: string; voter_id: string; sid_hash: string; station_id: string; at: string;
  actor_id: string; actor_name: string; source: BallotSource; window_id: string | null; reason: string | null;
}
export type IssueResult = { ok: true; is_leave: boolean } | { ok: false; voted_at: string | null; voted_station_id: string | null };
export interface CancelInput { cancel_id: string; issue_id: string; at: string; actor_id: string; actor_name: string; reason: string }
export interface StationCounts { station_id: string; net: number; leave_net: number; open_net: number; open_leave_net: number }
export interface RosterCount { district_id: string; kind: VoterKind; total: number; voted: number }

export interface VoteOps {
  /** 아직 투표하지 않은 경우에만 투표 처리하고 불출 기록을 남긴다. */
  issue(input: IssueInput): Promise<IssueResult>;
  /** 불출 기록을 취소 기록으로 상쇄하고 투표 상태를 푼다. 실패 시 이유 문자열. */
  cancel(input: CancelInput): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 열린 체크(구간 미배정)를 경계 시각까지 window에 배정한다. */
  assignWindow(stationId: string, windowId: string, boundaryAt: string): Promise<void>;
  /** 구간의 순 체크 인원(불출 − 취소)과 그중 준회원. */
  windowCounts(windowId: string): Promise<{ net: number; leave_net: number }>;
  /** 투표소별 실시간 집계. */
  liveCounts(): Promise<StationCounts[]>;
  /** 선거구 × 종류별 명부 인원과 투표 인원. */
  rosterCounts(): Promise<RosterCount[]>;
  /** 체크 기록·마감을 모두 지우고 투표 상태를 해제 (리허설용). */
  resetChecks(): Promise<void>;
  /** 체크 기록으로 선거인 투표 상태를 다시 맞춘다 (백업 복원 후). */
  rebuildVoterState(): Promise<number>;
  /** 명부·체크 기록 파기. */
  purge(): Promise<void>;
}

/** Boolean columns per table — SQLite stores them as 0/1, Supabase as boolean. */
export const BOOL_COLUMNS: Record<string, string[]> = {
  election: ['extension_enabled', 'input_locked', 'enforce_time_window'],
  election_day: ['is_extension'],
  slot: ['is_close'],
  member: ['active'],
  entry: ['confirmed'],
  ballot_event: ['is_leave'],
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
  'voter',
  'ballot_event',
  'tally_window',
  'shift',
  'voter_access_log',
] as const;

// ---- Row types ----
export interface Election {
  id: string;
  name: string;
  threshold_pct: number;
  extension_enabled: boolean;
  input_locked: boolean;
  enforce_time_window: boolean;
  /** 결과 공고일 (YYYY-MM-DD). 파기 가능 시점 계산용 */
  result_announced_on: string | null;
  retention_days: number;
  purged_at: string | null;
  /** 진행 중인 명부 업로드 (JSON: {id, kind, at}) */
  roster_upload: string | null;
  last_backup_at: string | null;
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
  pledged_at?: string | null; // v1.1 열. 마이그레이션 전 DB에도 위원을 추가할 수 있게 insert에서는 생략
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

// ---- 선거인명부 (v1.1) ----
export type VoterKind = 'regular' | 'associate';
export type BallotSource = 'live' | 'missed' | 'sheet' | 'restore';
export interface Voter {
  id: string; sid_hash: string; name_enc: string; dept_enc: string; district_id: string; kind: VoterKind;
  voted_at: string | null; voted_station_id: string | null; voted_event_id: string | null;
  batch_id: string | null; source: 'upload' | 'manual'; created_at: string;
}
export interface BallotEvent {
  id: string; voter_id: string; voter_sid_hash: string; station_id: string; kind: 'issue' | 'cancel'; ref_event_id: string | null;
  is_leave: boolean; at: string; actor_id: string; actor_name: string; window_id: string | null; source: BallotSource; reason: string | null;
}
export interface TallyWindow {
  id: string; station_id: string; date: string; opened_at: string; boundary_at: string;
  status: 'reconciling' | 'matched' | 'adjusted';
  check_count: number; leave_count: number; tag_count: number | null; accepted_count: number | null;
  adjustment: number; adjust_reason: string | null;
  closed_by: string; closed_by_name: string; matched_at: string | null; matched_by_name: string | null;
}
export interface Shift { id: string; member_id: string; station_id: string; date: string; start_time: string; end_time: string }
export interface VoterAccessLog {
  id: string; at: string; member_id: string; member_name: string; station_id: string | null;
  action: string; sid_hash8: string | null; result: string | null; note: string | null;
}
