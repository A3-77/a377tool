/* 端到端：上传一个 12 秒视频 → 应该弹选段框 → 拖选区 → 用这段 → 真处理。
   验证的是「视频太长时用户能自己挑一段」，而不是被盲目截开头。 */

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

if (!fs.existsSync(VIDEO)) { console.error("没有测试视频: " + VIDEO); process.exit(2); }

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });

const errors = [];
page.on("pageerror", (e) => errors.push("[pageerror] " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("[console] " + m.text()); });

await page.goto(`${BASE}/api/site-admin?key=${encodeURIComponent(TOKEN)}`, {
  waitUntil: "networkidle2", timeout: 60000,
});
await sleep(2000);

console.log("=== 1. 触发上传 ===");
const upBtn = await page.evaluateHandle(() => {
  const b = [...document.querySelectorAll(".list-head .btn")].find((x) => /上传/.test(x.textContent || ""));
  return b || null;
});
check("找到「＋ 上传」按钮", !!upBtn && (await upBtn.evaluate((e) => !!e)));
if (!upBtn) { await browser.close(); process.exit(1); }

/* pickFiles 建的是临时 input，不在 DOM 里 —— 用 fileChooser 拦截 */
const chooserP = page.waitForFileChooser({ timeout: 15000 });
await upBtn.evaluate((b) => b.click());
let chooser;
try { chooser = await chooserP; check("文件选择器弹出", true); }
catch (e) { check("文件选择器弹出", false, e.message); await browser.close(); process.exit(1); }
await chooser.accept([VIDEO]);

console.log("\n=== 2. 选段框 ===");
let mask = null;
try {
  await page.waitForSelector(".clip-mask", { timeout: 30000 });
  mask = true;
} catch (e) { mask = false; }
check("超长视频弹出选段框", mask, mask ? "" : "没弹 —— 可能 probeFile 没读到时长");

if (!mask) {
  errors.forEach((e) => console.log("  " + e));
  await page.screenshot({ path: path.join(OUT, "clip-fail.png") });
  await browser.close();
  process.exit(1);
}

const info = await page.evaluate(() => {
  const sel = document.querySelector(".clip-sel");
  const box = document.querySelector(".clip-box");
  const vid = document.querySelector(".clip-video");
  return {
    text: (box ? box.innerText : "").replace(/\s+/g, " ").slice(0, 200),
    selLeft: sel ? sel.style.left : "",
    selWidth: sel ? sel.style.width : "",
    hasVideo: !!vid,
    videoDur: vid ? vid.duration : null,
  };
});
console.log("  框内文字: " + info.text);
check("框里有视频预览", info.hasVideo);
check("读到视频时长", info.videoDur > 0, "duration=" + info.videoDur);
check("默认选区不是整条（确实要截）", parseFloat(info.selWidth) < 99,
  "width=" + info.selWidth);
await page.screenshot({ path: path.join(OUT, "clip-open.png") });

console.log("\n=== 3. 拖动选区 ===");
const before = await page.evaluate(() => document.querySelector(".clip-sel").style.left);
/* 抓选区中间拖到右边 —— 避开两端手柄 */
const box = await page.evaluate(() => {
  const r = document.querySelector(".clip-sel").getBoundingClientRect();
  const t = document.querySelector(".clip-track").getBoundingClientRect();
  return { sx: r.left + r.width / 2, sy: r.top + r.height / 2, trackW: t.width, trackL: t.left };
});
await page.mouse.move(box.sx, box.sy);
await page.mouse.down();
await page.mouse.move(box.sx + box.trackW * 0.3, box.sy, { steps: 12 });
await page.mouse.up();
await sleep(400);

const after = await page.evaluate(() => {
  const sel = document.querySelector(".clip-sel");
  return { left: sel.style.left, width: sel.style.width };
});
console.log(`  拖动前 left=${before}  拖动后 left=${after.left}`);
check("拖动改变了选区位置", before !== after.left, `${before} → ${after.left}`);
check("拖动没改变选区长度", after.width === info.selWidth, `${info.selWidth} → ${after.width}`);

/* 再拖右手柄，验证能调长度 */
const hb = await page.evaluate(() => {
  const r = document.querySelector(".clip-handle.r").getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.move(hb.x, hb.y);
await page.mouse.down();
await page.mouse.move(hb.x - 60, hb.y, { steps: 8 });
await page.mouse.up();
await sleep(300);
const after2 = await page.evaluate(() => document.querySelector(".clip-sel").style.width);
check("拖右手柄能改长度", after2 !== after.width, `${after.width} → ${after2}`);

await page.screenshot({ path: path.join(OUT, "clip-moved.png") });

console.log("\n=== 4. 用这段，真处理 ===");
const chosen = await page.evaluate(() => {
  const sel = document.querySelector(".clip-sel");
  return { left: sel.style.left, width: sel.style.width };
});
await page.evaluate(() => {
  const b = [...document.querySelectorAll(".clip-acts .btn")].find((x) => /用这段/.test(x.textContent || ""));
  b.click();
});
console.log("  提交区间: left=" + chosen.left + " width=" + chosen.width);

/* 处理是实时转码，12 秒素材给足时间 */
let done = null;
for (let i = 0; i < 60; i++) {
  await sleep(2000);
  done = await page.evaluate(() => {
    const t = document.querySelector(".toast");
    return t && t.classList.contains("on") ? t.textContent : null;
  });
  if (done) break;
}
check("处理完成并给出反馈", !!done, done ? "" : "等了 120 秒没等到 toast");
if (done) console.log("  反馈: " + done);
check("反馈里说了截了哪段", !!done && /截取|截|秒/.test(done), done || "");

await page.screenshot({ path: path.join(OUT, "clip-done.png") });

console.log("\n=== 控制台错误 ===");
if (!errors.length) console.log("  （无）");
else errors.forEach((e) => console.log("  " + e));
check("没有 JS 报错", errors.filter((e) => /pageerror/.test(e)).length === 0);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
await browser.close();
process.exit(fail ? 1 : 0);
