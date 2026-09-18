/**
 * 视频资产管线的端到端测试
 * ---------------------------------------------------------------------------
 * 这条管线是独立层，和任何展示组件无关，所以测试也不依赖站点：
 *
 *   [1] 档位模块     —— 纯函数，Node 直接 require，不需要浏览器
 *   [2] 命令行工具   —— 真 ffmpeg 跑一遍，产出物用 ffprobe 复核
 *   [3] 网页端引擎   —— 无头 Chrome 真跑转码，产出物落盘再 ffprobe 复核
 *
 * [3] 自己起一个小静态服务器（同源，省掉 CORS），不依赖 wrangler dev ——
 * 这样网页端引擎单独就能测，不用先起后端。
 *
 *   cd tests && node test_video_prep.mjs
 *
 * 需要 ffmpeg / ffprobe 在 PATH 上，以及 Chrome（找不到设 CHROME_PATH）。
 * 测试结束会删掉自己造的大素材，只留产出物供人工查看。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import puppeteer from "puppeteer-core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const WEB = path.join(ROOT, "web", "public");
const OUT = path.join(__dirname, "out_videoprep");
const SRC = path.join(OUT, "src");
const PREPPED = path.join(OUT, "prepped");
const BROWSER_OUT = path.join(OUT, "browser");
const CLI = path.join(ROOT, "tools", "video-prep", "cli.mjs");

/* 每轮开始先清掉上一轮的产出。
   留着会让「不该产出文件」这类断言假失败 —— 上一轮的产物还在，
   断言看到文件就以为这轮也产出了。 */
for (const d of [PREPPED, BROWSER_OUT]) fs.rmSync(d, { recursive: true, force: true });

fs.mkdirSync(SRC, { recursive: true });
fs.mkdirSync(PREPPED, { recursive: true });
fs.mkdirSync(BROWSER_OUT, { recursive: true });

const req = createRequire(import.meta.url);
const V = req(path.join(WEB, "assets", "video-spec.js"));

const NODE = process.execPath;
const CHROME =
  process.env.CHROME_PATH ||
  [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].find((p) => fs.existsSync(p));

let pass = 0, fail = 0;
function check(name, ok, extra) {
  if (ok) { pass++; console.log("  \u2713 " + name); }
  else { fail++; console.log("  \u2717 " + name + (extra ? "   \u2190 " + extra : "")); }
}
function section(t) { console.log("\n" + t); }

/* ---------------- ffmpeg 小工具 ---------------- */

/* Windows 上 ffmpeg 是原生程序，不认 Git Bash 的 /c/... 路径 */
function nativePath(p) {
  const abs = path.resolve(p);
  return process.platform === "win32" ? abs.replace(/\\/g, "/") : abs;
}

function ff(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.env.FFMPEG || "ffmpeg", args, { windowsHide: true });
    let err = "";
    c.stderr.on("data", (d) => { err += d; });
    c.on("error", () => reject(new Error("找不到 ffmpeg")));
    c.on("close", (code) => (code === 0 || opts.allowFail ? resolve(err) : reject(new Error(err.slice(-800)))));
  });
}

function ffprobeJson(file) {
  return new Promise((resolve, reject) => {
    const c = spawn(process.env.FFPROBE || "ffprobe", [
      "-v", "error", "-print_format", "json", "-show_format", "-show_streams", nativePath(file),
    ], { windowsHide: true });
    let out = "";
    c.stdout.on("data", (d) => { out += d; });
    c.on("error", () => reject(new Error("找不到 ffprobe")));
    c.on("close", () => { try { resolve(JSON.parse(out)); } catch (e) { reject(new Error("ffprobe 没吐出 JSON")); } });
  });
}

/* 光看编码成功不够 —— 真的把所有帧解一遍，确认文件完整。
   用 ffprobe -count_frames 而不是 `ffmpeg -f null -`：后者会把视频重新复用
   到 null 复用器，于是复用器自己的时间戳告警也混进 stderr —— 浏览器
   MediaRecorder 出的 mp4 会报 "non monotonically increasing dts"，
   但那个文件其实能完整解码（ffmpeg 退出码也是 0）。用它会报假警。 */
