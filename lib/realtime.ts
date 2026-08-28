'use client';

import { createClient, type RealtimeChannel, type SupabaseClient } from '@supabase/supabase-js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { REALTIME_CONFIGURED, SUPABASE_KEY, SUPABASE_URL } from './config';

/**
 * リアルタイムの通り道（Supabase Realtime のブロードキャスト）。
 *
 * 常駐するサーバーを持たない代わりに、押し出しの知らせだけをここに通す。
 * 使うのは**公開鍵**だけで、テーブルには一切触れない（触れないように
 * schema.sql で施錠してある）。通り道の名前は当てられない文字列
 * （来訪者ID・セッションID・署名）にしてあり、名前を知らない人は覗けない。
 */

let shared: SupabaseClient | null = null;

function client(): SupabaseClient {
  if (!shared) {
    shared = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { params: { eventsPerSecond: 20 } },
    });
  }
  return shared;
}

/** 受け取り口。イベント名ごとに、対応する payload の型がつく。 */
export type Handlers<E extends { event: string; payload: unknown }> = {
  [K in E['event']]?: (payload: Extract<E, { event: K }>['payload']) => void;
};

type AnyHandlers = Record<string, ((payload: unknown) => void) | undefined>;

/**
 * ひとつの通り道を聞く。topic が null のあいだは何もしない。
 * 戻り値は「いま繋がっているか」。
 */
export function useBroadcast<E extends { event: string; payload: unknown }>(
  topic: string | null,
  handlers: Handlers<E>,
): boolean {
  // 描画のたびに作り直される関数を購読し直さないよう、箱に入れて渡す
  const latest = useRef(handlers);
  latest.current = handlers;

  const [connected, setConnected] = useState(false);

  useEffect(() => {
    if (!topic || !REALTIME_CONFIGURED) return;

    const channel = client().channel(topic, { config: { broadcast: { self: false } } });
    channel.on('broadcast', { event: '*' }, (message) => {
      (latest.current as AnyHandlers)[message.event]?.(message.payload);
    });
    channel.subscribe((status) => setConnected(status === 'SUBSCRIBED'));

    return () => {
      setConnected(false);
      void client().removeChannel(channel);
    };
  }, [topic]);

  return connected;
}

export interface Link<E extends { event: string; payload: unknown }> {
  connected: boolean;
  /** 相手がこの通り道にいるか */
  peerPresent: boolean;
  send: <K extends E['event']>(event: K, payload: Extract<E, { event: K }>['payload']) => void;
}

/**
 * 告解室のように、双方が話す通り道。
 *
 * 在室は Supabase の presence で見る。相手がタブを閉じれば即座に消えるので、
 * 「相手がいるか」を別の仕組みで数えなくてよい。
 */
export function useLink<E extends { event: string; payload: unknown }>(
  topic: string | null,
  role: string,
  handlers: Handlers<E>,
): Link<E> {
  const latest = useRef(handlers);
  latest.current = handlers;

  const channelRef = useRef<RealtimeChannel | null>(null);
  const readyRef = useRef(false);
  const pending = useRef<{ event: string; payload: unknown }[]>([]);
  const [connected, setConnected] = useState(false);
  const [peerPresent, setPeerPresent] = useState(false);

  useEffect(() => {
    if (!topic || !REALTIME_CONFIGURED) return;

    const channel = client().channel(topic, {
      config: { broadcast: { self: false }, presence: { key: role } },
    });

    channel.on('broadcast', { event: '*' }, (message) => {
      (latest.current as AnyHandlers)[message.event]?.(message.payload);
    });

    channel.on('presence', { event: 'sync' }, () => {
      const state = channel.presenceState();
      setPeerPresent(Object.keys(state).some((key) => key !== role));
    });

    channel.subscribe((status) => {
      const ready = status === 'SUBSCRIBED';
      readyRef.current = ready;
      setConnected(ready);
      if (!ready) return;
      void channel.track({ role, at: Date.now() });
      // 繋がる前に書かれたものは、繋がってから送る
      for (const message of pending.current.splice(0)) {
        void channel.send({ type: 'broadcast', event: message.event, payload: message.payload });
      }
    });

    channelRef.current = channel;

    return () => {
      channelRef.current = null;
      readyRef.current = false;
      setConnected(false);
      setPeerPresent(false);
      void client().removeChannel(channel);
    };
  }, [topic, role]);

  const send = useCallback((event: string, payload: unknown) => {
    const channel = channelRef.current;
    if (!channel || !readyRef.current) {
      pending.current.push({ event, payload });
      return;
    }
    void channel.send({ type: 'broadcast', event, payload });
  }, []);

  return { connected, peerPresent, send: send as Link<E>['send'] };
}
