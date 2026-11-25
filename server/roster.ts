/**
 * 선거인명부 확인·투표용지 불출·꼬리표 대조 (명세 15절)
 * v1.2: 근무표 대신 투표소 공용 계정 + 기기별 담당자 (15.5)
 */
import { randomUUID } from 'node:crypto';
import {
  HttpError, TIME_RE, cookieHeader, int, loadConfig, log, requireAdmin, requireAuth, route, str, type ApiResponse, type Ctx,
} from './core.js';
import type {
  BallotEvent, BallotSource, Db, DeviceSession, District, Election, ElectionDay, Entry, Member, OperatorLog, Slot, Station,
  TallyWindow, Voter, VoterAccessLog, VoterKind, BallotPad, Desk, PadMove, PadReading, StationCounts, TagIssue, Dept,
} from './db/types.js';
import {
  addDepts, allDesks, deptLabel, deskOf, deskView, mergedIds, parseDepts, pickDesk, tagBaseline, tagTotalOf,
  rebuildDepts, resetDeskData, stationDesks, unassignedDesk,
} from './desks.js';
import { nowIso, slotEpoch } from './logic/time.js';
import { createSessionToken, renewedExpiry } from './auth.js';
import { decrypt, encrypt, hashSid, normalizeSid } from './voterCrypto.js';