async function decodable(file) {
  const err = await new Promise((resolve) => {
    const c = spawn(process.env.FFPROBE || "ffprobe", [
      "-v", "error", "-select_streams", "v", "-count_frames",
      "-show_entries", "stream=nb_read_frames",
      "-of", "default=noprint_wrappers=1:nokey=1", nativePath(file),
    ], { windowsHide: true });
    let out = "", e = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { e += d; });
    c.on("error", () => resolve("找不到 ffprobe"));
    c.on("close", () => resolve(e.trim() || (parseInt(out, 10) > 0 ? "" : "一帧都没解出来")));
  });
  return { ok: !err, error: err.slice(0, 300) };
}

/* faststart：moov 必须在 mdat 前面，否则浏览器要等整个文件下完才能播 */
function isFaststart(file) {
  const d = fs.readFileSync(file).subarray(0, 8192);
  const moov = d.indexOf(Buffer.from("moov"));
  const mdat = d.indexOf(Buffer.from("mdat"));
  return moov >= 0 && (mdat < 0 || moov < mdat);
}

function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const c = spawn(NODE, [CLI, ...args], { windowsHide: true });
    let out = "", err = "";
    c.stdout.on("data", (d) => { out += d; });
    c.stderr.on("data", (d) => { err += d; });
    c.on("close", (code) => resolve({ code, out, err }));
  });
}

/* ---------------- 素材 ---------------- */

const BIG = path.join(SRC, "big-1080p-16x9.mp4");
const SMALL_OK = path.join(SRC, "already-ok.mp4");
const MOV = path.join(SRC, "legacy.mov");
const ROT = path.join(SRC, "portrait-rotated.mp4");

/* 1920×1080 / 20 秒 / 带 aac 音轨 / 16:9 —— 对 loop-card 档位来说
   体积、分辨率、时长、比例、音轨、帧率全都不合规，一次覆盖所有判定分支。
   用 testsrc2 不用纯色：纯色画面压出来只有几十 KB，体积相关的判定就测不出来了。 */
async function makeFixtures() {
  if (!fs.existsSync(BIG)) {
    console.log("  造素材 big-1080p-16x9.mp4（1920×1080 / 20s / 带音轨，约 48MB）…");
    await ff([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=1920x1080:r=30:d=20",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=20",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", nativePath(BIG),
    ]);
  }
  if (!fs.existsSync(SMALL_OK)) {
    /* 已经合规的素材：720×480 / 4 秒 / 无音轨 —— 不该被判定要处理 */
    await ff([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "gradients=s=720x480:d=4:speed=0.06:nb_colors=3",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "30",
      "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an", nativePath(SMALL_OK),
    ]);
  }
  if (!fs.existsSync(MOV)) fs.copyFileSync(BIG, MOV);
  if (!fs.existsSync(ROT)) {
    /* 竖拍 + 旋转标记：编码尺寸 1080×1920，显示尺寸应该是 1920×1080。
       -display_rotation 得放在 -i 前面（输入选项），放输出侧 ffmpeg 会直接报错。 */
    const tmp = path.join(SRC, "_p.mp4");
    await ff([
      "-hide_banner", "-loglevel", "error", "-y",
      "-f", "lavfi", "-i", "testsrc2=s=1080x1920:r=30:d=5",
      "-c:v", "libx264", "-preset", "ultrafast", "-crf", "24", "-pix_fmt", "yuv420p",
      nativePath(tmp),
    ]);
    await ff([
      "-hide_banner", "-loglevel", "error", "-y",
      "-display_rotation", "90", "-i", nativePath(tmp), "-c", "copy", nativePath(ROT),
    ]);
    fs.rmSync(tmp, { force: true });
  }
}

/* =========================================================================
   [1] 档位模块
   ========================================================================= */
