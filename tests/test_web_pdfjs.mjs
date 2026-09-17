// 验证在线版用的 pdf.js API 是否真的能解析 PDF（渲染需要 DOM，这里只验证解析链路）
import fs from 'node:fs';

let pdfjsLib;
try {
  pdfjsLib = await import('../web/public/vendor/pdf.min.js');
} catch (e) {
  console.log('直接 import 失败:', e.message);
  console.log('改试 legacy 版...');
  pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
}

const lib = pdfjsLib.default && pdfjsLib.default.getDocument ? pdfjsLib.default : pdfjsLib;
console.log('pdf.js 版本:', lib.version);
console.log('有 getDocument:', typeof lib.getDocument === 'function');
console.log('有 GlobalWorkerOptions:', !!lib.GlobalWorkerOptions);

const data = new Uint8Array(fs.readFileSync('A.pdf'));

// Node 里没有 worker 环境，用 fake worker 走主线程；浏览器里是真 worker
if (lib.GlobalWorkerOptions) {
  lib.GlobalWorkerOptions.workerSrc = new URL('../web/public/vendor/pdf.worker.min.js', import.meta.url).href;
}

const pdf = await lib.getDocument({ data, isEvalSupported: false, useWorkerFetch: false }).promise;
console.log('页数:', pdf.numPages);

const page = await pdf.getPage(1);
const vp72 = page.getViewport({ scale: 1 });
const vp2 = page.getViewport({ scale: 2 });
console.log('第 1 页尺寸(scale=1):', Math.round(vp72.width), 'x', Math.round(vp72.height));
console.log('第 1 页尺寸(scale=2):', Math.round(vp2.width), 'x', Math.round(vp2.height));

const text = await page.getTextContent();
console.log('第 1 页文字:', text.items.map((i) => i.str).join('').trim());

console.log('destroy:', typeof pdf.destroy === 'function', '| page.cleanup:', typeof page.cleanup === 'function');
console.log('OK');
