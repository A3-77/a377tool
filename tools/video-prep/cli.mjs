#!/usr/bin/env node
/* =========================================================================
   视频资产处理命令行 —— 独立工具，不依赖站点也不依赖任何展示组件
   ---------------------------------------------------------------------------
   组件只声明「我要什么档位」，这个工具负责把任何视频变成那个档位。

     node tools/video-prep/cli.mjs profiles
     node tools/video-prep/cli.mjs probe   <文件...>
     node tools/video-prep/cli.mjs judge   <文件...> [--profile loop-card]
     node tools/video-prep/cli.mjs fix     <文件...> [--profile loop-card]

   为什么用本地 ffmpeg 而不是浏览器里跑 ffmpeg.wasm：
     1. ffmpeg.wasm 光 wasm 就 30 多 MB，为了偶尔传个视频让后台先下 30MB 不值
     2. 单线程 wasm 转 4K 视频慢到不可用，而且内存上限 2GB，大文件直接崩
     3. 本地 ffmpeg 能两遍编码精确控体积、能多文件批量，画质也更好
   浏览器端另有一条「就地压一下」的兜底路（assets/video-prep.js），
   适合手边没有终端的时候；两条路消费同一份判定结果，不会互相矛盾。
   ========================================================================= */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import {
  probe, encodeArgs, poster, verifyDecodable, run, nativePath, tempDir,
} from "./ffmpeg.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

/* 档位规范是浏览器和 Node 共用的同一个文件（UMD），直接 require 过来，
   不抄第二份 —— 抄一份迟早会不一致。 */
const req = createRequire(import.meta.url);
const V = req(path.join(ROOT, "web", "public", "assets", "video-spec.js"));

const FFMPEG = process.env.FFMPEG || "ffmpeg";

/* ---------------- 参数 ---------------- */

const VALUE_OPTS = new Set([
  "profile", "out", "trim", "target-size", "max-edge", "aspect", "fps",
  "poster-at", "base", "token", "crf", "preset",
]);
const FLAG_OPTS = new Set([
  "keep-audio", "poster", "local", "upload", "dry-run", "json", "force",
  "quiet", "help",
]);

function parseArgv(argv) {
  const opts = {};
  const files = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.slice(0, 2) !== "--") { files.push(a); continue; }
    const eq = a.indexOf("=");
    const key = (eq < 0 ? a.slice(2) : a.slice(2, eq)).toLowerCase();
    if (eq >= 0) { opts[key] = a.slice(eq + 1); continue; }
    if (FLAG_OPTS.has(key)) { opts[key] = true; continue; }
    if (!VALUE_OPTS.has(key)) {
      throw new Error(`不认识的参数：--${key}\n可用参数见 --help`);
    }
    const v = argv[++i];
    if (v == null) throw new Error(`--${key} 后面要跟一个值`);
    opts[key] = v;
  }
  return { opts, files };
}

/* ---------------- 输出 ---------------- */

const NO_COLOR = !!process.env.NO_COLOR;
const say = (...a) => { if (!global.__quiet) console.log(...a); };
const dim = (s) => (NO_COLOR ? s : `\x1b[2m${s}\x1b[0m`);
const bold = (s) => (NO_COLOR ? s : `\x1b[1m${s}\x1b[0m`);

function fmtMeta(meta) {
  const d = V.displaySize(meta);
  const bits = [
    V.fmtSize(meta.bytes),
    V.fmtSeconds(meta.seconds),
    `${d.width}×${d.height}` + (d.rotated ? `（旋转 ${meta.rotation}°）` : ""),
  ];
  if (meta.fps) bits.push((Math.round(meta.fps * 10) / 10) + "fps");
  bits.push(meta.vcodec + (meta.acodec ? " + " + meta.acodec : "（无音轨）"));
  bits.push(meta.container ? "." + meta.container : "");
  return bits.join("   ");
}

const MARK = { hard: "✗", warn: "!", info: "·" };

function printAnalysis(name, r, meta) {
  say(bold(name));
  say("  " + dim(fmtMeta(meta)));
  if (r.ok) {
    say("  ✓ 符合档位 " + r.profileLabel + "（" + r.profile + "）");
  } else {
    say("  " + (r.hard ? "✗" : "!") + " 不符合档位 " + r.profileLabel + "（" + r.profile + "）");
  }
  for (const i of r.issues) say("    " + MARK[i.level] + " " + i.msg);
  if (r.worthFixing) {
    say("  " + dim("处理方案："));
    r.steps.forEach((s, n) => say("    " + (n + 1) + ". " + s));
  }
}

/* ---------------- 命令：profiles ---------------- */

