import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/**
 * 誰が見ても同じ内容の公開ページだけを並べる。
 * 待機所・個別の部屋・書き置きの受け取りURLは載せない（robots.ts と同じ理由）。
 * /help は page.tsx 側で noindex にしてあるので、ここにも載せない
 * （載せると Search Console が「noindex なのに送信された」と警告する）。
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();

  return [
    { url: `${SITE_URL}/`, lastModified: now, changeFrequency: 'daily', priority: 1 },
    { url: `${SITE_URL}/message`, lastModified: now, changeFrequency: 'weekly', priority: 0.8 },
    { url: `${SITE_URL}/terms`, lastModified: now, changeFrequency: 'yearly', priority: 0.3 },
  ];
}
