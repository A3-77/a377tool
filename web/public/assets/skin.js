/* =========================================================================
   A377Tool · 双皮肤切换
   皮肤：classic（v0.2 原版视觉）| one（One Page Love 黑白网格）

   在 <head> 末尾同步引入 —— 必须在页面自身 <style> 之后，
   这样 one 皮肤注入的 onepage.css 才会落在页面样式之后。

   机制：/assets/onepage.css 只是 one 皮肤的覆盖层。
        classic 下这个文件根本不加载，所以不存在「覆盖层泄漏到经典皮肤」的问题。

   对外：
       window.A377Skin.get() / set(v) / toggle() / refresh()
       window 上派发 "a377:skinchange"，detail = { skin }
   ========================================================================= */
(function () {
  "use strict";

  var KEY = "a377skin";
  var DEFAULT_SKIN = "classic";   /* 想默认走新版，把这里改成 "one" */
  var OVERLAY_ID = "a377-onepage";
  var META_ONE = "#000000";

  var root = document.documentElement;

  function norm(v) { return v === "one" ? "one" : "classic"; }

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "one" || v === "classic" ? v : null;
    } catch (e) { return null; }
  }

  function current() { return norm(root.dataset.skin); }

  /* onepage.css 是「工作台页」的 one 皮肤覆盖层。
     页面要显式声明才生效：<link id="a377-onepage" … media="not all">。
     classic 下 media 保持 not all —— 规则完全不参与匹配，所以不存在泄漏；
     而 / 和 /draw/ 的 one 视图是自带样式的，它们不放这个 link，就不会被覆盖层压掉 hover 效果。
     必须在 <head> 末尾（页面自身 <style> 之后）调用，否则覆盖层顺序不对。 */
  function applyOverlay(v) {
    var el = document.getElementById(OVERLAY_ID);
    if (!el) return;
    var want = v === "one" ? "all" : "not all";
    if (el.getAttribute("media") !== want) el.setAttribute("media", want);
  }

  /* one 皮肤整页是黑的，移动端地址栏跟着走；classic 交回给 theme.js 的规则 */
  function applyMeta(v) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    if (v === "one") { meta.setAttribute("content", META_ONE); return; }
    meta.setAttribute("content", root.dataset.theme === "dark" ? "#16140f" : "#faf9f5");
  }

  /* one 皮肤自成一套配色，不跟随深浅色（onepage.css 里把
     html[data-skin="one"][data-theme="dark"] 和 light 写进了同一条规则）。
     而 /file/ /trips/ 这些页面是深色优先写的，浅色靠 html[data-theme="light"] 覆盖。
     所以 one 皮肤下必须把生效主题压成 light，否则 --text 被 onepage.css 强制成黑色后
     会和页面自己的深色底撞在一起，出现黑底黑字。 */
  function applyEffectiveTheme(v) {
    if (v === "one") {
      if (root.dataset.theme !== "light") root.dataset.theme = "light";
    } else if (window.A377Theme && window.A377Theme.repaint) {
      window.A377Theme.repaint();
    }
  }

  function paint(v) {
    /* 传了非法值（例如 shell.js 的 refresh() 不带参数）时，保持当前皮肤不动。
       旧版这里会把 undefined 当成 "one"，导致每次有顶栏的页面加载都把偏好重置掉。 */
    v = (v === "one" || v === "classic") ? v : current();
    root.dataset.skin = v;
    applyOverlay(v);
    applyEffectiveTheme(v);
    applyMeta(v);

    var btns = document.querySelectorAll("[data-skin-toggle]");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      var tip = v === "one" ? "当前：新版皮肤，点击切回经典" : "当前：经典皮肤，点击切到新版";
      b.setAttribute("aria-pressed", v === "one" ? "true" : "false");
      b.setAttribute("title", tip);
      b.setAttribute("aria-label", tip);
      var label = b.querySelector("[data-skin-label]");
      if (label) label.textContent = v === "one" ? "NEW" : "CLASSIC";
      b.classList.toggle("is-classic", v === "classic");
    }

    try {
      window.dispatchEvent(new CustomEvent("a377:skinchange", { detail: { skin: v } }));
    } catch (e) {}
  }

  /* 悬浮按钮样式 + one 皮肤下的两条全局修正。无论有没有顶栏都要注入。 */
  function ensureStyle() {
    if (document.getElementById("a377-skin-style")) return;
    var st = document.createElement("style");
    st.id = "a377-skin-style";
    st.textContent =
      ".a377-skin-toggle{position:fixed;left:14px;bottom:14px;z-index:2200;" +
      "display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 11px;" +
      "border:1px solid #000;background:#000;color:#fff;" +
      "font:700 11px/1 'Courier New','MS Gothic',Consolas,monospace;" +
      "text-transform:uppercase;letter-spacing:.08em;cursor:pointer;border-radius:0;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.18)}" +
      ".a377-skin-toggle:hover{background:#836953;border-color:#836953;color:#fff}" +
      ".a377-skin-toggle .dot{width:7px;height:7px;background:#fff;display:inline-block}" +
      ".a377-skin-toggle.is-classic{background:#fff;color:#000;border-color:#000}" +
      ".a377-skin-toggle.is-classic .dot{background:#000}" +
      ".a377-skin-toggle:focus-visible{outline:2px solid #836953;outline-offset:2px}" +
      "@media (prefers-reduced-motion:reduce){.a377-skin-toggle{transition:none!important}}" +
      /* one 皮肤只有一套浅色配色，没有深色变体 —— 深浅色开关在那里点了不会有任何变化，
         留着只会让人以为坏了。 */
      "html[data-skin=\"one\"] [data-theme-toggle]{display:none!important}";
    document.head.appendChild(st);
  }

  /* 悬浮按钮：只有页面自己没放 [data-skin-toggle]（也就是没顶栏）时才需要 */
  function ensureFloating() {
    if (document.querySelector("[data-skin-toggle]")) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "a377-skin-toggle";
    b.setAttribute("data-skin-toggle", "");
    b.innerHTML = '<span class="dot" aria-hidden="true"></span><span>SKIN</span><b data-skin-label></b>';
    document.body.appendChild(b);
  }

  /* 首屏：必须在解析 body 之前就把 data-skin 定下来，否则会闪皮肤 */
  ensureStyle();
  paint(stored() || DEFAULT_SKIN);

  /* ---------- 对外 API ---------- */
  window.A377Skin = {
    get: current,
    /* 重画当前皮肤。不带参数 —— 不要写成 refresh: paint，那会把 undefined 当成皮肤值 */
    refresh: function () { paint(current()); },
    set: function (v) {
      v = norm(v);
      try { localStorage.setItem(KEY, v); } catch (e) {}
      paint(v);
    },
    toggle: function () {
      var next = current() === "one" ? "classic" : "one";
      window.A377Skin.set(next);
      return next;
    }
  };

  /* ---------- 点击：事件委托，顶栏里后插入的按钮也能响应 ---------- */
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("[data-skin-toggle]") : null;
    if (!btn) return;
    e.preventDefault();
    window.A377Skin.toggle();
  });

  /* ---------- 多标签页同步 ---------- */
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY) return;
    paint(e.newValue === "one" || e.newValue === "classic" ? e.newValue : DEFAULT_SKIN);
  });

  /* ---------- 深浅色主题变了：one 皮肤下压回浅色，否则重算 theme-color ---------- */
  try {
    new MutationObserver(function () {
      if (current() === "one") {
        if (root.dataset.theme !== "light") { root.dataset.theme = "light"; return; }
      }
      applyMeta(current());
    }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  } catch (e) {}

  /* ---------- 启动 ---------- */
  function boot() {
    ensureStyle();
    ensureFloating();
    paint(current());
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
