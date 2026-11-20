/**
 * 창구 단위 대조, 꼬리표 누적 수 마감, 이슈 신고 (명세 15.13, 15.14)
 * 한 투표소 안에 학과 단위 불출 창구가 여러 개 있고, 창구마다 마감이 따로다.
 * v1.5부터 근무자 화면은 묶음 번호를 쓰지 않는다. 묶음 관련 경로와 테이블은 예전 기록을 위해 남겨 둔다.
 */
import { randomUUID } from 'node:crypto';
import { HttpError, int, log, requireAdmin, requireAuth, route, str, type Ctx } from './core.js';
import type {
  BallotPad, Db, Dept, Desk, DeviceSession, IssueType, PadMove, Station, TagIssue, TallyWindow, Voter,
} from './db/types.js';
import { nowIso } from './logic/time.js';
import { accessLog, gateAt, invalidatePlaces, operatorName, placesOf, whoName } from './roster.js';
import { decrypt } from './voterCrypto.js';

export const PAD_SIZE = 100;
export const SERIAL_MAX = 11000;
export const fmtNo = (n: number) => String(n).padStart(6, '0');
export const padLabel = (p: Pick<BallotPad, 'first_no' | 'last_no'>) => `${fmtNo(p.first_no)}~${fmtNo(p.last_no)}`;
export const ISSUE_TYPES: Record<IssueType, string> = {
  void: '폐기 용지', lost: '꼬리표 분실', damaged: '꼬리표 훼손', unreadable: '번호 판독 불가', pad_defect: '묶음 이상', other: '기타',
};

/** 학과 아래 전공이 있으면 "학과 > 전공"으로 저장한다 (명부의 학과 열 + 전공 열). 화면에는 "학과 전공"으로 보여 준다. */
export const DEPT_SEP = ' > ';
export const deptLabel = (s: string) => s.split(DEPT_SEP).join(' ');
/** 창구 이름: 한 학과의 전공을 모두 맡으면 학과 이름, 일부만 맡으면 전공 이름 */
export function deskNameFor(depts: string[], known: Iterable<string>): string {
  const all = [...known];
  const parts: string[] = [];
  for (const upper of [...new Set(depts.map((d) => d.split(DEPT_SEP)[0]))]) {
    const mine = depts.filter((d) => d.split(DEPT_SEP)[0] === upper);
    const whole = all.filter((d) => d.split(DEPT_SEP)[0] === upper).every((d) => mine.includes(d));
    if (whole) parts.push(upper); else parts.push(...mine.map((d) => d.split(DEPT_SEP)[1] ?? upper));
  }
  return parts.join('·').slice(0, 60);
}
export const parseDepts = (d: Pick<Desk, 'depts'>): string[] => { try { const a = JSON.parse(d.depts || '[]'); return Array.isArray(a) ? a.map(String) : []; } catch { return []; } };
export const deskView = (d: Desk) => ({ id: d.id, station_id: d.station_id, name: d.name, depts: parseDepts(d), is_all: d.is_all, is_unassigned: d.is_unassigned });

/** v1.4 테이블이 아직 없는 배포(schema.sql 재실행 전)에서도 기존 화면이 죽지 않게 빈 목록으로 돌려준다. */
export async function allDesks(db: Db): Promise<Desk[]> {
  try { return await db.all<Desk>('desk', undefined, 'created_at'); } catch { return []; }
}
export async function stationDesks(db: Db, stationId: string): Promise<Desk[]> {
  return (await db.all<Desk>('desk', { station_id: stationId }, 'created_at')).filter((d) => !d.merged_into);
}

/** 장애 시트의 창구 없는 행, 총관리자가 창구를 고르지 않고 한 체크가 들어가는 창구 (FR-110). */
export async function unassignedDesk(db: Db, stationId: string, by: string): Promise<Desk> {
  const found = (await db.all<Desk>('desk', { station_id: stationId, is_unassigned: true }))[0];
  if (found) return found;
  const d: Desk = { id: randomUUID(), station_id: stationId, name: '창구 미지정', depts: '[]', is_all: false, is_unassigned: true, created_at: nowIso(), created_by: by, merged_into: null };
  await db.insert('desk', d);
  return d;
}

