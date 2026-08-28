import 'server-only';
import crypto from 'node:crypto';
import { broadcast, db } from './supabase';
import { adminTopic } from './auth';
import { LOBBY_TOPIC, roomTopic, visitorTopic } from '../topics';
import type { AdminState, FatherPresence, PublicStatus, VisitorSummary } from '../types';

/* ------------------------------ 時間の決め ------------------------------ */

/*
  待つ時間を決めるときの前提：

  ブラウザは**裏に回ったタブのタイマーを間引く**（多くの環境で1分に1回程度まで）。
  待機所を開いたまま別の作業をする神父も、順番待ちのあいだ別のタブを見る来訪者も、
  信号は送っているのに「間引かれて届かない」状態になる。
  短く切ると、居るのに追い出してしまう。ここは寛容に取る。
*/

/** 告解室に居る人。席を早く空けたいので、ここだけは短め */
const ACTIVE_TIMEOUT_MS = 90_000;
/**
 * 並んで待っている人。
 *
 * 携帯で待つ人は、画面を消したり別のアプリを開いたりする。
 * そのあいだ信号は完全に止まるので、短く切ると
 * 「ちょっと目を離しただけで列から消えた」になる。長めに取る。
 * 待っているだけの人が居座っても、席が埋まるわけではないので害は小さい。
 */
const WAITING_TIMEOUT_MS = 300_000;
/** 神父の待機ページからの信号が、この時間途切れたら不在とみなす */
const FATHER_TIMEOUT_MS = 120_000;
/** 相手の応答が途切れていると表示しはじめるまで（間引きの分を見込む） */
const STALE_MS = 70_000;

// 通り道の名前はブラウザ側とも共有する（lib/topics.ts）
export { LOBBY_TOPIC, roomTopic, visitorTopic } from '../topics';

/* ------------------------------ 型 ------------------------------ */

interface VisitorRow {
  id: string;
  handle: string;
  state: 'queued' | 'invited' | 'active';
  session_id: string | null;
  joined_at: string;
  entered_at: string | null;
  last_seen_at: string;
  invite_expires_at: string | null;
}

const ms = (iso: string) => new Date(iso).getTime();

/**
 * いま居る人を、一度の問い合わせで全部持ってくる。
 *
 * 神父は一日じゅう待機所を開けたままにする。その裏で15〜30秒おきに
 * 在室の信号が飛ぶので、**一回の呼び出しで投げる問い合わせの数が
 * そのまま日々の負荷になる**。状態・席・待機列を別々に聞かず、
 * ここで一度だけ読んで、あとはメモリの上で数える。
 */
async function allVisitors(): Promise<VisitorRow[]> {
  const { data } = await db().from('visitors').select('*').order('joined_at');
  return (data ?? []) as VisitorRow[];
}

/** 席に着いている（または案内中の）人。席はひとつなので先頭だけ。 */
const seatOf = (visitors: VisitorRow[]): VisitorRow | null =>
  visitors.find((row) => row.state === 'active' || row.state === 'invited') ?? null;

/** 列に並んでいる人 */
const queueOf = (visitors: VisitorRow[]): VisitorRow[] =>
  visitors.filter((row) => row.state === 'queued');

function summarize(row: VisitorRow): VisitorSummary {
  return {
    visitorId: row.id,
    handle: row.handle,
    state: row.state,
    sessionId: row.session_id,
    joinedAt: ms(row.joined_at),
    enteredAt: row.entered_at ? ms(row.entered_at) : null,
    inviteExpiresAt: row.invite_expires_at ? ms(row.invite_expires_at) : null,
    lastSeenAt: ms(row.last_seen_at),
    stale: Date.now() - ms(row.last_seen_at) > STALE_MS,
  };
}

/* --------------------------- 掃除（在室確認） --------------------------- */

/**
 * 生存信号の途切れた来訪者を片づけ、案内の期限切れを次の人へ回す。
 *
 * 常駐するサーバーが無いので、誰かが訪ねてきた「ついで」に掃除する。
 * 一人も来なければ掃除は不要なので、これで困らない。
 */
