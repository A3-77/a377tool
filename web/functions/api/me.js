/* GET /api/me -> 当前登录用户；未登录返回 401 */
import { json, currentUser, clearCookie, ensureSeed, needSecret } from './_lib.js';

export async function onRequestGet({ request, env }){
  const bad = needSecret(env); if(bad) return json({ ok:false, error:bad, setup:true }, { status:500 });

  /* 第一次访问时把两个测试账号种下去，省得手工跑 SQL */
  let seeded=false;
  try{ seeded = await ensureSeed(env); }catch(e){
    return json({ ok:false, error:'数据库还没初始化：'+e.message, setup:true }, { status:500 });
  }

  const u = await currentUser(request, env);
  if(!u){
    const h = { 'Cache-Control':'no-store' };
    if(seeded) h['X-Seeded']='1';
    return json({ ok:false, error:'未登录', seeded }, { status:401, headers:h });
  }
  return json({ ok:true, user:{ id:u.id, username:u.username, seat:u.seat }, seeded });
}
