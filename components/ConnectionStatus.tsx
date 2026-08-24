'use client';

import type { FatherPresence } from '@/lib/types';

const PRESENCE_TEXT: Record<FatherPresence, { label: string; note: string; color: string }> = {
  offline: {
    label: '不在',
    note: '灯りが消えています',
    color: 'bg-paper-dim/40',
  },
  available: {
    label: '在室',
    note: '灯りがともっています',
    color: 'bg-moss',
  },
  busy: {
    label: '対応中',
    note: '先客がいらっしゃいます',
    color: 'bg-gold',
  },
};

export function PresenceBadge({
  presence,
  connected,
}: {
  presence: FatherPresence;
  connected: boolean;
}) {
  const view = connected
    ? PRESENCE_TEXT[presence]
    : { label: '確認中', note: 'ただいま様子をうかがっています', color: 'bg-paper-dim/40' };

  return (
    <div className="flex items-center gap-3">
      <span className={`h-2 w-2 rounded-full ${view.color} ${connected ? 'breathe' : ''}`} />
      <span className="text-sm tracking-[0.2em] text-paper">{view.label}</span>
      <span className="text-xs text-paper-dim">{view.note}</span>
    </div>
  );
}

/** 告解室で、相手が居るか・音声が途切れていないかを示す */
export function PeerIndicator({
  connected,
  peerPresent,
  peerStale,
  audioFlowing,
}: {
  connected: boolean;
  peerPresent: boolean;
  peerStale: boolean;
  audioFlowing: boolean | null;
}) {
  let color = 'bg-ember';
  let label = '接続が切れています';

  if (connected && peerPresent && !peerStale) {
    if (audioFlowing === false) {
      color = 'bg-gold';
      label = '音声が途切れています';
    } else {
      color = 'bg-moss';
      label = '接続中';
    }
  } else if (connected && peerPresent && peerStale) {
    color = 'bg-gold';
    label = '相手の応答が途切れています';
  } else if (connected && !peerPresent) {
    color = 'bg-paper-dim/50';
    label = 'まだ相手がいません';
  }

  return (
    <div className="flex items-center gap-2 text-xs text-paper-dim">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </div>
  );
}
