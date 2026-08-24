/**
 * 緊急・専門の相談窓口。
 *
 * 2026年8月時点で、厚生労働省「まもろうよ こころ」の一覧と照合済み。
 * 番号や受付時間は変わることがあるので、ときどき見直してください。
 *    https://www.mhlw.go.jp/mamorouyokokoro/
 */
export interface Helpline {
  name: string;
  detail: string;
  tel?: string;
  url?: string;
  hours?: string;
}

export const EMERGENCY_LINES: Helpline[] = [
  {
    name: '救急・警察',
    detail: '今まさに命に関わる状況のときは、迷わずこちらへ。',
    tel: '119',
    hours: '24時間',
  },
  {
    name: 'あなたのいばしょ',
    detail: '年齢や性別を問わない匿名のチャット相談。電話が苦手な方に。',
    url: 'https://talkme.jp/',
    hours: '24時間・年中無休',
  },
  {
    name: '#いのちSOS（自殺対策支援センター ライフリンク）',
    detail: 'つらい気持ちを電話で聴いてもらえます。通話料無料。',
    tel: '0120-061-338',
    url: 'https://www.lifelink.or.jp/inochisos/',
    hours: '24時間',
  },
  {
    name: 'よりそいホットライン（社会的包摂サポートセンター）',
    detail: '暮らし・生活・こころ、どんな悩みでも。通話料無料。',
    tel: '0120-279-338',
    url: 'https://www.since2011.net/yorisoi/',
    hours: '24時間',
  },
  {
    name: 'いのちの電話（フリーダイヤル）',
    detail: '通話料無料。毎月10日は24時間つながります。',
    tel: '0120-783-556',
    url: 'https://www.inochinodenwa.org/',
    hours: '毎日 16:00〜21:00 ／ 毎月10日は8:00から24時間',
  },
  {
    name: 'こころの健康相談統一ダイヤル',
    detail: 'お住まいの自治体の相談窓口につながります。通話料がかかります。',
    tel: '0570-064-556',
    hours: '自治体により異なります',
  },
  {
    name: 'チャイルドライン（18歳まで）',
    detail: '子ども・10代のための相談先。通話料無料。',
    tel: '0120-99-7777',
    url: 'https://childline.or.jp/',
    hours: '毎日 16:00〜21:00',
  },
  {
    name: '厚生労働省「まもろうよ こころ」',
    detail: '窓口の一覧。SNS相談の受付時間もこちらから確認できます。',
    url: 'https://www.mhlw.go.jp/mamorouyokokoro/',
  },
];