// ---------- 학과 목록 ----------
export async function addDepts(db: Db, pairs: { district_id: string; name: string }[]) {
  const want = new Map<string, { district_id: string; name: string }>();
  for (const p of pairs) if (p.name) want.set(`${p.district_id}\u0000${p.name}`, p);
  if (!want.size) return;
  const have = new Set((await db.all<Dept>('dept')).map((d) => `${d.district_id}\u0000${d.name}`));
  await insertDepts(db, [...want.entries()].filter(([k]) => !have.has(k)).map(([, p]) => p));
}
/** 다른 요청이 같은 학과를 먼저 넣었으면 묶음 저장이 통째로 실패하므로, 그때는 하나씩 넣고 겹치는 것은 넘긴다 */
async function insertDepts(db: Db, list: { district_id: string; name: string }[]) {
  const rows = list.map((p) => ({ id: randomUUID(), district_id: p.district_id, name: p.name }));
  if (!rows.length) return;
  try { await db.insertMany('dept', rows); }
  catch { for (const r of rows) await db.insert('dept', r).catch(() => undefined); }
}

const VOTER_PAGE = 1000, PAGES_AT_ONCE = 6;
/**
 * 선거인 전체에서 학과 목록을 다시 맞춘다: 없는 학과는 넣고, 명부에 없는 학과는 지운다.
 * 2만여 행을 읽는 무거운 작업이라 명부 업로드를 마칠 때 한 번만 하고, 페이지를 6개씩 동시에 읽는다.
 */
export async function rebuildDepts(db: Db) {
  const total = await db.count('voter', { batch_id: null });
  const want = new Map<string, { district_id: string; name: string }>();
  const offsets = Array.from({ length: Math.ceil(total / VOTER_PAGE) }, (_, i) => i * VOTER_PAGE);
  for (let i = 0; i < offsets.length; i += PAGES_AT_ONCE) {
    const pages = await Promise.all(offsets.slice(i, i + PAGES_AT_ONCE).map((o) => db.all<Voter>('voter', { batch_id: null }, 'id', VOTER_PAGE, o)));
    for (const v of pages.flat()) {
      const name = decrypt(v.dept_enc).trim();
      if (name) want.set(`${v.district_id}\u0000${name}`, { district_id: v.district_id, name });
    }
  }
  const have = await db.all<Dept>('dept');
  const haveKeys = new Set(have.map((d) => `${d.district_id}\u0000${d.name}`));
  const stale = have.filter((d) => !want.has(`${d.district_id}\u0000${d.name}`)).map((d) => d.id);
  if (stale.length) await db.removeIds('dept', stale);
  await insertDepts(db, [...want.entries()].filter(([k]) => !haveKeys.has(k)).map(([, p]) => p));
  deptsCheckedAt = Date.now();
}

const DEPT_CHECK_MS = 5 * 60_000;
let deptsCheckedAt = 0;
let deptsBuilding: Promise<void> | null = null;
/**
 * 학과 목록이 비어 있을 때만 다시 만든다 (v1.4 이전에 올린 명부 대비).
 * 같은 서버 인스턴스에서는 한 번에 하나만 돌고, 확인한 뒤 5분 동안은 다시 묻지 않는다.
 */
export async function ensureDepts(db: Db) {
  if (Date.now() - deptsCheckedAt < DEPT_CHECK_MS) return;
  deptsBuilding ??= (async () => {
    if ((await db.count('dept')) === 0) await rebuildDepts(db);
    deptsCheckedAt = Date.now();
  })().finally(() => { deptsBuilding = null; });
  await deptsBuilding;
}

