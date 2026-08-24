/**
 * 文章メッセージ・設定・日次統計の永続化。
 *
 * 音声とチャットの内容は一切保存しない。ここで扱うのは
 * 「③文章送付ページ」から届いた投稿と、個人情報を含まない集計値のみ。
 * 保存先は単純なJSONファイル（DATA_DIR）。常時起動のホスト（Render等）の
 * ディスクをそのまま使う想定で、DBを立てずに運用できるようにしている。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Sender, SiteConfig, StoredMessage } from '../lib/types';
import { envNumber, envString } from './env';

const DATA_DIR = path.resolve(envString('DATA_DIR', path.join(process.cwd(), 'data')));
const DB_FILE = path.join(DATA_DIR, 'kikimiya.json');

interface DailyStat {
  date: string;
  sessions: number;
  totalDurationSeconds: number;
}

interface Database {
  messages: StoredMessage[];
  config: SiteConfig;
  daily: Record<string, DailyStat>;
}

const DEFAULT_CONFIG: SiteConfig = {
  replyEtaDays: envNumber('REPLY_ETA_DAYS', 3),
  inviteTimeoutSeconds: envNumber('INVITE_TIMEOUT_SECONDS', 60),
};

function emptyDb(): Database {
  return { messages: [], config: { ...DEFAULT_CONFIG }, daily: {} };
}

let db: Database = emptyDb();

function load(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) as Partial<Database>;
      db = {
        messages: parsed.messages ?? [],
        config: { ...DEFAULT_CONFIG, ...(parsed.config ?? {}) },
        daily: parsed.daily ?? {},
      };
    }
  } catch (error) {
    console.error('[store] 読み込みに失敗したため空の状態で起動します:', error);
    db = emptyDb();
  }
}

let writeTimer: NodeJS.Timeout | null = null;
function persist(): void {
  if (writeTimer) return;
  // 連続した更新をまとめて書き出す
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${DB_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
      fs.renameSync(tmp, DB_FILE);
    } catch (error) {
      console.error('[store] 書き込みに失敗しました:', error);
    }
  }, 200);
}

load();

export function today(): string {
  // 運営者のタイムゾーン（既定はJST）で日付を切り替える
  const tz = envString('STATS_TIMEZONE', 'Asia/Tokyo');
  return new Intl.DateTimeFormat('sv-SE', { timeZone: tz }).format(new Date());
}

/* --------------------------- 設定 --------------------------- */

export function getConfig(): SiteConfig {
  return { ...db.config };
}

export function updateConfig(patch: Partial<SiteConfig>): SiteConfig {
  if (typeof patch.replyEtaDays === 'number' && Number.isFinite(patch.replyEtaDays)) {
    db.config.replyEtaDays = Math.max(1, Math.min(60, Math.round(patch.replyEtaDays)));
  }
  if (typeof patch.inviteTimeoutSeconds === 'number' && Number.isFinite(patch.inviteTimeoutSeconds)) {
    db.config.inviteTimeoutSeconds = Math.max(10, Math.min(600, Math.round(patch.inviteTimeoutSeconds)));
  }
  persist();
  return getConfig();
}

/* ------------------------ 文章メッセージ ------------------------ */

export const MAX_MESSAGE_LENGTH = 4000;

export const MAX_NAME_LENGTH = 60;
export const MAX_EMAIL_LENGTH = 254;

export function createMessage(body: string, sender: Sender = {}): StoredMessage {
  const message: StoredMessage = {
    id: crypto.randomUUID(),
    token: crypto.randomBytes(16).toString('base64url'),
    body: body.slice(0, MAX_MESSAGE_LENGTH),
    sender,
    createdAt: Date.now(),
    readAt: null,
    replies: [],
  };
  db.messages.unshift(message);
  persist();
  return message;
}

export function listMessages(): StoredMessage[] {
  // 以前の形式（sender なし）で保存されたものにも耐えるようにする
  return db.messages.map((m) => ({ ...m, sender: m.sender ?? {}, replies: [...m.replies] }));
}

export function findByToken(token: string): StoredMessage | undefined {
  return db.messages.find((m) => m.token === token);
}

export function findById(id: string): StoredMessage | undefined {
  return db.messages.find((m) => m.id === id);
}

export function markRead(id: string, read = true): StoredMessage | undefined {
  const message = findById(id);
  if (!message) return undefined;
  message.readAt = read ? (message.readAt ?? Date.now()) : null;
  persist();
  return message;
}

export function addReply(id: string, body: string): StoredMessage | undefined {
  const message = findById(id);
  if (!message) return undefined;
  message.replies.push({ body: body.slice(0, MAX_MESSAGE_LENGTH), at: Date.now() });
  message.readAt = message.readAt ?? Date.now();
  persist();
  return message;
}

export function deleteMessage(id: string): boolean {
  const index = db.messages.findIndex((m) => m.id === id);
  if (index === -1) return false;
  db.messages.splice(index, 1);
  persist();
  return true;
}

export function unreadCount(): number {
  return db.messages.filter((m) => m.readAt === null).length;
}

/* --------------------------- 統計 --------------------------- */

export function recordSession(durationSeconds: number): void {
  const date = today();
  const stat = db.daily[date] ?? { date, sessions: 0, totalDurationSeconds: 0 };
  stat.sessions += 1;
  stat.totalDurationSeconds += Math.max(0, Math.round(durationSeconds));
  db.daily[date] = stat;
  persist();
}

export function statsToday(): DailyStat {
  const date = today();
  return db.daily[date] ?? { date, sessions: 0, totalDurationSeconds: 0 };
}