function testSpec() {
  section("[1] 档位模块（纯函数）");

  /* 硬上限必须和服务端接口里的常量一致 —— 两处各写一个数，迟早会漂移，
     漂移的后果是「命令行说合规、传上去被 413」。 */
  const media = fs.readFileSync(path.join(ROOT, "web", "functions", "api", "_media.js"), "utf8");
  const m = /MAX_VIDEO\s*=\s*([\d\s*]+);/.exec(media);
  const serverMax = m ? m[1].split("*").map((x) => Number(x.trim())).reduce((a, b) => a * b, 1) : 0;
  check("硬上限和服务端 _media.js 的 MAX_VIDEO 一致",
    serverMax === V.HARD.bytes, `spec=${V.HARD.bytes} server=${serverMax}`);

  const rot = V.displaySize({ width: 1080, height: 1920, rotation: 90 });
  check("旋转 90° 后显示尺寸宽高互换", rot.width === 1920 && rot.height === 1080,
    JSON.stringify(rot));
  const rot270 = V.displaySize({ width: 1080, height: 1920, rotation: 270 });
  check("旋转 270° 同样互换", rot270.width === 1920 && rot270.height === 1080);
  const rot0 = V.displaySize({ width: 1080, height: 1920, rotation: 0 });
  check("没旋转就不动", rot0.width === 1080 && rot0.height === 1920);

  check("parseSize('1.5MB') = 1.5MB", V.parseSize("1.5MB") === 1572864, String(V.parseSize("1.5MB")));
  check("parseSize('800KB') = 800KB", V.parseSize("800KB") === 819200, String(V.parseSize("800KB")));
  check("parseRange('3-8') 解成区间", JSON.stringify(V.parseRange("3-8")) === '{"min":3,"max":8}');
  check("parseRange('8') 解成 0-8", JSON.stringify(V.parseRange("8")) === '{"min":0,"max":8}');

  const bad = V.analyze({
    name: "IMG.MOV", bytes: 48 * 1024 * 1024, seconds: 42.5,
    width: 1920, height: 1080, rotation: 0,
    vcodec: "hevc", acodec: "aac", fps: 59.94, container: "mov",
  }, "loop-card");
  const levels = (lv) => bad.issues.filter((i) => i.level === lv).map((i) => i.field);
  check("体积超服务端上限 → 硬违规", levels("hard").includes("bytes"));
  check("mov 容器 → 硬违规", levels("hard").includes("container"));
  check("分辨率/体积/时长/比例 四项档位不符都报出来",
    ["size", "bytes", "seconds", "aspect"].every((f) => levels("warn").includes(f)),
    JSON.stringify(levels("warn")));
  check("音轨只算提示（留着不影响功能，不为它单独重编）", levels("info").includes("audio"));
  check("帧率和编码算档位不符（这两项会真的重编）",
    levels("warn").includes("fps") && levels("warn").includes("vcodec"),
    JSON.stringify(levels("warn")));
  check("不合规 → ok 为假", bad.ok === false && bad.worthFixing === true);
  check("方案：缩放到 720×480 且要裁剪",
    bad.ops.scale && bad.ops.scale.w === 720 && bad.ops.scale.h === 480 && bad.ops.crop === true,
    JSON.stringify(bad.ops.scale));
  check("方案：截取 0–8 秒", bad.ops.trim && bad.ops.trim.end === 8, JSON.stringify(bad.ops.trim));
  check("方案：去音轨 + 降到 24fps", bad.ops.dropAudio === true && bad.ops.fps === 24);
  check("方案：反推码率留了余量（1408 kbps 左右，不是贴着 1.5MB 算）",
    bad.ops.fallbackKbps > 1350 && bad.ops.fallbackKbps < 1460, String(bad.ops.fallbackKbps));
  check("方案步骤是人话，不是参数", bad.steps.length >= 4 && /缩放到 720×480/.test(bad.steps[0]),
    bad.steps[0]);

  const good = V.analyze({
    name: "ok.mp4", bytes: 480 * 1024, seconds: 4,
    width: 720, height: 480, rotation: 0,
    vcodec: "h264", acodec: null, fps: 24, container: "mp4",
  }, "loop-card");
  check("已经合规的素材不误判、也不重编",
    good.ok === true && good.worthFixing === false && good.ops.needsReencode === false);

  /* 比例一致但没给 aspect 的档位不该裁 */
  const inline = V.analyze({
    name: "a.mp4", bytes: 2 * 1024 * 1024, seconds: 30,
    width: 1920, height: 1080, rotation: 0,
    vcodec: "h264", acodec: "aac", fps: 30, container: "mp4",
  }, "inline");
  check("inline 档位保持原比例（不裁）且保留音轨",
    inline.ops.crop === false && inline.ops.keepAudio === true,
    JSON.stringify({ crop: inline.ops.crop, keepAudio: inline.ops.keepAudio }));

  const tooShort = V.analyze({
    name: "s.mp4", bytes: 200 * 1024, seconds: 1.2,
    width: 720, height: 480, rotation: 0,
    vcodec: "h264", acodec: null, fps: 24, container: "mp4",
  }, "loop-card");
  check("太短会报出来但**不假装能修**",
    tooShort.issues.some((i) => i.field === "seconds" && /只能换素材/.test(i.msg)));

  /* --- 容差 ---
     编码器不可能精确停在某一帧；为了 0.3 秒或 4% 的帧率重编一整遍，
     省下的那点东西还不抵掉的那次画质。所以阈值要留余量，
     而且「报问题」和「动手修」必须用同一个阈值。 */
  const grace = V.analyze({
    name: "g.mp4", bytes: 500 * 1024, seconds: 8.3,
    width: 720, height: 480, rotation: 0,
    vcodec: "h264", acodec: null, fps: 25, container: "mp4",
  }, "loop-card");
  check(`时长只超 0.3 秒不判违规、也不截取（容差 ${V.DURATION_GRACE} 秒）`,
    grace.ok === true && grace.ops.trim === null && grace.worthFixing === false,
    JSON.stringify({ ok: grace.ok, trim: grace.ops.trim }));
  check(`帧率 25 对档位 24 不触发降帧（容差 ${V.FPS_SLACK} 倍）`,
    grace.ops.fps === null && !grace.issues.some((i) => i.field === "fps"),
    JSON.stringify({ fps: grace.ops.fps, issues: grace.issues.map((i) => i.field) }));

  const highFps = V.analyze({
    name: "h.mp4", bytes: 500 * 1024, seconds: 4,
    width: 720, height: 480, rotation: 0,
    vcodec: "h264", acodec: null, fps: 60, container: "mp4",
  }, "loop-card");
  check("帧率 60 才降帧，且报的是 warn（说了就会修）",
    highFps.ops.fps === 24 &&
    highFps.issues.some((i) => i.field === "fps" && i.level === "warn"),
    JSON.stringify({ fps: highFps.ops.fps, issues: highFps.issues }));

  /* 底线不变量：judge 说合规 ⟺ fix 不会动手。
     两者不一致的话，用户看到「合规」却被打包重编一遍，就不敢信这个工具了。 */
  const cases = [bad, good, grace, tooShort, inline, highFps];
  check("ok 与 worthFixing 永远一致（judge 说合规就不会被 fix 重编）",
    cases.every((c) => c.ok === !c.worthFixing),
    JSON.stringify(cases.map((c) => ({ ok: c.ok, fix: c.worthFixing }))));

  check("档位说明是从档位表生成的，不是手写",
    V.describe("loop-card").length >= 5 &&
    /720/.test(V.describe("loop-card")[1][1]));
}

