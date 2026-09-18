/**
 * 生成皮肤对照图：6 个页面 × 3 种状态，用无头 Chrome 截图后拼成一个对照页。
 *
 * 用法：cd tests && node skin-compare/gen.mjs
 * 产出：tests/skin-compare/index.html + shots/*.png（都是生成产物，已在 .gitignore 里）
 *
 * 和 test_skins.mjs 的分工：那个做断言（能不能切、有没有泄漏、对比度够不够），
 * 这个出图给人眼确认「看起来对不对」。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(HERE, "../../web/public");
const SHOTS = path.join(HERE, "shots");
fs.mkdirSync(SHOTS, { recursive: true });

function loadPuppeteer() {
  for (const req of [
    createRequire(path.join(process.cwd(), "__r__.js")),
    createRequire(import.meta.url),
  ]) {
    try { return req("puppeteer-core"); } catch (e) {}
  }
  throw new Error("找不到 puppeteer-core，请在 tests/ 目录下运行");
}
const puppeteer = loadPuppeteer();

const CHROME =
  ["C:/Program Files/Google/Chrome/Application/chrome.exe",
   "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => fs.existsSync(p)) ||
  process.env.CHROME_PATH;

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png" };

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end("404");
  }
  res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const PAGES = [
  ["/", "门户首页"],
  ["/file/", "文件工具箱"],
  ["/draw/", "生图落地页"],
  ["/draw/studio/", "Right Code 工作台"],
  ["/draw/code0/", "Code0 工作台"],
  ["/trips/?local=1", "周末去哪见面"],
];
const STATES = [
  ["classic", "light", "classic · 浅色"],
  ["classic", "dark", "classic · 深色"],
  ["one", "light", "one"],
];

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const cells = [];

for (const [i, [url, label]] of PAGES.entries()) {
  const row = { label, shots: [] };
  for (const [skin, theme, tag] of STATES) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 820, deviceScaleFactor: 1 });
    await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
    await page.evaluate((s, t) => {
      localStorage.setItem("a377skin", s);
      localStorage.setItem("a377theme", t);
    }, skin, theme);
    await page.goto(BASE + url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 1000));
    const file = `p${i}-${skin}-${theme}.png`;
    await page.screenshot({ path: path.join(SHOTS, file) });
    row.shots.push({ tag, file, skin, theme });
    await page.close();
  }
  cells.push(row);
  console.log(`已截图 ${label}`);
}

await browser.close();
server.close();

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>a377tool 皮肤对照</title>
<style>
  :root{--ink:#1c1b19;--dim:#6b6862;--line:#e2dfd5;--accent:#c96442}
  *{box-sizing:border-box}
  body{margin:0;padding:32px 28px 60px;background:#faf9f5;color:var(--ink);
    font:15px/1.65 "Segoe UI","Microsoft YaHei",system-ui,sans-serif}
  h1{margin:0 0 6px;font-size:26px;letter-spacing:-.02em}
  .sub{color:var(--dim);font-size:13.5px;margin:0 0 28px;max-width:70ch}
  .legend{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:26px}
  .legend span{font-size:12px;padding:4px 11px;border:1px solid var(--line);
    border-radius:999px;background:#fff;color:var(--dim)}
  section{margin-bottom:34px}
  h2{font-size:15px;margin:0 0 12px;font-weight:600}
  h2 em{font-style:normal;color:var(--dim);font-weight:400;font-size:13px;margin-left:8px}
  .row{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  figure{margin:0}
  figure img{width:100%;display:block;border:1px solid var(--line);border-radius:10px;background:#fff}
  figcaption{font-size:12px;color:var(--dim);margin-top:7px}
  .note{margin-top:30px;padding:15px 17px;border:1px solid var(--line);border-radius:11px;
    background:#fff;font-size:13px;color:var(--dim)}
  .note b{color:var(--ink)}
  @media(max-width:900px){.row{grid-template-columns:1fr}}
</style></head>
<body>
<h1>a377tool 皮肤对照</h1>
<p class="sub">同一套代码，切 <code>data-skin</code> / <code>data-theme</code> 后的实际渲染结果。
用无头 Chrome 在 1280×820 下截图，未做任何后期处理。</p>
<div class="legend">
  <span>classic = v0.2 原版</span>
  <span>one = One Page Love 黑白网格</span>
  <span>one 皮肤自成浅色配色，不跟随深色主题</span>
</div>
${cells.map((row) => `
<section>
  <h2>${row.label}<em>${row.shots.map((s) => s.tag).join(" · ")}</em></h2>
  <div class="row">
    ${row.shots.map((s) => `<figure><img src="shots/${s.file}" alt="${row.label} ${s.tag}"><figcaption>${s.tag}</figcaption></figure>`).join("")}
  </div>
</section>`).join("")}
<div class="note">
  <b>classic</b> 每一行都还原成 v0.2 的样子（圆角、软阴影、赤陶色点缀），
  深浅色主题都正常。<b>one</b> 是黑白网格 + 硬边框，与 classic 完全隔离。
</div>
</body></html>`;

fs.writeFileSync(path.join(HERE, "index.html"), html, "utf8");
console.log("\n生成：" + path.join(HERE, "index.html"));
