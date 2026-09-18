/**
 * 双皮肤回归测试
 * ---------------------------------------------------------------------------
 * 覆盖 6 个页面 × 2 套皮肤 × 2 个主题，检查四类问题：
 *   1. 皮肤是否真的生效（data-skin / 两套视图的显隐）
 *   2. onepage.css 是否只在 one 皮肤下加载（防「覆盖层泄漏到 classic」回归）
 *   3. 顶栏的 SKIN 按钮是否真的能切换（旧版这个按钮没绑事件）
 *   4. 有没有「深底深字」—— 自动算对比度，扫出看不见的文字
 *
 * 用法：
 *   cd tests && npm install          # 需要 puppeteer-core
 *   node test_skins.mjs              # 自带静态服务器，测 web/public
 *   node test_skins.mjs https://a377.xyz   # 也可以直接打线上
 *
 * Windows 上 CHROME 默认找系统 Chrome；没有就设 CHROME_PATH 环境变量。
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "..", "web", "public");

const CHROME =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => fs.existsSync(p));

if (!CHROME) {
  console.error("找不到 Chrome，请设 CHROME_PATH 环境变量指向浏览器可执行文件。");
  process.exit(2);
}

/* [url, 名字, 是否用 onepage.css 覆盖层]
   / 和 /draw/ 的两套皮肤是页面内联样式自带的，不挂覆盖层 */
const PAGES = [
  ["/", "home", false],
  ["/draw/", "draw", false],
  ["/file/", "file", true],
  ["/draw/studio/", "studio", true],
  ["/draw/code0/", "code0", true],
  ["/trips/?local=1", "trips", true],
];
const CASES = [
  ["classic", "light"],
  ["classic", "dark"],
  ["one", "light"],
  ["one", "dark"],
];

/* ------------------------------------------------------------------ */
/* 静态服务器（只在没给外部 URL 时用）                                  */
/* ------------------------------------------------------------------ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

function startServer() {
  const server = http.createServer((req, res) => {
    let rel = decodeURIComponent(req.url.split("?")[0]);
    if (rel.endsWith("/")) rel += "index.html";
    const file = path.join(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404, { "content-type": "text/plain" });
      return res.end("404");
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream" });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

/* ------------------------------------------------------------------ */
/* 页面内执行的探针                                                     */
/* ------------------------------------------------------------------ */
const PROBE = (sel) => {
  const root = document.documentElement;
  const visible = (n) => {
    if (!n) return false;
    const r = n.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const el = sel ? document.querySelector(sel) : null;
  const cs = el ? getComputedStyle(el) : null;
  /* 覆盖层是 <link media="not all">，只有 one 皮肤下 media 才被切成 all */
  const ov = document.getElementById("a377-onepage");
  return {
    skin: root.dataset.skin,
    theme: root.dataset.theme,
    overlay: !!ov && ov.getAttribute("media") !== "not all",
    bar: !!document.querySelector(".a377bar"),
    skinBtn: !!document.querySelector("[data-skin-toggle]"),
    themeBtn: visible(document.querySelector("[data-theme-toggle]")),
    hasSkinApi: typeof window.A377Skin === "object",
    probeVisible: visible(el),
    bg: cs ? cs.backgroundColor : null,
    radius: cs ? cs.borderTopLeftRadius : null,
  };
};

/* 扫「深底深字」：算 WCAG 对比度，低于 2.6 就算可疑 */
const LOW_CONTRAST = () => {
  const lum = (c) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const parse = (s) => {
    const m = String(s).match(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/);
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  };
  const bgOf = (el) => {
    let n = el;
    while (n && n.nodeType === 1) {
      const c = parse(getComputedStyle(n).backgroundColor);
      if (c && c.a > 0.5) return c;
      n = n.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b);
    const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
    return (hi + 0.05) / (lo + 0.05);
  };
  const out = [];
  document.querySelectorAll("body *").forEach((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 6 || r.height < 6) return;
    const s = getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || +s.opacity < 0.3) return;
    if (el.disabled) return;                       // 禁用态本来就该是灰的
    const hasText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) return;
    const fg = parse(s.color);
    if (!fg || fg.a < 0.3) return;
    const bg = bgOf(el);
    const cr = ratio(fg, bg);
    if (cr < 2.6) {
      const cls = el.className && typeof el.className === "string"
        ? "." + el.className.trim().split(/\s+/).join(".") : "";
      out.push({
        sel: el.tagName.toLowerCase() + cls,
        text: (el.textContent || "").trim().slice(0, 20),
        fg: s.color,
        bg: `rgb(${bg.r}, ${bg.g}, ${bg.b})`,
        ratio: +cr.toFixed(2),
      });
    }
  });
  const seen = new Set();
  return out
    .filter((o) => !seen.has(o.sel + o.fg + o.bg) && seen.add(o.sel + o.fg + o.bg))
    .slice(0, 10);
};

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */
const external = process.argv[2];
let server = null;
let BASE = external;
if (!BASE) {
  server = await startServer();
  BASE = `http://127.0.0.1:${server.address().port}`;
  console.log(`静态服务器：${BASE}  (${PUBLIC_DIR})`);
} else {
  console.log(`直接测外部地址：${BASE}`);
}

