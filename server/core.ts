import { randomUUID } from 'node:crypto';
import type { AuditLog, Db, District, Election, ElectionDay, Member, Slot, Station } from './db/types.js';
import { nowIso, slotEpoch } from './logic/time.js';
import { SESSION_TTL_MS } from './auth.js';

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

export class HttpError extends Error {
  constructor(public status: number, public code: string, message?: string, public extra?: unknown) {
    super(message ?? code);
  }
}

export type Ctx = { db: Db; member: Member | null; req: ApiRequest; params: Record<string, string> };
export type Handler = (ctx: Ctx) => Promise<unknown | ApiResponse>;
interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler }
export const routes: Route[] = [];

export function route(method: string, path: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:([a-zA-Z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, pattern, keys, handler });
}

export const COOKIE = 'vote_session';
export const isProd = () => !!process.env.VERCEL || process.env.NODE_ENV === 'production';
export function cookieHeader(token: string | null): string {
  const base = `${COOKIE}=${token ?? ''}; Path=/; HttpOnly; SameSite=Lax${isProd() ? '; Secure' : ''}`;
  return token ? `${base}; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` : `${base}; Max-Age=0`;
}

export function requireAuth(ctx: Ctx): Member {
  if (!ctx.member) throw new HttpError(401, 'unauthenticated', '로그인이 필요합니다.');
  return ctx.member;
}
export function requireAdmin(ctx: Ctx): Member {
  const m = requireAuth(ctx);
  if (m.role !== 'admin') throw new HttpError(403, 'forbidden', '총관리자만 할 수 있습니다.');
  return m;
}
export function int(v: unknown, name: string, min = 0): number {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < min) throw new HttpError(400, 'bad_request', `${name} 값이 올바르지 않습니다.`);
  return n;
}
export function str(v: unknown, name: string, max = 200): string {
  if (typeof v !== 'string' || v.trim().length === 0 || v.length > max) throw new HttpError(400, 'bad_request', `${name} 값이 올바르지 않습니다.`);
  return v.trim();
}
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export async function log(db: Db, actor: Member, action: string, fields: Partial<AuditLog> = {}) {
  await db.insert<AuditLog>('audit_log', {
    id: randomUUID(), at: nowIso(), actor_id: actor.id, actor_name: actor.name, action,
    station_id: null, slot_id: null, before_json: null, after_json: null, note: null, ...fields,
  });
}

export async function loadConfig(db: Db) {
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

export function slotKey(slot: Slot, days: ElectionDay[]) {
  const day = days.find((d) => d.id === slot.day_id)!;
  return { date: day.date, time: slot.time, epoch: slotEpoch(day.date, slot.time), isExtension: day.is_extension };
}

