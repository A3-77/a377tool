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

  /* ---------------- 控件定义 ----------------
     分类沿用 DialKit：slider / toggle / text / select / color / image / spring。
     min/max/step 决定滑杆范围，同时也会写进数字输入框。 */
  var SCHEMA = {
    gallery: {
      title: "弧形画廊",
      note: "把图片弯成圆柱面横向滚动。拖拽可手动转，松手后按速度继续。",
      list: {
        key: "items",
        label: "展示图片",
        fields: [
          { key: "src", type: "text", placeholder: "图片 URL，例如 /assets/showcase/g1.svg" },
          { key: "title", type: "text", placeholder: "说明文字（可选）" }
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
      note: "一张主照片，后面压一张错位的背片。悬停时按弹簧参数展开。",
      groups: [
        { label: "内容", open: true, fields: [
          { key: "title",    type: "text", label: "标题", placeholder: "Japan" },
          { key: "subtitle", type: "text", label: "副标题", placeholder: "December 2025" },
          { key: "front",    type: "image", label: "正片 URL" },
          { key: "back",     type: "image", label: "背片 URL" }
        ] },
        { label: "外形", open: true, fields: [
          { key: "width", type: "slider", label: "照片宽度 (px)", min: 160, max: 620, step: 4 },
          { key: "shape", type: "select", label: "照片形状", options: [
            { value: "portrait",  label: "竖版 Portrait" },
            { value: "landscape", label: "横版 Landscape" },
            { value: "square",    label: "方形 Square" }
          ] },
          { key: "shadowTint", type: "color", label: "阴影色调" }
        ] },
        { label: "背片 Back Photo", open: true, fields: [
          { key: "offsetX",        type: "slider", label: "水平偏移", min: -400, max: 400, step: 1 },
          { key: "offsetY",        type: "slider", label: "垂直偏移", min: -400, max: 400, step: 1 },
          { key: "scale",          type: "slider", label: "缩放",     min: 0.4,  max: 1.6, step: 0.01 },
          { key: "overlayOpacity", type: "slider", label: "压暗程度", min: 0, max: 1, step: 0.01 }
        ] },
        { label: "阴影", open: false, fields: [
          { key: "shadowBlur",    type: "slider", label: "模糊", min: 0, max: 160, step: 1 },
          { key: "shadowOpacity", type: "slider", label: "不透明度", min: 0, max: 1, step: 0.01 }
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

  /* ---------------- 图片列表 ---------------- */
  function listEditor(spec, cfg) {
    var box = el("div", { class: "list" });
    var items = Array.isArray(cfg[spec.key]) ? cfg[spec.key] : (cfg[spec.key] = []);

    function redraw() {
      box.textContent = "";
      box.append(el("div", { class: "list-head" },
        el("b", { text: spec.label }),
        el("span", { class: "count", text: items.length + " 张" }),
        el("span", { class: "sp" }),
        el("button", {
          class: "btn", type: "button",
          onclick: function () { items.push({ src: "", title: "" }); redraw(); preview(); }
        }, "+ 添加一张")));

      if (!items.length) {
        box.append(el("div", { class: "empty", text: "还没有图片。点「+ 添加一张」开始。" }));
        return;
      }

      items.forEach(function (it, i) {
        var thumb = el("img", { class: "thumb", alt: "" });
        thumb.src = it.src || "";
        thumb.addEventListener("error", function () { thumb.removeAttribute("src"); });

        var grow = el("div", { class: "grow" });
        spec.fields.forEach(function (f) {
          var inp = el("input", {
            type: "text", value: it[f.key] == null ? "" : it[f.key],
            placeholder: f.placeholder || f.key
          });
          inp.addEventListener("input", function () {
            it[f.key] = inp.value;
            if (f.key === "src") thumb.src = inp.value;
            preview();
          });
          grow.append(inp);
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

        box.append(el("div", { class: "item" }, thumb, grow, ops));
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
