import { randomUUID } from 'node:crypto';
import { getDb } from './db/index.js';
import type {
  AuditLog, ChangeRequest, Db, District, Election, ElectionDay, Entry, Member, Slot, Station,
} from './db/types.js';
import {
  createSessionToken, generateCode, hashCode, readSessionToken, verifyCode, SESSION_TTL_MS,
} from './auth.js';
import { currentTallyTimes, ensureSeed, regenerateSlots, regenerateSlotsForStation } from './logic/seed.js';
import { computeTally } from './logic/tally.js';
import { generateSlotTimes, nowIso, slotEpoch, weekdayKo } from './logic/time.js';

// ---------- Request / response abstraction (shared by Vercel + local dev) ----------
export interface ApiRequest {
  method: string;
  path: string; // without /api prefix, e.g. "/login"
  query: Record<string, string>;
  body: any;
  cookies: Record<string, string>;
}
export interface ApiResponse {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra?: unknown) {
    super(message ?? code);
  }
}

type Ctx = { db: Db; member: Member | null; req: ApiRequest; params: Record<string, string> };
type Handler = (ctx: Ctx) => Promise<unknown | ApiResponse>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }
const routes: Route[] = [];

function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, pattern, keys, handler });
}

const COOKIE = 'vote_session';
const isProd = () => !!process.env.VERCEL || process.env.NODE_ENV === 'production';
function cookieHeader(token: string | null): string {
  const base = `${COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax${isProd() ? '; Secure' : ''}`;
  return token ? `${base}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` : `${base}; Max-Age=0`;
}

function requireAuth(ctx: Ctx): Member {
  if (!ctx.member) throw new HttpError(401, 'unauthenticated', '로그인이 필요합니다.');
  return ctx.member;
}
function requireAdmin(ctx: Ctx): Member {
  const m = requireAuth(ctx);
  if (m.role !== 'admin') throw new HttpError(403, 'forbidden', '총관리자만 할 수 있습니다.');
  return m;
}
function int(v: unknown, name: string, min = 0): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min) throw new HttpError(400, 'bad_request', `${name} 값이 올바르지 않습니다.`);
  return n;
}
function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) throw new HttpError(400, 'bad_request', `${name} 값이 올바르지 않습니다.`);
  return v.trim();
}
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

async function log(db: Db, actor: Member, action: string, fields: Partial<AuditLog> = {}) {
  await db.insert<AuditLog>('audit_log', {
    id: randomUUID(), at: nowIso(), actor_id: actor.id, actor_name: actor.name, action,
    station_id: null, slot_id: null, before_json: null, after_json: null, note: null, ...fields,
  });
}

async function loadConfig(db: Db) {
  const [election, days, districts, stations, slots] = await Promise.all([
    db.get<Election>('election', { id: 'main' }),
    db.all<ElectionDay>('election_day', undefined, 'sort'),
    db.all<District>('district', undefined, 'sort'),
    db.all<Station>('station', undefined, 'sort'),
    db.all<Slot>('slot'),
  ]);
  if (!election) throw new HttpError(500, 'no_election');
  return { election, days, districts, stations, slots };
}

function slotKey(slot: Slot, days: ElectionDay[]) {
  const day = days.find((d) => d.id === slot.day_id)!;
  return { date: day.date, time: slot.time, epoch: slotEpoch(day.date, slot.time), isExtension: day.is_extension };
}