function cmdProfiles() {
  say(bold("可用档位") + dim("（按用途命名，不按组件命名 —— 组件换了档位不用动）"));
  say("");
  for (const id of Object.keys(V.PROFILES)) {
    const p = V.PROFILES[id];
    say(bold(id) + "   " + p.label + (p.usedBy ? dim("   当前使用者：" + p.usedBy) : dim("   暂无使用者")));
    say("  " + dim(p.why));
    for (const [k, v] of V.describe(id)) say("    " + k + "：" + v);
    say("");
  }
  say(dim("服务端硬上限 " + V.fmtSize(V.HARD.bytes) + "（" + V.HARD.why + "），超了接口直接 413，档位再宽松也越不过去。"));
}

/* ---------------- 命令：probe / judge ---------------- */

async function probeAll(files) {
  const out = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { say("✗ 找不到文件：" + f); continue; }
    out.push(await probe(f));
  }
  return out;
}

function buildOverride(opts) {
  const o = {};
  if (opts["max-edge"] != null) o.maxEdge = parseInt(opts["max-edge"], 10);
  if (opts["aspect"] != null) {
    const a = parseFloat(opts["aspect"]);
    o.aspect = isNaN(a) ? null : a;
  }
  if (opts["fps"] != null) o.fps = parseFloat(opts["fps"]);
  if (opts["target-size"] != null) {
    const b = V.parseSize(opts["target-size"]);
    if (!b) throw new Error(`看不懂的体积：${opts["target-size"]}（写成 1.5MB / 800KB）`);
    o.targetBytes = b;
  }
  if (opts["trim"] != null) {
    const r = V.parseRange(opts["trim"]);
    if (!r) throw new Error(`看不懂的区间：${opts["trim"]}（写成 2-9 表示第 2 到 9 秒）`);
    o.trim = [r.min, r.max];
  }
  if (opts["keep-audio"]) o.keepAudio = true;
  return o;
}

async function cmdProbe(files, opts) {
  const metas = await probeAll(files);
  if (opts.json) { console.log(JSON.stringify(metas, null, 2)); return 0; }
  for (const m of metas) {
    say(bold(m.name));
    say("  " + fmtMeta(m));
    say("  " + dim(m.path));
  }
  return 0;
}

async function cmdJudge(files, opts) {
  const profile = opts.profile || "loop-card";
  const override = buildOverride(opts);
  const metas = await probeAll(files);
  let bad = 0;
  const results = [];
  for (const m of metas) {
    const r = V.analyze(m, profile, override);
    results.push({ file: m.path, ...r });
    if (!r.ok) bad++;
  }
  if (opts.json) { console.log(JSON.stringify(results, null, 2)); return bad ? 1 : 0; }

  metas.forEach((m, i) => {
    if (i) say("");
    printAnalysis(m.name, results[i], m);
  });
  if (metas.length > 1) {
    say("");
    say(bad ? `${bad} / ${metas.length} 个不符合档位` : `全部 ${metas.length} 个都符合档位`);
  }
  if (bad) {
    say("");
    say(dim("改一个：node tools/video-prep/cli.mjs fix " + JSON.stringify(metas[0].path) +
            " --profile " + profile));
    say(dim("加 --upload 可以处理完直接传到线上。"));
  }
  return bad ? 1 : 0;
}

/* ---------------- 命令：fix ---------------- */

function outDirFor(firstInput, opts) {
  if (opts.out) return path.resolve(opts.out);
  if (opts.local) return path.join(ROOT, "web", "public", "assets", "showcase");
  return path.join(path.dirname(path.resolve(firstInput)), "prepped");
}

function baseName(p) {
  return path.basename(p).replace(/\.[^.]+$/, "");
}

