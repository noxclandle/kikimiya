import 'server-only';
import crypto from 'node:crypto';
import { db } from './supabase';

/**
 * 連投を抑える。
 *
 * 常駐するサーバーが無いのでメモリには数えられない。数はデータベースに置く。
 * 誰からの試行かは **IPそのものではなく、秘密鍵で HMAC した値**で数える。
 * 生のIPはどこにも書かない（聴き宮は匿名で話せることが前提のため）。
 */

function secret(): string {
  return process.env.SUPABASE_SECRET_KEY ?? process.env.ADMIN_PASSWORD ?? 'kikimiya';
}

/** 要求の出どころを、復元できない形の鍵にする */
export function sourceKey(request: Request, scope: string): string {
  const source =
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown';
  const digest = crypto.createHmac('sha256', secret()).update(source).digest('base64url');
  return `${scope}:${digest.slice(0, 32)}`;
}

/**
 * windowMs のあいだに max 回まで許す。許すなら true。
 *
 * 数え間違いより「詰まらせないこと」を優先する。数えられなかったとき（DB障害など）は
 * 通す側に倒す — 手紙を預けにきた人を、こちらの都合で追い返さないため。
 */
export async function allow(key: string, windowMs: number, max: number): Promise<boolean> {
  const now = Date.now();

  try {
    const { data } = await db()
      .from('rate_limits')
      .select('count, reset_at')
      .eq('id', key)
      .maybeSingle();

    const fresh = !data || new Date(data.reset_at).getTime() < now;

    if (fresh) {
      await db()
        .from('rate_limits')
        .upsert({ id: key, count: 1, reset_at: new Date(now + windowMs).toISOString() });
      // 窓が切り替わったついでに、期限の切れた行を片づける
      await db()
        .from('rate_limits')
        .delete()
        .lt('reset_at', new Date(now - 60 * 60 * 1000).toISOString());
      return true;
    }

    if (data.count >= max) return false;

    await db()
      .from('rate_limits')
      .update({ count: data.count + 1 })
      .eq('id', key);
    return true;
  } catch (cause) {
    console.error('[ratelimit] 数えられませんでした:', cause);
    return true;
  }
}