// ---------- 창구 고르기 (FR-107) ----------
function cleanDepts(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : [];
}
async function createDesk(db: Db, station: Station, by: string, body: any, exceptId?: string): Promise<Desk> {
  const desks = (await stationDesks(db, station.id)).filter((d) => d.id !== exceptId);
  if (body?.all === true) {
    const found = desks.find((d) => d.is_all);
    if (found) return found;
    const d: Desk = { id: randomUUID(), station_id: station.id, name: '전체', depts: '[]', is_all: true, is_unassigned: false, created_at: nowIso(), created_by: by, merged_into: null };
    await db.insert('desk', d);
    return d;
  }
  const depts = cleanDepts(body?.depts);
  if (!depts.length) throw new HttpError(400, 'desk_required', '창구를 고르세요.');
  await ensureDepts(db);
  const known = new Set((await db.all<Dept>('dept', { district_id: station.district_id })).map((d) => d.name));
  const unknown = depts.filter((d) => !known.has(d));
  if (unknown.length) throw new HttpError(400, 'bad_dept', `이 선거구 명부에 없는 학과입니다: ${unknown.map(deptLabel).join(', ')}`);
  for (const d of desks) {
    const taken = parseDepts(d).filter((x) => depts.includes(x));
    if (taken.length) throw new HttpError(409, 'dept_taken', `${taken.map(deptLabel).join(', ')}은(는) 이미 "${d.name}" 창구가 맡고 있습니다. 그 창구를 고르세요.`);
  }
  const name = typeof body?.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 60) : deskNameFor(depts, known);
  const d: Desk = { id: randomUUID(), station_id: station.id, name, depts: JSON.stringify(depts), is_all: false, is_unassigned: false, created_at: nowIso(), created_by: by, merged_into: null };
  await db.insert('desk', d);
  return d;
}

/** 담당자 등록·변경 때 창구를 정한다: 기존 창구, 새 학과 묶음, "전체" 중 하나. 아무것도 안 주면 지금 창구 유지. */
export async function pickDesk(ctx: Ctx, station: Station, dev: DeviceSession, body: any, by: string): Promise<Desk> {
  if (body?.desk_id) {
    const d = (await stationDesks(ctx.db, station.id)).find((x) => x.id === body.desk_id);
    if (!d || d.is_unassigned) throw new HttpError(404, 'not_found', '창구를 찾을 수 없습니다. 목록을 새로 고친 뒤 다시 고르세요.');
    return d;
  }
  if (body?.all === true || cleanDepts(body?.depts).length) return createDesk(ctx.db, station, by, { all: body?.all, depts: body?.depts });
  if (dev.desk_id) {
    const d = await ctx.db.get<Desk>('desk', { id: dev.desk_id });
    if (d && !d.merged_into) return d;
  }
  throw new HttpError(400, 'desk_required', '창구를 고르세요.');
}

/** 이 요청이 속한 창구: 투표소 기기는 그 기기의 창구, 총관리자는 고른 창구(없으면 "창구 미지정"). */
export async function deskOf(ctx: Ctx, station: Station, deskId?: unknown): Promise<Desk> {
  const me = ctx.member!;
  if (me.role === 'station') {
    const d = ctx.device?.desk_id ? await ctx.db.get<Desk>('desk', { id: ctx.device.desk_id }) : null;
    if (!d) throw new HttpError(403, 'operator_required', '창구를 고르고 담당자를 등록해야 합니다.');
    if (d.merged_into) {
      const to = await ctx.db.get<Desk>('desk', { id: d.merged_into });
      if (to) return to;
    }
    return d;
  }
  if (deskId) {
    const d = await ctx.db.get<Desk>('desk', { id: String(deskId) });
    if (!d || d.station_id !== station.id || d.merged_into) throw new HttpError(404, 'not_found', '창구를 찾을 수 없습니다.');
    return d;
  }
  return unassignedDesk(ctx.db, station.id, me.name);
}

route('GET', '/roster/desks', async (ctx) => {
  const me = requireAuth(ctx);
  if (me.role === 'member') throw new HttpError(403, 'forbidden');
  const pl = await placesOf(ctx.db);
  const station = pl.stations.find((s) => s.id === (me.role === 'station' ? me.station_id : ctx.req.query.station_id));
  if (!station) throw new HttpError(400, 'station_required', '투표소를 선택하세요.');
  await ensureDepts(ctx.db);
  const [desks, depts, devices] = await Promise.all([
    stationDesks(ctx.db, station.id), ctx.db.all<Dept>('dept', { district_id: station.district_id }, 'name'),
    ctx.db.all<DeviceSession>('device_session', { station_id: station.id, revoked_at: null }),
  ]);
  const now = Date.now();
  const live = devices.filter((d) => Date.parse(d.expires_at) > now);
  return {
    desks: desks.filter((d) => !d.is_unassigned || me.role === 'admin').map((d) => ({ ...deskView(d), device_count: live.filter((x) => x.desk_id === d.id).length })),
    depts: depts.map((d) => ({ name: d.name, desk_id: desks.find((x) => parseDepts(x).includes(d.name))?.id ?? null })),
  };
});

