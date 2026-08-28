/**
 * ブラウザに渡してよい設定。ここに秘密の値は置かない。
 * NEXT_PUBLIC_ の値はビルド時に埋め込まれるため、変えたら必ずビルドし直すこと。
 */

const trim = (value: string | undefined) => (value ?? '').replace(/\/$/, '').trim();

/* ---------------------- リアルタイムの通り道 ---------------------- */

export const SUPABASE_URL = trim(process.env.NEXT_PUBLIC_SUPABASE_URL);
export const SUPABASE_KEY = (process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? '').trim();

/**
 * 在室状況や入室の案内を「押し出し」で受け取れるか。
 *
 * false でも致命傷にはしない。定期的に自分から尋ねにいく（ポーリング）ので、
 * 反応が鈍くなるだけで、話せなくなるわけではない。
 */
export const REALTIME_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_KEY);

/* ---------------------------- お布施 ---------------------------- */

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

/* --------------------------- 生存の信号 --------------------------- */

/*
  信号の間隔は「サーバー側の許容時間の3分の1」を目安にしている。
  裏に回ったタブはタイマーを1分ほどに間引かれるので、
  短く打ってもその通りには届かない。無駄打ちを減らしつつ、
  間引かれても1〜2回は届く幅を取る。
*/

/** 来訪者の生存信号（許容：部屋90秒・列150秒） */
export const HEARTBEAT_INTERVAL_MS = 10000;

/** 神父の在室信号（許容：120秒） */
export const FATHER_HEARTBEAT_INTERVAL_MS = 30000;

/** 押し出しが届かなかったときのために、入口が自分から尋ねにいく間隔 */
export const STATUS_POLL_MS = REALTIME_CONFIGURED ? 30000 : 6000;
