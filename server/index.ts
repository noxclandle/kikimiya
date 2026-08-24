/**
 * 常時起動する側のサーバー。
 * Socket.io（在室確認・キュー・チャット・WebRTCシグナリング）と、
 * 文章メッセージ用の最小限のREST APIを1プロセスで提供する。
 *
 * Next.js（フロント）は Vercel 等に、こちらは Render 等の
 * 常時起動できる環境に置く想定。
 */
import 'dotenv/config';
import http from 'node:http';
import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { createSocketServer } from './socket';
import * as store from './store';
import {
  attemptKey,
  bearerFrom,
  issueToken,
  lockedFor,
  noteFailure,
  noteSuccess,
  passwordConfigured,
  revokeToken,
  verifyToken,
} from './auth';
import { AGE_BANDS, GENDERS, type Sender } from '../lib/types';
import { envNumber, envString } from './env';

const PORT = envNumber('SOCKET_PORT', 3001);
const ORIGINS = envString('ALLOWED_ORIGINS', 'http://localhost:3000')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const app = express();
app.disable('x-powered-by');
app.use(cors({ origin: ORIGINS.length ? ORIGINS : true }));
app.use(express.json({ limit: '64kb' }));

/**
 * 投稿の連投だけを抑えるための、ごく簡単なレート制限。
 * IPアドレスはそのまま保持せず、起動ごとに変わるソルトでハッシュ化した値だけを
 * メモリ上に持つ（ログにも残さない）。
 */
const RATE_SALT = crypto.randomBytes(16);
const rateBuckets = new Map<string, { count: number; resetAt: number }>();
function rateLimit(windowMs: number, max: number) {
  return (req: Request, res: Response, next: NextFunction) => {
    const raw = req.ip ?? 'unknown';
    const key = crypto.createHmac('sha256', RATE_SALT).update(raw).digest('base64');
    const now = Date.now();
    const bucket = rateBuckets.get(key);
    if (!bucket || bucket.resetAt < now) {
      rateBuckets.set(key, { count: 1, resetAt: now + windowMs });
      next();
      return;
    }
    bucket.count += 1;
    if (bucket.count > max) {
      res.status(429).json({ error: '送信が続いています。少し時間をおいてからお試しください。' });
      return;
    }
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of rateBuckets) if (bucket.resetAt < now) rateBuckets.delete(key);
}, 60_000).unref();

/** Express 5 の req.params は string | string[] になりうるので、必ず1本の文字列にする */
function param(req: Request, name: string): string {
  const value = (req.params as Record<string, string | string[] | undefined>)[name];
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
}

function requireFather(req: Request, res: Response, next: NextFunction): void {
  if (!verifyToken(bearerFrom(req.header('authorization')))) {
    res.status(401).json({ error: '認証が必要です。' });
    return;
  }
  next();
}

/* ------------------------------ 公開API ------------------------------ */

app.get('/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/config', (_req, res) => {
  const { replyEtaDays } = store.getConfig();
  res.json({ replyEtaDays });
});

/** 任意入力の差出人欄を、受け取れる形に整える。空欄はそのまま省く。 */
function readSender(raw: unknown): Sender {
  if (!raw || typeof raw !== 'object') return {};
  const input = raw as Record<string, unknown>;
  const text = (value: unknown, max: number): string | undefined => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim().slice(0, max);
    return trimmed.length > 0 ? trimmed : undefined;
  };

  const sender: Sender = {};
  const name = text(input.name, store.MAX_NAME_LENGTH);
  if (name) sender.name = name;

  const email = text(input.email, store.MAX_EMAIL_LENGTH);
  // 形式だけ確かめる。届くかどうかまでは確認しない
  if (email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) sender.email = email;

  const gender = text(input.gender, 10);
  if (gender && (GENDERS as readonly string[]).includes(gender)) {
    sender.gender = gender as Sender['gender'];
  }

  const ageBand = text(input.ageBand, 10);
  if (ageBand && (AGE_BANDS as readonly string[]).includes(ageBand)) {
    sender.ageBand = ageBand as Sender['ageBand'];
  }

  return sender;
}

