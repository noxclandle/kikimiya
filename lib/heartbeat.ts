'use client';

import { useEffect, useRef } from 'react';
import { FATHER_HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS } from './config';
import { adminHeartbeat, visitorHeartbeat } from './api';
import type { AdminState } from './types';

/**
 * 生存の信号。
 *
 * 常駐するサーバーが無いので「繋ぎっぱなしの線」も無い。
 * 代わりに、居るあいだだけ短い便りを送り続ける。
 * 途切れれば、サーバーは次に誰かが訪ねてきたときの掃除で退室扱いにする。
 */

/** すぐに1回、そのあと間隔ごとに繰り返す。タブが表に戻ったときも1回。 */
function useTicker(enabled: boolean, intervalMs: number, beat: () => void): void {
  const latest = useRef(beat);
  latest.current = beat;

  useEffect(() => {
    if (!enabled) return;
    const tick = () => latest.current();
    tick();
    const timer = setInterval(tick, intervalMs);
    // 裏に回ったタブは間引かれる。表に戻った瞬間に送り直す。
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, intervalMs]);
}

/**
 * 来訪者の生存信号。列に並んでいるあいだと、部屋に居るあいだだけ送る。
 * 入口を眺めているだけの人は送らない（席にも列にも載っていないため）。
 *
 * サーバーが「もう居ないことになっている」と答えたら onLost を呼ぶ。
 */
export function useVisitorHeartbeat(
  visitorId: string | null,
  enabled: boolean,
  onLost?: () => void,
): void {
  const lost = useRef(onLost);
  lost.current = onLost;

  useTicker(Boolean(visitorId) && enabled, HEARTBEAT_INTERVAL_MS, () => {
    if (!visitorId) return;
    void visitorHeartbeat(visitorId)
      .then((result) => {
        if (!result.alive) lost.current?.();
      })
      .catch(() => undefined);
  });
}

/**
 * 神父の在室信号。待機所を開いているあいだと、告解室に居るあいだ送る。
 * これが45秒途切れると、入口は「不在」になる。
 */
export function useFatherHeartbeat(
  token: string | null,
  enabled: boolean,
  handlers?: {
    onState?: (state: AdminState) => void;
    /** 期限が近づいて差し替えられたトークン。覚え直すこと。 */
    onToken?: (token: string) => void;
    onError?: (error: unknown) => void;
  },
): void {
  const latest = useRef(handlers);
  latest.current = handlers;

  useTicker(Boolean(token) && enabled, FATHER_HEARTBEAT_INTERVAL_MS, () => {
    if (!token) return;
    void adminHeartbeat(token)
      .then((data) => {
        latest.current?.onState?.(data.state);
        if (data.token) latest.current?.onToken?.(data.token);
      })
      .catch((cause) => latest.current?.onError?.(cause));
  });
}

/* --------------------------- 来訪者ID --------------------------- */

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
