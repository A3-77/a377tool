/* =========================================================================
   展示组件管理页
     GET  /api/site-admin?key=TOKEN   -> 控制面板（左侧 iframe 实时预览首页）
     POST /api/site-admin             -> { key, blocks } 保存，或 { key, reset:'gallery' } 恢复默认

   鉴权沿用现有的 ADMIN_TOKEN（和 /api/approve 同一个口令），不新开一套。
   控件渲染在 /assets/site-admin.js，样式在 /assets/site-admin.css ——
   放公开目录是因为里面没有任何密钥，真正的写操作仍然要 token。
   ========================================================================= */
import { ensureTables, DEFAULT_BLOCKS } from './_ddl.js';
import { timingSafeEqual } from './_lib.js';

const KINDS = Object.keys(DEFAULT_BLOCKS);

/* ---------------- 鉴权 ---------------- */
function authed(env, key){
  return !!(env.ADMIN_TOKEN && key && timingSafeEqual(key, env.ADMIN_TOKEN));
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const html = (body, status = 200) => new Response(body, {
  status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
});
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

function errorPage(title, detail, key){
  const back = key ? `<p><a href="/api/site-admin?key=${encodeURIComponent(key)}">← 重试</a></p>` : '';
  return html(`<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>
    <body style="background:#0a0d14;color:#e6ebf4;font:15px/1.8 -apple-system,'PingFang SC',sans-serif;padding:40px">
    <h1 style="font-size:20px">${esc(title)}</h1><p style="color:#8b97ab">${esc(detail)}</p>${back}</body>`, 401);
}

/* ---------------- 读配置 ---------------- */
async function readBlocks(env){
  const { results } = await env.DB.prepare(
    'select kind, enabled, config from site_blocks'
  ).all();
  const out = {};
  for(const row of results || []){
    if(!KINDS.includes(row.kind)) continue;
    let config = {};
    try{ config = JSON.parse(row.config || '{}'); }catch(e){ config = {}; }
    out[row.kind] = { enabled: row.enabled ? 1 : 0, config };
  }
  /* 表里缺哪个组件就用默认值补齐，保证面板上两个都在 */
  for(const kind of KINDS){
    if(!out[kind]) out[kind] = {
      enabled: DEFAULT_BLOCKS[kind].enabled,
      config: JSON.parse(JSON.stringify(DEFAULT_BLOCKS[kind].config)),
    };
  }
  return out;
}

/* ---------------- GET：控制面板 ---------------- */
export async function onRequestGet({ request, env }){
  if(!env.DB) return errorPage('数据库未绑定', 'D1 没绑到这个 Pages 项目上。');
  const key = new URL(request.url).searchParams.get('key') || '';
  if(!env.ADMIN_TOKEN) return errorPage('未配置管理口令',
    '请用 wrangler pages secret put ADMIN_TOKEN 设置后再访问。');
  if(!authed(env, key)) return errorPage('口令不对', '从管理页重新进入。');

  try{ await ensureTables(env); }
  catch(e){ return errorPage('数据库未就绪', e.message, key); }

  let blocks;
  try{ blocks = await readBlocks(env); }
  catch(e){ return errorPage('读取配置失败', e.message, key); }

  /* 注入给前端。把 < 转义掉，免得配置里出现 </script> 把页面截断 */
  const payload = JSON.stringify({ key, blocks }).replace(/</g, '\\u003c');
  const approveUrl = `/api/approve?key=${encodeURIComponent(key)}`;

  return html(`<!doctype html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>展示组件 · 管理</title>
<link rel="stylesheet" href="/assets/site-admin.css">
</head><body>
<div class="shell">
  <div class="stage">
    <iframe id="preview" src="/" title="首页预览"></iframe>
    <div class="stage-bar"><b>实时预览</b>改动立即生效 · 点保存才写库</div>
  </div>
  <div class="panel">
    <div class="top">
      <h1>展示组件<span>渲染在首页 /</span></h1>
      <div class="acts">
        <button class="btn primary" id="save" type="button">保存</button>
        <button class="btn" id="reload" type="button">刷新预览</button>
        <a class="btn" href="${esc(approveUrl)}">账号审批</a>
        <a class="btn" href="/" target="_blank" rel="noopener">打开首页</a>
      </div>
    </div>
    <div id="blocks"></div>
  </div>
</div>
<div class="toast" id="toast"></div>
<script>window.__A377_SITE__ = ${payload};</script>
<!-- 视频档位规范 + 网页端处理引擎。两者都是独立层，和展示组件无关 ——
     以后换掉画廊、上别的视频组件，这两个文件照样能用。 -->
<script src="/assets/video-spec.js"></script>
<script src="/assets/video-prep.js"></script>
<script src="/assets/site-admin.js"></script>
</body></html>`);
}

/* ---------------- POST：保存 / 恢复默认 ---------------- */
export async function onRequestPost({ request, env }){
  if(!env.DB) return json({ ok:false, error:'D1 未绑定' }, 500);

  let body;
  try{ body = await request.json(); }
  catch(e){ return json({ ok:false, error:'请求体不是合法 JSON' }, 400); }

  if(!authed(env, body && body.key)) return json({ ok:false, error:'口令不对' }, 401);

  try{ await ensureTables(env); }
  catch(e){ return json({ ok:false, error:'数据库未就绪：' + e.message }, 500); }

  const now = Date.now();

  /* 恢复默认：只把这一行改回 DEFAULT_BLOCKS，不影响另一个组件 */
  if(body.reset){
    const kind = String(body.reset);
    if(!KINDS.includes(kind)) return json({ ok:false, error:'未知组件：' + kind }, 400);
    const def = DEFAULT_BLOCKS[kind];
    await env.DB.prepare(
      'insert into site_blocks (kind, enabled, config, updated_at) values (?, ?, ?, ?) ' +
      'on conflict(kind) do update set enabled = excluded.enabled, config = excluded.config, updated_at = excluded.updated_at'
    ).bind(kind, def.enabled, JSON.stringify(def.config), now).run();
    return json({ ok:true, blocks: await readBlocks(env) });
  }

  /* 保存：整块覆盖写 */
  const blocks = body.blocks;
  if(!blocks || typeof blocks !== 'object') return json({ ok:false, error:'缺少 blocks' }, 400);

  const jobs = [];
  for(const kind of KINDS){
    const st = blocks[kind];
    if(!st) continue;

    /* 只传 enabled 时只翻开关，不动配置 —— 前台/测试用起来更省事，
       也避免「改个开关要把整份配置回传，漏字段就丢设置」 */
    if(st.config === undefined){
      jobs.push(env.DB.prepare(
        'update site_blocks set enabled = ?, updated_at = ? where kind = ?'
      ).bind(st.enabled ? 1 : 0, now, kind));
      continue;
    }

    if(typeof st.config !== 'object' || st.config === null || Array.isArray(st.config))
      return json({ ok:false, error:`${kind} 的 config 必须是对象` }, 400);
    const raw = JSON.stringify(st.config);
    /* 配置是纯文本存 D1，别让人塞进来一个几兆的字符串 */
    if(raw.length > 512 * 1024) return json({ ok:false, error:`${kind} 的配置过大（>512KB）` }, 400);
    jobs.push(env.DB.prepare(
      'insert into site_blocks (kind, enabled, config, updated_at) values (?, ?, ?, ?) ' +
      'on conflict(kind) do update set enabled = excluded.enabled, config = excluded.config, updated_at = excluded.updated_at'
    ).bind(kind, st.enabled ? 1 : 0, raw, now));
  }
  if(!jobs.length) return json({ ok:false, error:'没有可保存的组件' }, 400);

  try{ await env.DB.batch(jobs); }
  catch(e){ return json({ ok:false, error:'写入失败：' + e.message }, 500); }

  return json({ ok:true, blocks: await readBlocks(env) });
}
