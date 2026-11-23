import { isSilent, trackEnd, trackStart } from '../app/loading';

export interface Election {
  id: string; name: string; threshold_pct: number; extension_enabled: boolean; input_locked: boolean; enforce_time_window: boolean;
  result_announced_on: string | null; retention_days: number; purged_at: string | null;
}
export interface ElectionDay { id: string; date: string; is_extension: boolean; sort: number }
export interface District { id: string; name: string; sort: number; base_voters: number }
export interface Station { id: string; district_id: string; name: string; sort: number; open_time: string; close_time: string }
export interface Slot { id: string; station_id: string; day_id: string; time: string; is_close: boolean }
/** admin = 총관리자, member = 선관위원, station = 투표소 공용 계정 (v1.2) */
export type Role = 'admin' | 'member' | 'station';
export interface DeviceInfo {
  id: string; device_no: number; operator_name: string | null; operator_since: string | null; operator_pledged: boolean;
  created_at: string; expires_at: string; desk_id?: string | null;
}
export interface Me { id: string; name: string; role: Role; pledged_at?: string | null; station_id?: string | null; device?: DeviceInfo | null }
export interface Config { election: Election; days: ElectionDay[]; districts: District[]; stations: Station[]; slots: Slot[]; roster_active: boolean; server_now: string }
export interface Entry {
  id: string; station_id: string; slot_id: string; cumulative: number; leave_cumulative: number;
  entered_by: string; entered_by_name: string; entered_at: string; confirmed: boolean; confirmed_by: string | null; confirmed_at: string | null;
}
export interface ChangeRequest {
  id: string; entry_id: string; new_cumulative: number; new_leave_cumulative: number; reason: string;
  requested_by: string; requested_by_name: string; requested_at: string; status: 'pending' | 'approved' | 'rejected';
  decided_by_name: string | null; decided_at: string | null; decision_note: string | null; entry: Entry | null;
}
export interface MemberRow {
  id: string; name: string; role: Role; code_version: number; active: boolean; created_at: string; last_login_at: string | null;
  pledged_at: string | null; station_id?: string | null; locked_until?: string | null;
}
export interface AuditLog {
  id: string; at: string; actor_id: string; actor_name: string; action: string; station_id: string | null; slot_id: string | null;
  before_json: string | null; after_json: string | null; note: string | null;
}
export interface StationPoint {
  station_id: string; cumulative: number; leave_cumulative: number; has_slot: boolean; entered: boolean; confirmed: boolean;
  entry_id: string | null; last_entry_at: string | null; last_entry_by: string | null; carried_from: string | null;
}
export interface DistrictPoint {
  district_id: string; name: string; base_voters: number; voters: number; cumulative: number; leave_cumulative: number; pct: number;
  delta: number; missing: number; last_entry_at: string | null; last_entry_by: string | null; stations: StationPoint[];
}
export interface TallyPoint {
  date: string; time: string; epoch: number;
  total: { base_voters: number; voters: number; cumulative: number; leave_cumulative: number; pct: number; delta: number; missing: number };
  districts: DistrictPoint[];
}
export interface RosterStation {
  station_id: string; live: number; live_leave: number; open: number; reconciled: number; reconciled_leave: number;
  last_boundary_at: string | null; reconciling: boolean; warning: string | null;
  /** 창구별 내역 (v1.4) */
  desks?: { desk_id: string; name: string; is_unassigned: boolean; live: number; open: number; reconciled: number; last_boundary_at: string | null; reconciling: boolean; warning: string | null }[];
}
export interface Tally {
  election: Election; points: TallyPoint[]; pending_requests: number; server_now: string;
  roster: { roster_active: boolean; stations: RosterStation[]; live_series?: { date: string; time: string; cumulative: number; leave_cumulative: number }[] };
}

// ---- 선거인명부 (v1.1) ----
export type VoterKind = 'regular' | 'associate';
/** 투표소 운영시간 안인지 (FR-93) */
export interface StationHours { allowed: boolean; label: string; message: string | null }
export interface RosterMe {
  pledged_at: string | null; role: Role; station: Station | null; device: DeviceInfo | null; desk?: DeskInfo | null; hours: StationHours | null;
  roster_ready: boolean; uploading: boolean; purged: boolean; server_now: string;
}
export type LookupResult =
  | { result: 'not_found' }
  | { result: 'other_district'; district_name: string; station_names: string[] }
  | { result: 'voted'; voter_id: string; name: string; dept: string; kind: VoterKind; voted_at: string; voted_station_name: string }
  | { result: 'ok'; voter_id: string; name: string; dept: string; kind: VoterKind; desk_warning?: { dept: string; desk_name: string | null } };