export async function sweep(): Promise<VisitorRow[]> {
  const now = Date.now();
  const visitors = await allVisitors();

  const timedOut = (row: VisitorRow) =>
    ms(row.last_seen_at) <
    now - (row.state === 'active' ? ACTIVE_TIMEOUT_MS : WAITING_TIMEOUT_MS);

  const gone = visitors.filter(timedOut);
  const expired = visitors.filter(
    (row) =>
      !timedOut(row) &&
      row.state === 'invited' &&
      row.invite_expires_at !== null &&
      ms(row.invite_expires_at) < now,
  );

  // 誰も居ない・誰も切れていない、が大半の時間を占める。そのときは書き込まない。
  if (gone.length === 0 && expired.length === 0) return visitors;

  if (gone.length > 0) {
    await db()
      .from('visitors')
      .delete()
      .in('id', gone.map((row) => row.id));

    for (const row of gone) {
      if (row.state === 'active' && row.entered_at) {
        await recordSession((now - ms(row.entered_at)) / 1000);
        // 部屋に残されたもう一方（神父）にも、相手が消えたことを伝える
        if (row.session_id) {
          await broadcast(roomTopic(row.session_id), 'closed', {
            reason: '来訪者の通信が途切れたため、対話は終わりました。',
          });
        }
      }
    }
  }

  if (expired.length > 0) {
    /*
      呼んだのに返事が無かった人は、列から外す。

      列に戻すと先頭に居座り続け、神父が何度呼んでも同じ人に当たってしまう。
      音とタブの見出しで知らせたうえで返事が無いなら、その場を離れている。
      外れたことは本人の画面に伝わるので、戻ってきたら並び直せる。
    */
    await db()
      .from('visitors')
      .delete()
      .in('id', expired.map((row) => row.id));

    for (const row of expired) {
      await broadcast(visitorTopic(row.id), 'denied', {
        reason:
          '神父がお呼びしましたが、お返事がありませんでした。よろしければ、もう一度お並びください。',
      });
    }
  }

  // 席が空いても、自動では誰も入れない。誰を通すかは神父が決める。
  const removed = new Set([...gone, ...expired].map((row) => row.id));
  return visitors.filter((row) => !removed.has(row.id));
}

/* ------------------------------ 在室 ------------------------------ */

async function fatherRow() {
  const { data } = await db()
    .from('father_state')
    .select('online, heartbeat_at')
    .eq('id', 1)
    .maybeSingle();
  return data;
}

/** 神父が「オンラインのつもり」で、かつ信号が生きているか */
export async function fatherOnline(): Promise<boolean> {
  const row = await fatherRow();
  if (!row?.online) return false;
  return Date.now() - ms(row.heartbeat_at) < FATHER_TIMEOUT_MS;
}

export async function setFatherOnline(online: boolean): Promise<void> {
  await db()
    .from('father_state')
    .update({ online, heartbeat_at: new Date().toISOString() })
    .eq('id', 1);

  if (!online) {
    /*
      席を外したら、対応中の人にも待っている人にも伝えて解散する。

      ここは以前 .neq('id', '') と書いていた。id は uuid 列なので
      空文字との比較が型エラーになり、PostgREST がエラーを返して
      一人も消えないまま黙って素通りしていた（= オフラインにしても
      部屋が埋まったままになる）。全件を指すなら「null でない」を使う。
    */
    const { data: everyone, error } = await db()
      .from('visitors')
      .delete()
      .not('id', 'is', null)
      .select('*');
    if (error) console.error('[state] 解散に失敗:', error.message);
    for (const row of (everyone ?? []) as VisitorRow[]) {
      if (row.state === 'active' && row.entered_at) {
        await recordSession((Date.now() - ms(row.entered_at)) / 1000);
      }
      await broadcast(visitorTopic(row.id), 'closed', {
        reason: '神父が席を外しました。またお越しください。',
      });
    }
  }
  await publish();
}

export async function fatherHeartbeat(): Promise<void> {
  await db()
    .from('father_state')
    .update({ heartbeat_at: new Date().toISOString() })
    .eq('id', 1);
}

/* ------------------------------ 状態 ------------------------------ */

