/* =========================================================================
   ffmpeg / ffprobe 封装
   ---------------------------------------------------------------------------
   只做「探测」和「按方案转码」两件事，不含任何业务判断 ——
   什么算合规、该缩到多大，全在 web/public/assets/video-spec.js 里，
   这个文件只负责把那份方案翻译成 ffmpeg 参数。
   ========================================================================= */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FFMPEG = process.env.FFMPEG || "ffmpeg";
const FFPROBE = process.env.FFPROBE || "ffprobe";

/* Windows 上 ffmpeg 是原生程序，不认 Git Bash 的 /c/... 路径 ——
   会报 "No such file or directory" 但目录明明存在（tests/gen_showcase_video.sh
   里也踩过同一个坑）。传给它之前统一转成 C:/... 形式。
   ffmpeg 在 Windows 上正斜杠反斜杠都收，所以只需换分隔符。 */
export function nativePath(p) {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.replace(/\\/g, "/") : abs;
}

function missing(bin) {
  const e = new Error(
    `找不到 ${bin}。装一个再跑：\n` +
    `  Windows:  winget install Gyan.FFmpeg\n` +
    `  macOS:    brew install ffmpeg\n` +
    `  或者用 FFMPEG / FFPROBE 环境变量指到可执行文件`
  );
  e.code = "ENOENT_BIN";
  return e;
}

/* 跑一个命令，把 stdout / stderr 收全。
   失败时抛出的错误里带上 stderr 尾巴 —— ffmpeg 的报错信息全在 stderr，
   不捞出来的话只能看到一句「exit 1」，没法查。 */
export function run(bin, args, opts = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true, ...opts });
    } catch (e) {
      return reject(missing(bin));
    }
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => reject(e.code === "ENOENT" ? missing(bin) : e));
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout: out, stderr: err });
      else {
        const tail = err.trim().split("\n").slice(-14).join("\n");
        const e = new Error(`${path.basename(bin)} 退出码 ${code}\n${tail}`);
        e.code = code;
        e.stderr = err;
        reject(e);
      }
    });
  });
}

/* ---------------- 探测 ---------------- */

