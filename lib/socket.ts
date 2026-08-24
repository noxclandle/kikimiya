'use client';

import { useEffect, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from './types';
import { SERVER_URL } from './config';

export type KikimiyaSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

let shared: KikimiyaSocket | null = null;

/** ページ間で1本のコネクションを使い回す */
export function getSocket(): KikimiyaSocket {
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
