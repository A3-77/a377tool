/* =========================================================================
   A377Tool · 主题（全站唯一实现）
   在 <head> 里同步引入，避免首屏闪白：
       <script src="/assets/theme.js"></script>
  之后就不要再在页面里写主题逻辑了。

   规则：
     · localStorage 的 a377theme 是唯一真相（"light" | "dark"）
     · 没手动切过 → 跟随系统 prefers-color-scheme，并且系统变了跟着变
     · 手动切过之后 → 不再跟随系统
   ========================================================================= */
(function () {
  var KEY = "a377theme";
  var root = document.documentElement;
  var THEME_COLOR = { light: "#faf9f5", dark: "#16140f" };

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "light" || v === "dark" ? v : null;
    } catch (e) { return null; }
  }
  function systemTheme() {
    try {
      return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    } catch (e) { return "light"; }
  }
  function current() {
    return root.dataset.theme === "dark" ? "dark" : "light";
  }

  /* ---------- 应用 ---------- */
  function paint(t) {
    root.dataset.theme = t;
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", THEME_COLOR[t] || THEME_COLOR.light);
    /* 通知所有开关按钮（页面有几个就同步几个） */
    var btns = document.querySelectorAll("[data-theme-toggle]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].setAttribute("aria-pressed", t === "dark" ? "true" : "false");
      btns[i].setAttribute("aria-label", t === "dark" ? "切换到浅色" : "切换到深色");
      btns[i].setAttribute("title", t === "dark" ? "切换到浅色" : "切换到深色");
    }
  }

  /* 第一件事：立刻定色，必须在 paint 之前完成，否则会闪 */
  paint(stored() || systemTheme());

  /* ---------- 对外 API ---------- */
  window.A377Theme = {
    get: current,
    set: function (t) {
      if (t !== "light" && t !== "dark") return;
      try { localStorage.setItem(KEY, t); } catch (e) {}
      paint(t);
    },
    toggle: function () {
      var next = current() === "dark" ? "light" : "dark";
      window.A377Theme.set(next);
      return next;
    },
    /* 清掉手动选择，回到跟随系统 */
    followSystem: function () {
      try { localStorage.removeItem(KEY); } catch (e) {}
      paint(systemTheme());
    }
  };

  /* ---------- 系统主题变化 ---------- */
  try {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", function (e) {
      if (stored()) return;          /* 用户手动选过就不跟随 */
      paint(e.matches ? "dark" : "light");
    });
  } catch (e) {}

  /* ---------- 多标签页同步 ---------- */
  window.addEventListener("storage", function (e) {
    if (e.key !== KEY) return;
    paint(e.newValue === "dark" ? "dark" : e.newValue === "light" ? "light" : systemTheme());
  });

  /* ---------- 点开关（事件委托，覆盖后插入的按钮）---------- */
  document.addEventListener("click", function (e) {
    var btn = e.target && e.target.closest ? e.target.closest("[data-theme-toggle]") : null;
    if (!btn) return;
    e.preventDefault();
    window.A377Theme.toggle();
  });

  /* 把当前状态同步给 DOM 里已存在的按钮（脚本在 head，按钮还没解析出来） */
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { paint(current()); });
  }
})();
