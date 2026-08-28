'use client';

import type {
  AdminState,
  PublicMessage,
  PublicStatus,
  Sender,
  SiteConfig,
  StoredMessage,
} from './types';

/**
 * ブラウザ ⇄ Next.js の関数（/api/*）のやりとり。
 *
 * 判断（同時1名・順番・在室）はすべてサーバー側で行い、ここでは結果を運ぶだけ。
 * 同じ配信元なので、接続先の設定は要らない。
 */

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function call<T>(
  path: string,
  init?: { method?: string; body?: unknown; token?: string },
): Promise<T> {
  const { method = 'GET', body, token } = init ?? {};
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    // 圏外・回線断。呼んだ側が「切れている」と扱えるように 0 を渡す
    throw new ApiError('通信できませんでした。', 0);
  }

  const data = (await response.json().catch(() => ({}))) as { error?: string };
  if (!response.ok) {
    throw new ApiError(data.error ?? '通信に失敗しました。', response.status);
  }
  return data as T;
}

/* ------------------------------ 入口 ------------------------------ */

export const getStatus = () =>
  call<{ status: PublicStatus; replyEtaDays: number }>('/api/status');

/** 文章送付ページが使う。返信の目安だけを見る。 */
export const getSiteConfig = async () => ({ replyEtaDays: (await getStatus()).replyEtaDays });

/* ---------------------------- 来訪者 ---------------------------- */

export interface Greeting {
  visitorId: string;
  handle: string;
  state: 'idle' | 'queued' | 'invited' | 'active';
  sessionId: string | null;
  enteredAt: number | null;
  joinedAt: number | null;
  status: PublicStatus;
}

const visitor = <T>(action: string, visitorId?: string | null) =>
  call<T>('/api/visitor', { method: 'POST', body: { action, visitorId } });

/** 名乗る。前に居た人なら、そのときの順番や部屋に戻れる。 */
export const visitorHello = (visitorId: string | null) => visitor<Greeting>('hello', visitorId);

export const visitorHeartbeat = (visitorId: string) =>
  visitor<{ alive: boolean }>('heartbeat', visitorId);

export const visitorEnter = (visitorId: string) =>
  visitor<{ ok: boolean; sessionId?: string; reason?: string }>('enter', visitorId);

export const visitorAccept = (visitorId: string) =>
  visitor<{ ok: boolean; sessionId?: string; reason?: string }>('accept', visitorId);

export const visitorLeave = (visitorId: string) => visitor<{ ok: boolean }>('leave', visitorId);

/* ----------------------------- 手紙 ----------------------------- */

interface LetterRow {
  id: string;
  token: string;
  body: string;
  sender: Sender | null;
  created_at: string;
  read_at: string | null;
  replies: { body: string; at: number }[] | null;
}

/** データベースの行を、画面が扱う形に直す */
function toMessage(row: LetterRow): StoredMessage {
  return {
    id: row.id,
    token: row.token,
    body: row.body,
    sender: row.sender ?? {},
    createdAt: new Date(row.created_at).getTime(),
    readAt: row.read_at ? new Date(row.read_at).getTime() : null,
    replies: row.replies ?? [],
  };
}

export const sendWrittenMessage = (body: string, sender: Sender = {}) =>
  call<{ token: string; createdAt: number; replyEtaDays: number }>('/api/letters', {
    method: 'POST',
    body: { body, sender },
  });

export const fetchWrittenMessage = (token: string) =>
  call<{ message: PublicMessage; replyEtaDays: number }>(
    `/api/letters/${encodeURIComponent(token)}`,
  );

/* ----------------------------- 神父 ----------------------------- */

const admin = <T>(body: Record<string, unknown>, token?: string) =>
  call<T>('/api/admin', { method: 'POST', body, token });

export const adminLogin = (password: string) =>
  admin<{ token: string; topic: string; state: AdminState; config: SiteConfig }>({
    action: 'login',
    password,
  });

export const adminFetchState = (token: string) =>
  admin<{ state: AdminState; topic: string }>({ action: 'state' }, token);

/** 在室していることを知らせ続ける。途切れると入口が「不在」になる。 */
export const adminHeartbeat = (token: string) =>
  admin<{ state: AdminState; token?: string }>({ action: 'heartbeat' }, token);

export const adminPresence = (token: string, online: boolean) =>
  admin<{ state: AdminState }>({ action: 'presence', online }, token);

/** 待っている人を、告解室へ呼ぶ */
export const adminInvite = (token: string, visitorId: string) =>
  admin<{ ok: boolean; reason?: string; state: AdminState }>(
    { action: 'invite', visitorId },
    token,
  );

export const adminKick = (token: string, visitorId: string, reason?: string) =>
  admin<{ state: AdminState }>({ action: 'kick', visitorId, reason }, token);

export const adminUpdateConfig = (token: string, patch: Partial<SiteConfig>) =>
  admin<{ config: SiteConfig }>(
    {
      action: 'config',
      replyEtaDays: patch.replyEtaDays,
      inviteTimeoutSeconds: patch.inviteTimeoutSeconds,
    },
    token,
  );

export const adminMessages = async (token: string) => {
  const data = await admin<{ letters: LetterRow[]; config: SiteConfig }>(
    { action: 'letters' },
    token,
  );
  return { messages: data.letters.map(toMessage), config: data.config };
};

export const adminMarkRead = (token: string, id: string, read: boolean) =>
  admin<{ ok: boolean }>({ action: 'letter:read', id, read }, token);

export const adminReply = (token: string, id: string, body: string) =>
  admin<{ ok: boolean }>({ action: 'letter:reply', id, body }, token);

export const adminDeleteMessage = (token: string, id: string) =>
  admin<{ ok: boolean }>({ action: 'letter:delete', id }, token);
