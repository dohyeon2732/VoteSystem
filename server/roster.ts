/**
 * 선거인명부 확인·투표용지 불출·꼬리표 대조·근무표 (명세 v1.1 15절)
 */
import { randomUUID } from 'node:crypto';
import {
  HttpError, TIME_RE, int, loadConfig, log, requireAdmin, requireAuth, route, str, type ApiResponse, type Ctx,
} from './core.js';
import type {
  BallotEvent, BallotSource, Db, District, Election, ElectionDay, Entry, Member, Shift, Slot, Station, TallyWindow,
  Voter, VoterAccessLog, VoterKind,
} from './db/types.js';
import { nowIso, slotEpoch } from './logic/time.js';
import { decrypt, encrypt, hashSid, normalizeSid } from './voterCrypto.js';

const MIN = 60 * 1000;
const SHIFT_GRACE_MS = 15 * MIN;      // 근무 시작 15분 전 ~ 종료 15분 후
const OWN_CANCEL_MS = 5 * MIN;        // 본인 취소 5분
const SLOT_MATCH_MS = 10 * MIN;       // 시점 ±10분 안의 마감
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

async function accessLog(db: Db, me: Member, stationId: string | null, action: string, sidHash: string | null, result: string | null, note: string | null = null) {
  await db.insert<VoterAccessLog>('voter_access_log', {
    id: randomUUID(), at: nowIso(), member_id: me.id, member_name: me.name, station_id: stationId,
    action, sid_hash8: sidHash ? sidHash.slice(0, 8) : null, result, note,
  });
}

const lookupTimes = new Map<string, number[]>();
function rateLimit(memberId: string) {
  const now = Date.now();
  const list = (lookupTimes.get(memberId) ?? []).filter((t) => now - t < MIN);
  if (list.length >= LOOKUPS_PER_MIN) {
    lookupTimes.set(memberId, list);
    return false;
  }
  list.push(now);
  lookupTimes.set(memberId, list);
  return true;
}

/** 지금 근무 중인 근무표 행 (시작 15분 전 ~ 종료 15분 후). */
async function activeShift(db: Db, memberId: string, now = Date.now()): Promise<Shift | null> {
  const shifts = await db.all<Shift>('shift', { member_id: memberId, date: kstDate(now) });
  return shifts.find((s) => now >= slotEpoch(s.date, s.start_time) - SHIFT_GRACE_MS && now <= slotEpoch(s.date, s.end_time) + SHIFT_GRACE_MS) ?? null;
}

/**
 * 투표소·선거구는 선거 중 거의 바뀌지 않으므로 서버 인스턴스 메모리에 60초 보관한다.
 * 조회 한 번에 DB 왕복을 줄이기 위함 (이름을 바꾸면 같은 인스턴스는 즉시, 다른 인스턴스는 60초 안에 반영).
 */
const PLACE_TTL_MS = 60_000;
let placeCache: { at: number; stations: Station[]; districts: District[] } | null = null;
async function places(db: Db) {
  if (placeCache && Date.now() - placeCache.at < PLACE_TTL_MS) return placeCache;
  const [stations, districts] = await Promise.all([db.all<Station>('station', undefined, 'sort'), db.all<District>('district', undefined, 'sort')]);
  placeCache = { at: Date.now(), stations, districts };
  return placeCache;
}
export function invalidatePlaces() { placeCache = null; }

function checkGate(me: Member, el: Election, needReady?: boolean) {
  if (el.purged_at) throw new HttpError(410, 'purged', '선거인명부가 파기되었습니다.');
  if (!me.pledged_at) throw new HttpError(403, 'pledge_required', '개인정보 취급 서약에 먼저 동의해야 합니다.');
  if (needReady && el.roster_upload) throw new HttpError(503, 'uploading', '선거인명부 업로드가 진행 중입니다. 끝난 뒤 다시 시도하세요.');
}

/** 명부 기능 공통 검사: 서약, 파기 여부, 업로드 진행 여부. */
async function rosterGate(ctx: Ctx, opts: { needReady?: boolean } = {}) {
  const me = requireAuth(ctx);
  const el = await election(ctx.db);
  checkGate(me, el, opts.needReady);
  return { me, el };
}

/** 검사 + 근무 투표소 확인을 DB 왕복 한 번(병렬)으로 끝낸다. 학번 조회·불출처럼 자주 부르는 곳에서 쓴다. */
async function gateAt(ctx: Ctx, stationId: unknown, opts: { needReady?: boolean } = {}) {
  const me = requireAuth(ctx);
  const [el, pl, shift] = await Promise.all([
    election(ctx.db), places(ctx.db), me.role === 'admin' ? Promise.resolve(null) : activeShift(ctx.db, me.id),
  ]);
  checkGate(me, el, opts.needReady);
  const { station } = await resolveStation(ctx, me, stationId, pl.stations, shift);
  return { me, el, station, shift, pl };
}

