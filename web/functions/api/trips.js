/* GET  /api/trips        -> 全部行程（含 rev，用于冲突检测）
   POST /api/trips        -> 新建
   PUT  /api/trips?id=x   -> 整块覆盖，带乐观并发（body.rev 必须等于库里的 rev） */
import { json, fail, currentUser, needSecret, ensureSeed } from './_lib.js';

const MAX_STATE = 200*1024;   // 单个行程状态上限 200KB，防止误传大文件
const seatKey = seat => seat === 'nj' ? 'a' : seat === 'hs' ? 'b' : null;
const same = (left, right) => JSON.stringify(left ?? {}) === JSON.stringify(right ?? {});

export async function onRequestGet({ request, env }){
  const bad = needSecret(env); if(bad) return fail(bad, 500);
  await ensureSeed(env);
  const u = await currentUser(request, env);
  if(!u) return json({ ok:false, error:'未登录' }, { status:401 });

  const url = new URL(request.url);
  const id  = url.searchParams.get('id');

  if(id){
    const t = await env.DB.prepare('select * from trips where id = ?').bind(id).first();
    if(!t) return fail('行程不存在', 404);
    return json({ ok:true, trip: { ...t, state: JSON.parse(t.state) } });
  }
  const { results } = await env.DB.prepare(
    'select id, title, status, rev, created_by, created_at, updated_at, updated_by from trips order by updated_at desc'
  ).all();
  return json({ ok:true, trips: results||[], me:{ id:u.id, seat:u.seat, username:u.username } });
}

export async function onRequestPost({ request, env }){
  const bad = needSecret(env); if(bad) return fail(bad, 500);
  await ensureSeed(env);
  const u = await currentUser(request, env);
  if(!u) return json({ ok:false, error:'未登录' }, { status:401 });

  let body;
  try{ body = await request.json(); }catch(e){ return fail('请求格式错误'); }
  const state = JSON.stringify(body.state || {});
  if(state.length > MAX_STATE) return fail('行程数据过大');

  const id = body.id || ('t' + Date.now().toString(36) + Math.random().toString(36).slice(2,6));
  const now = Date.now();
  await env.DB.prepare(
    `insert into trips (id, title, status, state, rev, created_by, created_at, updated_at, updated_by)
     values (?, ?, ?, ?, 1, ?, ?, ?, ?)`
  ).bind(id, String(body.title||'新行程').slice(0,60),
         body.status||'planning', state, u.seat, now, now, u.seat).run();

  await logEvent(env, id, u.seat, 'create', { title: body.title });
  return json({ ok:true, id, rev:1 });
}

export async function onRequestPut({ request, env }){
  const bad = needSecret(env); if(bad) return fail(bad, 500);
  const u = await currentUser(request, env);
  if(!u) return json({ ok:false, error:'未登录' }, { status:401 });

  const id = new URL(request.url).searchParams.get('id');
  if(!id) return fail('缺少 id');

  let body;
  try{ body = await request.json(); }catch(e){ return fail('请求格式错误'); }

  const cur = await env.DB.prepare('select rev, status, state from trips where id = ?').bind(id).first();
  if(!cur) return fail('行程不存在', 404);

  /* 乐观并发：客户端拿的是旧版本就拒绝，避免一方把另一方的改动盖掉 */
  const expected = Number(body.rev);
  if(Number.isFinite(expected) && expected !== cur.rev){
    return json({ ok:false, error:'stale', rev:cur.rev, state:JSON.parse(cur.state) }, { status:409 });
  }

  const nextState = body.state || {};
  const currentState = JSON.parse(cur.state);
  const me = seatKey(u.seat);
  if(me){
    const them = me === 'a' ? 'b' : 'a';
    if(!same(currentState.votes?.[them], nextState.votes?.[them])
      || !same(currentState.free?.[them], nextState.free?.[them])){
      return fail('不能修改对方的表态或空闲日', 403);
    }

    const nextStatus = body.status || 'planning';
    if(nextStatus !== cur.status){
      const validPending = cur.status === 'planning' && nextStatus === 'pending'
        && nextState.lockedBy === me && nextState.lockedCity;
      const validConfirm = cur.status === 'pending' && nextStatus === 'locked'
        && currentState.lockedBy !== me && nextState.lockedBy === currentState.lockedBy
        && nextState.lockedCity === currentState.lockedCity;
      const validCancel = cur.status === 'pending' && nextStatus === 'planning'
        && currentState.lockedBy === me;
      if(!validPending && !validConfirm && !validCancel){
        return fail('这个行程状态不能由当前身份修改', 403);
      }
    }
  }

  const state = JSON.stringify(nextState);
  if(state.length > MAX_STATE) return fail('行程数据过大');

  const now = Date.now();
  const next = cur.rev + 1;
  await env.DB.prepare(
    `update trips set title = ?, status = ?, state = ?, rev = ?, updated_at = ?, updated_by = ? where id = ?`
  ).bind(String(body.title||'未命名').slice(0,60), body.status||'planning',
         state, next, now, u.seat, id).run();

  /* 记动态，让对方轮询时能看见"她刚改了什么" */
  if(body.event) await logEvent(env, id, u.seat, body.event.kind||'update', body.event.payload||{});

  return json({ ok:true, rev:next, updated_at:now, updated_by:u.seat });
}

export async function onRequestDelete({ request, env }){
  const u = await currentUser(request, env);
  if(!u) return json({ ok:false, error:'未登录' }, { status:401 });
  const id = new URL(request.url).searchParams.get('id');
  if(!id) return fail('缺少 id');
  await env.DB.prepare('delete from trips where id = ?').bind(id).run();
  await env.DB.prepare('delete from trip_events where trip_id = ?').bind(id).run();
  return json({ ok:true });
}

async function logEvent(env, tripId, seat, kind, payload){
  try{
    await env.DB.prepare(
      'insert into trip_events (trip_id, seat, kind, payload, created_at) values (?, ?, ?, ?, ?)'
    ).bind(tripId, seat, kind, JSON.stringify(payload||{}), Date.now()).run();
  }catch(e){}
}

