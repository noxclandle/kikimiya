'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { KikimiyaSocket } from './socket';
import type { RtcSignal } from './types';

const DEFAULT_STUN = 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302';

// 空文字が入っていても既定値に落ちるよう ?? ではなく || を使う。
// ここが空配列になると、音声がまったく繋がらなくなる。
const STUN_URLS = (process.env.NEXT_PUBLIC_STUN_URLS || DEFAULT_STUN)
  .split(',')
  .map((url) => url.trim())
  .filter(Boolean);

/** TURN が要る回線（対称NAT等）向け。未設定なら STUN のみで試みる。 */
function iceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = STUN_URLS.length > 0 ? [{ urls: STUN_URLS }] : [];
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL;
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL,
    });
  }
  return servers;
}

export type VoicePhase = 'off' | 'requesting' | 'waiting' | 'connecting' | 'live' | 'error';

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
  setMuted: (muted: boolean) => void;
  setMicVolume: (value: number) => void;
  setSpeakerVolume: (value: number) => void;
}

/**
 * WebRTC による一対一の音声通話。
 * シグナリングは Socket.io（`rtc:signal` / `rtc:peer-ready`）を通す。
 *
 * マイク音量は Web Audio の GainNode を通してから送るため、
 * スライダーを下げると「相手に届く声そのもの」が小さくなる。
 */
export function useVoiceCall(socket: KikimiyaSocket | null, active: boolean): VoiceCall {
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
  const initiatorRef = useRef(false);
  const makingOfferRef = useRef(false);
  const pendingCandidatesRef = useRef<RTCIceCandidateInit[]>([]);

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
        socket?.emit('rtc:signal', { kind: 'candidate', candidate: event.candidate.toJSON() });
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
  }, [socket, speakerVolume]);

  const makeOffer = useCallback(async () => {
    const pc = pcRef.current;
    if (!pc || makingOfferRef.current) return;
    try {
      makingOfferRef.current = true;
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket?.emit('rtc:signal', { kind: 'offer', sdp: pc.localDescription?.sdp ?? offer.sdp ?? '' });
      setPhase('connecting');
    } catch (cause) {
      console.error('[voice] offer の作成に失敗:', cause);
    } finally {
      makingOfferRef.current = false;
    }
  }, [socket]);

  /* ------------------------- マイクを開く ------------------------- */

  const enable = useCallback(async () => {
    if (!socket) return;
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
      socket.emit('rtc:ready');
      if (initiatorRef.current) await makeOffer();
    } catch (cause) {
      console.error('[voice] マイクを開けませんでした:', cause);
      setError(
        'マイクを使えませんでした。ブラウザの許可設定をご確認ください。文字だけでもお話しできます。',
      );
      setPhase('error');
      teardown();
    }
  }, [socket, micVolume, muted, ensurePeerConnection, makeOffer, teardown]);

  /* ------------------------- シグナリング受信 ------------------------- */

  useEffect(() => {
    if (!socket || !active) return;

    const onPeerReady = ({ initiator }: { initiator: boolean }) => {
      initiatorRef.current = initiator;
      if (initiator && pcRef.current && outboundTrackRef.current) void makeOffer();
    };

    const onSignal = async (payload: RtcSignal) => {
      try {
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
          socket.emit('rtc:signal', {
            kind: 'answer',
            sdp: pc.localDescription?.sdp ?? answer.sdp ?? '',
          });
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
    };

    socket.on('rtc:peer-ready', onPeerReady);
    socket.on('rtc:signal', onSignal);
    return () => {
      socket.off('rtc:peer-ready', onPeerReady);
      socket.off('rtc:signal', onSignal);
    };
  }, [socket, active, ensurePeerConnection, makeOffer]);

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
    setMuted,
    setMicVolume,
    setSpeakerVolume,
  };
}
