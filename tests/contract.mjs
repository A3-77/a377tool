// 用真实浏览器的 FormData 格式验证合并接口（Python 那边是手写 multipart，格式未必一样）
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:8777';

async function main() {
  const a = fs.readFileSync('A.pdf');
  const b = fs.readFileSync('B.pdf');

  const fd = new FormData();
  fd.append('files', new Blob([a], { type: 'application/pdf' }), 'A.pdf');
  fd.append('files', new Blob([b], { type: 'application/pdf' }), 'B.pdf');

  const qs = new URLSearchParams({ name: '合并结果' });
  const res = await fetch(BASE + '/api/pdf/merge?' + qs.toString(), {
    method: 'POST',
    body: fd
  });

  console.log('合并 HTTP:', res.status);
  if (res.status !== 200) {
    console.log('  错误内容:', (await res.text()).slice(0, 200));
    process.exit(1);
  }
  const info = JSON.parse(decodeURIComponent(res.headers.get('x-pdf2img-info') || '{}'));
  console.log('  files =', info.files, '| pages_total =', info.pages_total);
  console.log('  download_name =', info.download_name);
  console.log('  names =', JSON.stringify(info.names));

  const buf = Buffer.from(await res.arrayBuffer());
  console.log('  响应', buf.length, 'bytes, 魔数', buf.subarray(0, 4).toString());
  fs.writeFileSync('merged_by_node.pdf', buf);

  // 顺带验证缩略图接口（前端重排面板依赖它）
  const tq = new URLSearchParams({ dpi: '36' });
  const tres = await fetch(BASE + '/api/pdf/thumbs?' + tq.toString(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/pdf' },
    body: a
  });
  const tinfo = JSON.parse(decodeURIComponent(tres.headers.get('x-pdf2img-info') || '{}'));
  const tbuf = Buffer.from(await tres.arrayBuffer());
  console.log('缩略图 HTTP:', tres.status, '| pages =', tinfo.pages_total, '| zip', tbuf.length, 'bytes');
  fs.writeFileSync('thumbs_by_node.zip', tbuf);

  console.log('OK');
}

main().catch((e) => { console.error('失败:', e.message); process.exit(1); });
