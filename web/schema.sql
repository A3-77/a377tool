-- ============================================================================
--  周末去哪见面 · D1 (SQLite) 建表脚本
--
--  执行方式（二选一）：
--    wrangler d1 execute meet-db --remote --file=./schema.sql
--    Cloudflare 控制台 → D1 → 你的库 → Console → 粘贴执行
--
--  说明：D1 是 SQLite，没有 jsonb / gen_random_uuid()，所以：
--    · JSON 字段用 text 存
--    · 主键 id 由应用层生成
--    · 时间戳统一用毫秒整数
-- ============================================================================

-- ---------- 用户（含审批状态）----------
create table if not exists users (
  id            text primary key,
  username      text unique not null,
  password      text not null,              -- pbkdf2$次数$盐$哈希，绝不存明文
  seat          text not null,              -- 'nj' | 'hs'，绑定的席位
  status        text not null default 'pending',  -- pending | active | rejected
  note          text,                       -- 申请人自述，方便你判断
  approve_token text,                       -- 一次性审批令牌（32 字节随机）
  token_exp     integer,                    -- 令牌过期时间（毫秒）
  created_at    integer not null,
  approved_at   integer
);
create index if not exists idx_users_seat   on users(seat, status);
create index if not exists idx_users_token  on users(approve_token);

-- ---------- 行程 ----------
--  state 里存整个行程的 JSON（表态/权重/去过/时间窗口/落定信息）。
--  两个人、每次行程一次整块写入，用 JSON 比拆 6 张表少 90% 的代码，
--  而且天然的「行程之间完全隔离」。rev 用来做乐观并发，防止互相覆盖。
create table if not exists trips (
  id          text primary key,
  title       text not null,
  status      text not null default 'planning',   -- planning | pending | locked
  state       text not null,                      -- JSON
  rev         integer not null default 1,         -- 每次写入 +1
  created_by  text,
  created_at  integer not null,
  updated_at  integer not null,
  updated_by  text
);
create index if not exists idx_trips_updated on trips(updated_at desc);

-- ---------- 动态流（"她刚把武汉标了不想去"）----------
create table if not exists trip_events (
  id         integer primary key autoincrement,
  trip_id    text not null,
  seat       text not null,
  kind       text not null,                 -- vote | weight | lock | create
  payload    text not null default '{}',
  created_at integer not null
);
create index if not exists idx_events_trip on trip_events(trip_id, created_at desc);

-- ---------- 首页展示组件（弧形画廊 / Photo Stack）----------
--  kind 是组件标识（gallery | photostack），config 存整块 JSON。
--  enabled 决定前台是否渲染；默认内容由 _ddl.js 的 DEFAULT_BLOCKS 幂等种下，
--  真实内容在 /api/site-admin 管理页里改。
create table if not exists site_blocks (
  kind       text primary key,
  enabled    integer not null default 0,
  config     text not null default '{}',
  updated_at integer not null
);