// ---------- Auth ----------
route('POST', '/login', async ({ db, req }) => {
  const name = str(req.body?.name, '이름', 50);
  const code = str(req.body?.code, '코드', 20);
  const candidates = (await db.all<Member>('member', { name })).filter((m) => m.active);
  const member = candidates[0];
  const fail = () => { throw new HttpError(401, 'bad_credentials', '이름 또는 코드가 맞지 않습니다.'); };
  if (!member) fail();
  if (member.locked_until && Date.parse(member.locked_until) > Date.now()) {
    throw new HttpError(423, 'locked', '로그인 시도가 너무 많습니다. 10분 후 다시 시도하세요.');
  }
  if (!verifyCode(code, member.code_hash)) {
    const failed = member.failed_count + 1;
    await db.update('member', { id: member.id }, {
      failed_count: failed, locked_until: failed >= 5 ? new Date(Date.now() + 10 * 60 * 1000).toISOString() : null,
    });
    fail();
  }
  await db.update('member', { id: member.id }, { failed_count: 0, locked_until: null, last_login_at: nowIso() });
  const token = createSessionToken(member.id, member.code_version);
  return {
    status: 200,
    body: { id: member.id, name: member.name, role: member.role, expires_at: new Date(Date.now() + SESSION_TTL_MS).toISOString() },
    headers: { 'Set-Cookie': cookieHeader(token) },
  } satisfies ApiResponse;
});

route('POST', '/logout', async () => ({ status: 200, body: { ok: true }, headers: { 'Set-Cookie': cookieHeader(null) } }));

route('GET', '/me', async (ctx) => {
  const m = requireAuth(ctx);
  return { id: m.id, name: m.name, role: m.role };
});

// ---------- Config ----------
route('GET', '/config', async (ctx) => {
  requireAuth(ctx);
  const cfg = await loadConfig(ctx.db);
  return { ...cfg, server_now: nowIso() };
});

// ---------- Tally ----------
route('GET', '/tally', async (ctx) => {
  requireAuth(ctx);
  const cfg = await loadConfig(ctx.db);
  const entries = await ctx.db.all<Entry>('entry');
  const points = computeTally({ ...cfg, entries, extensionEnabled: cfg.election.extension_enabled });
  const pending = ctx.member!.role === 'admin' ? (await ctx.db.all<ChangeRequest>('change_request', { status: 'pending' })).length : 0;
  return { election: cfg.election, points, pending_requests: pending, server_now: nowIso() };
});

// ---------- Entries ----------
route('GET', '/entries', async (ctx) => {
  requireAuth(ctx);
  const entries = await ctx.db.all<Entry>('entry');
  return { entries };
});

route('POST', '/entries', async (ctx) => {
  const me = requireAuth(ctx);
  const { db, req } = ctx;
  const cfg = await loadConfig(db);
  const stationId = str(req.body?.station_id, '투표소');
  const slotId = str(req.body?.slot_id, '시점');
  const cumulative = int(req.body?.cumulative, '누적 투표자수');
  const leave = int(req.body?.leave_cumulative, '휴학생 투표자수');
  if (leave > cumulative) throw new HttpError(400, 'leave_exceeds', '휴학생 수는 누적 투표자수를 넘을 수 없습니다.');
  const station = cfg.stations.find((s) => s.id === stationId);
  const slot = cfg.slots.find((s) => s.id === slotId && s.station_id === stationId);
  if (!station || !slot) throw new HttpError(404, 'not_found', '투표소 또는 시점을 찾을 수 없습니다.');
  const key = slotKey(slot, cfg.days);
  if (key.isExtension && !cfg.election.extension_enabled) throw new HttpError(403, 'extension_disabled', '연장투표가 활성화되지 않았습니다.');
  if (me.role !== 'admin') {
    if (cfg.election.input_locked) throw new HttpError(403, 'locked', '입력이 잠겨 있습니다. 총관리자에게 문의하세요.');
    if (cfg.election.enforce_time_window && Date.now() < key.epoch - 10 * 60 * 1000) {
      throw new HttpError(403, 'too_early', '아직 입력할 수 없는 시점입니다. 집계 시각 10분 전부터 입력할 수 있습니다.');
    }
  }
  const existing = await db.get<Entry>('entry', { station_id: stationId, slot_id: slotId });
  const now = nowIso();
  if (!existing) {
    const entry: Entry = {
      id: randomUUID(), station_id: stationId, slot_id: slotId, cumulative, leave_cumulative: leave,
      entered_by: me.id, entered_by_name: me.name, entered_at: now, confirmed: false, confirmed_by: null, confirmed_at: null,
    };
    await db.insert('entry', entry);
    await log(db, me, 'entry.create', { station_id: stationId, slot_id: slotId, after_json: JSON.stringify({ cumulative, leave_cumulative: leave }) });
    return { entry, created: true };
  }
  if (existing.confirmed) {
    if (me.role !== 'admin') throw new HttpError(409, 'confirmed', '확정된 값입니다. 수정요청을 제출하세요.', { entry: existing });
    await db.update('entry', { id: existing.id }, { cumulative, leave_cumulative: leave, entered_by: me.id, entered_by_name: me.name, entered_at: now });
    await log(db, me, 'entry.admin_edit', {
      station_id: stationId, slot_id: slotId,
      before_json: JSON.stringify({ cumulative: existing.cumulative, leave_cumulative: existing.leave_cumulative, by: existing.entered_by_name }),
      after_json: JSON.stringify({ cumulative, leave_cumulative: leave }), note: '관리자 직접 수정',
    });
    return { entry: { ...existing, cumulative, leave_cumulative: leave, entered_by: me.id, entered_by_name: me.name, entered_at: now }, created: false };
  }
  if (req.body?.overwrite !== true) {
    throw new HttpError(409, 'exists', `${existing.entered_by_name}님이 이미 ${existing.cumulative}명으로 입력했습니다.`, { entry: existing });
  }
  await db.update('entry', { id: existing.id }, { cumulative, leave_cumulative: leave, entered_by: me.id, entered_by_name: me.name, entered_at: now });
  await log(db, me, 'entry.overwrite', {
    station_id: stationId, slot_id: slotId,
    before_json: JSON.stringify({ cumulative: existing.cumulative, leave_cumulative: existing.leave_cumulative, by: existing.entered_by_name }),
    after_json: JSON.stringify({ cumulative, leave_cumulative: leave }),
  });
  return { entry: { ...existing, cumulative, leave_cumulative: leave, entered_by: me.id, entered_by_name: me.name, entered_at: now }, created: false };
});

