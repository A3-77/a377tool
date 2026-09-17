/* =========================================================================
   A377Tool · 双皮肤切换
   皮肤：one（One Page Love 黑白网格）| classic（旧版工具站）
   在 <head> 里同步引入，尽早写入 html[data-skin]，避免首屏闪皮肤。
   ========================================================================= */
(function () {
  var KEY = "a377skin";
  var root = document.documentElement;

  function stored() {
    try {
      var v = localStorage.getItem(KEY);
      return v === "one" || v === "classic" ? v : null;
    } catch (e) { return null; }
  }
  function current() {
    return root.dataset.skin === "classic" ? "classic" : "one";
  }
  function paint(v) {
    v = v === "classic" ? "classic" : "one";
    root.dataset.skin = v;
    var btns = document.querySelectorAll("[data-skin-toggle]");
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.setAttribute("aria-pressed", v === "one" ? "true" : "false");
      b.setAttribute("title", v === "one" ? "当前：新皮肤，点击切旧版" : "当前：旧版皮肤，点击切新版");
      var label = b.querySelector("[data-skin-label]");
      if (label) label.textContent = v === "one" ? "NEW" : "CLASSIC";
      b.classList.toggle("is-classic", v === "classic");
    }
  }

  function ensureStyle() {
    if (document.getElementById("a377-skin-style")) return;
    var st = document.createElement("style");
    st.id = "a377-skin-style";
    st.textContent =
      ".a377-skin-toggle{position:fixed;left:14px;bottom:14px;z-index:2200;" +
      "display:inline-flex;align-items:center;gap:7px;height:34px;padding:0 11px;" +
      "border:1px solid #000;background:#000;color:#fff;font:700 11px/1 'Courier New','MS Gothic',Consolas,monospace;" +
      "text-transform:uppercase;letter-spacing:.08em;cursor:pointer;border-radius:0;" +
      "box-shadow:0 4px 14px rgba(0,0,0,.18)}" +
      ".a377-skin-toggle:hover{background:#836953;border-color:#836953;color:#fff}" +
      ".a377-skin-toggle .dot{width:7px;height:7px;background:#fff;display:inline-block}" +
      ".a377-skin-toggle.is-classic{background:#fff;color:#000;border-color:#000}" +
      ".a377-skin-toggle.is-classic .dot{background:#000}" +
      ".a377-skin-toggle:focus-visible{outline:2px solid #836953;outline-offset:2px}" +
      "@media (prefers-reduced-motion:reduce){.a377-skin-toggle{transition:none!important}}";
    document.head.appendChild(st);
  }

  function boot() {
    ensureStyle();
    if (document.body.dataset.shell) { paint(current()); return; }
    if (document.querySelector("[data-skin-toggle]")) return;
    var b = document.createElement("button");
    b.type = "button";
    b.className = "a377-skin-toggle";
    b.setAttribute("data-skin-toggle", "");
    b.innerHTML = '<span class="dot"></span><span>SKIN</span><b data-skin-label></b>';
    b.addEventListener("click", function () {
      window.A377Skin.toggle();
    });
    document.body.appendChild(b);
    paint(current());
  }

  paint(stored() || "one");

  window.A377Skin = {
    get: current,
    refresh: paint,
    set: function (v) {
      v = v === "classic" ? "classic" : "one";
      try { localStorage.setItem(KEY, v); } catch (e) {}
      paint(v);
    },
    toggle: function () {
      var next = current() === "one" ? "classic" : "one";
      window.A377Skin.set(next);
      return next;
    }
  };

  window.addEventListener("storage", function (e) {
    if (e.key !== KEY) return;
    paint(e.newValue === "classic" ? "classic" : "one");
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
