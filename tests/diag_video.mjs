/* 诊断：上传视频后为什么没走处理。
   prepareVideo 的第一道判断是 window.VideoPrep 存在且 available() 为真，
   否则「原样上传」并给 warn。这里把 available() 的三个条件逐个拆开量，
   看到底卡在哪一个。 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] || "https://a377.xyz").replace(/\/$/, "");
const TOKEN = process.argv[3] || "localdevtoken";

const CHROME =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].find((p) => fs.existsSync(p));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 1000 });
await page.goto(`${BASE}/api/site-admin?key=${encodeURIComponent(TOKEN)}`, {
  waitUntil: "networkidle2",
  timeout: 60000,
});
await new Promise((r) => setTimeout(r, 2000));

const r = await page.evaluate(() => {
  const out = {};
  out.isSecureContext = window.isSecureContext;
  out.hasVideoPrep = typeof window.VideoPrep !== "undefined";
  out.hasVideoSpec = typeof window.VideoSpec !== "undefined";
  out.hasMediaRecorder = typeof MediaRecorder !== "undefined";
  out.hasCaptureStream =
    typeof HTMLCanvasElement !== "undefined" &&
    !!HTMLCanvasElement.prototype.captureStream;

  /* 把 pickMime 的逻辑在外面重跑一遍，看能选中哪个 mime */
  out.mimeTried = [];
  let picked = "";
  if (typeof MediaRecorder !== "undefined") {
    const cands = [
      'video/mp4;codecs="avc1.42E01E"',
      'video/mp4;codecs="avc1.640028"',
      "video/mp4",
      'video/webm;codecs="vp9"',
      'video/webm;codecs="vp8"',
      "video/webm",
    ];
    for (const m of cands) {
      let ok = false;
      try { ok = MediaRecorder.isTypeSupported(m); } catch (e) { ok = "抛错"; }
      out.mimeTried.push(m + " => " + ok);
      if (ok === true && !picked) picked = m;
    }
  }
  out.pickedMime = picked;

  if (window.VideoPrep) {
    try { out.available = window.VideoPrep.available(); }
    catch (e) { out.available = "抛错: " + e.message; }
    out.apiKeys = Object.keys(window.VideoPrep);
  }
  return out;
});

console.log("=== 视频管线可用性 ===");
const line = (k, v, good) =>
  console.log(`  ${good ? "✓" : "✗"} ${k.padEnd(18)} ${v}`);

line("安全上下文", r.isSecureContext, r.isSecureContext);
line("VideoSpec 已加载", r.hasVideoSpec, r.hasVideoSpec);
line("VideoPrep 已加载", r.hasVideoPrep, r.hasVideoPrep);
line("MediaRecorder", r.hasMediaRecorder, r.hasMediaRecorder);
line("captureStream", r.hasCaptureStream, r.hasCaptureStream);
line("选中的 mime", r.pickedMime || "(空 —— available 会是 false)", !!r.pickedMime);
line("VideoPrep.available()", String(r.available), r.available === true);

if (r.apiKeys) console.log("\n  VideoPrep 导出: " + r.apiKeys.join(", "));

console.log("\n=== mime 逐个试 ===");
(r.mimeTried || []).forEach((m) => console.log("  " + m));

await browser.close();

/* 结论提示 */
if (r.available === true) {
  console.log("\n→ 管线可用。那「没处理」另有原因：可能是文件被判定为合规（skipped），"
    + "\n  或体积没到压缩阈值。需要看上传时返回的 note/warn。");
} else {
  console.log("\n→ 管线不可用，视频会原样上传。看上面哪个 ✗ 就是原因。");
}
