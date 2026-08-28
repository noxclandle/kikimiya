'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ApiError,
  adminDeleteMessage,
  adminFetchState,
  adminInvite,
  adminKick,
  adminLogin,
  adminMarkRead,
  adminMessages,
  adminPresence,
  adminReply,
  adminUpdateConfig,
} from '@/lib/api';
import {
  useChime,
  useDesktopNotifier,
  useLastActivity,
  useTabAttention,
  useWakeLock,
} from '@/lib/alerts';
import { useFatherHeartbeat } from '@/lib/heartbeat';
import { probeIce, TURN_CONFIGURED, type IceProbe } from '@/lib/voice';
import { useBroadcast } from '@/lib/realtime';
import type {
  AdminEvent,
  AdminState,
  SiteConfig,
  StoredMessage,
  VisitorSummary,
} from '@/lib/types';

const TOKEN_KEY = 'kikimiya:father-token';
const ONLINE_KEY = 'kikimiya:father-online';
const AUTO_AWAY_KEY = 'kikimiya:father-auto-away';
/** 隠し入口の名前。告解室から戻るときに使う（/admin は 404 にしてあるため） */
const PATH_KEY = 'kikimiya:father-path';

/** 待たせたまま反応が無いとき、自動で離席に落とすまでの分数 */
const AUTO_AWAY_CHOICES = [5, 10, 30, 0] as const;

/* --------------------------- 小さな部品 --------------------------- */

function elapsedSince(at: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (seconds < 60) return `${seconds}秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分${seconds % 60}秒`;
  return `${Math.floor(minutes / 60)}時間${minutes % 60}分`;
}