/* 一次编码。kbps 给了就用目标体积模式，否则 CRF 画质优先。 */
async function encodeOnce(input, output, ops, o) {
  if (o.kbps) {
    /* 两遍编码：第一遍只统计，不产出文件（-f null）。
       码率模式必须两遍，一遍的话画面复杂段会突然糊掉。 */
    const dir = tempDir();
    const log = path.join(dir, "pass");
    try {
      await run(FFMPEG, encodeArgs({ input, output: "-", ops, kbps: o.kbps, pass: 1, passlog: log, preset: o.preset }));
      await run(FFMPEG, encodeArgs({ input, output, ops, kbps: o.kbps, pass: 2, passlog: log, preset: o.preset }));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  } else {
    await run(FFMPEG, encodeArgs({ input, output, ops, crf: o.crf, preset: o.preset }));
  }
}

async function upload(file, opts) {
  const base = (opts.base || process.env.SITE_BASE || "").replace(/\/$/, "");
  const token = opts.token || process.env.ADMIN_TOKEN || "";
  if (!base) throw new Error("要 --upload 得给站点地址：--base https://xxx.pages.dev（或设 SITE_BASE）");
  if (!token) throw new Error("要 --upload 得给管理口令：--token xxx（或设 ADMIN_TOKEN）");

  const ext = path.extname(file).slice(1).toLowerCase();
  const type = ext === "webm" ? "video/webm" : "video/mp4";
  const buf = await fs.promises.readFile(file);
  const fd = new FormData();
  fd.append("file", new Blob([buf], { type }), path.basename(file));

  const res = await fetch(base + "/api/media?key=" + encodeURIComponent(token), {
    method: "POST", body: fd,
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data || !data.ok) {
    throw new Error("上传失败：" + ((data && data.error) || ("HTTP " + res.status)));
  }
  return { url: base + data.files[0].url, path: data.files[0].url, size: data.files[0].size };
}

async function cmdFix(files, opts) {
  const profile = opts.profile || "loop-card";
  const override = buildOverride(opts);
  const metas = await probeAll(files);
  if (!metas.length) return 1;

  const outDir = outDirFor(files[0], opts);
  const results = [];
  let failed = 0;

  for (const m of metas) {
    const r = V.analyze(m, profile, override);
    say("");
    printAnalysis(m.name, r, m);

    if (!r.worthFixing && !opts.force) {
      say("  " + dim("已经合规，不用处理（要强制重编加 --force）"));
      results.push({ file: m.path, skipped: true, ok: r.ok });
      continue;
    }

    const out = path.join(outDir, baseName(m.path) + "." + r.ops.outExt);
    fs.mkdirSync(outDir, { recursive: true });

    if (opts["dry-run"]) {
      say("  " + dim("--dry-run，只打印命令："));
      const args = encodeArgs({ input: m.path, output: out, ops: r.ops, crf: opts.crf });
      say("    " + FFMPEG + " " + args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" "));
      if (r.ops.fallbackKbps) {
        say("    " + dim("（若上面这条出来超过 " + V.fmtSize(r.ops.targetBytes) +
                         "，还会用 " + r.ops.fallbackKbps + " kbps 两遍重编一遍）"));
      }
      results.push({ file: m.path, dryRun: true, wouldWrite: out });
      continue;
    }

    const t0 = Date.now();
    say("  " + dim("编码中…"));
    try {
      await encodeOnce(m.path, out, r.ops, {
        crf: opts.crf != null ? parseInt(opts.crf, 10) : undefined,
        preset: opts.preset,
      });
    } catch (e) {
      say("  ✗ 编码失败：" + e.message);
      failed++;
      continue;
    }

    /* CRF 编完先看结果。超了才动用两遍编码 —— 画质优先，能不两遍就不两遍。
       实测绝大多数情况 CRF 就够：8 秒 720×480 出来通常只有两三百 KB。 */
    let bytes = fs.statSync(out).size;
    let usedKbps = null;
    if (bytes > r.ops.targetBytes && r.ops.fallbackKbps) {
      let kbps = r.ops.fallbackKbps;
      say("  " + dim(`CRF 出来 ${V.fmtSize(bytes)}，超过目标 ${V.fmtSize(r.ops.targetBytes)}，` +
                     `改用 ${kbps} kbps 两遍重编…`));
      /* x264 的 -b:v 是**平均**码率，会小幅超出 —— 实测 300KB 的目标，
         按算出来的码率编完是 304KB。所以编完必须复核，还超就再降 15% 重来。
         最多两轮：再来第三轮用户等不起，不如把实情说清楚。 */
      let encErr = null;
      for (let attempt = 0; attempt < 3 && bytes > r.ops.targetBytes; attempt++) {
        if (attempt) {
          kbps = Math.max(80, Math.round(kbps * 0.85));
          say("  " + dim(`还是 ${V.fmtSize(bytes)}，降到 ${kbps} kbps 再编一遍…`));
        }
        try {
          await encodeOnce(m.path, out, r.ops, { kbps, preset: opts.preset });
        } catch (e) {
          encErr = e;
          break;
        }
        bytes = fs.statSync(out).size;
        usedKbps = kbps;
      }
      if (encErr) { say("  ✗ 两遍编码失败：" + encErr.message); failed++; continue; }
    }

    /* 编码成功 ≠ 文件能放。真的把所有帧解一遍，确认没坏 */
    const vd = await verifyDecodable(out);
    const after = await probe(out);
    const ra = V.analyze(after, profile, override);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    say("  " + (vd.ok ? "✓" : "✗") + " " + out);
    say("    " + fmtMeta(after) + dim("   " + secs + "s" + (usedKbps ? "（两遍 " + usedKbps + "kbps）" : "（CRF）")));
    say("    " + V.fmtSize(m.bytes) + " → " + V.fmtSize(bytes) +
        dim("（" + (100 - Math.round(bytes / m.bytes * 100)) + "% 没了）"));
    if (!vd.ok) { say("    ✗ 解码校验没过：" + vd.error); failed++; }
    if (ra.hard) { say("    ✗ 还有硬违规：" + ra.issues.filter(i => i.level === "hard").map(i => i.msg).join("；")); failed++; }
    else if (bytes > r.ops.targetBytes) { say("    ✗ 体积仍超过目标 " + V.fmtSize(r.ops.targetBytes)); failed++; }
    else if (!ra.ok) {
      const left = ra.issues.filter(i => i.level !== "info").map(i => i.msg);
      if (left.length) say("    ! 还剩压不掉的：" + left.join("；"));
    }

    let posterOut = null;
    if (opts.poster) {
      posterOut = path.join(outDir, baseName(m.path) + ".poster.jpg");
      const at = opts["poster-at"] != null
        ? parseFloat(opts["poster-at"])
        : Math.min(0.5, Math.max(0.05, r.outSeconds / 4));
      await poster(m.path, posterOut, r.ops, at);
      say("    ✓ 封面 " + posterOut);
    }

    let up = null;
    if (opts.upload) {
      up = await upload(out, opts);
      say("    ✓ 已上传 " + up.url);
    }

    results.push({
      file: m.path, out, bytes, before: m.bytes, poster: posterOut,
      upload: up, verified: vd.ok, compliant: ra.ok,
    });
  }

  if (opts.json) { console.log(JSON.stringify(results, null, 2)); return failed ? 1 : 0; }

  if (!opts["dry-run"] && results.some((x) => x.out)) {
    say("");
    say(dim("产物在 " + outDir));
    if (!opts.upload && !opts.local) {
      say(dim("放进仓库：加 --local；直接传线上：加 --upload --base <站点> --token <口令>"));
    }
  }
  return failed ? 1 : 0;
}

/* ---------------- 入口 ---------------- */

const HELP = `
视频资产处理 —— 把任何视频变成某个档位要求的规格

  node tools/video-prep/cli.mjs profiles
      列出所有档位和各自的要求

  node tools/video-prep/cli.mjs probe   <文件...>
      只探测，打印时长 / 分辨率 / 体积 / 编码 / 音轨

  node tools/video-prep/cli.mjs judge   <文件...> [--profile loop-card]
      判定是否符合档位，打印问题清单和处理方案（不改文件）

  node tools/video-prep/cli.mjs fix     <文件...> [--profile loop-card]
      处理成合规文件

通用参数
  --profile <id>     档位，默认 loop-card（用 profiles 命令看有哪些）
  --out <目录>       输出目录，默认 <原文件同目录>/prepped
  --local            输出到 web/public/assets/showcase/（直接进仓库）
  --upload           处理后直接传到线上 KV（配 --base / --token，或用
                     SITE_BASE / ADMIN_TOKEN 环境变量）
  --dry-run          只打印将要执行的 ffmpeg 命令
  --json             输出 JSON，给脚本消费
  --force            已经合规也重编一遍
  --quiet            少说话

覆盖档位（少数情况才需要）
  --trim <起-止>     截取区间，秒。如 --trim 2-9
  --target-size <体积>  目标体积上限，如 1.5MB
  --max-edge <像素>  长边上限
  --aspect <比例>    目标比例，如 1.5；给 none 表示保持原比例
  --fps <帧率>
  --keep-audio       保留音轨（覆盖档位的静音要求）
  --poster           顺便导出一张封面图
  --poster-at <秒>   封面取哪一帧
  --crf <0-51>       画质优先模式的 CRF，默认 23，小=好
  --preset <名字>    x264 preset，默认 medium

退出码：0 = 合规 / 成功，1 = 不符合档位 / 有文件处理失败
`;

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    console.log(HELP.trim());
    return 0;
  }
  const { opts, files } = parseArgv(argv);
  if (opts.quiet) global.__quiet = true;

  try {
    if (cmd === "profiles") return cmdProfiles(), 0;
    if (!files.length) {
      console.error(`「${cmd}」要至少给一个文件。看用法：--help`);
      return 2;
    }
    if (cmd === "probe") return await cmdProbe(files, opts);
    if (cmd === "judge") return await cmdJudge(files, opts);
    if (cmd === "fix") return await cmdFix(files, opts);
    console.error(`不认识的命令：${cmd}\n看用法：--help`);
    return 2;
  } catch (e) {
    console.error("✗ " + e.message);
    return 1;
  }
}

process.exitCode = await main();