/** 席の状況をひとつだけ知りたいとき（入室・案内の判定用） */
async function activeVisitor(): Promise<VisitorRow | null> {
  return seatOf(await allVisitors());
}

export async function publicStatus(known?: VisitorRow[]): Promise<PublicStatus> {
  const [online, visitors] = await Promise.all([
    fatherOnline(),
    known ? Promise.resolve(known) : allVisitors(),
  ]);
  const busy = seatOf(visitors);
  const queue = queueOf(visitors);

  const presence: FatherPresence = !online ? 'offline' : busy ? 'busy' : 'available';
  return {
    presence,
    queueLength: queue.length + (busy?.state === 'invited' ? 1 : 0),
    // 席はひとつ。案内中の席も「埋まっている」として来訪者に見せる。
    capacity: 1,
    occupied: busy ? 1 : 0,
  };
}

export async function adminState(known?: VisitorRow[]): Promise<AdminState> {
  const visitors = known ?? (await allVisitors());
  const [status, stats, unread] = await Promise.all([
    publicStatus(visitors),
    statsToday(),
    unreadLetters(),
  ]);

  const seat = seatOf(visitors);
  const active = seat?.state === 'active' ? seat : null;
  const waiting = [...(seat?.state === 'invited' ? [seat] : []), ...queueOf(visitors)];

  return {
    presence: status.presence,
    active: active ? summarize(active) : null,
    queue: waiting.map(summarize),
    stats: {
      sessionsToday: stats.sessions,
      averageDurationToday:
        stats.sessions > 0 ? Math.round(stats.total_duration_seconds / stats.sessions) : 0,
      totalDurationToday: stats.total_duration_seconds,
      unreadMessages: unread,
      date: stats.date,
    },
  };
}

/** 入口と待機所へ、いまの状態を配る */
export async function publish(known?: VisitorRow[]): Promise<void> {
  const visitors = known ?? (await allVisitors());
  const [status, admin] = await Promise.all([publicStatus(visitors), adminState(visitors)]);
  await Promise.all([
    broadcast(LOBBY_TOPIC, 'status', status as unknown as Record<string, unknown>),
    broadcast(adminTopic(), 'state', admin as unknown as Record<string, unknown>),
    sendQueuePositions(visitors),
  ]);
}

async function sendQueuePositions(visitors: VisitorRow[]): Promise<void> {
  const seat = seatOf(visitors);
  const offset = seat?.state === 'invited' ? 1 : 0;
  const queue = queueOf(visitors);
  await Promise.all(
    queue.map((row, index) =>
      broadcast(visitorTopic(row.id), 'queue', {
        position: index + 1 + offset,
        total: queue.length + offset,
      }),
    ),
  );
}

/* ------------------------------ 入退室 ------------------------------ */

const HANDLE_CHARS = '甲乙丙丁戊己庚辛壬癸';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function makeHandle(): string {
  return `来訪者 ${HANDLE_CHARS[Math.floor(Math.random() * HANDLE_CHARS.length)]}`;
}

/**
 * 入口に立った人に、名前代わりの匿名IDを渡す。
 *
 * ここではまだ表に載せない。入口を眺めているだけの人が
 * 「お待ちの方」に数えられてしまうのを避けるため、
 * 実際に行を作るのは入室を押したときにする。
 */
export async function hello(
  existingId: string | null,
): Promise<{
  id: string;
  handle: string;
  state: string;
  session_id: string | null;
  entered_at?: string | null;
  joined_at?: string | null;
}> {
  // 名乗られたIDは、こちらが配ったものとは限らない。
  // uuid の形をしていなければ問い合わせず、新しいIDを配る。
  if (existingId && UUID.test(existingId)) {
    const { data } = await db()
      .from('visitors')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', existingId)
      .select('*')
      .maybeSingle();
    if (data) return data as VisitorRow;
    // 表から消えていても、同じIDを名乗り続けてもらう
    return { id: existingId, handle: makeHandle(), state: 'idle', session_id: null };
  }
  return { id: crypto.randomUUID(), handle: makeHandle(), state: 'idle', session_id: null };
}

