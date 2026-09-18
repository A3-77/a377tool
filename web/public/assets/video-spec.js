/* =========================================================================
   视频档位规范 —— 独立层，不依赖任何展示组件
   ---------------------------------------------------------------------------
   这一层只做三件事，全是纯函数：

     analyze(meta, profile)  →  问题清单 + 处理方案 + 人话步骤
     describe(profile)       →  给人看的规格说明（后台那段「视频规格要求」由它生成）
     displaySize(meta)       →  处理旋转后的真实显示尺寸

   为什么要把「判定」单独抽出来：
     处理视频有三条路 —— 本地 ffmpeg CLI、浏览器里就地转码、以后可能还有别的。
     如果每一条路各写一遍「什么算不合规、该缩到多大」，三份判断迟早会不一致，
     用户会遇到「命令行说合规、后台说超了」这种事。
     所以判定只在这里做一次，三条路都消费同一份结果。

   档位按「用途」命名，不按组件命名：
     组件会被换掉，用途不会。usedBy 只是个给人看的提示，
     代码里没有任何地方依赖它 —— 换了组件只要声明用哪个档位，这张表不用动。

   浏览器和 Node 共用同一个文件（UMD）：后台直接 <script> 引，
   CLI 和测试用 require 引，避免抄一份。
   ========================================================================= */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.VideoSpec = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var MB = 1024 * 1024;

  /* ---------------- 服务端硬上限 ----------------
     这是「存储层」的约束，和档位是两回事，别混：

       硬上限 = KV 单值 25 MiB 留出的余量，超了接口直接 413，**不可协商**
       档位   = 组件对素材的要求（体积 / 尺寸 / 时长），是「好不好用」的问题

     档位再宽松也不能越过硬上限，所以 analyze 两个都查。
     这个值必须和 web/functions/api/_media.js 的 MAX_VIDEO 一致 ——
     tests/test_video_prep.mjs 会解析那个文件来断言，防止两处悄悄漂移。 */
  var HARD = {
    bytes: 20 * MB,
    why: "KV 单值上限 25 MiB，留 5 MiB 余量",
  };

  /* 服务端 Content-Type 白名单对应的扩展名。
     注意这里**没有** mov / ogv —— 前端识别视频时会认它们（为了把老素材显示对），
     但服务端不收，所以它们是硬违规，不是警告。 */
  var VIDEO_EXT = ["mp4", "webm"];

  /* 时长容差（秒）。
     编码器不可能精确停在某一帧上：ffmpeg 能出 8.000，浏览器 MediaRecorder
     实测会到 8.3 左右（收尾时缓冲里还有帧）。为了 0.3 秒把「合规」判成
     「不合规」是没意义的 —— 档位上限本来就是「感觉」层面的约束，不是硬线。 */
  var DURATION_GRACE = 0.5;

  /* 帧率容差。只有明显高出才值得动 ——
     为了把 25fps 降到 24 而重编一整遍，省下 4% 的帧却掉一次画质，这笔账是亏的。
     所以「报告」和「动手」用同一个阈值，避免出现「说了有问题但又不去修」的怪状态。 */
  var FPS_SLACK = 1.15;

  /* ---------------- 档位表 ---------------- */
  var PROFILES = {
    "loop-card": {
      label: "卡片循环",
      usedBy: "弧形画廊",
      why: "一圈会复制成二十多张卡同时循环播，单张体积必须压得很死，否则首屏就被带宽拖死",
      maxEdge: 720,        /* 长边上限。默认参数下卡片实测约 380×270，720 已经够 2x 屏 */
      aspect: 1.5,         /* 固定比例 → 会居中裁剪；null = 保持原比例只缩放 */
      minSeconds: 3,
      maxSeconds: 8,
      maxBytes: 1.5 * MB,
      fps: 24,
      audio: false,
      container: "mp4",
      vcodec: "h264",
    },
    "inline": {
      label: "内嵌播放",
      usedBy: null,        /* 暂时没有组件用它，留着证明「换组件不用改这里」 */
      why: "用户主动点开才播，能接受更大的体积和更长的时长，也可以留声音",
      maxEdge: 1280,
      aspect: null,
      minSeconds: 1,
      maxSeconds: 120,
      maxBytes: 8 * MB,
      fps: 30,
      audio: true,
      container: "mp4",
      vcodec: "h264",
    },
  };

  /* ---------------- 小工具 ---------------- */

  function fmtSize(n) {
    if (n == null || isNaN(n)) return "?";
    if (n < 1024) return n + " B";
    if (n < MB) return Math.round(n / 1024) + " KB";
    return (n / MB).toFixed(n < 10 * MB ? 1 : 0) + " MB";
  }

  function fmtSeconds(s) {
    if (s == null || isNaN(s)) return "?";
    if (s < 60) return (Math.round(s * 10) / 10) + " 秒";
    return Math.floor(s / 60) + " 分 " + Math.round(s % 60) + " 秒";
  }

  /* 偶数化：h264 的 yuv420p 要求宽高都是偶数，奇数会直接编码失败。
     顺手给个下限 2，0 尺寸没意义。 */
  function even(n) {
    return Math.max(2, Math.round(n / 2) * 2);
  }

  /* 命令行用："1.5MB" / "800KB" / "2M" / 纯数字（当字节） */
  function parseSize(v) {
    if (v == null) return null;
    if (typeof v === "number") return v;
    var m = /^\s*([\d.]+)\s*([kmg]?)(i?b?)?\s*$/i.exec(String(v));
    if (!m) return null;
    var n = parseFloat(m[1]);
    if (isNaN(n)) return null;
    var u = (m[2] || "").toLowerCase();
    if (u === "k") return Math.round(n * 1024);
    if (u === "m") return Math.round(n * MB);
    if (u === "g") return Math.round(n * 1024 * MB);
    return Math.round(n);
  }

  /* 命令行用："3-8" → {min:3,max:8}；"8" → {min:0,max:8} */
  function parseRange(v) {
    if (v == null) return null;
    var s = String(v).trim();
    var m = /^([\d.]+)\s*-\s*([\d.]+)$/.exec(s);
    if (m) return { min: parseFloat(m[1]), max: parseFloat(m[2]) };
    var one = parseFloat(s);
    if (isNaN(one)) return null;
    return { min: 0, max: one };
  }

  /* 从文件名 / 容器 / 编码猜扩展名 */
  function extOf(meta) {
    var m = /\.([a-z0-9]+)(\?|#|$)/i.exec(String(meta.name || ""));
    if (m) {
      var e = m[1].toLowerCase();
      if (e === "m4v") e = "mp4";
      return e;
    }
    var c = String(meta.container || "").toLowerCase();
    if (c === "mov" || c === "mp4" || c === "m4a" || c === "3gp") return "mp4";
    if (c === "matroska" || c === "webm") return "webm";
    return "";
  }

  /* 手机竖拍视频靠旋转标记（rotation=90）表达方向，编码尺寸其实是横的。
     不换算的话会把 1080×1920 的竖屏视频当成横屏，比例判断和裁剪全错。
     ffmpeg 转码时会自动应用旋转，所以滤镜看到的是显示尺寸 —— 两边要一致。 */
  function displaySize(meta) {
    var w = Number(meta.width) || 0;
    var h = Number(meta.height) || 0;
    var r = Number(meta.rotation) || 0;
    r = ((r % 360) + 360) % 360;
    if (r === 90 || r === 270) return { width: h, height: w, rotated: true };
    return { width: w, height: h, rotated: false };
  }

  /* ---------------- 判定 + 方案 ----------------
     override 是命令行/界面的临时覆盖，语义：
       maxEdge / aspect / fps / targetBytes / trim:[a,b] / keepAudio
     返回的东西全部是「数据」，不含任何执行细节 —— 执行由引擎自己决定怎么落。

     ok 的含义：没有 hard 也没有 warn。info 只是「可以更好」，不影响 ok。 */
  function analyze(meta, profileId, override) {
    var p = PROFILES[profileId];
    if (!p) throw new Error("没有这个档位：" + profileId);
    var o = override || {};

    var lim = {
      maxEdge: o.maxEdge != null ? o.maxEdge : p.maxEdge,
      aspect: o.aspect !== undefined ? o.aspect : p.aspect,
      minSeconds: o.minSeconds != null ? o.minSeconds : p.minSeconds,
      maxSeconds: o.maxSeconds != null ? o.maxSeconds : p.maxSeconds,
      maxBytes: o.targetBytes != null ? o.targetBytes : p.maxBytes,
      fps: o.fps != null ? o.fps : p.fps,
      audio: o.keepAudio ? true : p.audio,
      container: p.container,
      vcodec: p.vcodec,
    };

    var disp = displaySize(meta);
    var seconds = Number(meta.seconds) || 0;
    var bytes = Number(meta.bytes) || 0;
    var issues = [];

    /* --- 硬违规：服务端会直接拒 --- */
    if (bytes > HARD.bytes) {
      issues.push({
        level: "hard", field: "bytes",
        msg: "体积 " + fmtSize(bytes) + " 超过服务端上限 " + fmtSize(HARD.bytes) +
             "（" + HARD.why + "），传上去会被 413 拒绝",
      });
    }
    var ext = extOf(meta);
    if (!ext || VIDEO_EXT.indexOf(ext) < 0) {
      issues.push({
        level: "hard", field: "container",
        msg: "格式 " + (ext ? "." + ext : (meta.container || "未知")) +
             " 服务端不收，只收 mp4 / webm",
      });
    }

    /* --- 档位不符 --- */
    var longEdge = Math.max(disp.width, disp.height);
    if (longEdge > lim.maxEdge) {
      issues.push({
        level: "warn", field: "size",
        msg: "分辨率 " + disp.width + "×" + disp.height + " 超过档位长边上限 " + lim.maxEdge +
             "（白占体积，卡片上根本看不出差别）",
      });
    }
    if (bytes > lim.maxBytes) {
      issues.push({
        level: "warn", field: "bytes",
        msg: "体积 " + fmtSize(bytes) + " 超过档位上限 " + fmtSize(lim.maxBytes),
      });
    }
    if (seconds > lim.maxSeconds + DURATION_GRACE) {
      issues.push({
        level: "warn", field: "seconds",
        msg: "时长 " + fmtSeconds(seconds) + " 超过档位上限 " + fmtSeconds(lim.maxSeconds),
      });
    }
    if (seconds > 0 && seconds < lim.minSeconds - DURATION_GRACE) {
      /* 这个没法自动修 —— 循环播放短素材不会让「跳」变好，
         拉伸或重复只会更怪。只报告，让人自己换素材。 */
      issues.push({
        level: "warn", field: "seconds",
        msg: "时长 " + fmtSeconds(seconds) + " 短于档位下限 " + fmtSeconds(lim.minSeconds) +
             "，循环播会明显跳。这个只能换素材，压不出来",
      });
    }
    if (lim.aspect && disp.width && disp.height) {
      var ratio = disp.width / disp.height;
      if (Math.abs(ratio - lim.aspect) > 0.02) {
        issues.push({
          level: "warn", field: "aspect",
          msg: "比例 " + ratio.toFixed(2) + ":1 和档位要求的 " + lim.aspect +
               ":1 不一致，会被居中裁掉两边（裁的是画面，不是压缩变形）",
        });
      }
    }

    /* --- 只是可以更好 ---
       音轨放在 info 里是**故意**的：档位一律静音播放，留着音轨不影响功能。
       而「去掉音轨」只有在因为别的原因本来就要重编时才顺手做掉 ——
       为了省一条音轨专门重编一整遍，掉一次画质，这笔账是亏的。 */
    if (meta.acodec && !lim.audio) {
      issues.push({
        level: "info", field: "audio",
        msg: "带 " + meta.acodec + " 音轨，但这个档位一律静音播放 —— 音轨纯占体积",
      });
    }
    /* 帧率和编码放在 warn 里，因为这两项**会**触发重编。
       等级必须和「会不会动手」对齐：报了问题却不去修，用户就不敢信这个工具了。
       注意 FPS_SLACK —— 只略高不算，为了 25→24 重编一遍是亏的。 */
    if (meta.fps && meta.fps > lim.fps * FPS_SLACK) {
      issues.push({
        level: "warn", field: "fps",
        msg: "帧率 " + (Math.round(meta.fps * 10) / 10) + " 明显高于档位需要的 " + lim.fps,
      });
    }
    if (meta.vcodec && meta.vcodec !== lim.vcodec) {
      issues.push({
        level: "warn", field: "vcodec",
        msg: "编码是 " + meta.vcodec + "，转成 " + lim.vcodec + " 兼容性最好",
      });
    }

    /* ---------------- 处理方案 ---------------- */

    /* 目标尺寸。
       有 aspect 时是「固定盒子 + 居中裁剪」：先把画面放大到铺满盒子，再裁掉多余部分。
       没有 aspect 时只等比缩小，**不放大** —— 小素材放大纯属浪费体积。
       有 aspect 时同样不放大：盒子的长边取 min(档位上限, 素材长边)。 */
    var scale = null, crop = false;
    if (lim.aspect && disp.width && disp.height) {
      var boxLong = Math.min(lim.maxEdge, longEdge);
      var bw, bh;
      if (lim.aspect >= 1) { bw = boxLong; bh = even(boxLong / lim.aspect); }
      else { bh = boxLong; bw = even(boxLong * lim.aspect); }
      if (bw !== disp.width || bh !== disp.height) {
        scale = { w: bw, h: bh };
        crop = true;      /* 盒子比例和素材不一致，必定要裁 */
      }
    } else if (longEdge > lim.maxEdge) {
      var k = lim.maxEdge / longEdge;
      if (disp.width >= disp.height) scale = { w: even(disp.width * k), h: null };
      else scale = { w: null, h: even(disp.height * k) };
    }

    /* 截取区间。默认取开头 —— 画廊是循环播的，从中间截容易首尾接不上。
       只超出容差范围才截：8.2 秒的素材硬截到 8.0 省不下什么，还多一次重编。 */
    var trim = null;
    if (o.trim) {
      trim = { start: Math.max(0, o.trim[0]), end: Math.max(0, o.trim[1]) };
    } else if (seconds > lim.maxSeconds + DURATION_GRACE) {
      trim = { start: 0, end: lim.maxSeconds };
    }

    var outSeconds = trim ? (trim.end - trim.start) : seconds;

    /* 按目标体积反推码率 —— 这是**兜底**用的，不是首选。
       引擎应该先按 CRF 编一遍（画质优先），只有结果超了才用这个码率两遍重编。
       两个折扣都是有理由的，别随手改大：
         · 留 8 KB 给容器开销（moov / mdat 头，和视频码率无关）
         · 再打 0.90 —— x264 的平均码率是「尽量」，实测会小幅超出，
           贴着上限算出来的码率编完总是差一点点超（实测 300KB 目标出来 304KB） */
    var targetBytes = lim.maxBytes;
    var fallbackKbps = null;
    if (outSeconds > 0) {
      var audioKbps = lim.audio && meta.acodec ? 96 : 0;
      var budget = Math.max(1024, targetBytes - 8192);
      var kbps = Math.floor((budget * 8 * 0.90) / outSeconds / 1000) - audioKbps;
      if (kbps > 0) fallbackKbps = kbps;
    }

    var dropAudio = !!meta.acodec && !lim.audio;
    /* 只有明显高出才降帧率 —— 见 FPS_SLACK 的说明 */
    var lowerFps = meta.fps && meta.fps > lim.fps * FPS_SLACK ? lim.fps : null;

    /* 是不是必须重编码。
       「什么都没变」时不要重编 —— 重编一次白掉一次画质，
       对已经是 h264/mp4 的素材就是纯损失。 */
    var needsReencode = !!(
      scale || crop || trim || dropAudio || lowerFps ||
      (meta.vcodec && meta.vcodec !== lim.vcodec) ||
      ext !== lim.container
    );
    /* 原样保留时输出什么格式就跟着输入；否则统一出档位指定的容器 */
    var outExt = (!needsReencode && VIDEO_EXT.indexOf(ext) >= 0) ? ext : lim.container;

    var ops = {
      needsReencode: needsReencode,
      scale: scale,
      crop: crop,
      trim: trim,
      dropAudio: dropAudio,
      keepAudio: !!meta.acodec && lim.audio,
      fps: lowerFps,
      targetBytes: targetBytes,
      fallbackKbps: fallbackKbps,
      aspect: lim.aspect,
      container: lim.container,
      outExt: outExt,
    };

    /* ---------------- 人话步骤 ---------------- */
    var steps = [];
    if (scale && crop) {
      steps.push("缩放到 " + scale.w + "×" + scale.h +
                 "，按 " + lim.aspect + ":1 居中裁掉多余部分");
    } else if (scale) {
      steps.push("缩放到 " + (scale.w ? scale.w + "×（高按比例）" : "（宽按比例）×" + scale.h));
    }
    if (trim) steps.push("截取 " + trim.start + "–" + trim.end + " 秒");
    if (ops.dropAudio) steps.push("去掉音轨");
    if (ops.fps) steps.push("帧率降到 " + ops.fps);
    steps.push("h264 编码（CRF 23），若结果超过 " + fmtSize(targetBytes) +
               " 再按 " + fallbackKbps + " kbps 两遍重编");
    steps.push("moov 前置（faststart），边下边播");

    var hasHard = issues.some(function (i) { return i.level === "hard"; });
    var hasWarn = issues.some(function (i) { return i.level === "warn"; });

    return {
      profile: profileId,
      profileLabel: p.label,
      meta: meta,
      display: disp,
      limits: lim,
      issues: issues,
      hard: hasHard,
      warn: hasWarn,
      ok: !hasHard && !hasWarn,
      ops: ops,
      steps: steps,
      outSeconds: outSeconds,
      /* 该不该动手，和 ok 必须是一回事 ——
         judge 说合规、fix 却重编一遍，这种自相矛盾会让人不敢信工具。
         （音轨这类 info 不参与，见上面的说明） */
      worthFixing: hasHard || hasWarn,
    };
  }

  /* ---------------- 给人看的规格说明 ----------------
     后台那段「视频规格要求」由这里生成，不再手写 ——
     改了档位表，说明自动跟着变，不会出现「文档说 720，代码里是 1080」。 */
  function describe(profileId) {
    var p = PROFILES[profileId];
    if (!p) return [];
    var lines = [
      ["格式", p.container + "（" + p.vcodec + "），faststart"],
      ["分辨率", "长边 ≤ " + p.maxEdge +
        (p.aspect ? "，比例 " + p.aspect + ":1（不一致会被居中裁掉）" : "，保持原比例")],
      ["时长", fmtSeconds(p.minSeconds) + " – " + fmtSeconds(p.maxSeconds)],
      ["体积", "单个 ≤ " + fmtSize(p.maxBytes)],
      ["帧率", "≤ " + p.fps],
      ["音轨", p.audio ? "可以保留" : "去掉（这个档位一律静音播放）"],
    ];
    return lines;
  }

  /* 缺元数据时的兜底：浏览器预检读不到 <video> 元数据的情况
     （编码不支持、文件损坏），这时只能按体积判一部分 */
  function emptyMeta(name, bytes) {
    return {
      name: name || "", bytes: Number(bytes) || 0, seconds: 0,
      width: 0, height: 0, rotation: 0,
      vcodec: null, acodec: null, fps: 0, container: "",
    };
  }

  return {
    MB: MB,
    HARD: HARD,
    VIDEO_EXT: VIDEO_EXT,
    DURATION_GRACE: DURATION_GRACE,
    FPS_SLACK: FPS_SLACK,
    PROFILES: PROFILES,
    fmtSize: fmtSize,
    fmtSeconds: fmtSeconds,
    even: even,
    parseSize: parseSize,
    parseRange: parseRange,
    extOf: extOf,
    displaySize: displaySize,
    analyze: analyze,
    describe: describe,
    emptyMeta: emptyMeta,
  };
});
