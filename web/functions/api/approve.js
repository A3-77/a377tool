/* GET  /api/approve?token=xxx  -> 确认页（不改任何状态）
   POST /api/approve            -> 真正执行通过 / 拒绝
   GET  /api/approve            -> 待审批列表（需要 ADMIN_TOKEN） */
import { ensureTables } from './_ddl.js';
import { json, fail, needSecret, ensureSeed, SEATS, timingSafeEqual } from './_lib.js';

export async function onRequestGet({ request, env }){
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  const key   = url.searchParams.get('key');

  /* --- 没带 token：进入管理页（需要 ADMIN_TOKEN）--- */
  if(!token){
    if(!env.ADMIN_TOKEN) return html(page('未配置管理口令',
      '请用 <code>wrangler pages secret put ADMIN_TOKEN</code> 设置后再访问。'));
    if(!key || !timingSafeEqual(key, env.ADMIN_TOKEN))
      return html(loginish(), 401);
    return html(await adminPage(env, key));
  }

  /* --- 带 token：只显示确认页，绝不改状态 --- */
  const row = await env.DB.prepare(
    'select id, username, seat, note, status, token_exp from users where approve_token = ?'
  ).bind(token).first();

  if(!row) return html(page('链接无效', '这个审批链接不存在，或者已经被用过了。'));
  if(row.token_exp && row.token_exp < Date.now())
    return html(page('链接已过期', '审批链接 7 天有效，请让对方重新提交申请，或者到 <a href="/api/admin">管理页</a> 处理。'));
  if(row.status !== 'pending')
    return html(page('已经处理过了',
      `「${esc(row.username)}」当前状态是 <b>${row.status}</b>，不需要再操作。`));

  /* 谁占着这个席位（决定确认页要不要提前说清后果） */
  const occupant = await env.DB.prepare(
    "select username from users where seat = ? and status='active' and id <> ? limit 1"
  ).bind(row.seat, row.id).first();

  return html(confirmPage(row, token, occupant ? occupant.username : null));
}

export async function onRequestPost({ request, env }){
  let form;
  try{ form = await request.formData(); }catch(e){ return fail('请求格式错误'); }
  const token  = String(form.get('token')||'');
  const action = String(form.get('action')||'');

  if(!token)  return html(page('缺少令牌', '请从邮件里的链接重新进入。'), 400);
  if(!['accept','reject'].includes(action)) return html(page('未知操作', ''), 400);

  const row = await env.DB.prepare(
    'select id, username, seat, status, token_exp from users where approve_token = ?'
  ).bind(token).first();

  if(!row) return html(page('链接无效', '这个链接不存在或已经被用过了。'));
  if(row.token_exp && row.token_exp < Date.now()) return html(page('链接已过期', ''));
  if(row.status !== 'pending')
    return html(page('已经处理过了', `「${esc(row.username)}」当前状态是 <b>${row.status}</b>。`));

  if(action === 'accept'){
    /* 席位冲突：内置测试账号会一直占着席位，所以不能直接报错把人挡回去。
       管理员在确认页上已经看到「会停用谁」，这里照着执行。 */
    const taken = await env.DB.prepare(
      "select id, username from users where seat = ? and status='active' and id <> ? limit 1"
    ).bind(row.seat, row.id).first();
    if(taken){
      await env.DB.prepare("update users set status='rejected' where id = ?").bind(taken.id).run();
    }
    await env.DB.prepare(
      'update users set status = ?, approve_token = null, token_exp = null, approved_at = ? where id = ?'
    ).bind('active', Date.now(), row.id).run();

    return html(page('✅ 已通过',
      `「${esc(row.username)}」（${SEATS[row.seat]||row.seat}）现在可以登录了。`
      + (taken ? `<br><br>原来占着这个席位的「${esc(taken.username)}」已停用。` : '')));
  }

  /* 令牌一次性：处理完就作废，防重放 */
  await env.DB.prepare(
    'update users set status = ?, approve_token = null, token_exp = null, approved_at = ? where id = ?'
  ).bind('rejected', Date.now(), row.id).run();

  return html(page('已拒绝', `「${esc(row.username)}」的申请已拒绝。`));
}

/* ============================ 页面 ============================ */
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const shell = (title, body) => `<!doctype html><html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>
 :root{color-scheme:dark}
 body{margin:0;background:#0a0d14;color:#e6ebf4;font:15px/1.8 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;
   display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
 .box{max-width:520px;width:100%;background:#12161f;border-radius:14px;padding:28px}
 h1{font-size:20px;margin:0 0 14px}
 p{color:#8b97ab;margin:0 0 14px}
 b{color:#e6ebf4} code{background:#1e2431;padding:2px 6px;border-radius:5px;font-size:13px}
 a{color:#6f9ad0}
 .row{display:flex;gap:10px;margin-top:22px;flex-wrap:wrap}
 button{padding:13px 26px;border:none;border-radius:999px;font-size:15px;font-weight:600;cursor:pointer}
 .yes{background:#5fd39a;color:#08120d}
 .no{background:#1e2431;color:#8b97ab}
 table{width:100%;border-collapse:collapse;font-size:14px}
 td{padding:8px 0;border-bottom:1px solid #1e2431;color:#8b97ab}
 td:last-child{color:#e6ebf4;text-align:right}
</style><div class="box">${body}</div></html>`;

