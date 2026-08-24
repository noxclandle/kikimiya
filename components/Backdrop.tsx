'use client';

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

type Scene = 'chapel' | 'confessional';

interface BackdropState {
  scene: Scene;
  dimmed: boolean;
}

const SCENES: Record<Scene, { src: string; position: string }> = {
  // 夕暮れの聖堂。入口・文章を預ける画面など「まだ外にいる」場面で使う
  chapel: { src: '/images/chapel-dusk.jpg', position: 'center 58%' },
  // 格子ごしの告解室。中に入っている場面で使う
  confessional: { src: '/images/confessional.jpg', position: 'center center' },
};

/**
 * 文字が読めるよう、画像の上に重ねる暗幕。
 * 上のほうは薄くして景色を見せ、本文が詰まる下へいくほど濃くする。
 */
const VEIL: Record<Scene, string> = {
  chapel:
    'linear-gradient(180deg, rgba(12,10,9,0.72) 0%, rgba(12,10,9,0.50) 22%, rgba(12,10,9,0.46) 45%, rgba(12,10,9,0.70) 68%, rgba(12,10,9,0.90) 87%, rgb(12,10,9) 100%)',
  confessional:
    'linear-gradient(180deg, rgba(12,10,9,0.60) 0%, rgba(12,10,9,0.34) 28%, rgba(12,10,9,0.52) 58%, rgba(12,10,9,0.82) 82%, rgb(12,10,9) 100%)',
};

/** 中央の本文に視線を集めるための、ごく淡い周辺減光 */
const VIGNETTE =
  'radial-gradient(ellipse 85% 70% at 50% 40%, transparent 40%, rgba(12,10,9,0.40) 100%)';

const BackdropContext = createContext<(state: BackdropState | null) => void>(() => undefined);

/**
 * 背景レイヤーはレイアウト側が持ち、各ページは「どの場面か」だけを宣言する。
 *
 * 背景（z-0）と本文（z-10）を兄弟として並べ、負の z-index は使わない。
 * 写真は img ではなく CSS の background-image で敷いている
 * （固定レイヤーの中の img は、環境によって初回描画で塗られないことがあるため）。
 */
export function BackdropProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<BackdropState | null>(null);
  const scene = state?.scene;
  const dimmed = state?.dimmed ?? false;

  return (
    <BackdropContext.Provider value={setState}>
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
        {scene ? (
          <div
            className="absolute inset-0 transition-[filter,transform] duration-1000 ease-out"
            style={{
              backgroundImage: `url(${SCENES[scene].src})`,
              backgroundSize: 'cover',
              backgroundPosition: SCENES[scene].position,
              backgroundRepeat: 'no-repeat',
              // 神父が不在のときは灯りを落とす
              filter: dimmed ? 'brightness(0.34) saturate(0.45)' : 'brightness(0.82)',
              transform: dimmed ? 'scale(1.05)' : 'scale(1)',
            }}
          />
        ) : null}
        {scene ? (
          <div
            className="absolute inset-0"
            style={{ backgroundImage: `${VEIL[scene]}, ${VIGNETTE}` }}
          />
        ) : null}
      </div>

      <div className="relative z-10 flex min-h-dvh flex-col">{children}</div>
    </BackdropContext.Provider>
  );
}

/**
 * このページで出す背景を宣言する。何も描かないので、置く場所はどこでもよい。
 * ページを離れると背景は消える。
 */
export function Backdrop({ scene, dimmed = false }: { scene: Scene; dimmed?: boolean }) {
  const setState = useContext(BackdropContext);
  const next = useMemo<BackdropState>(() => ({ scene, dimmed }), [scene, dimmed]);

  useEffect(() => {
    setState(next);
  }, [setState, next]);

  useEffect(() => () => setState(null), [setState]);

  return null;
}
