'use client';

/**
 * 神父が画面を離れていても来訪に気づけるようにするための仕掛け。
 *  - 鐘の音（来訪がある間ずっと鳴らし続ける）
 *  - デスクトップ通知
 *  - タブのタイトルとファビコン
 *  - 画面を消さない（Wake Lock）
 *
 * 音は setInterval ではなく <audio loop> で鳴らす。
 * バックグラウンドのタブではタイマーが間引かれるが、音声の再生は間引かれないため。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/* ------------------------------ 鐘の音 ------------------------------ */

function writeString(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
}

/**
 * 鐘の音を合成して WAV にする。音声ファイルを持たずに済ませるため。
 * 全体の長さぶんループさせるので、`duration` がそのまま鳴る間隔になる。
 */
function renderBellWav(base: number, strikes: number[], duration: number): Blob {
  const sampleRate = 22050;
  const frames = Math.floor(sampleRate * duration);
  const samples = new Float32Array(frames);
  const partials = [1, 2.02, 2.78, 4.16];
  const weights = [1, 0.55, 0.32, 0.16];

  for (const strike of strikes) {
    const start = Math.floor(strike * sampleRate);
    for (let i = start; i < frames; i += 1) {
      const t = (i - start) / sampleRate;
      if (t > 2.4) break;
      let value = 0;
      for (let p = 0; p < partials.length; p += 1) {
        value +=
          weights[p] *
          Math.sin(2 * Math.PI * base * partials[p] * t) *
          Math.exp(-t * (2.2 + p * 1.4));
      }
      // 立ち上がりでの「プツッ」を避ける
      samples[i] += value * Math.min(1, t / 0.004) * 0.3;
    }
  }

  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  writeString(view, 8, 'WAVE');
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // モノラル
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeString(view, 36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, clamped * 32767, true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

export type ChimeKind = 'arrival' | 'warning';

export interface Chime {
  /** ブラウザが再生を許可している状態か */
  unlocked: boolean;
  volume: number;
  setVolume: (value: number) => void;
  /** 鳴らし続ける。すでに同じ音が鳴っていれば何もしない */
  start: (kind: ChimeKind) => void;
  stop: () => void;
  /** 一度だけ鳴らす（動作確認用）。ユーザー操作の中から呼ぶこと */
  test: (kind?: ChimeKind) => Promise<void>;
}

export function useChime(): Chime {
  const arrivalRef = useRef<HTMLAudioElement | null>(null);
  const warningRef = useRef<HTMLAudioElement | null>(null);
  const playingRef = useRef<ChimeKind | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [volume, setVolumeState] = useState(0.7);

  useEffect(() => {
    // 来訪は高く二度、警告は低く三度
    const arrivalUrl = URL.createObjectURL(renderBellWav(784, [0, 0.4], 4));
    const warningUrl = URL.createObjectURL(renderBellWav(392, [0, 0.28, 0.56], 3));
    const arrival = new Audio(arrivalUrl);
    const warning = new Audio(warningUrl);
    for (const audio of [arrival, warning]) {
      audio.loop = true;
      audio.preload = 'auto';
      audio.hidden = true;
      audio.dataset.kikimiyaChime = '';
      // 長時間の再生でも回収されないよう、文書に置いておく
      document.body.appendChild(audio);
    }
    arrivalRef.current = arrival;
    warningRef.current = warning;

    return () => {
      for (const audio of [arrival, warning]) {
        audio.pause();
        audio.remove();
      }
      URL.revokeObjectURL(arrivalUrl);
      URL.revokeObjectURL(warningUrl);
    };
  }, []);

  useEffect(() => {
    for (const audio of [arrivalRef.current, warningRef.current]) {
      if (audio) audio.volume = volume;
    }
  }, [volume]);

  /** 音を出さずに再生許可を取る。何かをクリックした流れの中でしか成功しない */
  const silentUnlock = useCallback(async () => {
    const audio = arrivalRef.current;
    if (!audio) return false;
    const previous = audio.volume;
    try {
      audio.volume = 0;
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
      setUnlocked(true);
      return true;
    } catch {
      setUnlocked(false);
      return false;
    } finally {
      audio.volume = previous;
    }
  }, []);

  // ページ内のどこかを一度でも操作したら、音を鳴らせるようにしておく
  useEffect(() => {
    if (unlocked) return;
    const handler = () => {
      void silentUnlock();
    };
    document.addEventListener('pointerdown', handler, { once: true });
    document.addEventListener('keydown', handler, { once: true });
    return () => {
      document.removeEventListener('pointerdown', handler);
      document.removeEventListener('keydown', handler);
    };
  }, [unlocked, silentUnlock]);

  const stop = useCallback(() => {
    playingRef.current = null;
    for (const audio of [arrivalRef.current, warningRef.current]) {
      if (!audio) continue;
      audio.pause();
      audio.currentTime = 0;
    }
  }, []);

  const start = useCallback(
    (kind: ChimeKind) => {
      if (playingRef.current === kind) return;
      stop();
      const audio = kind === 'arrival' ? arrivalRef.current : warningRef.current;
      if (!audio) return;
      playingRef.current = kind;
      audio.currentTime = 0;
      audio.volume = volume;
      audio
        .play()
        .then(() => setUnlocked(true))
        .catch(() => setUnlocked(false));
    },
    [stop, volume],
  );

  const test = useCallback(
    async (kind: ChimeKind = 'arrival') => {
      const audio = kind === 'arrival' ? arrivalRef.current : warningRef.current;
      if (!audio) return;
      try {
        audio.currentTime = 0;
        audio.volume = volume;
        await audio.play();
        setUnlocked(true);
        // ひと鳴りぶんだけ聞かせて止める
        window.setTimeout(() => {
          if (playingRef.current === null) {
            audio.pause();
            audio.currentTime = 0;
          }
        }, 2400);
      } catch {
        setUnlocked(false);
      }
    },
    [volume],
  );

  return { unlocked, volume, setVolume: setVolumeState, start, stop, test };
}

/* --------------------- タブのタイトルとファビコン --------------------- */

const ICON_IDLE =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#0c0a09"/><circle cx="16" cy="16" r="6" fill="#c9a44c"/></svg>',
  );

const ICON_ALERT =
  'data:image/svg+xml,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#c2603f"/><circle cx="16" cy="16" r="7" fill="#f2e6cf"/></svg>',
  );

