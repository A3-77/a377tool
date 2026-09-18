/* =========================================================================
   网页端视频处理引擎 —— 独立层，任何视频组件都能用
   ---------------------------------------------------------------------------
   用浏览器**自带**的编码器干活：<video> 解码 → canvas 缩放裁剪 → MediaRecorder 录制。
   没有用 ffmpeg.wasm，原因是硬的：

     Cloudflare Pages 单个文件上限 25 MiB，而 @ffmpeg/core 的 wasm 就 30+ MB，
     根本传不进部署产物；改从 jsdelivr / unpkg 拉，国内又不稳。

   浏览器自带编码器的代价是「实时」—— 转 8 秒要 8 秒。
   但我们的档位本来就只要 3–8 秒的片段，这个代价正好可以接受；
   而且解码是硬解的，拖 200MB 的 4K 手机视频进来也不吃力。

   限制（说清楚，别让人踩空）：
     · 浏览器解不开的编码（HEVC / ProRes 之类）这里做不了，要走本地 ffmpeg
     · 码率是「目标值」不是「精确值」，MediaRecorder 会上下浮动，
       所以压完要复核体积，超了就降码率重来一次
     · 输出是分片 mp4 / webm，没有 faststart 那套 moov 前置的概念
     · 浏览器看不到音轨信息，所以 probe 出来的 acodec 是 null；
       但档位要求静音的档位一律不录音轨，结果是对的

   判定逻辑不在这里 —— 全在 video-spec.js，和命令行工具共用同一份。
   ========================================================================= */