const page = (t,b) => shell(t, `<h1>${esc(t)}</h1><p>${b}</p>`);

function confirmPage(row, token, occupant){
  return shell('确认注册申请', `
    <h1>确认通过这个申请？</h1>
    <table>
      <tr><td>用户名</td><td><b>${esc(row.username)}</b></td></tr>
      <tr><td>申请席位</td><td><b>${esc(SEATS[row.seat]||row.seat)}</b></td></tr>
      ${row.note?`<tr><td>说明</td><td>${esc(row.note)}</td></tr>`:''}
    </table>
    ${occupant ? `<div style="background:#3a2f12;color:#e0c48f;padding:14px 16px;border-radius:10px;margin:18px 0">
      这个席位现在是 <b>${esc(occupant)}</b> 在用。<br>
      点「停用…并通过」会先把 <b>${esc(occupant)}</b> 停掉，然后把席位给 ${esc(row.username)}。
    </div>` : ''}
    <p style="margin-top:20px">下面这一步点了才会真的生效。</p>
    <form method="POST" action="/api/approve">
      <input type="hidden" name="token" value="${esc(token)}">
      <div class="row">
        <button class="yes" name="action" value="accept">${occupant ? `停用 ${esc(occupant)} 并通过` : '确认通过'}</button>
        <button class="no"  name="action" value="reject">拒绝</button>
      </div>
    </form>`);
}

async function adminPage(env, key){
  const pend = (await env.DB.prepare(
    "select id, username, seat, note, approve_token from users where status='pending' order by created_at desc"
  ).all()).results || [];
  const act = (await env.DB.prepare(
    "select id, username, seat, status, created_at from users where status <> 'pending' order by seat, created_at"
  ).all()).results || [];

  const pendHtml = pend.length
    ? `<table>${pend.map(r=>`<tr>
         <td>${esc(r.username)} · ${esc(SEATS[r.seat]||r.seat)}${r.note?`<br><span style="font-size:12px">${esc(r.note)}</span>`:''}</td>
         <td style="white-space:nowrap">
           <form method="POST" action="/api/approve" style="display:inline">
             <input type="hidden" name="token" value="${esc(r.approve_token||'')}">
             <button class="yes" name="action" value="accept" style="padding:7px 16px;font-size:13px">通过</button>
           </form>
           <form method="POST" action="/api/approve" style="display:inline">
             <input type="hidden" name="token" value="${esc(r.approve_token||'')}">
             <button class="no" name="action" value="reject" style="padding:7px 16px;font-size:13px">拒绝</button>
           </form>
         </td></tr>`).join('')}</table>`
    : `<p>现在没有待审批的申请。</p>`;

  /* 两个内置测试账号会一直占着席位。要让真人进来，先在这里停用对应的测试号。 */
  const actHtml = act.length
    ? `<table>${act.map(r=>`<tr>
         <td>${esc(r.username)} · ${esc(SEATS[r.seat]||r.seat)}
           <span style="font-size:12px;color:${r.status==='active'?'#5fd39a':'#5d6779'}">${r.status==='active'?'使用中':'已停用'}</span>
         </td>
         <td style="white-space:nowrap">
           <form method="POST" action="/api/admin" style="display:inline">
             <input type="hidden" name="key" value="${esc(key)}">
             <input type="hidden" name="uid" value="${esc(r.id)}">
             <input type="hidden" name="to" value="${r.status==='active'?'rejected':'active'}">
             <button class="${r.status==='active'?'no':'yes'}" style="padding:7px 16px;font-size:13px">
               ${r.status==='active'?'停用（腾出席位）':'恢复'}
             </button>
           </form>
         </td></tr>`).join('')}</table>`
    : '';

  return shell('注册审批', `
    <h1>待审批（${pend.length}）</h1>${pendHtml}
    <h1 style="margin-top:30px;font-size:16px">账号与席位</h1>
    <p style="font-size:13px">同名席位只能有一个「使用中」。内置的测试账号会占着席位 ——
       真人注册通过后，在这里把测试号停用，席位就让出来了。</p>
    ${actHtml}
    <p style="margin-top:22px;font-size:12px;color:#5d6779">这个页面需要 ADMIN_TOKEN，链接别外传。</p>`);
}

function loginish(){
  return shell('需要口令', `
    <h1>管理页</h1>
    <p>这个页面需要管理口令。直接在地址后面加上 <code>?key=你的ADMIN_TOKEN</code> 再打开。</p>
    <form method="GET" action="/api/approve">
      <div class="row">
        <input name="key" placeholder="ADMIN_TOKEN" style="flex:1;padding:12px 14px;border-radius:10px;
          border:1px solid #2b3444;background:#0a0d14;color:#e6ebf4;font-size:15px">
        <button class="yes">进入</button>
      </div>
    </form>`);
}

function html(body, status=200){
  return new Response(body, { status, headers:{ 'Content-Type':'text/html; charset=utf-8', 'Cache-Control':'no-store' } });
}




