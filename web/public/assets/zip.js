/* =========================================================================
   A377Tool · 纯前端 ZIP 打包（STORE 不压缩）
   用法：
     import { makeZipBlob, makeZip } from "/assets/zip.js";
     const blob = await makeZipBlob([{ name: "a.png", blob }, ...]);

   为什么是 STORE：图片/音频本身已经压过，再压基本没有收益，反而慢。
   ========================================================================= */

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

/* entries: [{ name: string, data: Uint8Array }] -> Uint8Array */
export function makeZip(entries) {
  const enc = new TextEncoder();
  const chunks = [], central = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const size = data.length;

    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);   // 本地文件头
    lv.setUint16(4, 20, true);           // 解压所需版本
    lv.setUint16(6, 0x0800, true);       // 文件名 UTF-8
    lv.setUint16(8, 0, true);            // STORE
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    chunks.push(local, data);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(cd.buffer);
    cv.setUint32(0, 0x02014b50, true);   // 中央目录
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
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
  ev.setUint32(0, 0x06054b50, true);     // 中央目录结束记录
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, cdSize, true);
  ev.setUint32(16, offset, true);

  const all = chunks.concat(central, [end]);
  const total = all.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of all) { out.set(c, p); p += c.length; }
  return out;
}

/* entries: [{ name: string, blob: Blob }] -> Promise<Blob> */
export async function makeZipBlob(entries) {
  const used = new Set();
  const prepared = [];
  for (const e of entries) {
    let name = String(e.name || "file").split(/[\\/]/).pop() || "file";
    if (used.has(name)) {
      const dot = name.lastIndexOf(".");
      const stem = dot > 0 ? name.slice(0, dot) : name;
      const ext = dot > 0 ? name.slice(dot) : "";
      let k = 2;
      while (used.has(stem + "(" + k + ")" + ext)) k++;
      name = stem + "(" + k + ")" + ext;
    }
    used.add(name);
    prepared.push({ name, data: new Uint8Array(await e.blob.arrayBuffer()) });
  }
  return new Blob([makeZip(prepared)], { type: "application/zip" });
}