const MIN = 60 * 1000;
const HOURS_GRACE_MS = 30 * MIN;      // 투표소 운영시간 30분 전 ~ 30분 후 (FR-93)
const OWN_CANCEL_MS = 5 * MIN;        // 본인 취소 5분
const SLOT_MATCH_MS = 15 * MIN;       // 시점 ±15분 안의 마감 (v1.4에서 10분 → 15분)
const CLOSE_DELAY_MS = 70 * MIN;      // 마감 지연 경고
const RECONCILE_DELAY_MS = 20 * MIN;  // 대조 중 지연 경고
const LOOKUPS_PER_MIN = 30;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------- 시각 도우미 (Asia/Seoul) ----------
export function kstDate(ms = Date.now()): string {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function hm(ms: number): string {
  return new Date(ms + 9 * 3600 * 1000).toISOString().slice(11, 16);
}

// ---------- 공통 ----------
async function election(db: Db): Promise<Election> {
  const e = await db.get<Election>('election', { id: 'main' });
  if (!e) throw new HttpError(500, 'no_election');
  return e;
}

export async function rosterActive(db: Db): Promise<boolean> {
  // schema.sql(v1.1)을 아직 실행하지 않은 배포에서도 기존 기능은 그대로 동작하도록, 테이블이 없으면 명부 미사용으로 본다
  try { return (await db.count('voter', { batch_id: null })) > 0; } catch { return false; }
}

/** 선거 기간 잠금 (FR-97a): 투표일(연장일 포함)에는 기록을 지우는 작업을 거부한다. */
export async function assertNotElectionDay(db: Db, what: string) {
  const today = kstDate();
  const days = await db.all<ElectionDay>('election_day');
  if (days.some((d) => d.date === today)) throw new HttpError(423, 'election_day', `투표일에는 ${what}을(를) 할 수 없습니다. 선거 기간에는 기록을 지우는 작업이 잠깁니다.`);
}

/** 지금 기기의 담당자 이름 (투표소 계정만). */
export const operatorOf = (ctx: Ctx) => (ctx.member?.role === 'station' ? ctx.device?.operator_name ?? null : null);

/** 변경 로그·자동 입력값에 남길 처리자: 투표소 기기는 "담당자 (투표소 계정)". */
export function actorOf(ctx: Ctx): Member {
  const me = ctx.member!;
  const op = operatorOf(ctx);
  return op ? { ...me, name: `${op} (${me.name})` } : me;
}
/** 마감·대조표에 보이는 처리자 이름: 투표소 기기는 담당자 이름. */
export const whoName = (ctx: Ctx) => operatorOf(ctx) ?? ctx.member!.name;
export const operatorName = operatorOf;

export async function accessLog(ctx: Ctx, stationId: string | null, action: string, sidHash: string | null, result: string | null, note: string | null = null) {
  const me = ctx.member!;
  const op = operatorOf(ctx);
  await ctx.db.insert<VoterAccessLog>('voter_access_log', {
    id: randomUUID(), at: nowIso(), member_id: me.id, member_name: me.name, station_id: stationId,
    action, sid_hash8: sidHash ? sidHash.slice(0, 8) : null, result, note,
    // v1.2 열은 값이 있을 때만 넣는다 (schema.sql 재실행 전에도 총관리자 기능이 동작하도록)
    ...(op ? { operator_name: op } : {}),
  });
}

const lookupTimes = new Map<string, number[]>();
/** 기기(투표소 계정) 또는 계정(총관리자)마다 1분 30회 */
function rateLimit(key: string) {
  const now = Date.now();
  const list = (lookupTimes.get(key) ?? []).filter((t) => now - t < MIN);
  if (list.length >= LOOKUPS_PER_MIN) {
    lookupTimes.set(key, list);
    return false;
  }
  list.push(now);
  lookupTimes.set(key, list);
  return true;
}

/**
 * 투표소·선거구·투표일은 선거 중 거의 바뀌지 않으므로 서버 인스턴스 메모리에 60초 보관한다.
 * 조회 한 번에 DB 왕복을 줄이기 위함 (이름을 바꾸면 같은 인스턴스는 즉시, 다른 인스턴스는 60초 안에 반영).
 */
const PLACE_TTL_MS = 60_000;
let placeCache: { at: number; stations: Station[]; districts: District[]; days: ElectionDay[] } | null = null;
async function places(db: Db) {
  if (placeCache && Date.now() - placeCache.at < PLACE_TTL_MS) return placeCache;
  const [stations, districts, days] = await Promise.all([
    db.all<Station>('station', undefined, 'sort'), db.all<District>('district', undefined, 'sort'), db.all<ElectionDay>('election_day', undefined, 'sort'),
  ]);
  placeCache = { at: Date.now(), stations, districts, days };
  return placeCache;
}
export function invalidatePlaces() { placeCache = null; }
export const placesOf = places;

/** 서약·파기·업로드·계정 종류 검사 (FR-93, FR-94). */
async function checkGate(ctx: Ctx, el: Election, needReady?: boolean) {
  const me = ctx.member!;
  if (el.purged_at) throw new HttpError(410, 'purged', '선거인명부가 파기되었습니다.');
  if (me.role === 'station') {
    if (!ctx.device?.operator_name || !ctx.device.operator_pledged_at) throw new HttpError(403, 'operator_required', '담당자 이름을 입력하고 서약에 동의해야 합니다.');
    if (!ctx.device.desk_id) throw new HttpError(403, 'operator_required', '창구를 고르고 담당자를 등록해야 합니다.');
  } else if (!me.pledged_at) {
    throw new HttpError(403, 'pledge_required', '개인정보 취급 서약에 먼저 동의해야 합니다.');
  }
  if (needReady && el.roster_upload) throw new HttpError(503, 'uploading', '선거인명부 업로드가 진행 중입니다. 끝난 뒤 다시 시도하세요.');
}

/** 명부 기능 공통 검사: 서약, 파기 여부, 업로드 진행 여부. */
async function rosterGate(ctx: Ctx, opts: { needReady?: boolean } = {}) {
  const me = requireAuth(ctx);
  const el = await election(ctx.db);
  await checkGate(ctx, el, opts.needReady);
  return { me, el };
}

/** 투표소 운영시간 [시작 30분 전, 종료 30분 후] 안인지 (FR-93). 리허설에서 시점 시간 제한을 끄면 항상 허용. */
export function stationHours(st: Station, el: Election, days: ElectionDay[], now = Date.now()) {
  const label = `${st.open_time}~${st.close_time}`;
  if (!el.enforce_time_window) return { allowed: true, label, message: null as string | null };
  const today = kstDate(now);
  const day = days.find((d) => d.date === today && (!d.is_extension || el.extension_enabled));
  if (!day) return { allowed: false, label, message: '오늘은 투표일이 아니어서 명부를 쓸 수 없습니다.' };
  const from = slotEpoch(today, st.open_time) - HOURS_GRACE_MS, to = slotEpoch(today, st.close_time) + HOURS_GRACE_MS;
  if (now < from || now > to) {
    return { allowed: false, label, message: `명부는 투표소 운영시간(${label})의 30분 전부터 30분 후까지만 쓸 수 있습니다.` };
  }
  return { allowed: true, label, message: null };
}

/**
 * 검사 + 투표소 확인을 DB 왕복 한 번(병렬)으로 끝낸다. 학번 조회·불출처럼 자주 부르는 곳에서 쓴다.
 * 투표소 계정은 자기 투표소만, 운영시간에만 (skipHours = 상태 보기처럼 시간 제한이 없는 곳).
 */
export async function gateAt(ctx: Ctx, stationId: unknown, opts: { needReady?: boolean; skipHours?: boolean } = {}) {
  const me = requireAuth(ctx);
  const [el, pl] = await Promise.all([election(ctx.db), places(ctx.db)]);
  await checkGate(ctx, el, opts.needReady);
  const station = await resolveStation(ctx, stationId, pl, el, opts.skipHours);
  return { me, el, station, pl };
}

/**
 * 총관리자와 선관위원은 지정한 투표소, 투표소 계정은 자기 투표소.
 * 선관위원(FR-117)은 비상용이라 투표소 계정처럼 운영시간 안에서만 쓸 수 있다. 총관리자는 시간 제한이 없다.
 */
async function resolveStation(ctx: Ctx, stationId: unknown, pl: Awaited<ReturnType<typeof places>>, el: Election, skipHours?: boolean): Promise<Station> {
  const me = ctx.member!;
  if (me.role !== 'station') {
    const station = pl.stations.find((s) => s.id === stationId);
    if (!station) throw new HttpError(400, 'station_required', '투표소를 선택하세요.');
    if (me.role === 'member' && !skipHours) {
      const h = stationHours(station, el, pl.days);
      if (!h.allowed) {
        await accessLog(ctx, station.id, 'denied', null, 'off_hours');
        throw new HttpError(403, 'off_hours', h.message!);
      }
    }
    return station;
  }
  const station = pl.stations.find((s) => s.id === me.station_id);
  if (!station) throw new HttpError(404, 'not_found', '이 계정의 투표소를 찾을 수 없습니다.');
  if (stationId && stationId !== station.id) {
    await accessLog(ctx, String(stationId), 'denied', null, 'wrong_station');
    throw new HttpError(403, 'wrong_station', '이 계정의 투표소가 아닙니다.');
  }
  if (!skipHours) {
    const h = stationHours(station, el, pl.days);
    if (!h.allowed) {
      await accessLog(ctx, station.id, 'denied', null, 'off_hours');
      throw new HttpError(403, 'off_hours', h.message!);
    }
  }
  return station;
}

/** 이미 읽은 기록의 투표소로 권한 검사 (취소·대조). */
async function stationFor(ctx: Ctx, stationId: string, skipHours?: boolean): Promise<Station> {
  const [el, pl] = await Promise.all([election(ctx.db), places(ctx.db)]);
  return resolveStation(ctx, stationId, pl, el, skipHours);
}

function voterView(v: Voter) {
  return { voter_id: v.id, name: decrypt(v.name_enc), dept: deptLabel(decrypt(v.dept_enc)), kind: v.kind };
}

// ---------- 집계 연동 ----------
/**
 * 일치한 마감 하나를 그 경계 ±15분 안의 집계 시점 입력값(entry)으로 옮긴다.
 * v1.4: 시점 값 = 그 투표소 모든 창구의, 시점 + 15분까지 끝난 구간 인정 인원 합 (FR-109).
 */
async function syncEntriesForWindow(db: Db, actor: Member, win: TallyWindow) {
  const [slots, days, all] = await Promise.all([
    db.all<Slot>('slot', { station_id: win.station_id }), db.all<ElectionDay>('election_day'), db.all<TallyWindow>('tally_window', { station_id: win.station_id }),
  ]);
  const boundary = Date.parse(win.boundary_at);
  const done = all.filter((w) => w.status !== 'reconciling');
  for (const slot of slots) {
    const day = days.find((d) => d.id === slot.day_id);
    if (!day) continue;
    const at = slotEpoch(day.date, slot.time);
    if (Math.abs(at - boundary) > SLOT_MATCH_MS) continue;
    const upto = new Date(at + SLOT_MATCH_MS).toISOString();
    const inRange = done.filter((w) => w.boundary_at <= upto);
    const cumulative = inRange.reduce((a, w) => a + (w.accepted_count ?? 0), 0);
    const leave = inRange.reduce((a, w) => a + w.leave_count, 0);
    const existing = await db.get<Entry>('entry', { station_id: win.station_id, slot_id: slot.id });
    const by = `꼬리표 대조(${win.matched_by_name ?? actor.name})`;
    const now = nowIso();
    if (!existing) {
      await db.insert<Entry>('entry', {
        id: randomUUID(), station_id: win.station_id, slot_id: slot.id, cumulative, leave_cumulative: leave,
        entered_by: 'system', entered_by_name: by, entered_at: now, confirmed: false, confirmed_by: null, confirmed_at: null,
      });
      await log(db, actor, 'entry.tally', { station_id: win.station_id, slot_id: slot.id, after_json: JSON.stringify({ cumulative, leave_cumulative: leave }), note: `마감 ${hm(boundary)}` });
    } else if (existing.confirmed) {
      await log(db, actor, 'entry.tally_skip', { station_id: win.station_id, slot_id: slot.id, note: `이미 확정된 시점이라 마감 ${hm(boundary)} 값(${cumulative}명)을 반영하지 않음` });
    } else if (existing.cumulative !== cumulative || existing.leave_cumulative !== leave) {
      await db.update('entry', { id: existing.id }, { cumulative, leave_cumulative: leave, entered_by: 'system', entered_by_name: by, entered_at: now });
      await log(db, actor, 'entry.tally', {
        station_id: win.station_id, slot_id: slot.id,
        before_json: JSON.stringify({ cumulative: existing.cumulative, leave_cumulative: existing.leave_cumulative, by: existing.entered_by_name }),
        after_json: JSON.stringify({ cumulative, leave_cumulative: leave }), note: `마감 ${hm(boundary)}`,
      });
    }
  }
}

/**
 * 시점 확정을 막는 창구 (FR-109): 그 시점 범위(±15분)에 일치 마감이 없는데 그 전에 한 체크가 남아 있는 창구.
 * 마지막 마감 뒤로 체크가 없는 창구는 막지 않는다.
 */
export async function slotBlockers(db: Db, stations: Station[], date: string, time: string): Promise<string[]> {
  const at = slotEpoch(date, time);
  const from = new Date(at - SLOT_MATCH_MS).toISOString(), to = new Date(at + SLOT_MATCH_MS).toISOString();
  const [desks, wins, open] = await Promise.all([allDesks(db), db.all<TallyWindow>('tally_window'), db.all<BallotEvent>('ballot_event', { window_id: null })]);
  const canceled = new Set(open.filter((e) => e.kind === 'cancel').map((e) => e.ref_event_id));
  const out: string[] = [];
  for (const d of desks) {
    const st = stations.find((s) => s.id === d.station_id);
    if (!st) continue;
    const mine = wins.filter((w) => w.desk_id === d.id);
    const why =
      mine.some((w) => w.status === 'reconciling' && w.boundary_at <= to) ? '대조 중'
      : open.some((e) => e.desk_id === d.id && e.kind === 'issue' && !canceled.has(e.id) && e.at < from) ? '마감 안 함'
      : mine.some((w) => w.boundary_at > to && w.opened_at < from && w.check_count > 0 && w.date === date) ? '늦게 마감'
      : null;
    if (why) out.push(`${st.name} ${d.name}(${why})`);
  }
  return out;
}

/** 입력값이 초기화된 뒤 대조 기록으로 다시 채운다. */
export async function resyncAllEntries(db: Db, actor: Member) {
  const wins = (await db.all<TallyWindow>('tally_window')).filter((w) => w.status !== 'reconciling')
    .sort((a, b) => a.boundary_at.localeCompare(b.boundary_at));
  for (const w of wins) await syncEntriesForWindow(db, actor, w);
}

/** 선거구 기본 유권자수 = 정회원 수 (FR-83) */
async function recomputeBaseVoters(db: Db, actor: Member) {
  const [counts, districts] = await Promise.all([db.votes.rosterCounts(), db.all<District>('district')]);
  for (const d of districts) {
    const n = counts.filter((c) => c.district_id === d.id && c.kind === 'regular').reduce((a, c) => a + Number(c.total), 0);
    if (n !== d.base_voters) {
      await db.update('district', { id: d.id }, { base_voters: n });
      await log(db, actor, 'voters.update', { before_json: JSON.stringify({ name: d.name, base_voters: d.base_voters }), after_json: JSON.stringify({ name: d.name, base_voters: n }), note: '선거인명부 정회원 수로 자동 계산' });
    }
  }
}

function stationWarning(st: Station, wins: TallyWindow[], electionDates: Set<string>, now: number): string | null {
  const reconciling = wins.find((w) => w.status === 'reconciling');
  if (reconciling && now - Date.parse(reconciling.boundary_at) > RECONCILE_DELAY_MS) return '대조 지연';
  const today = kstDate(now);
  if (!electionDates.has(today)) return null;
  const open = slotEpoch(today, st.open_time), close = slotEpoch(today, st.close_time);
  if (now < open + CLOSE_DELAY_MS) return null;
  const todays = wins.filter((w) => w.date === today).map((w) => Date.parse(w.boundary_at));
  if (now <= close + SLOT_MATCH_MS) {
    const last = Math.max(open, ...todays);
    return now - last > CLOSE_DELAY_MS ? '마감 지연' : null;
  }
  return todays.some((b) => b >= close - SLOT_MATCH_MS) ? null : '마감 미완료';
}

/** 창구별 경고 (FR-109): 마감하지 않은 체크가 있을 때만 지연을 따진다. */
function deskWarning(st: Station, wins: TallyWindow[], openNet: number, electionDates: Set<string>, now: number): string | null {
  const reconciling = wins.find((w) => w.status === 'reconciling');
  if (reconciling && now - Date.parse(reconciling.boundary_at) > RECONCILE_DELAY_MS) return '대조 지연';
  const today = kstDate(now);
  if (!electionDates.has(today) || openNet <= 0) return null;
  const open = slotEpoch(today, st.open_time), close = slotEpoch(today, st.close_time);
  if (now > close + SLOT_MATCH_MS) return '마감 미완료';
  const last = Math.max(open, ...wins.filter((w) => w.date === today).map((w) => Date.parse(w.boundary_at)));
  return now - last > CLOSE_DELAY_MS ? '마감 지연' : null;
}

const sumLive = (rows: StationCounts[]) => ({
  net: rows.reduce((a, r) => a + Number(r.net ?? 0), 0), leave_net: rows.reduce((a, r) => a + Number(r.leave_net ?? 0), 0),
  open_net: rows.reduce((a, r) => a + Number(r.open_net ?? 0), 0), open_leave_net: rows.reduce((a, r) => a + Number(r.open_leave_net ?? 0), 0),
});

export interface Forecast {
  today: string; today_gain: number; today_leave_gain: number;
  past: { date: string; gain: number; total: number }[];
  avg_gain: number; ratio: number; ratio_applied: boolean;
  points: { time: string; add: number; leave_add: number }[];
}
const HOUR_MS = 3600 * 1000;
/** 지난 투표일의 같은 시각 증가가 이보다 적으면 오늘 속도 비율을 믿지 않고 1로 둔다 */
const FORECAST_MIN_BASE = 30;

/**
 * 오늘 남은 시간의 예상 증가 (FR-127).
 * 남은 구간마다 지난 투표일의 같은 구간 증가 평균에 오늘 속도 비율(오늘 지금까지 ÷ 지난 날 같은 시각까지 평균)을 곱한다.
 * 체크 기록은 1시간 단위로 묶여 있어, 지난 날의 "같은 시각" 값은 걸친 1시간을 지난 분만큼 나눠 계산한다.
 */
export function buildForecast(buckets: { start: number; net: number; leave: number }[], dates: string[], times: string[], now: number): Forecast | null {
  const today = kstDate(now);
  if (!dates.includes(today)) return null;
  const of = (date: string) => buckets.filter((b) => kstDate(b.start) === date);
  const gainTo = (date: string, e: number) => of(date).reduce((a, b) => a + b.net * Math.min(1, Math.max(0, (e - b.start) / HOUR_MS)), 0);
  const total = (date: string) => of(date).reduce((a, b) => a + b.net, 0);
  const shift = (date: string) => slotEpoch(today, '00:00') - slotEpoch(date, '00:00');
  const pastDates = dates.filter((d) => d < today && total(d) > 0);
  if (!pastDates.length) return null;
  const todayGain = total(today), todayLeave = of(today).reduce((a, b) => a + b.leave, 0);
  const sameTime = pastDates.map((d) => gainTo(d, now - shift(d)));
  const avg = sameTime.reduce((a, x) => a + x, 0) / pastDates.length;
  const applied = avg >= FORECAST_MIN_BASE;
  const ratio = avg > 0 ? todayGain / avg : 1;
  const k = applied ? ratio : 1;
  const leaveShare = todayGain > 0 ? Math.max(0, todayLeave) / todayGain : 0;
  const points = times.map((time, i) => ({ time, epoch: slotEpoch(today, time), last: i === times.length - 1 })).filter((p) => p.epoch > now).map((p) => {
    // 마지막 점(종료 시각)은 그날 전체, 나머지는 그 정각까지
    const rest = pastDates.map((d, i) => (p.last ? total(d) : gainTo(d, p.epoch - shift(d))) - sameTime[i]);
    const add = Math.max(0, Math.round(k * rest.reduce((a, x) => a + x, 0) / pastDates.length));
    return { time: p.time, add, leave_add: Math.round(add * leaveShare) };
  });
  return {
    today, today_gain: todayGain, today_leave_gain: todayLeave,
    past: pastDates.map((d, i) => ({ date: d, gain: Math.round(sameTime[i]), total: total(d) })),
    avg_gain: Math.round(avg), ratio: Math.round(ratio * 1000) / 1000, ratio_applied: applied, points,
  };
}

/** 현황판에 붙이는 실시간·대조 정보 (15.6). v1.4: 투표소 값은 창구 합, 창구별 내역을 함께 준다. */
export async function tallyExtras(db: Db, days: ElectionDay[], stations: Station[], extensionEnabled: boolean, points: { date: string; time: string; epoch: number }[] = []) {
  const active = await rosterActive(db);
  if (!active) return { roster_active: false, stations: [], live_series: [], forecast: null };
  const [live, wins, desks, hourly] = await Promise.all([db.votes.liveCounts(), db.all<TallyWindow>('tally_window'), allDesks(db), db.votes.hourlyCounts()]);
  const dates = new Set(days.filter((d) => !d.is_extension || extensionEnabled).map((d) => d.date));
  const now = Date.now();
  // 실시간 추이 (FR-119): 투표일마다 매 정각과 그날 마지막 종료 시각에, 그때까지의 순 체크 인원(체크 시각 기준)
  let live_series: { date: string; time: string; cumulative: number; leave_cumulative: number }[];
  let forecast: Forecast | null = null;
  if (hourly) {
    const buckets = hourly.map((h) => ({ start: Date.parse(`${h.hour}:00:00Z`), net: Number(h.net), leave: Number(h.leave_net) }));
    const mins = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const open = Math.min(...stations.map((s) => mins(s.open_time))), close = Math.max(...stations.map((s) => mins(s.close_time)));
    const times: string[] = [];
    for (let m = (Math.floor(open / 60) + 1) * 60; m < close; m += 60) times.push(`${String(m / 60).padStart(2, '0')}:00`);
    if (stations.length) times.push(`${String(Math.floor(close / 60)).padStart(2, '0')}:${String(close % 60).padStart(2, '0')}`);
    live_series = [...dates].sort().flatMap((date) => times.map((time) => ({ date, time, epoch: slotEpoch(date, time) })))
      .filter((p) => p.epoch <= now)
      .map((p) => {
        const past = buckets.filter((b) => b.start < p.epoch);
        return { date: p.date, time: p.time, cumulative: past.reduce((a, b) => a + b.net, 0), leave_cumulative: past.reduce((a, b) => a + b.leave, 0) };
      });
    forecast = buildForecast(buckets, [...dates].sort(), times, now);
  } else {
    // DB 함수가 없을 때: 지난 집계 시점마다 그때까지 마감된 구간의 체크 인원 합 (FR-118)
    live_series = points.filter((p) => p.epoch <= now).map((p) => {
      const upto = new Date(p.epoch + SLOT_MATCH_MS).toISOString();
      const closed = wins.filter((w) => w.boundary_at <= upto);
      return { date: p.date, time: p.time, cumulative: closed.reduce((a, w) => a + w.check_count, 0), leave_cumulative: closed.reduce((a, w) => a + w.leave_count, 0) };
    });
  }
  return {
    roster_active: true, live_series, forecast,
    stations: stations.map((st) => {
      const l = sumLive(live.filter((x) => x.station_id === st.id));
      const mine = wins.filter((w) => w.station_id === st.id);
      const done = mine.filter((w) => w.status !== 'reconciling').sort((a, b) => a.boundary_at.localeCompare(b.boundary_at));
      const deskRows = desks.filter((d) => d.station_id === st.id && !d.merged_into).map((d) => {
        // 합쳐진 창구의 체크와 구간은 합친 창구에 함께 센다 (FR-125)
        const fam = mergedIds(desks, d.id);
        const dl = sumLive(live.filter((x) => x.desk_id && fam.has(x.desk_id)));
        const dw = mine.filter((w) => w.desk_id && fam.has(w.desk_id));
        const dd = dw.filter((w) => w.status !== 'reconciling').sort((a, b) => a.boundary_at.localeCompare(b.boundary_at));
        return {
          desk_id: d.id, name: d.name, is_unassigned: d.is_unassigned, live: dl.net, open: dl.open_net,
          reconciled: dd.reduce((a, w) => a + (w.accepted_count ?? 0), 0), last_boundary_at: dd.at(-1)?.boundary_at ?? null,
          reconciling: dw.some((w) => w.status === 'reconciling'), warning: deskWarning(st, dw, dl.open_net, dates, now),
        };
      }).filter((d) => !d.is_unassigned || d.live !== 0 || d.reconciling);
      return {
        station_id: st.id,
        live: l.net, live_leave: l.leave_net, open: l.open_net,
        reconciled: done.reduce((a, w) => a + (w.accepted_count ?? 0), 0),
        reconciled_leave: done.reduce((a, w) => a + w.leave_count, 0),
        last_boundary_at: done.at(-1)?.boundary_at ?? null,
        reconciling: mine.some((w) => w.status === 'reconciling'),
        warning: deskRows.length ? deskRows.find((d) => d.warning)?.warning ?? null : stationWarning(st, mine, dates, now),
        desks: deskRows,
      };
    }),
  };
}

/** 투표소 기기 정보 (화면 맨 위 "담당자: 홍길동 · 13:02부터") */
export function deviceView(d: DeviceSession | null) {
  return d ? {
    id: d.id, device_no: d.device_no, operator_name: d.operator_name, operator_since: d.operator_since,
    operator_pledged: !!d.operator_pledged_at, created_at: d.created_at, expires_at: d.expires_at, desk_id: d.desk_id ?? null,
  } : null;
}

// ---------- 내 상태·서약·담당자 ----------
route('GET', '/roster/me', async (ctx) => {
  const me = requireAuth(ctx);
  const [el, pl, active] = await Promise.all([election(ctx.db), places(ctx.db), rosterActive(ctx.db)]);
  const station = me.role === 'station' ? pl.stations.find((s) => s.id === me.station_id) ?? null : null;
  const desk = ctx.device?.desk_id ? await ctx.db.get<Desk>('desk', { id: ctx.device.desk_id }).catch(() => null) : null;
  return {
    pledged_at: me.pledged_at ?? null, role: me.role, station, device: deviceView(ctx.device), desk: desk ? deskView(desk) : null,
    hours: station ? stationHours(station, el, pl.days) : null,
    roster_ready: !el.roster_upload && !el.purged_at && active,
    uploading: !!el.roster_upload, purged: !!el.purged_at, server_now: nowIso(),
  };
});

/** 투표소 기기: 담당자 이름 + 서약 (로그인 직후, 교대할 때마다) (FR-94) */
route('POST', '/roster/operator', async (ctx) => {
  const me = requireAuth(ctx);
  const dev = ctx.device;
  if (me.role !== 'station' || !dev) throw new HttpError(403, 'forbidden', '투표소 기기에서만 담당자를 바꿀 수 있습니다.');
  const name = str(ctx.req.body?.name, '담당자 이름', 30);
  if (ctx.req.body?.agree !== true) throw new HttpError(400, 'bad_request', '개인정보 취급 서약에 동의해야 합니다.');
  const at = nowIso();
  const prev = dev.operator_name;
  // 창구 고르기 (FR-107). 창구 변경은 담당자 변경 때만 (FR-107a)
  const station = (await places(ctx.db)).stations.find((s) => s.id === dev.station_id);
  if (!station) throw new HttpError(404, 'not_found', '이 계정의 투표소를 찾을 수 없습니다.');
  const desk = await pickDesk(ctx, station, dev, ctx.req.body, name);
  await Promise.all([
    ctx.db.update('device_session', { id: dev.id }, { operator_name: name, operator_since: at, operator_pledged_at: at, last_seen_at: at, desk_id: desk.id }),
    ctx.db.insert<OperatorLog>('operator_log', { id: randomUUID(), device_id: dev.id, station_id: dev.station_id, operator_name: name, started_at: at }),
  ]);
  ctx.device = { ...dev, operator_name: name, operator_since: at, operator_pledged_at: at, last_seen_at: at, desk_id: desk.id };
  await accessLog(ctx, dev.station_id, 'operator', null, 'pledged', `${dev.device_no}번 기기 · ${desk.name} · ${prev ? `${prev} → ` : ''}${name}`);
  return { device: deviceView(ctx.device), desk: deskView(desk) };
});

route('POST', '/roster/pledge', async (ctx) => {
  const me = requireAuth(ctx);
  if (me.role === 'station') throw new HttpError(400, 'bad_request', '투표소 기기는 담당자 서약을 씁니다.');
  if (ctx.req.body?.agree !== true) throw new HttpError(400, 'bad_request', '서약에 동의해야 합니다.');
  const at = nowIso();
  await ctx.db.update('member', { id: me.id }, { pledged_at: at });
  await accessLog(ctx, null, 'pledge', null, 'agreed');
  return { pledged_at: at };
});

// ---------- 학번 조회·불출 (15.3) ----------
route('POST', '/roster/lookup', async (ctx) => {
  // DB 왕복 2번: ①권한 검사(설정)와 선거인 1행을 동시에 ②접근 로그. 계정·기기는 요청 처음에 읽고, 투표소·선거구 이름은 메모리 캐시에서.
  // 선거인 행은 미리 읽지만 권한 검사를 통과해야만 응답에 쓰인다.
  const me = requireAuth(ctx);
  const sid = normalizeSid(ctx.req.body?.sid);
  if (sid.length < 4 || sid.length > 20) throw new HttpError(400, 'bad_sid', '학번을 확인하세요.');
  const h = hashSid(sid);
  const [{ station, pl }, v] = await Promise.all([
    gateAt(ctx, ctx.req.body?.station_id, { needReady: true }),
    ctx.db.get<Voter>('voter', { sid_hash: h, batch_id: null }),
  ]);
  if (!rateLimit(ctx.device?.id ?? me.id)) {
    await accessLog(ctx, station.id, 'lookup', null, 'rate_limited');
    throw new HttpError(429, 'rate_limited', '조회가 너무 잦습니다. 1분 뒤 다시 시도하세요.');
  }
  let out: Record<string, unknown>;
  let result: string;
  if (!v) {
    result = 'not_found'; out = { result };
  } else if (v.district_id !== station.district_id) {
    result = 'other_district';
    out = {
      result, district_name: pl.districts.find((d) => d.id === v.district_id)?.name ?? '',
      station_names: pl.stations.filter((s) => s.district_id === v.district_id).map((s) => s.name),
    };
  } else if (v.voted_at) {
    result = 'voted';
    out = { result, ...voterView(v), voted_at: v.voted_at, voted_station_name: pl.stations.find((s) => s.id === v.voted_station_id)?.name ?? '' };
  } else {
    result = 'ok'; out = { result, ...voterView(v) };
    // 다른 학과 학생이면 경고만 (FR-107b). 불출은 막지 않는다
    if (ctx.device?.desk_id) {
      const desks = await stationDesks(ctx.db, station.id);
      const mine = desks.find((d) => d.id === ctx.device!.desk_id);
      const dept = decrypt(v.dept_enc).trim(); // 저장된 그대로 ("학과 > 전공")
      if (mine && !mine.is_all && !mine.is_unassigned && dept && !parseDepts(mine).includes(dept)) {
        out.desk_warning = { dept: deptLabel(dept), desk_name: desks.find((d) => parseDepts(d).includes(dept))?.name ?? null };
      }
    }
  }
  await accessLog(ctx, station.id, 'lookup', h, result);
  return out;
});

route('POST', '/roster/issue', async (ctx) => {
  requireAuth(ctx);
  if (ctx.req.body?.id_checked !== true) throw new HttpError(400, 'id_check', '신분증 확인을 먼저 체크하세요.');
  const voterId = str(ctx.req.body?.voter_id, '선거인');
  const missedId = ctx.req.body?.missed_window_id ? String(ctx.req.body.missed_window_id) : null;
  // 검사·선거인·대조 구간을 한 번에 병렬로 읽는다
  const [{ me, station, pl }, v, w] = await Promise.all([
    gateAt(ctx, ctx.req.body?.station_id, { needReady: true }),
    ctx.db.get<Voter>('voter', { id: voterId, batch_id: null }),
    missedId ? ctx.db.get<TallyWindow>('tally_window', { id: missedId }) : Promise.resolve(null),
  ]);
  if (!v) throw new HttpError(404, 'not_found', '선거인을 찾을 수 없습니다.');
  if (v.district_id !== station.district_id) throw new HttpError(403, 'other_district', '이 투표소 선거구의 선거인이 아닙니다.');
  const desk = await deskOf(ctx, station, ctx.req.body?.desk_id);
  let windowId: string | null = null;
  let source: BallotSource = 'live';
  if (missedId) {
    if (!w || w.station_id !== station.id || w.status !== 'reconciling' || (w.desk_id ?? null) !== desk.id) throw new HttpError(409, 'window_closed', '이 창구의 대조 중인 구간이 아닙니다.');
    windowId = w.id; source = 'missed';
  }
  const eventId = randomUUID();
  const r = await ctx.db.votes.issue({
    event_id: eventId, voter_id: v.id, sid_hash: v.sid_hash, station_id: station.id, at: nowIso(),
    actor_id: me.id, actor_name: me.name, source, window_id: windowId, reason: source === 'missed' ? '대조 중 누락분 추가' : null,
    operator_name: operatorOf(ctx), device_id: ctx.device?.id ?? null, desk_id: desk.id,
  });
  if (!r.ok) {
    await accessLog(ctx, station.id, 'issue', v.sid_hash, 'already_voted');
    throw new HttpError(409, 'already_voted', '이미 투표한 선거인입니다.', { voted_at: r.voted_at, voted_station_name: pl.stations.find((s) => s.id === r.voted_station_id)?.name ?? '' });
  }
  const [, counts] = await Promise.all([
    accessLog(ctx, station.id, 'issue', v.sid_hash, source === 'missed' ? 'missed' : 'ok'),
    ctx.db.votes.liveCounts(),
  ]);
  const live = counts.find((x) => x.desk_id === desk.id);
  return { ok: true, event_id: eventId, is_leave: r.is_leave, open_count: Number(live?.open_net ?? 0), total_count: Number(live?.net ?? 0) };
});

async function doCancel(ctx: Ctx, me: Member, ev: BallotEvent, reason: string) {
  if (ev.kind !== 'issue') throw new HttpError(400, 'bad_request', '불출 기록만 취소할 수 있습니다.');
  if (me.role !== 'admin') {
    // 투표소 계정은 여러 기기가 같이 쓰므로 "본인" = 체크한 그 기기. 선관위원은 본인 계정으로 체크한 건
    if (me.role === 'member' ? ev.actor_id !== me.id || !!ev.device_id : !ctx.device || ev.device_id !== ctx.device.id) {
      throw new HttpError(403, 'forbidden', me.role === 'member' ? '본인이 체크한 건만 취소할 수 있습니다. 총관리자에게 요청하세요.' : '이 기기에서 체크한 건만 취소할 수 있습니다. 총관리자에게 요청하세요.');
    }
    if (Date.now() - Date.parse(ev.at) > OWN_CANCEL_MS) throw new HttpError(403, 'too_late', '5분이 지나 총관리자만 취소할 수 있습니다.');
  }
  // FR-121: 총관리자는 대조가 끝난 구간의 체크도 취소한다. 취소분은 그 창구(합쳐졌으면 합친 창구)의 열린 구간에 들어간다
  let openDesk: string | null = ev.desk_id ?? null;
  if (me.role === 'admin' && openDesk) {
    const desks = await allDesks(ctx.db);
    for (let d = desks.find((x) => x.id === openDesk), n = 0; d?.merged_into && n < 20; d = desks.find((x) => x.id === openDesk), n++) openDesk = d.merged_into;
  }
  const r = await ctx.db.votes.cancel({
    cancel_id: randomUUID(), issue_id: ev.id, at: nowIso(), actor_id: me.id, actor_name: me.name, reason,
    operator_name: operatorOf(ctx), device_id: ctx.device?.id ?? null, force: me.role === 'admin', open_desk_id: openDesk,
  });
  if (!r.ok) {
    const msg = r.reason === 'already_canceled' ? '이미 취소된 기록입니다.' : r.reason === 'window_closed' ? (me.role === 'admin' ? '대조가 끝난 구간의 체크를 취소하지 못했습니다. DB 함수(vote_cancel)가 최신인지 확인하세요.' : '대조가 끝난 구간의 체크는 총관리자만 취소할 수 있습니다. 총관리자에게 요청하세요.') : '기록을 찾을 수 없습니다.';
    throw new HttpError(409, r.reason, msg);
  }
  await accessLog(ctx, ev.station_id, 'cancel', ev.voter_sid_hash, 'ok', r.late ? `${reason} (대조 끝난 구간의 체크)` : reason);
  if (r.late) await log(ctx.db, me, 'roster.cancel_late', { station_id: ev.station_id, note: `대조가 끝난 구간의 체크 1건 취소 · ${reason}` });
  return { ok: true, late: !!r.late };
}

route('POST', '/roster/cancel', async (ctx) => {
  const { me } = await rosterGate(ctx);
  const reason = str(ctx.req.body?.reason, '사유', 300);
  const ev = await ctx.db.get<BallotEvent>('ballot_event', { id: str(ctx.req.body?.event_id, '기록') });
  if (!ev) throw new HttpError(404, 'not_found', '기록을 찾을 수 없습니다.');
  if (me.role !== 'admin') await stationFor(ctx, ev.station_id);
  return doCancel(ctx, me, ev, reason);
});

/** 총관리자: 학번으로 그 학생의 현재 불출 기록을 취소 */
route('POST', '/roster/cancel-by-sid', async (ctx) => {
  const me = requireAdmin(ctx);
  await rosterGate(ctx, { needReady: true });
  const reason = str(ctx.req.body?.reason, '사유', 300);
  const h = hashSid(normalizeSid(ctx.req.body?.sid));
  const v = await ctx.db.get<Voter>('voter', { sid_hash: h, batch_id: null });
  if (!v) { await accessLog(ctx, null, 'cancel', h, 'not_found'); throw new HttpError(404, 'not_found', '선거인명부에 없는 학번입니다.'); }
  if (!v.voted_at || !v.voted_event_id) throw new HttpError(409, 'not_voted', '투표하지 않은 선거인입니다.');
  const ev = await ctx.db.get<BallotEvent>('ballot_event', { id: v.voted_event_id });
  if (!ev) throw new HttpError(404, 'not_found', '불출 기록을 찾을 수 없습니다.');
  return doCancel(ctx, me, ev, reason);
});

// ---------- 창구 상태·꼬리표 마감 (15.4, 15.13) ----------
route('GET', '/roster/station', async (ctx) => {
  const { me, el, station, pl } = await gateAt(ctx, ctx.req.query.station_id, { skipHours: true });
  const desk = await deskOf(ctx, station, ctx.req.query.desk_id);
  // 최근 체크: 투표소 기기는 그 기기에서 한 것, 총관리자는 본인이 한 것
  const mine: Record<string, string> = ctx.device ? { device_id: ctx.device.id } : { actor_id: me.id };
  const [live, wins, recent, issues, desks, stDesks] = await Promise.all([
    ctx.db.votes.liveCounts(),
    ctx.db.all<TallyWindow>('tally_window', { desk_id: desk.id }, 'boundary_at desc'),
    ctx.db.all<BallotEvent>('ballot_event', { ...mine, station_id: station.id, kind: 'issue' }, 'at desc', 5),
    ctx.db.all<TagIssue>('tag_issue', { desk_id: desk.id }, 'at desc', 20),
    me.role !== 'station' ? stationDesks(ctx.db, station.id) : Promise.resolve([] as Desk[]),
    ctx.db.all<Desk>('desk', { station_id: station.id }),
  ]);
  const canceled = new Set((await ctx.db.allIn<BallotEvent>('ballot_event', 'ref_event_id', recent.map((e) => e.id))).map((c) => c.ref_event_id));
  const reconciling = wins.find((w) => w.status === 'reconciling') ?? null;
  const l = live.find((x) => x.desk_id === desk.id);
  // 합쳐진 창구의 체크는 옮기지 않으므로 누적 수에는 함께 센다 (FR-125). 꼬리표 누적 수 기준(tagBaseline)과 같은 범위
  const family = mergedIds(stDesks, desk.id);
  const fam = sumLive(live.filter((x) => x.desk_id && family.has(x.desk_id)));
  return {
    station, hours: stationHours(station, el, pl.days), desk: deskView(desk), desks: desks.map(deskView),
    open_count: Number(l?.open_net ?? 0), open_leave: Number(l?.open_leave_net ?? 0),
    // 이 창구에서 첫날부터 지금까지 불출한 인원 (취소 제외). 꼬리표 누적 수와 맞아야 하는 숫자
    total_count: fam.net, total_leave: fam.leave_net,
    reconciling: reconciling ? { ...reconciling, ...(await ctx.db.votes.windowCounts(reconciling.id)) } : null,
    last_window: wins.find((w) => w.status !== 'reconciling') ?? null,
    issue_count: issues.filter((i) => !i.voided_at).length,
    window_issues: reconciling ? issues.filter((i) => i.window_id === reconciling.id && !i.voided_at).map((i) => ({ id: i.id, type: i.type, count: i.count, serial_from: i.serial_from, serial_to: i.serial_to, note: i.note })) : [],
    recent: recent.map((e) => ({ id: e.id, at: e.at, is_leave: e.is_leave, canceled: canceled.has(e.id), source: e.source })),
    server_now: nowIso(),
  };
});

/** 이 기기(투표소 계정) 또는 본인(위원)이 그 투표소에서 한 체크 전부, 최신순 (FR-123). 화면을 열 때 한 번 읽는다. */
route('GET', '/roster/recent', async (ctx) => {
  const { me, station } = await gateAt(ctx, ctx.req.query.station_id, { skipHours: true });
  const mine: Record<string, string> = ctx.device ? { device_id: ctx.device.id } : { actor_id: me.id };
  const [issues, cancels] = await Promise.all([
    ctx.db.all<BallotEvent>('ballot_event', { ...mine, station_id: station.id, kind: 'issue' }, 'at desc'),
    ctx.db.all<BallotEvent>('ballot_event', { station_id: station.id, kind: 'cancel' }),
  ]);
  const canceled = new Set(cancels.map((c) => c.ref_event_id));
  return { recent: issues.map((e) => ({ id: e.id, at: e.at, is_leave: e.is_leave, canceled: canceled.has(e.id), source: e.source })) };
});

route('POST', '/roster/close', async (ctx) => {
  const { me, station } = await gateAt(ctx, ctx.req.body?.station_id, { needReady: true });
  const desk = await deskOf(ctx, station, ctx.req.body?.desk_id);
  const op = operatorOf(ctx);
  // 마감 직전 담당자 재확인 (FR-89): 화면에서 확인한 이름이 지금 서버의 담당자와 다르면 다시 확인하게 한다
  if (op && ctx.req.body?.operator_name !== op) {
    throw new HttpError(409, 'operator_changed', `지금 이 기기의 담당자는 ${op}입니다. 담당자를 확인하고 다시 마감하세요.`);
  }
  // v1.4: 구간은 창구 단위 (FR-108). 다른 창구의 대조는 이 창구를 막지 않는다
  const wins = await ctx.db.all<TallyWindow>('tally_window', { desk_id: desk.id });
  if (wins.some((w) => w.status === 'reconciling')) throw new HttpError(409, 'reconciling', '대조 중인 구간이 있습니다. 먼저 꼬리표 대조를 마치세요.');
  const now = Date.now();
  const boundary = new Date(now).toISOString();
  const today = kstDate(now);
  const prev = wins.map((w) => w.boundary_at).sort().at(-1);
  const openAt = new Date(slotEpoch(today, station.open_time)).toISOString();
  const win: TallyWindow = {
    id: randomUUID(), station_id: station.id, date: today, opened_at: prev && prev > openAt ? prev : openAt, boundary_at: boundary,
    status: 'reconciling', check_count: 0, leave_count: 0, tag_count: null, accepted_count: null, adjustment: 0, adjust_reason: null,
    closed_by: me.id, closed_by_name: whoName(ctx), matched_at: null, matched_by_name: null,
    ...(op ? { operator_name: op } : {}), desk_id: desk.id,
  };
  await ctx.db.insert('tally_window', win);
  await ctx.db.votes.assignWindow(desk.id, win.id, boundary);
  const c = await ctx.db.votes.windowCounts(win.id);
  await ctx.db.update('tally_window', { id: win.id }, { check_count: c.net, leave_count: c.leave_net });
  await accessLog(ctx, station.id, 'close', null, 'begin', `${desk.name} · 경계 ${hm(now)} · 체크 ${c.net}명`);
  return { window: { ...win, check_count: c.net, leave_count: c.leave_net, net: c.net, leave_net: c.leave_net } };
});

async function loadReconciling(ctx: Ctx, me: Member, id: string) {
  const w = await ctx.db.get<TallyWindow>('tally_window', { id });
  if (!w) throw new HttpError(404, 'not_found', '마감 기록을 찾을 수 없습니다.');
  if (w.status !== 'reconciling') throw new HttpError(409, 'not_reconciling', '이미 대조가 끝난 구간입니다.');
  if (me.role !== 'admin') {
    await stationFor(ctx, w.station_id);
    if (ctx.device?.desk_id && w.desk_id && ctx.device.desk_id !== w.desk_id) throw new HttpError(403, 'other_desk', '다른 창구의 구간입니다.');
  }
  return w;
}

/** 근무자가 센 꼬리표 누적 수로 대조한다 (FR-111, FR-112). 이번 구간 꼬리표 수 = 누적 수 − 직전 누적 수 */
route('POST', '/roster/close/:id/submit', async (ctx) => {
  const { me } = await rosterGate(ctx);
  const w = await loadReconciling(ctx, me, ctx.params.id);
  const total = int(ctx.req.body?.total, '꼬리표 누적 수');
  // FR-124: 비교 기준은 마감을 누른 때가 아니라 대조 저장을 누른 지금이다.
  // 마감 뒤에 들어온 체크가 있으면 구간 끝을 지금으로 옮겨 이번 구간에 넣는다 (없으면 마감 시각을 그대로 둔다)
  if (w.desk_id) {
    const open = await ctx.db.all<BallotEvent>('ballot_event', { desk_id: w.desk_id, window_id: null }, 'at', 1);
    if (open.length) {
      const boundary = nowIso();
      await ctx.db.votes.assignWindow(w.desk_id, w.id, boundary);
      await ctx.db.update('tally_window', { id: w.id }, { boundary_at: boundary });
      await accessLog(ctx, w.station_id, 'close', null, 'extend', `경계 ${hm(Date.parse(w.boundary_at))} → ${hm(Date.parse(boundary))}`);
      w.boundary_at = boundary;
    }
  }
  const [c, prev] = await Promise.all([ctx.db.votes.windowCounts(w.id), w.desk_id ? tagBaseline(ctx.db, w.desk_id) : Promise.resolve(0)]);
  const tags = total - prev;
  const pad_json = JSON.stringify({ total, prev });
  await ctx.db.update('tally_window', { id: w.id }, { check_count: c.net, leave_count: c.leave_net, tag_count: tags, pad_json });
  if (tags !== c.net) {
    await accessLog(ctx, w.station_id, 'close', null, 'mismatch', `꼬리표 누적 ${total} / 체크 누적 ${prev + c.net}`);
    const diff = tags - c.net;
    throw new HttpError(409, 'mismatch', `꼬리표 수와 체크 인원이 다릅니다. 꼬리표가 ${Math.abs(diff)}장 ${diff > 0 ? '많습니다' : '적습니다'}. (입력한 꼬리표 ${total}장 · 시스템 ${prev + c.net}명)`, { check_count: c.net, tag_count: tags, diff, total, expected: prev + c.net });
  }
  const done: TallyWindow = { ...w, status: 'matched', check_count: c.net, leave_count: c.leave_net, tag_count: tags, accepted_count: c.net, matched_at: nowIso(), matched_by_name: whoName(ctx), pad_json };
  await ctx.db.update('tally_window', { id: w.id }, { status: done.status, accepted_count: done.accepted_count, matched_at: done.matched_at, matched_by_name: done.matched_by_name });
  await accessLog(ctx, w.station_id, 'close', null, 'matched', `${c.net}명 · 누적 ${total}장`);
  await log(ctx.db, actorOf(ctx), 'tally.match', { station_id: w.station_id, note: `마감 ${hm(Date.parse(w.boundary_at))} · 체크 ${c.net} = 꼬리표 ${tags} (누적 ${total})` });
  await syncEntriesForWindow(ctx.db, actorOf(ctx), done);
  return { window: done };
});

route('POST', '/roster/close/:id/adjust', async (ctx) => {
  const me = requireAdmin(ctx);
  await rosterGate(ctx);
  const w = await loadReconciling(ctx, me, ctx.params.id);
  const reason = str(ctx.req.body?.reason, '조정 사유', 300);
  const accepted = int(ctx.req.body?.accepted_count, '인정 인원');
  const [c, prev] = await Promise.all([ctx.db.votes.windowCounts(w.id), w.desk_id ? tagBaseline(ctx.db, w.desk_id) : Promise.resolve(0)]);
  // 꼬리표 누적 수: 총관리자가 새로 넣었으면 그 값, 아니면 근무자가 마지막으로 넣은 값, 둘 다 없으면 인정 인원만큼 늘어난 것으로 본다 (FR-113)
  const given = ctx.req.body?.total;
  const total = given !== undefined && given !== null && given !== '' ? int(given, '꼬리표 누적 수') : tagTotalOf(w)?.total ?? prev + accepted;
  const tags = total - prev;
  const done: TallyWindow = {
    ...w, status: 'adjusted', check_count: c.net, leave_count: c.leave_net, tag_count: tags, accepted_count: accepted,
    adjustment: accepted - c.net, adjust_reason: reason, matched_at: nowIso(), matched_by_name: me.name, pad_json: JSON.stringify({ total, prev }),
  };
  const { id: _id, ...patch } = done;
  await ctx.db.update('tally_window', { id: w.id }, patch);
  await accessLog(ctx, w.station_id, 'adjust', null, 'adjusted', `체크 ${c.net} · 꼬리표 ${tags} (누적 ${total}) · 인정 ${accepted} · ${reason}`);
  await log(ctx.db, me, 'tally.adjust', { station_id: w.station_id, before_json: JSON.stringify({ check_count: c.net, tag_count: tags, tag_total: total }), after_json: JSON.stringify({ accepted_count: accepted, adjustment: accepted - c.net }), note: reason });
  await syncEntriesForWindow(ctx.db, me, done);
  return { window: done };
});

route('GET', '/roster/windows', async (ctx) => {
  const me = requireAuth(ctx);
  const cfg = await loadConfig(ctx.db);
  const [all, extras, desks, issues] = await Promise.all([
    ctx.db.all<TallyWindow>('tally_window', undefined, 'boundary_at'),
    tallyExtras(ctx.db, cfg.days, cfg.stations, cfg.election.extension_enabled),
    allDesks(ctx.db), ctx.db.all<TagIssue>('tag_issue').catch(() => [] as TagIssue[]),
  ]);
  // 투표소 계정은 자기 투표소의 모든 창구 (FR-94c, 15.13). 총관리자·선관위원은 전체 열람
  const mine = (id: string) => me.role !== 'station' || id === me.station_id;
  const wins = all.filter((w) => mine(w.station_id)).map((w) => {
    const { pad_json: _p, ...rest } = w;
    return { ...rest, desk_name: desks.find((d) => d.id === w.desk_id)?.name ?? null, tag_total: tagTotalOf(w)?.total ?? null, issue_count: issues.filter((i) => i.window_id === w.id && !i.voided_at).length };
  });
  return {
    windows: wins, stations: extras.stations.filter((s) => mine(s.station_id)),
    desks: desks.filter((d) => mine(d.station_id) && !d.merged_into).map(deskView),
    my_desk_id: ctx.device?.desk_id ?? null, server_now: nowIso(),
  };
});

// ---------- 명부 관리 (15.2) ----------
route('GET', '/roster/summary', async (ctx) => {
  requireAdmin(ctx);
  const el = await election(ctx.db);
  const [counts, events, wins] = await Promise.all([ctx.db.votes.rosterCounts(), ctx.db.count('ballot_event'), ctx.db.all<TallyWindow>('tally_window')]);
  const purgeFrom = el.result_announced_on ? new Date(Date.parse(`${el.result_announced_on}T00:00:00+09:00`) + el.retention_days * 86400000) : null;
  return {
    counts, event_count: events, uploading: el.roster_upload ? JSON.parse(el.roster_upload) : null,
    last_backup_at: el.last_backup_at,
    closes_since_backup: wins.filter((w) => w.matched_at && (!el.last_backup_at || w.matched_at > el.last_backup_at)).length,
    result_announced_on: el.result_announced_on, retention_days: el.retention_days, purged_at: el.purged_at,
    purge_available_from: purgeFrom ? kstDate(purgeFrom.getTime()) : null,
    purge_available: !!purgeFrom && Date.now() >= purgeFrom.getTime() && !el.purged_at,
    keys_configured: !!process.env.VOTER_ENC_KEY && !!process.env.VOTER_HMAC_KEY,
  };
});

route('POST', '/roster/upload/begin', async (ctx) => {
  const me = requireAdmin(ctx);
  const { el } = await rosterGate(ctx);
  const kind: VoterKind = ctx.req.body?.kind === 'associate' ? 'associate' : ctx.req.body?.kind === 'regular' ? 'regular' : (() => { throw new HttpError(400, 'bad_request', '명부 종류를 고르세요.'); })();
  if ((await ctx.db.count('ballot_event')) > 0) throw new HttpError(409, 'has_checks', '체크 기록이 있어 명부를 교체할 수 없습니다. 리허설 후라면 설정 화면의 전체 초기화를 먼저 하세요.');
  if (el.roster_upload) {
    const prev = JSON.parse(el.roster_upload) as { id: string };
    await ctx.db.remove('voter', { batch_id: prev.id });
  }
  await ctx.db.remove('voter', { kind });
  const id = randomUUID();
  await ctx.db.update('election', { id: 'main' }, { roster_upload: JSON.stringify({ id, kind, at: nowIso(), by: me.name }) });
  return { upload_id: id };
});

async function currentUpload(db: Db, uploadId: unknown) {
  const el = await election(db);
  const up = el.roster_upload ? (JSON.parse(el.roster_upload) as { id: string; kind: VoterKind }) : null;
  if (!up || up.id !== uploadId) throw new HttpError(409, 'no_upload', '진행 중인 업로드가 아닙니다. 처음부터 다시 올리세요.');
  return up;
}

route('POST', '/roster/upload/chunk', async (ctx) => {
  requireAdmin(ctx);
  const up = await currentUpload(ctx.db, ctx.req.body?.upload_id);
  const rows = ctx.req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 1000) throw new HttpError(400, 'bad_request', '한 번에 1~1,000행만 보낼 수 있습니다.');
  const districts = new Set((await ctx.db.all<District>('district')).map((d) => d.id));
  const now = nowIso();
  const sids: string[] = [];
  const voters: Voter[] = rows.map((r: any, i: number) => {
    const sid = normalizeSid(r?.sid);
    const name = String(r?.name ?? '').trim();
    const dept = String(r?.dept ?? '').trim();
    if (sid.length < 4 || sid.length > 20 || !name || name.length > 50 || dept.length > 100 || !districts.has(r?.district_id)) {
      throw new HttpError(400, 'bad_row', `${i + 1}번째 행의 값이 올바르지 않습니다.`);
    }
    sids.push(sid);
    return {
      id: randomUUID(), sid_hash: hashSid(sid), name_enc: encrypt(name), dept_enc: encrypt(dept), district_id: r.district_id, kind: up.kind,
      voted_at: null, voted_station_id: null, voted_event_id: null, batch_id: up.id, source: 'upload', created_at: now,
    };
  });
  await addDepts(ctx.db, rows.map((r: any) => ({ district_id: String(r?.district_id ?? ''), name: String(r?.dept ?? '').trim() }))).catch(() => undefined);
  try {
    await ctx.db.insertMany('voter', voters);
  } catch {
    const existing = new Set((await ctx.db.allIn<Voter>('voter', 'sid_hash', voters.map((v) => v.sid_hash))).map((v) => v.sid_hash));
    const dupes = voters.map((v, i) => (existing.has(v.sid_hash) ? sids[i] : null)).filter(Boolean);
    throw new HttpError(409, 'duplicate', dupes.length ? `이미 등록된 학번이 있습니다 (다른 종류 명부 포함): ${dupes.slice(0, 20).join(', ')}${dupes.length > 20 ? ` 외 ${dupes.length - 20}건` : ''}` : '저장하지 못했습니다. 다시 시도하세요.', { duplicates: dupes });
  }
  return { ok: true, inserted: voters.length };
});

