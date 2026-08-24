'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Backdrop } from '@/components/Backdrop';
import { fetchWrittenMessage } from '@/lib/api';
import type { PublicMessage } from '@/lib/types';

function formatDate(at: number): string {
  return new Date(at).toLocaleString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function MessageReceiptPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';
  const [message, setMessage] = useState<PublicMessage | null>(null);
  const [replyEtaDays, setReplyEtaDays] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    fetchWrittenMessage(token)
      .then((data) => {
        if (cancelled) return;
        setMessage(data.message);
        setReplyEtaDays(data.replyEtaDays);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(cause instanceof Error ? cause.message : '読み込めませんでした。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  if (loading) {
    return <p className="text-center text-sm text-paper-dim">開いています…</p>;
  }

  if (error || !message) {
    return (
      <div className="mx-auto max-w-3xl space-y-6 text-center">
        <p className="text-sm leading-loose text-paper">{error ?? '見つかりませんでした。'}</p>
        <p className="text-xs leading-relaxed text-paper-dim">
          URLが正しいかご確認ください。控えを失うと、投稿には辿り着けなくなります。
        </p>
        <Link href="/message" className="btn btn-quiet">
          もう一度、文章で預ける
        </Link>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <Backdrop scene="chapel" dimmed />

      <section className="space-y-2 text-center">
        <p className="text-xs tracking-[0.35em] text-paper-dim">預けたもの</p>
        <p className="text-xs text-paper-dim">{formatDate(message.createdAt)}</p>
      </section>

      <article className="panel px-6 py-6">
        <p className="whitespace-pre-wrap break-words text-sm leading-loose text-paper">
          {message.body}
        </p>
      </article>

      <div className="rule" />

      <section className="space-y-4">
        <h2 className="text-xs tracking-[0.3em] text-paper-dim">返事</h2>
        {message.replies.length === 0 ? (
          <div className="panel space-y-2 px-6 py-6 text-sm leading-loose text-paper-dim">
            <p>
              {message.readAt
                ? 'すでに読まれています。返事はもう少しお待ちください。'
                : 'まだ読まれていません。'}
            </p>
            {replyEtaDays ? <p className="text-xs">返信の目安：{replyEtaDays}日以内</p> : null}
            <p className="text-xs">
              このページをときどき開いてみてください。返事はここに書き足されます。
            </p>
          </div>
        ) : (
          <ul className="space-y-4">
            {message.replies.map((reply) => (
              <li key={reply.at} className="panel border-l-2 border-gold/40 px-6 py-5">
                <p className="whitespace-pre-wrap break-words text-sm leading-loose text-paper">
                  {reply.body}
                </p>
                <p className="mt-3 text-[0.7rem] text-paper-dim">{formatDate(reply.at)}</p>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="flex flex-col gap-3 sm:flex-row">
        <Link href="/" className="btn btn-quiet grow">
          入口へ戻る
        </Link>
        <Link href="/message" className="btn btn-quiet">
          もう一度預ける
        </Link>
      </div>
    </div>
  );
}
