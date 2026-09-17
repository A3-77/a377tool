/* =========================================================================
   共用工具：密码哈希 / 会话签名 / JSON 响应 / D1 助手
   下划线开头的文件不会被 Pages 路由成接口
   ========================================================================= */

import { ensureTables } from './_ddl.js';

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------- 编解码 ---------- */
export function b64url(bytes){
  let s='';
  const a=new Uint8Array(bytes);
  for(let i=0;i<a.length;i++) s+=String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
export function unb64url(str){
  const s=str.replace(/-/g,'+').replace(/_/g,'/');
  const bin=atob(s+'='.repeat((4-s.length%4)%4));
  const out=new Uint8Array(bin.length);
  for(let i=0;i<bin.length;i++) out[i]=bin.charCodeAt(i);
  return out;
}
export const hex = buf => [...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
export function unhex(s){
  const out=new Uint8Array(s.length/2);
  for(let i=0;i<out.length;i++) out[i]=parseInt(s.substr(i*2,2),16);
  return out;
}

/* ---------- 密码：PBKDF2-SHA256 ---------- */
/* Cloudflare Workers 的 Web Crypto 对 PBKDF2 迭代数有上限（100000），
   超过会直接抛 "iteration counts above 100000 are not supported"。
   本地 wrangler dev 不校验这个，只有部署到线上才暴露。 */
const ITER = 100000;
export async function hashPassword(pw, saltHex, iter = ITER){
  const salt = saltHex ? unhex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name:'PBKDF2', salt, iterations:iter, hash:'SHA-256' }, key, 256);
  return `pbkdf2$${iter}$${hex(salt)}$${hex(bits)}`;
}
export async function verifyPassword(pw, stored){
  if(!stored) return false;
  const parts = String(stored).split('$');
  /* 兼容：早期明文（只可能出现在手工插入的行上），验证通过后调用方应立即升级 */
  if(parts[0] !== 'pbkdf2') return stored === pw;
  /* 用哈希串里存的迭代数验证，这样以后调 ITER 不会把老密码全废掉 */
  const iter = parseInt(parts[1], 10) || ITER;
  const saltHex = parts[2];
  const again = await hashPassword(pw, saltHex, iter);
  return timingSafeEqual(again, stored);
}
/* 定长比较，避免计时侧信道 */
export function timingSafeEqual(a, b){
  const A=enc.encode(String(a)), B=enc.encode(String(b));
  if(A.length!==B.length) return false;
  let d=0;
  for(let i=0;i<A.length;i++) d|=A[i]^B[i];
  return d===0;
}

/* ---------- 会话：HMAC 签名的 cookie ---------- */
const COOKIE='sid';
const TTL = 30*24*3600;   // 30 天

async function hmacKey(secret){
  return crypto.subtle.importKey('raw', enc.encode(secret), {name:'HMAC',hash:'SHA-256'}, false, ['sign','verify']);
}
export async function signSession(payload, secret){
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig  = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(body));
  return body + '.' + b64url(sig);
}
export async function readSession(token, secret){
  if(!token) return null;
  const i = token.lastIndexOf('.');
  if(i < 0) return null;
  const body = token.slice(0,i), sig = token.slice(i+1);
  let ok=false;
  try{
    ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64url(sig), enc.encode(body));
  }catch(e){ return null; }
  if(!ok) return null;
  try{
    const p = JSON.parse(dec.decode(unb64url(body)));
    if(!p.exp || p.exp < Math.floor(Date.now()/1000)) return null;
    return p;
  }catch(e){ return null; }
}
/* 线上必须 Secure；本地 127.0.0.1 / localhost 下带 Secure 浏览器和 curl 都不回传，
   所以按 hostname 判断。这是本地开发唯一放宽的地方。 */
export function isLocalHost(url){
  try{
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '[::1]' || h === '::1';
  }catch(e){ return false; }
}
export function sessionCookie(token, maxAge=TTL, secure=true){
  return `${COOKIE}=${token}; Path=/; HttpOnly;${secure?' Secure;':''} SameSite=Lax; Max-Age=${maxAge}`;
}
export function clearCookie(secure=true){
  return `${COOKIE}=; Path=/; HttpOnly;${secure?' Secure;':''} SameSite=Lax; Max-Age=0`;
}
export function getCookie(req, name=COOKIE){
  const c = req.headers.get('Cookie') || '';
  const m = c.match(new RegExp('(?:^|;\\s*)'+name+'=([^;]*)'));
  return m ? m[1] : null;
}

/* ---------- 响应 ---------- */
export const json = (data, init={}) => new Response(JSON.stringify(data), {
  ...init,
  headers: { 'Content-Type':'application/json; charset=utf-8', 'Cache-Control':'no-store', ...(init.headers||{}) },
});
export const fail = (msg, code=400) => json({ ok:false, error:msg }, { status:code });

/* ---------- 环境检查 ---------- */
export function needSecret(env){
  const s = env.SESSION_SECRET;
  if(!s || s.length < 16){
    /* 故意不提供不安全的默认值 —— 静默用弱密钥比直接报错危险得多 */
    return 'SESSION_SECRET 未配置或过短（至少 16 字符）。用 `wrangler pages secret put SESSION_SECRET` 设置。';
  }
  return null;
}

/* ---------- 当前登录用户 ---------- */
export async function currentUser(req, env){
  const t = getCookie(req);
  const s = await readSession(t, env.SESSION_SECRET || '');
  if(!s || !s.uid) return null;
  try{
    const row = await env.DB.prepare(
      'select id, username, seat, status, created_at from users where id = ?'
    ).bind(s.uid).first();
    if(!row || row.status !== 'active') return null;
    return row;
  }catch(e){ return null; }
}

/* ---------- 席位 ---------- */
export const SEATS = { nj:'南京方', hs:'黄石方' };

/* ---------- 行程归属 ----------
   新行程把 created_by 写成 user.id；旧数据里 created_by 是 seat，所以两种都认。 */
export async function getOwnedTrip(env, id, user){
  if(!id || !user) return null;
  return env.DB.prepare(
    'select * from trips where id = ? and (created_by = ? or created_by = ?)'
  ).bind(id, user.id, user.seat).first();
}

/* ---------- 首次运行时种下两个测试账号 ---------- */
export async function ensureSeed(env){
  await ensureTables(env);                    // 表不在这个 D1 实例里就现建
  const { results } = await env.DB.prepare('select count(*) as n from users').all();
  if(results?.[0]?.n > 0) return false;
  const rows = [
    { id:'usr_nj', username: env.SEED_NJ_NAME || '南京', pw: env.SEED_NJ_PW || '111', seat:'nj' },
    { id:'usr_hs', username: env.SEED_HS_NAME || '黄石', pw: env.SEED_HS_PW || '222', seat:'hs' },
  ];
  for(const r of rows){
    const ph = await hashPassword(r.pw);
    await env.DB.prepare(
      `insert or ignore into users (id, username, password, seat, status, created_at)
       values (?, ?, ?, ?, 'active', ?)`
    ).bind(r.id, r.username, ph, r.seat, Date.now()).run();
  }
  return true;
}