route('POST', '/roster/upload/finish', async (ctx) => {
  const me = requireAdmin(ctx);
  const up = await currentUpload(ctx.db, ctx.req.body?.upload_id);
  const expected = int(ctx.req.body?.expected, '행 수', 1);
  const n = await ctx.db.count('voter', { batch_id: up.id });
  if (n !== expected) throw new HttpError(409, 'count_mismatch', `서버에 저장된 행 수(${n})가 파일 행 수(${expected})와 다릅니다. 다시 올리세요.`);
  await ctx.db.update('voter', { batch_id: up.id }, { batch_id: null });
  await ctx.db.update('election', { id: 'main' }, { roster_upload: null });
  // 학과 목록을 새 명부에 맞춘다 (예전 업로드의 학과가 남지 않게). 투표소 기기가 창구 목록을 열 때 기다리지 않도록 여기서 끝낸다.
  // 실패하면 비워 두고, 창구 목록을 처음 열 때 다시 만든다
  await rebuildDepts(ctx.db).catch(() => ctx.db.removeAll('dept').catch(() => undefined));
  await recomputeBaseVoters(ctx.db, me);
  const label = up.kind === 'regular' ? '정회원' : '준회원';
  await log(ctx.db, me, 'roster.upload', { note: `${label} ${n}명` });
  await accessLog(ctx, null, 'upload', null, up.kind, `${label} ${n}명`);
  return { ok: true, count: n };
});

