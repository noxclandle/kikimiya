'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './types';
import { SERVER_CONFIGURED, SERVER_URL } from './config';

export type KikimiyaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let shared: KikimiyaSocket | null = null;

let warned = false;

/** ページ間で1本のコネクションを使い回す */
export function getSocket(): KikimiyaSocket | null {
  if (!SERVER_CONFIGURED) {
    if (!warned) {
      warned = true;
      console.error(
        '[聴き宮] NEXT_PUBLIC_SERVER_URL が設定されていません。\n' +
          '常時起動サーバーのURL（例 https://realtime.example.com）を環境変数に入れ、\n' +
          'ビルドし直してください。この値はビルド時に埋め込まれます。',
      );
    }
    return null;
  }
  if (!shared) {
    shared = io(SERVER_URL, {
      transports: ['websocket', 'polling'],
      reconnectionDelay: 800,
      reconnectionDelayMax: 4000,
    });
  }
  return shared;
}

/** 接続状態つきで socket を返すフック */
export function useSocket(): { socket: KikimiyaSocket | null; connected: boolean } {
  const [connected, setConnected] = useState(false);
  const ref = useRef<KikimiyaSocket | null>(null);

  if (typeof window !== 'undefined' && !ref.current) {
    ref.current = getSocket();
  }

  useEffect(() => {
    const socket = ref.current;
    if (!socket) return;
    setConnected(socket.connected);
    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    return () => {
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
    };
  }, []);

  return { socket: ref.current, connected };
}