function durationText(seconds: number): string {
  if (seconds <= 0) return '—';
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}分${seconds % 60}秒` : `${seconds}秒`;
}

function VisitorRow({
  visitor,
  onKick,
  actions,
}: {
  visitor: VisitorSummary;
  onKick: (visitorId: string) => void | Promise<void>;
  actions?: React.ReactNode;
}) {
  return (
    <li className="panel flex flex-wrap items-center justify-between gap-3 px-4 py-3">
      <div className="space-y-1">
        <p className="text-sm text-paper">
          {visitor.handle}
          {visitor.stale ? <span className="ml-2 text-xs text-gold">応答なし</span> : null}
        </p>
        <p className="text-xs text-paper-dim">
          {visitor.state === 'active'
            ? `対話 ${elapsedSince(visitor.enteredAt ?? visitor.joinedAt)}`
            : visitor.state === 'invited'
              ? `お呼びしています${
                  visitor.inviteExpiresAt
                    ? ` — 返事待ち 残り ${Math.max(
                        0,
                        Math.ceil((visitor.inviteExpiresAt - Date.now()) / 1000),
                      )}秒`
                    : ''
                }`
              : `お待たせして ${elapsedSince(visitor.joinedAt)}`}
        </p>
      </div>
      <div className="flex gap-2">
        {actions}
        <button
          type="button"
          className="btn btn-danger px-3 py-2 text-xs"
          onClick={() => void onKick(visitor.visitorId)}
        >
          追放
        </button>
      </div>
    </li>
  );
}

/* ------------------------------ 本体 ------------------------------ */

export default function AdminPage() {
  const [token, setToken] = useState<string | null>(null);
  /** 待機所だけに教えられる、リアルタイムの通り道の名前 */
  const [topic, setTopic] = useState<string | null>(null);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  /** 直前のやりとりが届いているか。届かなくなったら「切れている」と見る。 */
  const [connected, setConnected] = useState(true);
  const [signingIn, setSigningIn] = useState(false);
  const [state, setState] = useState<AdminState | null>(null);
  const [messages, setMessages] = useState<StoredMessage[]>([]);
  const [config, setConfig] = useState<SiteConfig | null>(null);
  const [tick, setTick] = useState(0);

  /** 「在室にしておくつもりか」。回線が切れても意思は覚えておき、復帰したら戻す */
  const [intendedOnline, setIntendedOnline] = useState(false);
  const [dropped, setDropped] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [lastArrival, setLastArrival] = useState<{ handle: string; queued: boolean } | null>(null);
  /** いま案内をかけている相手（二度押しを止める） */
  const [inviting, setInviting] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);

  const chime = useChime();
  const { start: startChime, stop: stopChime, unlocked: soundUnlocked, test: testChime } = chime;
  const notifier = useDesktopNotifier();
  const { show: showNotification, clear: clearNotification } = notifier;
  const [soundOn, setSoundOn] = useState(true);
  const [keepAwake, setKeepAwake] = useState(false);
  /** 0 は「自動で離席にしない」 */
  const [autoAwayMinutes, setAutoAwayMinutes] = useState(10);
  const [awayNotice, setAwayNotice] = useState<string | null>(null);
  const lastActivity = useLastActivity();
  const wakeLock = useWakeLock(keepAwake);

  /* ------------------------- 認証 ------------------------- */

  useEffect(() => {
    // いま開いている名前を覚えておく。告解室から戻るときの行き先になる。
    window.localStorage.setItem(PATH_KEY, window.location.pathname);
    const stored = window.localStorage.getItem(TOKEN_KEY);
    if (stored) setToken(stored);
    setIntendedOnline(window.localStorage.getItem(ONLINE_KEY) === '1');
    const away = Number(window.localStorage.getItem(AUTO_AWAY_KEY));
    if (Number.isFinite(away) && away >= 0) setAutoAwayMinutes(away);
  }, []);

  /** 合言葉が通らなくなったら、覚えているものを捨ててログイン画面へ戻す */
  const signOut = useCallback((message?: string) => {
    window.localStorage.removeItem(TOKEN_KEY);
    setToken(null);
    setTopic(null);
    setState(null);
    if (message) setAuthError(message);
  }, []);

  // 覚えているトークンで、そのまま待機所に戻れるか確かめる
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    void adminFetchState(token)
      .then((data) => {
        if (cancelled) return;
        setState(data.state);
        setTopic(data.topic);
        setConnected(true);
      })
      .catch((cause) => {
        if (cancelled) return;
        if (cause instanceof ApiError && cause.status === 401) {
          signOut('合言葉を入れ直してください。');
        } else {
          setConnected(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token, signOut]);

  /*
    在室していることを、一定の間隔で知らせ続ける。
    これが45秒途切れると、入口からは「不在」に見える。
    返ってくる状態には来訪者と待機列も入っているので、
    押し出しの知らせが届かなかったときの取りこぼしもここで拾える。
  */
  useFatherHeartbeat(token, Boolean(token), {
    onState: (next) => {
      setState(next);
      setConnected(true);
    },
    onToken: (fresh) => {
      // 何時間も開けっぱなしでも、合言葉を入れ直さずに済むようにする
      window.localStorage.setItem(TOKEN_KEY, fresh);
      setToken(fresh);
    },
    onError: (cause) => {
      if (cause instanceof ApiError && cause.status === 401) {
        signOut('合言葉を入れ直してください。');
        return;
      }
      setConnected(false);
    },
  });

  // 回線やサーバーが復帰したら、在室のつもりなら自動で戻す
  useEffect(() => {
    if (!token || !intendedOnline || !connected) return;
    if (state?.presence !== 'offline') return;
    void adminPresence(token, true)
      .then((data) => setState(data.state))
      .catch(() => undefined);
  }, [token, intendedOnline, connected, state]);

  // 在室のつもりなのに接続が切れている状態を検知する（短い瞬断では鳴らさない）
  useEffect(() => {
    if (!token || !intendedOnline || connected) {
      setDropped(false);
      return;
    }
    const timer = setTimeout(() => setDropped(true), 8000);
    return () => clearTimeout(timer);
  }, [connected, token, intendedOnline]);

  const login = useCallback(
    async (event: React.FormEvent) => {
      event.preventDefault();
      setAuthError(null);
      setSigningIn(true);
      try {
        const data = await adminLogin(password);
        window.localStorage.setItem(TOKEN_KEY, data.token);
        setToken(data.token);
        setTopic(data.topic);
        setState(data.state);
        setConfig(data.config);
        setConnected(true);
        setPassword('');
        // 席を外していないつもりなら、そのまま在室に戻す
        if (window.localStorage.getItem(ONLINE_KEY) === '1') {
          const next = await adminPresence(data.token, true);
          setState(next.state);
        }
      } catch (cause) {
        setAuthError(cause instanceof Error ? cause.message : '認証できませんでした。');
      } finally {
        setSigningIn(false);
      }
    },
    [password],
  );

  /* ------------------------- 状態の購読 ------------------------- */

  useBroadcast<AdminEvent>(token ? topic : null, {
    state: (next) => {
      setState(next);
      setConnected(true);
    },
    arrived: ({ handle, queued }) => {
      setLastArrival({ handle, queued });
      setAcknowledged(false);
      showNotification(
        '聴き宮に来訪者があります',
        queued ? `${handle} が待機列に入りました` : `${handle} が入室しました`,
      );
    },
  });

  useEffect(() => {
    if (!token) return;
    const timer = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [token]);

  /* ------------------------- 来訪の知らせ ------------------------- */

  const waitingCount = (state?.active ? 1 : 0) + (state?.queue.length ?? 0);
  const previousWaiting = useRef(0);

  const hadActive = useRef(false);

  useEffect(() => {
    // 対話が終わって席が空いたのに、まだ待っている人がいる → 呼ぶ番だと知らせ直す
    const active = Boolean(state?.active);
    if (hadActive.current && !active && (state?.queue.length ?? 0) > 0) setAcknowledged(false);
    hadActive.current = active;
  }, [state]);

  useEffect(() => {
    // 新しく人が増えたら、また知らせ直す
    if (waitingCount > previousWaiting.current) setAcknowledged(false);
    if (waitingCount === 0) {
      setAcknowledged(false);
      setLastArrival(null);
      clearNotification();
    }
    previousWaiting.current = waitingCount;
  }, [waitingCount, clearNotification]);

  const needsAttention = waitingCount > 0 && !acknowledged;


  // 鳴らし続ける。相手が去るか、確認するまで止まらない。
  useEffect(() => {
    if (!token || !soundOn) {
      stopChime();
      return;
    }
    if (dropped) {
      startChime('warning');
      return;
    }
    if (needsAttention) {
      startChime('arrival');
      return;
    }
    stopChime();
  }, [token, soundOn, dropped, needsAttention, startChime, stopChime]);

  useTabAttention(
    !token
      ? null
      : dropped
        ? '⚠ 接続が切れています — 聴き宮'
        : needsAttention
          ? `● 来訪者があります（${waitingCount}） — 聴き宮`
          : null,
  );

  const acknowledge = useCallback(() => {
    setAcknowledged(true);
    clearNotification();
  }, [clearNotification]);

  /* ------------------------- 文章メッセージ ------------------------- */

  const reloadMessages = useCallback(async () => {
    if (!token) return;
    try {
      const data = await adminMessages(token);
      setMessages(data.messages);
      setConfig(data.config);
    } catch {
      // 認証切れなどはソケット側の admin:auth で処理される
    }
  }, [token]);

  useEffect(() => {
    void reloadMessages();
  }, [reloadMessages, state?.stats.unreadMessages]);

  /* ------------------------- 操作 ------------------------- */

  const togglePresence = useCallback(
    async (online: boolean) => {
      if (!token) return;
      setIntendedOnline(online);
      if (online) setAwayNotice(null);
      window.localStorage.setItem(ONLINE_KEY, online ? '1' : '0');
      try {
        const data = await adminPresence(token, online);
        setState(data.state);
        setConnected(true);
      } catch {
        setConnected(false);
      }
    },
    [token],
  );

  /*
    待たせているのに、まったく触られていない。
    「席にいるつもりで、実はいない」状態がいちばん来訪者に酷なので、
    正直に離席へ落として、待っている人には「席を外しました」と伝える。
    待っている人がいないあいだは、何時間放っておいても落とさない。
  */
  useEffect(() => {
    if (!token || !intendedOnline || autoAwayMinutes <= 0) return;
    if (waitingCount === 0) return;
    const idleFor = Date.now() - lastActivity.current;
    if (idleFor < autoAwayMinutes * 60_000) return;

    setAwayNotice(
      `${autoAwayMinutes}分のあいだ操作がなかったため、自動で離席にしました。` +
        'お待ちだった方には、席を外した旨をお伝えしています。',
    );
    void togglePresence(false);
    // tick に乗せて毎秒見る。判定に使う値は ref なので、依存には出さない。
  }, [tick, token, intendedOnline, autoAwayMinutes, waitingCount, lastActivity, togglePresence]);

  /** 待っている人を、告解室へ呼ぶ */
  const invite = useCallback(
    async (visitorId: string) => {
      if (!token) return;
      setInviteError(null);
      setInviting(visitorId);
      try {
        const data = await adminInvite(token, visitorId);
        setState(data.state);
        setConnected(true);
        if (!data.ok) setInviteError(data.reason ?? 'お呼びできませんでした。');
        else acknowledge();
      } catch (cause) {
        setInviteError(cause instanceof Error ? cause.message : 'お呼びできませんでした。');
      } finally {
        setInviting(null);
      }
    },
    [token, acknowledge],
  );

  const kick = useCallback(
    async (visitorId: string) => {
      if (!token) return;
      if (!window.confirm('この方を退室させます。よろしいですか。')) return;
      try {
        const data = await adminKick(token, visitorId, '神父により退室となりました。');
        setState(data.state);
      } catch {
        setConnected(false);
      }
    },
    [token],
  );

  /* ------------------------- ログイン画面 ------------------------- */

  if (!token) {
    return (
      <div className="mx-auto max-w-sm space-y-8">
        <section className="space-y-3 text-center">
          <p className="text-xs tracking-[0.35em] text-paper-dim">神父用</p>
          <h1 className="text-xl tracking-[0.2em]">待機所</h1>
        </section>
        <form onSubmit={(event) => void login(event)} className="panel space-y-4 px-6 py-6">
          <label htmlFor="password" className="label">
            合言葉
          </label>
          <input
            id="password"
            type="password"
            className="field"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
          />
          {authError ? <p className="text-xs text-ember">{authError}</p> : null}
          <button
            type="submit"
            className="btn btn-primary w-full"
            disabled={signingIn || !password}
          >
            {signingIn ? '確かめています…' : '入る'}
          </button>
          <p className="text-[0.7rem] leading-relaxed text-paper-dim/80">
            合言葉はサーバーの環境変数 ADMIN_PASSWORD で設定します。
          </p>
        </form>
      </div>
    );
  }

  /* ------------------------- 待機ページ ------------------------- */

  const online = intendedOnline && state?.presence !== 'offline';
  const activeSessionId = state?.active?.sessionId ?? null;
  /** 次に呼べる人。対応中でも案内中でもなければ、この人を通せる */
  const nextToCall =
    state && !state.active && !state.queue.some((visitor) => visitor.state === 'invited')
      ? (state.queue.find((visitor) => visitor.state === 'queued') ?? null)
      : null;

  const presenceView = dropped
    ? {
        label: '接続が切れています',
        note: '来訪者からは「不在」に見えています。回線をご確認ください。',
        dot: 'bg-ember',
        edge: 'border-l-ember',
      }
    : !online
      ? {
          label: '不在',
          note: '入口は「文章で預ける」案内になっています。',
          dot: 'bg-paper-dim/50',
          edge: 'border-l-paper-dim/30',
        }
      : state?.presence === 'busy'
        ? {
            label: '対応中',
            note: '先客がいます。次の方は待機列に入ります。',
            dot: 'bg-gold',
            edge: 'border-l-gold',
          }
        : {
            label: '在室中',
            note: 'いつでも入ってこられます。',
            dot: 'bg-moss',
            edge: 'border-l-moss',
          };

  return (
    <div className="space-y-8" data-tick={tick}>
      {/* 離れていても目に入るように、知らせは一番上に大きく置く */}
      {dropped ? (
        <section className="panel alarm border-2 px-6 py-6">
          <p className="text-xl tracking-[0.2em] text-ember">接続が切れています</p>
          <p className="mt-2 text-sm leading-relaxed text-paper">
            いま来訪者からは「不在」に見えています。回線が戻れば自動的に在室へ戻します。
          </p>
        </section>
      ) : needsAttention ? (
        <section className="panel summon border-2 px-6 py-6">
          <p className="text-2xl tracking-[0.2em] text-gold">来訪者があります</p>
          <p className="mt-2 text-sm leading-relaxed text-paper">
            {lastArrival
              ? `${lastArrival.handle} が${lastArrival.queued ? '待機列に入りました' : '入室しました'}。`
              : `${waitingCount} 名がお待ちです。`}
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            {activeSessionId ? (
              <Link
                href={`/room/${activeSessionId}?role=father`}
                className="btn btn-primary"
                onClick={acknowledge}
              >
                告解室へ入る
              </Link>
            ) : nextToCall ? (
              <button
                type="button"
                className="btn btn-primary"
                disabled={inviting !== null}
                onClick={() => void invite(nextToCall.visitorId)}
              >
                {inviting ? 'お呼びしています…' : `${nextToCall.handle} を入室させる`}
              </button>
            ) : null}
            <button type="button" className="btn btn-quiet" onClick={acknowledge}>
              確認した（音を止める）
            </button>
          </div>
        </section>
      ) : null}

      {awayNotice ? (
        <section className="panel border-l-4 border-l-gold px-6 py-5">
          <p className="text-sm leading-relaxed text-paper">{awayNotice}</p>
          <button
            type="button"
            className="btn btn-primary mt-4"
            onClick={() => void togglePresence(true)}
          >
            戻りました（在室に戻す）
          </button>
        </section>
      ) : null}

      {/* 在室の状態。ひと目で分かるよう大きく */}
      <section className={`panel flex flex-wrap items-center justify-between gap-5 border-l-4 px-6 py-6 ${presenceView.edge}`}>
        <div className="flex items-center gap-4">
          <span
            className={`h-3.5 w-3.5 shrink-0 rounded-full ${presenceView.dot} ${online && !dropped ? 'breathe' : ''}`}
          />
          <div>
            <p className="text-2xl tracking-[0.2em] text-paper">{presenceView.label}</p>
            <p className="mt-1 text-xs leading-relaxed text-paper-dim">{presenceView.note}</p>
          </div>
        </div>
        <button
          type="button"
          className={online ? 'btn btn-quiet' : 'btn btn-primary'}
          onClick={() => void togglePresence(!intendedOnline)}
          disabled={!token}
        >
          {intendedOnline ? 'オフラインにする' : 'オンラインにする'}
        </button>
      </section>

      {/* 離席中の知らせ方 */}
      <section className="space-y-3">
        <h2 className="text-xs tracking-[0.3em] text-paper-dim">離席中の知らせ方</h2>
        <div className="panel space-y-4 px-6 py-5">
          <AlertSetting
            title="音で知らせる"
            note={
              !soundOn
                ? '止めています'
                : soundUnlocked
                  ? '来訪がある間、確認するまで鳴り続けます'
                  : 'ブラウザが音を止めています。一度鳴らして許可してください'
            }
            ok={soundOn && soundUnlocked}
            action={
              <div className="flex gap-2">
                <button
                  type="button"
                  className="btn btn-quiet px-3 py-2 text-xs"
                  onClick={() => void testChime('arrival')}
                >
                  鳴らしてみる
                </button>
                <button
                  type="button"
                  className="btn btn-quiet px-3 py-2 text-xs"
                  onClick={() => setSoundOn((value) => !value)}
                >
                  {soundOn ? '音を止める' : '音を出す'}
                </button>
              </div>
            }
          />

          {soundOn ? (
            <div className="flex items-center gap-4 pl-6">
              <span className="text-xs text-paper-dim">音量</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.05}
                value={chime.volume}
                onChange={(event) => chime.setVolume(Number(event.target.value))}
                className="max-w-56 grow"
                aria-label="鐘の音量"
              />
              <span className="text-xs tabular-nums text-paper-dim">
                {Math.round(chime.volume * 100)}
              </span>
            </div>
          ) : null}

          <div className="rule" />

          <AlertSetting
            title="デスクトップ通知"
            note={
              notifier.permission === 'granted'
                ? '別のアプリを見ていても、画面に出ます'
                : notifier.permission === 'denied'
                  ? 'ブラウザで拒否されています。サイトの設定から許可してください'
                  : notifier.permission === 'unsupported'
                    ? 'このブラウザでは使えません'
                    : 'まだ許可されていません'
            }
            ok={notifier.permission === 'granted'}
            action={
              notifier.permission === 'default' ? (
                <button
                  type="button"
                  className="btn btn-quiet px-3 py-2 text-xs"
                  onClick={() => void notifier.request()}
                >
                  許可する
                </button>
              ) : null
            }
          />

          <div className="rule" />

          <AlertSetting
            title="待たせたままなら自動で離席"
            note={
              autoAwayMinutes > 0
                ? `お待ちの方がいるのに${autoAwayMinutes}分ふれなければ、離席にして事情をお伝えします`
                : '落としません。席を外したまま待たせ続けることがあります'
            }
            ok={autoAwayMinutes > 0}
            action={
              <select
                className="field w-auto py-2 text-xs"
                value={autoAwayMinutes}
                onChange={(event) => {
                  const value = Number(event.target.value);
                  setAutoAwayMinutes(value);
                  window.localStorage.setItem(AUTO_AWAY_KEY, String(value));
                }}
                aria-label="自動で離席にするまでの時間"
              >
                {AUTO_AWAY_CHOICES.map((minutes) => (
                  <option key={minutes} value={minutes}>
                    {minutes === 0 ? 'しない' : `${minutes}分`}
                  </option>
                ))}
              </select>
            }
          />

          <div className="rule" />

          <AlertSetting
            title="画面を消さない"
            note={
              !wakeLock.supported
                ? 'このブラウザでは使えません'
                : keepAwake
                  ? wakeLock.active
                    ? 'このタブを開いている間、画面は消えません'
                    : '取得を待っています'
                  : '放置しているとスリープで気づけないことがあります'
            }
            ok={keepAwake && wakeLock.active}
            action={
              wakeLock.supported ? (
                <button
                  type="button"
                  className="btn btn-quiet px-3 py-2 text-xs"
                  onClick={() => setKeepAwake((value) => !value)}
                >
                  {keepAwake ? 'やめる' : '消さない'}
                </button>
              ) : null
            }
          />
        </div>
      </section>

      {/* 対応中 */}
      <section className="space-y-3">
        <h2 className="text-xs tracking-[0.3em] text-paper-dim">対応中</h2>
        {state?.active ? (
          <ul className="space-y-2">
            <VisitorRow
              visitor={state.active}
              onKick={kick}
              actions={
                activeSessionId ? (
                  <Link
                    href={`/room/${activeSessionId}?role=father`}
                    className="btn btn-primary px-3 py-2 text-xs"
                    onClick={acknowledge}
                  >
                    告解室へ入る
                  </Link>
                ) : null
              }
            />
          </ul>
        ) : (
          <p className="panel px-4 py-4 text-sm text-paper-dim">いまは誰もいません。</p>
        )}
      </section>

      {/* 待機列 — 通す順番は神父が決める */}
      <section className="space-y-3">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-xs tracking-[0.3em] text-paper-dim">
            待機列（{state?.queue.length ?? 0} 名）
          </h2>
          <p className="text-[0.7rem] text-paper-dim/70">
            自動では誰も入りません。上から順に、呼べるときに呼んでください。
          </p>
        </div>

        {inviteError ? (
          <p className="panel border-l-4 border-l-ember px-4 py-3 text-sm text-ember">
            {inviteError}
          </p>
        ) : null}

        {state && state.queue.length > 0 ? (
          <ul className="space-y-2">
            {state.queue.map((visitor) => (
              <VisitorRow
                key={visitor.visitorId}
                visitor={visitor}
                onKick={kick}
                actions={
                  visitor.state === 'queued' ? (
                    <button
                      type="button"
                      className="btn btn-primary px-3 py-2 text-xs"
                      disabled={inviting !== null || Boolean(state.active) || !online}
                      onClick={() => void invite(visitor.visitorId)}
                    >
                      {inviting === visitor.visitorId ? 'お呼び中…' : '入室させる'}
                    </button>
                  ) : null
                }
              />
            ))}
          </ul>
        ) : (
          <p className="panel px-4 py-4 text-sm text-paper-dim">お待ちの方はいません。</p>
        )}
      </section>

      {/* 統計 */}
      <section className="space-y-3">
        <h2 className="text-xs tracking-[0.3em] text-paper-dim">今日（{state?.stats.date ?? '—'}）</h2>
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {[
            { label: '対応件数', value: `${state?.stats.sessionsToday ?? 0} 件` },
            { label: '平均対話時間', value: durationText(state?.stats.averageDurationToday ?? 0) },
            { label: '合計対話時間', value: durationText(state?.stats.totalDurationToday ?? 0) },
            { label: '未読の手紙', value: `${state?.stats.unreadMessages ?? 0} 通` },
          ].map((item) => (
            <div key={item.label} className="panel px-4 py-4">
              <dt className="text-[0.65rem] tracking-[0.15em] text-paper-dim">{item.label}</dt>
              <dd className="mt-2 text-lg tabular-nums text-gold">{item.value}</dd>
            </div>
          ))}
        </dl>
        <p className="text-[0.7rem] text-paper-dim/70">
          集計は件数と時間だけです。対話の内容は残していません。
        </p>
      </section>

      <div className="rule" />

      {/* 声の通り道 */}
      <VoicePath />

      {/* 手紙受け */}
      <Mailbox token={token} messages={messages} onChanged={reloadMessages} />

      {/* 設定 */}
      {config ? <ConfigPanel token={token} config={config} onSaved={setConfig} /> : null}

      <button
        type="button"
        className="btn btn-quiet w-full"
        onClick={() => signOut()}
      >
        ログアウト
      </button>
    </div>
  );
}

/* ------------------------- 知らせ方の一行 ------------------------- */

function AlertSetting({
  title,
  note,
  ok,
  action,
}: {
  title: string;
  note: string;
  ok: boolean;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-start gap-3">
        <span
          className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${ok ? 'bg-moss' : 'bg-paper-dim/40'}`}
        />
        <div>
          <p className="text-sm text-paper">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-paper-dim">{note}</p>
        </div>
      </div>
      {action}
    </div>
  );
}

