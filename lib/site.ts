/**
 * 検索エンジンに見せる「表の住所」。
 *
 * Vercel が配る `*.vercel.app` でも中身は同じものが返るので、
 * 何も言わないと同じ内容が二つのURLで拾われる（重複コンテンツ）。
 * robots・sitemap・canonical はすべてここを唯一の正とする。
 */
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? 'https://kikimiya.hexa-relation.com'
).replace(/\/$/, '');