/* =========================================================================
   [2] 命令行工具
   ========================================================================= */
async function testCli() {
  section("[2] 命令行工具（真 ffmpeg）");

  const prof = await runCli(["profiles"]);
  check("profiles 列出两个档位",
    prof.code === 0 && /loop-card/.test(prof.out) && /inline/.test(prof.out));

  const p = await runCli(["probe", BIG]);
  check("probe 读到 1920×1080 / 20 秒 / 有音轨",
    /1920×1080/.test(p.out) && /20 秒/.test(p.out) && /aac/.test(p.out), p.out.split("\n")[1]);

  const pj = await runCli(["probe", "--json", BIG]);
  const meta = JSON.parse(pj.out)[0];
  check("probe --json 给出机器可读的元数据",
    meta.width === 1920 && meta.height === 1080 && meta.acodec === "aac" &&
    Math.abs(meta.seconds - 20) < 0.5, JSON.stringify(meta).slice(0, 160));

  const rot = await runCli(["probe", ROT]);
  check("旋转标记被读出来并换算成显示尺寸",
    /旋转 90°/.test(rot.out) && /1920×1080/.test(rot.out), rot.out.split("\n")[1]);

  const j = await runCli(["judge", BIG]);
  check("judge 不合规时退出码为 1", j.code === 1);
  check("judge 给出可直接复制的修复命令", /cli\.mjs fix/.test(j.out));

  const jGood = await runCli(["judge", SMALL_OK]);
  check("judge 已合规素材退出码为 0", jGood.code === 0, jGood.out);

  const jMov = await runCli(["judge", MOV]);
  check("judge .mov 报硬违规（服务端不收 mov）",
    jMov.code === 1 && /只收 mp4 \/ webm/.test(jMov.out));

  /* --- fix --- */
  const fx = await runCli(["fix", BIG, "--out", PREPPED, "--poster"]);
  check("fix 退出码 0", fx.code === 0, fx.out.slice(-400));
  const fixed = path.join(PREPPED, "big-1080p-16x9.mp4");
  check("产出文件存在", fs.existsSync(fixed));

  const info = await ffprobeJson(fixed);
  const v = info.streams.find((s) => s.codec_type === "video");
  const a = info.streams.find((s) => s.codec_type === "audio");
  const bytes = fs.statSync(fixed).size;
  const dur = parseFloat(info.format.duration);

  check("长边压到 720 以内", Math.max(v.width, v.height) <= 720, `${v.width}×${v.height}`);
  check("比例正好是档位要求的 1.5", Math.abs(v.width / v.height - 1.5) < 0.005,
    (v.width / v.height).toFixed(4));
  check("时长截到 8 秒以内", dur <= 8.05, String(dur));
  check("音轨被去掉了", !a);
  check("体积在档位上限 1.5MB 以内", bytes <= 1.5 * 1024 * 1024, V.fmtSize(bytes));
  check("编码是 h264 / yuv420p（兼容性底线）",
    v.codec_name === "h264" && v.pix_fmt === "yuv420p", `${v.codec_name}/${v.pix_fmt}`);
  check("帧率降到 24", Math.abs(parseFloat(v.r_frame_rate) - 24) < 0.1, v.r_frame_rate);
  check("moov 前置（faststart，边下边播）", isFaststart(fixed));
  const dec = await decodable(fixed);
  check("产出文件能完整解码（不是「编码成功但文件坏了」）", dec.ok, dec.error);
  check("封面图也出来了",
    fs.existsSync(path.join(PREPPED, "big-1080p-16x9.poster.jpg")));

  /* 压完再判一次 —— 这才是「真的合规了」的证据 */
  const rejudge = await runCli(["judge", fixed]);
  check("产出物重新判定为合规", rejudge.code === 0, rejudge.out.slice(-300));

  /* 两遍编码：把目标体积压到 CRF 达不到的水平，必须走反推码率 */
  const out2 = path.join(PREPPED, "twopass");
  const fx2 = await runCli(["fix", BIG, "--out", out2, "--target-size", "300KB", "--force"]);
  const two = path.join(out2, "big-1080p-16x9.mp4");
  check("目标 300KB 时真的走两遍编码并达标",
    fs.existsSync(two) && fs.statSync(two).size <= 300 * 1024,
    fs.existsSync(two) ? V.fmtSize(fs.statSync(two).size) : "没产出");
  check("两遍编码的输出也能解码",
    fs.existsSync(two) && (await decodable(two)).ok);

  /* 手动指定截取区间 */
  const out3 = path.join(PREPPED, "trim");
  await runCli(["fix", BIG, "--out", out3, "--trim", "2-5", "--force"]);
  const trimmed = await ffprobeJson(path.join(out3, "big-1080p-16x9.mp4"));
  check("--trim 2-5 出来是 3 秒", Math.abs(parseFloat(trimmed.format.duration) - 3) < 0.2,
    trimmed.format.duration);

  /* .mov 修完应该变成 .mp4 */
  const out4 = path.join(PREPPED, "mov");
  await runCli(["fix", MOV, "--out", out4]);
  check(".mov 处理完输出的是 .mp4（换容器）",
    fs.existsSync(path.join(out4, "legacy.mp4")) && !fs.existsSync(path.join(out4, "legacy.mov")));

  /* 已经合规的就不该动它 */
  const out5 = path.join(PREPPED, "skip");
  const skip = await runCli(["fix", SMALL_OK, "--out", out5]);
  check("已经合规的素材跳过、不重复编码",
    skip.code === 0 && /已经合规/.test(skip.out) && !fs.existsSync(path.join(out5, "already-ok.mp4")),
    skip.out.slice(-200));

  /* 旋转素材：显示尺寸 1920×1080 会被裁成 720×480，且方向不能反 */
  const out6 = path.join(PREPPED, "rot");
  await runCli(["fix", ROT, "--out", out6]);
  const rotOut = path.join(out6, "portrait-rotated.mp4");
  if (fs.existsSync(rotOut)) {
    const ri = await ffprobeJson(rotOut);
    const rv = ri.streams.find((s) => s.codec_type === "video");
    check("竖拍旋转素材处理成 720×480（方向没搞反）",
      rv.width === 720 && rv.height === 480, `${rv.width}×${rv.height}`);
    check("旋转素材的产出也能解码", (await decodable(rotOut)).ok);
  } else {
    check("竖拍旋转素材处理成 720×480（方向没搞反）", false, "没产出");
  }

  const dry = await runCli(["fix", BIG, "--dry-run"]);
  check("--dry-run 只打印命令、不产出文件",
    /-vf/.test(dry.out) && /libx264/.test(dry.out) && !fs.existsSync(path.join(SRC, "prepped", "dry.mp4")));
}

