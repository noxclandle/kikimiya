import { NextResponse } from 'next/server';
import {
  acceptInvite,
  enter,
  heartbeat,
  hello,
  leave,
  publicStatus,
  sweep,
} from '@/lib/server/state';
import { notifyArrival } from '@/lib/purchase-notify';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * 来訪者の操作をまとめて受ける。
 * 判断（同時1名・順番）はすべてここで行い、ブラウザは結果を受け取るだけ。
 */
export async function POST(request: Request) {
  let body: { action?: string; visitorId?: string | null };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: '不正な要求です。' }, { status: 400 });
  }

  const { action, visitorId } = body;

  switch (action) {
    case 'hello': {
      const alive = await sweep();
      const visitor = await hello(visitorId ?? null);
      const status = await publicStatus(alive);

      /*
        神父が不在のあいだに誰かが来たことを知らせる。在室中は待機所の画面と
        チャイムが鳴るので、二重には鳴らさない。

        visitorId を持たない要求だけを「新しい来訪」とみなす。再読み込みや
        再接続では覚えている id が送られてくるため、同じ人で何度も鳴らない。

        誰が来たかは載せない。人数だけ知らせる。
      */
      if (!visitorId && status.presence === 'offline') {
        await notifyArrival({ queueLength: status.queueLength });
      }

      return NextResponse.json({
        visitorId: visitor.id,
        handle: visitor.handle,
        state: visitor.state,
        sessionId: visitor.session_id,
        // 告解室の経過時間の起点。まだ入っていなければ null
        enteredAt: visitor.entered_at ? new Date(visitor.entered_at).getTime() : null,
        // 列に並んだ時刻。「◯分お待ちです」の起点になる
        joinedAt: visitor.joined_at ? new Date(visitor.joined_at).getTime() : null,
        status,
      });
    }

    case 'heartbeat': {
      if (!visitorId) return NextResponse.json({ error: 'visitorId が要ります。' }, { status: 400 });
      return NextResponse.json({ alive: await heartbeat(visitorId) });
    }

    case 'enter': {
      if (!visitorId) return NextResponse.json({ error: 'visitorId が要ります。' }, { status: 400 });
      return NextResponse.json(await enter(visitorId));
    }

    case 'accept': {
      if (!visitorId) return NextResponse.json({ error: 'visitorId が要ります。' }, { status: 400 });
      return NextResponse.json(await acceptInvite(visitorId));
    }

    case 'leave': {
      if (!visitorId) return NextResponse.json({ error: 'visitorId が要ります。' }, { status: 400 });
      await leave(visitorId, '退室しました。', false);
      return NextResponse.json({ ok: true });
    }

    default:
      return NextResponse.json({ error: '不明な操作です。' }, { status: 400 });
  }
}
