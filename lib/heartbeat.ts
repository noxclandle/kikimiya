'use client';

import { useEffect } from 'react';
import { HEARTBEAT_INTERVAL_MS } from './config';
import type { KikimiyaSocket } from './socket';

/**
 * 在室確認のための生存信号を一定間隔で送り続ける。
 * ブラウザを閉じる・リロードして戻らない場合は信号が止まり、
 * サーバー側のタイムアウト（既定15秒）で自動的に退室扱いになる。
 */
export function useHeartbeat(socket: KikimiyaSocket | null, enabled = true): void {
  useEffect(() => {
    if (!socket || !enabled) return;
    const beat = () => {
      if (socket.connected) socket.emit('heartbeat');
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_INTERVAL_MS);
    // タブが再び表示されたときは即座に1回送る（スロットリング対策）
    const onVisible = () => {
      if (document.visibilityState === 'visible') beat();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [socket, enabled]);
}

/** 来訪者IDをタブ単位で覚えておく（リロードしても同じ順番待ちに戻れるように） */
const VISITOR_KEY = 'kikimiya:visitor';

export function rememberedVisitorId(): string | null {
  if (typeof window === 'undefined') return null;
  return window.sessionStorage.getItem(VISITOR_KEY);
}

export function rememberVisitorId(id: string): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.setItem(VISITOR_KEY, id);
}

export function forgetVisitorId(): void {
  if (typeof window === 'undefined') return;
  window.sessionStorage.removeItem(VISITOR_KEY);
}
