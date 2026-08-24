'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Backdrop } from '@/components/Backdrop';
import { PeerIndicator } from '@/components/ConnectionStatus';
import { DonationButton } from '@/components/DonationButton';
import { DONATION_ENABLED } from '@/lib/config';
import { EmergencyModal } from '@/components/EmergencyModal';
import { VolumeSlider } from '@/components/VolumeSlider';
import { useHeartbeat } from '@/lib/heartbeat';
import { useSocket } from '@/lib/socket';
import { useVoiceCall } from '@/lib/voice';
import type { ChatMessage } from '@/lib/types';

const ADMIN_TOKEN_KEY = 'kikimiya:father-token';

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = String(Math.floor(total / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${minutes}:${seconds}`;
}

function timeOf(at: number): string {
  return new Date(at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}

function RoomView() {
  const params = useParams<{ sessionId: string }>();
  const searchParams = useSearchParams();
  const router = useRouter();
  const sessionId = params?.sessionId ?? '';
  const isFather = searchParams.get('role') === 'father';

  const { socket, connected } = useSocket();
  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [peerPresent, setPeerPresent] = useState(false);
  const [peerStale, setPeerStale] = useState(false);
  const [closed, setClosed] = useState<string | null>(null);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const voice = useVoiceCall(socket, closed === null);
  const logRef = useRef<HTMLDivElement>(null);

  useHeartbeat(socket, closed === null);

  /* ------------------------- 入室・イベント購読 ------------------------- */

  useEffect(() => {
    if (!socket || !sessionId) return;

    const join = () => {
      if (isFather) {
        const token = window.localStorage.getItem(ADMIN_TOKEN_KEY);
        if (!token) {
          setClosed('神父としての認証が切れています。待機ページからやり直してください。');
          return;
        }
        socket.emit('father:auth', { token });
        socket.emit('father:join-room', { sessionId });
      } else {
        socket.emit('visitor:resume', { sessionId });
      }
    };

    if (socket.connected) join();
    socket.on('connect', join);

    const onReady = ({ startedAt: at }: { startedAt: number }) => {
      setStartedAt(at);
      setClosed(null);
    };
    const onHistory = (history: ChatMessage[]) => setMessages(history);
    const onMessage = (message: ChatMessage) =>
      setMessages((current) => [...current, message]);
    const onPeer = ({ present, stale }: { present: boolean; stale: boolean }) => {
      setPeerPresent(present);
      setPeerStale(stale);
    };
    const onClosed = ({ reason }: { reason: string }) => setClosed(reason);

    socket.on('room:ready', onReady);
    socket.on('chat:history', onHistory);
    socket.on('chat:message', onMessage);
    socket.on('room:peer', onPeer);
    socket.on('room:closed', onClosed);

    return () => {
      socket.off('connect', join);
      socket.off('room:ready', onReady);
      socket.off('chat:history', onHistory);
      socket.off('chat:message', onMessage);
      socket.off('room:peer', onPeer);
      socket.off('room:closed', onClosed);
    };
  }, [socket, sessionId, isFather]);

  // 経過時間
  useEffect(() => {
    if (!startedAt || closed) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt, closed]);

  // 新しい発言までスクロール
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  const elapsed = useMemo(
    () => (startedAt ? formatElapsed(now - startedAt) : '--:--'),
    [startedAt, now],
  );

  /* ----------------------------- 操作 ----------------------------- */

  const send = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const text = draft.trim();
      if (!text || !socket) return;
      socket.emit('chat:send', { text });
      setDraft('');
    },
    [draft, socket],
  );

  const leave = useCallback(() => {
    voice.hangUp();
    if (isFather) {
      socket?.emit('father:end-session', {
        reason: '神父が退室しました。お話しくださってありがとうございました。',
      });
      router.push('/admin');
      return;
    }
    socket?.emit('visitor:leave');
    router.push('/');
  }, [voice, isFather, socket, router]);

  /* ---------------------------- 終了画面 ---------------------------- */

  if (closed) {
    return (
      <div className="mx-auto max-w-3xl space-y-8">
        <Backdrop scene="chapel" />

        <section className="panel space-y-4 px-6 py-8 text-center">
          <p className="text-xs tracking-[0.35em] text-paper-dim">対話は終わりました</p>
          <p className="text-sm leading-loose text-paper">{closed}</p>
          <p className="text-xs leading-relaxed text-paper-dim">
            話された内容は、どこにも残していません。
          </p>
        </section>

        {!isFather && DONATION_ENABLED ? (
          <section className="panel space-y-4 px-6 py-6">
            <h2 className="text-sm tracking-[0.2em] text-paper">お布施</h2>
            <p className="text-xs leading-relaxed text-paper-dim">
              金額はご自由に。納めなくても、何も変わりません。
            </p>
            <DonationButton />
          </section>
        ) : null}

        <Link href={isFather ? '/admin' : '/'} className="btn btn-quiet w-full">
          {isFather ? '待機ページへ戻る' : '入口へ戻る'}
        </Link>

        <EmergencyModal open={emergencyOpen} onClose={() => setEmergencyOpen(false)} />
      </div>
    );
  }

  /* ---------------------------- 通常表示 ---------------------------- */

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <Backdrop scene="confessional" />
      <audio ref={voice.audioRef} autoPlay playsInline className="hidden" />

      {/* 状態と経過時間 */}
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs tracking-[0.3em] text-paper-dim">
            {isFather ? '対応中' : '告解室'}
          </p>
          <PeerIndicator
            connected={connected}
            peerPresent={peerPresent}
            peerStale={peerStale}
            audioFlowing={voice.audioFlowing}
          />
        </div>
        <div className="text-right">
          <p className="text-xs tracking-[0.3em] text-paper-dim">経過</p>
          <p className="text-2xl tabular-nums text-gold">{elapsed}</p>
        </div>
      </section>

      <div className="rule" />

      {/* 音声 */}
      <section className="panel space-y-5 px-6 py-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm tracking-[0.2em] text-paper">声</h2>
          <span className="text-xs text-paper-dim">
            {voice.phase === 'live'
              ? 'つながっています'
              : voice.phase === 'connecting'
                ? 'つないでいます…'
                : voice.phase === 'waiting'
                  ? '相手を待っています'
                  : voice.phase === 'requesting'
                    ? 'マイクの許可を待っています'
                    : voice.phase === 'error'
                      ? '音声は使えません'
                      : '文字だけでも話せます'}
          </span>
        </div>

        {voice.phase === 'off' || voice.phase === 'error' ? (
          <button type="button" className="btn btn-primary w-full" onClick={() => void voice.enable()}>
            マイクを許可して声でつなぐ
          </button>
        ) : (
          <div className="grid gap-5 sm:grid-cols-2">
            <VolumeSlider
              label="マイク（自分の声）"
              value={voice.micVolume}
              onChange={voice.setMicVolume}
              hint="下げると、相手に届く声そのものが小さくなります。"
            />
            <VolumeSlider
              label="スピーカー（相手の声）"
              value={voice.speakerVolume}
              onChange={voice.setSpeakerVolume}
              hint="この端末で聞こえる音量だけを変えます。"
            />
          </div>
        )}

        {voice.phase !== 'off' && voice.phase !== 'error' ? (
          <button
            type="button"
            className={voice.muted ? 'btn btn-danger w-full' : 'btn btn-quiet w-full'}
            onClick={() => voice.setMuted(!voice.muted)}
          >
            {voice.muted ? 'ミュート中 — 解除する' : '今すぐミュートする'}
          </button>
        ) : null}

        {voice.error ? <p className="text-xs leading-relaxed text-ember">{voice.error}</p> : null}
      </section>

      {/* 文字での会話 */}
      <section className="panel flex flex-col px-6 py-6">
        <h2 className="text-sm tracking-[0.2em] text-paper">文字</h2>
        <div
          ref={logRef}
          className="my-4 h-64 space-y-3 overflow-y-auto pr-1"
          aria-live="polite"
        >
          {messages.length === 0 ? (
            <p className="pt-8 text-center text-xs leading-loose text-paper-dim/70">
              まだ何も書かれていません。
              <br />
              声でも文字でも、話しやすいほうで。
            </p>
          ) : (
            messages.map((message) => {
              const mine =
                (isFather && message.from === 'father') ||
                (!isFather && message.from === 'visitor');
              if (message.from === 'system') {
                return (
                  <p key={message.id} className="text-center text-xs text-paper-dim/70">
                    {message.text}
                  </p>
                );
              }
              return (
                <div key={message.id} className={mine ? 'text-right' : 'text-left'}>
                  <div
                    className={`inline-block max-w-[85%] rounded-sm px-4 py-2 text-sm leading-relaxed ${
                      mine
                        ? 'bg-gold/10 text-paper'
                        : 'border border-white/8 bg-black/25 text-paper'
                    }`}
                  >
                    <span className="whitespace-pre-wrap break-words">{message.text}</span>
                  </div>
                  <p className="mt-1 text-[0.65rem] text-paper-dim/60">{timeOf(message.at)}</p>
                </div>
              );
            })
          )}
        </div>

        <form onSubmit={send} className="flex gap-2">
          <input
            className="field"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="書いて伝える"
            maxLength={2000}
            aria-label="メッセージ"
          />
          <button type="submit" className="btn btn-quiet shrink-0" disabled={!draft.trim()}>
            送る
          </button>
        </form>
      </section>

      {!isFather && DONATION_ENABLED ? (
        <section>
          <DonationButton variant="quiet" openInNewTab returnTo={`/room/${sessionId}`} />
        </section>
      ) : null}

      <div className="rule" />

      <section>
        {confirmLeave ? (
          <div className="panel space-y-4 px-6 py-5">
            <p className="text-sm leading-relaxed text-paper">
              退室すると、この対話はここで終わります。
              {isFather ? '' : '話された内容はどこにも残りません。'}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button type="button" className="btn btn-danger grow" onClick={leave}>
                はい、退室します
              </button>
              <button
                type="button"
                className="btn btn-quiet"
                onClick={() => setConfirmLeave(false)}
              >
                いいえ、続けます
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-quiet w-full"
            onClick={() => setConfirmLeave(true)}
          >
            退室する
          </button>
        )}
        <p className="mt-3 text-center text-[0.7rem] leading-relaxed text-paper-dim/70">
          ブラウザを閉じたり再読み込みしたりすると、自動的に退室になります。
        </p>
        <p className="mt-4 text-center text-[0.7rem] text-paper-dim/60">
          <button
            type="button"
            className="underline underline-offset-4 hover:text-paper-dim"
            onClick={() => setEmergencyOpen(true)}
          >
            いま、つらい
          </button>
        </p>
      </section>

      <EmergencyModal open={emergencyOpen} onClose={() => setEmergencyOpen(false)} />
    </div>
  );
}

export default function RoomPage() {
  return (
    <Suspense fallback={<p className="text-center text-sm text-paper-dim">支度をしています…</p>}>
      <RoomView />
    </Suspense>
  );
}
