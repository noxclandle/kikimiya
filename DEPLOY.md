# 公開の手順

置くのは Next.js の1つだけです。常時起動のサーバーは要りません。

```
kikimiya.hexa-relation.com   → Vercel（フロントとAPIを兼ねる）
```

在室・順番・入室案内・告解室のやりとりは Supabase Realtime が運びます。
書き置きと設定は Supabase のデータベースに入ります。

> 以前は Socket.io の常時起動サーバーを Render に置き、
> `realtime.hexa-relation.com` を割り当てる構成でした。
> 2026-08-29 に Vercel と Supabase だけで動く形へ移し、旧サーバーは削除しました。
> **`realtime.hexa-relation.com` はもう使いません。**

## DNS

足すのは CNAME 1本だけです。

| ホスト名 | 種別 | 向き先 | どこで分かるか |
|---|---|---|---|
| `kikimiya` | CNAME | `cname.vercel-dns.com` | Vercel でドメインを追加すると表示されます |

> `kikimiya` のように**前に付ける名前**がサブドメインです。
> 大元のドメイン（`hexa-relation.com` 自体）や、既存のサイトには一切影響しません。

DNS の管理は**お名前.com**（ネームサーバーが `01〜04.dnsv.jp`）。
ドメイン設定 → DNS関連機能設定 → 対象ドメインを選択 → DNSレコード設定を利用する。

## 環境変数

Vercel の Production に入れます。

### 必須

| 変数 | 中身 | どこで取るか |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase のプロジェクト URL | Supabase → Project Settings → API |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | 公開してよい鍵 | 同上 |
| `SUPABASE_SECRET_KEY` | サーバー側だけで使う鍵 | 同上。**公開しないこと** |
| `NEXT_PUBLIC_BASE_URL` | `https://kikimiya.hexa-relation.com` | — |
| `ADMIN_PATH` | 待機所の入口。推測されない文字列にする | 自分で決める |
| `ADMIN_PASSWORD` | 待機所の合言葉 | 自分で決める |

### お布施を受けるなら

| 変数 | 中身 |
|---|---|
| `STRIPE_SECRET_KEY` | Stripe の `sk_live_...`。**作成時にしか表示されない** |
| `STRIPE_WEBHOOK_SECRET` | Stripe で Webhook を登録すると出る `whsec_...` |
| `NEXT_PUBLIC_DONATION_ENABLED` | `1`。これが無いとお布施の導線ごと出ません |
| `STRIPE_DONATION_PRICE_ID` | 任意。自由金額の Price を使い回すとき |

Stripe 側では、Webhook の送信先に
`https://kikimiya.hexa-relation.com/api/stripe/webhook` を登録し、
イベントは `checkout.session.completed` だけを選びます。

### 知らせを受け取るなら

| 変数 | 中身 |
|---|---|
| `DISCORD_PURCHASE_WEBHOOK_URL` | お布施が入ったときの宛先 |
| `DISCORD_KIKIMIYA_WEBHOOK_URL` | 来訪と書き置きの宛先 |

どちらも「届いた」ことだけを流します。
**話した内容も書き置きの本文も差出人も、Discord には送りません。**

## 確認のしかた

公開したあと、次が返れば通っています。

| 叩くもの | 期待する応答 |
|---|---|
| `GET /api/status` | `200`。在室と順番が入った JSON |
| `POST /api/donate` | `200`。`checkout.stripe.com` の URL |
| `POST /api/stripe/webhook`（署名なし） | `400 missing signature` |

`POST /api/donate` が `501` を返すときは `STRIPE_SECRET_KEY` が空です。
`POST /api/stripe/webhook` が `503` を返すときは `STRIPE_SECRET_KEY` か
`STRIPE_WEBHOOK_SECRET` のどちらかが空です。

> 環境変数を足したあとは、**新しくデプロイし直してください。**
> 既存のデプロイをそのまま再実行（redeploy）すると、
> 古い環境変数のまま焼き直されて反映されません。
