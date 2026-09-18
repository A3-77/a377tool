/* 端到端：对「已在用的素材」重新截取一段。
   和 test_clip.mjs 的区别：那边是上传时顺带问一句，这边是用户主动改
   已经传上去的东西 —— 走的是 fetch 回来 → 选段 → 处理 → 再上传 → 换 src。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] || "http://127.0.0.1:8791").replace(/\/$/, "");
const TOKEN = process.argv[3] || "localdevtoken";
const VIDEO = process.argv[4] || path.join(__dirname, "fixtures", "long12s.mp4");
const OUT = path.join(__dirname, "out_diag");
fs.mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].find((p) => fs.existsSync(p));

let pass = 0, fail = 0;
const check = (name, ok, extra) => {
  if (ok) { pass++; console.log("  ✓ " + name); }
  else { fail++; console.log("  ✗ " + name + (extra ? "   ← " + extra : "")); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
const errors = [];
page.on("pageerror", (e) => errors.push("[pageerror] " + e.message));

await page.goto(`${BASE}/api/site-admin?key=${encodeURIComponent(TOKEN)}`, {
  waitUntil: "networkidle2", timeout: 60000,
});
await sleep(2000);

/* ---------- 0. 先确保列表里有一个视频项 ---------- */
console.log("=== 0. 准备一个已在用的视频素材 ===");
let hasVideo = await page.evaluate(() => {
  return [...document.querySelectorAll(".ops .iconbtn")].some((b) => b.title === "截取一段");
});

if (!hasVideo) {
  console.log("  列表里还没有视频，先传一个");
  const up = await page.evaluateHandle(() =>
    [...document.querySelectorAll(".list-head .btn")].find((x) => /上传/.test(x.textContent || "")));
  const chooserP = page.waitForFileChooser({ timeout: 15000 });
  await up.evaluate((b) => b.click());
  const chooser = await chooserP;
  await chooser.accept([VIDEO]);
  /* 12 秒会弹选段，用默认（前 8 秒）就行 */
  try {
    await page.waitForSelector(".clip-mask", { timeout: 30000 });
    await page.evaluate(() => {
      [...document.querySelectorAll(".clip-acts .btn")].find((x) => /用这段/.test(x.textContent)).click();
    });
  } catch (e) { /* 没弹就算了 */ }
  for (let i = 0; i < 60; i++) {
    await sleep(2000);
    const t = await page.evaluate(() => {
      const x = document.querySelector(".toast");
      return x && x.classList.contains("on") ? x.textContent : null;
    });
    if (t) { console.log("  上传反馈: " + t); break; }
  }
  await sleep(1000);
  hasVideo = await page.evaluate(() =>
    [...document.querySelectorAll(".ops .iconbtn")].some((b) => b.title === "截取一段"));
}
check("列表里有可截取的视频项", hasVideo, hasVideo ? "" : "没有视频素材就没法测");
if (!hasVideo) { await browser.close(); process.exit(1); }

/* ---------- 1. 点截取 ---------- */
console.log("\n=== 1. 对已在用的素材点「截取」 ===");
const srcBefore = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".ops .iconbtn")].find((x) => x.title === "截取一段");
  const item = b.closest(".item");
  const inp = item.querySelector("input[type=text]");
  return inp ? inp.value : null;
});
console.log("  当前 src: " + srcBefore);

await page.evaluate(() => {
  [...document.querySelectorAll(".ops .iconbtn")].find((x) => x.title === "截取一段").click();
});

let opened = false;
try { await page.waitForSelector(".clip-mask", { timeout: 40000 }); opened = true; } catch (e) { opened = false; }
check("点「截取」弹出选段框", opened, opened ? "" : "可能 fetch 素材失败或读不出时长");

if (!opened) {
  const st = await page.evaluate(() => {
    const t = document.querySelector(".toast");
    return t && t.classList.contains("on") ? t.textContent : null;
  });
  if (st) console.log("  页面反馈: " + st);
  errors.forEach((e) => console.log("  " + e));
  await page.screenshot({ path: path.join(OUT, "reclip-fail.png") });
  await browser.close();
  process.exit(1);
}