const fails = [];
const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });

async function newPage(skin, theme) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
  await page.evaluate((s, t) => {
    localStorage.setItem("a377skin", s);
    localStorage.setItem("a377theme", t);
  }, skin, theme);
  return page;
}

console.log("\n页面 / 皮肤 / 主题                  skin  theme overlay bar btn themeBtn");
for (const [url, name, usesOverlay] of PAGES) {
  for (const [skin, theme] of CASES) {
    const page = await newPage(skin, theme);
    await page.goto(BASE + url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 700));

    const info = await page.evaluate(PROBE, null);
    const tag = `${name} / ${skin} / ${theme}`;

    // 1. 皮肤是否生效
    if (info.skin !== skin) fails.push(`${tag}: data-skin=${info.skin}，期望 ${skin}`);
    // 2. 覆盖层只应该在 one 皮肤下生效，且只在该用的页面上
    if (usesOverlay) {
      if (skin === "one" && !info.overlay) fails.push(`${tag}: one 皮肤没启用 onepage.css`);
      if (skin === "classic" && info.overlay) fails.push(`${tag}: classic 皮肤不应启用 onepage.css`);
    } else if (info.overlay) {
      fails.push(`${tag}: 该页自带两套样式，不该挂 onepage.css 覆盖层`);
    }
    // 3. 顶栏与按钮
    if (!info.bar) fails.push(`${tag}: 没有顶栏`);
    if (!info.skinBtn) fails.push(`${tag}: 没有皮肤切换按钮`);
    // 4. one 皮肤只有浅色一套
    if (skin === "one") {
      if (info.theme !== "light") fails.push(`${tag}: one 皮肤下 data-theme 应为 light，实际 ${info.theme}`);
      if (info.themeBtn) fails.push(`${tag}: one 皮肤下深浅色开关应隐藏`);
    } else if (!info.themeBtn) {
      fails.push(`${tag}: classic 皮肤下深浅色开关不应隐藏`);
    }

    console.log(
      `${tag.padEnd(32)} ${String(info.skin).padEnd(8)} ${String(info.theme).padEnd(5)} ` +
      `${info.overlay ? "yes" : "no "}     ${info.bar ? "yes" : "no "} ${info.skinBtn ? "yes" : "no "} ` +
      `${info.themeBtn ? "yes" : "no"}`
    );
    await page.close();
  }
}

