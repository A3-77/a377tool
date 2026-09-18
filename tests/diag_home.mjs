/* 快速看首页当前渲染：SHOWCASE 实际位置、hero 段在哪个坐标 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] || "https://a377.xyz").replace(/\/$/, "");
const OUT = path.join(__dirname, "out_diag");
import fs from "node:fs";
fs.mkdirSync(OUT, { recursive: true });

const CHROME =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ].find((p) => fs.existsSync(p));

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 800 });
await page.goto(BASE, { waitUntil: "networkidle2", timeout: 60000 });
/* 默认测 one 皮肤（用户截图用的）。要测 classic 把 "one" 改成 "classic"。 */
await page.evaluate(() => {
  try { localStorage.setItem("a377skin", "one"); } catch (e) {}
});
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 1500));

const layout = await page.evaluate(() => {
  function pos(sel) {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    /* getBoundingClientRect + scrollY 给绝对位置，不受 offsetParent 影响 */
    return {
      sel,
      top: Math.round(r.top + window.scrollY),
      height: Math.round(r.height),
      visible: getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none" && r.height > 0,
      text: (el.innerText || "").slice(0, 50).replace(/\s+/g, " ").trim(),
    };
  }
  return {
    skin: document.documentElement.getAttribute("data-skin"),
    scrollH: document.documentElement.scrollHeight,
    viewH: window.innerHeight,
    sections: [
      pos("header.hero"),
      pos(".wrap.classic"),
      pos("[data-view=\"one\"]"),
      pos("[data-showcase]"),
      pos("[data-view=\"classic\"] [data-showcase]"),
      pos("footer"),
      pos(".cell.foot"),
    ],
  };
});

console.log("皮肤: " + layout.skin);
console.log("总高: " + layout.scrollH + "px,  视口: " + layout.viewH + "px");
console.log("");
console.log("元素           top        高        简略文字");
console.log("─".repeat(72));
layout.sections.forEach((s) => {
  if (!s) { console.log("  (缺失)"); return; }
  console.log(
    (s.sel + " ").padEnd(15) +
    String(s.top).padEnd(11) +
    String(s.height).padEnd(10) +
    " " + s.text
  );
});

await page.screenshot({ path: path.join(OUT, "home-full.png"), fullPage: true });
await page.screenshot({ path: path.join(OUT, "home-view.png"), fullPage: false });
await browser.close();
console.log("\n截图: tests/out_diag/home-full.png  (整页)");
console.log("     tests/out_diag/home-view.png  (视口)");