const info = await page.evaluate(() => ({
  text: document.querySelector(".clip-box").innerText.replace(/\s+/g, " ").slice(0, 180),
  dur: document.querySelector(".clip-video").duration,
}));
console.log("  框内: " + info.text);
check("把已有素材读回来了（有视频预览）", info.dur > 0, "duration=" + info.dur);
await page.screenshot({ path: path.join(OUT, "reclip-open.png") });

/* ---------- 2. 选一段 ---------- */
console.log("\n=== 2. 选段 ===");
/* 先试整体挪动。但素材比上限短时，选区默认就占满全长 ——
   那种情况根本没有挪的空间，能做的是拖手柄把它缩短。两种都算通过。 */
const before = await page.evaluate(() => ({
  left: document.querySelector(".clip-sel").style.left,
  width: document.querySelector(".clip-sel").style.width,
}));
const box = await page.evaluate(() => {
  const r = document.querySelector(".clip-sel").getBoundingClientRect();
  const t = document.querySelector(".clip-track").getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: t.width };
});
await page.mouse.move(box.x, box.y);
await page.mouse.down();
await page.mouse.move(box.x + box.w * 0.25, box.y, { steps: 10 });
await page.mouse.up();
await sleep(300);
let now = await page.evaluate(() => ({
  left: document.querySelector(".clip-sel").style.left,
  width: document.querySelector(".clip-sel").style.width,
}));

if (now.left !== before.left) {
  check("拖动选区挪动位置", true, `${before.left} → ${now.left}`);
} else {
  console.log("  · 选区已占满全长（素材比上限短），改验「拖手柄缩短」");
  const hb = await page.evaluate(() => {
    const r = document.querySelector(".clip-handle.r").getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  await page.mouse.move(hb.x, hb.y);
  await page.mouse.down();
  await page.mouse.move(hb.x - 80, hb.y, { steps: 8 });
  await page.mouse.up();
  await sleep(300);
  now = await page.evaluate(() => ({
    left: document.querySelector(".clip-sel").style.left,
    width: document.querySelector(".clip-sel").style.width,
  }));
  check("拖手柄能缩短选区", parseFloat(now.width) < parseFloat(before.width),
    `${before.width} → ${now.width}`);
}

await page.evaluate(() => {
  [...document.querySelectorAll(".clip-acts .btn")].find((x) => /用这段/.test(x.textContent)).click();
});

/* ---------- 3. 等处理 + 重新上传 ---------- */
console.log("\n=== 3. 处理并换掉素材 ===");
let toast = null;
for (let i = 0; i < 90; i++) {
  await sleep(2000);
  toast = await page.evaluate(() => {
    const t = document.querySelector(".toast");
    return t && t.classList.contains("on") ? t.textContent : null;
  });
  if (toast && /截取|失败/.test(toast)) break;
}
check("给出结果反馈", !!toast, toast ? "" : "等了 180 秒没反馈");
if (toast) console.log("  反馈: " + toast);
check("没报失败", !!toast && !/失败/.test(toast), toast || "");

const srcAfter = await page.evaluate(() => {
  const b = [...document.querySelectorAll(".ops .iconbtn")].find((x) => x.title === "截取一段");
  if (!b) return null;
  const item = b.closest(".item");
  const inp = item.querySelector("input[type=text]");
  return inp ? inp.value : null;
});
console.log("  新 src: " + srcAfter);
check("素材地址被换成了新的", !!srcAfter && srcAfter !== srcBefore,
  srcBefore === srcAfter ? "src 没变，说明没替换成功" : "");

await page.screenshot({ path: path.join(OUT, "reclip-done.png") });

console.log("\n=== 控制台错误 ===");
if (!errors.length) console.log("  （无）");
else errors.forEach((e) => console.log("  " + e));
check("没有 JS 报错", errors.length === 0);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
