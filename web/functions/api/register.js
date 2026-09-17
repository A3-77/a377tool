/* POST /api/register  { username, password, seat, note }
   写入 pending，给管理员发一封带「确认页」链接的邮件。
   注意：邮件里的链接是 GET 到确认页，真正的通过/拒绝是 POST——
   因为 Gmail / Outlook / Defender 会主动预取邮件 URL，
   如果 GET 直接改状态，每一个注册（包括垃圾注册）都会被自动通过。 */
import { ensureTables } from './_ddl.js';
import { json, fail, hashPassword, b64url, needSecret, ensureSeed, SEATS } from './_lib.js';

export async function onRequestPost({ request, env }){
  const bad = needSecret(env); if(bad) return fail(bad, 500);
  try{ await ensureTables(env); }catch(e){ return fail('数据库未就绪：'+e.message, 500); }
  try{ await ensureSeed(env); }catch(e){ return fail('数据库未就绪：'+e.message, 500); }

  let body;
  try{ body = await request.json(); }catch(e){ return fail('请求格式错误'); }
  const username = String(body.username||'').trim();
  const password = String(body.password||'');
  const seat     = String(body.seat||'').trim();
  const note     = String(body.note||'').slice(0,200);

  if(username.length < 2 || username.length > 20) return fail('用户名 2~20 个字符');
  if(password.length < 3) return fail('密码至少 3 位');
  if(!SEATS[seat]) return fail('请选择你是哪一方');

  /* 席位占用不再硬拦 —— 内置测试账号会一直占着两个席位，
     硬拦的话真实用户永远注册不进来。
     改成把冲突写进邮件和管理页，由管理员决定停用哪个旧账号。 */
  const taken = await env.DB.prepare(
    "select username from users where seat = ? and status = 'active' limit 1"
  ).bind(seat).first();
  const seatConflict = taken ? taken.username : null;

  const dup = await env.DB.prepare('select id, status from users where username = ?').bind(username).first();
  if(dup){
    if(dup.status === 'pending')  return fail('这个名字已经提交过申请了，等管理员审核');
    if(dup.status === 'rejected') return fail('这个名字之前被拒过，换个名字');
    return fail('用户名已被占用');
  }

  const id = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2,8);
  const token = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  const ph = await hashPassword(password);

  await env.DB.prepare(
    `insert into users (id, username, password, seat, status, note, approve_token, token_exp, created_at)
     values (?, ?, ?, ?, 'pending', ?, ?, ?, ?)`
  ).bind(id, username, ph, seat, note, token, now + 7*864e5, now).run();

  const origin = new URL(request.url).origin;
  const link = `${origin}/api/approve?token=${token}`;

  /* 邮件发不出去也不能让注册失败 —— 用户仍然可以通过 /api/admin 手工通过 */
  let mailed = false, mailErr = '';
  if(env.RESEND_KEY && env.ADMIN_EMAIL){
    try{
      const r = await fetch('https://api.resend.com/emails', {
        method:'POST',
        headers:{ Authorization:`Bearer ${env.RESEND_KEY}`, 'Content-Type':'application/json' },
        body: JSON.stringify({
          from: env.MAIL_FROM || 'onboarding@resend.dev',
          to: [env.ADMIN_EMAIL],
          subject: `【见面地推荐】${username} 申请注册（${SEATS[seat]}）`,
          html: mailHtml({ username, seat, note, link, origin, seatConflict }),
        }),
      });
      mailed = r.ok;
      if(!r.ok) mailErr = (await r.text()).slice(0,200);
    }catch(e){ mailErr = e.message; }
  } else {
    mailErr = '未配置 RESEND_KEY / ADMIN_EMAIL';
  }
  if(!mailed) console.log('[register] 邮件未发出:', mailErr, '| 审批链接:', link);

  return json({ ok:true, mailed, mailErr, seatConflict, message: mailed
    ? '申请已提交，等管理员在邮箱里点确认'
    : '申请已提交。邮件没发出去，请让管理员到 /api/admin 手工通过' });
}

function mailHtml({ username, seat, note, link, origin, seatConflict }){
  const esc = s => String(s).replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
  return `<!doctype html><meta charset="utf-8">
  <div style="font:15px/1.8 -apple-system,'PingFang SC',sans-serif;max-width:520px;color:#222">
    <h2 style="margin:0 0 6px">新的注册申请</h2>
    <p style="color:#666;margin:0 0 18px">周末去哪见面 · 双人版</p>
    <table style="border-collapse:collapse;font-size:15px">
      <tr><td style="padding:4px 14px 4px 0;color:#888">用户名</td><td><b>${esc(username)}</b></td></tr>
      <tr><td style="padding:4px 14px 4px 0;color:#888">申请席位</td><td><b>${esc(SEATS[seat]||seat)}</b></td></tr>
      ${note?`<tr><td style="padding:4px 14px 4px 0;color:#888">说明</td><td>${esc(note)}</td></tr>`:''}
    </table>
    ${seatConflict ? `<p style="background:#3a2f12;color:#e0c48f;padding:12px 14px;border-radius:8px;margin:16px 0">
      ⚠️ <b>${esc(seatConflict)}</b> 现在占着「${esc(SEATS[seat]||seat)}」这个席位。
      要通过这个申请，请先到 <a href="${origin}/api/admin" style="color:#e0c48f">管理页</a> 把原来那个停用。</p>` : ''}
    <p style="margin:24px 0 8px">点下面的按钮会打开一个确认页面，<b>那一步不会直接生效</b>，页面里再点一次才会真的通过。</p>
    <p style="margin:0 0 6px"><a href="${link}"
      style="display:inline-block;background:#2f6ad0;color:#fff;padding:12px 26px;border-radius:8px;
             text-decoration:none;font-weight:600">打开确认页 →</a></p>
    <p style="color:#999;font-size:13px;margin-top:22px">
      链接 7 天内有效，只能用一次。如果按钮点不开，把下面这行粘到浏览器：<br>
      <span style="word-break:break-all;color:#666">${link}</span>
    </p>
    <p style="color:#bbb;font-size:12px;margin-top:18px">
      收不到审批邮件时，也可以直接访问 <a href="${origin}/api/admin" style="color:#2f6ad0">${origin}/api/admin</a> 手工处理。
    </p>
  </div>`;
}