route('POST', '/entries/:id/confirm', async (ctx) => {
  const me = requireAdmin(ctx);
  const entry = await ctx.db.get<Entry>('entry', { id: ctx.params.id });
  if (!entry) throw new HttpError(404, 'not_found');
  const confirmed = ctx.req.body?.confirmed !== false;
  await ctx.db.update('entry', { id: entry.id }, { confirmed, confirmed_by: confirmed ? me.id : null, confirmed_at: confirmed ? nowIso() : null });
  await log(ctx.db, me, confirmed ? 'entry.confirm' : 'entry.unconfirm', { station_id: entry.station_id, slot_id: entry.slot_id });
  return { ok: true };
});

/** 시점(날짜+시각) 일괄 확정: 모든 투표소의 해당 시점 입력값 */
route('POST', '/slots/confirm', async (ctx) => {
  const me = requireAdmin(ctx);
  const cfg = await loadConfig(ctx.db);
  const date = str(ctx.req.body?.date, '날짜');
  const time = str(ctx.req.body?.time, '시각');
  const confirmed = ctx.req.body?.confirmed !== false;
  const day = cfg.days.find((d) => d.date === date);
  if (!day) throw new HttpError(404, 'not_found');
  const slotIds = cfg.slots.filter((s) => s.day_id === day.id && s.time === time).map((s) => s.id);
  let n = 0;
  for (const slotId of slotIds) {
    const entry = await ctx.db.get<Entry>('entry', { slot_id: slotId });
    if (!entry || entry.confirmed === confirmed) continue;
    await ctx.db.update('entry', { id: entry.id }, { confirmed, confirmed_by: confirmed ? me.id : null, confirmed_at: confirmed ? nowIso() : null });
    n++;
  }
  await log(ctx.db, me, confirmed ? 'slot.confirm_all' : 'slot.unconfirm_all', { note: `${date} ${time} · ${n}건` });
  return { ok: true, count: n };
});

