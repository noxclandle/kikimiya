const CONFIGURED_SERVER_URL = process.env.NEXT_PUBLIC_SERVER_URL?.replace(/\/$/, '') || '';

/**
 * ブラウザから見た「常時起動サーバー」の場所。
 *
 * 未設定のときに localhost へ落とすのは、手元で動かしているときだけにする。
 * 公開されたサイトから ws://localhost:3001 を叩きにいっても繋がるはずがなく、
 * 「設定を入れ忘れている」ことに気づけないまま延々と再接続を繰り返すため。
 */
export const SERVER_URL: string = (() => {
  if (CONFIGURED_SERVER_URL) return CONFIGURED_SERVER_URL;
  if (typeof window === 'undefined') return 'http://localhost:3001';
  const { hostname } = window.location;
  if (hostname === 'localhost' || hostname === '127.0.0.1') return 'http://localhost:3001';
  return '';
})();

/** 接続先が分かっているか。false なら在室確認も会話もできない。 */
export const SERVER_CONFIGURED = SERVER_URL !== '';

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