export async function heartbeat(visitorId: string): Promise<boolean> {
  const { data } = await db()
    .from('visitors')
    .update({ last_seen_at: new Date().toISOString() })
    .eq('id', visitorId)
    .select('id')
    .maybeSingle();
  return Boolean(data);
}

/**
 * 順番待ちに並ぶ。
 *
 * 空いていても、ここでは入室させない。**誰をいつ通すかは神父が決める**。
 * 来訪者にとっては「押したら並ぶ」の一手だけになり、
 * 神父にとっては、心の準備ができてから一人ずつ迎えられる。
 */
export async function enter(
  visitorId: string,
): Promise<{ ok: boolean; sessionId?: string; reason?: string }> {
  await sweep();

  if (!(await fatherOnline())) {
    return { ok: false, reason: 'ただいま神父は不在です。文章でお預かりします。' };
  }

  // 既に部屋に居る人（二重に押した・戻ってきた）は、その部屋へ戻す
  const { data: current } = await db()
    .from('visitors')
    .select('state, session_id')
    .eq('id', visitorId)
    .maybeSingle();
  if (current?.state === 'active' && current.session_id) {
    return { ok: true, sessionId: current.session_id };
  }

  const { handle, isNew } = await enroll(visitorId);
  if (isNew) {
    // 待機所の鐘を鳴らすのはここ。空席のときも必ず神父に知らせが行く。
    await broadcast(adminTopic(), 'arrived', { handle, queued: true });
  }
  await publish();
  return { ok: false, reason: 'queued' };
}

/** 並ぶと押した時点で、はじめて表に載せる。戻り値は名前と、新しく並んだかどうか。 */
async function enroll(visitorId: string): Promise<{ handle: string; isNew: boolean }> {
  const { data } = await db()
    .from('visitors')
    .select('id, handle')
    .eq('id', visitorId)
    .maybeSingle();

  if (data) {
    await db()
      .from('visitors')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', visitorId);
    return { handle: data.handle, isNew: false };
  }

  const handle = makeHandle();
  await db().from('visitors').insert({ id: visitorId, handle, state: 'queued' });
  return { handle, isNew: true };
}

/** 一意索引に弾かれた = 誰かが先に座った */
const SEAT_TAKEN = '23505';

async function startSession(
  visitorId: string,
): Promise<{ ok: boolean; sessionId?: string; reason?: string }> {
  const sessionId = crypto.randomBytes(12).toString('base64url');

  /*
    「空いているか確かめてから座る」では、関数が並列に起動する環境で
    二人が同時に座れてしまう。visitors には state='active' の部分一意索引が
    張ってあるので、二人目の UPDATE はデータベース側で必ず弾かれる。
    ここではそのエラーを「満室だった」として読み替える。
  */
  const { data, error } = await db()
    .from('visitors')
    .update({
      state: 'active',
      session_id: sessionId,
      entered_at: new Date().toISOString(),
      invite_expires_at: null,
      last_seen_at: new Date().toISOString(),
    })
    .eq('id', visitorId)
    .select('handle')
    .maybeSingle();

  if (error) {
    if (error.code === SEAT_TAKEN) return { ok: false, reason: 'queued' };
    console.error('[state] 入室に失敗:', error.message);
    return { ok: false, reason: 'いま入室できませんでした。少し置いてお試しください。' };
  }
  if (!data) return { ok: false, reason: 'この席はもうありません。' };

  await broadcast(visitorTopic(visitorId), 'ready', { sessionId });
  await broadcast(adminTopic(), 'arrived', { handle: data.handle, queued: false });
  await publish();
  return { ok: true, sessionId };
}

export async function acceptInvite(
  visitorId: string,
): Promise<{ ok: boolean; sessionId?: string; reason?: string }> {
  const { data } = await db()
    .from('visitors')
    .select('state')
    .eq('id', visitorId)
    .maybeSingle();
  if (data?.state !== 'invited') return { ok: false, reason: 'ご案内の期限が切れています。' };
  return startSession(visitorId);
}

/**
 * 神父が、待っている人ひとりに入室を案内する。
 *
 * 押した瞬間に部屋へ放り込まないのは、席を離れているかもしれないため。
 * 決めた秒数のあいだ返事を待ち、無ければ列に戻して、次の人を呼べるようにする。
 */
