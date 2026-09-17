/**
 * Code0 图片工作台 —— Cloudflare Pages Function 版
 *
 * 对应本地版 code0_web.py 的后端部分。API Key 从环境变量读（CODE0_API_KEY），
 * 前端源码里看不到，比内置在 JS 里安全。
 *
 * 路由：
 *   GET  /api/code0/status   -> { key: bool, base: string }
 *   POST /api/code0/gen      -> { ok, mime, image_b64 }
 *   POST /api/code0/edit     -> { ok, mime, image_b64 }
 *   POST /api/code0/export   -> ZIP
 */

const DEFAULT_BASE_URL = "https://code0.ai/v1";
const MODEL_DEFAULT = "gpt-image-2.5-sunburst-c";

/* ---------------- 工具 ---------------- */

function getKeyBase(env) {
  const key = env.CODE0_API_KEY || env.IMAGE_API_KEY || "";
  const base = (env.CODE0_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
  return { key, base };
}

function sniffMime(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return "image/png";
}

function b64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToB64(bytes) {
  let s = "";
  const CH = 0x8000;                       // 分块，避免 apply 参数过多爆栈
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(s);
}

/** 把平台常见报错翻成中文建议（照搬本地版） */
function friendlyHint(code, body) {
  const b = String(body || "").toLowerCase();
  if (code === 451 || b.includes("safety policy") || b.includes("filtered") || b.includes("content policy")) {
    return "\n\n💡 平台安全审核拦截了本次生成（不是软件故障）：换个说法重试，避免真人姓名/明星肖像、真实人物、暴露、暴力等描述；图生图时源图含这类元素也可能被拦。";
  }
  if (code === 401) return "\n\n💡 API Key 无效，检查环境变量 CODE0_API_KEY 是否配置正确。";
  if (code === 402 || b.includes("insufficient") || b.includes("quota") || b.includes("balance")) {
    return "\n\n💡 账户余额或额度不足，去 code0.ai 控制台充值或更换分组。";
  }
  if (code === 429) return "\n\n💡 请求太频繁，等几十秒再试。";
  if (code >= 500) return "\n\n💡 平台该模型上游暂时不可用（服务端故障，本次未计费）：换个模型（如 gpt-image-2.5-flare-c）通常马上能用。";
  return "";
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/* ---------------- 调用上游 ---------------- */

async function postJson(url, key, payload) {
  const r = await fetch(url, {
    method: "POST",
    headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + " 调用失败: " + text.slice(0, 900) + friendlyHint(r.status, text));
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error("上游响应不是 JSON：" + text.slice(0, 300));
  }
}

async function extractImage(item) {
  if (item && item.b64_json) {
    let v = item.b64_json;
    if (v.startsWith("data:")) v = v.split(",", 1)[1];
    return b64ToBytes(v);
  }
  if (item && item.url) {
    const r = await fetch(item.url);
    if (!r.ok) throw new Error("下载生成结果失败 HTTP " + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }
  throw new Error("响应中既没有 b64_json 也没有 url 字段");
}

function requireData(resp) {
  const data = (resp && resp.data) || [];
  if (!data.length) throw new Error("响应中没有 data 字段: " + JSON.stringify(resp).slice(0, 500));
  return data[0];
}

function addSize(target, d) {
  if (d.size && d.size !== "auto") target.size = d.size;
}

async function callGen(d, key, base) {
  const payload = { model: d.model || MODEL_DEFAULT, prompt: d.prompt || "" };
  addSize(payload, d);
  return extractImage(requireData(await postJson(base + "/images/generations", key, payload)));
}

/** 走 multipart 的图生图（对应本地版的 call_edit_multipart） */
async function callEditMultipart(d, key, base) {
  const bytes = b64ToBytes(d.image_b64);
  const mime = sniffMime(bytes);
  const ext = { "image/jpeg": "jpg", "image/webp": "webp" }[mime] || "png";
  const fd = new FormData();
  fd.append("model", d.model || MODEL_DEFAULT);
  fd.append("prompt", d.prompt || "");
  if (d.size && d.size !== "auto") fd.append("size", d.size);
  fd.append("image", new Blob([bytes], { type: mime }), "source." + ext);

  const r = await fetch(base + "/images/edits", {
    method: "POST",
    headers: { Authorization: "Bearer " + key },
    body: fd,
  });
  const text = await r.text();
  if (!r.ok) throw new Error("HTTP " + r.status + " 调用失败: " + text.slice(0, 900) + friendlyHint(r.status, text));
  let resp;
  try {
    resp = JSON.parse(text);
  } catch (e) {
    throw new Error("上游响应不是 JSON：" + text.slice(0, 300));
  }
  return extractImage(requireData(resp));
}

/** 走 chat/completions 的图生图（从 markdown 里抠图） */
async function callEditChat(d, key, base) {
  const bytes = b64ToBytes(d.image_b64);
  const mime = sniffMime(bytes);
  const payload = {
    model: d.model || MODEL_DEFAULT,
    messages: [{
      role: "user",
      content: [
        { type: "text", text: d.prompt || "" },
        { type: "image_url", image_url: { url: "data:" + mime + ";base64," + d.image_b64 } },
      ],
    }],
  };
  const resp = await postJson(base + "/chat/completions", key, payload);
  let content;
  try {
    content = resp.choices[0].message.content;
  } catch (e) {
    throw new Error("响应格式异常: " + JSON.stringify(resp).slice(0, 500));
  }
  let m = content.match(/!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/);
  if (m) {
    const r = await fetch(m[1]);
    if (!r.ok) throw new Error("下载生成结果失败 HTTP " + r.status);
    return new Uint8Array(await r.arrayBuffer());
  }
  m = content.match(/!\[[^\]]*\]\(data:image\/[^;]+;base64,([A-Za-z0-9+/=\s]+)\)/);
  if (m) return b64ToBytes(m[1].replace(/\s+/g, ""));
  const s = content.trim();
  const raw = s.startsWith("data:") ? s.split(",", 1)[1] : s;
  try {
    return b64ToBytes(raw);
  } catch (e) {
    throw new Error("无法从返回内容中提取图片，原始内容:\n" + content.slice(0, 500));
  }
}

async function callEdit(d, key, base) {
  if (!d.image_b64) throw new Error("缺少源图片数据");
  if (d.channel === "chat") return callEditChat(d, key, base);
  return callEditMultipart(d, key, base);
}

/* ---------------- ZIP（只用 STORE，不压缩） ---------------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function makeZip(entries) {
  const enc = new TextEncoder();
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const size = data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);      // 本地文件头签名
    lv.setUint16(4, 20, true);              // 版本
    lv.setUint16(6, 0x0800, true);          // 通用标志：文件名 UTF-8
    lv.setUint16(8, 0, true);               // 压缩方式：STORE
    lv.setUint16(10, 0, true);              // 时间
    lv.setUint16(12, 0, true);              // 日期
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);      // 中央目录签名
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, size, true);
    cv.setUint32(24, size, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);

    offset += local.length + size;
  }

  const cdSize = central.reduce((a, b) => a + b.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);        // 中央目录结束记录
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = chunks.concat(central, [end]);
  const total = all.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/* ---------------- 路由 ---------------- */

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const { key, base } = getKeyBase(env);

  if (path.endsWith("/status")) {
    return json({ key: !!key, base });
  }
  return json({ ok: false, error: "未知接口" }, 404);
}

export async function onRequestPost({ request, env }) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "");
  const { key, base } = getKeyBase(env);

  if (!key) {
    return json({
      ok: false,
      error: '服务端没有配置 API Key。需要设置环境变量 CODE0_API_KEY：\n'
           + 'npx wrangler pages secret put CODE0_API_KEY --project-name=a377tool',
    });
  }

  let d;
  try {
    d = await request.json();
  } catch (e) {
    return json({ ok: false, error: "请求体不是合法 JSON" }, 400);
  }

  /* ---- 打包下载 ---- */
  if (path.endsWith("/export")) {
    const files = d.files || [];
    if (!files.length) return json({ ok: false, error: "没有可导出的文件" });
    const used = new Set();
    const entries = [];
    for (const f of files) {
      let fn = String(f.filename || "image.jpg").split(/[\\/]/).pop() || "image.jpg";
      const dot = fn.lastIndexOf(".");
      const stem = dot > 0 ? fn.slice(0, dot) : fn;
      const ext = dot > 0 ? fn.slice(dot) : "";
      let k = 2;
      while (used.has(fn)) { fn = stem + "(" + k + ")" + ext; k++; }
      used.add(fn);
      try {
        entries.push({ name: fn, data: b64ToBytes(f.image_b64 || "") });
      } catch (e) { /* 跳过坏数据 */ }
    }
    if (!entries.length) return json({ ok: false, error: "文件数据都解析失败了" });
    const zip = makeZip(entries);
    return new Response(zip, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": 'attachment; filename="export.zip"',
        "Cache-Control": "no-store",
      },
    });
  }

  /* ---- 生成 / 编辑 ---- */
  const fn = path.endsWith("/gen") ? callGen : path.endsWith("/edit") ? callEdit : null;
  if (!fn) return json({ ok: false, error: "未知接口" }, 404);

  try {
    const img = await fn(d, key, base);
    return json({ ok: true, mime: sniffMime(img), image_b64: bytesToB64(img) });
  } catch (e) {
    return json({ ok: false, error: String(e && e.message || e) });
  }
}