/* =========================================================================
   [3] 网页端引擎（无头 Chrome 真跑）
   ========================================================================= */

/* 自己起个同源小服务器：页面、脚本、素材、存盘口都在一个 origin 下，
   省掉 CORS 那堆事，也让网页端引擎能脱离 wrangler dev 单独测。 */
function startServer() {
  const PAGE = `<!doctype html><meta charset="utf-8"><title>video-prep harness</title>
<script src="/assets/video-spec.js"></script>
<script src="/assets/video-prep.js"></script>`;

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    if (req.method === "POST" && u.pathname === "/save") {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const name = path.basename(u.searchParams.get("name") || "out.bin");
        fs.writeFileSync(path.join(BROWSER_OUT, name), Buffer.concat(chunks));
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("ok");
      });
      return;
    }
    let file = null;
    if (u.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    if (u.pathname.startsWith("/assets/")) file = path.join(WEB, u.pathname);
    else if (u.pathname.startsWith("/fixture/")) file = path.join(SRC, decodeURIComponent(u.pathname.slice(9)));
    else if (u.pathname.startsWith("/browser-out/")) file = path.join(BROWSER_OUT, decodeURIComponent(u.pathname.slice(13)));
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404); return res.end("not found");
    }
    const ext = path.extname(file).toLowerCase();
    const type = ext === ".js" ? "text/javascript"
      : ext === ".mp4" ? "video/mp4" : ext === ".webm" ? "video/webm" : "application/octet-stream";
    const st = fs.statSync(file);
    /* 支持 Range：<video> 定位要 seek，没有 Range 就只能从头顺放，
       测 --trim 的定位行为会不准 */
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      const start = m[1] ? parseInt(m[1], 10) : 0;
      const end = m[2] ? parseInt(m[2], 10) : st.size - 1;
      res.writeHead(206, {
        "content-type": type, "accept-ranges": "bytes",
        "content-range": `bytes ${start}-${end}/${st.size}`,
        "content-length": end - start + 1,
      });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "content-type": type, "accept-ranges": "bytes", "content-length": st.size });
    fs.createReadStream(file).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