// ---------- 총관리자: 창구 관리 (S-12) ----------
route('POST', '/desks', async (ctx) => {
  const me = requireAdmin(ctx);
  const pl = await placesOf(ctx.db);
  const station = pl.stations.find((s) => s.id === ctx.req.body?.station_id);
  if (!station) throw new HttpError(400, 'station_required', '투표소를 선택하세요.');
  const d = await createDesk(ctx.db, station, me.name, ctx.req.body);
  await log(ctx.db, me, 'desk.create', { station_id: station.id, note: `창구 "${d.name}"` });
  return { desk: deskView(d) };
});

route('PUT', '/desks/:id', async (ctx) => {
  const me = requireAdmin(ctx);
  const d = await ctx.db.get<Desk>('desk', { id: ctx.params.id });
  if (!d || d.merged_into) throw new HttpError(404, 'not_found', '창구를 찾을 수 없습니다.');
  const patch: Partial<Desk> = {};
  if (typeof ctx.req.body?.name === 'string') patch.name = str(ctx.req.body.name, '창구 이름', 60);
  if (Array.isArray(ctx.req.body?.depts) && !d.is_all && !d.is_unassigned) {
    const depts = cleanDepts(ctx.req.body.depts);
    if (!depts.length) throw new HttpError(400, 'bad_request', '학과를 하나 이상 고르세요. 창구를 없애려면 다른 창구로 합치세요.');
    const pl = await placesOf(ctx.db);
    const known = new Set((await ctx.db.all<Dept>('dept', { district_id: pl.stations.find((s) => s.id === d.station_id)?.district_id ?? '' })).map((x) => x.name));
    const unknown = depts.filter((x) => !known.has(x) && !parseDepts(d).includes(x));
    if (unknown.length) throw new HttpError(400, 'bad_dept', `이 선거구 명부에 없는 학과입니다: ${unknown.map(deptLabel).join(', ')}`);
    // 이름을 따로 바꾼 적이 없으면(학과에서 자동으로 붙은 이름이면) 새 학과 구성에 맞춰 다시 붙인다
    if (patch.name === undefined && d.name === deskNameFor(parseDepts(d), known)) patch.name = deskNameFor(depts, known);
    for (const o of (await stationDesks(ctx.db, d.station_id)).filter((x) => x.id !== d.id)) {
      const taken = parseDepts(o).filter((x) => depts.includes(x));
      if (taken.length) throw new HttpError(409, 'dept_taken', `${taken.map(deptLabel).join(', ')}은(는) 이미 "${o.name}" 창구가 맡고 있습니다.`);
    }
    patch.depts = JSON.stringify(depts);
  }
  if (!Object.keys(patch).length) throw new HttpError(400, 'bad_request', '바뀐 내용이 없습니다.');
  await ctx.db.update('desk', { id: d.id }, patch);
  await log(ctx.db, me, 'desk.update', { station_id: d.station_id, before_json: JSON.stringify({ name: d.name, depts: parseDepts(d) }), after_json: JSON.stringify({ name: patch.name ?? d.name, depts: patch.depts ? JSON.parse(patch.depts) : parseDepts(d) }) });
  return { ok: true };
});