/* 帧率是 "30000/1001" 这种分数，除一下才是人看的数 */
function parseFps(s) {
  if (!s) return 0;
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(String(s).trim());
  if (m) {
    const d = Number(m[2]);
    return d ? Number(m[1]) / d : 0;
  }
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

/* 旋转标记有两个来源，优先用 side_data_list（新格式），
   退回 tags.rotate（老格式）。手机竖拍必看，不然 1080×1920 会被当横屏。 */
function readRotation(stream) {
  const sd = stream.side_data_list || [];
  for (const s of sd) {
    if (typeof s.rotation === "number") return s.rotation;
  }
  const t = stream.tags && stream.tags.rotate;
  if (t != null && t !== "") return Number(t) || 0;
  return 0;
}

/* 归一化到 0 / 90 / 180 / 270。ffprobe 会给 -90 这种负值 */
function normRotation(r) {
  const n = ((Math.round(Number(r) || 0) % 360) + 360) % 360;
  if (n === 90 || n === 180 || n === 270) return n;
  return 0;
}

/* 容器名。mov 和 mp4 共用同一个 demuxer，format_name 都是
   "mov,mp4,m4a,3gp,3g2,mj2"，分不出来 —— 所以这里只是兜底，
   真正的格式判断以文件扩展名为准（video-spec 的 extOf 就是这么做的）。
   优先认 mp4，避免「无扩展名的 mp4」被误报成 mov 而拒掉。 */
function containerOf(formatName) {
  const f = String(formatName || "").toLowerCase();
  if (f.includes("webm") || f.includes("matroska")) return "webm";
  if (f.includes("mp4")) return "mp4";
  return f.split(",")[0] || "";
}

/**
 * 探测一个视频文件，输出 video-spec 的 analyze() 能吃的那种 meta。
 * @returns {Promise<object>}
 */
export async function probe(file) {
  const p = nativePath(file);
  const { stdout } = await run(FFPROBE, [
    "-v", "error", "-print_format", "json",
    "-show_format", "-show_streams", p,
  ]);

  let raw;
  try {
    raw = JSON.parse(stdout);
  } catch (e) {
    throw new Error(`${file} 不是能识别的媒体文件（ffprobe 没吐出 JSON）`);
  }

  const streams = raw.streams || [];
  const v = streams.find((s) => s.codec_type === "video");
  const a = streams.find((s) => s.codec_type === "audio");
  const fmt = raw.format || {};

  if (!v) throw new Error(`${file} 里没有视频流`);

  /* 时长有三个来源，按可靠度试：format.duration → 视频流 duration → 音频流。
     mp4 的流级 duration 常常缺失，所以 format 优先。 */
  let seconds = parseFloat(fmt.duration);
  if (!isFinite(seconds) || seconds <= 0) seconds = parseFloat(v.duration);
  if (!isFinite(seconds) || seconds <= 0) seconds = a ? parseFloat(a.duration) : 0;
  if (!isFinite(seconds) || seconds <= 0) seconds = 0;

  let bytes = parseInt(fmt.size, 10);
  if (!isFinite(bytes) || bytes <= 0) bytes = fs.statSync(path.resolve(file)).size;

  return {
    name: path.basename(file),
    path: path.resolve(file),
    bytes,
    seconds,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    rotation: normRotation(readRotation(v)),
    vcodec: v.codec_name || null,
    acodec: a ? (a.codec_name || "unknown") : null,
    fps: parseFps(v.avg_frame_rate || v.r_frame_rate),
    container: containerOf(fmt.format_name),
    pixFmt: v.pix_fmt || null,
  };
}

/* ---------------- 转码 ---------------- */

/* 把方案里的缩放/裁剪翻译成滤镜串。
   有比例要求时用「放大到铺满 + 居中裁」—— 顺序不能反，
   先裁后放会把边缘裁歪。crop 默认就是居中，不用额外给坐标。 */
export function buildFilter(ops) {
  const parts = [];
  if (ops.scale && ops.crop) {
    parts.push(`scale=${ops.scale.w}:${ops.scale.h}:force_original_aspect_ratio=increase`);
    parts.push(`crop=${ops.scale.w}:${ops.scale.h}`);
  } else if (ops.scale) {
    /* 只定一边、另一边给 -2：让 ffmpeg 自己算并保证偶数，
       比在 JS 里 round 少一次累积误差（h264 的 yuv420p 要求偶数） */
    parts.push(ops.scale.w ? `scale=${ops.scale.w}:-2` : `scale=-2:${ops.scale.h}`);
  }
  if (ops.fps) parts.push(`fps=${ops.fps}`);
  return parts.length ? parts.join(",") : null;
}

/**
 * 拼出一次编码的 ffmpeg 参数。
 * @param {object} o
 * @param {string} o.input     输入文件
 * @param {string} o.output    输出文件（pass 1 传 "-"）
 * @param {object} o.ops       analyze() 给的 ops
 * @param {number} [o.crf]     画质优先模式
 * @param {number} [o.kbps]    目标体积模式（和 crf 二选一）
 * @param {number} [o.pass]    1 / 2
 * @param {string} [o.passlog] 两遍编码的日志前缀
 */
export function encodeArgs(o) {
  const ops = o.ops;
  const args = ["-hide_banner", "-loglevel", "error", "-y"];

  /* -ss 放在 -i 前面 = 输入侧快速定位：先跳到最近的关键帧再往前解码到精确位置。
     对 4K 长视频比放在输出侧快一个数量级，而结果一样精确（重编码会重新出关键帧）。 */
  if (ops.trim && ops.trim.start > 0) args.push("-ss", String(ops.trim.start));
  args.push("-i", nativePath(o.input));
  if (ops.trim) args.push("-t", String(+(ops.trim.end - ops.trim.start).toFixed(3)));

  const filter = buildFilter(ops);
  if (filter) args.push("-vf", filter);

  args.push("-c:v", "libx264", "-preset", o.preset || "medium");
  if (o.kbps) args.push("-b:v", o.kbps + "k");
  else args.push("-crf", String(o.crf == null ? 23 : o.crf));
  /* yuv420p 是兼容性底线：不转的话 10bit / 444 的手机视频在 Safari 上放不出来 */
  args.push("-pix_fmt", "yuv420p");

  if (o.pass) {
    args.push("-pass", String(o.pass));
    if (o.passlog) args.push("-passlogfile", nativePath(o.passlog));
  }

  if (ops.keepAudio) args.push("-c:a", "aac", "-b:a", "96k");
  else args.push("-an");

  if (o.pass === 1) {
    args.push("-f", "null", "-");
  } else {
    /* faststart 把 moov 挪到文件头，边下边播。默认写在尾部，浏览器要等整个下完 */
    args.push("-movflags", "+faststart");
    args.push(nativePath(o.output));
  }
  return args;
}

/**
 * 抽一帧当封面。滤镜和视频保持一致，封面比例才和视频一样。
 */
export async function poster(input, output, ops, atSeconds) {
  const args = ["-hide_banner", "-loglevel", "error", "-y"];
  if (atSeconds > 0) args.push("-ss", String(atSeconds));
  args.push("-i", nativePath(input));
  const filter = buildFilter(ops);
  if (filter) args.push("-vf", filter);
  args.push("-frames:v", "1", "-q:v", "3", "-an", nativePath(output));
  await run(FFMPEG, args);
  return output;
}

/**
 * 完整解码一遍，确认输出文件没坏。
 * 光看「ffmpeg 退出码 0」不够 —— 编码成功不代表文件完整可解。
 *
 * 用 ffprobe -count_frames 而不是 `ffmpeg -f null -`，是因为后者会把视频
 * **重新复用**到 null 复用器，于是复用器自己的时间戳告警也混进 stderr：
 * 浏览器 MediaRecorder 出的 mp4 会报 "non monotonically increasing dts"，
 * 但那个文件其实能完整解码（ffmpeg 退出码也是 0）。用会真的报假警。
 * ffprobe 只解码不重新复用，报出来的才是真问题。
 * @returns {Promise<{ok:boolean, frames?:number, error?:string}>}
 */
export async function verifyDecodable(file) {
  try {
    const { stdout, stderr } = await run(FFPROBE, [
      "-v", "error",
      "-select_streams", "v",
      "-count_frames",
      "-show_entries", "stream=nb_read_frames",
      "-of", "default=noprint_wrappers=1:nokey=1",
      nativePath(file),
    ]);
    const frames = parseInt(String(stdout).trim(), 10);
    if (stderr.trim()) return { ok: false, frames, error: stderr.trim().slice(0, 300) };
    if (!isFinite(frames) || frames <= 0) {
      return { ok: false, frames, error: "一帧都没解出来" };
    }
    return { ok: true, frames };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/** 临时目录，两遍编码的日志放里面，用完删掉 */
export function tempDir(tag = "videoprep") {
  return fs.mkdtempSync(path.join(os.tmpdir(), tag + "-"));
}