route('POST', '/roster/upload/abort', async (ctx) => {
  requireAdmin(ctx);
  const el = await election(ctx.db);
  const up = el.roster_upload ? (JSON.parse(el.roster_upload) as { id: string }) : null;
  if (up && (!ctx.req.body?.upload_id || up.id === ctx.req.body.upload_id)) {
    await ctx.db.remove('voter', { batch_id: up.id });
    await ctx.db.update('election', { id: 'main' }, { roster_upload: null });
  }
  return { ok: true };
});

/** 개별 추가 (FR-82) */
route('POST', '/roster/voters', async (ctx) => {
  const me = requireAdmin(ctx);
  await rosterGate(ctx);
  const b = ctx.req.body ?? {};
  const sid = normalizeSid(b.sid);
  if (sid.length < 4 || sid.length > 20) throw new HttpError(400, 'bad_sid', '학번을 확인하세요.');
  const name = str(b.name, '이름', 50);
  const dept = typeof b.dept === 'string' ? b.dept.trim().slice(0, 100) : '';
  const reason = str(b.reason, '사유', 300);
  const kind: VoterKind = b.kind === 'associate' ? 'associate' : 'regular';
  if (!(await ctx.db.get<District>('district', { id: b.district_id }))) throw new HttpError(400, 'bad_request', '선거구를 고르세요.');
  const h = hashSid(sid);
  if (await ctx.db.get<Voter>('voter', { sid_hash: h })) throw new HttpError(409, 'exists', '이미 명부에 있는 학번입니다.');
  await ctx.db.insert<Voter>('voter', {
    id: randomUUID(), sid_hash: h, name_enc: encrypt(name), dept_enc: encrypt(dept), district_id: b.district_id, kind,
    voted_at: null, voted_station_id: null, voted_event_id: null, batch_id: null, source: 'manual', created_at: nowIso(),
  });
  await addDepts(ctx.db, [{ district_id: b.district_id, name: dept }]).catch(() => undefined);
  await recomputeBaseVoters(ctx.db, me);
  await accessLog(ctx, null, 'voter.add', h, kind, reason);
  await log(ctx.db, me, 'roster.add', { note: `${kind === 'regular' ? '정회원' : '준회원'} 1명 추가 · ${reason}` });
  return { ok: true };
});

