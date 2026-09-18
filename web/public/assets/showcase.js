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

  /* 卡片里的媒体可以是图也可以是视频（DialKit 那个画廊就是 22 个 mp4）。
     判定顺序：item.type 显式指定 > 按扩展名猜。 */
  var VIDEO_RE = /\.(mp4|m4v|webm|ogv|ogg|mov)(\?|#|$)/i;

  function isVideo(item) {
    if (item.type === "video") return true;
    if (item.type === "image") return false;
    return VIDEO_RE.test(item.src || "");
  }

  function mediaEl(item) {
    if (!isVideo(item)) {
      var img = document.createElement("img");
      img.src = item.src;
      img.alt = item.title || "";
      img.loading = "lazy";
      img.draggable = false;
      return img;
    }
    var v = document.createElement("video");
    /* muted 是自动播放的硬前提 —— 不静音浏览器直接拒绝 play() */
    v.muted = true;
    v.defaultMuted = true;
    v.loop = true;
    v.playsInline = true;
    v.setAttribute("muted", "");
    v.setAttribute("playsinline", "");
    v.setAttribute("disablepictureinpicture", "");
    v.setAttribute("tabindex", "-1");
    v.draggable = false;
    v.preload = item.preload || "metadata";
    if (item.poster) v.poster = item.poster;
    v.src = item.src;
    return v;
  }

  function gallerySection(cfg) {
    var items = (cfg.items || []).filter(function (it) { return it && it.src; });

    var perView = clamp(num(cfg.perView, 6), 2, 14);       // 一屏可见卡片数
    var step = clamp(num(cfg.angleStep, 15), 3, 45);       // 卡片夹角（度）
    var aspect = clamp(num(cfg.aspect, 1.5), 0.8, 2.4);    // 卡片宽高比
    var speed = num(cfg.speed, 6);
    var dim = clamp(num(cfg.dim, 0.55), 0, 1);
    var pauseOnHover = cfg.pauseOnHover !== false;
    var canDrag = cfg.drag !== false;
    var videoAutoplay = cfg.videoAutoplay !== false;
    var maxPlaying = clamp(num(cfg.videoMaxPlaying, 4), 0, 16);
    var preloadAll = cfg.videoPreload !== "none";

    var sec = el("section", "a377-showcase a377-showcase-bleed");
    sec.style.setProperty("--bg", cfg.bg || "#000");
    sec.append(el("div", "a377-showcase-label", "SHOWCASE"));

    var view = el("div", "a377-gal-viewport");

    if (!items.length) {
      view.append(el("div", "a377-showcase-empty",
        "还没有内容。到 管理页 → 展示组件 里加几张图片或视频。"));
      sec.append(view);
      return sec;
    }

    /* 铺满一整圈：一份不够就复制几份，但总数不超过 360/夹角，否则会自我重叠 */
    var span = items.length * step;
    var copies = Math.max(1, Math.ceil(360 / span));
    var count = Math.min(items.length * copies, Math.max(1, Math.floor(360 / step)));

    var ring = el("div", "a377-gal-ring");
    var cards = [];
    var videos = [];   // 只放视频卡片，播放调度用
    for (var i = 0; i < count; i++) {
      var item = items[i % items.length];
      var angle = i * step;

      var fig = el("figure", "a377-gal-card");
      var node = mediaEl(item);
      /* 环会把同一份素材复制多张卡。复制出来的那些大部分时间在背面
         （.a377-gal-card 有 backface-visibility:hidden，背面根本不显示），
         所以「不预加载」模式下让它们保持空白是安全的，等转到正面再加载。 */
      var isDup = i >= items.length;
      if (node.tagName === "VIDEO" && !preloadAll && isDup) {
        node.preload = "none";
        node.removeAttribute("src");
        node.dataset.src = item.src;
      }
      fig.append(node);
      if (item.title) fig.append(el("figcaption", null, item.title));

      var entry = null;
      if (node.tagName === "VIDEO") {
        entry = { node: node, d: 999, on: false, item: item };
        videos.push(entry);
      }

      ring.append(fig);
      cards.push({ node: fig, angle: angle, video: entry });
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

    /* ---- 视频播放调度 ----
       一圈 24 张卡，如果视频全播会把带宽和 CPU 一起吃掉。
       策略：按「离正前方多远」排序，只播最近的 videoMaxPlaying 个；
       整块展示带滚出视口时全部暂停（IntersectionObserver 已经在管 rAF，
       这里跟着一起停）。
       不在播放名单里的停在首帧 —— preload="metadata" 已经拿到首帧，
       看着就是张静图，不会有「空白卡片」。 */
    var syncRot = NaN, syncDirty = true;

    function syncVideo() {
      if (!videos.length) return;
      /* 排序不便宜，环每转 0.5° 才重排一次
         （默认 6°/s ≈ 每秒 12 次，而不是每帧 60 次） */
      if (!syncDirty && Math.abs(rot - syncRot) < 0.5) return;
      syncRot = rot;
      syncDirty = false;

      var order = videos.slice().sort(function (a, b) {
        return Math.abs(a.d) - Math.abs(b.d);
      });
      /* REDUCE（系统开了「减少动态效果」）时一个都不播 —— 只留首帧 */
      var budget = (videoAutoplay && visible && !REDUCE) ? maxPlaying : 0;

      for (var i = 0; i < order.length; i++) {
        var v = order[i];
        var want = i < budget;
        if (want === v.on) continue;
        v.on = want;
        if (want) {
          /* 复制卡是懒加载的，轮到它播了才把 src 装上（同源，走缓存，不会重下） */
          if (!v.node.getAttribute("src") && v.node.dataset.src) {
            v.node.setAttribute("src", v.node.dataset.src);
            v.node.preload = "auto";
          }
          var p = v.node.play();
          /* 自动播放被浏览器拦下来是正常情况（省电模式、策略限制），不该炸 */
          if (p && p.catch) p.catch(function () {});
        } else {
          v.node.pause();
        }
      }
    }

    function paint() {
      ring.style.transform = "translateZ(" + (-radius).toFixed(1) + "px) rotateY(" + rot + "deg)";
      for (var k = 0; k < cards.length; k++) {
        var d = ((cards[k].angle + rot) % 360 + 360) % 360;
        if (d > 180) d -= 360;
        cards[k].node.style.opacity = (1 - dim * Math.min(1, Math.abs(d) / 180)).toFixed(3);
        if (cards[k].video) cards[k].video.d = d;
      }
      syncVideo();
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
          /* rAF 停了 paint() 就不会再跑，视频得在这里显式停 ——
             否则滚出视口后视频还在后台播，白白耗流量和电 */
          syncDirty = true;
          syncVideo();
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
    /* 组件被换掉时（切皮肤重渲染）把所有视频停下来 */
    cleanups.push(function () {
      for (var i = 0; i < videos.length; i++) {
        try { videos[i].node.pause(); } catch (e) {}
      }
    });
    return sec;
  }

  /* ============================================================
     Photo Stack

     照 DialKit 的 example/src/PhotoStack.tsx 对齐。原版用 React + motion，
     这里没有动画库，所以按同一套状态机手写：

       · 多张照片轮转（原版 4 张），点最上面那张 → 下一张
       · 新片从背片位（offsetX/offsetY，scale×0.8）弹入
       · 旧片向左滑出并淡出（x:-width, scale:1, opacity:0）
       · 背片压暗是「从 shadowTint 到透明」的横向渐变，不是纯色 + 透明度
       · 阴影是「整张照片的模糊副本」独立一层，不是 box-shadow ——
         所以它会被照片自己的颜色染色，用 scale/blur/yOffset 三个参数调
       · transformOrigin: bottom left —— 缩放时左下角不动，
         背片因此和正片底边对齐、只往右上缩

     原版是满屏 demo，尺寸写死 340×480 这类固定值。我们这里是个 section，
     窄屏放不下，所以外面套一层按可用宽度算出来的缩放（--ps-k），
     内部几何仍然全部按原版的固定 px 算 —— 缩放只发生在最外层，
     弹簧、clip-path、错位量全都不用改。
     ============================================================ */
  var PS_SHAPES = {
    portrait:  { w: 340, h: 480 },
    square:    { w: 400, h: 400 },
    landscape: { w: 480, h: 320 }
  };
  var PS_VISIBLE = 2;          /* 原版就是 2：最上面一张 + 后面一张 */

  function stackSection(cfg) {
    /* ---- 照片列表 ----
       优先读 photos 数组；老配置只有正片/背片，就退化成两张，
       免得已经存进库里的配置变成白板。 */
    var photos = [];
    if (Array.isArray(cfg.photos)) {
      for (var pi = 0; pi < cfg.photos.length; pi++) {
        var it = cfg.photos[pi];
        if (it && it.src) photos.push({ src: it.src, color: it.color || "#1a1a2e" });
      }
    }
    if (!photos.length) {
      if (cfg.front) photos.push({ src: cfg.front, color: "#1a1a2e" });
      if (cfg.back) photos.push({ src: cfg.back, color: "#1a1a2e" });
    }
    if (!photos.length) photos.push({ src: "", color: "#1a1a2e" });

    var sec = el("section", "a377-showcase");
    sec.style.setProperty("--bg", cfg.darkMode ? "#08090c" : "#101114");

    var ps = el("div", "a377-ps" + (cfg.darkMode ? " dark" : ""));

    var shape = PS_SHAPES[cfg.shape] || PS_SHAPES.portrait;
    /* 容器尺寸照原版：右边留 180 给背片错位、下面留 200 给阴影的模糊和下沉。
       背片偏移默认 239 > 180，超出的部分靠 photoLayer 的 clip-path 放行。 */
    var boxW = shape.w + 180, boxH = shape.h + 200;
    /* 照片尺寸给 CSS —— 每个节点都要用，写在 CSS 变量里比逐个 setStyle 干净 */
    ps.style.setProperty("--ps-sw", shape.w + "px");
    ps.style.setProperty("--ps-sh", shape.h + "px");

    var inner = el("div", "a377-ps-inner");
    var meta = el("div", "a377-ps-meta");
    meta.append(el("h3", null, cfg.title || ""));
    meta.append(el("p", null, cfg.subtitle || ""));
    meta.append(el("div", "a377-ps-hint", "点一下换下一张"));

    var fit = el("div", "a377-ps-fit");
    var stage = el("div", "a377-ps-stage");
    stage.style.width = boxW + "px";
    stage.style.height = boxH + "px";
    var shadowLayer = el("div", "a377-ps-shadow-layer");
    var photoLayer = el("div", "a377-ps-photo-layer");
    stage.append(shadowLayer, photoLayer);
    fit.append(stage);
    inner.append(meta, fit);
    ps.append(inner);
    sec.append(ps);

    /* ---- 参数 ---- */
    var tint = cfg.shadowTint || "#000000";
    var ox = num(cfg.offsetX, 239), oy = num(cfg.offsetY, 0);
    var sc = clamp(num(cfg.scale, 0.7), 0.2, 1.4);
    var overlay = clamp(num(cfg.overlayOpacity, 0.6), 0, 1);
    var shScale = clamp(num(cfg.shadowScale, 1.03), 0.5, 2);
    var shOp = clamp(num(cfg.shadowOpacity, 0.25), 0, 1);
    var shBlur = clamp(num(cfg.shadowBlur, 14), 0, 200);
    var shY = num(cfg.shadowYOffset, 8);

    /* ---- 弹簧 ----
       换算跟原来一致：bounce 0 → 阻尼比 1（临界阻尼，不回弹），
       bounce 1 → 0.15（明显回弹）。半隐式欧拉，每帧切小步长保证稳定。 */
    var S = cfg.spring || {};
    var dur = clamp(num(S.duration, 0.5), 0.05, 4);
    var bounce = clamp(num(S.bounce, 0.04), 0, 1);
    var zeta = 1 - 0.85 * bounce;
    var omega0 = 6 / dur;
    var KC = omega0 * omega0;
    var CC = 2 * zeta * omega0;

    function prop(v) { return { cur: v, vel: 0, target: v }; }
    function stepProp(p, h) {
      var a = -KC * (p.cur - p.target) - CC * p.vel;
      p.vel += a * h;
      p.cur += p.vel * h;
    }
    function done(p) { return Math.abs(p.cur - p.target) < 0.002 && Math.abs(p.vel) < 0.002; }
    function snap(p) { p.cur = p.target; p.vel = 0; }

    var KT = 1;                 /* 窄屏缩放系数，layout() 里算 */
    var stepIdx = 0;            /* 原版的 step */
    var nodes = [];
    var raf = 0, prev = 0, visible = true;
    /* 原版给 AnimatePresence 传了 initial={false}：首帧直接落在终态，
       不从背片位飞进来。不这么做的话页面一打开照片会自己抖一下。 */
    var booted = false;

    function findNode(key) {
      for (var i = 0; i < nodes.length; i++) if (nodes[i].key === key) return nodes[i];
      return null;
    }

    function apply(n) {
      var t = "translate3d(" + n.x.cur.toFixed(2) + "px," + n.y.cur.toFixed(2) + "px,0)" +
              " scale(" + n.s.cur.toFixed(4) + ")";
      n.node.style.transform = t;
      n.shadow.style.transform = t;
      n.node.style.opacity = n.o.cur.toFixed(3);
      n.shadow.style.opacity = n.o.cur.toFixed(3);
      n.veil.style.opacity = n.ov.cur.toFixed(3);
      /* 正片的阴影给满，背片减半 —— 原版就是这个比例 */
      n.blur.style.opacity = (shOp * (n.stackIndex === 0 ? 1 : 0.5)).toFixed(3);
      n.node.style.zIndex = String(n.z);
    }
    function settled(n) {
      return done(n.x) && done(n.y) && done(n.s) && done(n.o) && done(n.ov);
    }
    function snapAll(n) {
      snap(n.x); snap(n.y); snap(n.s); snap(n.o); snap(n.ov);
    }
    /* 首次布局时把所有节点直接摆到终态 —— 对应原版的 initial={false}。
       只有第一次；之后的 rebuild 都要走弹簧。 */
    function settleNow() {
      for (var i = 0; i < nodes.length; i++) { snapAll(nodes[i]); apply(nodes[i]); }
    }

    function buildNode(w) {
      /* 阴影层：整张照片的模糊副本。外面那层负责跟照片同步位移，
         里面那层负责 blur/scale/yOffset 和透明度。 */
      var shadow = el("div", "a377-ps-shadow");
      var blur = el("div", "a377-ps-blur");
      blur.style.background = w.photo.color;
      blur.style.filter = "blur(" + shBlur + "px)";
      blur.style.transform = "scale(" + shScale + ") translateY(" + shY + "px)";
      blur.style.opacity = "0";
      var simg = document.createElement("img");
      simg.src = w.photo.src; simg.alt = ""; simg.draggable = false;
      blur.append(simg);
      shadow.append(blur);

      var node = el("div", "a377-ps-photo");
      var card = el("div", "a377-ps-card");
      card.style.background = w.photo.color;
      var img = document.createElement("img");
      img.src = w.photo.src; img.alt = ""; img.draggable = false;
      var veil = el("div", "a377-ps-veil");
      veil.style.background = "linear-gradient(to right," + tint + " 0%,transparent 100%)";
      card.append(img, veil);
      node.append(card);

      shadowLayer.append(shadow);
      photoLayer.append(node);

      var n = {
        key: w.key, photo: w.photo, stackIndex: w.stackIndex, z: 1, exiting: false,
        shadow: shadow, blur: blur, node: node, card: card, veil: veil,
        /* 进场起点照原版：背片位，再小一圈 */
        x: prop(ox * KT), y: prop(oy * KT), s: prop(sc * 0.8),
        o: prop(1), ov: prop(overlay)
      };
      node.addEventListener("click", function () {
        if (n.stackIndex === 0 && !n.exiting) next();
      });
      return n;
    }

    /* ---- 重建可见集合 ----
       原版：currentIndex = step % N，可见 [currentIndex, currentIndex+1]，
       key 带圈数（lap）以便绕一圈后当成新节点重新进场。 */
    function rebuild() {
      var idx = stepIdx % photos.length;
      var want = [];
      for (var i = 0; i < PS_VISIBLE; i++) {
        var pIdx = (idx + i) % photos.length;
        var lap = Math.floor((stepIdx + i) / photos.length);
        want.push({ key: pIdx + "-" + lap, photo: photos[pIdx], stackIndex: i });
      }
      var keep = {};
      for (var k = 0; k < want.length; k++) keep[want[k].key] = 1;

      /* 掉出新一组 → 向左滑出 + 淡出 */
      for (var a = 0; a < nodes.length; a++) {
        var old = nodes[a];
        if (keep[old.key] || old.exiting) continue;
        old.exiting = true;
        old.x.target = -shape.w * KT;
        old.y.target = 0;
        old.s.target = 1;
        old.o.target = 0;
        old.ov.target = 0;
        old.z = PS_VISIBLE + 1;
        old.node.classList.remove("is-top");
        old.node.style.pointerEvents = "none";
      }

      for (var q = 0; q < want.length; q++) {
        var w2 = want[q];
        var nd = findNode(w2.key);
        if (!nd) { nd = buildNode(w2); nodes.push(nd); }
        /* 出场到一半又被要回来的情况（快速连点）：让它掉头回去 */
        nd.exiting = false;
        nd.stackIndex = w2.stackIndex;
        nd.z = PS_VISIBLE - w2.stackIndex;
        nd.x.target = w2.stackIndex * ox * KT;
        nd.y.target = w2.stackIndex * oy * KT;
        nd.s.target = w2.stackIndex === 0 ? 1 : sc;
        nd.o.target = 1;
        nd.ov.target = w2.stackIndex === 0 ? 0 : overlay;
        nd.node.classList.toggle("is-top", w2.stackIndex === 0);
        /* 只有最上面那张可点 —— 背片被压住，点了也没意义 */
        nd.node.style.pointerEvents = w2.stackIndex === 0 ? "auto" : "none";
      }

      kick();
    }

    function next() { stepIdx++; rebuild(); }

    function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; prev = 0; }

    function tick(now) {
      var dt = prev ? Math.min(0.05, (now - prev) / 1000) : 0.016;
      prev = now;
      var sub = Math.max(1, Math.ceil(dt / 0.008));
      var h = dt / sub;
      var busy = false;
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        for (var s = 0; s < sub; s++) {
          stepProp(n.x, h); stepProp(n.y, h); stepProp(n.s, h);
          stepProp(n.o, h); stepProp(n.ov, h);
        }
        if (settled(n)) snapAll(n); else busy = true;
        apply(n);
      }
      /* 出场跑完的节点摘掉 —— 不摘会一直堆在 DOM 里 */
      for (var j = nodes.length - 1; j >= 0; j--) {
        if (nodes[j].exiting && settled(nodes[j])) {
          nodes[j].node.remove();
          nodes[j].shadow.remove();
          nodes.splice(j, 1);
        }
      }
      if (busy) raf = requestAnimationFrame(tick);
      else { raf = 0; prev = 0; }
    }

    function kick() {
      if (REDUCE) {
        /* 关掉动效的降级：直接落到终态，出场节点立刻摘掉 */
        for (var i = nodes.length - 1; i >= 0; i--) {
          var n = nodes[i];
          snapAll(n); apply(n);
          if (n.exiting) { n.node.remove(); n.shadow.remove(); nodes.splice(i, 1); }
        }
        return;
      }
      if (!raf) { prev = 0; raf = requestAnimationFrame(tick); }
    }

    /* ---- 窄屏：整体等比缩小 ----
       原版的固定 px 几何在窄屏放不下，但缩放只作用在最外层，
       里面所有坐标、弹簧、clip-path 都不用跟着改。 */
    function layout() {
      /* 量内层而不是 .a377-ps：clientWidth 是「内容 + padding」，
         拿它当可用宽度会多算左右两边的 padding，窄屏上正好溢出那么多。 */
      var avail = inner.clientWidth;
      if (!avail) return;
      KT = clamp(avail / boxW, 0.35, 1);
      fit.style.width = (boxW * KT).toFixed(1) + "px";
      fit.style.height = (boxH * KT).toFixed(1) + "px";
      stage.style.transform = KT >= 0.999 ? "none" : "scale(" + KT.toFixed(4) + ")";
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        if (n.exiting) continue;
        n.x.target = n.stackIndex * ox * KT;
        n.y.target = n.stackIndex * oy * KT;
      }
      /* 第一次拿到真实宽度时才落位，免得先按错的系数摆一次 */
      if (!booted) { settleNow(); booted = true; return; }
      kick();
    }

    /* ---- 无障碍：能点到就该能用键盘 ----
       原版是靠面板里的 Next 按钮换片，我们只在前台点照片，
       所以键盘也得有个入口。 */
    stage.tabIndex = 0;
    stage.setAttribute("role", "button");
    stage.setAttribute("aria-label", "下一张：" + (cfg.title || "照片"));
    stage.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " " || e.key === "Spacebar") {
        e.preventDefault();
        next();
      }
    });

    rebuild();
    layout();
    /* 没走到 layout 的落位分支（比如节点还藏着，clientWidth 是 0）也要落一次，
       否则页面打开的第一帧会停在背片位。 */
    if (!booted) { settleNow(); booted = true; }

    var ro = null, io = null;
    if (window.ResizeObserver) {
      ro = new ResizeObserver(layout);
      ro.observe(ps);
    } else {
      window.addEventListener("resize", layout);
    }
    if (window.IntersectionObserver) {
      io = new IntersectionObserver(function (ents) {
        for (var i = 0; i < ents.length; i++) visible = ents[i].isIntersecting;
        /* rAF 停了 tick 就不会再跑，滚回来要显式叫醒 */
        if (visible) kick(); else stop();
      }, { threshold: 0 });
      io.observe(ps);
    }

    cleanups.push(function () {
      stop();
      if (ro) ro.disconnect(); else window.removeEventListener("resize", layout);
      if (io) io.disconnect();
    });
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
