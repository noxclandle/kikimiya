'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Backdrop } from '@/components/Backdrop';
import { PresenceBadge } from '@/components/ConnectionStatus';
import { useHeartbeat, rememberVisitorId, rememberedVisitorId } from '@/lib/heartbeat';
import { useSocket } from '@/lib/socket';
import type { FatherPresence } from '@/lib/types';

type Mode = 'idle' | 'queued' | 'invited';

export default function EntrancePage() {
  const router = useRouter();
  const { socket, connected } = useSocket();
  const [presence, setPresence] = useState<FatherPresence>('offline');
  const [queueLength, setQueueLength] = useState(0);
  const [mode, setMode] = useState<Mode>('idle');
  const [position, setPosition] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);

  useHeartbeat(socket, true);

  useEffect(() => {
    if (!socket) return;

    const hello = () => socket.emit('visitor:hello', { visitorId: rememberedVisitorId() });
    if (socket.connected) hello();
    socket.on('connect', hello);

    socket.on('visitor:identity', ({ visitorId }) => rememberVisitorId(visitorId));
    socket.on('status', (status) => {
      setPresence(status.presence);
      setQueueLength(status.queueLength);
    });
    socket.on('queue:position', ({ position: next }) => {
      setPosition(next);
      setMode((current) => (next > 0 ? 'queued' : current === 'queued' ? 'idle' : current));
    });
    socket.on('room:invite', ({ expiresInSeconds }) => {
      setMode('invited');
      setCountdown(expiresInSeconds);
      setNotice(null);
    });
    socket.on('room:ready', ({ sessionId }) => {
      router.push(`/room/${sessionId}`);
    });
    socket.on('room:denied', ({ reason }) => {
      setMode('idle');
      setPosition(0);
      setNotice(reason);
    });
    socket.on('room:closed', ({ reason }) => {
      setMode('idle');
      setPosition(0);
      setNotice(reason);
    });

    return () => {
      socket.off('connect', hello);
      socket.off('visitor:identity');
      socket.off('status');
      socket.off('queue:position');
      socket.off('room:invite');
      socket.off('room:ready');
      socket.off('room:denied');
      socket.off('room:closed');
    };
  }, [socket, router]);

  // 入室案内の残り時間
  useEffect(() => {
    if (mode !== 'invited' || countdown <= 0) return;
    const timer = setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [mode, countdown]);

  const enter = useCallback(() => {
    setNotice(null);
    socket?.emit('visitor:enter');
  }, [socket]);

  const leaveQueue = useCallback(() => {
    socket?.emit('visitor:leave');
    setMode('idle');
    setPosition(0);
    setNotice('待機列を離れました。またいつでもお越しください。');
  }, [socket]);

  const accept = useCallback(() => {
    socket?.emit('visitor:accept-invite');
  }, [socket]);

  return (
    <div className="mx-auto max-w-3xl space-y-12">
      {/* 神父が不在のときは、聖堂の灯りも落ちる */}
      <Backdrop scene="chapel" dimmed={!connected || presence === 'offline'} />

      <section className="on-backdrop space-y-5 text-center">
        <p className="text-xs tracking-[0.4em] text-paper-dim">ようこそ</p>
        <h1 className="text-2xl leading-relaxed tracking-[0.15em] sm:text-3xl">
          ここは、ただ
          <span className="text-gold">聴</span>
          くだけの部屋です
        </h1>
        <p className="mx-auto max-w-md text-sm leading-loose text-paper">
          名前も、登録も要りません。話したいことを、話したいだけ。
          助言も評価もしません。ひとりぶんの声を、そのままお預かりします。
        </p>
      </section>

      <section className="panel px-6 py-6 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <PresenceBadge presence={presence} connected={connected} />
          {queueLength > 0 ? (
            <span className="text-xs text-paper-dim">お待ちの方 {queueLength} 名</span>
          ) : null}
        </div>

        <div className="my-6 rule" />

        {notice ? (
          <p className="mb-5 border-l-2 border-gold/50 pl-4 text-sm leading-relaxed text-paper-dim">
            {notice}
          </p>
        ) : null}

        {mode === 'invited' ? (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-paper">
              お部屋が空きました。どうぞお入りください。
              <span className="ml-2 tabular-nums text-gold">残り {countdown} 秒</span>
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button type="button" className="btn btn-primary grow" onClick={accept}>
                入室する
              </button>
              <button type="button" className="btn btn-quiet" onClick={leaveQueue}>
                今日はやめておく
              </button>
            </div>
          </div>
        ) : mode === 'queued' ? (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-paper">
              いま {position} 番目にお待ちいただいています。
              順番が来たら、この画面でお知らせします。
            </p>
            <p className="text-xs leading-relaxed text-paper-dim">
              このページを開いたままにしておいてください。閉じると列から外れます。
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button type="button" className="btn btn-quiet" onClick={leaveQueue}>
                列を離れる
              </button>
              <Link href="/message" className="btn btn-quiet">
                文章で預けておく
              </Link>
            </div>
          </div>
        ) : presence === 'available' ? (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-paper-dim">
              いま、部屋は空いています。入るとすぐに、話しはじめられます。
            </p>
            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={enter}
              disabled={!connected}
            >
              入室する
            </button>
          </div>
        ) : presence === 'busy' ? (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-paper">ただいま満室です。</p>
            <p className="text-xs leading-relaxed text-paper-dim">
              先にいらした方の話が終わるまで、少しお待ちいただくことになります。
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                className="btn btn-primary grow"
                onClick={enter}
                disabled={!connected}
              >
                順番待ちに入る
              </button>
              <Link href="/message" className="btn btn-quiet">
                文章で預けて出直す
              </Link>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-paper">
              いま、神父は席を外しています。
            </p>
            <p className="text-xs leading-relaxed text-paper-dim">
              文章でお預かりします。読んだうえで、あとからお返事します。
            </p>
            <Link href="/message" className="btn btn-primary w-full">
              文章で預ける
            </Link>
          </div>
        )}
      </section>

      <section className="space-y-3 pt-4 text-xs leading-loose text-paper-dim/80">
        <div className="rule" />
        <p>
          登録もログインもありません。名前を訊くこともありません。
          話した内容と声は、部屋を出た時点で消えます。
          お布施は任意で、納めても納めなくても話す時間は変わりません。
        </p>
        <p>
          ここはカウンセリングでも医療でもなく、ただ話を聴くだけの場所です。
          <Link href="/terms" className="link mx-1">
            利用規約・免責
          </Link>
          ／
          <Link href="/help" className="link mx-1">
            相談窓口
          </Link>
        </p>
      </section>

    </div>
  );
}
