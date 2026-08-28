-- 聴き宮 — テーブル定義
--
-- Supabase の SQL Editor に貼り付けて実行してください。
-- 何度実行しても壊れないように書いてあります。
--
-- 方針：
--   ブラウザにはテーブルを一切触らせない。
--   すべての読み書きは Vercel 側の関数（秘密鍵を持つ）を通す。
--   そのため全テーブルで RLS を有効にし、ポリシーは1つも作らない。
--   = 公開鍵しか持たないブラウザからは、何も読めず、何も書けない。

-- ------------------------------------------------------------------
-- 神父の在室（常に1行だけ）
-- ------------------------------------------------------------------
create table if not exists father_state (
  id           smallint primary key default 1,
  online       boolean     not null default false,
  -- 待機ページから定期的に更新される。古くなっていれば不在とみなす。
  heartbeat_at timestamptz not null default now(),
  constraint father_state_single_row check (id = 1)
);

insert into father_state (id, online) values (1, false)
on conflict (id) do nothing;

-- ------------------------------------------------------------------
-- 来訪者（揮発。生存信号が途切れたら消える）
-- ------------------------------------------------------------------
create table if not exists visitors (
  id           uuid        primary key default gen_random_uuid(),
  handle       text        not null,
  state        text        not null check (state in ('queued', 'invited', 'active')),
  -- 告解室のURLに使う。部屋にいる間だけ入る。
  session_id   text        unique,
  joined_at    timestamptz not null default now(),
  entered_at   timestamptz,
  last_seen_at timestamptz not null default now(),
  -- 入室を案内した相手が、いつまでに答えるべきか
  invite_expires_at timestamptz
);

create index if not exists visitors_state_joined_idx on visitors (state, joined_at);
create index if not exists visitors_last_seen_idx    on visitors (last_seen_at);

-- 席はひとつしかない。
-- 関数は並列に起動するので「空いているか確認してから座る」では二人入ってしまう。
-- 部分一意索引を置いて、二人目の UPDATE をデータベース側で弾く。
create unique index if not exists visitors_one_active_idx  on visitors (state) where state = 'active';
create unique index if not exists visitors_one_invited_idx on visitors (state) where state = 'invited';

-- ------------------------------------------------------------------
-- 手紙（唯一の永続データ）
-- ------------------------------------------------------------------
create table if not exists letters (
  id         uuid        primary key default gen_random_uuid(),
  -- 来訪者が自分の手紙に戻るための鍵。URLの一部になる。
  token      text        not null unique,
  body       text        not null,
  -- 任意で名乗られた差出人。空のこともある。
  sender     jsonb       not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  read_at    timestamptz,
  replies    jsonb       not null default '[]'::jsonb
);

create index if not exists letters_created_idx on letters (created_at desc);
create index if not exists letters_unread_idx  on letters (read_at) where read_at is null;

-- ------------------------------------------------------------------
-- 連投の抑制（手紙・ログイン試行）
--
-- 誰からの試行かは、IPそのものではなく秘密鍵で HMAC した値で数える。
-- 生のIPはどこにも書かない。
-- ------------------------------------------------------------------
create table if not exists rate_limits (
  id       text        primary key,
  count    integer     not null default 0,
  reset_at timestamptz not null
);

create table if not exists login_attempts (
  id           text        primary key,
  count        integer     not null default 0,
  locked_until timestamptz,
  reset_at     timestamptz not null
);

-- ------------------------------------------------------------------
-- 日次の集計（個人を特定する情報は持たない）
-- ------------------------------------------------------------------
create table if not exists daily_stats (
  date                   date primary key,
  sessions               integer not null default 0,
  total_duration_seconds integer not null default 0
);

-- ------------------------------------------------------------------
-- 設定（返信の目安など。神父が待機ページから変える）
-- ------------------------------------------------------------------
create table if not exists site_config (
  id                     smallint primary key default 1,
  reply_eta_days         integer not null default 3,
  invite_timeout_seconds integer not null default 60,
  constraint site_config_single_row check (id = 1)
);

insert into site_config (id) values (1) on conflict (id) do nothing;

-- ------------------------------------------------------------------
-- 施錠：ブラウザからは何も見えないようにする
-- ------------------------------------------------------------------
alter table father_state   enable row level security;
alter table visitors       enable row level security;
alter table letters        enable row level security;
alter table daily_stats    enable row level security;
alter table site_config    enable row level security;
alter table rate_limits    enable row level security;
alter table login_attempts enable row level security;

-- ポリシーは意図的に1つも作らない。
-- RLS が有効でポリシーが無い = 公開鍵からは一切アクセスできない。
-- サーバー側の秘密鍵だけが RLS を迂回できる。

-- 念のため、公開ロールの権限も明示的に剥がしておく
revoke all on father_state, visitors, letters, daily_stats, site_config,
  rate_limits, login_attempts
  from anon, authenticated;

-- 逆に、サーバー側の役割にははっきり権限を渡す。
-- 「新しいテーブルを自動的に公開する」を切っていると、
-- service_role にも権限が渡らないため、ここで明示する必要がある。
grant usage on schema public to service_role;
grant all privileges on table
  father_state, visitors, letters, daily_stats, site_config,
  rate_limits, login_attempts
  to service_role;