/* -------------------------- 声の通り道 -------------------------- */

/**
 * 音声が繋がる見込みを、実際に繋ぐ前に確かめる。
 *
 * STUN だけだと、携帯回線や職場のネットワークから来た相手とは
 * 音声が繋がらないことがある。しかもそれは**本番で相手を待たせている最中**に
 * 分かる。ここでいつでも試せるようにしておく。
 */
function VoicePath() {
  const [probe, setProbe] = useState<IceProbe | null>(null);
  const [busy, setBusy] = useState(false);

  const verdict = !probe
    ? null
    : probe.error
      ? { ok: false, text: `確かめられませんでした（${probe.error}）` }
      : probe.relay
        ? { ok: true, text: '中継（TURN）が使えています。相手の回線を選ばず繋がります。' }
        : probe.srflx
          ? {
              ok: false,
              text: probe.turnConfigured
                ? '中継の設定はありますが、応答がありません。URL・利用者名・合言葉をご確認ください。'
                : 'STUN のみで通っています。携帯回線や職場からの相手とは、音声が繋がらないことがあります。',
            }
          : { ok: false, text: '外に出られていません。回線かファイアウォールをご確認ください。' };

  return (
    <section className="space-y-3">
      <h2 className="text-xs tracking-[0.3em] text-paper-dim">声の通り道</h2>
      <div className="panel space-y-4 px-6 py-5">
        <AlertSetting
          title="中継（TURN）"
          note={
            TURN_CONFIGURED
              ? '設定されています。念のため、ときどき確かめてください'
              : '未設定です。STUN だけでは繋がらない相手がいます'
          }
          ok={TURN_CONFIGURED}
          action={
            <button
              type="button"
              className="btn btn-quiet px-3 py-2 text-xs"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                setProbe(null);
                try {
                  setProbe(await probeIce());
                } finally {
                  setBusy(false);
                }
              }}
            >
              {busy ? '確かめています…' : '確かめる'}
            </button>
          }
        />

        {verdict ? (
          <div className="space-y-2 pl-6">
            <p className={`text-sm leading-relaxed ${verdict.ok ? 'text-moss' : 'text-gold'}`}>
              {verdict.text}
            </p>
            <p className="text-[0.7rem] text-paper-dim/70">
              自分の端末 {probe?.host ? '○' : '×'} ／ 外から見た自分{' '}
              {probe?.srflx ? '○' : '×'} ／ 中継 {probe?.relay ? '○' : '×'}
            </p>
          </div>
        ) : null}
      </div>
    </section>
  );
}

