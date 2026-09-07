/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  async headers() {
    return [
      {
        /**
         * Vercel が配る `*.vercel.app` は、独自ドメインと同じ中身を返す。
         * 放っておくと同じページが二つのURLで拾われ、
         * どちらが本物か検索側に判断させることになる（重複コンテンツ）。
         * 表の住所は kikimiya.hexa-relation.com だけ、とここで宣言する。
         */
        source: '/:path*',
        has: [{ type: 'host', value: '(?<vercelPreview>.*\\.vercel\\.app)' }],
        headers: [{ key: 'X-Robots-Tag', value: 'noindex, nofollow' }],
      },
    ];
  },
};

export default nextConfig;
