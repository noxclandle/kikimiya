'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Backdrop } from '@/components/Backdrop';
import { getSiteConfig, sendWrittenMessage } from '@/lib/api';
import { AGE_BANDS, GENDERS, type AgeBand, type Gender, type Sender } from '@/lib/types';

const MAX_LENGTH = 4000;

/** 任意の選択肢。もう一度押すと外せる。 */
function Choice({
  label,
  selected,
  onSelect,
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={`rounded-sm border px-4 py-2 text-sm transition-colors ${
        selected
          ? 'border-gold bg-gold/15 text-gold'
          : 'border-white/12 text-paper-dim hover:border-white/30 hover:text-paper'
      }`}
    >
      {label}
    </button>
  );
}

export default function MessagePage() {
  const [body, setBody] = useState('');
  // ここから下はすべて任意。空のままでも送れる。
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [gender, setGender] = useState<Gender | ''>('');
  const [ageBand, setAgeBand] = useState<AgeBand | ''>('');
  const [replyEtaDays, setReplyEtaDays] = useState<number | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [receiptUrl, setReceiptUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    getSiteConfig()
      .then((config) => setReplyEtaDays(config.replyEtaDays))
      .catch(() => setReplyEtaDays(null));
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = body.trim();
    if (!text) return;
    setSending(true);
    setError(null);
    try {
      const sender: Sender = {};
      if (name.trim()) sender.name = name.trim();
      if (email.trim()) sender.email = email.trim();
      if (gender) sender.gender = gender;
      if (ageBand) sender.ageBand = ageBand;

      const { token, replyEtaDays: eta } = await sendWrittenMessage(text, sender);
      setReplyEtaDays(eta);
      setReceiptUrl(`${window.location.origin}/message/${token}`);
      setBody('');
      setName('');
      setEmail('');
      setGender('');
      setAgeBand('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '送信できませんでした。');
    } finally {
      setSending(false);
    }
  };

  if (receiptUrl) {
    return (
      <div className="mx-auto max-w-3xl space-y-8">
        <Backdrop scene="chapel" />

        <section className="space-y-4 text-center">
          <p className="text-xs tracking-[0.35em] text-paper-dim">お預かりしました</p>
          <h1 className="text-xl leading-relaxed tracking-[0.15em]">確かに、届いています</h1>
        </section>

        <section className="panel space-y-4 px-6 py-6">
          <p className="text-sm leading-loose text-paper-dim">
            返事はこちらのURLに書き足されます。
            <span className="text-paper">この画面を閉じると二度と辿り着けません。</span>
            ブックマークするか、控えておいてください。
          </p>
          <div className="rounded-sm border border-gold/30 bg-black/30 px-4 py-3">
            <p className="break-all font-mono text-xs leading-relaxed text-gold">{receiptUrl}</p>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row">
            <button
              type="button"
              className="btn btn-primary grow"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(receiptUrl);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2500);
                } catch {
                  setCopied(false);
                }
              }}
            >
              {copied ? '控えました' : 'URLを控える'}
            </button>
            <Link href={new URL(receiptUrl).pathname} className="btn btn-quiet">
              いま開いてみる
            </Link>
          </div>
          {replyEtaDays ? (
            <p className="text-xs leading-relaxed text-paper-dim">
              返信の目安：{replyEtaDays}日以内。ただし、お約束はできません。
            </p>
          ) : null}
        </section>

        <Link href="/" className="btn btn-quiet w-full">
          入口へ戻る
        </Link>

      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {/* 神父が席にいないときに開かれる画面なので、灯りは落としておく */}
      <Backdrop scene="chapel" dimmed />

      <section className="space-y-4 text-center">
        <p className="text-xs tracking-[0.35em] text-paper-dim">文で預ける</p>
        <h1 className="text-xl leading-relaxed tracking-[0.15em] sm:text-2xl">
          いま話せなくても、書いておけます
        </h1>
        <p className="mx-auto max-w-md text-sm leading-loose text-paper-dim">
          神父が席にいないときも、書いたものはあとで必ず読まれ、返事が届きます。
          名前も連絡先も要りません。
        </p>
      </section>

      <form onSubmit={submit} className="panel space-y-4 px-6 py-6">
        <label htmlFor="body" className="label">
          預けたいこと
        </label>
        <textarea
          id="body"
          className="field min-h-64 resize-y leading-loose"
          value={body}
          maxLength={MAX_LENGTH}
          onChange={(event) => setBody(event.target.value)}
          placeholder="うまく書けなくて構いません。順番も、まとまりも、要りません。"
        />
        <div className="flex items-center justify-between text-xs text-paper-dim">
          <span>
            {replyEtaDays
              ? `返信の目安：${replyEtaDays}日以内`
              : '返信までお時間をいただくことがあります'}
          </span>
          <span className="tabular-nums">
            {body.length} / {MAX_LENGTH}
          </span>
        </div>

        <div className="rule my-2" />

        <details className="group">
          <summary className="cursor-pointer list-none text-sm text-paper-dim marker:content-['']">
            <span className="text-paper">差出人を書く</span>
            <span className="ml-2 text-xs">— すべて任意です。何も書かなくて構いません</span>
          </summary>

          <div className="mt-5 space-y-5">
            <p className="text-[0.7rem] leading-relaxed text-paper-dim/80">
              名乗りたい方のための欄です。書かなくても、返事は控えのURLに届きます。
              書いていただいた場合は、神父だけがそれを見ます。
            </p>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <label htmlFor="sender-name" className="label">
                  お名前（任意）
                </label>
                <input
                  id="sender-name"
                  className="field"
                  value={name}
                  maxLength={60}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="呼ばれたい名で構いません"
                  autoComplete="off"
                />
              </div>

              <div className="space-y-2">
                <label htmlFor="sender-email" className="label">
                  メールアドレス（任意）
                </label>
                <input
                  id="sender-email"
                  type="email"
                  className="field"
                  value={email}
                  maxLength={254}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="返事の連絡がほしい方のみ"
                  autoComplete="off"
                />
              </div>
            </div>

            <fieldset className="space-y-2">
              <legend className="label">性別（任意）</legend>
              <div className="flex flex-wrap gap-2">
                {GENDERS.map((value) => (
                  <Choice
                    key={value}
                    label={value}
                    selected={gender === value}
                    onSelect={() => setGender(gender === value ? '' : value)}
                  />
                ))}
              </div>
            </fieldset>

            <fieldset className="space-y-2">
              <legend className="label">年代（任意）</legend>
              <div className="flex flex-wrap gap-2">
                {AGE_BANDS.map((value) => (
                  <Choice
                    key={value}
                    label={value}
                    selected={ageBand === value}
                    onSelect={() => setAgeBand(ageBand === value ? '' : value)}
                  />
                ))}
              </div>
            </fieldset>

            <p className="text-[0.7rem] leading-relaxed text-paper-dim/80">
              選んだものをもう一度押すと、取り消せます。
            </p>
          </div>
        </details>

        {error ? <p className="text-xs text-ember">{error}</p> : null}

        <button type="submit" className="btn btn-primary w-full" disabled={sending || !body.trim()}>
          {sending ? 'お預かりしています…' : '預ける'}
        </button>
        <p className="text-[0.7rem] leading-relaxed text-paper-dim/80">
          送信すると、返事を読むための一意のURLが表示されます。
          ログインの代わりになるものなので、他の人に知られないようご注意ください。
        </p>
      </form>

      <section className="space-y-3 pt-2 text-xs leading-loose text-paper-dim/80">
        <div className="rule" />
        <p>
          これはカウンセリングでも医療でもありません。返ってくるのは診断ではなく、
          ひとりの人間の言葉です。
          <Link href="/help" className="link mx-1">
            相談窓口
          </Link>
        </p>
      </section>

    </div>
  );
}
