import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * 선거인명부 암호화 (명세 15.9)
 * - 학번: 원문을 저장하지 않고 HMAC-SHA256 값으로만 검색 (VOTER_HMAC_KEY)
 * - 이름·학과: AES-256-GCM 암호화 (VOTER_ENC_KEY)
 * 키는 32바이트를 base64 또는 hex로 넣는다. 예: `openssl rand -base64 32`
 */
function loadKey(envName: string): Buffer {
  const raw = (process.env[envName] ?? '').trim();
  if (!raw) {
    if (process.env.VERCEL || process.env.NODE_ENV === 'production') {
      throw Object.assign(new Error(`${envName} 환경변수가 없습니다. 명부 기능을 쓰려면 배포 환경변수에 등록하세요.`), { status: 500, code: 'no_key' });
    }
    // 로컬 개발 전용 고정 키 (실제 명부를 로컬에 올리지 않는다는 전제)
    return createHash('sha256').update(`local-dev-${envName}`).digest();
  }
  const buf = /^[0-9a-fA-F]{64}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw Object.assign(new Error(`${envName} 는 32바이트여야 합니다 (openssl rand -base64 32).`), { status: 500, code: 'bad_key' });
  }
  return buf;
}

let encKey: Buffer | null = null;
let hmacKey: Buffer | null = null;
const getEncKey = () => (encKey ??= loadKey('VOTER_ENC_KEY'));
const getHmacKey = () => (hmacKey ??= loadKey('VOTER_HMAC_KEY'));

/** 학번 정규화: 숫자만 남긴다. */
export function normalizeSid(sid: unknown): string {
  return String(sid ?? '').replace(/[^0-9]/g, '');
}

export function hashSid(sid: string): string {
  return createHmac('sha256', getHmacKey()).update(normalizeSid(sid)).digest('hex');
}

export function encrypt(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getEncKey(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${iv.toString('base64')}.${cipher.getAuthTag().toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(token: string): string {
  const [iv, tag, ct] = token.split('.');
  const d = createDecipheriv('aes-256-gcm', getEncKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
