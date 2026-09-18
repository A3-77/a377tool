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
/* 强制切到 one 皮肤看（用户截图是 one） */
await page.evaluate(() => {
  try { localStorage.setItem("a377skin", "one"); } catch (e) {}
});
await page.reload({ waitUntil: "networkidle2" });
await new Promise((r) => setTimeout(r, 1500));

const layout = await page.evaluate(() => {
  function pos(sel) {
    const el = document.querySelector(sel);
    if (!el) return null;
    /* offsetTop/offsetHeight 不受 transform 影响，更可靠 */
    const r = el.getBoundingClientRect();
    return {
      sel,
      top: Math.round(el.offsetTop),
      height: Math.round(el.offsetHeight),
      clientTop: Math.round(r.top),
      visible: getComputedStyle(el).visibility !== "hidden" && getComputedStyle(el).display !== "none",
      text: (el.innerText || "").slice(0, 50).replace(/\s+/g, " ").trim(),
    };
  }
  return {
    skin: document.documentElement.getAttribute("data-skin"),
    scrollH: document.documentElement.scrollHeight,
    viewH: window.innerHeight,
    sections: [
      pos(".shell header, .top, header"),
      pos(".brand, #brand"),
      pos(".ticker"),
      pos(".intro, section.cell.intro"),
      pos("[data-showcase]"),
      pos(".tools, section.tools, .grid"),
      pos("footer, .foot"),
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