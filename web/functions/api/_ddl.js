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
  /* ---------- 首页展示组件 ----------
     一行一个组件，config 存 JSON。enabled 决定前台是否渲染。
     参数体系照搬 DialKit 的控件分类（slider / toggle / text / select / color /
     pad / spring / folder），后台管理页按同一套渲染，改完存这里，前台读 /api/site。
     用 text 存整块 JSON 而不是拆表：组件只有一个、每次整体覆盖写，拆表没收益。 */
  `create table if not exists site_blocks (
    kind       text primary key,
    enabled    integer not null default 0,
    config     text not null default '{}',
    updated_at integer not null
  )`,
];

/* 首次建表时种下的默认内容。`insert or ignore` 保证只在缺失时写入，
   之后在后台改过的值不会被覆盖回去。 */
const SHOWCASE = '/assets/showcase';

export const DEFAULT_BLOCKS = {
  gallery: {
    enabled: 1,
    config: {
      items: [
        { src: SHOWCASE + '/g1.svg', title: '文件工具箱' },
        { src: SHOWCASE + '/g2.svg', title: '生图工作台' },
        { src: SHOWCASE + '/g3.svg', title: '周末去哪见面' },
        { src: SHOWCASE + '/g4.svg', title: '批量处理' },
        { src: SHOWCASE + '/g5.svg', title: '数据看板' },
        { src: SHOWCASE + '/g6.svg', title: '离线优先' },
        { src: SHOWCASE + '/g7.svg', title: '账户与席位' },
        { src: SHOWCASE + '/g8.svg', title: '主题系统' },
      ],
      /* 几何不写死 px：半径和卡片尺寸都由容器宽度反解，
         所以这些是「比例 / 数量」而不是绝对尺寸，换屏幕宽度不会跑偏。
         改这里之前先看 assets/showcase.js 里的推导注释。 */
      perView: 6,          // 一屏可见卡片数 —— 决定卡片多大
      angleStep: 15,       // 相邻卡片的夹角 —— 越大弯得越厉害
      aspect: 1.5,         // 卡片宽高比
      speed: 6,            // 自动旋转速度（度/秒），0 = 不自动转
      dim: 0.55,           // 越靠边压暗越多
      bg: '#000000',
      drag: true,
      pauseOnHover: true,
    },
  },
  photostack: {
    enabled: 0,            // 默认关闭，在后台一键打开
    config: {
      title: 'Japan',
      subtitle: 'December 2025',
      front: SHOWCASE + '/ps-front.svg',
      back: SHOWCASE + '/ps-back.svg',
      shape: 'portrait',   // portrait | landscape | square
      shadowTint: '#000000',
      width: 320,          // 照片宽度上限（px），窄屏自动缩
      offsetX: 96,         // 背片错位量
      offsetY: 0,
      scale: 0.9,          // 背片相对正片的缩放
      /* 背片上的压暗层。给到 0.5 以上背片就基本看不出是张照片了，
         0.3 左右既能拉开层次又能看清内容。 */
      overlayOpacity: 0.32,
      shadowBlur: 60,
      shadowOpacity: 0.45,
      spring: { type: 'time', duration: 0.5, bounce: 0.41 },
      darkMode: false,
    },
  },
};

let ddlDone = false;
export async function ensureTables(env){
  if(ddlDone) return;
  for(const sql of DDL) await env.DB.prepare(sql).run();
  for(const [kind, def] of Object.entries(DEFAULT_BLOCKS)){
    await env.DB.prepare(
      'insert or ignore into site_blocks (kind, enabled, config, updated_at) values (?, ?, ?, ?)'
    ).bind(kind, def.enabled, JSON.stringify(def.config), Date.now()).run();
  }
  ddlDone = true;
}
