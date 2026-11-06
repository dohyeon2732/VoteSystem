export interface Election {
  id: string; name: string; threshold_pct: number; extension_enabled: boolean; input_locked: boolean; enforce_time_window: boolean;
  result_announced_on: string | null; retention_days: number; purged_at: string | null;
}
export interface ElectionDay { id: string; date: string; is_extension: boolean; sort: number }
export interface District { id: string; name: string; sort: number; base_voters: number }
export interface Station { id: string; district_id: string; name: string; sort: number; open_time: string; close_time: string }
export interface Slot { id: string; station_id: string; day_id: string; time: string; is_close: boolean }
export interface Me { id: string; name: string; role: 'admin' | 'member'; pledged_at?: string | null }
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
  id: string; name: string; role: 'admin' | 'member'; code_version: number; active: boolean; created_at: string; last_login_at: string | null;
  pledged_at: string | null;
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
}
export interface Tally {
  election: Election; points: TallyPoint[]; pending_requests: number; server_now: string;
  roster: { roster_active: boolean; stations: RosterStation[] };
}

// ---- 선거인명부 (v1.1) ----
export type VoterKind = 'regular' | 'associate';
export interface Shift { id: string; member_id: string; station_id: string; date: string; start_time: string; end_time: string }
export interface RosterMe {
  pledged_at: string | null; role: 'admin' | 'member'; shift: Shift | null; today_shifts: Shift[];
  roster_ready: boolean; uploading: boolean; purged: boolean; server_now: string;
}
export type LookupResult =
  | { result: 'not_found' }
  | { result: 'other_district'; district_name: string; station_names: string[] }
  | { result: 'voted'; voter_id: string; name: string; dept: string; kind: VoterKind; voted_at: string; voted_station_name: string }
  | { result: 'ok'; voter_id: string; name: string; dept: string; kind: VoterKind };
export interface TallyWindow {
  id: string; station_id: string; date: string; opened_at: string; boundary_at: string; status: 'reconciling' | 'matched' | 'adjusted';
  check_count: number; leave_count: number; tag_count: number | null; accepted_count: number | null; adjustment: number; adjust_reason: string | null;
  closed_by_name: string; matched_at: string | null; matched_by_name: string | null; net?: number; leave_net?: number;
}
export interface StationStatus {
  station: Station; shift: Shift | null; open_count: number; open_leave: number;
  reconciling: (TallyWindow & { net: number; leave_net: number }) | null; last_window: TallyWindow | null;
  recent: { id: string; at: string; is_leave: boolean; canceled: boolean; source: string }[]; server_now: string;
}
export interface RosterSummary {
  counts: { district_id: string; kind: VoterKind; total: number; voted: number }[]; event_count: number;
  uploading: { id: string; kind: VoterKind; at: string; by: string } | null; last_backup_at: string | null; closes_since_backup: number;
  result_announced_on: string | null; retention_days: number; purged_at: string | null; purge_available_from: string | null; purge_available: boolean;
  keys_configured: boolean;
}
export interface AccessLogRow {
  id: string; at: string; member_id: string; member_name: string; station_id: string | null; action: string; sid_hash8: string | null; result: string | null; note: string | null;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public extra?: any) { super(message); }
}

export async function api<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch('/api' + path, {
    method: init?.method ?? (init?.body !== undefined ? 'POST' : 'GET'),
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new ApiError(res.status, data?.error ?? 'error', data?.message ?? `오류 (${res.status})`, data?.extra);
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