/** ③ 文章送付 */
app.post('/api/messages', rateLimit(60_000, 5), (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body) {
    res.status(400).json({ error: '本文が空です。' });
    return;
  }
  if (body.length > store.MAX_MESSAGE_LENGTH) {
    res.status(400).json({ error: `本文は${store.MAX_MESSAGE_LENGTH}文字までです。` });
    return;
  }
  const message = store.createMessage(body, readSender(req.body?.sender));
  // 控えの画面で必ず目安を出せるよう、返信の目安も一緒に返す
  res.status(201).json({
    token: message.token,
    createdAt: message.createdAt,
    replyEtaDays: store.getConfig().replyEtaDays,
  });
});

/** 発行されたトークンで自分の投稿と返信を見る（ログイン不要） */
app.get('/api/messages/:token', (req, res) => {
  const message = store.findByToken(param(req, 'token'));
  if (!message) {
    res.status(404).json({ error: 'この控えは見つかりませんでした。' });
    return;
  }
  const { id: _id, ...publicMessage } = message;
  // 差出人欄が入る前に保存されたものにも耐えるようにする
  res.json({
    message: { ...publicMessage, sender: message.sender ?? {} },
    replyEtaDays: store.getConfig().replyEtaDays,
  });
});

/* ------------------------------ 神父用API ------------------------------ */

app.post('/api/admin/login', rateLimit(60_000, 10), (req, res) => {
  if (!passwordConfigured()) {
    res.status(500).json({ error: 'ADMIN_PASSWORD が設定されていません。' });
    return;
  }
  const key = attemptKey(req.ip);
  const locked = lockedFor(key);
  if (locked > 0) {
    res.status(429).json({
      error: `試行が続いたため、${Math.ceil(locked / 60000)}分ほど受け付けできません。`,
    });
    return;
  }

  const password = typeof req.body?.password === 'string' ? req.body.password : '';
  const token = issueToken(password);
  if (!token) {
    noteFailure(key);
    res.status(401).json({ error: '合言葉が違います。' });
    return;
  }
  noteSuccess(key);
  res.json({ token });
});

app.post('/api/admin/logout', requireFather, (req, res) => {
  const token = bearerFrom(req.header('authorization'));
  if (token) revokeToken(token);
  res.json({ ok: true });
});

app.get('/api/admin/messages', requireFather, (_req, res) => {
  res.json({ messages: store.listMessages(), config: store.getConfig() });
});

app.post('/api/admin/messages/:id/read', requireFather, (req, res) => {
  const read = req.body?.read !== false;
  const message = store.markRead(param(req, 'id'), read);
  if (!message) {
    res.status(404).json({ error: '見つかりません。' });
    return;
  }
  res.json({ message });
});

app.post('/api/admin/messages/:id/reply', requireFather, (req, res) => {
  const body = typeof req.body?.body === 'string' ? req.body.body.trim() : '';
  if (!body) {
    res.status(400).json({ error: '返信が空です。' });
    return;
  }
  const message = store.addReply(param(req, 'id'), body);
  if (!message) {
    res.status(404).json({ error: '見つかりません。' });
    return;
  }
  res.json({ message });
});

app.delete('/api/admin/messages/:id', requireFather, (req, res) => {
  const ok = store.deleteMessage(param(req, 'id'));
  res.status(ok ? 200 : 404).json({ ok });
});

app.post('/api/admin/config', requireFather, (req, res) => {
  const config = store.updateConfig({
    replyEtaDays: Number(req.body?.replyEtaDays),
    inviteTimeoutSeconds: Number(req.body?.inviteTimeoutSeconds),
  });
  res.json({ config });
});

/* ------------------------------ 起動 ------------------------------ */

const server = http.createServer(app);
createSocketServer(server, ORIGINS);

server.listen(PORT, () => {
  console.log(`[聴き宮] socket/api server listening on :${PORT}`);
  console.log(`[聴き宮] allowed origins: ${ORIGINS.join(', ') || '(all)'}`);
  if (!passwordConfigured()) {
    console.warn('[聴き宮] ADMIN_PASSWORD が未設定です。/admin にログインできません。');
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
