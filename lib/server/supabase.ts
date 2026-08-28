import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/**
 * サーバー側（Vercel の関数）専用の Supabase クライアント。
 *
 * 秘密鍵は RLS を迂回するため、これがブラウザに渡ると
 * 預かった懺悔と手紙が全部読まれる。'server-only' を入れてあるので、
 * クライアント側から誤って import するとビルドが失敗する。
 */
let client: SupabaseClient | null = null;

export function db(): SupabaseClient {
  if (client) return client;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL と SUPABASE_SECRET_KEY を設定してください。');
  }
  client = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

/**
 * リアルタイムの通り道へ、サーバーから声を流す。
 * 在室状況の変化や、入室の案内はここから配る。
 */
export async function broadcast(
  topic: string,
  event: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const secret = process.env.SUPABASE_SECRET_KEY;
  if (!url || !secret) return;

  try {
    const response = await fetch(`${url}/realtime/v1/api/broadcast`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: secret,
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ messages: [{ topic, event, payload, private: false }] }),
    });
    if (!response.ok) {
      console.error('[broadcast] 断られました:', response.status, await response.text());
    }
  } catch (cause) {
    // 通知が届かなくても、状態そのものは DB にあるので致命傷にはしない
    console.error('[broadcast] 送れませんでした:', cause);
  }
}