/* ---------------------------- 手紙受け ---------------------------- */

function shortDate(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return sameDay
    ? date.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
}

function senderName(message: StoredMessage): string {
  return message.sender?.name?.trim() || '名乗りなし';
}

/** 差出人が任意で書いてくれたことをまとめて出す */
function senderNote(message: StoredMessage): string | null {
  const parts = [message.sender?.ageBand, message.sender?.gender].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * 預かった手紙をメールボックスのように読む。
 * 左に一覧、右に中身。狭い画面では一覧と中身を入れ替えて出す。
 */
function Mailbox({
  token,
  messages,
  onChanged,
}: {
  token: string;
  messages: StoredMessage[];
  onChanged: () => void | Promise<void>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | 'unread'>('all');

  const unread = messages.filter((message) => message.readAt === null).length;
  const shown = useMemo(
    () => (filter === 'unread' ? messages.filter((m) => m.readAt === null) : messages),
    [messages, filter],
  );
  const selected = messages.find((message) => message.id === selectedId) ?? null;

  // 開いたら既読にする
  const open = useCallback(
    async (message: StoredMessage) => {
      setSelectedId(message.id);
      if (message.readAt === null) {
        await adminMarkRead(token, message.id, true).catch(() => undefined);
        await onChanged();
      }
    },
    [token, onChanged],
  );

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xs tracking-[0.3em] text-paper-dim">
          手紙受け（未読 {unread} / 全 {messages.length}）
        </h2>
        <div className="flex gap-2">
          {(['all', 'unread'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setFilter(value)}
              className={`rounded-sm border px-3 py-1.5 text-xs transition-colors ${
                filter === value
                  ? 'border-gold/60 bg-gold/10 text-gold'
                  : 'border-white/12 text-paper-dim hover:border-white/30 hover:text-paper'
              }`}
            >
              {value === 'all' ? 'すべて' : `未読${unread > 0 ? ` ${unread}` : ''}`}
            </button>
          ))}
        </div>
      </div>

      {messages.length === 0 ? (
        <p className="panel px-4 py-6 text-sm text-paper-dim">まだ届いていません。</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-[minmax(0,17rem)_minmax(0,1fr)]">
          {/* 一覧 */}
          <ul
            className={`panel max-h-[32rem] divide-y divide-white/6 overflow-y-auto ${
              selected ? 'hidden sm:block' : 'block'
            }`}
          >
            {shown.length === 0 ? (
              <li className="px-4 py-6 text-sm text-paper-dim">未読はありません。</li>
            ) : (
              shown.map((message) => {
                const isUnread = message.readAt === null;
                const isSelected = message.id === selectedId;
                return (
                  <li key={message.id}>
                    <button
                      type="button"
                      onClick={() => void open(message)}
                      className={`w-full px-4 py-3 text-left transition-colors ${
                        isSelected ? 'bg-gold/10' : 'hover:bg-white/4'
                      }`}
                    >
                      <div className="flex items-baseline justify-between gap-2">
                        <span
                          className={`flex min-w-0 items-center gap-2 text-sm ${
                            isUnread ? 'text-paper' : 'text-paper-dim'
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                              isUnread ? 'bg-gold' : 'bg-transparent'
                            }`}
                          />
                          <span className="truncate">{senderName(message)}</span>
                        </span>
                        <span className="shrink-0 text-[0.65rem] tabular-nums text-paper-dim/70">
                          {shortDate(message.createdAt)}
                        </span>
                      </div>
                      <p className="mt-1 truncate pl-3.5 text-xs text-paper-dim/80">
                        {message.body.replace(/\s+/g, ' ')}
                      </p>
                      {message.replies.length > 0 ? (
                        <p className="mt-1 pl-3.5 text-[0.65rem] text-moss">
                          返信済み {message.replies.length}
                        </p>
                      ) : null}
                    </button>
                  </li>
                );
              })
            )}
          </ul>

          {/* 中身 */}
          <div className={selected ? 'block' : 'hidden sm:block'}>
            {selected ? (
              <Letter
                key={selected.id}
                token={token}
                message={selected}
                onChanged={onChanged}
                onClose={() => setSelectedId(null)}
              />
            ) : (
              <p className="panel flex h-full items-center justify-center px-6 py-12 text-sm text-paper-dim">
                左から手紙を選んでください。
              </p>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/* ---------------------------- 一通の手紙 ---------------------------- */

function Letter({
  token,
  message,
  onChanged,
  onClose,
}: {
  token: string;
  message: StoredMessage;
  onChanged: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submitReply = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError(null);
    try {
      await adminReply(token, message.id, body);
      setDraft('');
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '返信できませんでした。');
    } finally {
      setBusy(false);
    }
  };

  const note = senderNote(message);

  return (
    <article className="panel space-y-5 px-6 py-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-lg text-paper">{senderName(message)}</p>
          <p className="mt-1 text-xs text-paper-dim">
            {new Date(message.createdAt).toLocaleString('ja-JP')}
            {note ? ` · ${note}` : ''}
          </p>
          {message.sender?.email ? (
            <a href={`mailto:${message.sender.email}`} className="link mt-1 inline-block text-xs">
              {message.sender.email}
            </a>
          ) : null}
        </div>
        <button type="button" className="btn btn-quiet px-3 py-1.5 text-xs sm:hidden" onClick={onClose}>
          一覧へ
        </button>
      </div>

      <div className="rule" />

      <p className="whitespace-pre-wrap break-words text-sm leading-loose text-paper">
        {message.body}
      </p>

      {message.replies.length > 0 ? (
        <ul className="space-y-3 border-l-2 border-gold/40 pl-4">
          {message.replies.map((reply) => (
            <li key={reply.at}>
              <p className="whitespace-pre-wrap break-words text-sm leading-loose text-paper-dim">
                {reply.body}
              </p>
              <p className="mt-1 text-[0.65rem] text-paper-dim/60">
                {new Date(reply.at).toLocaleString('ja-JP')}
              </p>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="rule" />

      <div className="space-y-3">
        <label htmlFor={`reply-${message.id}`} className="label">
          返事を書く
        </label>
        <textarea
          id={`reply-${message.id}`}
          className="field min-h-32 resize-y leading-loose"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="読みました、と伝えるだけでも構いません。"
        />
        {error ? <p className="text-xs text-ember">{error}</p> : null}
        <button
          type="button"
          className="btn btn-primary w-full"
          disabled={busy || !draft.trim()}
          onClick={() => void submitReply()}
        >
          {busy ? '送っています…' : '返事を書き足す'}
        </button>
        <p className="text-[0.7rem] leading-relaxed text-paper-dim/70">
          返事は、来訪者が控えたURLのページに追記されます。
          {message.sender?.email
            ? ' メールでの連絡をご希望の場合は、上のアドレスからどうぞ。'
            : ''}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          className="btn btn-quiet px-3 py-2 text-xs"
          onClick={async () => {
            await adminMarkRead(token, message.id, message.readAt === null);
            await onChanged();
          }}
        >
          {message.readAt === null ? '既読にする' : '未読に戻す'}
        </button>
        <button
          type="button"
          className="btn btn-danger px-3 py-2 text-xs"
          onClick={async () => {
            if (!window.confirm('この手紙と返事を完全に削除します。よろしいですか。')) return;
            await adminDeleteMessage(token, message.id);
            onClose();
            await onChanged();
          }}
        >
          削除
        </button>
      </div>
    </article>
  );
}

/* ------------------------------ 設定 ------------------------------ */

function ConfigPanel({
  token,
  config,
  onSaved,
}: {
  token: string;
  config: SiteConfig;
  onSaved: (config: SiteConfig) => void;
}) {
  const [replyEtaDays, setReplyEtaDays] = useState(config.replyEtaDays);
  const [inviteTimeoutSeconds, setInviteTimeoutSeconds] = useState(config.inviteTimeoutSeconds);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);

  return (
    <section className="space-y-3">
      <h2 className="text-xs tracking-[0.3em] text-paper-dim">設定</h2>
      <div className="panel grid gap-4 px-6 py-5 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="eta" className="label">
            返信の目安（日）
          </label>
          <input
            id="eta"
            type="number"
            min={1}
            max={60}
            className="field"
            value={replyEtaDays}
            onChange={(event) => setReplyEtaDays(Number(event.target.value))}
          />
        </div>
        <div className="space-y-2">
          <label htmlFor="invite" className="label">
            入室案内の待ち時間（秒）
          </label>
          <input
            id="invite"
            type="number"
            min={10}
            max={600}
            className="field"
            value={inviteTimeoutSeconds}
            onChange={(event) => setInviteTimeoutSeconds(Number(event.target.value))}
          />
        </div>
        <div className="sm:col-span-2">
          <button
            type="button"
            className="btn btn-primary w-full"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                const data = await adminUpdateConfig(token, { replyEtaDays, inviteTimeoutSeconds });
                onSaved(data.config);
                setSaved(true);
                setTimeout(() => setSaved(false), 2500);
              } finally {
                setBusy(false);
              }
            }}
          >
            {saved ? '保存しました' : '保存する'}
          </button>
        </div>
      </div>
    </section>
  );
}