/** 창구 합치기: 잘못 만든 창구를 다른 창구로. 대조 중이거나 마감하지 않은 체크가 있으면 먼저 마감해야 한다. */
route('POST', '/desks/:id/merge', async (ctx) => {
  const me = requireAdmin(ctx);
  const [from, to] = await Promise.all([ctx.db.get<Desk>('desk', { id: ctx.params.id }), ctx.db.get<Desk>('desk', { id: String(ctx.req.body?.into_id ?? '') })]);
  if (!from || !to || from.merged_into || to.merged_into || from.id === to.id || from.station_id !== to.station_id) throw new HttpError(400, 'bad_request', '같은 투표소의 다른 창구를 고르세요.');
  const [wins, live] = await Promise.all([ctx.db.all<TallyWindow>('tally_window', { desk_id: from.id, status: 'reconciling' }), ctx.db.votes.liveCounts()]);
  if (wins.length) throw new HttpError(409, 'reconciling', '대조 중인 구간이 있는 창구는 합칠 수 없습니다.');
  if (Number(live.find((l) => l.desk_id === from.id)?.open_net ?? 0) !== 0) throw new HttpError(409, 'open_checks', '마감하지 않은 체크가 있는 창구는 합칠 수 없습니다. 먼저 마감하세요.');
  await ctx.db.update('ballot_pad', { desk_id: from.id }, { desk_id: to.id });
  await ctx.db.update('device_session', { desk_id: from.id }, { desk_id: to.id });
  if (!to.is_all && !to.is_unassigned) await ctx.db.update('desk', { id: to.id }, { depts: JSON.stringify([...new Set([...parseDepts(to), ...parseDepts(from)])]) });
  await ctx.db.update('desk', { id: from.id }, { merged_into: to.id, depts: '[]' });
  await log(ctx.db, me, 'desk.merge', { station_id: from.station_id, note: `창구 "${from.name}" → "${to.name}"` });
  return { ok: true };
});

// ---------- 묶음 (FR-100) ----------
function parseSerial(v: unknown, name: string): number {
  const s = String(v ?? '').replace(/\s/g, '');
  if (!/^\d{1,6}$/.test(s)) throw new HttpError(400, 'bad_serial', `${name}는 숫자 6자리 이하로 넣으세요.`);
  const n = Number(s);
  if (n < 1 || n > SERIAL_MAX) throw new HttpError(400, 'bad_serial', `${name}는 ${fmtNo(1)}~${fmtNo(SERIAL_MAX)} 사이여야 합니다.`);
  return n;
}
export async function activePads(db: Db, deskId: string): Promise<BallotPad[]> {
  return (await db.all<BallotPad>('ballot_pad', { desk_id: deskId }, 'first_no')).filter((p) => !p.exhausted_at);
}
export const padView = (p: BallotPad) => ({
  id: p.id, desk_id: p.desk_id, first_no: p.first_no, last_no: p.last_no, used_no: p.used_no, used_total: p.used_total, by_count: p.by_count,
  exhausted: !!p.exhausted_at, label: padLabel(p),
});

route('POST', '/roster/pads', async (ctx) => {
  const { me, station } = await gateAt(ctx, ctx.req.body?.station_id, { skipHours: true });
  const desk = await deskOf(ctx, station, ctx.req.body?.desk_id);
  const first = parseSerial(ctx.req.body?.first_no, '첫 번호');
  if (first % PAD_SIZE !== 1) throw new HttpError(400, 'bad_serial', `묶음의 첫 번호는 …01로 끝납니다 (예: ${fmtNo(Math.floor((first - 1) / PAD_SIZE) * PAD_SIZE + 1)}).`);
  const dup = await ctx.db.get<BallotPad>('ballot_pad', { first_no: first });
  if (dup) {
    const d = await ctx.db.get<Desk>('desk', { id: dup.desk_id });
    throw new HttpError(409, 'pad_exists', dup.desk_id === desk.id ? '이미 이 창구에 등록된 묶음입니다.' : `이미 "${d?.name ?? '다른'}" 창구에 등록된 묶음입니다. 가져다 쓰려면 "묶음 받기"를 누르세요.`);
  }
  const pad: BallotPad = {
    id: randomUUID(), station_id: station.id, desk_id: desk.id, first_no: first, last_no: first + PAD_SIZE - 1, used_no: null, used_total: 0, by_count: false,
    opened_at: nowIso(), opened_by: whoName(ctx), device_id: ctx.device?.id ?? null, exhausted_at: null,
  };
  await ctx.db.insert('ballot_pad', pad);
  await accessLog(ctx, station.id, 'pad.add', null, 'ok', `${desk.name} · ${padLabel(pad)}`);
  return { pad: padView(pad) };
});

