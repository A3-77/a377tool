// 模拟浏览器的完整使用流程：登录 -> 拉行程 -> 新建 -> 再拉
// 用真实的 fetch + cookie 传递，比 curl 更接近浏览器行为
const BASE = 'https://a377.xyz';

let cookie = '';
let pass = 0, fail = 0;
const check = (ok, msg) => { console.log((ok ? '  [OK] ' : '  [XX] ') + msg); ok ? pass++ : fail++; };

async function req(method, path, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (cookie) headers['Cookie'] = cookie;

  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: 'manual',
  });

  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];

  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  return { status: res.status, ok: res.ok, data, raw: text };
}

async function main() {
  console.log('=== 1. 未登录时访问 ===');
  let r = await req('GET', '/api/me');
  check(r.status === 401, `/api/me -> HTTP ${r.status}（应为 401）`);
  check(r.data !== null, `响应是合法 JSON（不是 HTML）`);
  if (r.data === null) {
    console.log('     实际拿到:', r.raw.slice(0, 120));
    return;
  }

  console.log('=== 2. 登录 ===');
  r = await req('POST', '/api/login', { username: '南京', password: '111' });
  check(r.status === 200 && r.data?.ok, `登录 -> HTTP ${r.status}`);
  check(!!cookie, `拿到了会话 cookie：${cookie.slice(0, 28)}…`);

  console.log('=== 3. 带 cookie 拉行程（这就是之前崩掉的地方）===');
  r = await req('GET', '/api/trips');
  check(r.status === 200, `/api/trips -> HTTP ${r.status}`);
  check(Array.isArray(r.data?.trips), `返回了 trips 数组（当前 ${r.data?.trips?.length ?? '?'} 条）`);
  check(!!r.data?.me, `带回了用户信息：${r.data?.me?.username}`);

  console.log('=== 4. 新建行程 ===');
  const before = r.data.trips.length;
  r = await req('POST', '/api/trips', {
    title: '接口自测行程',
    status: 'planning',
    state: { votes: { a: {}, b: {} }, free: { a: [], b: [] } },
  });
  check(r.status === 200 && r.data?.ok, `创建 -> HTTP ${r.status}`);
  const newId = r.data?.id;
  check(!!newId, `返回了新行程 id：${newId}`);

  console.log('=== 5. 再拉一次，确认真的存进去了 ===');
  r = await req('GET', '/api/trips');
  check(r.status === 200, `/api/trips -> HTTP ${r.status}`);
  check(r.data?.trips?.length === before + 1,
        `行程数从 ${before} 变成 ${r.data?.trips?.length}（应 +1）`);
  const created = r.data?.trips?.find(t => t.id === newId);
  check(!!created, `新行程在列表里：${created?.title}`);

  console.log('=== 6. 按 id 拉详情 ===');
  r = await req('GET', '/api/trips?id=' + encodeURIComponent(newId));
  check(r.status === 200 && !!r.data?.trip, `详情 -> HTTP ${r.status}`);
  check(!!r.data?.trip?.state, `state 字段能解析：${JSON.stringify(r.data?.trip?.state).slice(0, 50)}`);

  console.log('=== 7. 登出 ===');
  r = await req('POST', '/api/logout');
  check(r.status === 200, `登出 -> HTTP ${r.status}`);
  cookie = '';
  r = await req('GET', '/api/trips');
  check(r.status === 401, `登出后访问 -> HTTP ${r.status}（应为 401）`);

  console.log();
  console.log(`结果：${pass} 通过, ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('测试异常:', e.message); process.exit(1); });