/** 개별 정정: 학적·선거구 변경 (FR-82) */
route('PUT', '/roster/voters', async (ctx) => {
  const me = requireAdmin(ctx);
  await rosterGate(ctx);
  const b = ctx.req.body ?? {};
  const h = hashSid(normalizeSid(b.sid));
  const reason = str(b.reason, '사유', 300);
  const v = await ctx.db.get<Voter>('voter', { sid_hash: h, batch_id: null });
  if (!v) { await accessLog(ctx, null, 'voter.edit', h, 'not_found'); throw new HttpError(404, 'not_found', '명부에 없는 학번입니다.'); }
  const patch: Partial<Voter> = {};
  if (b.kind === 'regular' || b.kind === 'associate') patch.kind = b.kind;
  if (b.district_id && b.district_id !== v.district_id) {
    if (v.voted_at) throw new HttpError(409, 'voted', '이미 투표한 선거인의 선거구는 바꿀 수 없습니다.');
    if (!(await ctx.db.get<District>('district', { id: b.district_id }))) throw new HttpError(400, 'bad_request', '선거구를 고르세요.');
    patch.district_id = b.district_id;
  }
  if (patch.kind && patch.kind !== v.kind && v.voted_at) throw new HttpError(409, 'voted', '이미 투표한 선거인의 학적은 바꿀 수 없습니다. 체크를 먼저 취소하세요.');
  if (!Object.keys(patch).length) throw new HttpError(400, 'bad_request', '바뀐 내용이 없습니다.');
  await ctx.db.update('voter', { id: v.id }, patch);
  await recomputeBaseVoters(ctx.db, me);
  await accessLog(ctx, null, 'voter.edit', h, 'ok', `${JSON.stringify(patch)} · ${reason}`);
  await log(ctx.db, me, 'roster.edit', { note: reason });
  return { ok: true };
});

