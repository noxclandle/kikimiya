import { NextResponse } from 'next/server';
import {
  adminTopic,
  attemptKey,
  bearerFrom,
  checkPassword,
  expiresSoon,
  issueToken,
  lockedMinutes,
  noteFailure,
  noteSuccess,
  passwordConfigured,
  verifyToken,
} from '@/lib/server/auth';
import {
  adminState,
  fatherHeartbeat,
  invite,
  leave,
  publish,
  setFatherOnline,
  siteConfig,
  sweep,
  updateSiteConfig,
} from '@/lib/server/state';
import { db } from '@/lib/server/supabase';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const unauthorized = () => NextResponse.json({ error: '認証が必要です。' }, { status: 401 });

/** 神父の操作。ログイン以外はすべてトークンが要る。 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '不正な要求です。' }, { status: 400 });
  }

  const action = String(body.action ?? '');

  /* ---------- ログインだけは認証の外 ---------- */
  if (action === 'login') {
    if (!passwordConfigured()) {
      return NextResponse.json({ error: 'ADMIN_PASSWORD が設定されていません。' }, { status: 500 });
    }
    const key = attemptKey(
      request.headers.get('x-forwarded-for') ?? request.headers.get('x-real-ip'),
    );
    const locked = await lockedMinutes(key);
    if (locked > 0) {
      return NextResponse.json(
        { error: `試行が続いたため、あと${locked}分ほど受け付けできません。` },
        { status: 429 },
      );
    }
    if (!checkPassword(String(body.password ?? ''))) {
      await noteFailure(key);
      return NextResponse.json({ error: '合言葉が違います。' }, { status: 401 });
    }
    await noteSuccess(key);
    const alive = await sweep();
    return NextResponse.json({
      token: issueToken(),
      topic: adminTopic(),
      state: await adminState(alive),
      config: await siteConfig(),
    });
  }

  /* ---------- ここから先は要認証 ---------- */
  const token = bearerFrom(request.headers.get('authorization'));
  if (!verifyToken(token)) return unauthorized();

  switch (action) {
    case 'state': {
      const alive = await sweep();
      return NextResponse.json({ state: await adminState(alive), topic: adminTopic() });
    }

    case 'heartbeat': {
      await fatherHeartbeat();
      const alive = await sweep();
      return NextResponse.json({
        state: await adminState(alive),
        // 開きっぱなしの待機所が、期限切れで黙って落ちないように差し替える
        ...(expiresSoon(token) ? { token: issueToken() } : {}),
      });
    }

    case 'presence': {
      await setFatherOnline(Boolean(body.online));
      return NextResponse.json({ state: await adminState() });
    }

    /** 待っている人ひとりに、入室を案内する */
    case 'invite': {
      const visitorId = String(body.visitorId ?? '');
      if (!visitorId) return NextResponse.json({ error: 'visitorId が要ります。' }, { status: 400 });
      const result = await invite(visitorId);
      return NextResponse.json({ ...result, state: await adminState() });
    }

    case 'kick': {
      const visitorId = String(body.visitorId ?? '');
      if (!visitorId) return NextResponse.json({ error: 'visitorId が要ります。' }, { status: 400 });
      await leave(visitorId, String(body.reason ?? '神父により退室となりました。'), true);
      return NextResponse.json({ state: await adminState() });
    }

    case 'config': {
      const config = await updateSiteConfig({
        replyEtaDays: Number(body.replyEtaDays),
        inviteTimeoutSeconds: Number(body.inviteTimeoutSeconds),
      });
      return NextResponse.json({ config });
    }

    /* ---------- 手紙 ---------- */
    case 'letters': {
      const { data } = await db()
        .from('letters')
        .select('*')
        .order('created_at', { ascending: false });
      return NextResponse.json({ letters: data ?? [], config: await siteConfig() });
    }

    case 'letter:read': {
      const read = body.read !== false;
      await db()
        .from('letters')
        .update({ read_at: read ? new Date().toISOString() : null })
        .eq('id', String(body.id ?? ''));
      await publish();
      return NextResponse.json({ ok: true });
    }

    case 'letter:reply': {
      const text = String(body.body ?? '').trim();
      if (!text) return NextResponse.json({ error: '返事が空です。' }, { status: 400 });
      const id = String(body.id ?? '');
      const { data } = await db().from('letters').select('replies').eq('id', id).maybeSingle();
      if (!data) return NextResponse.json({ error: '見つかりません。' }, { status: 404 });
      const replies = [
        ...(data.replies as { body: string; at: number }[]),
        { body: text.slice(0, 4000), at: Date.now() },
      ];
      await db()
        .from('letters')
        .update({ replies, read_at: new Date().toISOString() })
        .eq('id', id);
      await publish();
      return NextResponse.json({ ok: true });
    }

    case 'letter:delete': {
      await db().from('letters').delete().eq('id', String(body.id ?? ''));
      await publish();
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: '不明な操作です。' }, { status: 400 });
  }
}
