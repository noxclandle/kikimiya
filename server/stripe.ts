/**
 * お布施（投げ銭）の決済。
 * 金額は来訪者が決める — Stripe の「Customer chooses price」
 * （custom_unit_amount を有効にした Price）を使う。
 *
 * 設定方法は3通り。上から順に優先される。
 *  1. NEXT_PUBLIC_STRIPE_PAYMENT_LINK … 自由金額の Payment Link に飛ばすだけ（最も簡単）
 *  2. STRIPE_SECRET_KEY + STRIPE_DONATION_PRICE_ID … 作成済みの Price を使う（推奨）
 *  3. STRIPE_SECRET_KEY のみ … 自由金額の Price を初回に自動作成して使い回す
 * いずれも未設定なら、お布施ボタンは「準備中」の表示になる。
 *
 * 秘密鍵はコードに書かず、必ず環境変数から読み込む。
 */
import Stripe from 'stripe';

let client: Stripe | null = null;
let cachedPriceId: string | null = null;

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY);
}

function stripe(): Stripe {
  if (!client) {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY が設定されていません。');
    client = new Stripe(key);
  }
  return client;
}

/** JPY は最小単位が「円」なので、そのままの数値を渡す */
const CURRENCY = (process.env.DONATION_CURRENCY ?? 'jpy').toLowerCase();
const PRESET = Number(process.env.DONATION_PRESET_AMOUNT ?? 1000);
const MIN = Number(process.env.DONATION_MIN_AMOUNT ?? 100);
const MAX = Number(process.env.DONATION_MAX_AMOUNT ?? 100000);

/**
 * 「金額はお客様が決める」Price を用意する。
 * price_data では custom_unit_amount を指定できないため、Price を作ってから参照する。
 */
async function donationPriceId(): Promise<string> {
  const configured = process.env.STRIPE_DONATION_PRICE_ID;
  if (configured) return configured;
  if (cachedPriceId) return cachedPriceId;

  const price = await stripe().prices.create({
    currency: CURRENCY,
    custom_unit_amount: { enabled: true, preset: PRESET, minimum: MIN, maximum: MAX },
    product_data: { name: 'お布施（聴き宮）' },
    nickname: 'kikimiya-donation',
  });

  cachedPriceId = price.id;
  console.log(
    `[stripe] 自由金額の Price を作成しました: ${price.id}\n` +
      '        毎回作らないよう、STRIPE_DONATION_PRICE_ID に設定しておくことをおすすめします。',
  );
  return price.id;
}

export interface DonationSessionOptions {
  /** 決済後に戻ってくる先。告解室から押した場合は告解室に戻す。 */
  returnTo?: string;
  baseUrl: string;
}

export async function createDonationSession(options: DonationSessionOptions): Promise<string> {
  const { baseUrl, returnTo } = options;
  const thanks = new URL('/thanks', baseUrl);
  if (returnTo) thanks.searchParams.set('return_to', returnTo);

  const session = await stripe().checkout.sessions.create({
    mode: 'payment',
    // 来訪者を特定しうる情報は一切渡さない
    line_items: [{ price: await donationPriceId(), quantity: 1 }],
    success_url: thanks.toString(),
    cancel_url: returnTo ? new URL(returnTo, baseUrl).toString() : baseUrl,
    submit_type: 'donate',
  });

  if (!session.url) throw new Error('Checkout Session の URL を取得できませんでした。');
  return session.url;
}
