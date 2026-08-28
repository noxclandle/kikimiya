import { NextResponse } from 'next/server';
import { createDonationSession, stripeConfigured } from '@/lib/server/stripe';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  if (!stripeConfigured()) {
    // 設定漏れを来訪者に見せない。運営者側はサーバーのログで気づけるようにする。
    console.warn(
      '[donate] お布施が未設定です。NEXT_PUBLIC_STRIPE_PAYMENT_LINK か STRIPE_SECRET_KEY を設定してください。',
    );
    return NextResponse.json(
      { error: 'いまはお布施をお受けできません。お気持ちだけ、ありがたく。' },
      { status: 501 },
    );
  }

  let returnTo: string | undefined;
  try {
    const body = (await request.json()) as { returnTo?: unknown };
    // オープンリダイレクトを避けるため、自サイト内の相対パスだけを許可する
    if (typeof body.returnTo === 'string' && /^\/[^/\\]/.test(body.returnTo)) {
      returnTo = body.returnTo;
    }
  } catch {
    returnTo = undefined;
  }

  const baseUrl =
    process.env.NEXT_PUBLIC_BASE_URL?.replace(/\/$/, '') || new URL(request.url).origin;

  try {
    const url = await createDonationSession({ baseUrl, returnTo });
    return NextResponse.json({ url });
  } catch (cause) {
    console.error('[donate] Checkout Session の作成に失敗:', cause);
    return NextResponse.json({ error: 'お布施の受付を開けませんでした。' }, { status: 500 });
  }
}
