/* 一次性诊断：后台页面到底渲染成什么样。
   用途：用户说「没有上传入口」，但代码里按钮是有的 ——
   要么 JS 抛错了没渲染，要么渲染了但被 CSS 藏了 / 挤没了。
   这个脚本把三种情况一次分开：控制台错误、DOM 里有没有、实际可见性。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] || "http://127.0.0.1:8791").replace(/\/$/, "");
const TOKEN = process.argv[3] || "localdevtoken";
const OUT = path.join(__dirname, "out_diag");
fs.mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].find((p) => fs.existsSync(p));

if (!CHROME) { console.error("找不到 Chrome"); process.exit(2); }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });

/* 控制台错误和加载失败的资源 —— 这是「JS 没执行」的第一现场 */
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push("[console] " + m.text());
});
page.on("pageerror", (e) => errors.push("[pageerror] " + e.message));
page.on("requestfailed", (r) =>
  errors.push("[加载失败] " + r.url() + "  " + (r.failure()?.errorText || ""))
);

const url = `${BASE}/api/site-admin?key=${encodeURIComponent(TOKEN)}`;
console.log("打开 " + url + "\n");
await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 2500));

/* 1. 页面是不是「口令不对」那页 */
const isAuthFail = await page.evaluate(() =>
  /口令不对|未配置管理口令/.test(document.body.innerText)
);
console.log("口令校验: " + (isAuthFail ? "✗ 没进得去（口令不对）" : "✓ 进去了"));

if (isAuthFail) {
  console.log("\n进不去，后面没法查。控制台输出：");
  errors.forEach((e) => console.log("  " + e));
  await browser.close();
  process.exit(1);
}

/* 2. 上传按钮在不在 DOM 里 */
const btns = await page.evaluate(() => {
  const all = [...document.querySelectorAll("button")];
  return all
    .map((b, i) => {
      const r = b.getBoundingClientRect();
      const cs = getComputedStyle(b);
      return {
        i,
        text: (b.textContent || "").trim().slice(0, 20),
        w: Math.round(r.width),
        h: Math.round(r.height),
        display: cs.display,
        visibility: cs.visibility,
        opacity: cs.opacity,
        /* 被祖先 overflow 裁掉的话，元素中心点命中不到它自己 */
        hitSelf: (() => {
          if (!r.width || !r.height) return false;
          const el = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          return !!(el && (el === b || b.contains(el)));
        })(),
      };
    })
    .filter((b) => /上传/.test(b.text));
});

console.log("\n=== 含「上传」的按钮 ===");
if (!btns.length) {
  console.log("  ✗ DOM 里一个都没有 —— 控件压根没渲染（通常是 JS 抛错）");
} else {
  btns.forEach((b) => {
    console.log(
      `  [${b.i}] "${b.text}"  ${b.w}x${b.h}  display=${b.display} vis=${b.visibility} op=${b.opacity} 可点=${b.hitSelf ? "是" : "否"}`
    );
  });
}

/* 3. 素材列表 / 缩略图槽 */
const lists = await page.evaluate(() => ({
  listHead: document.querySelectorAll(".list-head").length,
  thumbSlot: document.querySelectorAll(".thumb-slot").length,
  item: document.querySelectorAll(".item").length,
  block: document.querySelectorAll(".block").length,
}));
console.log("\n=== 页面结构 ===");
console.log(`  .block(组件块)=${lists.block}  .list-head=${lists.listHead}  .item=${lists.item}  .thumb-slot=${lists.thumbSlot}`);

/* 4. 控制台错误 */
console.log("\n=== 控制台/加载错误 ===");
if (!errors.length) console.log("  （无）");
else errors.forEach((e) => console.log("  " + e));

/* 5. 截图 */
const shot = path.join(OUT, "admin.png");
await page.screenshot({ path: shot, fullPage: false });
console.log("\n截图: " + shot);

/* 6. 滚动到第一个素材列表再截一张 —— 上传按钮可能在折叠区里 */
const scrolled = await page.evaluate(() => {
  const h = document.querySelector(".list-head");
  if (!h) return false;
  h.scrollIntoView({ block: "center" });
  return true;
});
if (scrolled) {
  await new Promise((r) => setTimeout(r, 600));
  const shot2 = path.join(OUT, "admin-list.png");
  await page.screenshot({ path: shot2, fullPage: false });
  console.log("列表区截图: " + shot2);
}

await browser.close();
