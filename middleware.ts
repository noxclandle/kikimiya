import { NextResponse, type NextRequest } from 'next/server';

/**
 * 待機所（神父の部屋）の入口を隠す。
 *
 * `ADMIN_PATH` を設定すると、待機所はその名前でだけ開くようになり、
 * `/admin` は「そんなページは無い」と答えるようになる。
 *
 * ただし **これは鍵の代わりにはならない**。当てずっぽうで辿り着かれることは防げても、
 * URLが人目に触れた時点で意味を失う。合言葉（ADMIN_PASSWORD）は必ず併用すること。
 * ここでやっているのは「知らない人の目に触れさせない」までで、
 * 中に入れるかどうかは合言葉が決めている。
 *
 * 未設定なら、これまでどおり `/admin` が開く（設定漏れで自分が締め出されないように）。
 */

const REAL_PATH = '/admin';

function secretPath(): string | null {
  const raw = process.env.ADMIN_PATH?.trim().replace(/^\/+|\/+$/g, '');
  return raw ? `/${raw}` : null;
}

export function middleware(request: NextRequest) {
  const secret = secretPath();
  if (!secret) return NextResponse.next();

  const { pathname } = request.nextUrl;

  // 隠し名で来たら、中身は待機所を返す（URLはそのまま隠し名で表示される）
  if (pathname === secret || pathname === `${secret}/`) {
    const url = request.nextUrl.clone();
    url.pathname = REAL_PATH;
    const response = NextResponse.rewrite(url);
    // 検索の網にかからないようにする
    response.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return response;
  }

  // 本来の名前は無かったことにする
  if (pathname === REAL_PATH || pathname.startsWith(`${REAL_PATH}/`)) {
    return new NextResponse(null, { status: 404 });
  }

  return NextResponse.next();
}

export const config = {
  // 画像やAPIまで通さない（無駄に呼ばれないように）
  matcher: ['/((?!api/|_next/|images/|mock/|favicon).*)'],
};
