/** ブラウザから見た「常時起動サーバー」の場所。未設定ならローカル開発用の既定値。 */
export const SERVER_URL =
  process.env.NEXT_PUBLIC_SERVER_URL?.replace(/\/$/, '') || 'http://localhost:3001';

/** お布施の受け口となる Payment Link。空ならお布施の導線ごと出さない。 */
export const PAYMENT_LINK = process.env.NEXT_PUBLIC_STRIPE_PAYMENT_LINK || '';

/**
 * お布施を受け付けるか。
 * Payment Link を設定すれば自動で有効になる。
 * サーバー側で決済画面を作る方式（STRIPE_SECRET_KEY）を使う場合だけ、
 * NEXT_PUBLIC_DONATION_ENABLED=1 を明示する。
 */
export const DONATION_ENABLED =
  Boolean(PAYMENT_LINK) || process.env.NEXT_PUBLIC_DONATION_ENABLED === '1';

/** ハートビートの送信間隔（サーバー側のタイムアウトは既定15秒） */
export const HEARTBEAT_INTERVAL_MS = 5000;
