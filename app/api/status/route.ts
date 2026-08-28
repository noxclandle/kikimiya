import { NextResponse } from 'next/server';
import { publicStatus, siteConfig, sweep } from '@/lib/server/state';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** 入口ページが最初に呼ぶ。ついでに在室確認の掃除もする。 */
export async function GET() {
  // 掃除で読んだ顔ぶれを、そのまま状況の計算に使い回す
  const alive = await sweep();
  const [status, config] = await Promise.all([publicStatus(alive), siteConfig()]);
  return NextResponse.json({ status, replyEtaDays: config.replyEtaDays });
}
