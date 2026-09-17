/* POST /api/admin  { key, uid, to }  —— 停用 / 恢复账号（腾出席位） */
import { ensureTables } from './_ddl.js';
import { needSecret, timingSafeEqual } from './_lib.js';

export async function onRequestPost({ request, env }){
  const bad = needSecret(env); if(bad) return html(page('配置错误', bad), 500);
  try{ await ensureTables(env); }catch(e){ return html(page('数据库未就绪', e.message), 500); }

  let form;
  try{ form = await request.formData(); }catch(e){ return html(page('请求格式错误',''), 400); }
  const key = String(form.get('key')||'');
  const uid = String(form.get('uid')||'');
  const to  = String(form.get('to')||'');

  if(!env.ADMIN_TOKEN || !key || !timingSafeEqual(key, env.ADMIN_TOKEN))
    return html(page('口令不对', '从管理页重新进入。'), 401);
  if(!['active','rejected'].includes(to)) return html(page('未知操作',''), 400);

  const row = await env.DB.prepare('select username from users where id = ?').bind(uid).first();
  if(!row) return html(page('账号不存在',''), 404);

  await env.DB.prepare('update users set status = ? where id = ?').bind(to, uid).run();

  return new Response(null, { status:302, headers:{ Location:`/api/approve?key=${encodeURIComponent(key)}` } });
}

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const page = (t,b) => new Response(
  `<!doctype html><meta charset="utf-8"><title>${esc(t)}</title>
   <body style="background:#0a0d14;color:#e6ebf4;font:15px/1.8 -apple-system,'PingFang SC',sans-serif;padding:40px">
   <h1 style="font-size:20px">${esc(t)}</h1><p style="color:#8b97ab">${b}</p>
   <a href="/api/approve" style="color:#6f9ad0">← 回到管理页</a></body>`,
  { status:200, headers:{ 'Content-Type':'text/html; charset=utf-8' } });

const html = (body, status) => new Response(body, { status, headers:{ 'Content-Type':'text/html; charset=utf-8' } });
