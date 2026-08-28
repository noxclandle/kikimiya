/**
 * リアルタイムの通り道の名前。サーバーとブラウザの双方が使う。
 *
 * 名前そのものが鍵になっている（来訪者ID・セッションID・署名）。
 * 当てられない文字列にしてあるので、名前を知らない人は覗けない。
 */

/** 誰でも聞いてよい、在室状況だけが流れる通り道 */
export const LOBBY_TOPIC = 'kikimiya:lobby';

/** 来訪者ひとりに宛てた通り道（順番・入室案内・終了の知らせ） */
export const visitorTopic = (visitorId: string) => `kikimiya:visitor:${visitorId}`;

/** 告解室。神父と来訪者の二人だけが名前を知っている */
export const roomTopic = (sessionId: string) => `kikimiya:room:${sessionId}`;
