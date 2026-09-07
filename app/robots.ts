import type { MetadataRoute } from 'next';
import { SITE_URL } from '@/lib/site';

/**
 * ⚠ 一人ひとりのURLは絶対に開けない。
 * `/room/<sessionId>` と `/message/<token>` は、その人だけが持つ合言葉そのもの。
 * 拾われた時点で「匿名で話す」という前提が壊れる。
 * 末尾の `/` があるので `/message`（公開の入口）は通り、
 * `/message/<token>` だけが閉じる。
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/admin/', '/api/', '/room/', '/message/', '/thanks'],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
  };
}