/** 다른 창구의 묶음을 통째로 가져온다 (FR-100a). 직전 번호가 이어진다. */
route('POST', '/roster/pads/receive', async (ctx) => {
  const { me, station } = await gateAt(ctx, ctx.req.body?.station_id, { skipHours: true });
  const desk = await deskOf(ctx, station, ctx.req.body?.desk_id);
  const first = parseSerial(ctx.req.body?.first_no, '첫 번호');
  const pad = await ctx.db.get<BallotPad>('ballot_pad', { first_no: Math.floor((first - 1) / PAD_SIZE) * PAD_SIZE + 1 });
  if (!pad) throw new HttpError(404, 'not_found', '등록된 묶음이 아닙니다. 처음 쓰는 묶음이면 "묶음 추가"를 누르세요.');
  if (pad.station_id !== station.id && me.role !== 'admin') throw new HttpError(403, 'other_station', '다른 투표소의 묶음입니다. 총관리자에게 요청하세요.');
  if (pad.desk_id === desk.id) throw new HttpError(409, 'same_desk', '이미 이 창구의 묶음입니다.');
  if (pad.exhausted_at) throw new HttpError(409, 'exhausted', '다 쓴 묶음입니다.');
  if ((await ctx.db.all<TallyWindow>('tally_window', { desk_id: pad.desk_id, status: 'reconciling' })).length) {
    throw new HttpError(409, 'reconciling', '주는 창구가 꼬리표 대조 중입니다. 그 대조가 끝난 뒤에 받을 수 있습니다.');
  }
  const from = await ctx.db.get<Desk>('desk', { id: pad.desk_id });
  await ctx.db.update('ballot_pad', { id: pad.id }, { desk_id: desk.id, station_id: station.id });
  await ctx.db.insert<PadMove>('pad_move', { id: randomUUID(), pad_id: pad.id, from_desk_id: pad.desk_id, to_desk_id: desk.id, at: nowIso(), operator_name: whoName(ctx), device_id: ctx.device?.id ?? null });
  await accessLog(ctx, station.id, 'pad.receive', null, 'ok', `${padLabel(pad)} · ${from?.name ?? '?'} → ${desk.name}`);
  return { pad: padView({ ...pad, desk_id: desk.id }) };
});

route('DELETE', '/roster/pads/:id', async (ctx) => {
  const { me, station } = await gateAt(ctx, ctx.req.query.station_id, { skipHours: true });
  const pad = await ctx.db.get<BallotPad>('ballot_pad', { id: ctx.params.id });
  if (!pad || pad.station_id !== station.id) throw new HttpError(404, 'not_found', '묶음을 찾을 수 없습니다.');
  if (me.role !== 'admin' && pad.desk_id !== (await deskOf(ctx, station)).id) throw new HttpError(403, 'forbidden', '이 창구의 묶음이 아닙니다.');
  if (pad.used_total > 0 || (await ctx.db.count('pad_reading', { pad_id: pad.id })) > 0) throw new HttpError(409, 'in_use', '한 장이라도 쓴 묶음은 지울 수 없습니다. 총관리자에게 요청하세요.');
  await ctx.db.remove('ballot_pad', { id: pad.id });
  await accessLog(ctx, station.id, 'pad.remove', null, 'ok', padLabel(pad));
  return { ok: true };
});

/** 총관리자: 묶음 현황 (FR-100b) */
route('GET', '/pads', async (ctx) => {
  requireAdmin(ctx);
  const [pads, desks, moves] = await Promise.all([ctx.db.all<BallotPad>('ballot_pad', undefined, 'first_no'), allDesks(ctx.db), ctx.db.all<PadMove>('pad_move', undefined, 'at')]);
  return { pads, desks: desks.map((d) => ({ ...deskView(d), merged_into: d.merged_into })), moves, pad_size: PAD_SIZE, serial_max: SERIAL_MAX };
});