/** 위원은 근무 중인 투표소만, 총관리자는 지정한 투표소. */
async function stationFor(ctx: Ctx, me: Member, stationId: unknown): Promise<{ station: Station; shift: Shift | null }> {
  const [pl, shift] = await Promise.all([places(ctx.db), me.role === 'admin' ? Promise.resolve(null) : activeShift(ctx.db, me.id)]);
  return resolveStation(ctx, me, stationId, pl.stations, shift);
}

async function resolveStation(ctx: Ctx, me: Member, stationId: unknown, stations: Station[], shift: Shift | null): Promise<{ station: Station; shift: Shift | null }> {
  if (me.role === 'admin') {
    const station = stations.find((s) => s.id === stationId);
    if (!station) throw new HttpError(400, 'station_required', '투표소를 선택하세요.');
    return { station, shift: null };
  }
  if (!shift) {
    await accessLog(ctx.db, me, typeof stationId === 'string' ? stationId : null, 'denied', null, 'no_shift');
    throw new HttpError(403, 'no_shift', '지금은 근무 시간이 아닙니다. 근무표를 확인하세요.');
  }
  if (stationId && stationId !== shift.station_id) {
    await accessLog(ctx.db, me, String(stationId), 'denied', null, 'wrong_station');
    throw new HttpError(403, 'wrong_station', '근무 중인 투표소가 아닙니다.');
  }
  const station = stations.find((s) => s.id === shift.station_id);
  if (!station) throw new HttpError(404, 'not_found', '근무 투표소를 찾을 수 없습니다.');
  return { station, shift };
}

function voterView(v: Voter) {
  return { voter_id: v.id, name: decrypt(v.name_enc), dept: decrypt(v.dept_enc), kind: v.kind };
}

// ---------- 집계 연동 ----------
async function stationCumulative(db: Db, stationId: string, upto?: string) {
  const wins = (await db.all<TallyWindow>('tally_window', { station_id: stationId }))
    .filter((w) => w.status !== 'reconciling' && (!upto || w.boundary_at <= upto));
  return {
    cumulative: wins.reduce((a, w) => a + (w.accepted_count ?? 0), 0),
    leave: wins.reduce((a, w) => a + w.leave_count, 0),
    last: wins.sort((a, b) => a.boundary_at.localeCompare(b.boundary_at)).at(-1) ?? null,
  };
}

