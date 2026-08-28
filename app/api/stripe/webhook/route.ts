import { NextResponse } from 'next/server';
import Stripe from 'stripe';
import { notifyPurchase } from '@/lib/purchase-notify';

/**
 * Stripe Webhook。お布施が実際に支払われたことを受け取る。
 *
 * これが無いと、お布施は Stripe のダッシュボードを見に行くまで気づけない。
 *
 * 守っていること:
 *  - **署名検証を通らないリクエストは一切処理しない。** これが無いと
 *    誰でも「お布施が入った」を偽装して通知チャンネルを荒らせる
 *  - 署名検証には**生のリクエストボディ**が必要。JSON パースしてはいけない
 *  - 通知に失敗しても 200 を返す。500 を返すと Stripe が再送を繰り返し、
 *    最終的にエンドポイントを無効化してしまう
 *
 * 必要な環境変数:
 *   STRIPE_SECRET_KEY             既存
 *   STRIPE_WEBHOOK_SECRET         Stripe 側でこのエンドポイントを登録して得る whsec_...
 *   DISCORD_PURCHASE_WEBHOOK_URL  通知の宛先
 *
 * Stripe 側の登録先:
 *   https://kikimiya.hexa-relation.com/api/stripe/webhook
 *   受け取るイベントは checkout.session.completed だけでよい
 */

// 署名検証のため Node ランタイムで動かす
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const key = process.env.STRIPE_SECRET_KEY;
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!key || !secret) {
    console.warn('[stripe-webhook] STRIPE_SECRET_KEY か STRIPE_WEBHOOK_SECRET が未設定です。');
    return NextResponse.json({ error: 'stripe is not configured' }, { status: 503 });
  }

  const signature = request.headers.get('stripe-signature');
  if (!signature) {
    return NextResponse.json({ error: 'missing signature' }, { status: 400 });
  }

  const payload = await request.text();

  let event: Stripe.Event;
  try {
    event = new Stripe(key).webhooks.constructEvent(payload, signature, secret);
  } catch {
    // 署名が合わない = 偽装の可能性。中身は一切ログに残さない
    console.error('[stripe-webhook] 署名検証に失敗しました。');
    return NextResponse.json({ error: 'invalid signature' }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object as Stripe.Checkout.Session;

    if (session.payment_status === 'paid') {
      /*
        来訪者を特定しうる情報は載せない。聴き宮は匿名で話せることが前提で、
        「誰がいくら置いていったか」が分かる形にしてしまうと、
        告解室で話した内容と結びついてしまう。金額と照合IDだけ流す。
      */
      await notifyPurchase({
        service: '聴き宮',
        product: 'お布施',
        amountJpy: session.amount_total,
        fields: [
          { name: '通貨', value: (session.currency ?? 'jpy').toUpperCase(), inline: true },
          { name: '備考', value: '来訪者を特定できる情報は意図的に載せていません' },
        ],
        reference: session.id,
      });
    }
  }

  return NextResponse.json({ received: true });
}
