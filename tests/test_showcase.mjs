/**
 * 首页展示组件（弧形画廊 / Photo Stack）的端到端测试
 * ---------------------------------------------------------------------------
 * 需要先起带 D1 的 wrangler dev：
 *   cd web && npx wrangler pages dev public --d1=DB --persist-to .d1dev --port 8791
 * 然后：
 *   cd tests && node test_showcase.mjs http://127.0.0.1:8791 localdevtoken
 *
 * 覆盖三类事：
 *   1. 接口：/api/site 只吐启用的组件；/api/site-admin 的鉴权、保存、恢复默认
 *   2. 渲染：画廊真的建出来了、卡片按角度分布、边缘压暗生效、切皮肤后还在
 *   3. 交互：Photo Stack 悬停后背片真的动了（弹簧解算在跑），不是静态的
 *
 * 测试结束会把 photostack 恢复成默认关闭，保证可重复跑。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.argv[2] || "http://127.0.0.1:8791").replace(/\/$/, "");
const TOKEN = process.argv[3] || "localdevtoken";
const SHOTS = path.join(__dirname, "out_showcase");
fs.mkdirSync(SHOTS, { recursive: true });

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
  console.error("找不到 Chrome，请设 CHROME_PATH 环境变量。");
  process.exit(2);
}

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra ? "   \u2190 " + extra : "")); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getSite() {
  const r = await fetch(BASE + "/api/site");
  return r.json();
}
async function post(body) {
  const r = await fetch(BASE + "/api/site-admin", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/* ============================ 1. 接口 ============================ */
console.log("\n[1] 接口");

/* 先把两个组件都恢复默认，否则上一次跑剩下的状态会让「默认值」断言误报 */
await post({ key: TOKEN, reset: "gallery" });
await post({ key: TOKEN, reset: "photostack" });

const site0 = await getSite();
check("/api/site 返回 ok", site0.ok === true);
check("默认只吐 gallery（photostack 默认关闭）",
  !!site0.blocks.gallery && !site0.blocks.photostack,
  "blocks = " + Object.keys(site0.blocks).join(","));
check("gallery 默认有 8 张图", (site0.blocks.gallery?.items || []).length === 8);
check("gallery 默认带视觉参数（perView / angleStep / aspect）",
  site0.blocks.gallery?.perView > 0 && site0.blocks.gallery?.angleStep > 0 && site0.blocks.gallery?.aspect > 0,
  JSON.stringify({
    perView: site0.blocks.gallery?.perView,
    angleStep: site0.blocks.gallery?.angleStep,
    aspect: site0.blocks.gallery?.aspect,
  }));

const noKey = await fetch(BASE + "/api/site-admin");
check("管理页无 key → 401", noKey.status === 401, "got " + noKey.status);
const badKey = await fetch(BASE + "/api/site-admin?key=wrong");
check("管理页错 key → 401", badKey.status === 401, "got " + badKey.status);
const okKey = await fetch(BASE + "/api/site-admin?key=" + encodeURIComponent(TOKEN));
check("管理页对 key → 200", okKey.status === 200, "got " + okKey.status);
const adminHtml = await okKey.text();
check("管理页注入了配置 JSON", adminHtml.includes("window.__A377_SITE__"));
check("管理页带预览 iframe", adminHtml.includes('id="preview"'));
check("配置里的 < 被转义（防 </script> 截断）",
  !/window\.__A377_SITE__ = [^;]*<\/script>/.test(adminHtml));

const badPost = await post({ key: "wrong", blocks: {} });
check("POST 错 key → 401", badPost.status === 401, "got " + badPost.status);

const badBody = await post({ key: TOKEN, blocks: { gallery: { enabled: 1, config: "nope" } } });
check("POST config 非对象 → 400", badBody.status === 400, "got " + badBody.status);

/* 打开 Photo Stack —— 只传 enabled，配置走服务端默认值。
   之前这里硬编码整份 config，默认值一改测试就失配，
   而且盖掉了「只翻开关」这条接口路径（本来就是为它加的）。 */
const onRes = await post({ key: TOKEN, blocks: { photostack: { enabled: 1 } } });
check("POST 保存成功", onRes.body?.ok === true);
const site1 = await getSite();
check("保存后 /api/site 立刻包含 photostack", !!site1.blocks.photostack);
check("翻开关没把配置冲掉（标题仍是默认值）", site1.blocks.photostack?.title === "Japan",
  "got " + JSON.stringify(site1.blocks.photostack?.title));

