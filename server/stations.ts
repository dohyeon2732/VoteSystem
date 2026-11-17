/**
 * 투표소 공용 계정과 기기 세션 (명세 v1.2 15.5, FR-92·FR-94a·FR-94b)
 * 근무표 대신, 투표소마다 계정 1개를 두고 그 투표소 근무자들이 같은 코드로 각자 기기에서 로그인한다.
 */
import { randomUUID } from 'node:crypto';
import { HttpError, log, requireAdmin, route } from './core.js';
import type { Db, DeviceSession, Member, OperatorLog, Station } from './db/types.js';
import { generateCode, hashCode, stationExpiry } from './auth.js';
import { nowIso } from './logic/time.js';
import { accessLog } from './roster.js';

const TOUCH_EVERY_MS = 60_000; // 마지막 활동 시각은 1분에 한 번만 기록

/** 투표소 계정이 부를 수 있는 API (FR-94c). 나머지는 요청 처음에 거부한다. */
export const STATION_PATHS: { method: string; re: RegExp }[] = [
  ['POST', '/login'], ['POST', '/logout'], ['GET', '/me'], ['GET', '/config'],
  ['GET', '/roster/me'], ['POST', '/roster/operator'], ['POST', '/roster/lookup'], ['POST', '/roster/issue'],
  ['POST', '/roster/cancel'], ['GET', '/roster/station'], ['POST', '/roster/close'], ['POST', '/roster/close/[^/]+/submit'],
  ['GET', '/roster/windows'],
  // v1.4 창구·묶음·이슈
  ['GET', '/roster/desks'], ['POST', '/roster/pads'], ['POST', '/roster/pads/receive'], ['DELETE', '/roster/pads/[^/]+'],
  ['POST', '/roster/issues'], ['GET', '/roster/issues'],
].map(([method, path]) => ({ method, re: new RegExp(`^${path}$`) }));

export async function createDevice(db: Db, member: Member, userAgent: string | null): Promise<DeviceSession> {
  if (!member.station_id) throw new HttpError(409, 'no_station', '투표소가 지정되지 않은 계정입니다. 총관리자에게 문의하세요.');
  const now = Date.now();
  const n = await db.count('device_session', { station_id: member.station_id });
  const at = new Date(now).toISOString();
  const dev: DeviceSession = {
    id: randomUUID(), member_id: member.id, station_id: member.station_id, device_no: n + 1,
    created_at: at, expires_at: new Date(stationExpiry(now)).toISOString(), last_seen_at: at,
    operator_name: null, operator_since: null, operator_pledged_at: null, revoked_at: null,
    user_agent: userAgent ? userAgent.slice(0, 300) : null,
  };
  await db.insert('device_session', dev);
  return dev;
}

export async function revokeDevice(db: Db, id: string) {
  await db.update('device_session', { id, revoked_at: null }, { revoked_at: nowIso() });
}

export async function touchDevice(db: Db, d: DeviceSession): Promise<DeviceSession> {
  if (Date.now() - Date.parse(d.last_seen_at) < TOUCH_EVERY_MS) return d;
  const at = nowIso();
  await db.update('device_session', { id: d.id }, { last_seen_at: at });
  return { ...d, last_seen_at: at };
}

const deviceStatus = (d: DeviceSession, now = Date.now()) =>
  d.revoked_at ? 'revoked' : Date.parse(d.expires_at) <= now ? 'expired' : 'active';

const accountView = ({ code_hash: _h, ...m }: Member) => m;

// ---------- 총관리자: 투표소 계정·기기 (S-12) ----------
route('GET', '/stations/accounts', async (ctx) => {
  requireAdmin(ctx);
  const [stations, accounts, devices, logs] = await Promise.all([
    ctx.db.all<Station>('station', undefined, 'sort'),
    ctx.db.all<Member>('member', { role: 'station' }, 'created_at'),
    ctx.db.all<DeviceSession>('device_session', undefined, 'created_at desc'),
    ctx.db.all<OperatorLog>('operator_log', undefined, 'started_at'),
  ]);
  const now = Date.now();
  return {
    stations: stations.map((st) => ({
      station: st,
      accounts: accounts.filter((a) => a.station_id === st.id).map(accountView),
      devices: devices.filter((d) => d.station_id === st.id).map((d) => ({
        ...d, status: deviceStatus(d, now),
        history: logs.filter((l) => l.device_id === d.id).map((l) => ({ operator_name: l.operator_name, started_at: l.started_at })),
      })),
    })),
    server_now: nowIso(),
  };
});

