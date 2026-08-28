import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import { BackdropProvider } from '@/components/Backdrop';
import './globals.css';

export const metadata: Metadata = {
  title: '聴き宮 — 誰にも言えないことを、話す部屋',
  description:
    '匿名で神父と一対一で話せる、オンラインの告解室。登録も名前も要りません。人に言えないことを打ち明け、応えてもらう場所です。カウンセリングでも医療でもありません。',
  robots: { index: true, follow: false },
};

export const viewport: Viewport = {
  themeColor: '#0c0a09',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh antialiased">
        <BackdropProvider>
          <header className="border-b border-white/6">
            <div className="mx-auto flex w-full max-w-5xl items-baseline justify-between px-6 py-5">
              <Link href="/" className="text-lg tracking-[0.35em] text-paper">
                聴<span className="text-gold">き</span>宮
              </Link>
              <span className="text-[0.65rem] tracking-[0.3em] text-paper-dim">KIKIMIYA</span>
            </div>
          </header>

          <main className="mx-auto w-full max-w-5xl grow px-6 py-10 sm:py-14">{children}</main>

          <footer className="border-t border-white/6">
            <div className="mx-auto flex w-full max-w-5xl flex-wrap items-center justify-between gap-3 px-6 py-6 text-xs text-paper-dim">
              <p>ここはカウンセリングでも医療でもありません。打ち明け、応えるための場所です。</p>
              <nav className="flex gap-4">
                <Link href="/terms" className="link">
                  利用規約・免責
                </Link>
                <Link href="/message" className="link">
                  文章で預ける
                </Link>
                <Link href="/help" className="link">
                  相談窓口
                </Link>
              </nav>
            </div>
          </footer>
        </BackdropProvider>
      </body>
    </html>
  );
}
