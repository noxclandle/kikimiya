'use client';

import { useEffect, useRef } from 'react';
import { EMERGENCY_LINES, type Helpline } from '@/lib/helplines';

export function HelplineCard({ line }: { line: Helpline }) {
  return (
    <li className="panel px-4 py-3">
      <p className="text-sm text-paper">{line.name}</p>
      <p className="mt-1 text-xs leading-relaxed text-paper-dim">{line.detail}</p>
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {line.tel ? (
          <a href={`tel:${line.tel.replace(/-/g, '')}`} className="link tabular-nums">
            {line.tel}
          </a>
        ) : null}
        {line.url ? (
          <a href={line.url} target="_blank" rel="noopener noreferrer" className="link">
            相談ページを開く
          </a>
        ) : null}
        {line.hours ? <span className="text-paper-dim/70">{line.hours}</span> : null}
      </div>
    </li>
  );
}

export function HelplineList() {
  return (
    <ul className="space-y-2">
      {EMERGENCY_LINES.map((line) => (
        <HelplineCard key={line.name} line={line} />
      ))}
    </ul>
  );
}

/**
 * 「つらい」ボタンで開くモーダル。
 * 会話は止めない — 閉じればそのまま話し続けられる。
 */
export function EmergencyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="emergency-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/80 p-4 sm:items-center"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="panel max-h-[85dvh] w-full max-w-lg overflow-y-auto p-6">
        <h2 id="emergency-title" className="text-lg tracking-[0.2em] text-gold">
          ひとりで抱えないでください
        </h2>
        <p className="mt-3 text-sm leading-relaxed text-paper-dim">
          聴き宮は、ただ話を聴くだけの場所です。いま危ないと感じるとき、
          専門の人に頼るほうが確かなことがあります。下の窓口は、あなたのためにあります。
        </p>

        <div className="my-5 rule" />

        <HelplineList />

        <div className="mt-6 flex flex-col gap-2 sm:flex-row-reverse">
          <button ref={closeRef} type="button" className="btn btn-primary grow" onClick={onClose}>
            閉じて、話を続ける
          </button>
        </div>
        <p className="mt-3 text-[0.7rem] leading-relaxed text-paper-dim/70">
          閉じても会話は続いています。何度でも開いて構いません。
        </p>
      </div>
    </div>
  );
}