/**
 * 전체 초기화 (FR-116): 선거인명부·설정·계정만 남기고 투표 전 상태로 되돌린다.
 * 체크·투표 여부, 마감·대조, 창구·이슈, 입력값·수정요청, 변경 로그·접근 로그, 기기 접속·담당자 이력을 모두 지운다.
 */
route('POST', '/reset-all', async (ctx) => {
  const me = requireAdmin(ctx);
  if (String(ctx.req.body?.confirm ?? '').normalize('NFC').trim() !== '전체초기화') throw new HttpError(400, 'bad_request', '확인 문구가 맞지 않습니다.');
  await assertNotElectionDay(ctx.db, '전체 초기화');
  await ctx.db.votes.resetChecks();
  await resetDeskData(ctx.db);
  for (const t of ['change_request', 'entry', 'audit_log', 'voter_access_log', 'operator_log', 'device_session']) await ctx.db.removeAll(t);
  for (const m of await ctx.db.all<Member>('member')) {
    if (m.failed_count || m.locked_until || m.pledged_at || m.last_login_at) await ctx.db.update('member', { id: m.id }, { failed_count: 0, locked_until: null, pledged_at: null, last_login_at: null });
  }
  await ctx.db.update('election', { id: 'main' }, { last_backup_at: null });
  await log(ctx.db, me, 'system.reset', { note: '전체 초기화 (선거인명부·설정·계정만 유지)' });
  await accessLog(ctx, null, 'reset_all', null, 'ok');
  return { ok: true };
});