// ---------- Change requests ----------
route('GET', '/change-requests', async (ctx) => {
  const me = requireAuth(ctx);
  const all = await ctx.db.all<ChangeRequest>('change_request', undefined, 'requested_at desc');
  const mine = me.role === 'admin' ? all : all.filter((r) => r.requested_by === me.id);
  const entries = await ctx.db.all<Entry>('entry');
  return { requests: mine.map((r) => ({ ...r, entry: entries.find((e) => e.id === r.entry_id) ?? null })) };
});

route('POST', '/change-requests', async (ctx) => {
  const me = requireAuth(ctx);
  const entryId = str(ctx.req.body?.entry_id, '입력값');
  const cumulative = int(ctx.req.body?.new_cumulative, '누적 투표자수');
  const leave = int(ctx.req.body?.new_leave_cumulative, '휴학생 투표자수');
  const reason = str(ctx.req.body?.reason, '사유', 500);
  if (leave > cumulative) throw new HttpError(400, 'leave_exceeds', '휴학생 수는 누적 투표자수를 넘을 수 없습니다.');
  const entry = await ctx.db.get<Entry>('entry', { id: entryId });
  if (!entry) throw new HttpError(404, 'not_found');
  const dup = (await ctx.db.all<ChangeRequest>('change_request', { entry_id: entryId, status: 'pending' }))[0];
  if (dup) throw new HttpError(409, 'pending_exists', '이미 승인 대기 중인 수정요청이 있습니다.');
  const cr: ChangeRequest = {
    id: randomUUID(), entry_id: entryId, new_cumulative: cumulative, new_leave_cumulative: leave, reason,
    requested_by: me.id, requested_by_name: me.name, requested_at: nowIso(), status: 'pending',
    decided_by: null, decided_by_name: null, decided_at: null, decision_note: null,
  };
  await ctx.db.insert('change_request', cr);
  await log(ctx.db, me, 'request.create', {
    station_id: entry.station_id, slot_id: entry.slot_id,
    before_json: JSON.stringify({ cumulative: entry.cumulative, leave_cumulative: entry.leave_cumulative }),
    after_json: JSON.stringify({ cumulative, leave_cumulative: leave }), note: reason,
  });
  return { request: cr };
});

route('POST', '/change-requests/:id/decide', async (ctx) => {
  const me = requireAdmin(ctx);
  const cr = await ctx.db.get<ChangeRequest>('change_request', { id: ctx.params.id });
  if (!cr || cr.status !== 'pending') throw new HttpError(404, 'not_found', '대기 중인 요청이 아닙니다.');
  const approve = ctx.req.body?.approve === true;
  const note = typeof ctx.req.body?.note === 'string' ? ctx.req.body.note.slice(0, 500) : null;
  const entry = await ctx.db.get<Entry>('entry', { id: cr.entry_id });
  if (!entry) throw new HttpError(404, 'not_found');
  const now = nowIso();
  await ctx.db.update('change_request', { id: cr.id }, {
    status: approve ? 'approved' : 'rejected', decided_by: me.id, decided_by_name: me.name, decided_at: now, decision_note: note,
  });
  if (approve) {
    await ctx.db.update('entry', { id: entry.id }, {
      cumulative: cr.new_cumulative, leave_cumulative: cr.new_leave_cumulative,
      entered_by: cr.requested_by, entered_by_name: cr.requested_by_name, entered_at: now,
      confirmed: true, confirmed_by: me.id, confirmed_at: now,
    });
  }
  await log(ctx.db, me, approve ? 'request.approve' : 'request.reject', {
    station_id: entry.station_id, slot_id: entry.slot_id,
    before_json: JSON.stringify({ cumulative: entry.cumulative, leave_cumulative: entry.leave_cumulative }),
    after_json: approve ? JSON.stringify({ cumulative: cr.new_cumulative, leave_cumulative: cr.new_leave_cumulative }) : null,
    note: `${cr.requested_by_name} 요청${note ? ' · ' + note : ''}`,
  });
  return { ok: true };
});

// ---------- Log ----------
route('GET', '/log', async (ctx) => {
  requireAdmin(ctx);
  const limit = Math.min(int(ctx.req.query.limit ?? 500, 'limit', 1), 5000);
  const all = await ctx.db.all<AuditLog>('audit_log', undefined, 'at desc');
  return { log: all.slice(0, limit) };
});

