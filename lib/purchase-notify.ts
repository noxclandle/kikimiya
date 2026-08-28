/*
  お布施が入ったときの Discord 通知。

  聴き宮は匿名で話せることが前提のサービスなので、
  **通知には来訪者を特定しうる情報を一切載せない。**
  Stripe は決済時にメールアドレスを取得するが、ここでは意図的に捨てている。
  金額と照合IDだけあれば、Stripe のダッシュボード側で必要な確認はできる。

  ここで守っていること:
  - **決済処理を絶対に止めない。** 通知は支払いが成立した後の付随処理。
    ここで throw すると Webhook が 500 を返し、Stripe が再送を繰り返した末に
    エンドポイントを無効化してしまう。
  - **黙って失敗しない。** 未設定も送信失敗も console.error として残す。

  必要な環境変数:
    DISCORD_PURCHASE_WEBHOOK_URL  購入通知の宛先
*/

export type PurchaseField = { name: string; value: string; inline?: boolean };

export type PurchaseEvent = {
  /** どのサービスで売れたか */
  service: string;
  /** 何が売れたか */
  product: string;
  /** 税込金額（円） */
  amountJpy?: number | null;
  /** 商品ごとに詰め替える内訳 */
  fields?: PurchaseField[];
  /** 後から突き合わせるための ID */
  reference?: string | null;
};

/** サービスごとに色を変えて、購入チャンネル上で見分けられるようにする */
const COLOR_BY_SERVICE: Record<string, number> = {
  聴き宮: 0x8d7ab8,
};
const DEFAULT_COLOR = 0xb4741a;

const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;

function buildPayload(e: PurchaseEvent) {
  const fields: PurchaseField[] = [];

  if (e.amountJpy != null) fields.push({ name: '金額', value: yen(e.amountJpy), inline: true });
  for (const f of e.fields ?? []) fields.push({ ...f, value: f.value.slice(0, 1024) });
  if (e.reference) fields.push({ name: '照合ID', value: `\`${e.reference}\``, inline: false });

  return {
    embeds: [
      {
        title: `${e.product} が届きました`,
        color: COLOR_BY_SERVICE[e.service] ?? DEFAULT_COLOR,
        author: { name: e.service },
        fields,
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

type PostResult = { ok: true } | { ok: false; reason: string };

async function postToWebhook(url: string, body: unknown): Promise<PostResult> {
  let lastReason = '不明';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (error) {
      lastReason = `ネットワーク: ${error instanceof Error ? error.name : '不明'}`;
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 500);
      continue;
    }

    if (res.ok) return { ok: true };

    if (res.status === 429) {
      const retryAfter = Number(res.headers.get('retry-after')) || 1;
      lastReason = `レート制限（${retryAfter}秒待機の指示）`;
      if (attempt < MAX_ATTEMPTS) await sleep(Math.min(retryAfter, 5) * 1000);
      continue;
    }

    if (res.status >= 500) {
      lastReason = `Discord側エラー ${res.status}`;
      if (attempt < MAX_ATTEMPTS) await sleep(attempt * 500);
      continue;
    }

    // 404=webhook削除済み / 401,403=トークン無効 / 400=ペイロード不正。
    // どれも再送で結果が変わらないので即座に諦める
    if (res.status === 404) lastReason = 'webhook が存在しない（削除済み）';
    else if (res.status === 401 || res.status === 403) lastReason = 'webhook の認証に失敗';
    else lastReason = `送信内容が拒否された ${res.status}`;
    return { ok: false, reason: lastReason };
  }

  return { ok: false, reason: `${MAX_ATTEMPTS}回とも失敗: ${lastReason}` };
}

/**
 * お布施を Discord へ通知する。
 *
 * 例外は投げない。false は「通知が届かなかった」だけを意味し、決済自体は成立している。
 */
export async function notifyPurchase(e: PurchaseEvent): Promise<boolean> {
  const url = process.env.DISCORD_PURCHASE_WEBHOOK_URL;

  if (!url) {
    console.error('[purchase-notify] webhook が未設定。お布施を取りこぼしている', {
      service: e.service,
      product: e.product,
      reference: e.reference ?? 'なし',
    });
    return false;
  }

  const result = await postToWebhook(url, buildPayload(e));
  if (result.ok) return true;

  console.error('[purchase-notify] お布施通知の送信に失敗', {
    service: e.service,
    product: e.product,
    reference: e.reference ?? 'なし',
    reason: result.reason,
  });
  return false;
}
