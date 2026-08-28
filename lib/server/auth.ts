import 'server-only';
import crypto from 'node:crypto';
import { db } from './supabase';

/**
 * 神父の簡易認証。
 *
 * 関数は毎回まっさらな状態で起動するので、発行したトークンを
 * サーバー側で覚えておくことができない。そこで
 * 「有効期限＋署名」を含んだトークンを発行し、署名を検証するだけで
 * 済むようにする（保管が要らない）。
 */

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12時間

function password(): string | null {
  const value = process.env.ADMIN_PASSWORD;
  return value && value.length > 0 ? value : null;
}

/** トークンの署名鍵。合言葉を変えれば、発行済みのトークンは自動的に無効になる。 */
function signingKey(): string {
  return crypto
    .createHash('sha256')
    .update(`kikimiya:${password() ?? ''}:${process.env.SUPABASE_SECRET_KEY ?? ''}`)
    .digest('hex');
}

export function passwordConfigured(): boolean {
  return password() !== null;
}

function sign(value: string): string {
  return crypto.createHmac('sha256', signingKey()).update(value).digest('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function issueToken(): string {
  const expiresAt = String(Date.now() + TOKEN_TTL_MS);
  return `${expiresAt}.${sign(expiresAt)}`;
}

/**
 * 期限が近づいているか。
 *
 * 待機所は何時間も開きっぱなしにする前提なので、
 * 12時間で黙って落ちると「在室のつもりが不在」になる。
 * 残りが少なくなったら、在室の信号のついでに新しいトークンを配る。
 */
export function expiresSoon(token: string | null | undefined): boolean {
  if (!token) return false;
  const [expiresAt] = token.split('.');
  const remaining = Number(expiresAt) - Date.now();
  return Number.isFinite(remaining) && remaining < TOKEN_TTL_MS / 2;
}

export function verifyToken(token: string | null | undefined): boolean {
  if (!token) return false;
  const [expiresAt, signature] = token.split('.');
  if (!expiresAt || !signature) return false;
  if (!safeEqual(signature, sign(expiresAt))) return false;
  return Number(expiresAt) > Date.now();
}

export function checkPassword(candidate: string): boolean {
  const expected = password();
  if (!expected) return false;
  return safeEqual(candidate, expected);
}

export function bearerFrom(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

/**
 * 神父だけに教えるリアルタイムの通り道の名前。
 * 合言葉を知らなければ算出できないので、他人には覗けない。
 */
export function adminTopic(): string {
  return `kikimiya:admin:${sign('admin-channel').slice(0, 24)}`;
}

/* --------------------------- 総当たり対策 --------------------------- */

const FAIL_LIMIT = 5;
const LOCK_MINUTES = 15;

/** 誰からの試行かは、IPそのものではなくハッシュ化した値で数える */
export function attemptKey(source: string | null): string {
  return crypto
    .createHmac('sha256', signingKey())
    .update(source ?? 'unknown')
    .digest('base64url')
    .slice(0, 32);
}

/** ロック中なら残り分数、そうでなければ 0 */
export async function lockedMinutes(key: string): Promise<number> {
  const { data } = await db()
    .from('login_attempts')
    .select('locked_until')
    .eq('id', key)
    .maybeSingle();
  if (!data?.locked_until) return 0;
  const remaining = new Date(data.locked_until).getTime() - Date.now();
  return remaining > 0 ? Math.ceil(remaining / 60000) : 0;
}

export async function noteFailure(key: string): Promise<void> {
  const now = Date.now();
  const { data } = await db()
    .from('login_attempts')
    .select('count, reset_at')
    .eq('id', key)
    .maybeSingle();

  const expired = !data || new Date(data.reset_at).getTime() < now;
  const count = expired ? 1 : (data?.count ?? 0) + 1;

  await db()
    .from('login_attempts')
    .upsert({
      id: key,
      count: count >= FAIL_LIMIT ? 0 : count,
      locked_until:
        count >= FAIL_LIMIT ? new Date(now + LOCK_MINUTES * 60000).toISOString() : null,
      reset_at: new Date(now + LOCK_MINUTES * 60000).toISOString(),
    });
}

export async function noteSuccess(key: string): Promise<void> {
  await db().from('login_attempts').delete().eq('id', key);
}