/* 点击切换 */
console.log("\n顶栏 SKIN 按钮点击测试");
{
  const page = await newPage("classic", "light");
  await page.goto(BASE + "/file/", { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 600));
  const before = await page.evaluate(() => document.documentElement.dataset.skin);
  await page.click("[data-skin-toggle]");
  await new Promise((r) => setTimeout(r, 300));
  const after = await page.evaluate(() => {
    const ov = document.getElementById("a377-onepage");
    return {
      skin: document.documentElement.dataset.skin,
      overlay: !!ov && ov.getAttribute("media") !== "not all",
      stored: localStorage.getItem("a377skin"),
      label: (document.querySelector("[data-skin-label]") || {}).textContent,
    };
  });
  if (before !== "classic") fails.push(`点击前应为 classic，实际 ${before}`);
  if (after.skin !== "one") fails.push(`点击后应切到 one，实际 ${after.skin}`);
  if (!after.overlay) fails.push("切到 one 后没有启用 onepage.css");
  if (after.stored !== "one") fails.push(`点击后 localStorage 应写入 one，实际 ${after.stored}`);
  console.log(`  classic → ${after.skin}   overlay=${after.overlay}  stored=${after.stored}  label=${after.label}`);

  // 再点一次切回去
  await page.click("[data-skin-toggle]");
  await new Promise((r) => setTimeout(r, 300));
  const back = await page.evaluate(() => {
    const ov = document.getElementById("a377-onepage");
    return {
      skin: document.documentElement.dataset.skin,
      overlay: !!ov && ov.getAttribute("media") !== "not all",
      theme: document.documentElement.dataset.theme,
    };
  });
  if (back.skin !== "classic") fails.push(`再点一次应切回 classic，实际 ${back.skin}`);
  if (back.overlay) fails.push("切回 classic 后 onepage.css 应停用");
  console.log(`  再点一次 → ${back.skin}  overlay=${back.overlay}  theme=${back.theme}`);
  await page.close();
}

/* one 视图的 hover 反色。onepage.css 里 html[data-skin="one"] .tool/.card 带
   background:#fff!important，如果覆盖层被错误地挂到 / 和 /draw/ 上，
   会把这两个页面的 hover 反色效果整个压死。 */
console.log("\none 视图 hover 反色测试");
for (const [url, name, sel] of [["/", "home", ".page .tool"], ["/draw/", "draw", ".page .card"]]) {
  const page = await newPage("one", "light");
  await page.goto(BASE + url, { waitUntil: "domcontentloaded" });
  await new Promise((r) => setTimeout(r, 800));
  const rest = await page.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
  await page.hover(sel);
  await new Promise((r) => setTimeout(r, 350));
  const hov = await page.evaluate((s) => getComputedStyle(document.querySelector(s)).backgroundColor, sel);
  const ok = rest !== hov;
  if (!ok) fails.push(`${name}: one 皮肤下 ${sel} 的 hover 没有反色（${rest} → ${hov}）`);
  console.log(`  ${name.padEnd(6)} ${sel}  ${rest} → ${hov}  ${ok ? "反色 OK" : "没变化 ✗"}`);
  await page.close();
}

/* 低对比度扫描 */
console.log("\n低对比度扫描（深底深字）");
let lowCount = 0;
for (const [url, name] of PAGES) {
  for (const [skin, theme] of CASES) {
    const page = await newPage(skin, theme);
    await page.goto(BASE + url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await new Promise((r) => setTimeout(r, 800));
    const hits = await page.evaluate(LOW_CONTRAST);    if (hits.length) {
      console.log(`\n  [${name} / ${skin} / ${theme}]`);
      hits.forEach((h) => console.log(`    ${h.ratio}  ${h.sel}  fg=${h.fg} bg=${h.bg}  "${h.text}"`));
      lowCount += hits.length;
    }
    await page.close();
  }
}
console.log(`\n  合计 ${lowCount} 处（已知历史遗留见 AGENTS.md，不算失败）`);

await browser.close();
if (server) server.close();

console.log("\n" + "=".repeat(60));
if (fails.length) {
  console.log(`失败 ${fails.length} 项：`);
  fails.forEach((f) => console.log("  ✗ " + f));
  process.exit(1);
}
console.log("全部通过。");
