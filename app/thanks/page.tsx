'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { Backdrop } from '@/components/Backdrop';

function ThanksView() {
  const searchParams = useSearchParams();
  const raw = searchParams.get('return_to');
  // 外部サイトへ飛ばされないよう、自サイト内の相対パスだけを受け付ける
  const returnTo = raw && /^\/[^/\\]/.test(raw) ? raw : null;

  return (
    <div className="mx-auto max-w-3xl space-y-10 text-center">
      <Backdrop scene="chapel" />

      <section className="space-y-5">
        <p className="text-xs tracking-[0.4em] text-paper-dim">受け取りました</p>
        <h1 className="text-xl leading-relaxed tracking-[0.2em] sm:text-2xl">
          ありがとうございます
        </h1>
        <p className="mx-auto max-w-md text-sm leading-loose text-paper-dim">
          お気持ちは、この場所の灯りを絶やさないために使わせていただきます。
          金額の多少で、話す時間が変わることはありません。
        </p>
      </section>

      <div className="rule" />

      <div className="flex flex-col gap-3 sm:flex-row">
        {returnTo ? (
          <Link href={returnTo} className="btn btn-primary grow">
            部屋に戻る
          </Link>
        ) : null}
        <Link href="/" className="btn btn-quiet grow">
          入口へ戻る
        </Link>
      </div>

      <p className="text-[0.7rem] leading-relaxed text-paper-dim/70">
        領収に関するご連絡は Stripe から届きます。聴き宮側では、
        どなたが納めたかを記録していません。
      </p>
    </div>
  );
}

export default function ThanksPage() {
  return (
    <Suspense fallback={<p className="text-center text-sm text-paper-dim">…</p>}>
      <ThanksView />
    </Suspense>
  );
}