async function testBrowser() {
  section("[3] 网页端引擎（无头 Chrome 真跑转码）");

  if (!CHROME) {
    check("找到 Chrome", false, "设 CHROME_PATH 环境变量");
    return;
  }

  const { server, port } = await startServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--mute-audio",
    ],
  });

  try {
    const page = await browser.newPage();
    const logs = [];
    page.on("console", (m) => logs.push(m.text()));
    page.on("pageerror", (e) => logs.push("PAGEERROR " + e.message));
    await page.goto(base + "/", { waitUntil: "load" });

    const has = await page.evaluate(() => ({
      spec: typeof window.VideoSpec, prep: typeof window.VideoPrep,
      avail: window.VideoPrep && window.VideoPrep.available(),
      mime: window.VideoPrep && window.VideoPrep.pickMime(),
    }));
    check("两个脚本都能在浏览器里加载", has.spec === "object" && has.prep === "object",
      JSON.stringify(has));
    check("这个浏览器能就地转码", has.avail === true, JSON.stringify(has));
    console.log("    " + "编码器：" + has.mime);

    /* 浏览器侧探测：不下载不上传，只读 header */
    const probed = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const f = new File([await r.blob()], "big-1080p-16x9.mp4", { type: "video/mp4" });
      const m = await VideoPrep.probeFile(f);
      const plan = await VideoPrep.plan(f, "loop-card", {});
      return {
        meta: m,
        ok: plan.analysis.ok,
        scale: plan.analysis.ops.scale,
        crop: plan.analysis.ops.crop,
        trim: plan.analysis.ops.trim,
        kbps: plan.analysis.ops.fallbackKbps,
        estimate: VideoPrep.estimateBytes(plan.analysis),
      };
    }, base + "/fixture/big-1080p-16x9.mp4");

    check("网页端读到元数据（1920×1080 / 20 秒）",
      probed.meta.width === 1920 && probed.meta.height === 1080 &&
      Math.abs(probed.meta.seconds - 20) < 0.6,
      JSON.stringify(probed.meta).slice(0, 200));
    check("网页端判定的方案和命令行一致（720×480 + 裁剪 + 截 8 秒）",
      probed.scale.w === 720 && probed.scale.h === 480 && probed.crop === true &&
      probed.trim.end === 8,
      JSON.stringify({ s: probed.scale, crop: probed.crop, trim: probed.trim }));
    check("动手前能估出产出体积（约 1.5MB 以内）",
      probed.estimate > 0 && probed.estimate <= 1.5 * 1024 * 1024, String(probed.estimate));

    /* --- 真转码 --- */
    console.log("    " + "转码中（实时，8 秒素材约 8 秒）…");
    const t0 = Date.now();
    const res = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const f = new File([await r.blob()], "big-1080p-16x9.mp4", { type: "video/mp4" });
      const notes = [];
      const out = await VideoPrep.process(f, "loop-card", {}, {
        onNote: (n) => notes.push(n),
      });
      /* 用 POST 把产出物交给 Node 侧存盘 —— 比 base64 过 evaluate 稳得多 */
      const save = await fetch("/save?name=" + encodeURIComponent(out.file.name), {
        method: "POST", body: out.file,
      });
      return {
        saved: save.ok, name: out.file.name, bytes: out.bytes, note: out.note,
        width: out.outMeta.width, height: out.outMeta.height,
        seconds: out.outMeta.seconds, ok: out.after ? out.after.ok : null,
        issues: out.after ? out.after.issues.map((i) => i.level + ":" + i.field) : [],
        skipped: !!out.skipped, notes,
      };
    }, base + "/fixture/big-1080p-16x9.mp4");
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    check("转码完成并落盘", res.saved === true, JSON.stringify(res).slice(0, 200));
    console.log("    产出：" + res.name + "  " + V.fmtSize(res.bytes) +
      "  " + res.width + "×" + res.height + "  耗时 " + elapsed + "s");
    if (res.notes.length) res.notes.forEach((n) => console.log("    注：" + n));

    check("产出体积在档位上限 1.5MB 以内", res.bytes <= 1.5 * 1024 * 1024, V.fmtSize(res.bytes));
    check("产出尺寸是 720×480", res.width === 720 && res.height === 480,
      `${res.width}×${res.height}`);
    check("产出格式是服务端收的（mp4 或 webm）",
      /\.(mp4|webm)$/.test(res.name), res.name);
    check("转码后重新判定为合规", res.ok === true, JSON.stringify(res.issues));

    /* 落盘的产出物用 ffprobe 独立复核 —— 不能只信浏览器自己的说法 */
    const savedFile = path.join(BROWSER_OUT, res.name);
    check("落盘的产出物能被 ffprobe 解析", fs.existsSync(savedFile));
    if (fs.existsSync(savedFile)) {
      const bi = await ffprobeJson(savedFile);
      const bv = bi.streams.find((s) => s.codec_type === "video");
      const ba = bi.streams.find((s) => s.codec_type === "audio");
      check("ffprobe 确认尺寸是 720×480 且比例正好 1.5",
        bv.width === 720 && bv.height === 480 && Math.abs(bv.width / bv.height - 1.5) < 0.005,
        `${bv.width}×${bv.height}`);
      check("ffprobe 确认没有音轨（档位要求静音）", !ba,
        ba ? "有 " + ba.codec_name : "");
      const bd = await decodable(savedFile);
      check("落盘的产出物能完整解码", bd.ok, bd.error);
      const bdur = parseFloat(bi.format.duration);
      console.log("    ffprobe 时长：" + bdur + " 秒（目标 8）");
      check("时长落在 7–9 秒之间", bdur >= 7 && bdur <= 9, String(bdur));

      /* 关键一步：产出物能不能在浏览器里正常播 —— 这才是「能用」的分界线。
         MediaRecorder 出来的文件如果缺时长元数据，<video> 会报 Infinity。 */
      const play = await page.evaluate(async (url) => {
        const r = await fetch(url);
        const f = new File([await r.blob()], "out.mp4", { type: "video/mp4" });
        const m = await VideoPrep.probeFile(f);
        return { w: m.width, h: m.height, d: m.seconds, decodable: m.decodable };
      }, base + "/browser-out/" + encodeURIComponent(res.name)).catch(() => null);
      check("产出物能被 <video> 读出时长（不是 Infinity，画廊循环才正常）",
        play && play.decodable && isFinite(play.d) && play.d > 6,
        play ? JSON.stringify(play) : "读不到");
    }

    /* 已经合规的素材应当直接跳过，不做无谓的实时转码 */
    const skip = await page.evaluate(async (url) => {
      const r = await fetch(url);
      const f = new File([await r.blob()], "already-ok.mp4", { type: "video/mp4" });
      const out = await VideoPrep.process(f, "loop-card", {}, {});
      return { skipped: !!out.skipped, bytes: f.size, note: out.note || "" };
    }, base + "/fixture/already-ok.mp4");
    check("已经合规的素材直接跳过、不白等一轮实时转码", skip.skipped === true,
      JSON.stringify(skip));

    /* ---- 时长读不出来的素材 ----
       MediaRecorder 录出来的 webm 没有时长元数据，<video>.duration 是 Infinity，
       probeFile 会把它记成 0。曾经的 bug：把 0 当成录制终点，
       于是第一帧就停，录出个 0 字节的文件，上传被服务端以「空文件」拒掉。
       现在应该退成「录到档位上限为止」，产出正常。
       这个用例顺手把「浏览器自己录的 webm」也覆盖了 —— 用户很可能拖这种文件进来。 */
    console.log("    " + "另造一个 MediaRecorder 录的 webm（时长读不出来）…");
    const unk = await page.evaluate(async () => {
      const cv = document.createElement("canvas");
      cv.width = 1920; cv.height = 1080;
      const ctx = cv.getContext("2d");
      const rec = new MediaRecorder(cv.captureStream(30), { mimeType: "video/webm" });
      const chunks = [];
      rec.addEventListener("dataavailable", (e) => { if (e.data.size) chunks.push(e.data); });
      rec.start(100);
      const t0 = performance.now();
      await new Promise((res) => {
        (function d() {
          const t = (performance.now() - t0) / 1000;
          ctx.fillStyle = "hsl(" + ((t * 140) % 360) + " 80% 45%)";
          ctx.fillRect(0, 0, 1920, 1080);
          if (t > 3.4) return res();
          requestAnimationFrame(d);
        })();
      });
      rec.stop();
      await new Promise((r) => rec.addEventListener("stop", r));
      const f = new File([new Blob(chunks, { type: "video/webm" })], "recorded.webm",
        { type: "video/webm" });

      const meta = await VideoPrep.probeFile(f);
      const out = await VideoPrep.process(f, "loop-card", {}, {});
      return {
        metaSeconds: meta.seconds, metaW: meta.width, metaH: meta.height,
        decodable: meta.decodable, skipped: !!out.skipped, bytes: out.bytes,
        ow: out.outMeta.width, oh: out.outMeta.height, osec: out.outMeta.seconds,
        ok: out.after ? out.after.ok : null,
      };
    });
    console.log("    素材时长读出来是 " + unk.metaSeconds + " 秒（0 = 读不出来）");
    check("尺寸能读出来、判定能跑（时长读不出来也不影响）",
      unk.decodable === true && unk.metaW === 1920 && unk.metaH === 1080,
      JSON.stringify(unk));
    check("时长读不出来时不会录出空文件（退成录到档位上限）",
      unk.skipped === false && unk.bytes > 10 * 1024, String(unk.bytes));
    check("这种素材也能被处理成 720×480", unk.ow === 720 && unk.oh === 480,
      unk.ow + "×" + unk.oh);
    check("处理完仍然判定为合规", unk.ok === true, JSON.stringify(unk));

    const errs = logs.filter((l) => l.startsWith("PAGEERROR"));
    check("页面上没有未捕获的报错", errs.length === 0, errs.join(" | ").slice(0, 300));
  } finally {
    await browser.close();
    server.close();
  }
}

/* ---------------- 跑 ---------------- */

console.log("视频资产管线端到端测试");
console.log("产物目录：" + OUT);
await makeFixtures();
testSpec();
await testCli();
await testBrowser();

console.log("\n" + (fail ? `\u2717 ${fail} 项没过，` : "") + `\u2713 ${pass} 项通过` +
  (fail ? "" : "，全绿"));
process.exit(fail ? 1 : 0);
