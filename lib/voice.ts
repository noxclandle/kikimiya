'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { RtcSignal } from './types';

const DEFAULT_STUN = 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';

// 空文字が入っていても既定値に落ちるよう ?? ではなく || を使う。
// ここが空配列になると、音声がまったく繋がらなくなる。
const STUN_URLS = (process.env.NEXT_PUBLIC_STUN_URLS || DEFAULT_STUN)
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

/*
  TURN（中継）の設定。

  STUN だけでは、対称NAT の回線（携帯回線・職場や学校のネットワークに多い）で
  音声が繋がらない。**繋がらない相手が一定の割合で必ず出る**ので、
  ずっと運用するなら中継を用意しておくのが確実。

  提供元は udp / tcp / 443番 の複数のURLを配ることが多いので、
  カンマ区切りで並べられるようにしてある（片方が塞がれていても、もう片方で通る）。
*/
const TURN_URLS = (process.env.NEXT_PUBLIC_TURN_URLS || process.env.NEXT_PUBLIC_TURN_URL || '')
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

/** 中継の設定があるか。無ければ STUN だけで試みる。 */
export const TURN_CONFIGURED = TURN_URLS.length > 0;

function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = STUN_URLS.length > 0 ? [{ urls: STUN_URLS }] : [];
  if (TURN_URLS.length > 0) {
    servers.push({
      urls: TURN_URLS,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }
  return servers;
}

export interface IceProbe {
  /** 自分の端末のアドレス。これしか出なければ、外に出られていない */
  host: boolean;
  /** STUN で見えた、外から見た自分のアドレス */
  srflx: boolean;
  /** TURN の中継。これがあれば、相手の回線を選ばない */
  relay: boolean;
  turnConfigured: boolean;
  error?: string;
}

/**
 * 声の通り道を、実際に繋ぐ前に確かめる。
 *
 * 本番で「繋がらない」と分かるのは遅すぎるので、
 * 待機所からいつでも試せるようにしておく。
 */
export async function probeIce(timeoutMs = 8000): Promise<IceProbe> {
  const found: IceProbe = { host: false, srflx: false, relay: false, turnConfigured: TURN_CONFIGURED };
  let pc: RTCPeerConnection | null = null;

  try {
    pc = new RTCPeerConnection({ iceServers: iceServers() });
    pc.createDataChannel('probe');

    const gathered = new Promise<void>((resolve) => {
      if (!pc) return resolve();
      pc.onicecandidate = (event) => {
        if (!event.candidate) return resolve();
        const type = event.candidate.type;
        if (type === 'host') found.host = true;
        if (type === 'srflx' || type === 'prflx') found.srflx = true;
        if (type === 'relay') {
          found.relay = true;
          resolve(); // 中継が取れたなら、それ以上待つ必要はない
        }
      };
    });

    await pc.setLocalDescription(await pc.createOffer());
    await Promise.race([
      gathered,
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
    ]);
  } catch (cause) {
    found.error = cause instanceof Error ? cause.message : String(cause);
  } finally {
    pc?.close();
  }

  return found;
}

export type VoicePhase = 'off' | 'requesting' | 'waiting' | 'connecting' | 'live' | 'error';

/**
 * 声を繋ぐための、相手との細い連絡路。
 * 実体は告解室のリアルタイム通り道だが、ここでは「送れること」だけ知っていればよい。
 */
export interface VoiceLink {
  send: (signal: RtcSignal) => void;
  /** こちらが発信側か。神父側を発信側にしている。 */
  initiator: boolean;
}

export interface VoiceCall {
  phase: VoicePhase;
  error: string | null;
  muted: boolean;
  micVolume: number;
  speakerVolume: number;
  /** 相手の音声パケットが実際に届いているか（null = 判定前） */
  audioFlowing: boolean | null;
  audioRef: React.RefObject<HTMLAudioElement | null>;
  enable: () => Promise<void>;
  hangUp: () => void;
  /** 相手から届いたシグナルを流し込む。告解室の受け取り口から呼ぶ。 */
  receive: (signal: RtcSignal) => void;
  setMuted: (muted: boolean) => void;
  setMicVolume: (value: number) => void;
  setSpeakerVolume: (value: number) => void;
}

/**
 * WebRTC による一対一の音声通話。
 *
 * シグナリング（繋ぐための打ち合わせ）は、告解室のリアルタイム通り道を借りる。
 * 声そのものはピア間を直接ゆき来し、どのサーバーも通らない。
 *
 * マイク音量は Web Audio の GainNode を通してから送るため、
 * スライダーを下げると「相手に届く声そのもの」が小さくなる。
 */
export function useVoiceCall(link: VoiceLink | null, active: boolean): VoiceCall {
  const [phase, setPhase] = useState<VoicePhase>('off');
  const [error, setError] = useState<string | null>(null);
  const [muted, setMutedState] = useState(false);
  const [micVolume, setMicVolumeState] = useState(1);
  const [speakerVolume, setSpeakerVolumeState] = useState(1);
  const [audioFlowing, setAudioFlowing] = useState<boolean | null>(null);

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const rawStreamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const outboundTrackRef = useRef<MediaStreamTrack | null>(null);
  const makingOfferRef = useRef(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);
  /** 相手がマイクを開いたと知らせてきたか */
  const peerReadyRef = useRef(false);

  // 描画のたびに作り直される連絡路を、依存に持ち込まないよう箱に入れる
  const linkRef = useRef(link);
  linkRef.current = link;

  const sendSignal = useCallback((signal: RtcSignal) => linkRef.current?.send(signal), []);
  const isInitiator = useCallback(() => Boolean(linkRef.current?.initiator), []);

  /* ------------------------- 後片付け ------------------------- */

  const teardown = useCallback(() => {
    pcRef.current?.close();
    pcRef.current = null;
    outboundTrackRef.current = null;
    rawStreamRef.current?.getTracks().forEach((track) => track.stop());
    rawStreamRef.current = null;
    gainRef.current = null;
    void contextRef.current?.close().catch(() => undefined);
    contextRef.current = null;
    pendingCandidatesRef.current = [];
    peerReadyRef.current = false;
    if (audioRef.current) audioRef.current.srcObject = null;
    setAudioFlowing(null);
    setPhase('off');
  }, []);

  useEffect(() => () => teardown(), [teardown]);

  // 部屋を出たら必ず切る
  useEffect(() => {
    if (!active) teardown();
  }, [active, teardown]);

  /* ------------------------- 接続の組み立て ------------------------- */

  const ensurePeerConnection = useCallback((): RTCPeerConnection => {
    if (pcRef.current) return pcRef.current;
    const pc = new RTCPeerConnection({ iceServers: iceServers() });

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendSignal({ kind: 'candidate', candidate: event.candidate.toJSON() });
      }
    };

    pc.ontrack = (event) => {
      const [stream] = event.streams;
      if (audioRef.current && stream) {
        audioRef.current.srcObject = stream;
        audioRef.current.volume = speakerVolume;
        void audioRef.current.play().catch(() => undefined);
      }
      setPhase('live');
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') setPhase('live');
      if (pc.connectionState === 'connecting') setPhase('connecting');
      if (pc.connectionState === 'failed') {
        setError('音声の接続に失敗しました。回線を変えるか、文字でお話しください。');
        setPhase('error');
      }
      if (pc.connectionState === 'disconnected') setAudioFlowing(false);
    };

    pcRef.current = pc;
    return pc;
  }, [sendSignal, speakerVolume]);

  const makeOffer = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || makingOfferRef.current) return;
    try {
      makingOfferRef.current = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendSignal({ kind: 'offer', sdp: pc.localDescription?.sdp ?? offer.sdp ?? '' });
      setPhase('connecting');
    } catch (cause) {
      console.error('[voice] offer の作成に失敗:', cause);
    } finally {
      makingOfferRef.current = false;
    }
  }, [sendSignal]);

  /* ------------------------- マイクを開く ------------------------- */

  const enable = useCallback(async () => {
    if (!linkRef.current) return;
    if (rawStreamRef.current) return;
    setError(null);
    setPhase('requesting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      });
      rawStreamRef.current = stream;

      // GainNode を挟んで「送る声の大きさ」を調整できるようにする
      const context = new AudioContext();
      await context.resume().catch(() => undefined);
      const source = context.createMediaStreamSource(stream);
      const gain = context.createGain();
      gain.gain.value = micVolume;
      const destination = context.createMediaStreamDestination();
      source.connect(gain);
      gain.connect(destination);
      contextRef.current = context;
      gainRef.current = gain;

      const outbound = destination.stream.getAudioTracks()[0];
      outbound.enabled = !muted;
      outboundTrackRef.current = outbound;

      const pc = ensurePeerConnection();
      pc.addTrack(outbound, destination.stream);

      setPhase('waiting');
      // 「開いた」と伝える。相手が発信側なら、これを受けて offer を出し直す。
      sendSignal({ kind: 'ready' });
      if (isInitiator() && peerReadyRef.current) await makeOffer();
    } catch (cause) {
      console.error('[voice] マイクを開けませんでした:', cause);
      setError(
        'マイクを使えませんでした。ブラウザの許可設定をご確認ください。文字だけでもお話しできます。',
      );
      setPhase('error');
      teardown();
    }
  }, [sendSignal, isInitiator, micVolume, muted, ensurePeerConnection, makeOffer, teardown]);

  /* ------------------------- シグナリング受信 ------------------------- */

  const receive = useCallback(
    (payload: RtcSignal) => {
      void (async () => {
      try {
        if (payload.kind === 'ready') {
          // 相手がマイクを開いた。発信側なら（改めて）offer を出す。
          peerReadyRef.current = true;
          if (isInitiator() && pcRef.current && outboundTrackRef.current) await makeOffer();
          return;
        }

        if (payload.kind === 'candidate') {
          const candidate = payload.candidate as RTCIceCandidateInit;
          const pc = pcRef.current;
          if (!pc || !pc.remoteDescription) {
            pendingCandidatesRef.current.push(candidate);
            return;
          }
          await pc.addIceCandidate(candidate);
          return;
        }

        if (payload.kind === 'offer') {
          const pc = ensurePeerConnection();
          await pc.setRemoteDescription({ type: 'offer', sdp: payload.sdp });
          for (const candidate of pendingCandidatesRef.current.splice(0)) {
            await pc.addIceCandidate(candidate).catch(() => undefined);
          }
          // まだマイクを開いていない場合は受信のみで応答する
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          sendSignal({ kind: 'answer', sdp: pc.localDescription?.sdp ?? answer.sdp ?? '' });
          setPhase((current) => (current === 'off' ? 'connecting' : current));
          return;
        }

        if (payload.kind === 'answer') {
          const pc = pcRef.current;
          if (!pc || pc.signalingState !== 'have-local-offer') return;
          await pc.setRemoteDescription({ type: 'answer', sdp: payload.sdp });
          for (const candidate of pendingCandidatesRef.current.splice(0)) {
            await pc.addIceCandidate(candidate).catch(() => undefined);
          }
        }
      } catch (cause) {
        console.error('[voice] シグナリングの処理に失敗:', cause);
      }
      })();
    },
    [isInitiator, ensurePeerConnection, makeOffer, sendSignal],
  );

  /* --------------------- 音声途切れの検知 --------------------- */

  useEffect(() => {
    if (phase !== 'live') return;
    let lastBytes = -1;
    let silentTicks = 0;

    const timer = setInterval(async () => {
      const pc = pcRef.current;
      if (!pc) return;
      try {
        const stats = await pc.getStats();
        let bytes = 0;
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            bytes += (report as RTCInboundRtpStreamStats & { bytesReceived?: number })
              .bytesReceived ?? 0;
          }
        });
        if (lastBytes >= 0) {
          // 受信バイト数が増えていなければ、相手の音声が届いていない
          silentTicks = bytes > lastBytes ? 0 : silentTicks + 1;
          setAudioFlowing(silentTicks < 2);
        }
        lastBytes = bytes;
      } catch {
        // 取得できない環境では判定しない
      }
    }, 2000);

    return () => clearInterval(timer);
  }, [phase]);

  /* --------------------------- 操作 --------------------------- */

  const setMuted = useCallback((next: boolean) => {
    setMutedState(next);
    // 即座に止める（GainNodeを待たずトラック自体を無効化する）
    if (outboundTrackRef.current) outboundTrackRef.current.enabled = !next;
  }, []);

  const setMicVolume = useCallback((value: number) => {
    setMicVolumeState(value);
    if (gainRef.current) gainRef.current.gain.value = value;
  }, []);

  const setSpeakerVolume = useCallback((value: number) => {
    setSpeakerVolumeState(value);
    if (audioRef.current) audioRef.current.volume = value;
  }, []);

  return {
    phase,
    error,
    muted,
    micVolume,
    speakerVolume,
    audioFlowing,
    audioRef,
    enable,
    hangUp: teardown,
    receive,
    setMuted,
    setMicVolume,
    setSpeakerVolume,
  };
}