// ---------- 백업·복원 (FR-96) ----------
const BACKUP_PAGE = 3000; // 한 번 응답이 Vercel 한도(4.5MB)를 넘지 않게 나눠 준다
/** 백업 자료를 나눠서 준다. CSV는 브라우저가 합쳐 만든다 (FR-96, FR-96a). */
route('GET', '/roster/backup/data', async (ctx) => {
  requireAdmin(ctx);
  const offset = int(ctx.req.query.offset ?? 0, 'offset');
  const [events, total, wins] = await Promise.all([
    ctx.db.all<BallotEvent>('ballot_event', undefined, 'at, id', BACKUP_PAGE, offset),
    ctx.db.count('ballot_event'),
    offset === 0 ? ctx.db.all<TallyWindow>('tally_window', undefined, 'boundary_at') : Promise.resolve([] as TallyWindow[]),
  ]);
  // v1.4: 창구·묶음·마감별 번호·이동·이슈도 첫 쪽에 함께 (FR-106)
  const extra = offset === 0 ? {
    desks: await ctx.db.all<Desk>('desk'), pads: await ctx.db.all<BallotPad>('ballot_pad'), readings: await ctx.db.all<PadReading>('pad_reading'),
    moves: await ctx.db.all<PadMove>('pad_move'), issues: await ctx.db.all<TagIssue>('tag_issue'),
  } : { desks: [], pads: [], readings: [], moves: [], issues: [] };
  return { status: 200, body: { events, windows: wins, ...extra, total, page: BACKUP_PAGE }, headers: { 'Cache-Control': 'no-store' } } satisfies ApiResponse;
});

/** 백업 파일 저장을 마쳤다고 기록. 자동 백업이면 로그인도 연장한다 (자정까지만). */
route('POST', '/roster/backup/done', async (ctx) => {
  const me = requireAdmin(ctx);
  const auto = ctx.req.body?.auto === true;
  const at = nowIso();
  await ctx.db.update('election', { id: 'main' }, { last_backup_at: at });
  await accessLog(ctx, null, 'backup', null, 'ok', `${auto ? '자동 · ' : ''}체크 ${int(ctx.req.body?.events ?? 0, '체크 수')}건 · 마감 ${int(ctx.req.body?.windows ?? 0, '마감 수')}건`);
  if (!auto) return { ok: true, at };
  const exp = renewedExpiry();
  return {
    status: 200, body: { ok: true, at, session_expires_at: new Date(exp).toISOString() },
    headers: { 'Set-Cookie': cookieHeader(createSessionToken(me.id, me.code_version, { exp }), exp - Date.now()) },
  } satisfies ApiResponse;
});

route('POST', '/roster/restore/chunk', async (ctx) => {
  requireAdmin(ctx);
  const b = ctx.req.body ?? {};
  if (b.first === true && ((await ctx.db.count('ballot_event')) > 0 || (await ctx.db.count('tally_window')) > 0)) {
    throw new HttpError(409, 'not_empty', '체크 기록이 비어 있을 때만 복원할 수 있습니다. 설정 화면의 전체 초기화 후 다시 시도하세요.');
  }
  if (b.first === true) {
    // v1.4 부가 자료: 백업에 있는 그대로 다시 넣는다 (서버가 만든 행이므로 열 구성이 같다)
    await resetDeskData(ctx.db);
    const rowsOf = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]).filter((r) => r && typeof r.id === 'string') : []);
    const extraRows = rowsOf(b.desks).length + rowsOf(b.pads).length + rowsOf(b.readings).length + rowsOf(b.moves).length + rowsOf(b.issues).length;
    if (extraRows > 20000) throw new HttpError(400, 'bad_request', '부가 자료가 너무 많습니다.');
    await ctx.db.insertMany('desk', rowsOf(b.desks));
    await ctx.db.insertMany('ballot_pad', rowsOf(b.pads));
    await ctx.db.insertMany('pad_reading', rowsOf(b.readings));
    await ctx.db.insertMany('pad_move', rowsOf(b.moves));
    await ctx.db.insertMany('tag_issue', rowsOf(b.issues));
  }
  const wins = Array.isArray(b.windows) ? (b.windows as TallyWindow[]) : [];
  const events = Array.isArray(b.events) ? (b.events as BallotEvent[]) : [];
  if (wins.length + events.length > 1000) throw new HttpError(400, 'bad_request', '한 번에 1,000건까지 보낼 수 있습니다.');
  const pickW = (w: TallyWindow): TallyWindow => ({
    id: String(w.id), station_id: String(w.station_id), date: String(w.date), opened_at: String(w.opened_at), boundary_at: String(w.boundary_at),
    status: w.status, check_count: Number(w.check_count), leave_count: Number(w.leave_count), tag_count: w.tag_count ?? null, accepted_count: w.accepted_count ?? null,
    adjustment: Number(w.adjustment ?? 0), adjust_reason: w.adjust_reason ?? null, closed_by: String(w.closed_by), closed_by_name: String(w.closed_by_name),
    matched_at: w.matched_at ?? null, matched_by_name: w.matched_by_name ?? null,
    ...(w.operator_name ? { operator_name: String(w.operator_name) } : {}),
    ...(w.desk_id ? { desk_id: String(w.desk_id) } : {}), ...(w.pad_json ? { pad_json: String(w.pad_json) } : {}),
  });
  const pickE = (e: BallotEvent): BallotEvent => ({
    id: String(e.id), voter_id: String(e.voter_id), voter_sid_hash: String(e.voter_sid_hash), station_id: String(e.station_id), kind: e.kind === 'cancel' ? 'cancel' : 'issue',
    ref_event_id: e.ref_event_id ?? null, is_leave: e.is_leave === true || (e.is_leave as unknown) === 1, at: String(e.at), actor_id: String(e.actor_id), actor_name: String(e.actor_name),
    window_id: e.window_id ?? null, source: e.source ?? 'restore', reason: e.reason ?? null,
    ...(e.operator_name ? { operator_name: String(e.operator_name) } : {}), ...(e.device_id ? { device_id: String(e.device_id) } : {}),
    ...(e.desk_id ? { desk_id: String(e.desk_id) } : {}),
  });
  await ctx.db.insertMany('tally_window', wins.map(pickW));
  await ctx.db.insertMany('ballot_event', events.map(pickE));
  return { ok: true };
});