// ---------- Admin: election / districts / stations / slots ----------
route('PUT', '/election', async (ctx) => {
  const me = requireAdmin(ctx);
  const cur = (await loadConfig(ctx.db)).election;
  const b = ctx.req.body ?? {};
  const patch: Partial<Election> = {};
  if (b.name !== undefined) patch.name = str(b.name, '선거 명칭', 100);
  if (b.threshold_pct !== undefined) {
    const t = Number(b.threshold_pct);
    if (!Number.isFinite(t) || t < 0 || t > 100) throw new HttpError(400, 'bad_request', '기준 투표율이 올바르지 않습니다.');
    patch.threshold_pct = t;
  }
  for (const k of ['extension_enabled', 'input_locked', 'enforce_time_window'] as const) {
    if (b[k] !== undefined) patch[k] = b[k] === true;
  }
  await ctx.db.update('election', { id: 'main' }, patch);
  await log(ctx.db, me, 'election.update', { before_json: JSON.stringify(cur), after_json: JSON.stringify({ ...cur, ...patch }) });
  return { election: { ...cur, ...patch } };
});

route('PUT', '/districts/:id', async (ctx) => {
  const me = requireAdmin(ctx);
  const d = await ctx.db.get<District>('district', { id: ctx.params.id });
  if (!d) throw new HttpError(404, 'not_found');
  const patch: Partial<District> = {};
  if (ctx.req.body?.name !== undefined) patch.name = str(ctx.req.body.name, '이름', 50);
  if (ctx.req.body?.base_voters !== undefined) patch.base_voters = int(ctx.req.body.base_voters, '유권자수');
  await ctx.db.update('district', { id: d.id }, patch);
  if (patch.base_voters !== undefined && patch.base_voters !== d.base_voters) {
    await log(ctx.db, me, 'voters.update', { before_json: JSON.stringify({ name: d.name, base_voters: d.base_voters }), after_json: JSON.stringify({ name: patch.name ?? d.name, base_voters: patch.base_voters }) });
  }
  return { district: { ...d, ...patch } };
});

route('PUT', '/stations/:id', async (ctx) => {
  const me = requireAdmin(ctx);
  const s = await ctx.db.get<Station>('station', { id: ctx.params.id });
  if (!s) throw new HttpError(404, 'not_found');
  const b = ctx.req.body ?? {};
  const patch: Partial<Station> = {};
  if (b.name !== undefined) patch.name = str(b.name, '이름', 50);
  if (b.open_time !== undefined) { if (!TIME_RE.test(b.open_time)) throw new HttpError(400, 'bad_request', '시작 시각 형식 오류'); patch.open_time = b.open_time; }
  if (b.close_time !== undefined) { if (!TIME_RE.test(b.close_time)) throw new HttpError(400, 'bad_request', '종료 시각 형식 오류'); patch.close_time = b.close_time; }
  const next = { ...s, ...patch };
  if (next.open_time >= next.close_time) throw new HttpError(400, 'bad_request', '종료 시각은 시작 시각보다 늦어야 합니다.');
  await ctx.db.update('station', { id: s.id }, patch);
  if (patch.open_time || patch.close_time) await regenerateSlotsForStation(ctx.db, next, await currentTallyTimes(ctx.db));
  await log(ctx.db, me, 'station.update', { station_id: s.id, before_json: JSON.stringify(s), after_json: JSON.stringify(next) });
  return { station: next };
});