export interface TallyWindow {
  id: string; station_id: string; date: string; opened_at: string; boundary_at: string; status: 'reconciling' | 'matched' | 'adjusted';
  check_count: number; leave_count: number; tag_count: number | null; accepted_count: number | null; adjustment: number; adjust_reason: string | null;
  closed_by_name: string; matched_at: string | null; matched_by_name: string | null; net?: number; leave_net?: number;
  desk_id?: string | null; desk_name?: string | null; tag_total?: number | null; issue_count?: number;
}
export interface StationStatus {
  station: Station; hours: StationHours; open_count: number; open_leave: number; total_count: number; total_leave: number;
  reconciling: (TallyWindow & { net: number; leave_net: number }) | null; last_window: TallyWindow | null;
  recent: { id: string; at: string; is_leave: boolean; canceled: boolean; source: string }[]; server_now: string;
  desk: DeskInfo; desks: DeskInfo[]; issue_count: number;
  window_issues: { id: string; type: IssueType; count: number; serial_from: number | null; serial_to: number | null; note: string | null }[];
}
export interface RosterSummary {
  counts: { district_id: string; kind: VoterKind; total: number; voted: number }[]; event_count: number;
  uploading: { id: string; kind: VoterKind; at: string; by: string } | null; last_backup_at: string | null; closes_since_backup: number;
  result_announced_on: string | null; retention_days: number; purged_at: string | null; purge_available_from: string | null; purge_available: boolean;
  keys_configured: boolean;
}
export interface AccessLogRow {
  id: string; at: string; member_id: string; member_name: string; station_id: string | null; action: string; sid_hash8: string | null; result: string | null; note: string | null;
  operator_name?: string | null;
}
// ---- 투표소 계정·기기 (v1.2) ----
export interface DeviceRow {
  id: string; member_id: string; station_id: string; device_no: number; created_at: string; expires_at: string; last_seen_at: string;
  operator_name: string | null; operator_since: string | null; revoked_at: string | null; user_agent: string | null;
  status: 'active' | 'expired' | 'revoked'; history: { operator_name: string; started_at: string }[];
}
export interface StationAccounts {
  stations: { station: Station; accounts: MemberRow[]; devices: DeviceRow[] }[]; server_now: string;
}
export const roleLabel = (r: Role | undefined) => (r === 'admin' ? '총관리자' : r === 'station' ? '투표소' : '선관위원');

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: any) { super(message); }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown; silent?: boolean }): Promise<T> {
  // 화면 가운데 로딩 표시 (배경 자동 갱신은 runSilently로 제외)
  const silent = init?.silent || isSilent();
  if (!silent) trackStart();
  try {
    return await request<T>(path, init);
  } finally {
    if (!silent) trackEnd();
  }
}

async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch('/api' + path, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    // 세션 만료·강제 로그아웃: 다음 요청에서 바로 로그인 화면으로 (FR-94b)
    if (res.status === 401 && path !== '/login' && path !== '/me') window.dispatchEvent(new Event('auth:expired'));
    throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `오류 (${res.status})`, data?.extra);
  }
  return data as T;
}

// ---- formatting ----
export const fmtNum = (n: number) => n.toLocaleString('ko-KR');
export const fmtPct = (n: number) => `${n.toFixed(2)}%`;
const WD = ['일', '월', '화', '수', '목', '금', '토'];
export function weekday(date: string): string {
  return WD[new Date(Date.parse(`${date}T12:00:00+09:00`) + 9 * 3600 * 1000).getUTCDay()];
}
export const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}(${weekday(date)})`;
export const noticeDate = (date: string, time: string) => `${date.replace(/-/g, '.')}.(${weekday(date)}) ${time} 기준`;
export const pointLabel = (p: { date: string; time: string }) => `${shortDate(p.date)} ${p.time}`;
export const slotEpoch = (date: string, time: string) => Date.parse(`${date}T${time}:00+09:00`);
export function fmtTime(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
}
export const fmtHM = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false }) : '');
export const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
export const remainingToThreshold = (voters: number, cumulative: number, thresholdPct: number) =>
  Math.max(0, Math.ceil((voters * thresholdPct) / 100) - cumulative);

// ---- 창구·묶음·이슈 (v1.4) ----
export interface DeskInfo { id: string; station_id: string; name: string; depts: string[]; is_all: boolean; is_unassigned: boolean; merged_into?: string | null }
export interface DeskList { desks: (DeskInfo & { device_count: number })[]; depts: { name: string; desk_id: string | null }[] }
export type IssueType = 'void' | 'lost' | 'damaged' | 'unreadable' | 'pad_defect' | 'other';
export const ISSUE_TYPES: Record<IssueType, string> = {
  void: '폐기 용지', lost: '꼬리표 분실', damaged: '꼬리표 훼손', unreadable: '번호 판독 불가', pad_defect: '묶음 이상', other: '기타',
};
/** 새로 신고할 때 고르는 유형 (v1.5). 번호 판독 불가·묶음 이상은 예전 기록 표시용으로만 남긴다 */
export const ISSUE_CHOICES: IssueType[] = ['void', 'lost', 'damaged', 'other'];
export interface TagIssueRow {
  id: string; station_id: string; desk_id: string | null; window_id: string | null; pad_id: string | null; type: IssueType;
  serial_from: number | null; serial_to: number | null; count: number; note: string | null; operator_name: string; at: string;
  reviewed_by: string | null; reviewed_at: string | null; voided_by: string | null; voided_at: string | null; void_reason: string | null;
  desk_name: string | null; pad_label: string | null;
}
export const fmtNo = (n: number) => String(n).padStart(6, '0');
/** 학과 아래 전공이 있으면 "학과 > 전공"으로 저장된다. 화면에는 "학과 전공"으로 보여 준다. */
export const DEPT_SEP = ' > ';
export const deptLabel = (s: string) => s.split(DEPT_SEP).join(' ');
