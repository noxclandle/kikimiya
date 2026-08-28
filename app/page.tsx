'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Backdrop } from '@/components/Backdrop';
import { PresenceBadge, SeatCount } from '@/components/ConnectionStatus';
import { REALTIME_CONFIGURED, STATUS_POLL_MS } from '@/lib/config';
import {
  getStatus,
  visitorAccept,
  visitorEnter,
  visitorHello,
  visitorLeave,
} from '@/lib/api';
import { useChime, useTabAttention } from '@/lib/alerts';
import { useVisitorHeartbeat, rememberVisitorId, rememberedVisitorId } from '@/lib/heartbeat';
import { useBroadcast } from '@/lib/realtime';
import { LOBBY_TOPIC, visitorTopic } from '@/lib/topics';
import type { LobbyEvent, PublicStatus, VisitorEvent } from '@/lib/types';

type Mode = 'idle' | 'queued' | 'invited';

const UNKNOWN: PublicStatus = {
  presence: 'offline',
  queueLength: 0,
  capacity: 1,
  occupied: 0,
};

export default function EntrancePage() {
  const router = useRouter();

  const [visitorId, setVisitorId] = useState<string | null>(null);
  const [status, setStatus] = useState<PublicStatus>(UNKNOWN);
  const [known, setKnown] = useState(false);
  const [mode, setMode] = useState<Mode>('idle');
  const [position, setPosition] = useState(0);
  const [countdown, setCountdown] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** 列に並んだ時刻。「◯分お待ちです」の起点 */
  const [queuedSince, setQueuedSince] = useState<number | null>(null);
  const [waitTick, setWaitTick] = useState(0);

  const leaving = useRef(false);

  /* --------------------- 名乗り（前回の続きに戻る） --------------------- */

  useEffect(() => {
    let cancelled = false;
    void visitorHello(rememberedVisitorId())
      .then((greeting) => {
        if (cancelled) return;
        rememberVisitorId(greeting.visitorId);
        setVisitorId(greeting.visitorId);
        setStatus(greeting.status);
        setKnown(true);
        // 部屋に居るまま再読み込みした人は、そのまま部屋へ戻す
        if (greeting.state === 'active' && greeting.sessionId) {
          router.replace(`/room/${greeting.sessionId}`);
          return;
        }
        if (greeting.state === 'queued' || greeting.state === 'invited') {
          setMode(greeting.state);
          setQueuedSince(greeting.joinedAt ?? Date.now());
        }
      })
      .catch(() => {
        if (!cancelled) setNotice('いまつながりません。少し置いてから開き直してください。');
      });
    return () => {
      cancelled = true;
    };
  }, [router]);

  /* ------------------------- 押し出しで受け取る ------------------------- */

  const lobbyLive = useBroadcast<LobbyEvent>(LOBBY_TOPIC, {
    status: (next) => {
      setStatus(next);
      setKnown(true);
    },
  });

  useBroadcast<VisitorEvent>(visitorId ? visitorTopic(visitorId) : null, {
    queue: ({ position: next, total }) => {
      setPosition(next);
      setMode((current) => (current === 'invited' ? current : next > 0 ? 'queued' : 'idle'));
      if (total > 0) setNotice(null);
    },
    invite: ({ expiresInSeconds }) => {
      setMode('invited');
      setCountdown(expiresInSeconds);
      setNotice(null);
    },
    ready: ({ sessionId }) => router.push(`/room/${sessionId}`),
    denied: ({ reason }) => {
      setMode('idle');
      setPosition(0);
      setNotice(reason);
    },
    closed: ({ reason }) => {
      setMode('idle');
      setPosition(0);
      setNotice(reason);
    },
  });

  /* --------- 押し出しが届かなかったときのために、自分でも尋ねる --------- */

  useEffect(() => {
    const ask = () => {
      void getStatus()
        .then((data) => {
          setStatus(data.status);
          setKnown(true);
        })
        .catch(() => undefined);
    };
    const timer = setInterval(ask, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  /* -------- 列に並んでいるあいだだけ、生きていることを知らせ続ける -------- */

  useVisitorHeartbeat(visitorId, mode !== 'idle', () => {
    // サーバー側では既に消えている（回線が長く途切れたなど）
    if (leaving.current) return;
    setMode('idle');
    setPosition(0);
    setNotice('通信が途切れたため、列から外れました。もう一度お並びください。');
  });

  /* ------------------- 呼ばれたことに気づけるように ------------------- */

  /*
    神父が一人ずつ通す形なので、来訪者は「呼ばれる瞬間」を待つことになる。
    その間ずっと画面を見つめている人はいない。裏のタブに回していても
    気づけるよう、音とタブの見出しで知らせる。
    （「順番に並ぶ」を押した操作があるので、ブラウザは音を鳴らせる）
  */
  const chime = useChime();
  const { start: startChime, stop: stopChime } = chime;

  useEffect(() => {
    if (mode === 'invited') startChime('arrival');
    else stopChime();
  }, [mode, startChime, stopChime]);

  useTabAttention(
    mode === 'invited'
      ? '● お呼びです — 聴き宮'
      : mode === 'queued'
        ? `お待ちいただいています${position > 0 ? `（${position}番目）` : ''} — 聴き宮`
        : null,
  );

  // 待ち時間の表示（分単位でよいので、ゆっくり数える）
  useEffect(() => {
    if (mode !== 'queued') return;
    const timer = setInterval(() => setWaitTick((value) => value + 1), 15000);
    return () => clearInterval(timer);
  }, [mode]);

  const waitedMinutes =
    queuedSince && mode === 'queued' ? Math.floor((Date.now() - queuedSince) / 60000) : 0;

  // 入室案内の残り時間
  useEffect(() => {
    if (mode !== 'invited' || countdown <= 0) return;
    const timer = setInterval(() => setCountdown((value) => Math.max(0, value - 1)), 1000);
    return () => clearInterval(timer);
  }, [mode, countdown]);

  /* ------------------------------ 操作 ------------------------------ */

  const enter = useCallback(async () => {
    if (!visitorId || busy) return;
    setNotice(null);
    setBusy(true);
    try {
      const result = await visitorEnter(visitorId);
      if (result.ok && result.sessionId) {
        router.push(`/room/${result.sessionId}`);
        return;
      }
      // 満室だった。列には既に載っているので、そのまま待ってもらう。
      if (result.reason === 'queued') {
        setMode('queued');
        setQueuedSince((current) => current ?? Date.now());
        setPosition((current) => (current > 0 ? current : 1));
        return;
      }
      setNotice(result.reason ?? 'いま入室できませんでした。');
    } catch {
      setNotice('いまつながりません。少し置いてからお試しください。');
    } finally {
      setBusy(false);
    }
  }, [visitorId, busy, router]);

  const accept = useCallback(async () => {
    if (!visitorId || busy) return;
    setBusy(true);
    try {
      const result = await visitorAccept(visitorId);
      if (result.ok && result.sessionId) router.push(`/room/${result.sessionId}`);
      else {
        setMode('idle');
        setNotice(result.reason ?? 'ご案内の期限が切れています。');
      }
    } catch {
      setNotice('いまつながりません。');
    } finally {
      setBusy(false);
    }
  }, [visitorId, busy, router]);

  const leaveQueue = useCallback(async () => {
    if (!visitorId) return;
    leaving.current = true;
    setMode('idle');
    setPosition(0);
    setQueuedSince(null);
    setNotice('待機列を離れました。またいつでもお越しください。');
    await visitorLeave(visitorId).catch(() => undefined);
    leaving.current = false;
  }, [visitorId]);

  /* ------------------------------ 表示 ------------------------------ */

  const { presence, capacity, occupied } = status;
  const full = occupied >= capacity;
  // 押し出しが使えない設定でも、尋ねに行けていれば「分かっている」扱いにする
  const live = known && (lobbyLive || !REALTIME_CONFIGURED);

  return (
    <div className="mx-auto max-w-3xl space-y-12">
      {/* 神父が不在のときは、聖堂の灯りも落ちる */}
      <Backdrop scene="chapel" dimmed={!live || presence === 'offline'} />

      <section className="on-backdrop space-y-5 text-center">
        <p className="text-xs tracking-[0.4em] text-paper-dim">ようこそ</p>
        <h1 className="text-2xl leading-relaxed tracking-[0.15em] sm:text-3xl">
          誰にも言えないことを、
          <br className="sm:hidden" />
          <span className="text-gold">話</span>
          す部屋です
        </h1>
        <p className="mx-auto max-w-md text-sm leading-loose text-paper">
          名前も、登録も要りません。誰にも打ち明けられなかったことを、
          そのまま口に出してください。神父は黙って聴き、思うところがあれば言葉を返します。
        </p>
      </section>

      <section className="panel px-6 py-6 sm:px-8">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <PresenceBadge presence={presence} connected={live} />
          <SeatCount status={status} known={live} />
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
              神父がお呼びです。どうぞお入りください。
              {countdown > 0 ? (
                <span className="ml-2 tabular-nums text-gold">残り {countdown} 秒</span>
              ) : null}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                className="btn btn-primary grow"
                onClick={() => void accept()}
                disabled={busy}
              >
                入室する
              </button>
              <button type="button" className="btn btn-quiet" onClick={() => void leaveQueue()}>
                今日はやめておく
              </button>
            </div>
          </div>
        ) : mode === 'queued' ? (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-paper" data-tick={waitTick}>
              いま {position > 0 ? `${position} 番目に` : ''}お待ちいただいています
              {waitedMinutes >= 1 ? `（${waitedMinutes}分）` : ''}。
              神父が支度を整えてお呼びします。順番が来たら、この画面でお知らせします。
            </p>

            {waitedMinutes >= 5 ? (
              <p className="border-l-2 border-gold/50 pl-4 text-xs leading-relaxed text-paper-dim">
                長らくお待たせしています。神父が席を外している可能性もあります。
                書いて預けておけば、あとで必ず読まれて返事が届きます。
              </p>
            ) : null}
            <p className="text-xs leading-relaxed text-paper-dim">
              このページを開いたままにしておいてください。閉じると列から外れます。
              <br />
              順番が来ると<span className="text-paper">音が鳴り</span>、
              タブの見出しでもお知らせします。ほかの作業をしていて構いません。
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button type="button" className="btn btn-quiet" onClick={() => void leaveQueue()}>
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
              いま、部屋は空いています（{occupied}/{capacity}）。
              神父がひとりずつお通しするので、まず列にお並びください。
            </p>
            <button
              type="button"
              className="btn btn-primary w-full"
              onClick={() => void enter()}
              disabled={!live || busy || !visitorId}
            >
              {busy ? '並んでいます…' : '順番に並ぶ'}
            </button>
          </div>
        ) : presence === 'busy' ? (
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-paper">
              ただいま満室です（{occupied}/{capacity}）。いまは入室できません。
            </p>
            <p className="text-xs leading-relaxed text-paper-dim">
              先にいらした方の話が終わるまで、少しお待ちいただくことになります。
              {status.queueLength > 0 ? `いま ${status.queueLength} 名がお待ちです。` : ''}
            </p>
            <div className="flex flex-col gap-3 sm:flex-row">
              <button
                type="button"
                className="btn btn-primary grow"
                onClick={() => void enter()}
                disabled={!live || busy || !visitorId}
              >
                {busy ? '並んでいます…' : '順番待ちに入る'}
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
          告解室はひとつだけで、同時に入れるのはお一人です。
          {full ? 'いまは埋まっています。' : ''}
          入室は神父がひとりずつお呼びします（勝手に開くことはありません）。
          登録もログインもありません。名前を訊くこともありません。
          何を話しても咎められません。話した内容と声は、部屋を出た時点で消えます。
          お布施は任意で、納めても納めなくても話す時間は変わりません。
        </p>
        <p>
          神父は資格を持った専門家ではありません。返ってくるのは、ひとりの人間の言葉です。
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
