// 用真实 canvas 实现跑一遍在线版的渲染链路（这是唯一还没实测的部分）
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let canvasMod;
try {
  canvasMod = require('@napi-rs/canvas');
} catch (e) {
  console.error('[x] 缺依赖 @napi-rs/canvas。在 tests/ 目录装一下：');
  console.error('    npm install @napi-rs/canvas');
  process.exit(1);
}
const { createCanvas, DOMMatrix, ImageData, Path2D } = canvasMod;

// pdf.js 在 Node 环境需要这几个全局对象
globalThis.DOMMatrix = DOMMatrix;
globalThis.ImageData = ImageData;
globalThis.Path2D = Path2D;

const pdfjsLib = await import('../web/public/vendor/pdf.min.js');
const lib = pdfjsLib.default && pdfjsLib.default.getDocument ? pdfjsLib.default : pdfjsLib;
lib.GlobalWorkerOptions.workerSrc = new URL('../web/public/vendor/pdf.worker.min.js', import.meta.url).href;

const data = new Uint8Array(fs.readFileSync(process.env.TEST_PDF || 'A.pdf'));
const pdf = await lib.getDocument({
  data,
  isEvalSupported: false,
  standardFontDataUrl: process.env.FONT_BASE ||
    new URL('../web/public/vendor/standard_fonts/', import.meta.url).href
}).promise;

// 完全照搬 web/public/index.html 里的 renderPageToCanvas
async function renderPageToCanvas(pdf, pageNo, scale) {
  const page = await pdf.getPage(pageNo);
  const viewport = page.getViewport({ scale });
  const w = Math.floor(viewport.width), h = Math.floor(viewport.height);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, w, h };
}

// 统计非白像素，用来判断文字到底画出来没有
function inkRatio(canvas) {
  const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
  let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200) ink++;
  }
  return ink / (canvas.width * canvas.height);
}

const targets = [[1, 144]];
if (pdf.numPages >= 2) targets.push([2, 72]);

for (const [pageNo, dpi] of targets) {
  const scale = dpi / 72;
  const { canvas, w, h } = await renderPageToCanvas(pdf, pageNo, scale);
  const png = canvas.toBuffer('image/png');
  const jpg = canvas.toBuffer('image/jpeg', 92);
  fs.writeFileSync(`render_p${pageNo}_${dpi}dpi.png`, png);
  fs.writeFileSync(`render_p${pageNo}_${dpi}dpi.jpg`, jpg);
  const ink = (inkRatio(canvas) * 100).toFixed(2);
  console.log(`第 ${pageNo} 页 @${dpi}DPI -> ${w}x${h}  PNG ${png.length}B  JPEG ${jpg.length}B  墨迹占比 ${ink}%`);
}

pdf.destroy();
console.log('OK');
