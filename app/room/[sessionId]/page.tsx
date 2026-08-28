'use client';

import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Backdrop } from '@/components/Backdrop';
import { PeerIndicator } from '@/components/ConnectionStatus';
import { DonationButton } from '@/components/DonationButton';
import { DONATION_ENABLED, REALTIME_CONFIGURED } from '@/lib/config';
import { EmergencyModal } from '@/components/EmergencyModal';
import { VolumeSlider } from '@/components/VolumeSlider';
import { adminFetchState, adminKick, visitorHello, visitorLeave } from '@/lib/api';
import {
  useFatherHeartbeat,
  useVisitorHeartbeat,
  rememberedVisitorId,
} from '@/lib/heartbeat';
import { useLink, type Link as Channel } from '@/lib/realtime';
import { roomTopic } from '@/lib/topics';
import { useVoiceCall } from '@/lib/voice';
import type { ChatMessage, RoomEvent, RtcSignal } from '@/lib/types';

const ADMIN_TOKEN_KEY = 'kikimiya:father-token';
const ADMIN_PATH_KEY = 'kikimiya:father-path';

/** 待機所は隠し名で開いていることがあるので、来た道を覚えておいたものを使う */
function adminPath(): string {
  if (typeof window === 'undefined') return '/admin';
  return window.localStorage.getItem(ADMIN_PATH_KEY) || '/admin';
}

/** 対話中の文字は、自分の画面にだけ残す。閉じれば消えるタブ単位の置き場を使う。 */
const chatKey = (sessionId: string) => `kikimiya:chat:${sessionId}`;