/** 활성 계정이 없는 투표소마다 계정을 만들고, 코드는 이 응답에서 한 번만 보여 준다 (FR-92). */
route('POST', '/stations/accounts/bulk', async (ctx) => {
  const me = requireAdmin(ctx);
  const [stations, members] = await Promise.all([ctx.db.all<Station>('station', undefined, 'sort'), ctx.db.all<Member>('member')]);
  const activeNames = new Set(members.filter((m) => m.active).map((m) => m.name));
  const created: { station_id: string; station_name: string; name: string; code: string }[] = [];
  for (const st of stations) {
    if (members.some((m) => m.role === 'station' && m.active && m.station_id === st.id)) continue;
    const name = activeNames.has(st.name) ? `${st.name} 투표소` : st.name;
    if (activeNames.has(name)) throw new HttpError(409, 'exists', `"${name}" 이름의 활성 계정이 있어 만들 수 없습니다.`);
    const code = generateCode();
    await ctx.db.insert<Member>('member', {
      id: randomUUID(), name, role: 'station', code_hash: hashCode(code), code_version: 1, active: true,
      created_at: nowIso(), last_login_at: null, failed_count: 0, locked_until: null, station_id: st.id,
    });
    activeNames.add(name);
    created.push({ station_id: st.id, station_name: st.name, name, code });
  }
  if (created.length) await log(ctx.db, me, 'station_account.bulk', { note: `투표소 계정 ${created.length}개 생성` });
  return { created };
});

/** 선거가 끝나면 투표소 계정을 모두 비활성화 (FR-92). 로그인한 기기도 바로 끊긴다. */
route('POST', '/stations/accounts/deactivate', async (ctx) => {
  const me = requireAdmin(ctx);
  if (String(ctx.req.body?.confirm ?? '').normalize('NFC').trim() !== '투표소계정종료') throw new HttpError(400, 'bad_request', '확인 문구가 맞지 않습니다.');
  const accounts = (await ctx.db.all<Member>('member', { role: 'station' })).filter((m) => m.active);
  for (const a of accounts) await ctx.db.update('member', { id: a.id }, { active: false, code_version: a.code_version + 1 });
  const devices = (await ctx.db.all<DeviceSession>('device_session', { revoked_at: null }));
  await ctx.db.update('device_session', { revoked_at: null }, { revoked_at: nowIso() });
  await log(ctx.db, me, 'station_account.deactivate_all', { note: `투표소 계정 ${accounts.length}개 비활성화 · 기기 ${devices.length}대 로그아웃` });
  await accessLog(ctx, null, 'device.revoke_all', null, 'ok', `계정 ${accounts.length}개 · 기기 ${devices.length}대`);
  return { ok: true, accounts: accounts.length, devices: devices.length };
});

/** 모르는 기기만 강제 로그아웃 (FR-94b). 계정 전체를 끊으려면 코드 재발급. */
route('POST', '/devices/:id/revoke', async (ctx) => {
  const me = requireAdmin(ctx);
  const d = await ctx.db.get<DeviceSession>('device_session', { id: ctx.params.id });
  if (!d) throw new HttpError(404, 'not_found', '기기를 찾을 수 없습니다.');
  if (d.revoked_at) return { ok: true };
  await revokeDevice(ctx.db, d.id);
  await log(ctx.db, me, 'device.revoke', { station_id: d.station_id, note: `${d.device_no}번 기기${d.operator_name ? ` (담당자 ${d.operator_name})` : ''}` });
  await accessLog(ctx, d.station_id, 'device.revoke', null, 'ok', `${d.device_no}번 기기${d.operator_name ? ` · ${d.operator_name}` : ''}`);
  return { ok: true };
});
