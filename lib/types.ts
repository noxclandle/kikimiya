/**
 * 聴き宮 — クライアント／サーバー間で共有する型定義。
 * 個人を特定する情報はここに含めない（匿名ハンドルのみを扱う）。
 */

export type FatherPresence = 'offline' | 'available' | 'busy';

export type VisitorState = 'idle' | 'queued' | 'invited' | 'active';

/** 入口ページ・待機ページに配信する公開ステータス */
export interface PublicStatus {
  presence: FatherPresence;
  queueLength: number;
  /** 告解室の席数。いまは常に1。 */
  capacity: number;
  /** 埋まっている席の数。入室案内中の席も埋まっているものとして数える。 */
  occupied: number;
}

/** 神父側にのみ配信する来訪者情報（匿名ハンドルと時刻のみ） */
export interface VisitorSummary {
  visitorId: string;
  handle: string;
  state: VisitorState;
  sessionId: string | null;
  joinedAt: number;
  /** 告解室に入った時刻。まだ入っていなければ null */
  enteredAt: number | null;
  /** 入室を案内した相手が、いつまでに答えるべきか。案内していなければ null */
  inviteExpiresAt: number | null;
  lastSeenAt: number;
  /** ハートビートが途切れている（=接続不安定）か */
  stale: boolean;
}

export interface AdminStats {
  /** 本日の対応件数（対話が成立したセッション数） */
  sessionsToday: number;
  /** 本日の平均対話時間（秒） */
  averageDurationToday: number;
  /** 本日の合計対話時間（秒） */
  totalDurationToday: number;
  /** 未読の文章メッセージ件数 */
  unreadMessages: number;
  date: string;
}

export interface AdminState {
  presence: FatherPresence;
  active: VisitorSummary | null;
  queue: VisitorSummary[];
  stats: AdminStats;
}

export interface ChatMessage {
  id: string;
  from: 'visitor' | 'father' | 'system';
  text: string;
  at: number;
}

/** 年代。任意入力なので、答えない選択もできる。 */
export const AGE_BANDS = ['10代', '20代', '30代', '40代'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const GENDERS = ['男性', '女性', 'その他'] as const;
export type Gender = (typeof GENDERS)[number];

/**
 * 手紙の差出人。すべて任意で、空のままでも送れる。
 * 名乗りたい人だけが名乗れるようにするための欄。
 */
export interface Sender {
  name?: string;
  email?: string;
  gender?: Gender;
  ageBand?: AgeBand;
}

/** 文章送付ページで受け取った投稿。唯一サーバーに永続化されるデータ。 */
export interface StoredMessage {
  id: string;
  /** 来訪者が自分の投稿を再訪するためのトークン（URLの一部になる） */
  token: string;
  body: string;
  /** 任意で書かれた差出人。何も書かれなければ空のまま */
  sender: Sender;
  createdAt: number;
  readAt: number | null;
  replies: { body: string; at: number }[];
}

/** 来訪者向けに返す投稿（内部IDは含めない） */
export type PublicMessage = Omit<StoredMessage, 'id'>;

export interface SiteConfig {
  /** 「返信の目安：◯日以内」に使う日数。神父が /admin から変更できる。 */
  replyEtaDays: number;
  /** キューの先頭に入室案内を出してから自動的に次へ回すまでの秒数 */
  inviteTimeoutSeconds: number;
}

/* ------------------------------------------------------------------ */
/* Socket.io イベント                                                   */
/* ------------------------------------------------------------------ */

export interface ServerToClientEvents {
  'status': (status: PublicStatus) => void;
  'queue:position': (payload: { position: number; total: number }) => void;
  'room:invite': (payload: { expiresInSeconds: number }) => void;
  'room:ready': (payload: { sessionId: string; startedAt: number }) => void;
  'room:denied': (payload: { reason: string }) => void;
  'room:closed': (payload: { reason: string }) => void;
  'room:peer': (payload: { present: boolean; stale: boolean }) => void;
  'chat:message': (message: ChatMessage) => void;
  'chat:history': (messages: ChatMessage[]) => void;
  'admin:state': (state: AdminState) => void;
  'admin:visitor-arrived': (payload: { handle: string; queued: boolean }) => void;
  'admin:auth': (payload: { ok: boolean; token?: string; error?: string }) => void;
  /** 接続直後に、その来訪者に割り当てられた匿名IDを伝える */
  'visitor:identity': (payload: { visitorId: string; handle: string }) => void;
  'rtc:signal': (payload: RtcSignal) => void;
  'rtc:peer-ready': (payload: { initiator: boolean }) => void;
}

export interface ClientToServerEvents {
  'visitor:hello': (payload: { visitorId?: string | null }) => void;
  'visitor:enter': () => void;
  'visitor:accept-invite': () => void;
  'visitor:leave': () => void;
  'visitor:resume': (payload: { sessionId: string }) => void;
  'heartbeat': () => void;
  'chat:send': (payload: { text: string }) => void;
  'father:auth': (payload: { password?: string; token?: string }) => void;
  'father:presence': (payload: { online: boolean }) => void;
  'father:join-room': (payload: { sessionId: string }) => void;
  'father:kick': (payload: { visitorId: string; reason?: string }) => void;
  /** 神父側から、いま対応中のセッションを終える */
  'father:end-session': (payload: { reason?: string }) => void;
  'rtc:signal': (payload: RtcSignal) => void;
  'rtc:ready': () => void;
}

export type RtcSignal =
  | { kind: 'offer'; sdp: string }
  | { kind: 'answer'; sdp: string }
  | { kind: 'candidate'; candidate: unknown }
  /** マイクを開いたことを相手に伝える。受け取った発信側が offer を出し直す。 */
  | { kind: 'ready' };

/* ------------------------------------------------------------------ */
/* リアルタイムの通り道（Supabase Realtime のブロードキャスト）           */
/* ------------------------------------------------------------------ */

/** 入口ページ全体に流れる知らせ */
export type LobbyEvent = { event: 'status'; payload: PublicStatus };

/** 待機所（神父）に流れる知らせ */
export type AdminEvent =
  | { event: 'state'; payload: AdminState }
  | { event: 'arrived'; payload: { handle: string; queued: boolean } };

/** 来訪者ひとりに宛てて流れる知らせ */
export type VisitorEvent =
  | { event: 'ready'; payload: { sessionId: string } }
  | { event: 'invite'; payload: { expiresInSeconds: number } }
  | { event: 'queue'; payload: { position: number; total: number } }
  | { event: 'denied'; payload: { reason: string } }
  | { event: 'closed'; payload: { reason: string } };

/** 告解室のなかで、二人のあいだを直接ゆき来するもの */
export type RoomEvent =
  | { event: 'chat'; payload: ChatMessage }
  | { event: 'rtc'; payload: RtcSignal }
  | { event: 'closed'; payload: { reason: string } };
