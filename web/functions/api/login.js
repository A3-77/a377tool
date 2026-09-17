/* POST /api/login  { username, password } */
import { ensureTables } from './_ddl.js';
import { json, fail, verifyPassword, hashPassword, signSession, sessionCookie, isLocalHost, needSecret, ensureSeed } from './_lib.js';

export async function onRequestPost({ request, env }){
  const bad = needSecret(env); if(bad) return fail(bad, 500);
  try{ await ensureTables(env); }catch(e){ return fail('数据库未就绪：'+e.message, 500); }
  try{ await ensureSeed(env); }catch(e){ return fail('数据库未就绪：'+e.message, 500); }

  let body;
  try{ body = await request.json(); }catch(e){ return fail('请求格式错误'); }
  const username = String(body.username||'').trim();
  const password = String(body.password||'');
  if(!username || !password) return fail('请填写账号和密码');

  let row;
  try{
    row = await env.DB.prepare(
      'select id, username, password, seat, status from users where username = ?'
    ).bind(username).first();
  }catch(e){ return fail('查询失败：'+e.message, 500); }

  /* 账号不存在和密码错误的提示统一，别泄露哪个账号存在 */
  if(!row) return fail('账号或密码不对', 401);

  const okPw = await verifyPassword(password, row.password);
  if(!okPw) return fail('账号或密码不对', 401);

  /* 老的明文行，验过后顺手升级成 PBKDF2 */
  if(!String(row.password).startsWith('pbkdf2$')){
    const ph = await hashPassword(password);
    await env.DB.prepare('update users set password = ? where id = ?').bind(ph, row.id).run();
  }

  if(row.status === 'pending')  return fail('账号还在等管理员审核，通过后就能登录了', 403);
  if(row.status === 'rejected') return fail('这次申请没有通过', 403);

  const exp = Math.floor(Date.now()/1000) + 30*24*3600;
  const token = await signSession({ uid:row.id, seat:row.seat, exp }, env.SESSION_SECRET);

  return json(
    { ok:true, user:{ id:row.id, username:row.username, seat:row.seat } },
    { headers:{ 'Set-Cookie': sessionCookie(token, undefined, !isLocalHost(request.url)) } }
  );
}