route('PUT', '/pads/:id', async (ctx) => {
  const me = requireAdmin(ctx);
  const pad = await ctx.db.get<BallotPad>('ballot_pad', { id: ctx.params.id });
  if (!pad) throw new HttpError(404, 'not_found', '묶음을 찾을 수 없습니다.');
  const b = ctx.req.body ?? {};
  const reason = str(b.reason, '사유', 300);
  const patch: Partial<BallotPad> = {};
  if (b.desk_id && b.desk_id !== pad.desk_id) {
    const d = await ctx.db.get<Desk>('desk', { id: String(b.desk_id) });
    if (!d || d.merged_into) throw new HttpError(404, 'not_found', '창구를 찾을 수 없습니다.');
    patch.desk_id = d.id; patch.station_id = d.station_id;
  }
  if (b.last_no !== undefined && b.last_no !== null && b.last_no !== '') {
    const last = parseSerial(b.last_no, '끝 번호');
    if (last < pad.first_no || last > pad.first_no + PAD_SIZE - 1) throw new HttpError(400, 'bad_serial', '끝 번호가 묶음 범위를 벗어납니다.');
    patch.last_no = last;
  }
  if (b.used_total !== undefined && b.used_total !== null && b.used_total !== '') {
    const size = (patch.last_no ?? pad.last_no) - pad.first_no + 1;
    const used = int(b.used_total, '누적 사용 장수');
    if (used > size) throw new HttpError(400, 'bad_request', `누적 사용 장수는 ${size}장을 넘을 수 없습니다.`);
    patch.used_total = used; patch.used_no = used > 0 ? pad.first_no + used - 1 : null;
    patch.exhausted_at = used >= size ? nowIso() : null;
  }
  if (!Object.keys(patch).length) throw new HttpError(400, 'bad_request', '바뀐 내용이 없습니다.');
  await ctx.db.update('ballot_pad', { id: pad.id }, patch);
  await log(ctx.db, me, 'pad.update', { station_id: pad.station_id, before_json: JSON.stringify({ desk_id: pad.desk_id, last_no: pad.last_no, used_total: pad.used_total }), after_json: JSON.stringify(patch), note: `${padLabel(pad)} · ${reason}` });
  return { ok: true };
});

// ---------- 꼬리표 누적 수로 마감 (v1.5, FR-111~113) ----------
/** 마감 때 근무자가 센 "이 창구의 꼬리표 누적 수"와 그 직전 누적 수. 구간의 pad_json에 남긴다. */
export interface TagTotal { total: number; prev: number }
export function tagTotalOf(w: Pick<TallyWindow, 'pad_json'>): TagTotal | null {
  try {
    const j = w.pad_json ? JSON.parse(w.pad_json) : null;
    return j && !Array.isArray(j) && Number.isFinite(j.total) ? { total: Number(j.total), prev: Number(j.prev ?? 0) } : null;
  } catch { return null; }
}
/**
 * 창구의 직전 꼬리표 누적 수: 끝난 구간을 차례로 보며, 누적 수가 적힌 구간은 그 값으로, 없는 구간(v1.4 기록)은 꼬리표 수를 더한다.
 * 이 창구로 합친 창구의 꼬리표도 이 창구에 쌓여 있으므로 함께 더한다.
 */
export async function tagBaseline(db: Db, deskId: string): Promise<number> {
  const [desks, wins] = await Promise.all([allDesks(db), db.all<TallyWindow>('tally_window', undefined, 'boundary_at')]);
  const ids = new Set([deskId]);
  for (let grew = true; grew;) { grew = false; for (const d of desks) if (d.merged_into && ids.has(d.merged_into) && !ids.has(d.id)) { ids.add(d.id); grew = true; } }
  let sum = 0;
  for (const id of ids) {
    let cum = 0;
    for (const w of wins) {
      if (w.desk_id !== id || w.status === 'reconciling') continue;
      const t = tagTotalOf(w);
      cum = t ? t.total : cum + (w.tag_count ?? w.accepted_count ?? 0);
    }
    sum += cum;
  }
  return sum;
}

