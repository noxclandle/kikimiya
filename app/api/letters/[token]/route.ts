import { NextResponse } from 'next/server';
import { db } from '@/lib/server/supabase';
import { siteConfig } from '@/lib/server/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 発行された控えのURLから、自分の手紙と返事を読む（ログイン不要） */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  const { data } = await db()
    .from('letters')
    .select('token, body, sender, created_at, read_at, replies')
    .eq('token', token)
    .maybeSingle();

  if (!data) {
    return NextResponse.json({ error: 'この控えは見つかりませんでした。' }, { status: 404 });
  }

  const { replyEtaDays } = await siteConfig();
  return NextResponse.json({
    message: {
      token: data.token,
      body: data.body,
      sender: data.sender ?? {},
      createdAt: new Date(data.created_at).getTime(),
      readAt: data.read_at ? new Date(data.read_at).getTime() : null,
      replies: data.replies ?? [],
    },
    replyEtaDays,
  });
}
