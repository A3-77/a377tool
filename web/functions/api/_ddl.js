/* =========================================================================
   建表语句（与 schema.sql 一致）
   放在应用里而不是只放 SQL 文件，是为了：
     · 本地 wrangler pages dev 的 D1 实例和 d1 execute 的实例不一定是同一个，
       靠手工跑 SQL 很容易出现"表不在这个库里"的坑
     · 部署时少一步，首次请求自动建好
   CREATE TABLE IF NOT EXISTS 是幂等的，每个 isolate 只用跑一次。
   ========================================================================= */
export const DDL = [
  `create table if not exists users (
    id            text primary key,
    username      text unique not null,
    password      text not null,
    seat          text not null,
    status        text not null default 'pending',
    note          text,
    approve_token text,
    token_exp     integer,
    created_at    integer not null,
    approved_at   integer
  )`,
  `create index if not exists idx_users_seat  on users(seat, status)`,
  `create index if not exists idx_users_token on users(approve_token)`,
  `create table if not exists trips (
    id          text primary key,
    title       text not null,
    status      text not null default 'planning',
    state       text not null,
    rev         integer not null default 1,
    created_by  text,
    created_at  integer not null,
    updated_at  integer not null,
    updated_by  text
  )`,
  `create index if not exists idx_trips_updated on trips(updated_at desc)`,
  `create table if not exists trip_events (
    id         integer primary key autoincrement,
    trip_id    text not null,
    seat       text not null,
    kind       text not null,
    payload    text not null default '{}',
    created_at integer not null
  )`,
  `create index if not exists idx_events_trip on trip_events(trip_id, created_at desc)`,
];

let ddlDone = false;
export async function ensureTables(env){
  if(ddlDone) return;
  for(const sql of DDL) await env.DB.prepare(sql).run();
  ddlDone = true;
}