// ---------- 이슈 신고 (FR-104, FR-105) ----------
route('POST', '/roster/issues', async (ctx) => {
  const { station } = await gateAt(ctx, ctx.req.body?.station_id, { skipHours: true });
  const desk = await deskOf(ctx, station, ctx.req.body?.desk_id);
  const b = ctx.req.body ?? {};
  const type = String(b.type ?? '') as IssueType;
  if (!ISSUE_TYPES[type]) throw new HttpError(400, 'bad_request', '이슈 유형을 고르세요.');
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, 300) : '';
  if (type === 'other' && !note) throw new HttpError(400, 'bad_request', '"기타"는 메모를 적어야 합니다.');
  const from = b.serial_from !== undefined && b.serial_from !== null && b.serial_from !== '' ? parseSerial(b.serial_from, '일련번호') : null;
  const to = b.serial_to !== undefined && b.serial_to !== null && b.serial_to !== '' ? parseSerial(b.serial_to, '일련번호') : from;
  if (from !== null && to !== null && to < from) throw new HttpError(400, 'bad_serial', '끝 번호가 시작 번호보다 작습니다.');
  const count = b.count !== undefined && b.count !== null && b.count !== '' ? int(b.count, '장수', 1) : from !== null && to !== null ? to - from + 1 : 1;
  let padId: string | null = null;
  if (b.pad_id) {
    const pad = await ctx.db.get<BallotPad>('ballot_pad', { id: String(b.pad_id) });
    if (!pad || pad.station_id !== station.id) throw new HttpError(404, 'not_found', '묶음을 찾을 수 없습니다.');
    padId = pad.id;
  } else if (from !== null) {
    padId = (await ctx.db.get<BallotPad>('ballot_pad', { first_no: Math.floor((from - 1) / PAD_SIZE) * PAD_SIZE + 1 }))?.id ?? null;
  }
  const win = (await ctx.db.all<TallyWindow>('tally_window', { desk_id: desk.id, status: 'reconciling' }))[0] ?? null;
  const issue: TagIssue = {
    id: randomUUID(), station_id: station.id, desk_id: desk.id, window_id: win?.id ?? null, pad_id: padId, type, serial_from: from, serial_to: to, count, note: note || null,
    device_id: ctx.device?.id ?? null, operator_name: whoName(ctx), at: nowIso(), reviewed_by: null, reviewed_at: null, voided_by: null, voided_at: null, void_reason: null,
  };
  await ctx.db.insert('tag_issue', issue);
  await accessLog(ctx, station.id, 'issue.report', null, type, `${desk.name} · ${ISSUE_TYPES[type]} ${count}장${from !== null ? ` · ${fmtNo(from)}${to !== from ? `~${fmtNo(to!)}` : ''}` : ''}`);
  return { issue };
});

route('GET', '/roster/issues', async (ctx) => {
  const me = requireAuth(ctx);
  if (me.role === 'member') throw new HttpError(403, 'forbidden');
  const where = me.role === 'station' ? { station_id: me.station_id ?? '' } : undefined;
  const [issues, desks, pads] = await Promise.all([ctx.db.all<TagIssue>('tag_issue', where, 'at desc'), allDesks(ctx.db), ctx.db.all<BallotPad>('ballot_pad')]);
  return {
    issues: issues.map((i) => ({ ...i, desk_name: desks.find((d) => d.id === i.desk_id)?.name ?? null, pad_label: (() => { const p = pads.find((x) => x.id === i.pad_id); return p ? padLabel(p) : null; })() })),
    types: ISSUE_TYPES,
  };
});

route('POST', '/roster/issues/:id/review', async (ctx) => {
  const me = requireAdmin(ctx);
  const i = await ctx.db.get<TagIssue>('tag_issue', { id: ctx.params.id });
  if (!i) throw new HttpError(404, 'not_found', '이슈를 찾을 수 없습니다.');
  const on = ctx.req.body?.reviewed !== false;
  await ctx.db.update('tag_issue', { id: i.id }, { reviewed_by: on ? me.name : null, reviewed_at: on ? nowIso() : null });
  return { ok: true };
});

route('POST', '/roster/issues/:id/void', async (ctx) => {
  const me = requireAdmin(ctx);
  const i = await ctx.db.get<TagIssue>('tag_issue', { id: ctx.params.id });
  if (!i) throw new HttpError(404, 'not_found', '이슈를 찾을 수 없습니다.');
  const reason = str(ctx.req.body?.reason, '무효 사유', 300);
  await ctx.db.update('tag_issue', { id: i.id }, { voided_by: me.name, voided_at: nowIso(), void_reason: reason });
  await log(ctx.db, me, 'issue.void', { station_id: i.station_id, note: `${ISSUE_TYPES[i.type]} · ${reason}` });
  return { ok: true };
});

/** 체크 기록 초기화 때 창구·묶음·이슈도 지운다 (FR-106). */
export async function resetDeskData(db: Db) {
  for (const t of ['pad_reading', 'pad_move', 'ballot_pad', 'tag_issue', 'desk']) await db.removeAll(t);
  for (const d of await db.all<DeviceSession>('device_session')) if (d.desk_id) await db.update('device_session', { id: d.id }, { desk_id: null });
  invalidatePlaces();
}
