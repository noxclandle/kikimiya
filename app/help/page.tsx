import type { Metadata } from 'next';
import Link from 'next/link';
import { HelplineList } from '@/components/EmergencyModal';

export const metadata: Metadata = {
  title: '相談窓口 — 聴き宮',
  robots: { index: false, follow: false },
};

export default function HelpPage() {
  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <header className="space-y-3">
        <p className="text-xs tracking-[0.35em] text-paper-dim">そのほかの場所</p>
        <h1 className="text-xl tracking-[0.2em]">相談窓口</h1>
        <p className="text-sm leading-loose text-paper-dim">
          聴き宮は、ただ話を聴くだけの場所です。専門の助けが要るとき、
          こちらのほうが確かに力になれます。
        </p>
      </header>

      <div className="rule" />

      <HelplineList />

      <p className="text-[0.7rem] leading-relaxed text-paper-dim/70">
        連絡先や受付時間は変わることがあります。最新の情報は各窓口でご確認ください。
      </p>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Link href="/" className="btn btn-quiet grow">
          入口へ戻る
        </Link>
        <Link href="/terms" className="btn btn-quiet">
          利用規約・免責
        </Link>
      </div>
    </div>
  );
}