export async function invite(visitorId: string): Promise<{ ok: boolean; reason?: string }> {
  await sweep();

  if (!(await fatherOnline())) {
    return { ok: false, reason: 'いまは不在の扱いです。先にオンラインにしてください。' };
  }

  const busy = await activeVisitor();
  if (busy && busy.id !== visitorId) {
    return {
      ok: false,
      reason:
        busy.state === 'active'
          ? 'いま対応中の方がいます。終えてからお呼びください。'
          : 'ほかの方をご案内中です。',
    };
  }

  const seconds = (await siteConfig()).inviteTimeoutSeconds;
  const { data, error } = await db()
    .from('visitors')
    .update({
      state: 'invited',
      invite_expires_at: new Date(Date.now() + seconds * 1000).toISOString(),
      last_seen_at: new Date().toISOString(),
    })
    .eq('id', visitorId)
    .eq('state', 'queued')
    .select('id')
    .maybeSingle();

  if (error) {
    if (error.code === SEAT_TAKEN) return { ok: false, reason: 'ほかの方をご案内中です。' };
    console.error('[state] 案内に失敗:', error.message);
    return { ok: false, reason: 'お呼びできませんでした。' };
  }
  if (!data) return { ok: false, reason: 'この方は、もう列にいません。' };

  await broadcast(visitorTopic(visitorId), 'invite', { expiresInSeconds: seconds });
  await publish();
  return { ok: true };
}

export async function leave(visitorId: string, reason: string, notify: boolean): Promise<void> {
  const { data } = await db()
    .from('visitors')
    .delete()
    .eq('id', visitorId)
    .select('state, entered_at, session_id')
    .maybeSingle();

  if (data?.state === 'active' && data.entered_at) {
    await recordSession((Date.now() - ms(data.entered_at)) / 1000);
    if (data.session_id) {
      await broadcast(roomTopic(data.session_id), 'closed', { reason });
    }
  }
  if (notify) await broadcast(visitorTopic(visitorId), 'closed', { reason });

  await sweep();
  await publish();
}

/* ------------------------------ 設定と集計 ------------------------------ */

export async function siteConfig(): Promise<{ replyEtaDays: number; inviteTimeoutSeconds: number }> {
  const { data } = await db()
    .from('site_config')
    .select('reply_eta_days, invite_timeout_seconds')
    .eq('id', 1)
    .maybeSingle();
  return {
    replyEtaDays: data?.reply_eta_days ?? 3,
    inviteTimeoutSeconds: data?.invite_timeout_seconds ?? 60,
  };
}

export async function updateSiteConfig(patch: {
  replyEtaDays?: number;
  inviteTimeoutSeconds?: number;
}) {
  const update: Record<string, number> = {};
  if (Number.isFinite(patch.replyEtaDays)) {
    update.reply_eta_days = Math.max(1, Math.min(60, Math.round(patch.replyEtaDays as number)));
  }
  if (Number.isFinite(patch.inviteTimeoutSeconds)) {
    update.invite_timeout_seconds = Math.max(
      10,
      Math.min(600, Math.round(patch.inviteTimeoutSeconds as number)),
    );
  }
  if (Object.keys(update).length > 0) {
    await db().from('site_config').update(update).eq('id', 1);
  }
  return siteConfig();
}

function today(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

async function statsToday() {
  const date = today();
  const { data } = await db()
    .from('daily_stats')
    .select('date, sessions, total_duration_seconds')
    .eq('date', date)
    .maybeSingle();
  return data ?? { date, sessions: 0, total_duration_seconds: 0 };
}

async function recordSession(durationSeconds: number): Promise<void> {
  const current = await statsToday();
  await db().from('daily_stats').upsert({
    date: current.date,
    sessions: current.sessions + 1,
    total_duration_seconds: current.total_duration_seconds + Math.max(0, Math.round(durationSeconds)),
  });
}

async function unreadLetters(): Promise<number> {
  const { count } = await db()
    .from('letters')
    .select('id', { count: 'exact', head: true })
    .is('read_at', null);
  return count ?? 0;
}