/** 일치한 마감 하나를 그 경계 ±10분 안의 집계 시점 입력값(entry)으로 옮긴다. */
async function syncEntriesForWindow(db: Db, actor: Member, win: TallyWindow) {
  const [slots, days] = await Promise.all([db.all<Slot>('slot', { station_id: win.station_id }), db.all<ElectionDay>('election_day')]);
  const boundary = Date.parse(win.boundary_at);
  const { cumulative, leave } = await stationCumulative(db, win.station_id, win.boundary_at);
  for (const slot of slots) {
    const day = days.find((d) => d.id === slot.day_id);
    if (!day || Math.abs(slotEpoch(day.date, slot.time) - boundary) > SLOT_MATCH_MS) continue;
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

/** 현황판에 붙이는 실시간·대조 정보 (15.6) */
export async function tallyExtras(db: Db, days: ElectionDay[], stations: Station[], extensionEnabled: boolean) {
  const active = await rosterActive(db);
  if (!active) return { roster_active: false, stations: [] };
  const [live, wins] = await Promise.all([db.votes.liveCounts(), db.all<TallyWindow>('tally_window')]);
  const dates = new Set(days.filter((d) => !d.is_extension || extensionEnabled).map((d) => d.date));
  const now = Date.now();
  return {
    roster_active: true,
    stations: stations.map((st) => {
      const l = live.find((x) => x.station_id === st.id);
      const mine = wins.filter((w) => w.station_id === st.id);
      const done = mine.filter((w) => w.status !== 'reconciling').sort((a, b) => a.boundary_at.localeCompare(b.boundary_at));
      return {
        station_id: st.id,
        live: Number(l?.net ?? 0),
        live_leave: Number(l?.leave_net ?? 0),
        open: Number(l?.open_net ?? 0),
        reconciled: done.reduce((a, w) => a + (w.accepted_count ?? 0), 0),
        reconciled_leave: done.reduce((a, w) => a + w.leave_count, 0),
        last_boundary_at: done.at(-1)?.boundary_at ?? null,
        reconciling: mine.some((w) => w.status === 'reconciling'),
        warning: stationWarning(st, mine, dates, now),
      };
    }),
  };
}

// ---------- 내 상태·서약 ----------
route('GET', '/roster/me', async (ctx) => {
  const me = requireAuth(ctx);
  const el = await election(ctx.db);
  const shift = me.role === 'admin' ? null : await activeShift(ctx.db, me.id);
  const todays = me.role === 'admin' ? [] : await ctx.db.all<Shift>('shift', { member_id: me.id, date: kstDate() }, 'start_time');
  return {
    pledged_at: me.pledged_at, role: me.role, shift, today_shifts: todays,
    roster_ready: !el.roster_upload && !el.purged_at && (await rosterActive(ctx.db)),
    uploading: !!el.roster_upload, purged: !!el.purged_at, server_now: nowIso(),
  };
});

route('POST', '/roster/pledge', async (ctx) => {
  const me = requireAuth(ctx);
  if (ctx.req.body?.agree !== true) throw new HttpError(400, 'bad_request', '서약에 동의해야 합니다.');
  const at = nowIso();
  await ctx.db.update('member', { id: me.id }, { pledged_at: at });
  await accessLog(ctx.db, me, null, 'pledge', null, 'agreed');
  return { pledged_at: at };
});

// ---------- 학번 조회·불출 (15.3) ----------
route('POST', '/roster/lookup', async (ctx) => {
  // DB 왕복 2번: ①권한 검사(설정·근무표)와 선거인 1행을 동시에 ②접근 로그. 투표소·선거구 이름은 메모리 캐시에서.
  // 선거인 행은 미리 읽지만 권한 검사를 통과해야만 응답에 쓰인다.
  const me = requireAuth(ctx);
  const sid = normalizeSid(ctx.req.body?.sid);
  if (sid.length < 4 || sid.length > 20) throw new HttpError(400, 'bad_sid', '학번을 확인하세요.');
  const h = hashSid(sid);
  const [{ station, pl }, v] = await Promise.all([
    gateAt(ctx, ctx.req.body?.station_id, { needReady: true }),
    ctx.db.get<Voter>('voter', { sid_hash: h, batch_id: null }),
  ]);
  if (!rateLimit(me.id)) {
    await accessLog(ctx.db, me, station.id, 'lookup', null, 'rate_limited');
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
  }
  await accessLog(ctx.db, me, station.id, 'lookup', h, result);
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
  let windowId: string | null = null;
  let source: BallotSource = 'live';
  if (missedId) {
    if (!w || w.station_id !== station.id || w.status !== 'reconciling') throw new HttpError(409, 'window_closed', '대조 중인 구간이 아닙니다.');
    windowId = w.id; source = 'missed';
  }
  const eventId = randomUUID();
  const r = await ctx.db.votes.issue({
    event_id: eventId, voter_id: v.id, sid_hash: v.sid_hash, station_id: station.id, at: nowIso(),
    actor_id: me.id, actor_name: me.name, source, window_id: windowId, reason: source === 'missed' ? '대조 중 누락분 추가' : null,
  });
  if (!r.ok) {
    await accessLog(ctx.db, me, station.id, 'issue', v.sid_hash, 'already_voted');
    throw new HttpError(409, 'already_voted', '이미 투표한 선거인입니다.', { voted_at: r.voted_at, voted_station_name: pl.stations.find((s) => s.id === r.voted_station_id)?.name ?? '' });
  }
  const [, counts] = await Promise.all([
    accessLog(ctx.db, me, station.id, 'issue', v.sid_hash, source === 'missed' ? 'missed' : 'ok'),
    ctx.db.votes.liveCounts(),
  ]);
  const live = counts.find((x) => x.station_id === station.id);
  return { ok: true, event_id: eventId, is_leave: r.is_leave, open_count: Number(live?.open_net ?? 0) };
});

async function doCancel(ctx: Ctx, me: Member, ev: BallotEvent, reason: string) {
  if (ev.kind !== 'issue') throw new HttpError(400, 'bad_request', '불출 기록만 취소할 수 있습니다.');
  if (me.role !== 'admin') {
    if (ev.actor_id !== me.id) throw new HttpError(403, 'forbidden', '본인이 체크한 건만 취소할 수 있습니다. 총관리자에게 요청하세요.');
    if (Date.now() - Date.parse(ev.at) > OWN_CANCEL_MS) throw new HttpError(403, 'too_late', '5분이 지나 총관리자만 취소할 수 있습니다.');
  }
  const r = await ctx.db.votes.cancel({ cancel_id: randomUUID(), issue_id: ev.id, at: nowIso(), actor_id: me.id, actor_name: me.name, reason });
  if (!r.ok) {
    const msg = r.reason === 'already_canceled' ? '이미 취소된 기록입니다.' : r.reason === 'window_closed' ? '대조가 끝난 구간의 체크는 취소할 수 없습니다. 총관리자 조정으로 처리하세요.' : '기록을 찾을 수 없습니다.';
    throw new HttpError(409, r.reason, msg);
  }
  await accessLog(ctx.db, me, ev.station_id, 'cancel', ev.voter_sid_hash, 'ok', reason);
  return { ok: true };
}

route('POST', '/roster/cancel', async (ctx) => {
  const { me } = await rosterGate(ctx);
  const reason = str(ctx.req.body?.reason, '사유', 300);
  const ev = await ctx.db.get<BallotEvent>('ballot_event', { id: str(ctx.req.body?.event_id, '기록') });
  if (!ev) throw new HttpError(404, 'not_found', '기록을 찾을 수 없습니다.');
  if (me.role !== 'admin') await stationFor(ctx, me, ev.station_id);
  return doCancel(ctx, me, ev, reason);
});

/** 총관리자: 학번으로 그 학생의 현재 불출 기록을 취소 */
route('POST', '/roster/cancel-by-sid', async (ctx) => {
  const me = requireAdmin(ctx);
  await rosterGate(ctx, { needReady: true });
  const reason = str(ctx.req.body?.reason, '사유', 300);
  const h = hashSid(normalizeSid(ctx.req.body?.sid));
  const v = await ctx.db.get<Voter>('voter', { sid_hash: h, batch_id: null });
  if (!v) { await accessLog(ctx.db, me, null, 'cancel', h, 'not_found'); throw new HttpError(404, 'not_found', '선거인명부에 없는 학번입니다.'); }
  if (!v.voted_at || !v.voted_event_id) throw new HttpError(409, 'not_voted', '투표하지 않은 선거인입니다.');
  const ev = await ctx.db.get<BallotEvent>('ballot_event', { id: v.voted_event_id });
  if (!ev) throw new HttpError(404, 'not_found', '불출 기록을 찾을 수 없습니다.');
  return doCancel(ctx, me, ev, reason);
});

// ---------- 투표소 상태·꼬리표 마감 (15.4) ----------
route('GET', '/roster/station', async (ctx) => {
  const { me, station, shift } = await gateAt(ctx, ctx.req.query.station_id);
  const [live, wins, recent] = await Promise.all([
    ctx.db.votes.liveCounts(),
    ctx.db.all<TallyWindow>('tally_window', { station_id: station.id }, 'boundary_at desc'),
    ctx.db.all<BallotEvent>('ballot_event', { actor_id: me.id, station_id: station.id, kind: 'issue' }, 'at desc', 5),
  ]);
  const canceled = new Set((await ctx.db.allIn<BallotEvent>('ballot_event', 'ref_event_id', recent.map((e) => e.id))).map((c) => c.ref_event_id));
  const reconciling = wins.find((w) => w.status === 'reconciling') ?? null;
  const l = live.find((x) => x.station_id === station.id);
  return {
    station, shift,
    open_count: Number(l?.open_net ?? 0), open_leave: Number(l?.open_leave_net ?? 0),
    reconciling: reconciling ? { ...reconciling, ...(await ctx.db.votes.windowCounts(reconciling.id)) } : null,
    last_window: wins.find((w) => w.status !== 'reconciling') ?? null,
    recent: recent.map((e) => ({ id: e.id, at: e.at, is_leave: e.is_leave, canceled: canceled.has(e.id), source: e.source })),
    server_now: nowIso(),
  };
});

route('POST', '/roster/close', async (ctx) => {
  const { me } = await rosterGate(ctx, { needReady: true });
  const { station } = await stationFor(ctx, me, ctx.req.body?.station_id);
  const wins = await ctx.db.all<TallyWindow>('tally_window', { station_id: station.id });
  if (wins.some((w) => w.status === 'reconciling')) throw new HttpError(409, 'reconciling', '대조 중인 구간이 있습니다. 먼저 꼬리표 대조를 마치세요.');
  const now = Date.now();
  const boundary = new Date(now).toISOString();
  const today = kstDate(now);
  const prev = wins.map((w) => w.boundary_at).sort().at(-1);
  const openAt = new Date(slotEpoch(today, station.open_time)).toISOString();
  const win: TallyWindow = {
    id: randomUUID(), station_id: station.id, date: today, opened_at: prev && prev > openAt ? prev : openAt, boundary_at: boundary,
    status: 'reconciling', check_count: 0, leave_count: 0, tag_count: null, accepted_count: null, adjustment: 0, adjust_reason: null,
    closed_by: me.id, closed_by_name: me.name, matched_at: null, matched_by_name: null,
  };
  await ctx.db.insert('tally_window', win);
  await ctx.db.votes.assignWindow(station.id, win.id, boundary);
  const c = await ctx.db.votes.windowCounts(win.id);
  await ctx.db.update('tally_window', { id: win.id }, { check_count: c.net, leave_count: c.leave_net });
  await accessLog(ctx.db, me, station.id, 'close', null, 'begin', `경계 ${hm(now)} · 체크 ${c.net}명`);
  return { window: { ...win, check_count: c.net, leave_count: c.leave_net, net: c.net, leave_net: c.leave_net } };
});

async function loadReconciling(ctx: Ctx, me: Member, id: string) {
  const w = await ctx.db.get<TallyWindow>('tally_window', { id });
  if (!w) throw new HttpError(404, 'not_found', '마감 기록을 찾을 수 없습니다.');
  if (w.status !== 'reconciling') throw new HttpError(409, 'not_reconciling', '이미 대조가 끝난 구간입니다.');
  if (me.role !== 'admin') await stationFor(ctx, me, w.station_id);
  return w;
}

route('POST', '/roster/close/:id/submit', async (ctx) => {
  const { me } = await rosterGate(ctx);
  const w = await loadReconciling(ctx, me, ctx.params.id);
  const tags = int(ctx.req.body?.tag_count, '꼬리표 수');
  const c = await ctx.db.votes.windowCounts(w.id);
  await ctx.db.update('tally_window', { id: w.id }, { check_count: c.net, leave_count: c.leave_net, tag_count: tags });
  if (tags !== c.net) {
    await accessLog(ctx.db, me, w.station_id, 'close', null, 'mismatch', `꼬리표 ${tags} / 체크 ${c.net}`);
    const diff = tags - c.net;
    throw new HttpError(409, 'mismatch', `꼬리표 수와 체크 인원이 다릅니다. 꼬리표가 ${Math.abs(diff)}장 ${diff > 0 ? '많습니다' : '적습니다'}.`, { check_count: c.net, tag_count: tags, diff });
  }
  const done: TallyWindow = { ...w, status: 'matched', check_count: c.net, leave_count: c.leave_net, tag_count: tags, accepted_count: c.net, matched_at: nowIso(), matched_by_name: me.name };
  await ctx.db.update('tally_window', { id: w.id }, { status: done.status, accepted_count: done.accepted_count, matched_at: done.matched_at, matched_by_name: done.matched_by_name });
  await accessLog(ctx.db, me, w.station_id, 'close', null, 'matched', `${c.net}명`);
  await log(ctx.db, me, 'tally.match', { station_id: w.station_id, note: `마감 ${hm(Date.parse(w.boundary_at))} · 체크 ${c.net} = 꼬리표 ${tags}` });
  await syncEntriesForWindow(ctx.db, me, done);
  return { window: done };
});

route('POST', '/roster/close/:id/adjust', async (ctx) => {
  const me = requireAdmin(ctx);
  await rosterGate(ctx);
  const w = await loadReconciling(ctx, me, ctx.params.id);
  const reason = str(ctx.req.body?.reason, '조정 사유', 300);
  const accepted = int(ctx.req.body?.accepted_count, '인정 인원');
  const c = await ctx.db.votes.windowCounts(w.id);
  const tags = ctx.req.body?.tag_count !== undefined && ctx.req.body?.tag_count !== null && ctx.req.body?.tag_count !== '' ? int(ctx.req.body.tag_count, '꼬리표 수') : w.tag_count;
  const done: TallyWindow = {
    ...w, status: 'adjusted', check_count: c.net, leave_count: c.leave_net, tag_count: tags, accepted_count: accepted,
    adjustment: accepted - c.net, adjust_reason: reason, matched_at: nowIso(), matched_by_name: me.name,
  };
  const { id: _id, ...patch } = done;
  await ctx.db.update('tally_window', { id: w.id }, patch);
  await accessLog(ctx.db, me, w.station_id, 'adjust', null, 'adjusted', `체크 ${c.net} · 꼬리표 ${tags ?? '-'} · 인정 ${accepted} · ${reason}`);
  await log(ctx.db, me, 'tally.adjust', { station_id: w.station_id, before_json: JSON.stringify({ check_count: c.net, tag_count: tags }), after_json: JSON.stringify({ accepted_count: accepted, adjustment: accepted - c.net }), note: reason });
  await syncEntriesForWindow(ctx.db, me, done);
  return { window: done };
});

route('GET', '/roster/windows', async (ctx) => {
  const me = requireAuth(ctx);
  const cfg = await loadConfig(ctx.db);
  let wins = await ctx.db.all<TallyWindow>('tally_window', undefined, 'boundary_at');
  if (me.role !== 'admin') {
    const shift = await activeShift(ctx.db, me.id);
    wins = shift ? wins.filter((w) => w.station_id === shift.station_id) : [];
  }
  const extras = await tallyExtras(ctx.db, cfg.days, cfg.stations, cfg.election.extension_enabled);
  return { windows: wins, stations: extras.stations, server_now: nowIso() };
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
  if ((await ctx.db.count('ballot_event')) > 0) throw new HttpError(409, 'has_checks', '체크 기록이 있어 명부를 교체할 수 없습니다. 리허설 후라면 체크 기록 초기화를 먼저 하세요.');
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
  await recomputeBaseVoters(ctx.db, me);
  const label = up.kind === 'regular' ? '정회원' : '준회원';
  await log(ctx.db, me, 'roster.upload', { note: `${label} ${n}명` });
  await accessLog(ctx.db, me, null, 'upload', null, up.kind, `${label} ${n}명`);
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
  await recomputeBaseVoters(ctx.db, me);
  await accessLog(ctx.db, me, null, 'voter.add', h, kind, reason);
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
  if (!v) { await accessLog(ctx.db, me, null, 'voter.edit', h, 'not_found'); throw new HttpError(404, 'not_found', '명부에 없는 학번입니다.'); }
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
  await accessLog(ctx.db, me, null, 'voter.edit', h, 'ok', `${JSON.stringify(patch)} · ${reason}`);
  await log(ctx.db, me, 'roster.edit', { note: reason });
  return { ok: true };
});

/** 체크 기록 초기화 (FR-97) */
route('POST', '/roster/reset-checks', async (ctx) => {
  const me = requireAdmin(ctx);
  if (String(ctx.req.body?.confirm ?? '').normalize('NFC').trim() !== '체크기록초기화') throw new HttpError(400, 'bad_request', '확인 문구가 맞지 않습니다.');
  const entries = await ctx.db.all<Entry>('entry', { entered_by: 'system' });
  await ctx.db.votes.resetChecks();
  const crs = await ctx.db.all<{ id: string; entry_id: string }>('change_request');
  const ids = new Set(entries.map((e) => e.id));
  await ctx.db.removeIds('change_request', crs.filter((c) => ids.has(c.entry_id)).map((c) => c.id));
  await ctx.db.removeIds('entry', [...ids]);
  await log(ctx.db, me, 'roster.reset_checks', { note: `체크 기록 초기화 · 자동 입력값 ${ids.size}건 삭제` });
  await accessLog(ctx.db, me, null, 'reset_checks', null, 'ok');
  return { ok: true };
});

// ---------- 백업·복원 (FR-96) ----------
const csvCell = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
route('GET', '/roster/backup.csv', async (ctx) => {
  const me = requireAdmin(ctx);
  const [events, wins, stations] = await Promise.all([
    ctx.db.all<BallotEvent>('ballot_event', undefined, 'at'), ctx.db.all<TallyWindow>('tally_window', undefined, 'boundary_at'), ctx.db.all<Station>('station'),
  ]);
  const sname = (id: string) => stations.find((s) => s.id === id)?.name ?? id;
  const lines = ['구분,시각,투표소,종류,학번해시,구간,데이터'];
  for (const w of wins) lines.push(['마감', w.boundary_at, sname(w.station_id), w.status, '', w.id, JSON.stringify(w)].map(csvCell).join(','));
  for (const e of events) lines.push(['체크', e.at, sname(e.station_id), e.kind, e.voter_sid_hash, e.window_id ?? '', JSON.stringify(e)].map(csvCell).join(','));
  const at = nowIso();
  await ctx.db.update('election', { id: 'main' }, { last_backup_at: at });
  await accessLog(ctx.db, me, null, 'backup', null, 'ok', `체크 ${events.length}건 · 마감 ${wins.length}건`);
  return {
    status: 200, body: '﻿' + lines.join('\r\n'),
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="roster_backup_${at.slice(0, 16).replace(/[:T]/g, '-')}.csv"`, 'Cache-Control': 'no-store' },
  } satisfies ApiResponse;
});

route('POST', '/roster/restore/chunk', async (ctx) => {
  requireAdmin(ctx);
  const b = ctx.req.body ?? {};
  if (b.first === true && ((await ctx.db.count('ballot_event')) > 0 || (await ctx.db.count('tally_window')) > 0)) {
    throw new HttpError(409, 'not_empty', '체크 기록이 비어 있을 때만 복원할 수 있습니다. 체크 기록 초기화 후 다시 시도하세요.');
  }
  const wins = Array.isArray(b.windows) ? (b.windows as TallyWindow[]) : [];
  const events = Array.isArray(b.events) ? (b.events as BallotEvent[]) : [];
  if (wins.length + events.length > 1000) throw new HttpError(400, 'bad_request', '한 번에 1,000건까지 보낼 수 있습니다.');
  const pickW = (w: TallyWindow): TallyWindow => ({
    id: String(w.id), station_id: String(w.station_id), date: String(w.date), opened_at: String(w.opened_at), boundary_at: String(w.boundary_at),
    status: w.status, check_count: Number(w.check_count), leave_count: Number(w.leave_count), tag_count: w.tag_count ?? null, accepted_count: w.accepted_count ?? null,
    adjustment: Number(w.adjustment ?? 0), adjust_reason: w.adjust_reason ?? null, closed_by: String(w.closed_by), closed_by_name: String(w.closed_by_name),
    matched_at: w.matched_at ?? null, matched_by_name: w.matched_by_name ?? null,
  });
  const pickE = (e: BallotEvent): BallotEvent => ({
    id: String(e.id), voter_id: String(e.voter_id), voter_sid_hash: String(e.voter_sid_hash), station_id: String(e.station_id), kind: e.kind === 'cancel' ? 'cancel' : 'issue',
    ref_event_id: e.ref_event_id ?? null, is_leave: e.is_leave === true || (e.is_leave as unknown) === 1, at: String(e.at), actor_id: String(e.actor_id), actor_name: String(e.actor_name),
    window_id: e.window_id ?? null, source: e.source ?? 'restore', reason: e.reason ?? null,
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
  await accessLog(ctx.db, me, null, 'restore', null, 'ok', `${n}명`);
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
    return { index, sid, station: st ?? null, at, recorder: String(r?.recorder ?? '').trim().slice(0, 50), hash: sid.length >= 4 ? hashSid(sid) : '' };
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
    return { ...base, status: 'ok' as const, _voter: v, _station: p.station, _recorder: p.recorder };
  });
}

route('POST', '/roster/sheet/preview', async (ctx) => {
  const me = requireAdmin(ctx);
  await rosterGate(ctx, { needReady: true });
  const res = await classifySheet(ctx.db, ctx.req.body?.rows);
  await accessLog(ctx.db, me, null, 'sheet.preview', null, 'ok', `${res.length}행`);
  return { rows: res.map(({ _voter, _station, _recorder, ...r }: any) => r) };
});

route('POST', '/roster/sheet/apply', async (ctx) => {
  const me = requireAdmin(ctx);
  await rosterGate(ctx, { needReady: true });
  const res = await classifySheet(ctx.db, ctx.req.body?.rows);
  let applied = 0, failed = 0;
  for (const r of res as any[]) {
    if (r.status !== 'ok') continue;
    const out = await ctx.db.votes.issue({
      event_id: randomUUID(), voter_id: r._voter.id, sid_hash: r._voter.sid_hash, station_id: r._station.id, at: r.at,
      actor_id: me.id, actor_name: `${r._recorder || me.name}(장애 시트)`, source: 'sheet', window_id: null, reason: '장애 기록 시트 반영',
    });
    if (out.ok) applied++; else failed++;
  }
  await log(ctx.db, me, 'roster.sheet', { note: `장애 시트 반영 ${applied}명${failed ? ` · 이미 투표 ${failed}명` : ''}` });
  await accessLog(ctx.db, me, null, 'sheet.apply', null, 'ok', `${applied}명`);
  return { applied, failed };
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
  if (!el.result_announced_on) throw new HttpError(409, 'no_date', '결과 공고일을 먼저 입력하세요.');
  const from = Date.parse(`${el.result_announced_on}T00:00:00+09:00`) + el.retention_days * 86400000;
  if (Date.now() < from) throw new HttpError(409, 'too_early', `${kstDate(from)}부터 파기할 수 있습니다.`);
  await ctx.db.votes.purge();
  await ctx.db.update('election', { id: 'main' }, { purged_at: nowIso() });
  await log(ctx.db, me, 'roster.purge', { note: '선거인명부·체크 기록 파기' });
  await accessLog(ctx.db, me, null, 'purge', null, 'ok');
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

// ---------- 근무표 (15.5) ----------
function checkShift(s: { date: string; start_time: string; end_time: string }) {
  if (!DATE_RE.test(s.date)) throw new HttpError(400, 'bad_request', `날짜 형식 오류: ${s.date}`);
  if (!TIME_RE.test(s.start_time) || !TIME_RE.test(s.end_time)) throw new HttpError(400, 'bad_request', '시각 형식 오류 (HH:MM)');
  if (s.start_time >= s.end_time) throw new HttpError(400, 'bad_request', '종료 시각은 시작 시각보다 늦어야 합니다.');
}
const overlaps = (a: Shift, b: Shift) => a.member_id === b.member_id && a.date === b.date && a.start_time < b.end_time && b.start_time < a.end_time;

route('GET', '/shifts', async (ctx) => {
  requireAdmin(ctx);
  return { shifts: await ctx.db.all<Shift>('shift', undefined, 'date, start_time') };
});

/** 엑셀/CSV에서 읽은 행을 한 번에 등록. replace=true면 기존 근무표 전체 교체 */
route('POST', '/shifts/bulk', async (ctx) => {
  const me = requireAdmin(ctx);
  const rows = ctx.req.body?.rows;
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 2000) throw new HttpError(400, 'bad_request', '1~2,000행만 올릴 수 있습니다.');
  const [members, stations, existing] = await Promise.all([ctx.db.all<Member>('member'), ctx.db.all<Station>('station'), ctx.db.all<Shift>('shift')]);
  const replace = ctx.req.body?.replace === true;
  const errors: { row: number; message: string }[] = [];
  const out: Shift[] = [];
  rows.forEach((r: any, i: number) => {
    const row = i + 2; // 헤더 다음 줄부터
    const member = members.find((m) => m.active && m.name === String(r?.member ?? '').trim());
    const station = stations.find((s) => s.name === String(r?.station ?? '').trim());
    const s: Shift = { id: randomUUID(), member_id: member?.id ?? '', station_id: station?.id ?? '', date: String(r?.date ?? '').trim(), start_time: String(r?.start ?? '').trim().padStart(5, '0'), end_time: String(r?.end ?? '').trim().padStart(5, '0') };
    if (!member) errors.push({ row, message: `위원 명부에 없는 이름: ${r?.member ?? ''}` });
    if (!station) errors.push({ row, message: `없는 투표소: ${r?.station ?? ''}` });
    try { checkShift(s); } catch (e) { errors.push({ row, message: (e as Error).message }); }
    if (member && station) {
      const clash = [...(replace ? [] : existing), ...out].find((x) => overlaps(x, s));
      if (clash) errors.push({ row, message: `${member.name}의 근무 시간이 겹칩니다 (${clash.date} ${clash.start_time}~${clash.end_time})` });
    }
    out.push(s);
  });
  if (errors.length) throw new HttpError(400, 'invalid_rows', `근무표에 오류가 ${errors.length}건 있습니다.`, { errors });
  if (replace) await ctx.db.removeAll('shift');
  await ctx.db.insertMany('shift', out);
  await log(ctx.db, me, 'shift.upload', { note: `근무표 ${out.length}행${replace ? ' (전체 교체)' : ' 추가'}` });
  return { ok: true, count: out.length };
});

async function shiftFromBody(ctx: Ctx, id?: string): Promise<Shift> {
  const b = ctx.req.body ?? {};
  const s: Shift = { id: id ?? randomUUID(), member_id: str(b.member_id, '위원'), station_id: str(b.station_id, '투표소'), date: str(b.date, '날짜', 10), start_time: str(b.start_time, '시작', 5), end_time: str(b.end_time, '종료', 5) };
  checkShift(s);
  if (!(await ctx.db.get<Member>('member', { id: s.member_id }))) throw new HttpError(400, 'bad_request', '위원을 고르세요.');
  if (!(await ctx.db.get<Station>('station', { id: s.station_id }))) throw new HttpError(400, 'bad_request', '투표소를 고르세요.');
  const clash = (await ctx.db.all<Shift>('shift', { member_id: s.member_id, date: s.date })).find((x) => x.id !== s.id && overlaps(x, s));
  if (clash) throw new HttpError(409, 'overlap', `근무 시간이 겹칩니다 (${clash.start_time}~${clash.end_time})`);
  return s;
}

route('POST', '/shifts', async (ctx) => {
  const me = requireAdmin(ctx);
  const s = await shiftFromBody(ctx);
  await ctx.db.insert('shift', s);
  await log(ctx.db, me, 'shift.add', { station_id: s.station_id, after_json: JSON.stringify(s) });
  return { shift: s };
});

route('PUT', '/shifts/:id', async (ctx) => {
  const me = requireAdmin(ctx);
  const before = await ctx.db.get<Shift>('shift', { id: ctx.params.id });
  if (!before) throw new HttpError(404, 'not_found');
  const s = await shiftFromBody(ctx, before.id);
  const { id: _id, ...patch } = s;
  await ctx.db.update('shift', { id: s.id }, patch);
  await log(ctx.db, me, 'shift.update', { station_id: s.station_id, before_json: JSON.stringify(before), after_json: JSON.stringify(s) });
  return { shift: s };
});

route('DELETE', '/shifts/:id', async (ctx) => {
  const me = requireAdmin(ctx);
  const before = await ctx.db.get<Shift>('shift', { id: ctx.params.id });
  if (!before) throw new HttpError(404, 'not_found');
  await ctx.db.remove('shift', { id: before.id });
  await log(ctx.db, me, 'shift.remove', { station_id: before.station_id, before_json: JSON.stringify(before) });
  return { ok: true };
});
