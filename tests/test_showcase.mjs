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
 * 覆盖：接口 / 画廊渲染 / 视频播放调度 / Photo Stack / 后台面板。
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
check("gallery 默认有内容", (site0.blocks.gallery?.items || []).length >= 8);
check("gallery 默认里含视频项（画廊不只支持图片）",
  (site0.blocks.gallery?.items || []).some((it) => /\.(mp4|webm|mov)$/i.test(it.src || "")),
  (site0.blocks.gallery?.items || []).map((it) => it.src).join(" "));
check("gallery 默认带视觉参数（perView / angleStep / aspect）",
  site0.blocks.gallery?.perView > 0 && site0.blocks.gallery?.angleStep > 0 && site0.blocks.gallery?.aspect > 0,
  JSON.stringify({
    perView: site0.blocks.gallery?.perView,
    angleStep: site0.blocks.gallery?.angleStep,
    aspect: site0.blocks.gallery?.aspect,
  }));
check("gallery 默认带视频播放参数（autoplay / maxPlaying / preload）",
  site0.blocks.gallery?.videoAutoplay === true &&
  site0.blocks.gallery?.videoMaxPlaying > 0 &&
  !!site0.blocks.gallery?.videoPreload,
  JSON.stringify({
    autoplay: site0.blocks.gallery?.videoAutoplay,
    max: site0.blocks.gallery?.videoMaxPlaying,
    preload: site0.blocks.gallery?.videoPreload,
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
  executablePath: CHROME, headless: "new",
  /* 画廊里的视频是 muted 的，真实 Chrome 本来就允许自动播；
     这个 flag 只是让无头环境的行为和真机一致，免得测出假阴性 */
  args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"],
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
/* 视频的 videoWidth 是另一条异步路径 —— preload="metadata" 下要等元数据到才有值，
   上面那轮等图片的覆盖不到它。立刻读会得到 0，而同轮「currentTime 在推进」却是过的，
   很容易误判成「视频没解码」（踩过）。 */
await page.waitForFunction(
  () => {
    const vids = [...document.querySelectorAll(".a377-gal-card video")];
    return vids.length > 0 && vids.every((v) => v.videoWidth > 0);
  },
  { timeout: 20000 }
).catch(() => {});

const gal = await page.evaluate(() => {
  const slot = document.querySelector("[data-showcase]:not([hidden])");
  const cards = [...slot.querySelectorAll(".a377-gal-card")];
  const ring = slot.querySelector(".a377-gal-ring");
  const view = slot.querySelector(".a377-gal-viewport");
  const r0 = cards[0]?.getBoundingClientRect();
  const vids = [...slot.querySelectorAll(".a377-gal-card video")];
  return {
    slotInView: slot.closest("[data-view]")?.getAttribute("data-view"),
    cards: cards.length,
    ringTransform: getComputedStyle(ring).transform,
    ringInline: ring.style.transform,
    persp: getComputedStyle(view).perspective,
    firstCardTransform: cards[0]?.style.transform,
    opacities: cards.map((c) => Number(c.style.opacity)),
    /* 图片和视频分开数 —— 卡片里两种媒体都可能出现 */
    imgs: cards.filter((c) => c.querySelector("img")).length,
    imgsLoaded: cards.filter((c) => c.querySelector("img")?.naturalWidth > 0).length,
    videos: vids.length,
    videosDecoded: vids.filter((v) => v.videoWidth > 0).length,
    videoAttrs: vids[0]
      ? { muted: vids[0].muted, loop: vids[0].loop, playsInline: vids[0].playsInline,
          controls: vids[0].controls, preload: vids[0].preload }
      : null,
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
check("图片真的加载出来了（不是坏图）", gal.imgsLoaded === gal.imgs,
  gal.imgsLoaded + "/" + gal.imgs);
check("边缘压暗生效（各卡 opacity 不一致）",
  new Set(gal.opacities.map((o) => o.toFixed(2))).size > 1,
  JSON.stringify(gal.opacities.slice(0, 6)));

/* ---- 视频卡片 ----
   画廊支持放视频（DialKit 那个画廊就是 22 个 mp4）。
   这里盯三件事：渲染成 <video> 而不是 <img>、属性对、真的在动。 */
check("视频项渲染成 <video> 而不是 <img>", gal.videos > 0,
  gal.videos + " 个 video / " + gal.cards + " 张卡");
check("视频都解码出了画面（videoWidth > 0）", gal.videosDecoded === gal.videos,
  gal.videosDecoded + "/" + gal.videos);
check("视频属性对（muted + loop + playsInline + 无原生控件）",
  !!gal.videoAttrs && gal.videoAttrs.muted && gal.videoAttrs.loop &&
  gal.videoAttrs.playsInline && !gal.videoAttrs.controls,
  JSON.stringify(gal.videoAttrs));
check("视频用 preload=metadata（拿首帧当封面，不是空白卡）",
  gal.videoAttrs?.preload === "metadata", gal.videoAttrs?.preload);

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

/* ---- 视频播放调度 ----
   一圈会复制成 20 多张卡，如果视频全播会把带宽和 CPU 一起吃光。
   策略：只播离正前方最近的 videoMaxPlaying 个，其余停在首帧。 */
const maxPlaying = site0.blocks.gallery.videoMaxPlaying;

const vPlay = await page.evaluate(() => {
  const vids = [...document.querySelectorAll(".a377-gal-card video")];
  return { playing: vids.filter((v) => !v.paused).length, total: vids.length };
});
check("同时播放数不超过 videoMaxPlaying（不是全播）",
  vPlay.playing > 0 && vPlay.playing <= maxPlaying,
  vPlay.playing + " 个在播 / 上限 " + maxPlaying + " / 共 " + vPlay.total + " 个视频卡");

/* 「在播」还不够 —— 得确认画面真的在动 */
const vT0 = await page.evaluate(() => {
  const v = [...document.querySelectorAll(".a377-gal-card video")].find((x) => !x.paused);
  return v ? v.currentTime : -1;
});
await sleep(900);
const vT1 = await page.evaluate(() => {
  const v = [...document.querySelectorAll(".a377-gal-card video")].find((x) => !x.paused);
  return v ? v.currentTime : -1;
});
check("视频真的在播（currentTime 在推进）",
  vT0 >= 0 && vT1 > vT0, vT0.toFixed(2) + "s  →  " + vT1.toFixed(2) + "s");

/* 滚出视口要全部暂停。
   注意：首页总共只能滚 258px，正常视口下画廊根本滚不出去（踩过 ——
   一开始以为是暂停逻辑坏了，其实是页面太短）。所以临时把视口压矮，
   制造一次真正的「滚出视口」。 */
await page.setViewport({ width: 1440, height: 420, deviceScaleFactor: 1 });
await sleep(300);
await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
await sleep(900);
const vAway = await page.evaluate(() => {
  const vids = [...document.querySelectorAll(".a377-gal-card video")];
  const r = document.querySelector(".a377-gal-viewport").getBoundingClientRect();
  return { playing: vids.filter((v) => !v.paused).length, bottom: Math.round(r.bottom) };
});
check("滚出视口后视频全部暂停（rAF 停了 paint 不会再跑，必须显式停）",
  vAway.bottom < 0 && vAway.playing === 0,
  "画廊底边 y=" + vAway.bottom + "，仍在播 " + vAway.playing + " 个");

await page.evaluate(() => {
  document.querySelector(".a377-gal-viewport").scrollIntoView({ block: "center" });
});
await sleep(1000);
const vBack = await page.evaluate(() =>
  [...document.querySelectorAll(".a377-gal-card video")].filter((v) => !v.paused).length);
check("滚回视口后恢复播放", vBack > 0, vBack + " 个在播");

await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await sleep(300);

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
await page.waitForFunction(() => !!document.querySelector(".a377-ps-stage"), { timeout: 20000 });
await page.waitForFunction(
  () => {
    const imgs = [...document.querySelectorAll(".a377-ps-stage img")];
    return imgs.length > 0 && imgs.every((i) => i.naturalWidth > 0);
  },
  { timeout: 20000 }
).catch(() => {});

/* 可见的永远是最上面一张 + 后面一张（原版 visibleCount = 2）。
   坐标一律换算成「相对舞台」——绝对坐标会随滚动变，没法比。 */
const psSnap = () =>
  page.evaluate(() => {
    const stage = document.querySelector(".a377-ps-stage");
    const sr = stage.getBoundingClientRect();
    const cards = [...document.querySelectorAll(".a377-ps-photo")].map((n) => {
      const card = n.querySelector(".a377-ps-card");
      const veil = n.querySelector(".a377-ps-veil");
      const r = card.getBoundingClientRect();
      return {
        src: (n.querySelector("img").getAttribute("src") || "").split("/").pop(),
        top: n.classList.contains("is-top"),
        x: Math.round(r.x - sr.x), y: Math.round(r.y - sr.y),
        w: Math.round(r.width), h: Math.round(r.height),
        radius: getComputedStyle(card).borderRadius,
        veilBg: veil.style.background,
        veilOp: parseFloat(getComputedStyle(veil).opacity),
        z: Number(n.style.zIndex),
        pe: getComputedStyle(n).pointerEvents,
      };
    });
    const blur = document.querySelector(".a377-ps-blur");
    return {
      count: cards.length,
      cards,
      shadows: document.querySelectorAll(".a377-ps-shadow").length,
      shadowFilter: blur ? getComputedStyle(blur).filter : null,
      title: document.querySelector(".a377-ps-meta h3")?.textContent,
      sub: document.querySelector(".a377-ps-meta p")?.textContent,
      hint: document.querySelector(".a377-ps-hint")?.textContent,
      stageW: Math.round(sr.width), stageH: Math.round(sr.height),
      stageTop: Math.round(sr.top),
      metaBottom: Math.round(document.querySelector(".a377-ps-meta").getBoundingClientRect().bottom),
      role: stage.getAttribute("role"),
      tabIndex: stage.tabIndex,
      aria: stage.getAttribute("aria-label") || "",
    };
  });

const ps0 = await psSnap();
const top0 = ps0.cards.find((c) => c.top);
const back0 = ps0.cards.find((c) => !c.top);

check("Photo Stack 渲染出来了（说明开关生效）", !!ps0.title, JSON.stringify(ps0.title));
check("标题/副标题正确", ps0.title === "Japan" && ps0.sub === "December 2025");
check("可见照片是 2 张（最上面一张 + 后面一张）", ps0.count === 2, ps0.count + " 个节点");

/* 外观：这几条都是照 DialKit 的 example/src/PhotoStack.tsx 对齐的，
   之前我们做成了「16px 圆角卡片 + 纯色压暗 + box-shadow」，跟原版不一样。 */
check("照片是 2px 圆角（原版几乎是直角，不是圆角卡片）",
  top0?.radius === "2px", top0?.radius);
check("标题在照片上方（原版是竖排，不是左右两列）",
  ps0.metaBottom <= ps0.stageTop + 2,
  "标题底 " + ps0.metaBottom + " vs 照片顶 " + ps0.stageTop);
check("容器尺寸按原版留了错位和阴影的余量（形状 + 180 × + 200）",
  ps0.stageW === 520 && ps0.stageH === 680, ps0.stageW + "×" + ps0.stageH);

/* 几何：这几条全都能从原版源码推出来，不是「看着差不多」 */
check("正片就是形状的原尺寸 340×480", top0?.w === 340 && top0?.h === 480,
  top0?.w + "×" + top0?.h);
check("背片按 scale 缩放（默认 0.70）",
  Math.abs(back0.w / top0.w - 0.7) < 0.02,
  "宽比 " + (back0.w / top0.w).toFixed(3));
check("背片底边和正片对齐（缩放原点是左下角）",
  Math.abs(back0.y + back0.h - (top0.y + top0.h)) <= 3,
  "底边差 " + (back0.y + back0.h - (top0.y + top0.h)) + "px");
check("背片往右错位 offsetX=239", Math.abs(back0.x - top0.x - 239) <= 3,
  "错位 " + (back0.x - top0.x) + "px");
check("背片露在正片右缘外（错位可见）", back0.x + back0.w > top0.x + top0.w + 40,
  "露出 " + (back0.x + back0.w - top0.x - top0.w) + "px");
check("背片压暗是渐变（shadowTint → 透明），不是纯色",
  /linear-gradient/.test(back0.veilBg) && /rgb/.test(back0.veilBg), back0.veilBg);
check("正片不压暗、背片压暗（overlayOpacity 默认 0.6）",
  top0.veilOp < 0.01 && Math.abs(back0.veilOp - 0.6) < 0.02,
  "正片 " + top0.veilOp + " / 背片 " + back0.veilOp);
check("阴影是独立的模糊副本层（不是 box-shadow）",
  ps0.shadows === 2 && /blur/.test(ps0.shadowFilter || ""),
  ps0.shadows + " 层 / filter=" + ps0.shadowFilter);
check("背片在最上面那张之下", top0.z > back0.z, "z " + top0.z + " vs " + back0.z);
check("只有最上面那张可点（背片被压住，点了没意义）",
  top0.pe !== "none" && back0.pe === "none", top0.pe + " / " + back0.pe);
check("可键盘操作（role=button + tabindex + aria-label）",
  ps0.role === "button" && ps0.tabIndex === 0 && /下一张/.test(ps0.aria),
  ps0.role + " / tabindex=" + ps0.tabIndex + " / " + ps0.aria);

/* ---- 点最上面那张 → 换下一张 ----
   原版是 AnimatePresence：新片从背片位弹入，旧片向左滑出并淡出，
   所以动画中途会同时存在 3 张。Photo Stack 在首屏下方，
   必须先滚进视口再取坐标（踩过：直接取会拿到视口外的 y，点了没反应）。 */
const stageEl = await page.$(".a377-ps-stage");
await stageEl.scrollIntoView();
await sleep(300);
const sb = await stageEl.boundingBox();
check("Photo Stack 已滚入视口（坐标落在视口内）",
  sb.y >= 0 && sb.y + sb.height <= 900,
  JSON.stringify({ y: Math.round(sb.y), h: Math.round(sb.height) }));

await page.mouse.move(10, 10);
await sleep(60);
await page.mouse.click(sb.x + sb.width / 4, sb.y + sb.height / 4);
await sleep(150);
const mid = await psSnap();
await page.screenshot({ path: path.join(SHOTS, "03-photostack-swap.png") });
await sleep(2200);
const ps1 = await psSnap();
const top1 = ps1.cards.find((c) => c.top);

check("点最上面那张会换片（正片换成下一张）",
  !!top1 && top1.src !== top0.src, top0.src + "  →  " + top1?.src);
check("原来的背片补上来当正片",
  top1?.src === back0.src, back0.src + "  →  " + top1?.src);
check("动画中途旧片在往左滑出（同时存在 3 张）",
  mid.cards.length === 3 && mid.cards.some((c) => c.x < -10),
  mid.cards.length + " 张，x = " + mid.cards.map((c) => c.x).join(","));
check("动画结束后出场节点被摘掉（还是 2 张）",
  ps1.count === 2, ps1.count + " 个节点");

/* 键盘也得能换 —— 原版靠面板里的 Next 按钮，我们只在前台点照片，
   没有键盘入口的话就只能用鼠标。 */
await page.focus(".a377-ps-stage");
const keyBefore = (await psSnap()).cards.find((c) => c.top)?.src;
await page.keyboard.press("Enter");
await sleep(2200);
const keyAfter = (await psSnap()).cards.find((c) => c.top)?.src;
check("键盘 Enter 也能换片", keyAfter !== keyBefore, keyBefore + " → " + keyAfter);

/* 连点 4 次应该正好绕一圈回到起点（默认 4 张照片） */
const lapStart = keyAfter;
const seen = [];
for (let i = 0; i < 4; i++) {
  const r = await page.evaluate(() => {
    const n = document.querySelector(".a377-ps-photo.is-top");
    const b = n.getBoundingClientRect();
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
  });
  await page.mouse.click(r.x, r.y);
  await sleep(1700);
  seen.push((await psSnap()).cards.find((c) => c.top)?.src);
}
check("4 张照片真的在轮转（不是只换一次）",
  new Set(seen).size === 4, seen.join(" → "));
check("点 4 次正好绕一圈回到起点", seen[3] === lapStart,
  lapStart + " → " + seen.join(" → "));

/* 挪开鼠标，避免悬停缩放影响后面的截图 */
await page.mouse.move(10, 10);
await sleep(400);

/* 窄屏：原版的几何是写死的 340×480，靠最外层整体缩放收进去。
   缩的是 transform，所以布局盒也得跟着变 —— 只缩 transform 会留下一块空白。 */
await page.setViewport({ width: 390, height: 800, deviceScaleFactor: 1 });
await sleep(700);
const narrow = await page.evaluate(() => {
  const stage = document.querySelector(".a377-ps-stage");
  const r = stage.getBoundingClientRect();
  return {
    stageW: Math.round(r.width),
    stageRight: Math.round(r.right),
    docW: document.documentElement.clientWidth,
    transform: stage.style.transform,
  };
});
check("窄屏下照片整体等比缩小（不是溢出，也不是留一块空白）",
  narrow.stageW < 520 && narrow.stageW > 150 && /scale/.test(narrow.transform),
  narrow.stageW + "px / " + narrow.transform);
check("窄屏下舞台盒不出视口", narrow.stageRight <= narrow.docW,
  narrow.stageRight + " vs 视口 " + narrow.docW);

await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
await sleep(500);

/* ============================ 4. 后台面板 ============================ */
console.log("\n[4] 后台面板");

const admin = await browser.newPage();
await admin.setViewport({ width: 1600, height: 1000, deviceScaleFactor: 1 });
const adminErrs = [];
admin.on("pageerror", (e) => adminErrs.push(e.message));
await admin.goto(BASE + "/api/site-admin?key=" + encodeURIComponent(TOKEN), { waitUntil: "networkidle0" });
await admin.waitForFunction(() => !!document.querySelector("#save"), { timeout: 20000 });
await sleep(1500);

const panel = await admin.evaluate(() => {
  const slots = [...document.querySelectorAll(".item .thumb-slot")];
  const kinds = slots.map((s) => s.getAttribute("data-kind"));
  const labels = [...document.querySelectorAll(".folder > summary, details > summary")]
    .map((s) => s.textContent.trim());

  /* Photo Stack 那一块单独拎出来看 —— 全局查会跟画廊的项混在一起 */
  const psBlock = [...document.querySelectorAll(".block")].find(
    (b) => b.querySelector(".block-head .kind")?.textContent === "photostack");
  const folderOf = (name) => {
    const d = [...(psBlock?.querySelectorAll(".folder") || [])]
      .find((f) => f.querySelector("summary")?.textContent.trim() === name);
    return d ? [...d.querySelectorAll(".field > label")].map((l) => l.textContent.trim()) : [];
  };

  return {
    kinds,
    videoThumbs: slots.filter((s) => s.querySelector("video")).length,
    hasVideoFolder: labels.some((l) => /视频/.test(l)),
    typeSelects: document.querySelectorAll('.item select').length,
    typeOptions: [...document.querySelectorAll(".item select")].slice(0, 1)
      .map((s) => [...s.options].map((o) => o.value).join("/"))[0],
    /* ---- Photo Stack ---- */
    psListLabel: psBlock?.querySelector(".list-head b")?.textContent,
    psListCount: psBlock?.querySelector(".list-head .count")?.textContent,
    psItems: psBlock ? psBlock.querySelectorAll(".item").length : 0,
    psColorInputs: psBlock ? psBlock.querySelectorAll('.item input[type="color"]').length : 0,
    psGroups: psBlock
      ? [...psBlock.querySelectorAll(".folder > summary")].map((s) => s.textContent.trim())
      : [],
    psShadowFields: folderOf("阴影"),
    psBackFields: folderOf("背片 Back Photo"),
    /* 老的「两个 URL 输入框」写法应该已经没了 */
    psHasOldUrlFields: psBlock
      ? [...psBlock.querySelectorAll(".field > label")].some((l) => /正片 URL|背片 URL|照片宽度/.test(l.textContent))
      : false,
  };
});

check("后台列表按类型打标（IMG / VID 角标）",
  panel.kinds.filter((k) => k === "video").length === (site0.blocks.gallery.items || [])
    .filter((it) => /\.(mp4|webm|mov)$/i.test(it.src || "")).length &&
  panel.kinds.includes("image"),
  JSON.stringify(panel.kinds));
check("视频项的缩略图用 <video> 渲染", panel.videoThumbs > 0, panel.videoThumbs + " 个");
check("每一项都能选类型（自动 / 图片 / 视频）",
  panel.typeSelects > 0 && /^\/image\/video$/.test(panel.typeOptions || ""),
  panel.typeOptions);
check("有「视频」参数分组", panel.hasVideoFolder);
check("后台面板没有 JS 报错", adminErrs.length === 0, adminErrs.slice(0, 3).join(" | "));

/* ---- Photo Stack 面板：对齐原版之后应该是「照片列表」而不是两个 URL 输入框 ---- */
check("Photo Stack 的照片是列表编辑（原版是多张照片轮转）",
  panel.psListLabel === "照片" && panel.psItems >= 2,
  panel.psListLabel + " × " + panel.psItems + " 张（" + panel.psListCount + "）");
check("每张照片带底色色板（阴影会被这个颜色染色）",
  panel.psColorInputs === panel.psItems, panel.psColorInputs + "/" + panel.psItems);
check("老的「正片 URL / 背片 URL / 照片宽度」字段已经清掉",
  panel.psHasOldUrlFields === false);
check("阴影有 4 个参数（缩放 / 不透明度 / 模糊 / 下沉）",
  panel.psShadowFields.length === 4,
  panel.psShadowFields.join("、"));
check("背片有 4 个参数（水平 / 垂直偏移 + 缩放 + 压暗）",
  panel.psBackFields.length === 4, panel.psBackFields.join("、"));

/* 视频规格要求必须写在面板里，不能只躺在文档里 ——
   改配置的人就在这个页面上，规格不写在眼前等于没写。 */
const spec = await admin.evaluate(() => {
  const b = document.querySelector(".spec");
  if (!b) return null;
  return {
    title: b.querySelector(".spec-title")?.textContent,
    lines: [...b.querySelectorAll(".spec-line")].map((l) =>
      l.querySelector(".k").textContent + "=" + l.querySelector(".v").textContent),
    /* 说明块不能是可填字段 —— 它不该出现在任何输入框里 */
    inField: !!b.closest(".field")?.querySelector("input,select,textarea"),
  };
});
check("后台写明了视频规格要求", !!spec && /视频规格/.test(spec.title || ""),
  spec ? spec.title + " / " + spec.lines.length + " 条" : "没找到 .spec");
check("规格里给了格式/分辨率/比例/时长/体积/音轨六条",
  !!spec && ["格式", "分辨率", "比例", "时长", "体积", "音轨"].every((k) => spec.lines.some((l) => l.startsWith(k + "="))),
  spec ? spec.lines.join("  ") : "");
check("规格块不是可填字段（只读说明）", !!spec && !spec.inField);

/* 后台页面不能有「幽灵滚动区」。
   面板内容 5000+px 会溢出到文档层，文档因此能滚 4000+px 的空白；
   鼠标停在左边预览 iframe 上滚滚轮时滚动链会传到父文档，把整个后台拉走。
   修法见 site-admin.css 里 .panel 的 contain:paint。 */
const ghost = await admin.evaluate(() => {
  const before = window.scrollY;
  window.scrollTo(0, 99999);
  const maxY = Math.round(window.scrollY);
  window.scrollTo(0, before);
  return { maxY, docH: document.documentElement.scrollHeight, winH: window.innerHeight };
});
check("后台文档没有幽灵滚动区（滚下去不是空白）",
  ghost.maxY === 0, "可滚 " + ghost.maxY + "px（文档 " + ghost.docH + " / 视口 " + ghost.winH + "）");

/* 真实滚轮：鼠标停在左侧预览上滚 —— 这是最容易误触的位置 */
await admin.mouse.move(300, 500);
for (let i = 0; i < 10; i++) await admin.mouse.wheel({ deltaY: 300 });
await sleep(400);
const wheelY = await admin.evaluate(() => Math.round(window.scrollY));
check("滚轮停在左侧预览上滚，后台不会被拉走", wheelY === 0, "window.scrollY=" + wheelY);

/* 面板自己还得能滚（别把 contain:paint 用成「谁都不能滚」） */
const panelScroll = await admin.evaluate(() => {
  const p = document.querySelector(".panel");
  const before = p.scrollTop;
  p.scrollTop = p.scrollHeight;
  const after = p.scrollTop;
  p.scrollTop = before;
  return { scrollable: p.scrollHeight > p.clientHeight, after };
});
check("右侧面板自身仍然能滚", panelScroll.scrollable && panelScroll.after > 0,
  "scrollTop 到 " + panelScroll.after);

await admin.screenshot({ path: path.join(SHOTS, "04-admin-video.png") });
await admin.close();

/* ============================ 5. 恢复默认 ============================ */
console.log("\n[5] 恢复默认");

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
