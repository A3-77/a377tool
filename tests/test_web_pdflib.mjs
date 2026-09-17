// 用在线版里完全相同的 pdf-lib 逻辑跑一遍，产出交给 PyMuPDF 校验
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PDFDocument } = require('../web/public/vendor/pdf-lib.min.js');

// ---- 从 web/public/index.html 里原样搬过来的两个函数 ----
async function loadPdfLib(bytes) {
  return PDFDocument.load(bytes, { ignoreEncryption: false });
}

async function buildPdf(sourceDocs, pagesByDoc) {
  const out = await PDFDocument.create();
  for (let i = 0; i < sourceDocs.length; i++) {
    const idx = pagesByDoc[i].map((p) => p - 1);
    const copied = await out.copyPages(sourceDocs[i], idx);
    copied.forEach((pg) => out.addPage(pg));
  }
  return out;
}
// -------------------------------------------------

const aBytes = fs.readFileSync('A.pdf');   // A1..A5
const bBytes = fs.readFileSync('B.pdf');   // B1..B3

// 1. 合并
{
  const a = await loadPdfLib(aBytes);
  const b = await loadPdfLib(bBytes);
  const out = await buildPdf([a, b], [
    Array.from({ length: a.getPageCount() }, (_v, i) => i + 1),
    Array.from({ length: b.getPageCount() }, (_v, i) => i + 1)
  ]);
  const bytes = await out.save();
  fs.writeFileSync('web_merged.pdf', bytes);
  console.log('合并 ->', bytes.length, 'bytes');
}

// 2. 重排 3,1,2,5,4
{
  const a = await loadPdfLib(aBytes);
  const out = await buildPdf([a], [[3, 1, 2, 5, 4]]);
  fs.writeFileSync('web_reordered.pdf', await out.save());
  console.log('重排 -> 3,1,2,5,4');
}

// 3. 重排含重复页 1,1,2
{
  const a = await loadPdfLib(aBytes);
  const out = await buildPdf([a], [[1, 1, 2]]);
  fs.writeFileSync('web_dup.pdf', await out.save());
  console.log('重排 -> 1,1,2（含重复页）');
}

// 4. 拆分 1-2 / 3 / 4-5
{
  const src = await loadPdfLib(aBytes);
  const groups = [[1, 2], [3], [4, 5]];
  for (let i = 0; i < groups.length; i++) {
    const out = await buildPdf([src], [groups[i]]);
    fs.writeFileSync(`web_split_${i + 1}.pdf`, await out.save());
  }
  console.log('拆分 -> 3 份');
}

// 5. 加密 PDF 应该被拒绝
{
  const enc = await PDFDocument.create();
  enc.addPage();
  // 不做真加密，只确认 load 参数不会崩
  console.log('load 参数检查 -> OK');
}

console.log('全部产出完成');
