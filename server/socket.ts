/**
 * Socket.io サーバー本体。
 *  - 在室確認（ハートビート）
 *  - 同時1名の入室制御と待機列（キュー）
 *  - テキストチャットの中継
 *  - WebRTC（音声）のシグナリング中継
 *  - 神父用の状態配信・追放
 *
 * 会話の内容はディスクに書き出さない。チャットは「そのセッションが続いている間だけ」
 * メモリ上に保持し（再読み込み時の復帰用）、セッション終了と同時に破棄する。
 */
import crypto from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import { Server, type Socket } from 'socket.io';
import type {
  AdminState,
  ChatMessage,
  ClientToServerEvents,
  FatherPresence,
  PublicStatus,
  ServerToClientEvents,
  VisitorState,
  VisitorSummary,
} from '../lib/types';
import * as store from './store';
import { attemptKey, issueToken, lockedFor, noteFailure, noteSuccess, verifyToken } from './auth';

const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS ?? 15_000);
const STALE_AFTER_MS = Number(process.env.HEARTBEAT_STALE_MS ?? 8_000);
const SWEEP_INTERVAL_MS = 3_000;
/** 神父の接続が切れてから、実際に離席とみなすまでの猶予 */
const FATHER_GRACE_MS = Number(process.env.FATHER_GRACE_MS ?? 20_000);
const MAX_CHAT_BUFFER = 200;
const MAX_CHAT_LENGTH = 2000;

type TypedSocket = Socket<ClientToServerEvents, ServerToClientEvents>;
type TypedServer = Server<ClientToServerEvents, ServerToClientEvents>;

interface Visitor {
  visitorId: string;
  handle: string;
  socketId: string | null;
  state: VisitorState;
  sessionId: string | null;
  joinedAt: number;
  enteredAt: number | null;
  lastSeenAt: number;
}

/** 匿名ハンドル。個人は特定できないが、神父が見分けられる程度の識別子。 */
const HANDLE_CHARS = '甲乙丙丁戊己庚辛壬癸';
let handleCounter = 0;
function nextHandle(): string {
  const char = HANDLE_CHARS[handleCounter % HANDLE_CHARS.length];
  handleCounter += 1;
  return `来訪者 ${char}`;
}