function faviconLink(): HTMLLinkElement {
  let link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!link) {
    link = document.createElement('link');
    link.rel = 'icon';
    document.head.appendChild(link);
  }
  return link;
}

/**
 * 別のタブを見ていても気づけるよう、タイトルとファビコンを変える。
 * 点滅させないのは、バックグラウンドのタブではタイマーが間引かれるため。
 */
export function useTabAttention(alertTitle: string | null): void {
  useEffect(() => {
    const link = faviconLink();
    if (!alertTitle) {
      link.href = ICON_IDLE;
      return;
    }
    const original = document.title;
    document.title = alertTitle;
    link.href = ICON_ALERT;
    return () => {
      document.title = original;
      link.href = ICON_IDLE;
    };
  }, [alertTitle]);
}

/* --------------------------- デスクトップ通知 --------------------------- */

export type NotifyPermission = 'unsupported' | NotificationPermission;

export interface DesktopNotifier {
  permission: NotifyPermission;
  request: () => Promise<void>;
  show: (title: string, body: string) => void;
  clear: () => void;
}

export function useDesktopNotifier(): DesktopNotifier {
  const [permission, setPermission] = useState<NotifyPermission>('unsupported');
  const currentRef = useRef<Notification | null>(null);

  useEffect(() => {
    if (typeof window !== 'undefined' && 'Notification' in window) {
      setPermission(Notification.permission);
    }
  }, []);

  const request = useCallback(async () => {
    if (typeof window === 'undefined' || !('Notification' in window)) return;
    const result = await Notification.requestPermission();
    setPermission(result);
  }, []);

  const clear = useCallback(() => {
    currentRef.current?.close();
    currentRef.current = null;
  }, []);

  const show = useCallback(
    (title: string, body: string) => {
      if (typeof window === 'undefined' || !('Notification' in window)) return;
      if (Notification.permission !== 'granted') return;
      clear();
      const notification = new Notification(title, {
        body,
        // 見るまで消えないようにする（対応しているブラウザのみ）
        requireInteraction: true,
        tag: 'kikimiya-visitor',
      });
      notification.onclick = () => {
        window.focus();
        notification.close();
      };
      currentRef.current = notification;
    },
    [clear],
  );

  useEffect(() => () => currentRef.current?.close(), []);

  return { permission, request, show, clear };
}

/* ---------------------------- 画面を消さない ---------------------------- */

type WakeLockSentinelLike = { release: () => Promise<void>; released: boolean };

export function useWakeLock(enabled: boolean): { supported: boolean; active: boolean } {
  const [active, setActive] = useState(false);
  const supported =
    typeof navigator !== 'undefined' && 'wakeLock' in navigator;

  useEffect(() => {
    if (!enabled || !supported) {
      setActive(false);
      return;
    }
    let sentinel: WakeLockSentinelLike | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const api = (navigator as Navigator & {
          wakeLock: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
        }).wakeLock;
        sentinel = await api.request('screen');
        if (cancelled) {
          void sentinel.release();
          return;
        }
        setActive(true);
      } catch {
        setActive(false);
      }
    };

    void acquire();
    // 別のタブに移ると解除されるので、戻ってきたら取り直す
    const onVisible = () => {
      if (document.visibilityState === 'visible' && (!sentinel || sentinel.released)) {
        void acquire();
      }
    };
    document.addEventListener('visibilitychange', onVisible);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
      void sentinel?.release().catch(() => undefined);
      setActive(false);
    };
  }, [enabled, supported]);

  return { supported, active };
}

/* ------------------------------------------------------------------ */
/* 離席の検知                                                          */
/* ------------------------------------------------------------------ */

/**
 * 最後に人が触った時刻を返す。
 *
 * 「パソコンの前にいる限り在室」で運用すると、席を外したまま
 * オンラインにし続ける状況が必ず来る。待たせたまま気づかないより、
 * 一定時間まったく触られていないことを見て、正直に離席へ落とすほうがよい。
 *
 * 画面を見ているだけでも触ったことにはならないので、
 * 「待っている人がいるのに反応が無い」ときだけの判断材料として使うこと。
 */
export function useLastActivity(): { current: number } {
  const at = useRef(Date.now());

  useEffect(() => {
    const touch = () => {
      at.current = Date.now();
    };
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const;
    for (const name of events) window.addEventListener(name, touch, { passive: true });
    const onVisible = () => {
      if (document.visibilityState === 'visible') touch();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', touch);
    return () => {
      for (const name of events) window.removeEventListener(name, touch);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', touch);
    };
  }, []);

  return at;
}
