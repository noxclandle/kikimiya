/**
 * 神父（運営者）用の簡易認証。
 * 環境変数 ADMIN_PASSWORD と照合し、成功したらメモリ上のトークンを発行する。
 * 会員登録・ユーザーDBは持たない（来訪者側に認証は一切ない）。
 */
import crypto from 'node:crypto';

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12時間
const tokens = new Map<string, number>(); // token -> 失効時刻

function adminPassword(): string | null {
  const value = process.env.ADMIN_PASSWORD;
  return value && value.length > 0 ? value : null;
}

/** タイミング差から password を推測されないよう定数時間で比較する */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function passwordConfigured(): boolean {
  return adminPassword() !== null;
}

/* ----------------------- 総当たり対策 ----------------------- */

/**
 * 短い合言葉でも破られないよう、失敗が続いたらしばらく受け付けない。
 * 誰からの試行かはIPアドレスそのものではなく、
 * 起動ごとに変わるソルトでハッシュ化した値で数える（IPは保持しない）。
 */
const FAIL_LIMIT = Number(process.env.LOGIN_FAIL_LIMIT ?? 5);
const LOCK_MS = Number(process.env.LOGIN_LOCK_MS ?? 15 * 60 * 1000);
const ATTEMPT_SALT = crypto.randomBytes(16);
const attempts = new Map<string, { count: number; lockedUntil: number; resetAt: number }>();

export function attemptKey(source: string | undefined): string {
  return crypto
    .createHmac('sha256', ATTEMPT_SALT)
    .update(source ?? 'unknown')
    .digest('base64');
}

/** ロック中なら残りミリ秒、そうでなければ 0 */
export function lockedFor(key: string): number {
  const record = attempts.get(key);
  if (!record) return 0;
  const remaining = record.lockedUntil - Date.now();
  return remaining > 0 ? remaining : 0;
}

export function noteFailure(key: string): void {
  const now = Date.now();
  const record = attempts.get(key);
  if (!record || record.resetAt < now) {
    attempts.set(key, { count: 1, lockedUntil: 0, resetAt: now + LOCK_MS });
    return;
  }
  record.count += 1;
  if (record.count >= FAIL_LIMIT) {
    record.lockedUntil = now + LOCK_MS;
    record.count = 0;
  }
}

export function noteSuccess(key: string): void {
  attempts.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, record] of attempts) {
    if (record.resetAt < now && record.lockedUntil < now) attempts.delete(key);
  }
}, 10 * 60 * 1000).unref();

export function issueToken(password: string): string | null {
  const expected = adminPassword();
  if (!expected) return null;
  if (!safeEqual(password, expected)) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

export function verifyToken(token: string | undefined | null): boolean {
  if (!token) return false;
  const expiresAt = tokens.get(token);
  if (!expiresAt) return false;
  if (expiresAt < Date.now()) {
    tokens.delete(token);
    return false;
  }
  return true;
}

export function revokeToken(token: string): void {
  tokens.delete(token);
}

export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match ? match[1] : null;
}

// 期限切れトークンの掃除
setInterval(() => {
  const now = Date.now();
  for (const [token, expiresAt] of tokens) {
    if (expiresAt < now) tokens.delete(token);
  }
}, 60 * 60 * 1000).unref();