/** 공통 집계 시각 목록을 바꾸고 모든 투표소·모든 날짜의 시점을 다시 만든다. */
route('PUT', '/tally-times', async (ctx) => {
  const me = requireAdmin(ctx);
  const raw = ctx.req.body?.times;
  if (!Array.isArray(raw) || raw.length > 24) throw new HttpError(400, 'bad_request', '집계 시각 목록이 올바르지 않습니다.');
  const times = [...new Set(raw.map((t) => String(t).trim()))].sort();
  for (const t of times) if (!TIME_RE.test(t)) throw new HttpError(400, 'bad_request', `시각 형식 오류: ${t}`);
  const before = await currentTallyTimes(ctx.db);
  const stations = await ctx.db.all<Station>('station');
  // 지워질 시점에 입력값이 있으면 막는다 (남겨 두면 공통 시각 목록에 다시 섞여 들어옴)
  const [slots, entries] = await Promise.all([ctx.db.all<Slot>('slot'), ctx.db.all<Entry>('entry')]);
  const used = new Set(entries.map((e) => e.slot_id));
  const blocked = new Set<string>();
  for (const st of stations) {
    const wanted = new Set(generateSlotTimes(st.open_time, st.close_time, times).map((x) => x.time));
    for (const sl of slots) if (sl.station_id === st.id && !wanted.has(sl.time) && used.has(sl.id)) blocked.add(sl.time);
  }
  if (blocked.size) {
    throw new HttpError(409, 'has_entry', `${[...blocked].sort().join(', ')} 시점에 입력값이 있어 바꿀 수 없습니다. 입력값을 지우거나 초기화한 뒤 다시 시도하세요.`);
  }
  const kept = await regenerateSlots(ctx.db, stations, times);
  await log(ctx.db, me, 'slot.tally_times', { before_json: JSON.stringify(before), after_json: JSON.stringify(times), note: kept ? `입력값 있어 유지된 시점 ${kept}개` : null });
  return { times, kept };
});

route('POST', '/slots', async (ctx) => {
  const me = requireAdmin(ctx);
  const stationId = str(ctx.req.body?.station_id, '투표소');
  const dayId = str(ctx.req.body?.day_id, '날짜');
  const time = str(ctx.req.body?.time, '시각', 5);
  if (!TIME_RE.test(time)) throw new HttpError(400, 'bad_request', '시각 형식 오류');
  if (await ctx.db.get('slot', { station_id: stationId, day_id: dayId, time })) throw new HttpError(409, 'exists', '이미 있는 시점입니다.');
  const slot: Slot = { id: randomUUID(), station_id: stationId, day_id: dayId, time, is_close: false };
  await ctx.db.insert('slot', slot);
  await log(ctx.db, me, 'slot.add', { station_id: stationId, slot_id: slot.id, note: time });
  return { slot };
});

route('DELETE', '/slots/:id', async (ctx) => {
  const me = requireAdmin(ctx);
  const slot = await ctx.db.get<Slot>('slot', { id: ctx.params.id });
  if (!slot) throw new HttpError(404, 'not_found');
  if (await ctx.db.get('entry', { slot_id: slot.id })) throw new HttpError(409, 'has_entry', '입력값이 있는 시점은 삭제할 수 없습니다.');
  await ctx.db.remove('slot', { id: slot.id });
  await log(ctx.db, me, 'slot.remove', { station_id: slot.station_id, slot_id: slot.id, note: slot.time });
  return { ok: true };
});

// ---------- Admin: members ----------
route('GET', '/members', async (ctx) => {
  requireAdmin(ctx);
  const members = await ctx.db.all<Member>('member', undefined, 'created_at');
  return { members: members.map(({ code_hash: _h, ...m }) => m) };
});

route('POST', '/members', async (ctx) => {
  const me = requireAdmin(ctx);
  const name = str(ctx.req.body?.name, '이름', 50);
  const role = ctx.req.body?.role === 'admin' ? 'admin' : 'member';
  const dup = (await ctx.db.all<Member>('member', { name })).find((m) => m.active);
  if (dup) throw new HttpError(409, 'exists', '같은 이름의 활성 위원이 있습니다. 구분되는 이름을 쓰세요.');
  const code = generateCode();
  const member: Member = {
    id: randomUUID(), name, role, code_hash: hashCode(code), code_version: 1, active: true,
    created_at: nowIso(), last_login_at: null, failed_count: 0, locked_until: null,
  };
  await ctx.db.insert('member', member);
  await log(ctx.db, me, 'member.create', { after_json: JSON.stringify({ name, role }) });
  const { code_hash: _h, ...safe } = member;
  return { member: safe, code };
});

