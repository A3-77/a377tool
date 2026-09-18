/* =========================================================================
   展示组件管理页的控件渲染
   数据来自服务端注入的 window.__A377_SITE__ = { key, blocks }
   左侧 iframe 是首页实时预览：任何改动立即 postMessage 过去，不写库；
   点「保存」才 POST 落库。
   ========================================================================= */
(function () {
  "use strict";

  var boot = window.__A377_SITE__;
  if (!boot || !boot.blocks) return;

  var KEY = boot.key;
  var state = boot.blocks;          // { gallery:{enabled,config}, photostack:{...} }
  var frame = document.getElementById("preview");

  /* ---------------- 视频档位 ----------------
     这一行是「组件 ↔ 管线」之间**唯一**的接口：组件声明自己要哪个档位，
     规格说明、判定、处理方案全部由独立的档位表推出来。

     换组件时只改这一行 —— 画廊不要了、换成别的视频组件，
     把 VIDEO_PROFILE 指到另一个档位就行，视频处理那套代码一个字都不用动。 */
  var VIDEO_PROFILE = "loop-card";

  /* 规格说明从档位表生成，不再手写。
     手写的版本和代码是两处事实，迟早不一致 ——
     出现「页面上说 720、代码里按 1080 裁」这种事最难查。 */
  function specLines(id) {
    var VS = window.VideoSpec;
    if (!VS) return [["提示", "视频档位模块没加载上，规格说明暂时取不到"]];
    try {
      return VS.describe(id);
    } catch (e) {
      return [["提示", "档位 " + id + " 不存在"]];
    }
  }

  /* ---------------- 控件定义 ----------------
     分类沿用 DialKit：slider / toggle / text / select / color / image / spring。
     min/max/step 决定滑杆范围，同时也会写进数字输入框。 */
  var SCHEMA = {
    gallery: {
      title: "弧形画廊",
      note: "把图片或视频弯成圆柱面横向滚动。拖拽可手动转，松手后按速度继续。素材点「＋ 上传」选文件，或直接把图片 / 视频拖进列表。",
      list: {
        key: "items",
        label: "展示内容",
        fields: [
          { key: "src", type: "text", placeholder: "点缩略图上传，或直接填 URL / 路径" },
          { key: "title", type: "text", placeholder: "说明文字（可选）" },
          { key: "type", type: "select", label: "类型", options: [
            { value: "", label: "自动（按扩展名）" },
            { value: "image", label: "图片" },
            { value: "video", label: "视频" }
          ] },
          { key: "poster", type: "text", placeholder: "视频封面图（可选）" }
        ]
      },
      groups: [
        { label: "视觉参数", open: true, fields: [
          { key: "perView",   type: "slider", label: "一屏可见卡片数", min: 2, max: 14, step: 1,
            hint: "决定卡片多大。半径和卡片尺寸都是按容器宽度反解的，换屏幕宽度不会跑偏" },
          { key: "angleStep", type: "slider", label: "卡片夹角（度）", min: 3, max: 45, step: 1,
            hint: "相邻两张卡的角度差。越大弯得越厉害、绕一圈需要的卡片越少" },
          { key: "aspect",    type: "slider", label: "卡片宽高比", min: 0.8, max: 2.4, step: 0.05,
            hint: "1.5 ≈ 3:2，2.0 ≈ 16:8" },
          { key: "dim",       type: "slider", label: "边缘压暗", min: 0, max: 1, step: 0.01 }
        ] },
        { label: "视频", open: true, fields: [
          /* 规格写在参数前面 —— 先知道该拿什么素材来，再谈怎么调。
             内容是从档位表生成的，不是手写：见上面 specLines() 的说明。 */
          { key: "_videoSpec", type: "note", title: "视频规格要求", lines: specLines(VIDEO_PROFILE) },
          { key: "_videoAuto", type: "note", title: "不符合要求怎么办", lines: [
            ["不用管", "上传时会在浏览器里自动处理：改尺寸、截片段、压体积、去音轨"],
            ["要等多久", "处理是实时的，8 秒的片段大约 8 秒出结果"],
            ["处理不了", "浏览器解不开的编码（HEVC / ProRes）会明确告诉你，那种要走命令行"],
          ] },
          { key: "videoAutoplay",   type: "toggle", label: "自动播放",
            hint: "关掉就只显示视频首帧，当静图用" },
          { key: "videoMaxPlaying", type: "slider", label: "最多同时播放", min: 0, max: 16, step: 1,
            hint: "只播离正前方最近的这几个。一圈会复制成二十多张卡，全播会把带宽和 CPU 吃光" },
          { key: "videoPreload", type: "select", label: "预加载", options: [
            { value: "metadata", label: "拉首帧当封面（好看）" },
            { value: "none",     label: "不预加载（省流量，建议配封面图）" }
          ] }
        ] },
        { label: "运动", open: true, fields: [
          { key: "speed",        type: "slider", label: "自动旋转（度/秒）", min: 0, max: 60, step: 0.5, hint: "0 = 不自动转，只能手动拖" },
          { key: "pauseOnHover", type: "toggle", label: "鼠标悬停时暂停" },
          { key: "drag",         type: "toggle", label: "允许拖拽" }
        ] },
        { label: "外观", open: true, fields: [
          { key: "bg", type: "color", label: "背景色" }
        ] }
      ]
    },

    photostack: {
      title: "Photo Stack",
      note: "多张照片叠在一起，点最上面那张换下一张。后面的照片按弹簧参数错位展开。素材点「＋ 上传」选文件，或直接把照片拖进列表 —— 每张照片的底色会自动取图里的平均色。",
      list: {
        key: "photos",
        label: "照片",
        unit: "张",
        newItem: { src: "", color: "#1a1a2e" },
        fields: [
          { key: "src", type: "text", placeholder: "点缩略图上传，或直接填 URL / 路径" },
          { key: "color", type: "color" }
        ]
      },
      groups: [
        { label: "文字", open: true, fields: [
          { key: "title",    type: "text", label: "标题", placeholder: "Japan" },
          { key: "subtitle", type: "text", label: "副标题", placeholder: "December 2025" }
        ] },
        { label: "外形", open: true, fields: [
          { key: "shape", type: "select", label: "照片形状", options: [
            { value: "portrait",  label: "竖版 340×480" },
            { value: "square",    label: "方形 400×400" },
            { value: "landscape", label: "横版 480×320" }
          ] },
          { key: "shadowTint", type: "color", label: "阴影色调" }
        ] },
        { label: "背片 Back Photo", open: true, fields: [
          { key: "offsetX", type: "slider", label: "水平偏移", min: 0, max: 400, step: 1,
            hint: "原版默认 239。改大背片露得更多" },
          { key: "offsetY", type: "slider", label: "垂直偏移", min: 0, max: 150, step: 1 },
          { key: "scale",   type: "slider", label: "缩放",     min: 0.5, max: 0.95, step: 0.01,
            hint: "缩放原点是左下角，所以背片底边始终跟正片对齐、只往右上缩" },
          { key: "overlayOpacity", type: "slider", label: "压暗程度", min: 0, max: 1, step: 0.01,
            hint: "从左到右由阴影色调渐变到透明，不是整片纯色" }
        ] },
        { label: "阴影", open: false, fields: [
          { key: "shadowScale",   type: "slider", label: "缩放",   min: 1, max: 1.2, step: 0.005,
            hint: "略大于 1，让阴影从照片边缘露出来一圈" },
          { key: "shadowOpacity", type: "slider", label: "不透明度", min: 0, max: 1,  step: 0.01 },
          { key: "shadowBlur",    type: "slider", label: "模糊",   min: 0, max: 60, step: 1 },
          { key: "shadowYOffset", type: "slider", label: "下沉",   min: 0, max: 60, step: 1,
            hint: "阴影是整张照片的模糊副本，所以会被照片的底色带出偏色" }
        ] },
        { label: "过渡弹簧 Transition Spring", open: true, fields: [
          { key: "spring.type",     type: "select", label: "类型", options: [
            { value: "time",    label: "Time（时长 + 弹跳）" },
            { value: "physics", label: "Physics（刚度 + 阻尼）" }
          ] },
          { key: "spring.duration", type: "slider", label: "时长 Duration", min: 0.1, max: 2, step: 0.01 },
          { key: "spring.bounce",   type: "slider", label: "弹跳 Bounce",   min: 0,   max: 1, step: 0.01 }
        ] },
        { label: "其他", open: true, fields: [
          { key: "darkMode", type: "toggle", label: "深色模式" }
        ] }
      ]
    }
  };

  /* ---------------- 小工具 ---------------- */
  function el(tag, props) {
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      var v = props[k];
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.indexOf("on") === 0) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid == null) continue;
      n.append(kid);
    }
    return n;
  }

  function get(obj, path) {
    var parts = path.split("."), cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur == null || typeof cur !== "object") return undefined;
      cur = cur[parts[i]];
    }
    return cur;
  }

  function put(obj, path, val) {
    var parts = path.split("."), cur = obj;
    for (var i = 0; i < parts.length - 1; i++) {
      var p = parts[i];
      if (typeof cur[p] !== "object" || cur[p] === null) cur[p] = {};
      cur = cur[p];
    }
    cur[parts[parts.length - 1]] = val;
  }

  /* 数字收敛到合法区间，避免手输 99999 把页面搞崩 */
  function clampNum(v, f) {
    var n = Number(v);
    if (!isFinite(n)) return 0;
    if (f.min != null && n < f.min) n = f.min;
    if (f.max != null && n > f.max) n = f.max;
    if (f.step) n = Math.round(n / f.step) * f.step;
    return Math.round(n * 1000) / 1000;
  }

  /* ---------------- 预览：改动即时同步到 iframe ---------------- */
  var pending = false;
  function preview() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () {
      pending = false;
      if (!frame || !frame.contentWindow) return;
      var blocks = {};
      for (var kind in state) {
        if (state[kind] && state[kind].enabled) blocks[kind] = state[kind].config;
      }
      frame.contentWindow.postMessage(
        { type: "a377:showcase-preview", blocks: blocks }, window.location.origin);
    });
  }

  function reloadPreview() {
    if (frame) frame.src = frame.src;
  }

  /* ---------------- 字段渲染 ---------------- */
  function field(f, cfg) {
    var wrap = el("div", { class: "field" });

    /* 纯说明块：不绑数据、不参与保存，只把「该按什么规格准备素材」写在手边。
       放在这里而不是文档里，是因为改配置的人就在这个页面上，
       规格不写在眼前等于没写。 */
    if (f.type === "note") {
      var box = el("div", { class: "spec" });
      if (f.title) box.append(el("div", { class: "spec-title", text: f.title }));
      (f.lines || []).forEach(function (ln) {
        box.append(el("div", { class: "spec-line" },
          el("span", { class: "k", text: ln[0] }),
          el("span", { class: "v", text: ln[1] })));
      });
      wrap.append(box);
      return wrap;
    }

    var val = get(cfg, f.key);
    var id = "f_" + f.key.replace(/\./g, "_");

    wrap.append(el("label", { for: id, text: f.label }));

    if (f.type === "slider") {
      var range = el("input", {
        type: "range", id: id,
        min: f.min, max: f.max, step: f.step,
        value: val == null ? f.min : val
      });
      var num = el("input", { type: "number", class: "num", step: f.step, value: val == null ? "" : val });
      range.addEventListener("input", function () {
        var v = clampNum(range.value, f);
        num.value = v; put(cfg, f.key, v); preview();
      });
      num.addEventListener("input", function () {
        var v = clampNum(num.value, f);
        put(cfg, f.key, v); range.value = v; preview();
      });
      num.addEventListener("blur", function () { num.value = get(cfg, f.key); });
      wrap.append(el("div", { class: "row" }, range, num));
    }

    else if (f.type === "toggle") {
      var cb = el("input", { type: "checkbox", id: id });
      cb.checked = !!val;
      cb.addEventListener("change", function () { put(cfg, f.key, cb.checked); preview(); });
      wrap.append(el("div", { class: "row" },
        el("label", { class: "switch", for: id }, cb, el("span", { class: "track" }))));
    }

    else if (f.type === "select") {
      var sel = el("select", { id: id });
      (f.options || []).forEach(function (o) {
        var opt = el("option", { value: o.value, text: o.label });
        if (String(val) === String(o.value)) opt.selected = true;
        sel.append(opt);
      });
      sel.addEventListener("change", function () { put(cfg, f.key, sel.value); preview(); });
      wrap.append(sel);
    }

    else if (f.type === "color") {
      var color = el("input", { type: "color", id: id, value: /^#[0-9a-f]{6}$/i.test(val) ? val : "#000000" });
      var hex = el("input", { type: "text", class: "hex", value: val == null ? "" : val, placeholder: "#000000" });
      color.addEventListener("input", function () { hex.value = color.value; put(cfg, f.key, color.value); preview(); });
      hex.addEventListener("input", function () {
        if (/^#[0-9a-f]{6}$/i.test(hex.value)) { color.value = hex.value; put(cfg, f.key, hex.value); preview(); }
      });
      hex.addEventListener("blur", function () { hex.value = get(cfg, f.key) || ""; });
      wrap.append(el("div", { class: "row" }, color, hex));
    }

    else { /* text / image 都是普通文本框 */
      var txt = el("input", {
        type: "text", id: id,
        value: val == null ? "" : val,
        placeholder: f.placeholder || ""
      });
      txt.addEventListener("input", function () { put(cfg, f.key, txt.value); preview(); });
      wrap.append(txt);
      if (f.type === "image") {
        var pv = el("img", { class: "thumb", style: "margin-top:8px;width:100%;height:90px" });
        pv.src = val || "";
        pv.addEventListener("error", function () { pv.style.visibility = "hidden"; });
        pv.addEventListener("load", function () { pv.style.visibility = "visible"; });
        txt.addEventListener("input", function () { pv.src = txt.value; });
        wrap.append(pv);
      }
    }

    if (f.hint) wrap.append(el("div", { class: "hint", text: f.hint }));
    return wrap;
  }

  /* ---------------- 上传 ----------------
     为什么要在浏览器里先压一遍：
       手机直出的一张照片是 3-5MB / 4000×3000，而画廊卡片实测只有约 380×270
       （2x 屏也就 760）。不压的话一张图就吃掉 KV 免费额度（总共 1GB）的一大块，
       而且上传还慢。让用户自己先去找工具压是不现实的，所以在这里做掉。

     顺便取一个平均色：Photo Stack 每张照片都要一个 color 当阴影底色
       （原版是手填的），这里从图里算出来当默认值，省一步。 */
  var MAX_EDGE = 1600;                 /* 长边上限。够 2x 屏，再多是白占体积 */
  var RECOMPRESS_OVER = 700 * 1024;    /* 小于这个就不折腾，原图直传 */

  function fmtSize(n) {
    if (n < 1024) return n + " B";
    if (n < 1048576) return Math.round(n / 1024) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  }

  function baseName(name) {
    return String(name || "file")
      .replace(/\.[^.]+$/, "")
      .replace(/[^\w\u4e00-\u9fa5.-]+/g, "-")
      .slice(0, 60) || "file";
  }

  function loadImage(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { resolve({ img: img, url: url }); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("读不出这张图")); };
      img.src = url;
    });
  }

  function toBlob(canvas, type, q) {
    return new Promise(function (resolve) { canvas.toBlob(resolve, type, q); });
  }

  /* 把整张图画到 1×1 的 canvas 上再读那个像素 —— 等价于求平均色，
     比逐像素遍历快几个数量级，当占位色完全够。
     imageSmoothingQuality 要给 high：low 的话是抽样不是平均，
     取出来会明显偏某一边的颜色。 */
  function averageColor(img) {
    try {
      var cv = document.createElement("canvas");
      cv.width = cv.height = 1;
      var ctx = cv.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.drawImage(img, 0, 0, 1, 1);
      var d = ctx.getImageData(0, 0, 1, 1).data;
      return "#" + [d[0], d[1], d[2]].map(function (n) {
        return ("0" + n.toString(16)).slice(-2);
      }).join("");
    } catch (e) {
      return "";   /* 跨域图会污染 canvas，取不到就算了，不是致命错误 */
    }
  }

  function recompress(img) {
    var w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) return Promise.resolve(null);
    var k = Math.min(1, MAX_EDGE / Math.max(w, h));
    var cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(w * k));
    cv.height = Math.max(1, Math.round(h * k));
    var ctx = cv.getContext("2d");
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, cv.width, cv.height);
    /* 不指定 alpha 的话统一走 jpeg（编码快、兼容性最好）；
       png/webp/avif 可能是带透明度的，转 webp 保住 alpha。 */
    return toBlob(cv, "image/jpeg", 0.86);
  }

  /* 秒 → 0:05。选段框要告诉人「留下第几秒到第几秒」，
     直接报 3.333 没人读得懂。 */
  function fmtSec(s) {
    s = Math.max(0, Number(s) || 0);
    var m = Math.floor(s / 60);
    var r = s - m * 60;
    return m + ":" + (r < 10 ? "0" : "") + r.toFixed(1);
  }

  /* 视频超过档位时长时，让用户自己挑留下哪一段。
     默认策略是「从头截 maxSeconds」，但想留的那段经常在中间 ——
     盲目截开头等于替用户做了决定，用户还没法改。
     这里给一条全长轨道 + 可拖的选区（两端调长度、中间整体挪、
     点空白直接跳过去），选完把 trim 交给视频管线。
     返回 null = 用户不挑，走默认。 */
  function pickClip(file, total, lim) {
    return new Promise(function (resolve) {
      var url = URL.createObjectURL(file);
      var MIN = 0.5;                       /* 再短就没内容了 */
      var CAP = lim.maxSeconds;
      var start = 0;
      var end = Math.min(CAP, total);

      var vid = el("video", { class: "clip-video", src: url, controls: true, playsinline: true });
      var hL = el("div", { class: "clip-handle l" });
      var hR = el("div", { class: "clip-handle r" });
      var sel = el("div", { class: "clip-sel" }, hL, hR);
      var track = el("div", { class: "clip-track" }, sel);
      var readout = el("div", { class: "clip-meta" });

      function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

      function render() {
        sel.style.left = (start / total * 100) + "%";
        sel.style.width = ((end - start) / total * 100) + "%";
        readout.textContent = "";
        readout.append(
          el("span", {}, "留下 ", el("b", { text: fmtSec(start) + " – " + fmtSec(end) })),
          el("span", {}, "共 ", el("b", { text: (end - start).toFixed(1) + " 秒" })),
          el("span", { style: "color:var(--faint)" },
            "全长 " + fmtSec(total) + "，档位上限 " + CAP + " 秒")
        );
      }

      /* 试看选中这段。光看两个数字判断不了截得对不对 ——
         尤其想留的是中间某段时，必须能真的看一眼。 */
      function playSel() {
        try { vid.currentTime = start; vid.play(); } catch (e) { /* 跳不了就算了 */ }
      }
      vid.addEventListener("timeupdate", function () {
        if (vid.currentTime >= end) vid.pause();
      });

      var drag = null;
      function onMove(e) {
        if (!drag) return;
        var dt = ((e.clientX - drag.x0) / drag.w) * total;
        if (drag.mode === "move") {
          var len = drag.e0 - drag.s0;
          start = clamp(drag.s0 + dt, 0, total - len);
          end = start + len;
        } else if (drag.mode === "l") {
          start = clamp(drag.s0 + dt, 0, end - MIN);
          /* 左手柄往右推过头会把长度压过上限，反过来拽终点 */
          if (end - start > CAP) start = end - CAP;
        } else {
          end = clamp(drag.e0 + dt, start + MIN, Math.min(total, start + CAP));
        }
        render();
      }
      function onUp() {
        drag = null;
        sel.classList.remove("grabbing");
      }
      /* 手柄是选区的子元素，stopPropagation 免得拖手柄被当成整体挪动 */
      function onDown(e, mode) {
        e.preventDefault();
        e.stopPropagation();
        drag = {
          mode: mode, x0: e.clientX,
          w: track.getBoundingClientRect().width,
          s0: start, e0: end,
        };
        sel.classList.add("grabbing");
      }
      hL.addEventListener("pointerdown", function (e) { onDown(e, "l"); });
      hR.addEventListener("pointerdown", function (e) { onDown(e, "r"); });
      sel.addEventListener("pointerdown", function (e) { onDown(e, "move"); });

      /* 点轨道空白处 = 选区直接挪过去（居中），比拖快 */
      track.addEventListener("pointerdown", function (e) {
        if (e.target !== track) return;
        var r = track.getBoundingClientRect();
        var t = ((e.clientX - r.left) / r.width) * total;
        var len = end - start;
        start = clamp(t - len / 2, 0, total - len);
        end = start + len;
        render();
      });

      function close(val) {
        document.removeEventListener("pointermove", onMove);
        document.removeEventListener("pointerup", onUp);
        document.removeEventListener("keydown", onKey);
        try { vid.pause(); } catch (e) { /* 已经停了 */ }
        URL.revokeObjectURL(url);
        if (mask.parentNode) mask.parentNode.removeChild(mask);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === "Escape") close(null);
        else if (e.key === "Enter") close({ start: start, end: end });
      }

      var mask = el("div", { class: "clip-mask" },
        el("div", { class: "clip-box" },
          el("h3", { text: "挑一段留下" }),
          el("p", {
            class: "clip-sub",
            text: "这个视频 " + fmtSec(total) + "，超过「" + (lim.label || "该档位") +
                  "」上限 " + CAP + " 秒。拖选区挑要留下的那一段，然后「用这段」。",
          }),
          vid, track, readout,
          el("div", { class: "clip-acts" },
            el("button", { class: "btn", type: "button", onclick: playSel }, "▶ 试看这段"),
            el("span", { style: "flex:1" }),
            el("button", {
              class: "btn", type: "button",
              onclick: function () { close(null); },
            }, "取消"),
            el("button", {
              class: "btn primary", type: "button",
              onclick: function () { close({ start: start, end: end }); },
            }, "用这段")
          )
        )
      );
      mask.addEventListener("pointerdown", function (e) {
        if (e.target === mask) close(null);
      });
      document.addEventListener("pointermove", onMove);
      document.addEventListener("pointerup", onUp);
      document.addEventListener("keydown", onKey);
      document.body.append(mask);
      render();
    });
  }

  /* 视频：交给独立的视频管线处理。
     判什么算不合规、该怎么改，全在 video-spec.js + video-prep.js 里；
     这里只负责把结果接到上传流程上 —— 以后换掉画廊、上别的视频组件，
     这一整块不用动，改 VIDEO_PROFILE 那一行就行。 */
  function prepareVideo(file, onProgress) {
    var VP = window.VideoPrep;
    if (!VP || !VP.available()) {
      return Promise.resolve({
        file: file, color: "", note: "",
        warn: "这个浏览器不能就地处理视频，会原样上传 —— " +
              "超过服务端上限的话会被拒",
      });
    }

    /* 超长的先问一句截哪段。只在这个档位有时长上限、且真的超了才弹 ——
       没超长还弹是打扰。探测失败就当没超，让管线按默认处理。 */
    function askClip() {
      var VS = window.VideoSpec;
      var lim = VS && VS.PROFILES && VS.PROFILES[VIDEO_PROFILE];
      if (!lim || !lim.maxSeconds) return Promise.resolve(null);
      return VP.probeFile(file).then(function (meta) {
        var total = meta && meta.seconds;
        if (!total) return null;
        var grace = VS.DURATION_GRACE || 0;
        if (total <= lim.maxSeconds + grace) return null;
        return pickClip(file, total, lim);
      }).catch(function () { return null; });
    }

    return askClip().then(function (clip) {
      var extra = [];
      var override = clip ? { trim: [clip.start, clip.end] } : {};
      return VP.process(file, VIDEO_PROFILE, override, {
        onProgress: function (r, phase) {
          if (onProgress) onProgress(phase + " " + Math.round(r * 100) + "%");
        },
        onNote: function (n) { extra.push(n); },
      }).then(function (r) {
        if (r.skipped) return { file: file, color: "", note: "" };
        return {
          file: r.file, color: "",
          note: r.note + (extra.length ? "（" + extra.join("；") + "）" : ""),
          /* 处理完还是没达标（体积压不下去、或改完仍有违规）必须说出来 ——
             默默传一个不合规的文件，用户只会以为工具坏了 */
          warn: r.warn || "",
        };
      }).catch(function (e) {
        /* 处理不了就原样传，让服务端按规则判。但必须把原因说清楚 ——
           不然用户只看到一句「上传失败」，不知道该干什么。
           最典型的是浏览器解不开 HEVC / ProRes，那种得走命令行。 */
        return { file: file, color: "", note: "", warn: e.message };
      });
    });
  }

  /* 返回 { file, color, note, warn }；note 是给用户看的「改了什么」 */
  function prepare(file, onProgress) {
    /* 是不是视频要 MIME 和扩展名一起看：从相册拖出来的 HEVC 视频
       type 经常是空的，只看 MIME 会漏判。 */
    if (/^video\//.test(file.type) || VIDEO_RE.test(file.name)) {
      return prepareVideo(file, onProgress);
    }
    /* gif 是动图，canvas 重编码会把动画压成一张静图 —— 别碰它 */
    if (!/^image\//.test(file.type) || file.type === "image/gif") {
      return Promise.resolve({ file: file, color: "", note: "" });
    }
    return loadImage(file).then(function (r) {
      var color = averageColor(r.img);
      var big = file.size > RECOMPRESS_OVER ||
        Math.max(r.img.naturalWidth, r.img.naturalHeight) > MAX_EDGE;
      if (!big) {
        URL.revokeObjectURL(r.url);
        return { file: file, color: color, note: "" };
      }
      /* 统一出 jpeg：上传的图会当卡片背景，没有 alpha 需求 */
      return recompress(r.img).then(function (blob) {
        URL.revokeObjectURL(r.url);
        /* 压完反而更大就别压 —— 已经是高质量小图的情况很常见 */
        if (!blob || blob.size >= file.size) return { file: file, color: color, note: "" };
        return {
          file: new File([blob], baseName(file.name) + ".jpg", { type: "image/jpeg" }),
          color: color,
          note: fmtSize(file.size) + " → " + fmtSize(blob.size),
        };
      });
    }).catch(function () {
      /* 解不出来（少见格式 / 文件损坏）就原样传，让服务端按 Content-Type 判 */
      return { file: file, color: "", note: "" };
    });
  }

  /* 上传。onProgress 是给状态行用的，处理是一张张串行的 ——
     并行压十几张 4000×3000 会把主线程卡住，界面看着像死了；
     视频更甚，浏览器只能实时转码，并行跑会互相抢 CPU。 */
  function uploadFiles(files, onProgress) {
    var list = Array.prototype.slice.call(files);
    if (!list.length) return Promise.resolve({ files: [] });

    var items = [];
    return list.reduce(function (chain, f, i) {
      return chain.then(function () {
        if (onProgress) onProgress("处理 " + (i + 1) + "/" + list.length + "：" + f.name);
        return prepare(f, onProgress).then(function (r) {
          items.push({
            file: r.file, color: r.color, note: r.note,
            warn: r.warn, original: f.name,
          });
        });
      });
    }, Promise.resolve()).then(function () {
      var fd = new FormData();
      items.forEach(function (it) { fd.append("file", it.file); });
      if (onProgress) onProgress("上传 " + items.length + " 个文件…");
      return fetch("/api/media?key=" + encodeURIComponent(KEY), { method: "POST", body: fd });
    }).then(function (res) {
      return res.json().catch(function () { return null; }).then(function (data) {
        if (!res.ok || !data || !data.ok) {
          var msg = (data && data.error) || ("HTTP " + res.status);
          if (res.status === 503) msg = "还没绑定素材存储。" + msg;
          throw new Error(msg);
        }
        /* 服务端按提交顺序返回，用下标把颜色和处理说明对回来 */
        data.files = data.files.map(function (f, i) {
          var it = items[i] || {};
          f.color = it.color || "";
          f.original = it.original || f.name;
          f.note = it.note || "";
          f.warn = it.warn || "";
          return f;
        });
        return data;
      });
    });
  }

  /* ---------------- 内容列表（图片 / 视频混排） ---------------- */

  /* 和 assets/showcase.js 里的判定保持一致：显式 type 优先，否则按扩展名猜。
     两边不一致的话，后台显示「视频」而前台渲染成图片，很难查。 */
  var VIDEO_RE = /\.(mp4|m4v|webm|ogv|ogg|mov)(\?|#|$)/i;

  function itemIsVideo(it) {
    if (it.type === "video") return true;
    if (it.type === "image") return false;
    return VIDEO_RE.test(it.src || "");
  }

  /* 缩略图：视频用 <video> 取首帧。
     src 加 #t=0.1 是必须的 —— 不加的话视频缩略图是一块黑，
     浏览器不会自动解码第一帧给 <video> 当画面。 */
  function makeThumb(it) {
    var vid = itemIsVideo(it);
    var node = document.createElement(vid ? "video" : "img");
    node.className = "thumb";
    if (vid) {
      node.muted = true;
      node.playsInline = true;
      node.preload = "metadata";
      node.setAttribute("muted", "");
      node.setAttribute("playsinline", "");
      node.setAttribute("tabindex", "-1");
      if (it.src) node.src = it.src + (it.src.indexOf("#") < 0 ? "#t=0.1" : "");
    } else {
      node.alt = "";
      if (it.src) node.src = it.src;
    }
    /* 坏链接别显示破图图标，直接藏起来（之前用 removeAttribute("src") 没用，
       浏览器照样画破图） */
    node.style.visibility = it.src ? "" : "hidden";
    node.addEventListener("error", function () { node.style.visibility = "hidden"; });
    node.addEventListener(vid ? "loadeddata" : "load", function () {
      if (node.getAttribute("src")) node.style.visibility = "";
    });
    return node;
  }

  function listEditor(spec, cfg) {
    var box = el("div", { class: "list" });
    var items = Array.isArray(cfg[spec.key]) ? cfg[spec.key] : (cfg[spec.key] = []);
    var unit = spec.unit || "项";
    /* 新增项的默认色（Photo Stack 的底色）。上传替换时靠它判断
       「用户有没有自己挑过颜色」—— 还是默认值就说明没挑过，可以自动填。 */
    var defColor = spec.newItem ? spec.newItem.color : null;

    /* 上传进度行。box 是常驻的（redraw 只清子节点），
       所以 statusEl 建一次、每次 redraw 重新 append 回去就行。 */
    var statusEl = el("span", { class: "upstatus" });
    function setStatus(msg, on) {
      statusEl.textContent = msg || "";
      box.classList.toggle("busy", !!on);
    }

    /* 上传完造一项。title / color 只有这个列表声明了才填 ——
       画廊要 title（拿文件名当说明文字），Photo Stack 要 color（拿平均色当底色）。 */
    function itemFrom(f) {
      var it = spec.newItem ? Object.assign({}, spec.newItem) : { src: "", title: "" };
      it.src = f.url;
      if ("title" in it && !it.title) it.title = baseName(f.original);
      if ("color" in it && f.color) it.color = f.color;
      return it;
    }

    function replaceAt(index, f) {
      var it = items[index];
      if (!it) return;
      it.src = f.url;
      /* 底色跟着新图走，但只在用户没自己挑过的时候 ——
         不然上传一张新照片会把调好的阴影色调冲掉。 */
      if ("color" in it && f.color && (!it.color || it.color === defColor)) it.color = f.color;
    }

    function pickFiles(index) {
      var inp = document.createElement("input");
      inp.type = "file";
      inp.accept = "image/*,video/*";
      inp.multiple = index == null;     /* 替换是「换掉这一项」，只收一个 */
      inp.addEventListener("change", function () {
        if (inp.files && inp.files.length) runUpload(inp.files, index);
      });
      inp.click();
    }

    function runUpload(fileList, index) {
      var replace = index != null;
      setStatus("准备上传…", true);
      uploadFiles(fileList, function (msg) { setStatus(msg, true); }).then(function (data) {
        var notes = [], warns = [];
        data.files.forEach(function (f, i) {
          if (!replace) items.push(itemFrom(f));
          else if (i === 0) replaceAt(index, f);
          if (f.note) notes.push(f.original + "：" + f.note);
          if (f.warn) warns.push(f.original + "：" + f.warn);
        });
        setStatus("", false);
        redraw(); preview();
        /* 改过什么必须说出来 —— 不然用户不知道视频被裁过、截过、压过，
           也不知道 48MB 是怎么变成 900KB 的 */
        var msg = (replace ? "已替换素材" : "已上传 " + data.files.length + " 个") + "，记得点保存";
        if (notes.length) msg += "（已处理 " + notes.join("；") + "）";
        /* 没能处理的情况单独提示。这类问题（浏览器解不开的编码）
           用户不盯着状态行的话根本不会知道 */
        toast(warns.length ? msg + " ⚠ " + warns.join("；") : msg, warns.length ? "bad" : "ok");
      }).catch(function (e) {
        setStatus("", false);
        toast("上传失败：" + e.message, "bad");
      });
    }

    /* 拖进来就传 —— 这是「上传」最自然的动作，
       比先点按钮再在文件对话框里翻目录快得多。
       dragover 必须 preventDefault，否则浏览器根本不会派发 drop。 */
    function hasFiles(e) {
      var t = e.dataTransfer && e.dataTransfer.types;
      return !!t && Array.prototype.indexOf.call(t, "Files") >= 0;
    }
    box.addEventListener("dragenter", function (e) { if (hasFiles(e)) e.preventDefault(); });
    box.addEventListener("dragover", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      box.classList.add("dropping");
    });
    box.addEventListener("dragleave", function (e) {
      /* 移到子元素上也会触发 dragleave，不判断 relatedTarget 的话高亮会闪 */
      if (!box.contains(e.relatedTarget)) box.classList.remove("dropping");
    });
    box.addEventListener("drop", function (e) {
      if (!hasFiles(e)) return;
      e.preventDefault();
      box.classList.remove("dropping");
      runUpload(e.dataTransfer.files, null);
    });

    function redraw() {
      box.textContent = "";
      box.append(el("div", { class: "list-head" },
        el("b", { text: spec.label }),
        el("span", { class: "count", text: items.length + " " + unit }),
        statusEl,
        el("span", { class: "sp" }),
        el("button", {
          class: "btn", type: "button",
          title: "从电脑里选图片或视频，可多选；也可以直接把文件拖到这里",
          onclick: function () { pickFiles(null); }
        }, "＋ 上传"),
        el("button", {
          class: "btn", type: "button",
          onclick: function () {
            /* 新增项的模板由 spec 给 —— 画廊要 title，照片列表要 color */
            items.push(spec.newItem ? Object.assign({}, spec.newItem) : { src: "", title: "" });
            redraw(); preview();
          }
        }, "+ 添加一" + unit)));

      if (!items.length) {
        box.append(el("div", { class: "empty", text: "还没有内容。点「＋ 上传」选文件，或直接把图片 / 视频拖到这里。" }));
        return;
      }

      items.forEach(function (it, i) {
        /* 缩略图槽既是预览也是上传入口 —— 点它就能把这一项换成电脑里的文件。
           做成 <button> 而不是加个「上传」小按钮，是因为 52×40 的格子里
           再塞一个按钮太挤，而「点缩略图换图」本来就是直觉动作。
           thumbBox 单独一层：改 src / type 时只换它里面的元素，
           图片和视频是两种元素类型，原地改 src 换不了。 */
        var thumbBox = el("div", { class: "thumb-box" });
        var slot = el("button", {
          class: "thumb-slot", type: "button",
          title: "点这里上传，替换这一项的素材",
          onclick: function () { pickFiles(i); }
        }, thumbBox);
        function renderThumb() {
          thumbBox.textContent = "";
          thumbBox.append(makeThumb(it));
          slot.setAttribute("data-kind", itemIsVideo(it) ? "video" : "image");
        }
        renderThumb();

        var grow = el("div", { class: "grow" });
        spec.fields.forEach(function (f) {
          var field;
          if (f.type === "select") {
            field = el("select", { class: "mini" });
            (f.options || []).forEach(function (o) {
              var opt = el("option", { value: o.value, text: o.label });
              if ((it[f.key] || "") === o.value) opt.selected = true;
              field.append(opt);
            });
          } else if (f.type === "color") {
            /* 底色是颜色，给个色板比让人手打十六进制顺手；
               title 上挂着当前值，想看确切色号悬停即可 */
            field = el("input", {
              type: "color", class: "mini-color",
              value: /^#[0-9a-f]{6}$/i.test(it[f.key] || "") ? it[f.key] : "#1a1a2e",
              title: it[f.key] || ""
            });
          } else {
            field = el("input", {
              type: "text", value: it[f.key] == null ? "" : it[f.key],
              placeholder: f.placeholder || f.key
            });
          }
          field.addEventListener("input", function () {
            it[f.key] = field.value;
            if (f.key === "src" || f.key === "type") renderThumb();
            preview();
          });
          field.addEventListener("change", function () {
            it[f.key] = field.value;
            if (f.key === "src" || f.key === "type") renderThumb();
            preview();
          });
          grow.append(field);
        });

        var ops = el("div", { class: "ops" },
          el("button", {
            class: "iconbtn", type: "button", title: "上移", disabled: i === 0,
            onclick: function () { swap(items, i, i - 1); redraw(); preview(); }
          }, "\u2191"),
          el("button", {
            class: "iconbtn", type: "button", title: "下移", disabled: i === items.length - 1,
            onclick: function () { swap(items, i, i + 1); redraw(); preview(); }
          }, "\u2193"),
          el("button", {
            class: "iconbtn", type: "button", title: "删除",
            onclick: function () { items.splice(i, 1); redraw(); preview(); }
          }, "\u2715"));

        box.append(el("div", { class: "item" }, slot, grow, ops));
      });
    }

    redraw();
    return box;
  }

  function swap(arr, a, b) {
    if (b < 0 || b >= arr.length) return;
    var t = arr[a]; arr[a] = arr[b]; arr[b] = t;
  }

  /* ---------------- 组件块 ---------------- */
  function renderBlock(kind) {
    var spec = SCHEMA[kind];
    var st = state[kind];
    if (!spec || !st) return null;

    var cb = el("input", { type: "checkbox" });
    cb.checked = !!st.enabled;
    cb.addEventListener("change", function () { st.enabled = cb.checked ? 1 : 0; preview(); });

    var head = el("div", { class: "block-head" },
      el("h2", { text: spec.title }),
      el("span", { class: "kind", text: kind }),
      el("label", { class: "switch" }, cb, el("span", { class: "track" }),
        el("span", { text: "启用" })));

    var wrap = el("div", { class: "block" }, head, el("p", { class: "block-note", text: spec.note }));

    if (spec.list) wrap.append(listEditor(spec.list, st.config));

    (spec.groups || []).forEach(function (g) {
      var body = el("div", { class: "body" });
      g.fields.forEach(function (f) { body.append(field(f, st.config)); });
      wrap.append(el("details", { class: "folder", open: g.open !== false },
        el("summary", {}, document.createTextNode(g.label)), body));
    });

    wrap.append(el("div", { class: "acts", style: "margin-top:16px" },
      el("button", {
        class: "btn danger", type: "button",
        onclick: function () { reset(kind); }
      }, "恢复默认")));

    return wrap;
  }

  /* ---------------- 保存 ---------------- */
  function toast(msg, kind) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.className = "toast on " + (kind || "");
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.className = "toast " + (kind || ""); }, 2600);
  }

  function post(body) {
    return fetch("/api/site-admin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.assign({ key: KEY }, body))
    }).then(function (r) { return r.json().then(function (j) { return { status: r.status, body: j }; }); });
  }

  function save() {
    var btn = document.getElementById("save");
    btn.disabled = true;
    post({ blocks: state }).then(function (res) {
      btn.disabled = false;
      if (!res.body || !res.body.ok) { toast("保存失败：" + ((res.body && res.body.error) || res.status), "bad"); return; }
      toast("已保存，预览已刷新", "ok");
      reloadPreview();     // 重新拉一次，确认落库后前台确实是这样
    }).catch(function (e) {
      btn.disabled = false;
      toast("保存失败：" + e.message, "bad");
    });
  }

  function reset(kind) {
    if (!confirm("把「" + SCHEMA[kind].title + "」恢复成默认配置？当前改动会丢。")) return;
    post({ reset: kind }).then(function (res) {
      if (!res.body || !res.body.ok) { toast("恢复失败：" + ((res.body && res.body.error) || res.status), "bad"); return; }
      toast("已恢复默认，正在刷新", "ok");
      setTimeout(function () { location.reload(); }, 600);
    });
  }

  /* ---------------- 启动 ---------------- */
  var panel = document.getElementById("blocks");
  ["gallery", "photostack"].forEach(function (kind) {
    var node = renderBlock(kind);
    if (node) panel.append(node);
  });

  document.getElementById("save").addEventListener("click", save);
  document.getElementById("reload").addEventListener("click", reloadPreview);

  /* iframe 每次加载完都补发一次当前状态，避免刷新后预览回退成库里的旧值 */
  if (frame) frame.addEventListener("load", function () { setTimeout(preview, 60); });

  preview();
})();
