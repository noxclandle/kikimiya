'use client';

import { useState } from 'react';
import { DONATION_ENABLED, PAYMENT_LINK } from '@/lib/config';

/**
 * お布施（投げ銭）。金額は来訪者が決める。
 * Payment Link が設定されていればそこへ、なければ Checkout Session を作って遷移する。
 */
export function DonationButton({
  returnTo,
  variant = 'primary',
  label = 'お布施を納める',
  openInNewTab = false,
}: {
  returnTo?: string;
  variant?: 'primary' | 'quiet';
  label?: string;
  /** 会話中に押された場合、いまの部屋を離れずに済むよう別タブで開く */
  openInNewTab?: boolean;
}) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 受付そのものが用意されていない状態。来訪者にとっては不具合ではないので静かに出す。 */
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const className = variant === 'primary' ? 'btn btn-primary' : 'btn btn-quiet';

  // 受け付けていないあいだは、ボタンも文言も出さない（フックより後で判定すること）
  if (!DONATION_ENABLED) return null;

  if (PAYMENT_LINK) {
    return (
      <a href={PAYMENT_LINK} target="_blank" rel="noopener noreferrer" className={className}>
        {label}
      </a>
    );
  }

  const start = async () => {
    setPending(true);
    setError(null);
    // ポップアップブロックを避けるため、通信の前に空のタブを開いておく
    const tab = openInNewTab ? window.open('', '_blank', 'noopener,noreferrer') : null;
    try {
      const response = await fetch('/api/donate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ returnTo }),
      });
      const data = (await response.json()) as { url?: string; error?: string };
      if (response.status === 501) {
        tab?.close();
        setUnavailable(data.error ?? 'いまはお布施をお受けできません。');
        setPending(false);
        return;
      }
      if (!response.ok || !data.url) {
        throw new Error(data.error ?? 'お布施の受付を開けませんでした。');
      }
      if (tab) {
        tab.location.href = data.url;
        setPending(false);
      } else {
        window.location.href = data.url;
      }
    } catch (cause) {
      tab?.close();
      setError(cause instanceof Error ? cause.message : 'お布施の受付を開けませんでした。');
      setPending(false);
    }
  };

  if (unavailable) {
    return <p className="text-xs leading-relaxed text-paper-dim">{unavailable}</p>;
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" className={className} onClick={start} disabled={pending}>
        {pending ? 'ご案内しています…' : label}
      </button>
      {error ? <p className="text-xs text-ember">{error}</p> : null}
    </div>
  );
}