route('POST', '/members/:id/regenerate', async (ctx) => {
  const me = requireAdmin(ctx);
  const m = await ctx.db.get<Member>('member', { id: ctx.params.id });
  if (!m) throw new HttpError(404, 'not_found');
  const code = generateCode();
  await ctx.db.update('member', { id: m.id }, { code_hash: hashCode(code), code_version: m.code_version + 1, failed_count: 0, locked_until: null });
  await log(ctx.db, me, 'member.regenerate', { note: m.name });
  return { code };
});

route('PUT', '/members/:id', async (ctx) => {
  const me = requireAdmin(ctx);
  const m = await ctx.db.get<Member>('member', { id: ctx.params.id });
  if (!m) throw new HttpError(404, 'not_found');
  const patch: Partial<Member> = {};
  if (ctx.req.body?.role !== undefined) patch.role = ctx.req.body.role === 'admin' ? 'admin' : 'member';
  if (ctx.req.body?.active !== undefined) patch.active = ctx.req.body.active === true;
  if (ctx.req.body?.name !== undefined) patch.name = str(ctx.req.body.name, '이름', 50);
  const next = { ...m, ...patch };
  if (m.role === 'admin' && (next.role !== 'admin' || !next.active)) {
    const admins = (await ctx.db.all<Member>('member', { role: 'admin' })).filter((a) => a.active && a.id !== m.id);
    if (admins.length === 0) throw new HttpError(409, 'last_admin', '총관리자가 1명뿐이면 권한을 내리거나 비활성화할 수 없습니다.');
  }
  await ctx.db.update('member', { id: m.id }, { ...patch, code_version: m.code_version + (patch.active === false ? 1 : 0) });
  await log(ctx.db, me, 'member.update', { before_json: JSON.stringify({ name: m.name, role: m.role, active: m.active }), after_json: JSON.stringify({ name: next.name, role: next.role, active: next.active }) });
  return { ok: true };
});

// ---------- Admin: reset (test mode) ----------
route('POST', '/reset', async (ctx) => {
  const me = requireAdmin(ctx);
  if (String(ctx.req.body?.confirm ?? '').normalize('NFC').trim() !== '초기화') throw new HttpError(400, 'bad_request', '확인 문구가 맞지 않습니다.');
  for (const t of ['change_request', 'entry', 'audit_log']) await ctx.db.removeAll(t);
  await log(ctx.db, me, 'system.reset', { note: '전체 입력 초기화' });
  return { ok: true };
});

// ---------- Admin: mock data (test mode) ----------
/** 리허설용 목업: 유권자수가 0인 선거구에 예시 유권자수를 넣고, 첫 투표일의 앞 시점들에 임의 누적값을 채운다. */
route('POST', '/mock', async (ctx) => {
  const me = requireAdmin(ctx);
  const cfg = await loadConfig(ctx.db);
  const SAMPLE_VOTERS: Record<string, number> = {
    '건축대학': 373, '경영대학': 1412, '공과대학': 4750, '국제대학': 361, '문과대학': 1550, '부동산과학원': 420, '사범대학': 880,
    '사회과학대학': 1420, '상허교양대학': 1200, '생명과학대학': 1120, '수의과대학': 460, '예술디자인대학': 990, '융합과학기술원': 1180, '이과대학': 405,
  };
  let votersSet = 0;
  for (const d of cfg.districts) {
    if (d.base_voters === 0 && SAMPLE_VOTERS[d.name]) { await ctx.db.update('district', { id: d.id }, { base_voters: SAMPLE_VOTERS[d.name] }); d.base_voters = SAMPLE_VOTERS[d.name]; votersSet++; }
  }
  const day = cfg.days.find((d) => !d.is_extension) ?? cfg.days[0];
  if (!day) throw new HttpError(400, 'no_day', '투표일이 없습니다.');
  const slotsPerPoint = Number(ctx.req.body?.points ?? 4);
  let seed = 7;
  const rand = () => { seed = (seed * 9301 + 49297) % 233280; return seed / 233280; };
  const now = nowIso();
  let created = 0;
  for (const st of cfg.stations) {
    const d = cfg.districts.find((x) => x.id === st.district_id)!;
    const share = cfg.stations.filter((x) => x.district_id === d.id).length;
    const base = d.base_voters / share;
    const slots = cfg.slots.filter((x) => x.station_id === st.id && x.day_id === day.id).sort((a, b) => a.time.localeCompare(b.time));
    const take = slots.length <= 2 ? 1 : Math.min(slotsPerPoint, slots.length - 1);
    let cum = 0;
    for (const slot of slots.slice(0, take)) {
      if (await ctx.db.get('entry', { station_id: st.id, slot_id: slot.id })) continue;
      cum += Math.round(base * (0.05 + rand() * 0.05));
      const leave = Math.round(cum * 0.02);
      await ctx.db.insert<Entry>('entry', {
        id: randomUUID(), station_id: st.id, slot_id: slot.id, cumulative: cum, leave_cumulative: leave,
        entered_by: me.id, entered_by_name: `${me.name}(목업)`, entered_at: now, confirmed: false, confirmed_by: null, confirmed_at: null,
      });
      created++;
    }
  }
  await log(ctx.db, me, 'system.mock', { note: `목업 입력 ${created}건, 유권자수 ${votersSet}개 선거구` });
  return { ok: true, created, votersSet };
});