export function createSocketServer(httpServer: HttpServer, origins: string[]): TypedServer {
  const io: TypedServer = new Server(httpServer, {
    cors: { origin: origins.length ? origins : true, credentials: true },
    // IPアドレス等をログに残さないため、既定のログ出力は使わない
  });

  /* ----------------------------- 状態 ----------------------------- */

  const visitors = new Map<string, Visitor>();
  const socketToVisitor = new Map<string, string>();
  const fatherSockets = new Set<string>();
  /** 告解室に入っている神父のソケット（1つのセッションにつき1つ） */
  let fatherRoomSocketId: string | null = null;
  let fatherOnline = false;
  let activeVisitorId: string | null = null;
  let queue: string[] = [];
  let invite: { visitorId: string; timer: NodeJS.Timeout; expiresAt: number } | null = null;
  /** 神父の接続が全部切れたときの猶予。リロードや短い瞬断で対話を切らないため。 */
  let fatherAbsence: NodeJS.Timeout | null = null;
  let chatBuffer: ChatMessage[] = [];

  /* --------------------------- ヘルパー --------------------------- */

  const presence = (): FatherPresence => {
    if (!fatherOnline) return 'offline';
    if (activeVisitorId || invite) return 'busy';
    return 'available';
  };

  const publicStatus = (): PublicStatus => ({
    presence: presence(),
    queueLength: queue.length + (invite ? 1 : 0),
  });

  const isStale = (visitor: Visitor): boolean =>
    visitor.socketId === null || Date.now() - visitor.lastSeenAt > STALE_AFTER_MS;

  const summarize = (visitor: Visitor): VisitorSummary => ({
    visitorId: visitor.visitorId,
    handle: visitor.handle,
    state: visitor.state,
    sessionId: visitor.sessionId,
    joinedAt: visitor.joinedAt,
    lastSeenAt: visitor.lastSeenAt,
    stale: isStale(visitor),
  });

  const adminState = (): AdminState => {
    const stat = store.statsToday();
    const active = activeVisitorId ? visitors.get(activeVisitorId) : null;
    const queued = [
      ...(invite ? [invite.visitorId] : []),
      ...queue,
    ]
      .map((id) => visitors.get(id))
      .filter((v): v is Visitor => Boolean(v));

    return {
      presence: presence(),
      active: active ? summarize(active) : null,
      queue: queued.map(summarize),
      stats: {
        sessionsToday: stat.sessions,
        averageDurationToday: stat.sessions > 0 ? Math.round(stat.totalDurationSeconds / stat.sessions) : 0,
        totalDurationToday: stat.totalDurationSeconds,
        unreadMessages: store.unreadCount(),
        date: stat.date,
      },
    };
  };

  const socketOf = (visitorId: string | null): TypedSocket | null => {
    if (!visitorId) return null;
    const visitor = visitors.get(visitorId);
    if (!visitor?.socketId) return null;
    return (io.sockets.sockets.get(visitor.socketId) as TypedSocket | undefined) ?? null;
  };

  function broadcastStatus(): void {
    io.emit('status', publicStatus());
    broadcastAdmin();
  }

  function broadcastAdmin(): void {
    const state = adminState();
    for (const socketId of fatherSockets) {
      io.sockets.sockets.get(socketId)?.emit('admin:state', state);
    }
  }

  function sendQueuePositions(): void {
    queue.forEach((visitorId, index) => {
      socketOf(visitorId)?.emit('queue:position', {
        // 案内中の人がいる場合、その人の分だけ後ろにずれる
        position: index + 1 + (invite ? 1 : 0),
        total: queue.length + (invite ? 1 : 0),
      });
    });
  }

  function notifyPeerState(): void {
    const visitorSocket = socketOf(activeVisitorId);
    const fatherSocket = fatherRoomSocketId
      ? (io.sockets.sockets.get(fatherRoomSocketId) as TypedSocket | undefined)
      : undefined;
    const visitor = activeVisitorId ? visitors.get(activeVisitorId) : null;

    visitorSocket?.emit('room:peer', { present: Boolean(fatherSocket), stale: false });
    fatherSocket?.emit('room:peer', {
      present: Boolean(visitor?.socketId),
      stale: visitor ? isStale(visitor) : true,
    });

    if (visitorSocket && fatherSocket) {
      // 双方そろったので音声の交渉を始められる。神父側を発信側にする。
      fatherSocket.emit('rtc:peer-ready', { initiator: true });
      visitorSocket.emit('rtc:peer-ready', { initiator: false });
    }
  }

  function pushChat(message: ChatMessage): void {
    chatBuffer.push(message);
    if (chatBuffer.length > MAX_CHAT_BUFFER) chatBuffer.shift();
    socketOf(activeVisitorId)?.emit('chat:message', message);
    if (fatherRoomSocketId) io.sockets.sockets.get(fatherRoomSocketId)?.emit('chat:message', message);
  }

  function systemChat(text: string): void {
    pushChat({ id: crypto.randomUUID(), from: 'system', text, at: Date.now() });
  }

  /* --------------------------- 入退室 --------------------------- */

  function startSession(visitorId: string): void {
    const visitor = visitors.get(visitorId);
    if (!visitor) return;
    clearInvite();
    visitor.state = 'active';
    visitor.sessionId = crypto.randomBytes(12).toString('base64url');
    visitor.enteredAt = Date.now();
    activeVisitorId = visitorId;
    chatBuffer = [];
    queue = queue.filter((id) => id !== visitorId);

    socketOf(visitorId)?.emit('room:ready', {
      sessionId: visitor.sessionId,
      startedAt: visitor.enteredAt,
    });
    for (const socketId of fatherSockets) {
      io.sockets.sockets.get(socketId)?.emit('admin:visitor-arrived', {
        handle: visitor.handle,
        queued: false,
      });
    }
    sendQueuePositions();
    broadcastStatus();
  }

  /** 対応中のセッションを終了する。reason は双方に通知される。 */
  function endSession(reason: string, opts: { notifyVisitor?: boolean } = {}): void {
    const { notifyVisitor = true } = opts;
    if (!activeVisitorId) return;
    const visitor = visitors.get(activeVisitorId);
    if (visitor) {
      if (visitor.enteredAt) {
        store.recordSession((Date.now() - visitor.enteredAt) / 1000);
      }
      if (notifyVisitor) socketOf(visitor.visitorId)?.emit('room:closed', { reason });
      visitor.state = 'idle';
      visitor.sessionId = null;
      visitor.enteredAt = null;
    }
    if (fatherRoomSocketId) {
      io.sockets.sockets.get(fatherRoomSocketId)?.emit('room:closed', { reason });
      fatherRoomSocketId = null;
    }
    activeVisitorId = null;
    chatBuffer = [];
    broadcastStatus();
    inviteNext();
  }

  function clearInvite(): void {
    if (invite) {
      clearTimeout(invite.timer);
      invite = null;
    }
  }

  /** 空室になったら待機列の先頭に入室を案内する */
  function inviteNext(): void {
    if (activeVisitorId || invite || !fatherOnline) return;
    const nextId = queue.shift();
    if (!nextId) {
      broadcastStatus();
      return;
    }
    const visitor = visitors.get(nextId);
    if (!visitor) {
      inviteNext();
      return;
    }
    const seconds = store.getConfig().inviteTimeoutSeconds;
    visitor.state = 'invited';
    invite = {
      visitorId: nextId,
      expiresAt: Date.now() + seconds * 1000,
      timer: setTimeout(() => {
        // 応答がなければ次の人に回す
        const stalled = visitors.get(nextId);
        if (stalled) {
          stalled.state = 'idle';
          socketOf(nextId)?.emit('room:denied', {
            reason: '応答がなかったため、順番を次の方にお譲りしました。もう一度お並びいただけます。',
          });
        }
        invite = null;
        broadcastStatus();
        inviteNext();
      }, seconds * 1000),
    };
    socketOf(nextId)?.emit('room:invite', { expiresInSeconds: seconds });
    sendQueuePositions();
    broadcastStatus();
  }

  /** 来訪者を完全に取り除く（切断・退室・追放の共通処理） */
  function removeVisitor(visitorId: string, reason: string, notify: boolean): void {
    const visitor = visitors.get(visitorId);
    if (!visitor) return;

    if (activeVisitorId === visitorId) {
      if (notify) socketOf(visitorId)?.emit('room:closed', { reason });
      endSession(reason, { notifyVisitor: false });
    } else {
      if (invite?.visitorId === visitorId) clearInvite();
      queue = queue.filter((id) => id !== visitorId);
      if (notify) socketOf(visitorId)?.emit('room:closed', { reason });
    }

    if (visitor.socketId) socketToVisitor.delete(visitor.socketId);
    visitors.delete(visitorId);
    sendQueuePositions();
    broadcastStatus();
    inviteNext();
  }

  /* --------------------- ハートビート監視 --------------------- */

  const sweeper = setInterval(() => {
    const now = Date.now();
    let changed = false;
    for (const visitor of [...visitors.values()]) {
      if (now - visitor.lastSeenAt > HEARTBEAT_TIMEOUT_MS) {
        // 一定時間 生存信号が届かない = ブラウザを閉じた／リロードして戻らなかった
        removeVisitor(visitor.visitorId, '来訪者の接続が確認できなくなりました。', false);
        changed = true;
      }
    }
    // 「音声途切れ検知」用に、対応中の相手の状態は常に配信し直す
    if (activeVisitorId) notifyPeerState();
    if (!changed) broadcastAdmin();
  }, SWEEP_INTERVAL_MS);
  sweeper.unref();

  /* --------------------------- 接続 --------------------------- */

  io.on('connection', (socket: TypedSocket) => {
    socket.emit('status', publicStatus());

    /* ---------- 来訪者 ---------- */

    socket.on('visitor:hello', ({ visitorId: knownId }) => {
      // 直前の接続（リロード等）が生きていれば同じ来訪者として引き継ぐ
      let visitor: Visitor | undefined;
      if (knownId) {
        visitor = visitors.get(knownId);
      }
      if (!visitor) {
        visitor = {
          visitorId: crypto.randomBytes(9).toString('base64url'),
          handle: nextHandle(),
          socketId: socket.id,
          state: 'idle',
          sessionId: null,
          joinedAt: Date.now(),
          enteredAt: null,
          lastSeenAt: Date.now(),
        };
        visitors.set(visitor.visitorId, visitor);
      } else {
        if (visitor.socketId && visitor.socketId !== socket.id) {
          socketToVisitor.delete(visitor.socketId);
        }
        visitor.socketId = socket.id;
        visitor.lastSeenAt = Date.now();
      }
      socketToVisitor.set(socket.id, visitor.visitorId);
      socket.emit('visitor:identity', { visitorId: visitor.visitorId, handle: visitor.handle });
      socket.emit('status', publicStatus());
      // 待機列にいる場合だけ順番を返す（並んでいない人に 0 番目を送らない）
      const queueIndex = queue.indexOf(visitor.visitorId);
      if (queueIndex >= 0) {
        socket.emit('queue:position', {
          position: queueIndex + 1 + (invite ? 1 : 0),
          total: queue.length + (invite ? 1 : 0),
        });
      }
      if (invite?.visitorId === visitor.visitorId) {
        socket.emit('room:invite', {
          expiresInSeconds: Math.max(1, Math.round((invite.expiresAt - Date.now()) / 1000)),
        });
      }
      if (visitor.state === 'active' && visitor.sessionId) {
        socket.emit('room:ready', { sessionId: visitor.sessionId, startedAt: visitor.enteredAt ?? Date.now() });
      }
      broadcastAdmin();
    });

    socket.on('visitor:enter', () => {
      const visitorId = socketToVisitor.get(socket.id);
      const visitor = visitorId ? visitors.get(visitorId) : undefined;
      if (!visitor) return;
      visitor.lastSeenAt = Date.now();

      if (!fatherOnline) {
        socket.emit('room:denied', { reason: 'ただいま神父は不在です。文章でお預かりします。' });
        return;
      }
      if (visitor.state === 'active') return;
      if (!activeVisitorId && !invite) {
        startSession(visitor.visitorId);
        return;
      }
      // 満室 → 待機列へ
      if (!queue.includes(visitor.visitorId)) {
        queue.push(visitor.visitorId);
        visitor.state = 'queued';
        for (const socketId of fatherSockets) {
          io.sockets.sockets.get(socketId)?.emit('admin:visitor-arrived', {
            handle: visitor.handle,
            queued: true,
          });
        }
      }
      sendQueuePositions();
      broadcastStatus();
    });

    socket.on('visitor:accept-invite', () => {
      const visitorId = socketToVisitor.get(socket.id);
      if (!visitorId || invite?.visitorId !== visitorId) return;
      if (activeVisitorId) return;
      startSession(visitorId);
    });

    socket.on('visitor:leave', () => {
      const visitorId = socketToVisitor.get(socket.id);
      if (!visitorId) return;
      removeVisitor(visitorId, '来訪者が退室しました。', false);
    });

    socket.on('visitor:resume', ({ sessionId }) => {
      // 告解室ページを開いた／再読み込みしたときに、同じセッションへ戻る
      const visitor = [...visitors.values()].find((v) => v.sessionId === sessionId);
      if (!visitor) {
        socket.emit('room:closed', { reason: 'このセッションは既に終了しています。' });
        return;
      }
      if (visitor.socketId && visitor.socketId !== socket.id) {
        socketToVisitor.delete(visitor.socketId);
      }
      visitor.socketId = socket.id;
      visitor.lastSeenAt = Date.now();
      socketToVisitor.set(socket.id, visitor.visitorId);
      socket.emit('room:ready', {
        sessionId,
        startedAt: visitor.enteredAt ?? Date.now(),
      });
      socket.emit('chat:history', chatBuffer);
      notifyPeerState();
      broadcastAdmin();
    });

    socket.on('heartbeat', () => {
      const visitorId = socketToVisitor.get(socket.id);
      if (visitorId) {
        const visitor = visitors.get(visitorId);
        if (visitor) visitor.lastSeenAt = Date.now();
      }
    });

    /* ---------- チャット ---------- */

    socket.on('chat:send', ({ text }) => {
      const trimmed = (text ?? '').trim().slice(0, MAX_CHAT_LENGTH);
      if (!trimmed) return;
      const visitorId = socketToVisitor.get(socket.id);
      const isFather = socket.id === fatherRoomSocketId;
      const isActiveVisitor = Boolean(visitorId && visitorId === activeVisitorId);
      if (!isFather && !isActiveVisitor) return;
      pushChat({
        id: crypto.randomUUID(),
        from: isFather ? 'father' : 'visitor',
        text: trimmed,
        at: Date.now(),
      });
    });

    /* ---------- WebRTC シグナリング ---------- */

    socket.on('rtc:signal', (payload) => {
      const visitorId = socketToVisitor.get(socket.id);
      if (socket.id === fatherRoomSocketId) {
        socketOf(activeVisitorId)?.emit('rtc:signal', payload);
      } else if (visitorId && visitorId === activeVisitorId && fatherRoomSocketId) {
        io.sockets.sockets.get(fatherRoomSocketId)?.emit('rtc:signal', payload);
      }
    });

    socket.on('rtc:ready', () => {
      notifyPeerState();
    });

    /* ---------- 神父 ---------- */

    socket.on('father:auth', ({ password, token }) => {
      const key = attemptKey(socket.handshake.address);
      let issued: string | null = null;
      if (token && verifyToken(token)) {
        issued = token;
      } else if (password) {
        // 合言葉での試行だけ回数を数える（発行済みトークンは対象外）
        const locked = lockedFor(key);
        if (locked > 0) {
          socket.emit('admin:auth', {
            ok: false,
            error: `試行が続いたため、${Math.ceil(locked / 60000)}分ほど受け付けできません。`,
          });
          return;
        }
        issued = issueToken(password);
        if (issued) noteSuccess(key);
        else noteFailure(key);
      }
      if (!issued) {
        // 保存済みトークンでの再認証と、合言葉の入力ミスは区別して伝える
        socket.emit('admin:auth', {
          ok: false,
          error: token
            ? 'ログインの有効期限が切れました。もう一度合言葉を入れてください。'
            : '合言葉が違います。',
        });
        return;
      }
      fatherSockets.add(socket.id);
      // 戻ってきたので、離席とみなすのはやめる
      if (fatherAbsence) {
        clearTimeout(fatherAbsence);
        fatherAbsence = null;
      }
      socket.emit('admin:auth', { ok: true, token: issued });
      socket.emit('admin:state', adminState());
    });

    socket.on('father:presence', ({ online }) => {
      if (!fatherSockets.has(socket.id)) return;
      if (fatherOnline === online) return;
      fatherOnline = online;
      if (!online) {
        endSession('神父が席を外しました。またお越しください。');
        clearInvite();
        for (const visitorId of queue) {
          socketOf(visitorId)?.emit('room:denied', {
            reason: '神父が席を外したため、待機列を解散しました。',
          });
          const visitor = visitors.get(visitorId);
          if (visitor) visitor.state = 'idle';
        }
        queue = [];
      } else {
        inviteNext();
      }
      broadcastStatus();
    });

    socket.on('father:join-room', ({ sessionId }) => {
      if (!fatherSockets.has(socket.id)) return;
      const visitor = activeVisitorId ? visitors.get(activeVisitorId) : null;
      if (!visitor || visitor.sessionId !== sessionId) {
        socket.emit('room:closed', { reason: 'このセッションは既に終了しています。' });
        return;
      }
      fatherRoomSocketId = socket.id;
      socket.emit('room:ready', { sessionId, startedAt: visitor.enteredAt ?? Date.now() });
      socket.emit('chat:history', chatBuffer);
      notifyPeerState();
    });

    socket.on('father:end-session', ({ reason }) => {
      if (!fatherSockets.has(socket.id)) return;
      endSession(reason ?? '神父が退室しました。お話しくださってありがとうございました。');
    });

    socket.on('father:kick', ({ visitorId, reason }) => {
      if (!fatherSockets.has(socket.id)) return;
      removeVisitor(visitorId, reason ?? '神父により退室となりました。', true);
    });

    /* ---------- 切断 ---------- */

    socket.on('disconnect', () => {
      fatherSockets.delete(socket.id);
      if (fatherRoomSocketId === socket.id) {
        fatherRoomSocketId = null;
        notifyPeerState();
      }
      const visitorId = socketToVisitor.get(socket.id);
      socketToVisitor.delete(socket.id);
      if (visitorId) {
        const visitor = visitors.get(visitorId);
        // 即座に消さず、ハートビートのタイムアウトまで猶予を置く。
        // ページ遷移や短い回線断はここで吸収され、超過すれば自動的に退室扱いになる。
        if (visitor) visitor.socketId = null;
        notifyPeerState();
        broadcastAdmin();
      }
      if (fatherSockets.size === 0 && fatherOnline && !fatherAbsence) {
        // 待機ページを閉じた／再読み込みした場合。すぐに切らず、戻ってくるのを少し待つ。
        fatherAbsence = setTimeout(() => {
          fatherAbsence = null;
          if (fatherSockets.size > 0) return;
          fatherOnline = false;
          endSession('神父の接続が切れました。またお越しください。');
          broadcastStatus();
        }, FATHER_GRACE_MS);
      }
    });
  });

  return io;
}
