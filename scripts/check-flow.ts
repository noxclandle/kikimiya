/*
  席と順番の通し確認。

  「同時に一人」「神父が呼ぶまで誰も入らない」は、この作りの背骨にあたる。
  画面から手で確かめるには手数が多く、壊れても気づきにくいので、
  本物のデータベースに向けて一度通してみる。

    npm run check:flow

  実行に使った行と、増えた統計、神父の在室状態は最後に元へ戻す。

  **誰か来ている最中は走らせない。** この確認は席を占め、最後に在室を切り替えるので、
  本物の対話をしている人を追い出してしまう。冒頭で確かめて、居たら何もせず止まる。
*/
import 'dotenv/config';
import {
  acceptInvite,
  enter,
  fatherHeartbeat,
  hello,
  invite,
  leave,
  publicStatus,
  setFatherOnline,
} from '../lib/server/state';
import { db } from '../lib/server/supabase';

let failures = 0;

function check(label: string, ok: boolean, detail?: unknown): void {
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok || detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`);
  if (!ok) failures += 1;
}

const today = () =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());

async function statsRow() {
  const { data } = await db()
    .from('daily_stats')
    .select('*')
    .eq('date', today())
    .maybeSingle();
  return data as { date: string; sessions: number; total_duration_seconds: number } | null;
}

async function main(): Promise<void> {
  const { data: present } = await db().from('visitors').select('id, state');
  if (present && present.length > 0) {
    console.error(
      `いま ${present.length} 名が来ています。この確認は席を使うので、見送ります。\n` +
        '誰もいないときに、もう一度お試しください。',
    );
    process.exit(2);
  }

  const { data: fatherBefore } = await db()
    .from('father_state')
    .select('online')
    .eq('id', 1)
    .maybeSingle();
  const before = await statsRow();

  console.log('神父が在室にする');
  await setFatherOnline(true);
  await fatherHeartbeat();
  check('在室として見える', (await publicStatus()).presence === 'available');

  const a = await hello(null);
  const b = await hello(null);

  console.log('\n二人が並ぶ');
  const enteredA = await enter(a.id);
  check('空いていても入室しない', enteredA.ok === false && enteredA.reason === 'queued', enteredA);
  check('席は空いたまま', (await publicStatus()).occupied === 0);
  await enter(b.id);
  check('二人が列にいる', (await publicStatus()).queueLength === 2);

  console.log('\n神父が二番目の人を先に呼ぶ');
  check('呼べる', (await invite(b.id)).ok);
  check('席が埋まって見える', (await publicStatus()).occupied === 1);
  check('案内中に他の人は呼べない', (await invite(a.id)).ok === false);

  console.log('\n呼ばれた人が入室する');
  const accepted = await acceptInvite(b.id);
  check('部屋が渡される', accepted.ok && Boolean(accepted.sessionId), accepted);
  check('対応中になる', (await publicStatus()).presence === 'busy');
  check('対応中に他の人は呼べない', (await invite(a.id)).ok === false);

  console.log('\n対話が終わる');
  await leave(b.id, '確認', false);
  const afterLeave = await publicStatus();
  check('席が空く', afterLeave.occupied === 0, afterLeave);
  check('自動では誰も入らない', afterLeave.queueLength === 1, afterLeave);

  console.log('\n神父が次の人を呼ぶ');
  check('呼べる', (await invite(a.id)).ok);

  console.log('\n後始末');
  await leave(a.id, '確認', false);
  // 在室の状態も、確認を始める前に戻す
  await setFatherOnline(Boolean(fatherBefore?.online));
  check('誰も残っていない', (await publicStatus()).queueLength === 0);

  // 確認で増えた統計を元に戻す
  if (before) {
    await db().from('daily_stats').upsert(before);
  } else {
    await db().from('daily_stats').delete().eq('date', today());
  }
  check('統計を元に戻した', JSON.stringify(await statsRow()) === JSON.stringify(before));

  console.log(failures === 0 ? '\nすべて通りました。' : `\n${failures} 件、通りませんでした。`);
  process.exit(failures === 0 ? 0 : 1);
}

void main().catch((cause) => {
  console.error('確認の途中で止まりました:', cause);
  process.exit(1);
});
