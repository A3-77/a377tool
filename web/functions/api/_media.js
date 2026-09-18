/* =========================================================================
   展示组件的素材存储（图片 / 视频上传）
   ---------------------------------------------------------------------------
   为什么是 KV 而不是 R2：
     R2 免费额度更大（10GB / 无出口费），但**激活必须绑付款方式**；
     KV 免费额度是 1GB 总量、单值 25MiB、每天 1000 次写，不要付款方式。
     这个站要放的就是几十张图和几秒的短视频，KV 绰绰有余，且零门槛。
   代价：
     - KV 单值上限 25MiB（所以下面有 MAX_VIDEO 卡在 20MiB）
     - 写入是全球最终一致（最长 60s）。上传后立刻读**新 key** 不受影响，
       但「覆盖同一个 key」的语义不能依赖 —— 所以文件名里带随机段，
       换图 = 换 key，顺便让 Cache-Control: immutable 站得住。
   ========================================================================= */
import { fail } from './_lib.js';

/* 白名单。**不按扩展名放行** —— 扩展名是上传方随便写的，
   浏览器真正用来解释这个文件的是 Content-Type，
   所以这里存的是「允许的 Content-Type → 落盘扩展名」。 */
export const ALLOWED = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif':  'gif',
  'video/mp4':  'mp4',
  'video/webm': 'webm',
};

/* 落盘扩展名 → 回给浏览器时的 Content-Type（和上面反向对应） */
export const MIME = {
  jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp',
  avif: 'image/avif', gif: 'image/gif', mp4: 'video/mp4', webm: 'video/webm',
};

/* 单文件上限。KV 单值 25MiB，留出余量。
   注意这两个数是「上传这道门」，不是「推荐规格」——
   推荐体积（图片 ≤800KB、视频 ≤1.5MB）写在后台面板的规格块里，
   超了只提示不拦。拦在 10/20MB 是防呆（免得拖进来一个 200MB 的 4K 视频
   卡住整个上传），不是防懒。 */
export const MAX_IMAGE = 10 * 1024 * 1024;
export const MAX_VIDEO = 20 * 1024 * 1024;

/* 一次最多传几个。多选上传时会逐个压图，太多会卡住主线程 */
export const MAX_FILES = 30;

export function kindOf(ext){
  return ext === 'mp4' || ext === 'webm' ? 'video' : 'image';
}

export function extOf(type, name){
  const ct = String(type || '').toLowerCase().split(';')[0].trim();
  if(ALLOWED[ct]) return ALLOWED[ct];

  /* 兜底：有些浏览器给 .mov 报 video/quicktime、给 avif 报空 Content-Type。
     只在白名单内兜，不放行任意后缀 —— 否则「上传 a.php」就进来了。 */
  const m = /\.([a-z0-9]+)$/i.exec(String(name || ''));
  const e = m ? m[1].toLowerCase() : '';
  if(e === 'jpeg') return 'jpg';
  return Object.prototype.hasOwnProperty.call(MIME, e) ? e : '';
}

/* 随机 key。日期前缀是为了在 KV 控制台里按时间翻起来方便；
   随机段用 crypto 而不是 Math.random —— 别让人猜出别人的文件名
   （虽然 key 不泄密，但猜得到的 URL 意味着「没公开但能被扫到」）。 */
export function newKey(ext){
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const rnd = Array.from(buf, b => b.toString(16).padStart(2, '0')).join('');
  return `m/${stamp}-${rnd}.${ext}`;
}

/* 从路径里取 key：/api/media/m/20260918-ab12.jpg → m/20260918-ab12.jpg
   注意 [[key]] 捕获到的是**数组**（["m","20260918-ab12.jpg"]），不是字符串 ——
   直接当字符串用会得到 "m,20260918-ab12.jpg"，读回来永远是 404（踩过）。
   也注意不要再拼一次 m/ 前缀：捕获的已经含它了。
   返回 null 表示这不是一条合法的素材路径。 */
export function keyFromPath(rest){
  const raw = Array.isArray(rest) ? rest.join('/') : String(rest || '');
  /* 只认 m/ 开头：上传写的都落在这个前缀下，
     顺带挡住「拿 /api/media/<任意路径> 去探 KV 里别的东西」 */
  if(raw.slice(0, 2) !== 'm/') return null;
  /* KV 的 key 是扁平字符串，本来没有目录概念，但别让 m/../../x.png
     这种形状的 key 被构造出来 */
  if(raw.indexOf('..') >= 0) return null;
  const m = /\.([a-z0-9]+)$/i.exec(raw);
  if(!m) return null;
  const e = m[1].toLowerCase();
  if(!Object.prototype.hasOwnProperty.call(MIME, e)) return null;
  return { key: raw, ext: e };
}

/* 鉴权：和两个后台共用 ADMIN_TOKEN。上传走 query 传 key（multipart 的 body
   里塞口令要先解析完整个文件流，没必要）。 */
export function uploadAuth(env, request){
  if(!env.ADMIN_TOKEN) return fail('未配置管理口令（ADMIN_TOKEN）', 503);
  const key = new URL(request.url).searchParams.get('key') || '';
  /* 这里不做定长比较：口令长度本身不算秘密，而 multipart 的 body 还没读，
     提前 return 省下一次大文件解析。真正的暴力破解在 Cloudflare 层就被限速了。 */
  if(key !== env.ADMIN_TOKEN) return fail('口令不对', 401);
  return null;
}

export function humanSize(n){
  if(n < 1024) return n + ' B';
  if(n < 1024 * 1024) return (n / 1024).toFixed(0) + ' KB';
  return (n / 1024 / 1024).toFixed(1) + ' MB';
}