route('POST', '/roster/restore/finish', async (ctx) => {
  const me = requireAdmin(ctx);
  if (String(ctx.req.body?.confirm ?? '').normalize('NFC').trim() !== '복원') throw new HttpError(400, 'bad_request', '확인 문구가 맞지 않습니다.');
  const n = await ctx.db.votes.rebuildVoterState();
  await resyncAllEntries(ctx.db, me);
  await log(ctx.db, me, 'roster.restore', { note: `백업 복원 · 투표 상태 ${n}명` });
  await accessLog(ctx, null, 'restore', null, 'ok', `${n}명`);
  return { ok: true, voted: n };
});

// ---------- 장애 기록 시트 (FR-98) ----------
async function classifySheet(db: Db, rows: any[]) {
  if (!Array.isArray(rows) || rows.length > 3000) throw new HttpError(400, 'bad_request', '한 번에 3,000행까지 처리할 수 있습니다.');
  const stations = await db.all<Station>('station');
  const prepared = rows.map((r, index) => {
    const sid = normalizeSid(r?.sid);
    const st = stations.find((s) => s.name === String(r?.station ?? '').trim());
    const date = String(r?.date ?? '').trim();
    const time = String(r?.time ?? '').trim().padStart(5, '0');
    const at = DATE_RE.test(date) && TIME_RE.test(time) ? new Date(slotEpoch(date, time)).toISOString() : null;
    return { index, sid, station: st ?? null, at, desk: String(r?.desk ?? '').trim(), recorder: String(r?.recorder ?? '').trim().slice(0, 50), hash: sid.length >= 4 ? hashSid(sid) : '' };
  });
  const voters = await db.allIn<Voter>('voter', 'sid_hash', [...new Set(prepared.map((p) => p.hash).filter(Boolean))], { batch_id: null });
  const seen = new Set<string>();
  return prepared.map((p) => {
    const base = { index: p.index, sid: p.sid, station: p.station?.name ?? null, at: p.at };
    if (!p.hash || !p.station || !p.at) return { ...base, status: 'invalid' as const };
    if (seen.has(p.hash)) return { ...base, status: 'dup_in_sheet' as const };
    seen.add(p.hash);
    const v = voters.find((x) => x.sid_hash === p.hash);
    if (!v) return { ...base, status: 'not_found' as const };
    if (v.district_id !== p.station.district_id) return { ...base, status: 'other_district' as const };
    if (v.voted_at) return { ...base, status: 'voted' as const };
    return { ...base, status: 'ok' as const, _voter: v, _station: p.station, _recorder: p.recorder, _desk: p.desk };
  });
}

route('POST', '/roster/sheet/preview', async (ctx) => {
  const me = requireAdmin(ctx);
  await rosterGate(ctx, { needReady: true });
  const res = await classifySheet(ctx.db, ctx.req.body?.rows);
  await accessLog(ctx, null, 'sheet.preview', null, 'ok', `${res.length}행`);
  return { rows: res.map(({ _voter, _station, _recorder, _desk, ...r }: any) => r) };
});

route('POST', '/roster/sheet/apply', async (ctx) => {
  const me = requireAdmin(ctx);
  await rosterGate(ctx, { needReady: true });
  const res = await classifySheet(ctx.db, ctx.req.body?.rows);
  let applied = 0, failed = 0, unassigned = 0;
  // 창구 열이 비었거나 이름이 맞지 않으면 "창구 미지정"으로 (FR-110)
  const deskCache = new Map<string, Desk[]>();
  for (const r of res as any[]) {
    if (r.status !== 'ok') continue;
    if (!deskCache.has(r._station.id)) deskCache.set(r._station.id, await stationDesks(ctx.db, r._station.id));
    let desk = deskCache.get(r._station.id)!.find((d) => !d.is_unassigned && d.name === r._desk);
    if (!desk) { desk = await unassignedDesk(ctx.db, r._station.id, me.name); unassigned++; }
    const out = await ctx.db.votes.issue({
      event_id: randomUUID(), voter_id: r._voter.id, sid_hash: r._voter.sid_hash, station_id: r._station.id, at: r.at,
      actor_id: me.id, actor_name: `${r._recorder || me.name}(장애 시트)`, source: 'sheet', window_id: null, reason: '장애 기록 시트 반영',
      operator_name: null, device_id: null, desk_id: desk.id,
    });
    if (out.ok) applied++; else failed++;
  }
  await log(ctx.db, me, 'roster.sheet', { note: `장애 시트 반영 ${applied}명${failed ? ` · 이미 투표 ${failed}명` : ''}` });
  await accessLog(ctx, null, 'sheet.apply', null, 'ok', `${applied}명`);
  return { applied, failed, unassigned };
});

// ---------- 학번 일괄 대조 (FR-120) ----------
/** 손으로 적어 둔 학번 목록을 넣으면 학번마다 체크 여부를 알려 준다. 읽기만 한다. */
route('POST', '/roster/check-sids', async (ctx) => {
  requireAdmin(ctx);
  const raw: unknown[] = Array.isArray(ctx.req.body?.sids) ? ctx.req.body.sids : [];
  if (raw.length === 0) throw new HttpError(400, 'bad_request', '학번을 넣으세요.');
  if (raw.length > 500) throw new HttpError(400, 'bad_request', '한 번에 500개까지 대조할 수 있습니다.');
  const pl = await places(ctx.db);
  const seen = new Set<string>();
  const rows: Record<string, unknown>[] = [];
  const todo: { sid: string; row: Record<string, unknown> }[] = [];
  for (const x of raw) {
    const sid = normalizeSid(x);
    const row: Record<string, unknown> = { sid };
    rows.push(row);
    if (sid.length < 4 || sid.length > 20) row.result = 'bad';
    else if (seen.has(sid)) row.result = 'duplicate';
    else { seen.add(sid); todo.push({ sid, row }); }
  }
  for (let i = 0; i < todo.length; i += 25) {
    await Promise.all(todo.slice(i, i + 25).map(async ({ sid, row }) => {
      const v = await ctx.db.get<Voter>('voter', { sid_hash: hashSid(sid), batch_id: null });
      if (!v) { row.result = 'not_found'; return; }
      const { name, dept, kind } = voterView(v);
      Object.assign(row, {
        result: v.voted_at ? 'voted' : 'not_voted', name, dept, kind, voted_at: v.voted_at,
        voted_station_name: v.voted_at ? pl.stations.find((s) => s.id === v.voted_station_id)?.name ?? '' : '',
      });
    }));
  }
  const n = (r: string) => rows.filter((x) => x.result === r).length;
  await accessLog(ctx, null, 'check_sids', null, 'ok', `${rows.length}건 · 미체크 ${n('not_voted')} · 체크됨 ${n('voted')} · 명부에 없음 ${n('not_found')}`);
  return { status: 200, body: { rows }, headers: { 'Cache-Control': 'no-store' } } satisfies ApiResponse;
});

// ---------- 보유기간·파기 (FR-99) ----------
route('PUT', '/roster/retention', async (ctx) => {
  const me = requireAdmin(ctx);
  const b = ctx.req.body ?? {};
  const on = b.result_announced_on ? String(b.result_announced_on) : null;
  if (on && !DATE_RE.test(on)) throw new HttpError(400, 'bad_request', '날짜 형식이 올바르지 않습니다.');
  const days = int(b.retention_days ?? 7, '보유일수');
  await ctx.db.update('election', { id: 'main' }, { result_announced_on: on, retention_days: days });
  await log(ctx.db, me, 'roster.retention', { note: `결과 공고일 ${on ?? '미정'} · 보유 ${days}일` });
  return { ok: true };
});

route('POST', '/roster/purge', async (ctx) => {
  const me = requireAdmin(ctx);
  const el = await election(ctx.db);
  if (String(ctx.req.body?.confirm ?? '').normalize('NFC').trim() !== '명부파기') throw new HttpError(400, 'bad_request', '확인 문구가 맞지 않습니다.');
  await assertNotElectionDay(ctx.db, '파기');
  if (!el.result_announced_on) throw new HttpError(409, 'no_date', '결과 공고일을 먼저 입력하세요.');
  const from = Date.parse(`${el.result_announced_on}T00:00:00+09:00`) + el.retention_days * 86400000;
  if (Date.now() < from) throw new HttpError(409, 'too_early', `${kstDate(from)}부터 파기할 수 있습니다.`);
  await ctx.db.votes.purge();
  await ctx.db.update('election', { id: 'main' }, { purged_at: nowIso() });
  await log(ctx.db, me, 'roster.purge', { note: '선거인명부·체크 기록 파기' });
  await accessLog(ctx, null, 'purge', null, 'ok');
  return { ok: true };
});

// ---------- 접근 로그 (FR-95) ----------
route('GET', '/roster/access-log', async (ctx) => {
  requireAdmin(ctx);
  const limit = Math.min(int(ctx.req.query.limit ?? 500, 'limit', 1), 5000);
  const where: Record<string, string> = {};
  if (ctx.req.query.member_id) where.member_id = ctx.req.query.member_id;
  if (ctx.req.query.action) where.action = ctx.req.query.action;
  return { log: await ctx.db.all<VoterAccessLog>('voter_access_log', where, 'at desc', limit) };
});
