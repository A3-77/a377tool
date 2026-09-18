/* =========================================================================
   首页展示组件
     · 弧形画廊  —— 图片贴在圆柱面上横向无限滚动，可拖拽，参数来自 /api/site
     · Photo Stack —— 正片 + 错位背片，悬停按弹簧展开（真数值积分，不是 cubic-bezier）

   参数从后台管理页存进 D1，这里只负责画。
   后台面板左侧的 iframe 会 postMessage 过来做实时预览，不需要保存就能看效果。
   ========================================================================= */
(function () {
  "use strict";

  var API = "/api/site";
  var REDUCE = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var COARSE = window.matchMedia && window.matchMedia("(hover: none)").matches;

  var blocks = {};          // 当前生效的配置
  var cleanups = [];        // 每次重渲染前要跑的清理
  var previewLocked = false;

  /* ---------------- 小工具 ---------------- */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function num(v, dflt) {
    var n = Number(v);
    return isFinite(n) ? n : dflt;
  }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }

  function rgba(hex, a) {
    var m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex == null ? "" : hex).trim());
    if (!m) return "rgba(0,0,0," + a + ")";
    var h = m[1];
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var n = parseInt(h, 16);
    return "rgba(" + ((n >> 16) & 255) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")";
  }

  /* ---------------- 找到当前皮肤下该用的 slot ----------------
     首页写了两套皮肤视图，只有一套可见，各带一个空 slot。
     渲染进当前可见的那个，切皮肤时把节点搬过去（不重建，rAF 不中断）。 */
  function activeSlot() {
    var skin = document.documentElement.getAttribute("data-skin") || "classic";
    var slots = document.querySelectorAll("[data-showcase]");
    var first = null;
    for (var i = 0; i < slots.length; i++) {
      if (!first) first = slots[i];
      var view = slots[i].closest ? slots[i].closest("[data-view]") : null;
      if (view && view.getAttribute("data-view") === skin) return slots[i];
    }
    return first;
  }

  /* ============================================================
     弧形画廊

     几何全部由容器宽度反解，不写死 px —— 否则换个容器宽度就不成立
     （曾经用 radius=1600/cardWidth=460 的固定值，结果 900px 宽的 classic 视图
     一屏只能看到 ±1 张卡，第三张已经在屏幕外）。

     推导：环整体后移 radius，所以正面那张卡的 z = 0，投影比例正好是 1。
     于是卡片在屏幕上的横向位置 = r·sin(a)·CAM/(CAM + 1 - cos a)。
     令 a = 可见半角 θ 时正好落在容器边缘（W/2），反解出 r：

         r = (W/2) · (CAM + 1 - cos θ) / (CAM · sin θ)

     相邻卡片的弧长 r·θstep 就是卡片宽度 —— 这样卡片正好首尾相接，
     既不留缝也不过度重叠。
     ============================================================ */
  var CAM = 2.2;   // 相机距离 = 半径 × CAM

  function gallerySection(cfg) {
    var items = (cfg.items || []).filter(function (it) { return it && it.src; });

    var perView = clamp(num(cfg.perView, 6), 2, 14);       // 一屏可见卡片数
    var step = clamp(num(cfg.angleStep, 15), 3, 45);       // 卡片夹角（度）
    var aspect = clamp(num(cfg.aspect, 1.5), 0.8, 2.4);    // 卡片宽高比
    var speed = num(cfg.speed, 6);
    var dim = clamp(num(cfg.dim, 0.55), 0, 1);
    var pauseOnHover = cfg.pauseOnHover !== false;
    var canDrag = cfg.drag !== false;

    var sec = el("section", "a377-showcase a377-showcase-bleed");
    sec.style.setProperty("--bg", cfg.bg || "#000");
    sec.append(el("div", "a377-showcase-label", "SHOWCASE"));

    var view = el("div", "a377-gal-viewport");

    if (!items.length) {
      view.append(el("div", "a377-showcase-empty",
        "还没有图片。到 管理页 → 展示组件 里加几张。"));
      sec.append(view);
      return sec;
    }

    /* 铺满一整圈：一份不够就复制几份，但总数不超过 360/夹角，否则会自我重叠 */
    var span = items.length * step;
    var copies = Math.max(1, Math.ceil(360 / span));
    var count = Math.min(items.length * copies, Math.max(1, Math.floor(360 / step)));

    var ring = el("div", "a377-gal-ring");
    var cards = [];
    for (var i = 0; i < count; i++) {
      var item = items[i % items.length];
      var angle = i * step;

      var fig = el("figure", "a377-gal-card");
      var img = document.createElement("img");
      img.src = item.src;
      img.alt = item.title || "";
      img.loading = "lazy";
      img.draggable = false;
      fig.append(img);
      if (item.title) fig.append(el("figcaption", null, item.title));

      ring.append(fig);
      cards.push({ node: fig, angle: angle });
    }
    view.append(ring);
    sec.append(view);

    /* ---- 按容器宽度算几何 ---- */
    var radius = 1000, lastW = 0;

    function layout() {
      var W = view.clientWidth;
      if (!W) return;
      var half = clamp(perView * step / 2, 6, 84) * Math.PI / 180;
      radius = (W / 2) * (CAM + 1 - Math.cos(half)) / (CAM * Math.sin(half));

      var cardW = radius * step * Math.PI / 180;
      var cardH = cardW / aspect;

      view.style.setProperty("--card-w", cardW.toFixed(1) + "px");
      view.style.setProperty("--card-h", cardH.toFixed(1) + "px");
      view.style.setProperty("--persp", (radius * CAM).toFixed(0) + "px");
      /* 卡片下面还有一行说明文字，留出余量 */
      view.style.setProperty("--view-h", Math.round(cardH + 78) + "px");

      for (var k = 0; k < cards.length; k++) {
        cards[k].node.style.transform =
          "rotateY(" + cards[k].angle + "deg) translateZ(" + radius.toFixed(1) + "px)";
      }
      lastW = W;
    }

    /* ---- 动画 ---- */
    var rot = 0, hovered = false, dragging = false, lastX = 0;
    var raf = 0, prev = 0, visible = true;

    function paint() {
      ring.style.transform = "translateZ(" + (-radius).toFixed(1) + "px) rotateY(" + rot + "deg)";
      for (var k = 0; k < cards.length; k++) {
        var d = ((cards[k].angle + rot) % 360 + 360) % 360;
        if (d > 180) d -= 360;
        cards[k].node.style.opacity = (1 - dim * Math.min(1, Math.abs(d) / 180)).toFixed(3);
      }
    }

    function frame(now) {
      var dt = prev ? Math.min(0.05, (now - prev) / 1000) : 0;
      prev = now;
      if (!dragging && !(hovered && pauseOnHover) && speed !== 0 && !REDUCE) rot += speed * dt;
      paint();
      raf = requestAnimationFrame(frame);
    }

    function start() {
      if (raf || !visible || REDUCE) return;
      prev = 0;
      raf = requestAnimationFrame(frame);
    }
    function stop() {
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    }

    layout();
    paint();

    /* 容器宽度变了要重算几何（比如切皮肤后两套视图宽度不同） */
    if ("ResizeObserver" in window) {
      var ro = new ResizeObserver(function () {
        if (Math.abs(view.clientWidth - lastW) < 2) return;
        layout();
        paint();
      });
      ro.observe(view);
      cleanups.push(function () { ro.disconnect(); });
    }

    /* 滚出视口就停掉，别白烧 CPU */
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (ents) {
        for (var i = 0; i < ents.length; i++) {
          visible = ents[i].isIntersecting;
          if (visible) start(); else stop();
        }
      }, { rootMargin: "160px" });
      io.observe(view);
      cleanups.push(function () { io.disconnect(); });
    } else {
      start();
    }

    if (pauseOnHover) {
      view.addEventListener("pointerenter", function () { hovered = true; });
      view.addEventListener("pointerleave", function () { hovered = false; });
    }

    if (canDrag) {
      view.addEventListener("pointerdown", function (e) {
        dragging = true; lastX = e.clientX;
        view.classList.add("is-drag");
        if (view.setPointerCapture) view.setPointerCapture(e.pointerId);
      });
      view.addEventListener("pointermove", function (e) {
        if (!dragging) return;
        var dx = e.clientX - lastX;
        lastX = e.clientX;
        /* 弧长换算成角度：在圆柱表面横移 dx 像素 ≈ dx/r 弧度 */
        rot += (dx / radius) * (180 / Math.PI);
        paint();
        e.preventDefault();
      });
      var endDrag = function () { dragging = false; view.classList.remove("is-drag"); };
      view.addEventListener("pointerup", endDrag);
      view.addEventListener("pointercancel", endDrag);
      view.addEventListener("pointerleave", function () { if (dragging) endDrag(); });
    }

    cleanups.push(stop);
    return sec;
  }

  /* ============================================================
     Photo Stack
     ============================================================ */
  function stackSection(cfg) {
    var sec = el("section", "a377-showcase");
    sec.style.setProperty("--bg", cfg.darkMode ? "#08090c" : "#101114");

    var ps = el("div", "a377-ps" + (cfg.darkMode ? " dark" : ""));
    /* 照片宽度由 CSS 变量给到 grid 列，窄屏时 minmax 自动收窄 */
    var boxW = clamp(num(cfg.width, 320), 120, 720);
    ps.style.setProperty("--ps-w", boxW + "px");

    var ox0 = num(cfg.offsetX, 0), oy0 = num(cfg.offsetY, 0);
    var scale0 = clamp(num(cfg.scale, 0.9), 0.05, 4);

    /* 背片会探出正片外侧，悬停时探得更远（spread 最大 1.7）。
       这块空间必须提前留出来：不留的话背片会被容器裁掉（等于没有背片），
       留少了则悬停时会溢到展示带外面。
       offset 和 scale 都是后台可调的，所以只能算，不能写死。 */
    var SPREAD_MAX = 1.7;
    var boxH = boxW * ({ portrait: 4 / 3, landscape: 3 / 4, square: 1 }[cfg.shape] || 4 / 3);
    var backScaleMax = scale0 * 1.06;
    var peekX = ox0 * SPREAD_MAX - boxW * (1 - backScaleMax) / 2;
    var peekY = oy0 * SPREAD_MAX - boxH * (1 - backScaleMax) / 2;
    ps.style.setProperty("--ps-pad-r", Math.max(0, Math.round(peekX)) + "px");
    ps.style.setProperty("--ps-pad-l", Math.max(0, Math.round(-peekX)) + "px");
    ps.style.setProperty("--ps-pad-t", Math.max(0, Math.round(-peekY)) + "px");
    ps.style.setProperty("--ps-pad-b", Math.max(0, Math.round(peekY)) + "px");

    var inner = el("div", "a377-ps-inner");

    var meta = el("div", "a377-ps-meta");
    meta.append(el("h3", null, cfg.title || ""));
    meta.append(el("p", null, cfg.subtitle || ""));
    meta.append(el("div", "a377-ps-hint", COARSE ? "点按展开" : "悬停展开"));

    var stack = el("div", "a377-ps-stack");
    var ratio = { portrait: "3 / 4", landscape: "4 / 3", square: "1 / 1" }[cfg.shape] || "3 / 4";
    stack.style.setProperty("--ps-ratio", ratio);

    var tint = cfg.shadowTint || "#000000";
    var overlayOpacity = clamp(num(cfg.overlayOpacity, 0.58), 0, 1);

    var back = el("div", "a377-ps-layer a377-ps-back");
    var backImg = document.createElement("img");
    backImg.src = cfg.back || "";
    backImg.alt = "";
    backImg.draggable = false;
    var veil = el("div", "a377-ps-veil");
    veil.style.background = tint;
    back.append(backImg, veil);

    var front = el("div", "a377-ps-layer a377-ps-front");
    var frontImg = document.createElement("img");
    frontImg.src = cfg.front || "";
    frontImg.alt = cfg.title || "";
    frontImg.draggable = false;
    front.append(frontImg);

    var shBlur = clamp(num(cfg.shadowBlur, 60), 0, 400);
    var shOp = clamp(num(cfg.shadowOpacity, 0.45), 0, 1);
    front.style.boxShadow = "0 " + Math.round(shBlur * 0.4) + "px " + shBlur + "px " + rgba(tint, shOp);

    stack.append(back, front);
    inner.append(meta, stack);
    ps.append(inner);
    sec.append(ps);

    /* ---- 弹簧 ----
       visualDuration + bounce 换算成「质量 1」的阻尼弹簧：
         bounce 0   → 阻尼比 1（临界阻尼，不回弹）
         bounce 1   → 阻尼比 0.15（明显回弹）
       用半隐式欧拉积分，每帧切成小步长保证稳定。 */
    var S = cfg.spring || {};
    var dur = clamp(num(S.duration, 0.5), 0.05, 4);
    var bounce = clamp(num(S.bounce, 0.41), 0, 1);
    var zeta = 1 - 0.85 * bounce;
    var omega0 = 6 / dur;
    var K = omega0 * omega0;
    var C = 2 * zeta * omega0;

    var ox = ox0, oy = oy0, scale = scale0;

    var st = { x: 0, v: 0, target: 0 };
    var raf = 0, prev = 0;

    function apply(t) {
      /* 悬停时背片往外推、略微放大，压暗层明显变淡 —— 露出更多。
         spread 上限必须和上面算预留空间用的 SPREAD_MAX 一致。 */
      var spread = 1 + (SPREAD_MAX - 1) * t;
      back.style.transform =
        "translate3d(" + (ox * spread) + "px," + (oy * spread) + "px,0) scale(" + (scale * (1 + 0.06 * t)) + ")";
      veil.style.opacity = (overlayOpacity * (1 - 0.55 * t)).toFixed(3);
      front.style.transform = "translate3d(0," + (-4 * t).toFixed(2) + "px,0)";
    }

    function tick(now) {
      var dt = prev ? Math.min(0.05, (now - prev) / 1000) : 0.016;
      prev = now;
      var steps = Math.max(1, Math.ceil(dt / 0.008));
      var h = dt / steps;
      for (var i = 0; i < steps; i++) {
        var a = -K * (st.x - st.target) - C * st.v;
        st.v += a * h;
        st.x += st.v * h;
      }
      if (Math.abs(st.x - st.target) < 0.0015 && Math.abs(st.v) < 0.0015) {
        st.x = st.target; st.v = 0;
        apply(st.x);
        raf = 0;
        return;
      }
      apply(st.x);
      raf = requestAnimationFrame(tick);
    }

    function to(v) {
      st.target = v;
      if (!raf) { prev = 0; raf = requestAnimationFrame(tick); }
    }

    if (COARSE) {
      /* 触屏没有 hover，改成点一下切换 */
      stack.addEventListener("click", function () { to(st.target > 0.5 ? 0 : 1); });
    } else {
      stack.addEventListener("pointerenter", function () { to(1); });
      stack.addEventListener("pointerleave", function () { to(0); });
      stack.addEventListener("focusin", function () { to(1); });
      stack.addEventListener("focusout", function () { to(0); });
    }
    stack.tabIndex = 0;
    stack.setAttribute("role", "img");
    stack.setAttribute("aria-label", (cfg.title || "照片") + (cfg.subtitle ? "，" + cfg.subtitle : ""));

    apply(0);
    cleanups.push(function () { if (raf) cancelAnimationFrame(raf); raf = 0; });
    return sec;
  }

  /* ============================================================
     渲染调度
     ============================================================ */
  function teardown() {
    for (var i = 0; i < cleanups.length; i++) {
      try { cleanups[i](); } catch (e) {}
    }
    cleanups = [];
  }

  function render(next) {
    blocks = next || {};
    teardown();

    var slots = document.querySelectorAll("[data-showcase]");
    for (var i = 0; i < slots.length; i++) {
      slots[i].textContent = "";
      slots[i].hidden = true;
    }

    var host = activeSlot();
    if (!host) return;

    var made = [];
    if (blocks.gallery) made.push(gallerySection(blocks.gallery));
    if (blocks.photostack) made.push(stackSection(blocks.photostack));
    if (!made.length) return;      /* 两个都关着 → slot 保持隐藏，不占位置 */

    for (var j = 0; j < made.length; j++) host.append(made[j]);
    host.hidden = false;
  }

  /* 切皮肤：把已经渲染好的节点搬到另一套视图的 slot 里，不重建 */
  function relocate() {
    var from = null;
    var slots = document.querySelectorAll("[data-showcase]");
    for (var i = 0; i < slots.length; i++) if (!slots[i].hidden) from = slots[i];
    var to = activeSlot();
    if (!to || !from || from === to) return;
    while (from.firstChild) to.append(from.firstChild);
    from.hidden = true;
    to.hidden = false;
  }

  /* ---------------- 数据来源 ---------------- */
  function load() {
    if (previewLocked) return;
    fetch(API, { headers: { "Accept": "application/json" } })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok && !previewLocked) render(j.blocks); })
      .catch(function () {
        /* 没有后端（比如 python -m http.server 静态预览）→ 不渲染，保持隐藏 */
      });
  }

  window.addEventListener("message", function (e) {
    if (e.origin !== window.location.origin) return;
    var d = e.data;
    if (!d || d.type !== "a377:showcase-preview") return;
    previewLocked = true;      /* 后台面板接管后，别再被初次 fetch 覆盖 */
    render(d.blocks);
  });

  /* skin.js 把事件派发在 window 上，别挂到 document（document 收不到） */
  window.addEventListener("a377:skinchange", relocate);

  window.A377Showcase = { render: render, reload: load, relocate: relocate };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", load);
  } else {
    load();
  }
})();
