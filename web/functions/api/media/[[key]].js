/* =========================================================================
   素材接口：上传 / 读取 / 删除，全在这一个文件里
     POST   /api/media?key=TOKEN   上传（multipart/form-data，字段名 file，可多个）
     GET    /api/media/<key>       读取（公开 —— 首页要能直接引用）
     DELETE /api/media/<key>?key=TOKEN  删除

   为什么不用 media.js + media/[[key]].js 两个文件：
     试过。`[[key]]` 这个 catch-all 连 /api/media（零段）也会匹配，
     于是同一个路径被两个文件抢，Pages 按「先匹配到的路由没有这个方法就往后找」
     来兜 —— POST 落到 media.js、GET 落到 [[key]].js。能跑，但依赖的是
     路由匹配顺序这种没写进文档的行为。合成一个文件就没有这个问题。

   为什么显式用 Cache API：
     Pages Functions 的响应**默认不进边缘缓存**，光写 Cache-Control 只是告诉
     浏览器。而每次读 KV 都要算一次「读」—— 免费额度是每天 10 万次，首页一轮
     画廊 + Photo Stack 就是十几次读，不缓存的话几千次访问就打满。所以这里手动
     caches.default，同一张图在一个机房只读一次 KV。

   存储方案（为什么是 KV 不是 R2）见 ../_media.js 顶部注释。

   两个签名上的坑，都是踩出来的：
     · _lib.js 的 json() 是 (data, init)，不是 (data, status) ——
       写 json(x, 404) 会静默变成 200。错误一律走 fail(msg, code)。
     · [[key]] 捕获到的是**数组**（["m","20260918-xxx.png"]），不是字符串。
   ========================================================================= */
import {
  MAX_IMAGE, MAX_VIDEO, MAX_FILES,
  extOf, kindOf, newKey, keyFromPath, uploadAuth, humanSize, MIME,
} from '../_media.js';
import { json, fail } from '../_lib.js';

/* ---------------- 上传 ---------------- */
export async function onRequestPost({ request, env }){
  const denied = uploadAuth(env, request);
  if(denied) return denied;

  if(!env.MEDIA){
    return fail('没有绑定素材存储。需要在 Cloudflare 建一个 KV 命名空间，' +
      '在 wrangler.toml 里绑定成 MEDIA，然后重新部署。', 503);
  }

  let form;
  try{ form = await request.formData(); }
  catch(e){ return fail('请求不是合法的 multipart/form-data', 400); }

  /* 只要 File —— formData 里除了文件还有普通字段，typeof 都是 object，
     靠 arrayBuffer 判断更稳（Blob / File 才有） */
  const files = form.getAll('file')
    .filter(f => f && typeof f === 'object' && typeof f.arrayBuffer === 'function');
  if(!files.length) return fail('没有收到文件（表单字段名要叫 file）', 400);
  if(files.length > MAX_FILES) return fail(`一次最多传 ${MAX_FILES} 个`, 400);

  const out = [];
  for(const f of files){
    const name = f.name || '未命名';

    const ext = extOf(f.type, name);
    if(!ext){
      return fail(`${name} 的类型不支持（${f.type || '未知'}）。` +
        '图片只收 jpg / png / webp / avif / gif，视频只收 mp4 / webm。', 415);
    }

    const isVideo = kindOf(ext) === 'video';
    const max = isVideo ? MAX_VIDEO : MAX_IMAGE;
    if(f.size > max){
      return fail(`${name} 有 ${humanSize(f.size)}，超过上限 ${humanSize(max)}。` +
        (isVideo ? '先用手机相册或 ffmpeg 压一下再传。' : ''), 413);
    }

    const buf = await f.arrayBuffer();
    /* 空文件单独拦：拖进一个 0 字节的占位文件很常见，
       存进去之后前台就是一块空白，比在这里报错难查得多 */
    if(!buf.byteLength) return fail(`${name} 是空文件`, 400);

    const key = newKey(ext);
    await env.MEDIA.put(key, buf, {
      /* metadata 存原始文件名，方便在 KV 控制台里认出这是哪张图。
         metadata 有 1024 字节上限，超了 KV 会直接抛错，所以截断。 */
      metadata: { name: String(name).slice(0, 200), type: MIME[ext] },
    });
    out.push({ url: '/api/media/' + key, name, size: buf.byteLength, type: MIME[ext] });
  }

  return json({ ok: true, files: out });
}

/* ---------------- 读取 ---------------- */
export async function onRequestGet({ request, params, env, waitUntil }){
  const found = keyFromPath(params.key);
  /* 没带 key（就是访问了 /api/media 本身）时给个说得清的提示，而不是 404 */
  if(!found){
    return params.key ? fail('没有这个素材', 404)
      : fail('这是素材接口。上传 POST multipart/form-data 到 /api/media?key=TOKEN，' +
             '读取用 /api/media/m/<日期>-<随机>.<扩展名>。', 405);
  }

  if(!env.MEDIA) return fail('没有绑定素材存储（KV 绑定名 MEDIA）', 503);

  /* 先问边缘缓存。key 里带随机段、内容永不改变，
     所以命中缓存拿到的东西和重新读 KV 完全一致。
     本地 wrangler dev 下 Cache API 是模拟实现，失败也不能影响主流程。 */
  const cache = caches.default;
  let hit = null;
  try{ hit = await cache.match(request); }catch(e){}
  if(hit) return hit;

  const { value, metadata } = await env.MEDIA.getWithMetadata(found.key, 'arrayBuffer');
  if(!value) return fail('没有这个素材', 404);

  const res = new Response(value, {
    headers: {
      'Content-Type': MIME[found.ext],
      /* immutable 站得住的原因：换素材 = 换 key，不存在「改了图用户还看旧的」。
         真要在同一个路径上换内容，只能换 key，所以可以放心长缓存。 */
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(value.byteLength),
      'X-Media-Name': encodeURIComponent(String((metadata && metadata.name) || '')),
    },
  });

  /* 写缓存不能挡住响应 —— waitUntil 让它在后台完成 */
  if(waitUntil){
    try{ waitUntil(cache.put(request, res.clone())); }catch(e){}
  }
  return res;
}

/* ---------------- 删除 ---------------- */
export async function onRequestDelete({ request, params, env }){
  const denied = uploadAuth(env, request);
  if(denied) return denied;
  if(!env.MEDIA) return fail('没有绑定素材存储', 503);

  const found = keyFromPath(params.key);
  if(!found) return fail('没有这个素材', 404);

  await env.MEDIA.delete(found.key);
  /* 顺手清掉边缘缓存，否则删完还能被缓存喂出来最多一年 */
  try{ await caches.default.delete(request); }catch(e){}

  return json({ ok: true, deleted: found.key });
}