function loadChat(sessionId: string): ChatMessage[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.sessionStorage.getItem(chatKey(sessionId));
    return raw ? (JSON.parse(raw) as ChatMessage[]) : [];
  } catch {
    return [];
  }
}

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

  const [startedAt, setStartedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [closed, setClosed] = useState<string | null>(null);
  const [emergencyOpen, setEmergencyOpen] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  /** 来訪者は自分のID、神父は合言葉で得たトークンで名乗る */
  const [visitorId] = useState<string | null>(() => (isFather ? null : rememberedVisitorId()));
  const [token] = useState<string | null>(() =>
    isFather && typeof window !== 'undefined'
      ? window.localStorage.getItem(ADMIN_TOKEN_KEY)
      : null,
  );
  /** 神父が「この方を退室させる」ために要る相手のID */
  const [peerVisitorId, setPeerVisitorId] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const leaving = useRef(false);

  /* ------------------------ 声とのつなぎ ------------------------ */

  // 連絡路は下で作るが、声のほうが先に要る。箱を先に置いて、あとから繋ぐ。
  const sendRef = useRef<Channel<RoomEvent>['send'] | null>(null);

  const voiceLink = useMemo(
    () => ({
      send: (signal: RtcSignal) => sendRef.current?.('rtc', signal),
      // 発信側は神父。どちらか一方に決めておかないと offer がぶつかる。
      initiator: isFather,
    }),
    [isFather],
  );

  const voice = useVoiceCall(voiceLink, closed === null);

  /* ------------------------- 告解室の通り道 ------------------------- */

  const link = useLink<RoomEvent>(
    closed || !sessionId ? null : roomTopic(sessionId),
    isFather ? 'father' : 'visitor',
    {
      chat: (message) => setMessages((current) => [...current, message]),
      rtc: (signal) => voice.receive(signal),
      closed: ({ reason }) => setClosed(reason),
    },
  );

  sendRef.current = link.send;

  /* --------------------- この席がまだ有効か確かめる --------------------- */

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;

    const check = async () => {
      try {
        if (isFather) {
          if (!token) {
            setClosed('神父としての認証が切れています。待機ページからやり直してください。');
            return;
          }
          const { state } = await adminFetchState(token);
          if (cancelled) return;
          if (state.active?.sessionId !== sessionId) {
            setClosed('このセッションは既に終了しています。');
            return;
          }
          setPeerVisitorId(state.active.visitorId);
          setStartedAt(state.active.enteredAt ?? Date.now());
        } else {
          const greeting = await visitorHello(visitorId);
          if (cancelled) return;
          if (greeting.state !== 'active' || greeting.sessionId !== sessionId) {
            setClosed('このセッションは既に終了しています。');
            return;
          }
          setStartedAt(greeting.enteredAt ?? Date.now());
        }
        setMessages(loadChat(sessionId));
      } catch {
        if (!cancelled) setClosed('いまつながりません。入口からやり直してください。');
      }
    };

    void check();
    return () => {
      cancelled = true;
    };
  }, [sessionId, isFather, token, visitorId]);

  /* ------------------------- 生きていることを知らせる ------------------------- */

  useVisitorHeartbeat(visitorId, !isFather && closed === null, () => {
    if (leaving.current) return;
    setClosed('通信が途切れたため、対話は終わりました。');
  });

  useFatherHeartbeat(token, isFather && closed === null, {
    onState: (state) => {
      if (leaving.current) return;
      // 相手が去っていれば、待機所側の状態がそれを教えてくれる
      if (state.active?.sessionId !== sessionId) {
        setClosed('来訪者が退室しました。');
      }
    },
  });

  /* --------------------------- 画面の更新 --------------------------- */

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

  // 再読み込みで話の流れを見失わないよう、自分の画面にだけ控えておく
  useEffect(() => {
    if (!sessionId || messages.length === 0) return;
    try {
      window.sessionStorage.setItem(chatKey(sessionId), JSON.stringify(messages.slice(-200)));
    } catch {
      // 保存できない設定でも会話は続けられる
    }
  }, [sessionId, messages]);

  const forgetChat = useCallback(() => {
    try {
      window.sessionStorage.removeItem(chatKey(sessionId));
    } catch {
      // 消せなくても、タブを閉じれば消える
    }
  }, [sessionId]);

  // 対話が終わったら、控えも消す
  useEffect(() => {
    if (closed) forgetChat();
  }, [closed, forgetChat]);

  const elapsed = useMemo(
    () => (startedAt ? formatElapsed(now - startedAt) : '--:--'),
    [startedAt, now],
  );

  /* ----------------------------- 操作 ----------------------------- */

  const send = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      const text = draft.trim();
      if (!text) return;
      const message: ChatMessage = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        from: isFather ? 'father' : 'visitor',
        text: text.slice(0, 2000),
        at: Date.now(),
      };
      // 文字はサーバーを通らず、相手の画面へ直接届く
      link.send('chat', message);
      setMessages((current) => [...current, message]);
      setDraft('');
    },
    [draft, isFather, link],
  );

  const leave = useCallback(async () => {
    leaving.current = true;
    voice.hangUp();
    forgetChat();

    const reason = isFather
      ? '神父が退室しました。お話しくださってありがとうございました。'
      : '来訪者が退室しました。';
    // 相手の画面をすぐ閉じる（サーバー経由の知らせより速い）
    link.send('closed', { reason });

    try {
      if (isFather) {
        if (token && peerVisitorId) await adminKick(token, peerVisitorId, reason);
      } else if (visitorId) {
        await visitorLeave(visitorId);
      }
    } catch {
      // 伝えられなくても、生存信号が途切れれば片づけられる
    }

    router.push(isFather ? adminPath() : '/');
  }, [voice, forgetChat, isFather, link, token, peerVisitorId, visitorId, router]);

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

        <Link href={isFather ? adminPath() : '/'} className="btn btn-quiet w-full">
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

      {!REALTIME_CONFIGURED ? (
        <section className="panel border-l-4 border-l-ember px-6 py-5">
          <p className="text-sm leading-relaxed text-ember">
            リアルタイムの設定がされていないため、この部屋では声も文字もやりとりできません。
          </p>
          <p className="mt-2 text-xs leading-relaxed text-paper-dim">
            NEXT_PUBLIC_SUPABASE_URL と NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY を設定して、
            ビルドし直してください。
          </p>
        </section>
      ) : null}

      {/* 状態と経過時間 */}
      <section className="flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs tracking-[0.3em] text-paper-dim">
            {isFather ? '対応中' : '告解室'}
          </p>
          <PeerIndicator
            connected={link.connected}
            peerPresent={link.peerPresent}
            peerStale={false}
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
              <button type="button" className="btn btn-danger grow" onClick={() => void leave()}>
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
          ブラウザを閉じると、しばらくして自動的に退室になります。
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
