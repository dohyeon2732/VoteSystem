import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.SESSION_SECRET ?? 'dev-secret-change-me';
export const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2시간
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 혼동 문자(0/O, 1/I) 제외

export function generateCode(length = 8): string {
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return out;
}

export function normalizeCode(code: string): string {
  return code.trim().toUpperCase();
}

export function hashCode(code: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(normalizeCode(code), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyCode(code: string, stored: string): boolean {
  const [salt, hash] = stored.split(':');
  if (!salt || !hash) return false;
  const candidate = scryptSync(normalizeCode(code), salt, 32);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

/** sid = 투표소 기기 세션 id (투표소 계정만, v1.2) */
export interface SessionPayload { mid: string; v: number; exp: number; sid?: string }

function sign(data: string): string {
  return createHmac('sha256', SECRET).update(data).digest('base64url');
}

export const STATION_TTL_MS = 10 * 60 * 60 * 1000; // 투표소 기기 10시간 (FR-94a)

/** 투표소 기기 세션 만료: 로그인 10시간 뒤와 그날 자정(KST) 중 이른 때. */
export function stationExpiry(now = Date.now()): number {
  const kstMidnight = Date.parse(new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10) + 'T00:00:00+09:00') + 24 * 3600 * 1000;
  return Math.min(now + STATION_TTL_MS, kstMidnight);
}

/** 자동 백업 중인 총관리자 세션 연장: 2시간 뒤와 그날 자정(KST) 중 이른 때 (FR-96a). */
export function renewedExpiry(now = Date.now()): number {
  const kstMidnight = Date.parse(new Date(now + 9 * 3600 * 1000).toISOString().slice(0, 10) + 'T00:00:00+09:00') + 24 * 3600 * 1000;
  return Math.min(now + SESSION_TTL_MS, kstMidnight);
}

export function createSessionToken(memberId: string, codeVersion: number, opts: { sid?: string; exp?: number } = {}): string {
  const payload: SessionPayload = { mid: memberId, v: codeVersion, exp: opts.exp ?? Date.now() + SESSION_TTL_MS, ...(opts.sid ? { sid: opts.sid } : {}) };
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${data}.${sign(data)}`;
}

export function readSessionToken(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [data, sig] = token.split('.');
  if (!data || !sig) return null;
  const expected = sign(data);
  if (expected.length !== sig.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  try {
    const payload = JSON.parse(Buffer.from(data, 'base64url').toString()) as SessionPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
