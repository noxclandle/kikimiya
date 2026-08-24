/**
 * 環境変数の読み取り。
 *
 * ホスティング先の管理画面では「キーだけ作って値は空」という状態が
 * 簡単に起きる。`process.env.X ?? 既定値` は空文字を拾ってしまい、
 * Number('') = 0 のような値が既定値の顔をして紛れ込む。
 * タイムアウトが 0 になれば全員が即座に退室扱いになるため、ここで潰しておく。
 */

export function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function envString(name: string, fallback: string): string {
  const raw = process.env[name];
  return raw === undefined || raw.trim() === '' ? fallback : raw;
}