/* ============================ 2. 浏览器渲染 ============================ */
console.log("\n[2] 首页渲染");

const browser = await puppeteer.launch({
  executablePath: CHROME, headless: "new", args: ["--no-sandbox"],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

await page.goto(BASE + "/", { waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => {
    const s = document.querySelector("[data-showcase]:not([hidden])");
    return !!(s && s.querySelector(".a377-gal-card"));
  },
  { timeout: 20000 }
);
/* 卡片是 loading="lazy"，要等图片真的解码完再断言，否则会误判成坏图 */
await page.waitForFunction(
  () => {
    const imgs = [...document.querySelectorAll(".a377-gal-card img")];
    return imgs.length > 0 && imgs.every((i) => i.naturalWidth > 0);
  },
  { timeout: 20000 }
).catch(() => {});

const gal = await page.evaluate(() => {
  const slot = document.querySelector("[data-showcase]:not([hidden])");
  const cards = [...slot.querySelectorAll(".a377-gal-card")];
  const ring = slot.querySelector(".a377-gal-ring");
  const view = slot.querySelector(".a377-gal-viewport");
  const r0 = cards[0]?.getBoundingClientRect();
  return {
    slotInView: slot.closest("[data-view]")?.getAttribute("data-view"),
    cards: cards.length,
    ringTransform: getComputedStyle(ring).transform,
    ringInline: ring.style.transform,
    persp: getComputedStyle(view).perspective,
    firstCardTransform: cards[0]?.style.transform,
    opacities: cards.map((c) => Number(c.style.opacity)),
    imgsLoaded: cards.filter((c) => c.querySelector("img")?.naturalWidth > 0).length,
    cardCssW: parseFloat(getComputedStyle(cards[0]).width),
    containerW: view.getBoundingClientRect().width,
    slotRect: r0 ? { w: Math.round(r0.width), h: Math.round(r0.height) } : null,
  };
});

check("画廊已渲染进当前皮肤的 slot", gal.slotInView === "classic", "slot in " + gal.slotInView);
check("卡片数量 > 0", gal.cards > 0, gal.cards + " 张");
check("ring 用 3D transform 排布", /rotateY/.test(gal.ringInline), gal.ringInline);
check("viewport 有 perspective", gal.persp !== "none", gal.persp);
check("卡片各自带 rotateY", /rotateY/.test(gal.firstCardTransform || ""), gal.firstCardTransform);
check("图片真的加载出来了（不是坏图）", gal.imgsLoaded === gal.cards,
  gal.imgsLoaded + "/" + gal.cards);
check("边缘压暗生效（各卡 opacity 不一致）",
  new Set(gal.opacities.map((o) => o.toFixed(2))).size > 1,
  JSON.stringify(gal.opacities.slice(0, 6)));

/* 自动旋转：转一下再看角度有没有变 */
const rotA = await page.evaluate(() => document.querySelector(".a377-gal-ring").style.transform);
await sleep(700);
const rotB = await page.evaluate(() => document.querySelector(".a377-gal-ring").style.transform);
check("自动旋转在跑（角度在变）", rotA !== rotB, rotA + "  →  " + rotB);

/* 拖拽 */
const box = await page.$(".a377-gal-viewport");
const bb = await box.boundingBox();
await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
await page.mouse.down();
await page.mouse.move(bb.x + bb.width / 2 + 160, bb.y + bb.height / 2, { steps: 8 });
const rotDrag = await page.evaluate(() => document.querySelector(".a377-gal-ring").style.transform);
await page.mouse.up();
check("拖拽能改变角度", rotDrag !== rotB, rotB + "  →  " + rotDrag);

await page.evaluate(() => {
  document.querySelector("[data-showcase]:not([hidden])")
    ?.scrollIntoView({ block: "center" });
});
await sleep(400);
await page.screenshot({ path: path.join(SHOTS, "01-gallery-classic.png") });

/* 切皮肤：节点应该被搬到另一套视图，而不是重建/消失 */
await page.evaluate(() => window.A377Skin && window.A377Skin.set("one"));
await sleep(500);
const afterSkin = await page.evaluate(() => {
  const slot = document.querySelector("[data-showcase]:not([hidden])");
  const view = slot ? slot.querySelector(".a377-gal-viewport") : null;
  const card = slot ? slot.querySelector(".a377-gal-card") : null;
  return {
    inView: slot ? slot.closest("[data-view]")?.getAttribute("data-view") : null,
    cards: slot ? slot.querySelectorAll(".a377-gal-card").length : 0,
    hiddenCount: document.querySelectorAll("[data-showcase][hidden]").length,
    cardCssW: card ? parseFloat(getComputedStyle(card).width) : 0,
    containerW: view ? view.getBoundingClientRect().width : 0,
  };
});
check("切到 one 皮肤后画廊跟着搬过去", afterSkin.inView === "one", "in " + afterSkin.inView);
check("搬运后卡片没丢", afterSkin.cards === gal.cards, afterSkin.cards + " vs " + gal.cards);
check("另一套视图的 slot 是隐藏的", afterSkin.hiddenCount === 1, afterSkin.hiddenCount + " hidden");

/* 响应式回归：两套视图容器宽度不同（classic 是 900px 定宽，one 是全宽），
   卡片尺寸必须跟着变。曾经写死 px 半径和卡片宽度，导致 classic 视图一屏只看得到 ±1 张卡。 */
check("容器宽度确实变了（classic 定宽 → one 全宽）",
  afterSkin.containerW > gal.containerW + 50,
  Math.round(gal.containerW) + "px → " + Math.round(afterSkin.containerW) + "px");
check("卡片尺寸跟着容器宽度缩放（几何是反解的，不是写死 px）",
  afterSkin.cardCssW > gal.cardCssW * 1.1,
  gal.cardCssW.toFixed(1) + "px → " + afterSkin.cardCssW.toFixed(1) + "px");
const rA = gal.cardCssW / gal.containerW, rB = afterSkin.cardCssW / afterSkin.containerW;
check("卡片占容器的比例基本一致（同一套视觉，换个宽度不跑偏）",
  Math.abs(rA - rB) < 0.02, rA.toFixed(3) + " vs " + rB.toFixed(3));
await page.evaluate(() => {
  document.querySelector("[data-showcase]:not([hidden])")
    ?.scrollIntoView({ block: "center" });
});
await sleep(400);
await page.screenshot({ path: path.join(SHOTS, "02-gallery-one.png") });

await page.evaluate(() => window.A377Skin && window.A377Skin.set("classic"));
await sleep(400);

/* ============================ 3. Photo Stack ============================ */
console.log("\n[3] Photo Stack");

await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForFunction(
  () => !!document.querySelector(".a377-ps-stack"),
  { timeout: 20000 }
);
await page.waitForFunction(
  () => [...document.querySelectorAll(".a377-ps-stack img")].every((i) => i.naturalWidth > 0),
  { timeout: 20000 }
).catch(() => {});

const ps0 = await page.evaluate(() => {
  const stack = document.querySelector(".a377-ps-stack");
  const back = stack.querySelector(".a377-ps-back");
  const front = stack.querySelector(".a377-ps-front");
  const veil = stack.querySelector(".a377-ps-veil");
  const sr = stack.getBoundingClientRect();
  const br = back.getBoundingClientRect();
  const fr = front.getBoundingClientRect();
  return {
    title: document.querySelector(".a377-ps-meta h3")?.textContent,
    sub: document.querySelector(".a377-ps-meta p")?.textContent,
    backTransform: back.style.transform,
    frontShadow: getComputedStyle(front).boxShadow,
    veilBg: veil.style.background,
    imgsLoaded: [...stack.querySelectorAll("img")].filter((i) => i.naturalWidth > 0).length,
    stackW: Math.round(sr.width),
    stackH: Math.round(sr.height),
    /* 静止时背片露出正片右缘多少 px —— 为 0 就等于没有背片 */
    peek: Math.round(br.right - fr.right),
    veilOpacity: parseFloat(getComputedStyle(veil).opacity),
  };
});
check("Photo Stack 渲染出来了（说明开关生效）", !!ps0.title, JSON.stringify(ps0.title));
check("标题/副标题正确", ps0.title === "Japan" && ps0.sub === "December 2025");
check("背片有错位 transform", /translate3d/.test(ps0.backTransform), ps0.backTransform);
check("正片有阴影", ps0.frontShadow !== "none", ps0.frontShadow);
check("背片压暗层用了 shadowTint", /rgba?\(/.test(ps0.veilBg), ps0.veilBg);
check("正背片图片都加载了", ps0.imgsLoaded === 2, ps0.imgsLoaded + "/2");

/* 尺寸与背片可见性 —— 这两条是照截图修的：
   之前照片宽度被列宽顶到 440px（竖版 587px 高，几乎占满一屏），
   压暗层又给到 0.58，背片被压成全黑等于没有。
   现在宽度走 config.width，压暗层 0.32 且悬停再降。 */
check("照片宽度跟随 config.width（不再被列宽顶满）",
  Math.abs(ps0.stackW - 320) <= 4, "stack width = " + ps0.stackW + "px");
check("照片高度没到「占满一屏」的程度",
  ps0.stackH <= 460, "stack height = " + ps0.stackH + "px");
check("静止时背片露在正片外侧（错位可见）",
  ps0.peek >= 40, "peek = " + ps0.peek + "px");
check("压暗层不至于把背片压黑（≤0.4）",
  ps0.veilOpacity > 0 && ps0.veilOpacity <= 0.4, "veil opacity = " + ps0.veilOpacity);

/* 悬停：弹簧应该把背片推出去。
   Photo Stack 在首屏下方 —— 必须先滚进视口再取坐标，否则 boundingBox 给的是视口外的 y，
   鼠标移过去什么都不会发生（这个坑踩过）。 */
const stackEl = await page.$(".a377-ps-stack");
await stackEl.scrollIntoView();
await sleep(300);
const sb = await stackEl.boundingBox();
check("Photo Stack 已滚入视口（坐标落在视口内）",
  sb.y >= 0 && sb.y + sb.height <= 900,
  JSON.stringify({ y: Math.round(sb.y), h: Math.round(sb.height) }));

await page.mouse.move(10, 10);
await sleep(80);
await page.mouse.move(sb.x + sb.width / 2, sb.y + sb.height / 2);
await sleep(120);
const mid = await page.evaluate(() =>
  document.querySelector(".a377-ps-back").style.transform);
await sleep(900);
const end = await page.evaluate(() =>
  document.querySelector(".a377-ps-back").style.transform);
await page.screenshot({ path: path.join(SHOTS, "03-photostack-hover.png") });

check("悬停后背片位置变了（弹簧在解算）", end !== ps0.backTransform,
  ps0.backTransform + "  →  " + end);
check("弹簧是渐进收敛的（中间态不同于终态）", mid !== end,
  mid + "  vs  " + end);

/* 悬停该让背片「更明显」——不只是位移变了 */
const hov = await page.evaluate(() => {
  const stack = document.querySelector(".a377-ps-stack");
  const back = stack.querySelector(".a377-ps-back");
  const front = stack.querySelector(".a377-ps-front");
  const veil = stack.querySelector(".a377-ps-veil");
  return {
    peek: Math.round(back.getBoundingClientRect().right - front.getBoundingClientRect().right),
    veilOpacity: parseFloat(getComputedStyle(veil).opacity),
  };
});
check("悬停后背片露出更多", hov.peek > ps0.peek + 20,
  ps0.peek + "px  →  " + hov.peek + "px");
check("悬停后压暗层更淡", hov.veilOpacity < ps0.veilOpacity - 0.05,
  ps0.veilOpacity + "  →  " + hov.veilOpacity);

/* 移开应该回到原位 */
await page.mouse.move(20, 20);
await sleep(1100);
const back2 = await page.evaluate(() =>
  document.querySelector(".a377-ps-back").style.transform);
check("移开后回到初始位置", back2 === ps0.backTransform,
  ps0.backTransform + "  vs  " + back2);

/* ============================ 4. 恢复默认 ============================ */
console.log("\n[4] 恢复默认");

const resetRes = await post({ key: TOKEN, reset: "photostack" });
check("reset 接口成功", resetRes.body?.ok === true);
const site2 = await getSite();
check("reset 后 photostack 回到默认关闭状态", !site2.blocks.photostack,
  "blocks = " + Object.keys(site2.blocks).join(","));

const galleryReset = await post({ key: TOKEN, reset: "gallery" });
check("gallery 也能 reset", galleryReset.body?.ok === true);
const site3 = await getSite();
check("reset 后 gallery 仍在（默认是启用的）", !!site3.blocks.gallery);

await browser.close();

console.log("\n" + "─".repeat(52));
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log(`截图：${SHOTS}`);
process.exit(fail ? 1 : 0);
