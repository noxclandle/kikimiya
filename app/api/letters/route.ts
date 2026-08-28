import { NextResponse } from 'next/server';
import crypto from 'node:crypto';
import { db } from '@/lib/server/supabase';
import { publish, siteConfig } from '@/lib/server/state';
import { allow, sourceKey } from '@/lib/server/ratelimit';
import { AGE_BANDS, GENDERS, type Sender } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_BODY = 4000;

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
  const name = text(input.name, 60);
  if (name) sender.name = name;

  const email = text(input.email, 254);
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

/** 手紙を預かる */
export async function POST(request: Request) {
  // 1分に5通まで。書き直して出し直す人を止めない程度に、荒らしだけを止める。
  if (!(await allow(sourceKey(request, 'letters'), 60_000, 5))) {
    return NextResponse.json(
      { error: '少し間を置いてから、もう一度お送りください。' },
      { status: 429 },
    );
  }

  let payload: { body?: unknown; sender?: unknown };
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: '不正な要求です。' }, { status: 400 });
  }

  const body = typeof payload.body === 'string' ? payload.body.trim() : '';
  if (!body) return NextResponse.json({ error: '本文が空です。' }, { status: 400 });
  if (body.length > MAX_BODY) {
    return NextResponse.json({ error: `本文は${MAX_BODY}文字までです。` }, { status: 400 });
  }

  const token = crypto.randomBytes(16).toString('base64url');
  const { error } = await db()
    .from('letters')
    .insert({ token, body, sender: readSender(payload.sender) });

  if (error) {
    console.error('[letters] 保存に失敗:', error.message);
    return NextResponse.json({ error: 'お預かりできませんでした。' }, { status: 500 });
  }

  await publish();
  const { replyEtaDays } = await siteConfig();
  return NextResponse.json({ token, createdAt: Date.now(), replyEtaDays }, { status: 201 });
}
