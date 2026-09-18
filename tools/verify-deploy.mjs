/* =========================================================================
   部署校验：线上跑的到底是不是当前这份代码？
     node tools/verify-deploy.mjs                  # 默认查 https://a377.xyz
     node tools/verify-deploy.mjs https://xxx.pages.dev

   为什么需要这个：
     Pages 对不存在的路径会**回落到 index.html 并返回 200**。所以
     「/assets/video-prep.js 不存在」在浏览器和 curl 眼里都是 200 OK，
     只是内容是一整页 HTML。光看状态码会以为一切正常 ——
     实际线上可能落后好几个提交，功能整个不在。
     这里不看状态码，看 **Content-Type 和内容特征**。

   退出码 0 = 全绿；非 0 = 有缺项（每条都写了该怎么办）。
   ========================================================================= */

const BASE = (process.argv[2] || "https://a377.xyz").replace(/\/+$/, "");

let pass = 0, fail = 0;
const rows = [];

async function get(path) {
  const res = await fetch(BASE + path, { redirect: "follow" });
  const body = await res.text();
  return {
    status: res.status,
    type: (res.headers.get("content-type") || "").toLowerCase(),
    cache: (res.headers.get("cache-control") || "").toLowerCase(),
    body,
  };
}

/* 一条检查。why 说清「这条挂了意味着什么」，不然报告没法用 */
async function check(name, path, want, test, why) {
  let r;
  try {
    r = await get(path);
  } catch (e) {
    fail++;
    rows.push({ ok: false, name, got: "请求失败：" + e.message, why });
    return null;
  }
  const ok = test(r);
  ok ? pass++ : fail++;
  rows.push({
    ok, name,
    got: `HTTP ${r.status} ${r.type.split(";")[0] || "(无类型)"}`,
    why: ok ? "" : why,
    r,
  });
  return r;
}

const isJson = (r) => r.type.includes("json");
const isHtml = (r) => r.type.includes("html");

console.log("部署校验：" + BASE + "\n");

/* ---- 基础可达性 ---- */
await check("首页", "/", null, (r) => r.status === 200 && isHtml(r),
  "首页都打不开，先看 Cloudflare 控制台的部署状态。");

await check("登录态接口活着", "/api/me", null, (r) => r.status === 401 && isJson(r),
  "Functions 没部署，或者返回了 HTML（被劫持 / 没打包上去）。");

await check("管理页鉴权", "/api/site-admin", null, (r) => r.status === 401 && isHtml(r),
  "管理页 Function 没部署。");

/* ---- 素材接口：这组是「上传能不能用」的判据 ----
   Function 不在的时候，Pages 会把 /api/media 回落到首页，返回 200 + HTML。
   所以必须查 Content-Type，查状态码会漏。 */
await check("素材接口已部署", "/api/media", null, (r) => isJson(r),
  "接口不存在（拿到的是 HTML 回落页）。functions/api/media/[[key]].js 没部署上去 —— 重新部署。");

await check("素材读取路由已部署", "/api/media/m/nope.mp4", null, (r) => r.status === 404 && isJson(r),
  "读取路由没部署。上传完前台会读不到素材。");

/* ---- 静态资源：这组是「前端功能在不在」的判据 ----
   文件名带特征串，防止只判「不是 HTML」时被同名占位文件蒙混。 */
await check("视频档位模块已部署", "/assets/video-spec.js", null,
  (r) => r.status === 200 && !isHtml(r) && /VideoSpec/.test(r.body),
  "线上没有这个文件 —— 部署产物是旧的，视频管线还没上过线。");

await check("网页端转码引擎已部署", "/assets/video-prep.js", null,
  (r) => r.status === 200 && !isHtml(r) && /VideoPrep/.test(r.body),
  "线上没有这个文件 —— 视频处理那套代码没部署上去。");

await check("后台上传入口已部署", "/assets/site-admin.js", null,
  (r) => r.status === 200 && !isHtml(r) && /pickFiles/.test(r.body),
  "后台脚本是旧版（缩略图只是个 div，点了没反应）。重新部署 public/。");

/* ---- 缓存头：这组是「部署了但用户拿不到新版」的判据 ----
   Pages 默认给静态资源 max-age=14400（4 小时）。后台脚本是部署产物，
   改了就该立刻生效；默认值会让用户刷新后还是旧版 —— 服务端是对的，
   只有那个浏览器是旧的，比服务端没部署更难查。
   靠 public/_headers 压成 no-cache（用之前先协商，没变就 304）。 */
for (const [name, path] of [
  ["后台脚本", "/assets/site-admin.js"],
  ["后台样式", "/assets/site-admin.css"],
  ["视频档位模块", "/assets/video-spec.js"],
  ["转码引擎", "/assets/video-prep.js"],
]) {
  await check(name + "不缓存（部署后刷新即生效）", path, null,
    (r) => /no-cache|no-store|max-age=0/.test(r.cache),
    "缓存头是长 max-age，public/_headers 没生效 —— 部署后用户刷新会拿到旧版。");
}

/* ---- 报告 ---- */
console.log("检查项".padEnd(22) + "结果");
console.log("─".repeat(74));
for (const row of rows) {
  console.log((row.ok ? "  ✓ " : "  ✗ ") + row.name.padEnd(20) + row.got);
  if (!row.ok) console.log("      → " + row.why);
}

console.log("\n" + (fail ? `✗ ${fail} 项没过，${pass} 项通过` : `✓ ${pass} 项全过，线上就是当前这份代码`));
process.exit(fail ? 1 : 0);