(function () {
  "use strict";

  var V = window.VideoSpec;
  if (!V) return;

  /* 优先 mp4/h264（兼容性最好，也是档位要求的容器），退到 webm。
     Chrome 130+ 和 Safari 都能出 mp4；Firefox 目前只有 webm。 */
  var MP4 = [
    "video/mp4;codecs=avc1.42E01E",
    "video/mp4;codecs=avc1.4D401E",
    "video/mp4;codecs=avc1",
    "video/mp4",
  ];
  var WEBM = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];

  var supported = null;
  function pickMime() {
    if (supported) return supported;
    if (typeof MediaRecorder === "undefined") return (supported = "");
    var all = MP4.concat(WEBM);
    for (var i = 0; i < all.length; i++) {
      try {
        if (MediaRecorder.isTypeSupported(all[i])) return (supported = all[i]);
      } catch (e) { /* 有些实现会抛，忽略继续试 */ }
    }
    return (supported = "");
  }

  function extOfMime(m) {
    return /mp4/.test(m) ? "mp4" : "webm";
  }

  /* 能不能就地处理。缺 MediaRecorder 或 canvas.captureStream 就只能走命令行 */
  function available() {
    return typeof MediaRecorder !== "undefined" &&
      typeof HTMLCanvasElement !== "undefined" &&
      !!HTMLCanvasElement.prototype.captureStream &&
      !!pickMime();
  }

  function baseName(name) {
    return String(name || "video")
      .replace(/\.[^.]+$/, "")
      .replace(/[^\w\u4e00-\u9fa5.-]+/g, "-")
      .slice(0, 60) || "video";
  }

  function fmtSize(n) { return V.fmtSize(n); }
  function fmtSeconds(s) { return V.fmtSeconds(s); }

  /* ---------------- 探测 ----------------
     用 <video> 让浏览器自己读元数据，**不下载、不上传** ——
     objectURL 指向本地文件，读 header 就够了。

     注意 videoWidth/videoHeight 已经是**旋转后**的显示尺寸（浏览器替我们做了
     旋转换算），和命令行那条路要手动处理 rotation 不一样，这里不用管。 */
  function probeFile(file, timeoutMs) {
    return new Promise(function (resolve) {
      var meta = V.emptyMeta(file.name, file.size);
      var url = URL.createObjectURL(file);
      var v = document.createElement("video");
      var settled = false;

      var timer = setTimeout(function () { finish(false); }, timeoutMs || 12000);

      function finish(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (ok) {
          meta.seconds = isFinite(v.duration) && v.duration > 0 ? v.duration : 0;
          meta.width = v.videoWidth || 0;
          meta.height = v.videoHeight || 0;
          /* Firefox 能直接问有没有音轨；Chrome 没有对应 API，留 null。
             不影响结果 —— 要求静音的档位一律不录音轨。 */
          if (typeof v.mozHasAudio === "boolean") meta.acodec = v.mozHasAudio ? "audio" : null;
          var m = /\.([a-z0-9]+)$/i.exec(file.name);
          meta.container = m ? m[1].toLowerCase() : (/webm/.test(file.type) ? "webm" : "mp4");
          /* 浏览器解不开的格式（HEVC / ProRes 等）拿不到尺寸，这是判断依据 */
          meta.decodable = !!(meta.width && meta.height);
        } else {
          meta.decodable = false;
        }
        v.removeAttribute("src");
        try { v.load(); } catch (e) { /* 忽略 */ }
        URL.revokeObjectURL(url);
        resolve(meta);
      }

      v.preload = "metadata";
      v.muted = true;
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      v.addEventListener("loadedmetadata", function () { finish(true); });
      v.addEventListener("error", function () { finish(false); });
      v.src = url;
    });
  }

  /* 一步到位的判定：探测 + 分析。UI 直接消费它的结果 */
  async function plan(file, profileId, override) {
    var meta = await probeFile(file);
    var analysis = null;
    try {
      analysis = V.analyze(meta, profileId || "loop-card", override || {});
    } catch (e) { /* 档位不存在，留给调用方判 */ }
    return { meta: meta, analysis: analysis };
  }

  /* 预计产出多大：按反推的码率 × 时长估，用来在动手之前告诉用户 */
  function estimateBytes(analysis) {
    var ops = analysis.ops;
    if (!ops || !ops.fallbackKbps) return 0;
    return Math.round((ops.fallbackKbps * 1000 * analysis.outSeconds) / 8 * 1.06);
  }

  /* ---------------- 转码 ----------------
     hooks: { onProgress(ratio, phase), signal }
     返回 { blob, file, meta, mime, ext, seconds, bytes }
  */
  function transcode(file, analysis, hooks) {
    hooks = hooks || {};
    var ops = analysis.ops;

    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var v = document.createElement("video");
      var canvas = null, ctx = null, rec = null, stream = null;
      var audioCtx = null, chunks = [], cleaned = false;
      var startAt = ops.trim ? ops.trim.start : 0;
      /* 终点。时长**可能读不出来** —— MediaRecorder 录出来的 webm 没有时长
         元数据，<video>.duration 是 Infinity，probeFile 会把它记成 0。
         拿 0 当终点的话第一帧就停了，录出个空文件（实测踩过）。
         所以读不到时长就退成「录到档位上限为止」：
         素材真比上限短的话，ended 事件会先把它停掉。 */
      var endAt = ops.trim ? ops.trim.end
        : (analysis.meta.seconds > 0 ? analysis.meta.seconds : analysis.limits.maxSeconds);
      var lastT = startAt;      /* 记实际播到哪儿了，用来报真实时长 */
      var t0 = 0;

      function cleanup() {
        if (cleaned) return;
        cleaned = true;
        try { if (rec && rec.state !== "inactive") rec.stop(); } catch (e) { /* 忽略 */ }
        try { if (stream) stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* 忽略 */ }
        try { if (audioCtx) audioCtx.close(); } catch (e) { /* 忽略 */ }
        try { v.pause(); } catch (e) { /* 忽略 */ }
        v.removeAttribute("src");
        try { v.load(); } catch (e) { /* 忽略 */ }
        URL.revokeObjectURL(url);
      }

      function fail(err) { cleanup(); reject(err); }

      if (hooks.signal) {
        if (hooks.signal.aborted) return fail(new Error("已取消"));
        hooks.signal.addEventListener("abort", function () { fail(new Error("已取消")); });
      }

      v.addEventListener("error", function () {
        fail(new Error("浏览器解不开这个视频（可能是 HEVC / ProRes 之类的编码）"));
      });

      v.addEventListener("loadedmetadata", function () {
        /* 输出尺寸：方案里给了就按方案，没给就照原尺寸 */
        var ow = (ops.scale && ops.scale.w) || v.videoWidth;
        var oh = (ops.scale && ops.scale.h) || v.videoHeight;
        if (ops.scale && !ops.scale.w) {          /* 只定了高，宽按比例 */
          ow = V.even(ops.scale.h * v.videoWidth / v.videoHeight);
          oh = ops.scale.h;
        }
        if (ops.scale && !ops.scale.h) {          /* 只定了宽，高按比例 */
          oh = V.even(ops.scale.w * v.videoHeight / v.videoWidth);
          ow = ops.scale.w;
        }
        ow = V.even(ow); oh = V.even(oh);

        canvas = document.createElement("canvas");
        canvas.width = ow;
        canvas.height = oh;
        ctx = canvas.getContext("2d");
        /* low 是抽样不是平均，缩小的时候会明显出锯齿 */
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        /* 源图上要取的矩形。比例不一致时居中裁 —— 和命令行的
           scale+crop 是同一个意思，只是这里在 drawImage 里直接算完。 */
        var vw = v.videoWidth, vh = v.videoHeight;
        var srcAspect = vw / vh, dstAspect = ow / oh;
        var sx = 0, sy = 0, sw = vw, sh = vh;
        if (ops.crop || Math.abs(srcAspect - dstAspect) > 0.005) {
          if (srcAspect > dstAspect) { sw = vh * dstAspect; sx = (vw - sw) / 2; }
          else { sh = vw / dstAspect; sy = (vh - sh) / 2; }
        }

        var fps = ops.fps || 30;
        try {
          stream = canvas.captureStream(fps);
        } catch (e) {
          return fail(new Error("这个浏览器不支持 canvas 抓流（captureStream）"));
        }

        /* 要音轨才接音频。走 WebAudio 抓，**不连到扬声器** ——
           处理过程在后台悄悄跑就行，没必要放出声。
           注意 muted 的元素抓出来是静音，所以这里得先取消静音。 */
        if (ops.keepAudio) {
          try {
            v.muted = false;
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            var src = audioCtx.createMediaElementSource(v);
            var dst = audioCtx.createMediaStreamDestination();
            src.connect(dst);
            dst.stream.getAudioTracks().forEach(function (t) { stream.addTrack(t); });
          } catch (e) {
            /* 抓不到音频就退成无声，别把整件事搞失败 */
            v.muted = true;
            try { if (audioCtx) audioCtx.close(); } catch (e2) { /* 忽略 */ }
            audioCtx = null;
            if (hooks.onNote) hooks.onNote("这个浏览器没能抓到音轨，这次出无声版本");
          }
        } else {
          v.muted = true;
        }

        var mime = pickMime();
        if (!mime) return fail(new Error("这个浏览器没有可用的视频编码器"));

        /* 码率留 15% 余量：MediaRecorder 是目标码率不是精确码率，
           贴着上限给容易刚好超出去。 */
        var opts = { mimeType: mime };
        if (ops.fallbackKbps) {
          opts.videoBitsPerSecond = Math.round(ops.fallbackKbps * 1000 * 0.85);
        }
        if (ops.keepAudio) opts.audioBitsPerSecond = 96000;

        try {
          rec = new MediaRecorder(stream, opts);
        } catch (e) {
          /* 少数浏览器不吃 videoBitsPerSecond，去掉重试 */
          try { rec = new MediaRecorder(stream, { mimeType: mime }); }
          catch (e2) { return fail(new Error("MediaRecorder 起不来：" + e2.message)); }
        }

        rec.addEventListener("dataavailable", function (e) {
          if (e.data && e.data.size) chunks.push(e.data);
        });
        rec.addEventListener("error", function () {
          fail(new Error("录制过程出错"));
        });
        rec.addEventListener("stop", function () {
          var blob = new Blob(chunks, { type: mime });
          /* 空产出要当失败报出来，不能让它混进上传流程 ——
             服务端会以「空文件」为由 400，用户看到的却是一句莫名其妙的错。
             实测在时长读不出来、第一帧就停的那种情况下会走到这里。 */
          if (blob.size < 1024) {
            return fail(new Error("转码没出东西（只录到 " + blob.size +
              " 字节）。这个素材的时长读不出来，试试用本地 ffmpeg 那条路"));
          }
          var ext = extOfMime(mime);
          var out = new File([blob], baseName(file.name) + "." + ext, { type: mime.split(";")[0] });
          var result = {
            blob: blob, file: out, mime: mime, ext: ext,
            bytes: blob.size,
            /* 报实际播到哪儿了，不是「本来打算录多长」——
               素材比上限短的时候，ended 会先把它停掉 */
            seconds: Math.max(0, lastT - startAt),
            width: canvas.width, height: canvas.height,
          };
          cleanup();
          resolve(result);
        });

        /* 先定位到起点。用 seeked 事件等它真的落到位，
           不然会把定位过程中的旧画面录进去。 */
        if (startAt > 0.01) {
          v.addEventListener("seeked", startRecording, { once: true });
          v.currentTime = startAt;
        } else {
          startRecording();
        }
      });

      function draw() {
        if (!ctx) return;
        var vw = v.videoWidth, vh = v.videoHeight;
        var dstAspect = canvas.width / canvas.height;
        var srcAspect = vw / vh;
        var sx = 0, sy = 0, sw = vw, sh = vh;
        if (Math.abs(srcAspect - dstAspect) > 0.005) {
          if (srcAspect > dstAspect) { sw = vh * dstAspect; sx = (vw - sw) / 2; }
          else { sh = vw / dstAspect; sy = (vh - sh) / 2; }
        }
        ctx.drawImage(v, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      }

      function startRecording() {
        t0 = performance.now();
        try { rec.start(200); } catch (e) { return fail(new Error("录制启动失败：" + e.message)); }

        var raf = window.requestVideoFrameCallback ? null : requestAnimationFrame;
        var total = Math.max(0.001, endAt - startAt);

        /* 优先用 requestVideoFrameCallback：它只在真有新帧时触发，
           比 rAF 少画重复帧，也能拿到这一帧真实的媒体时间。 */
        if (window.requestVideoFrameCallback) {
          var step = function (now, info) {
            if (cleaned) return;
            draw();
            var t = info && isFinite(info.mediaTime) ? info.mediaTime : v.currentTime;
            lastT = t;
            if (hooks.onProgress) hooks.onProgress(Math.min(1, (t - startAt) / total), "转码");
            if (v.ended || v.currentTime >= endAt - 0.03) return stopRecording();
            v.requestVideoFrameCallback(step);
          };
          v.requestVideoFrameCallback(step);
        } else {
          var tick = function () {
            if (cleaned) return;
            draw();
            var t = v.currentTime;
            lastT = t;
            if (hooks.onProgress) hooks.onProgress(Math.min(1, (t - startAt) / total), "转码");
            if (v.ended || t >= endAt - 0.03) return stopRecording();
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }

        var p = v.play();
        if (p && p.catch) {
          p.catch(function () {
            fail(new Error("浏览器不允许自动播放，转码起不来。再点一次按钮试试"));
          });
        }
      }

      function stopRecording() {
        /* 到点了先停录 —— 顺序不能反：先 pause 再 stop 的话，
           最后一段可能来不及写进 dataavailable。 */
        try { rec.stop(); } catch (e) { /* 忽略 */ }
        try { v.pause(); } catch (e) { /* 忽略 */ }
      }

      v.preload = "auto";
      v.playsInline = true;
      v.setAttribute("playsinline", "");
      v.muted = true;
      v.src = url;
    });
  }

  /* ---------------- 一步到位 ----------------
     探测 → 判定 → （需要就）转码 → 复核体积。
     返回的 file 可以直接丢给上传流程。

     体积复核是必要的：MediaRecorder 的码率是目标值不是保证值，
     复杂画面可能超出去。超了就降码率重来一次，最多一次 ——
     再来第二次用户等不起，不如把实情告诉他。 */
  async function process(file, profileId, override, hooks) {
    hooks = hooks || {};
    var p = await plan(file, profileId, override);
    if (!p.analysis) throw new Error("没有这个档位：" + profileId);

    if (!p.meta.decodable) {
      var e = new Error("浏览器解不开这个视频（可能是 HEVC / ProRes 之类的编码）。" +
        "这个得用本地 ffmpeg 那条路：node tools/video-prep/cli.mjs fix <文件>");
      e.code = "UNDECODABLE";
      throw e;
    }
    if (!p.analysis.worthFixing) {
      return { file: file, analysis: p.analysis, meta: p.meta, skipped: true };
    }

    var out = await transcode(file, p.analysis, hooks);

    /* 复核：拿产出物再判一次，看到底合规没有 */
    var afterMeta = await probeFile(out.file);
    afterMeta.bytes = out.bytes;
    var after = V.analyze(afterMeta, profileId, override);

    var overshoot = out.bytes > p.analysis.ops.targetBytes;
    if (overshoot && p.analysis.ops.fallbackKbps && !hooks.noRetry) {
      if (hooks.onProgress) hooks.onProgress(0, "体积超了，降码率重来");
      if (hooks.onNote) hooks.onNote("第一次出来 " + fmtSize(out.bytes) +
        " 超过 " + fmtSize(p.analysis.ops.targetBytes) + "，降码率重来一遍");
      var retryOps = JSON.parse(JSON.stringify(p.analysis.ops));
      retryOps.fallbackKbps = Math.max(120, Math.round(retryOps.fallbackKbps * 0.6));
      var retryAnalysis = Object.assign({}, p.analysis, { ops: retryOps });
      out = await transcode(file, retryAnalysis, hooks);
      afterMeta = await probeFile(out.file);
      afterMeta.bytes = out.bytes;
      after = V.analyze(afterMeta, profileId, override);
    }

    return {
      file: out.file,
      analysis: p.analysis,
      after: after,
      meta: p.meta,
      outMeta: afterMeta,
      skipped: false,
      bytes: out.bytes,
      note: fmtSize(p.meta.bytes) + " " + fmtSeconds(p.meta.seconds) + " " +
            p.meta.width + "×" + p.meta.height +
            "  →  " + fmtSize(out.bytes) + " " + fmtSeconds(out.seconds) + " " +
            out.width + "×" + out.height,
    };
  }

  window.VideoPrep = {
    available: available,
    pickMime: pickMime,
    probeFile: probeFile,
    plan: plan,
    estimateBytes: estimateBytes,
    transcode: transcode,
    process: process,
  };
})();