// ---------- Export ----------
route('GET', '/export.csv', async (ctx) => {
  requireAdmin(ctx);
  const cfg = await loadConfig(ctx.db);
  const entries = await ctx.db.all<Entry>('entry');
  const points = computeTally({ ...cfg, entries, extensionEnabled: cfg.election.extension_enabled });
  const lines = ['날짜,시각,선거구,투표소,기본유권자수,휴학생투표자수,유권자수,누적투표자수,증가분,투표율,입력자,입력시각,확정여부'];
  const prev = new Map<string, number>();
  for (const p of points) {
    for (const d of p.districts) {
      for (const s of d.stations) {
        if (!s.has_slot) continue;
        const st = cfg.stations.find((x) => x.id === s.station_id)!;
        const delta = s.cumulative - (prev.get(s.station_id) ?? 0);
        prev.set(s.station_id, s.cumulative);
        const voters = d.base_voters + d.leave_cumulative;
        lines.push([
          p.date, p.time, d.name, st.name, d.base_voters, s.leave_cumulative, voters, s.cumulative, delta,
          s.entered ? (d.voters > 0 ? (d.pct).toFixed(2) : '') : '', s.entered ? s.last_entry_by ?? '' : '미입력',
          s.entered ? (s.last_entry_at ?? '') : '', s.entered ? (s.confirmed ? 'Y' : 'N') : '',
        ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(','));
      }
    }
  }
  return {
    status: 200, body: '﻿' + lines.join('\r\n'),
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="turnout_${cfg.days[0]?.date ?? ''}.csv"` },
  } satisfies ApiResponse;
});

// ---------- Dispatcher ----------
let seeded: Promise<void> | null = null;

export async function handle(req: ApiRequest): Promise<ApiResponse> {
  try {
    const db = await getDb();
    if (!seeded) seeded = ensureSeed(db);
    await seeded;
    const session = readSessionToken(req.cookies[COOKIE]);
    let member: Member | null = null;
    if (session) {
      const m = await db.get<Member>('member', { id: session.mid });
      if (m && m.active && m.code_version === session.v) member = m;
    }
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(req.path);
      if (!m) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      const result = await r.handler({ db, member, req, params });
      if (result && typeof result === 'object' && 'status' in (result as any) && 'body' in (result as any)) return result as ApiResponse;
      return { status: 200, body: result };
    }
    return { status: 404, body: { error: 'not_found', message: '없는 API입니다.' } };
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, body: { error: e.code, message: e.message, ...(e.extra ? { extra: e.extra } : {}) } };
    console.error(e);
    return { status: 500, body: { error: 'internal', message: (e as Error).message } };
  }
}

export { weekdayKo, generateSlotTimes };
