/* =========================================================================
   A377Tool · 全站顶栏（App Shell）
   在 <head> 里用 defer 引入：
       <link rel="stylesheet" href="/assets/tokens.css">
       <script src="/assets/theme.js"></script>
       <link rel="stylesheet" href="/assets/shell.css">
       <script src="/assets/shell.js" defer></script>

   页面通过 <body> 属性控制：
       data-nav="home|file|draw|trips"   高亮哪个导航项
       data-shell="生图 / Right Code"     面包屑
       data-shell-pad="none"              不要给 body 自动加顶部内边距
                                          （全屏型页面 / 自己控制偏移的页面用）

   另外提供：
       A377Toast(msg, kind, action)   kind: "ok" | "err" | 省略
       A377Confirm({title, copy, confirm, danger}) -> Promise<boolean>
   ========================================================================= */
(function () {
  "use strict";
  if (window.__a377shell) return;
  window.__a377shell = true;

  var NAV = [
    { k: "home",  href: "/",       label: "首页" },
    { k: "file",  href: "/file/",  label: "文件" },
    { k: "draw",  href: "/draw/",  label: "生图" },
    { k: "trips", href: "/trips/", label: "见面" }
  ];

  var MOON = '<path class="i-moon" d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>';
  var SUN  = '<g class="i-sun"><circle cx="12" cy="12" r="4"/>' +
             '<path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2' +
             'M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></g>';

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  /* ---------------- 顶栏 ---------------- */
  function buildBar() {
    var body = document.body;
    if (body.querySelector(":scope > .a377bar")) return body.querySelector(":scope > .a377bar");

    var active = body.dataset.nav || "";
    var crumb = body.dataset.shell || "";

    var bar = document.createElement("div");
    bar.className = "a377bar";
    bar.setAttribute("role", "banner");

    var html = '<a class="a377bar-brand" href="/" aria-label="A377Tool 首页">A377<i>Tool</i></a>';
    if (crumb) html += '<span class="a377bar-crumb">' + esc(crumb) + "</span>";
    html += '<span class="a377bar-grow"></span>';
    html += '<nav class="a377bar-nav" aria-label="主导航">';
    for (var i = 0; i < NAV.length; i++) {
      var n = NAV[i];
      html += '<a href="' + n.href + '"' +
        (n.k === active ? ' aria-current="page"' : "") + ">" + n.label + "</a>";
    }
    html += "</nav>";
    html += '<button class="a377bar-theme a377bar-skin" type="button" data-skin-toggle aria-pressed="true" title="切换皮肤">' +
              '<span class="a377bar-skin-dot" aria-hidden="true"></span>' +
              '<b data-skin-label>NEW</b>' +
            "</button>";
    html += '<button class="a377bar-theme" type="button" data-theme-toggle aria-pressed="false">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" ' +
              'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + MOON + SUN + "</svg>" +
            "</button>";

    bar.innerHTML = html;
    body.insertBefore(bar, body.firstChild);
    if (window.A377Skin && window.A377Skin.refresh) window.A377Skin.refresh();

    /* 实测高度写回 CSS 变量，字体放大/换行都不会错位 */
    var apply = function () {
      var h = Math.round(bar.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty("--shell-h", h + "px");
    };
    apply();
    window.addEventListener("resize", apply);
    return bar;
  }

  /* ---------------- 跳转链接 ---------------- */
  function buildSkip() {
    var main = document.querySelector("main, [role=main], #main, .wrap, .hub, .sidebar-inset");
    if (!main) return;
    if (!main.id) main.id = "a377-main";
    var a = document.createElement("a");
    a.className = "a377-skip";
    a.href = "#" + main.id;
    a.textContent = "跳到主内容";
    document.body.insertBefore(a, document.body.firstChild);
  }

  /* ---------------- Toast ---------------- */
  function toasts() {
    var box = document.querySelector(".a377-toasts");
    if (!box) {
      box = document.createElement("div");
      box.className = "a377-toasts";
      box.setAttribute("role", "status");
      box.setAttribute("aria-live", "polite");
      document.body.appendChild(box);
    }
    return box;
  }

  function toast(msg, kind, action, ms) {
    var box = toasts();
    var el = document.createElement("div");
    el.className = "a377-toast" + (kind ? " " + kind : "");
    var span = document.createElement("span");
    span.textContent = String(msg);
    el.appendChild(span);
    var timer = null;
    function close() {
      if (timer) clearTimeout(timer);
      el.classList.remove("on");
      setTimeout(function () { el.remove(); }, 240);
    }
    if (action && action.label) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "a377-toast-act"; b.textContent = action.label;
      b.addEventListener("click", function () {
        close();
        if (typeof action.onClick === "function") action.onClick();
      });
      el.appendChild(b);
    }
    box.appendChild(el);
    requestAnimationFrame(function () { el.classList.add("on"); });
    var life = ms || (kind === "err" ? 6000 : action ? 5000 : 3200);
    timer = setTimeout(close, life);
    return close;
  }
  window.A377Toast = toast;

  /* ---------------- Confirm ---------------- */
  function confirmBox(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var wrap = document.createElement("div");
      wrap.className = "a377-modal";
      wrap.innerHTML =
        '<div class="a377-modal-mask"></div>' +
        '<div class="a377-modal-box" role="dialog" aria-modal="true" aria-labelledby="a377cfmt">' +
          '<h3 id="a377cfmt"></h3><p></p>' +
          '<div class="a377-modal-act">' +
            '<button type="button" class="ui-btn" data-a="no"></button>' +
            '<button type="button" class="ui-btn primary" data-a="yes"></button>' +
          "</div>" +
        "</div>";
      wrap.querySelector("h3").textContent = opts.title || "确认操作";
      wrap.querySelector("p").textContent = opts.copy || "";
      wrap.querySelector('[data-a="no"]').textContent = opts.cancel || "取消";
      var yes = wrap.querySelector('[data-a="yes"]');
      yes.textContent = opts.confirm || "确认";
      if (opts.danger) {
        yes.style.background = "var(--ui-err)";
        yes.style.borderColor = "var(--ui-err)";
      }
      document.body.appendChild(wrap);
      requestAnimationFrame(function () { wrap.classList.add("on"); });

      var last = document.activeElement;
      function done(v) {
        wrap.classList.remove("on");
        setTimeout(function () { wrap.remove(); }, 200);
        document.removeEventListener("keydown", onKey, true);
        if (last && last.focus) try { last.focus(); } catch (e) {}
        resolve(v);
      }
      function onKey(e) {
        if (e.key === "Escape") { e.stopPropagation(); done(false); }
      }
      wrap.querySelector(".a377-modal-mask").addEventListener("click", function () { done(false); });
      wrap.querySelector('[data-a="no"]').addEventListener("click", function () { done(false); });
      yes.addEventListener("click", function () { done(true); });
      document.addEventListener("keydown", onKey, true);
      setTimeout(function () { yes.focus(); }, 30);
    });
  }
  window.A377Confirm = confirmBox;

  /* ---------------- 启动 ---------------- */
  function boot() {
    buildBar();
    if (document.body.dataset.shellPad !== "none") document.body.classList.add("shell-pad");
    buildSkip();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();

