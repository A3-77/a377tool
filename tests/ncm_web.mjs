// JS 版 ncm 解密（将要内联进 web/public/index.html 的完整实现）+ 与 Python 版交叉验证
import fs from 'node:fs';
import { createHash } from 'node:crypto';

// ============ AES-128 ECB 解密 ============
const SBOX = new Uint8Array([
  0x63,0x7c,0x77,0x7b,0xf2,0x6b,0x6f,0xc5,0x30,0x01,0x67,0x2b,0xfe,0xd7,0xab,0x76,
  0xca,0x82,0xc9,0x7d,0xfa,0x59,0x47,0xf0,0xad,0xd4,0xa2,0xaf,0x9c,0xa4,0x72,0xc0,
  0xb7,0xfd,0x93,0x26,0x36,0x3f,0xf7,0xcc,0x34,0xa5,0xe5,0xf1,0x71,0xd8,0x31,0x15,
  0x04,0xc7,0x23,0xc3,0x18,0x96,0x05,0x9a,0x07,0x12,0x80,0xe2,0xeb,0x27,0xb2,0x75,
  0x09,0x83,0x2c,0x1a,0x1b,0x6e,0x5a,0xa0,0x52,0x3b,0xd6,0xb3,0x29,0xe3,0x2f,0x84,
  0x53,0xd1,0x00,0xed,0x20,0xfc,0xb1,0x5b,0x6a,0xcb,0xbe,0x39,0x4a,0x4c,0x58,0xcf,
  0xd0,0xef,0xaa,0xfb,0x43,0x4d,0x33,0x85,0x45,0xf9,0x02,0x7f,0x50,0x3c,0x9f,0xa8,
  0x51,0xa3,0x40,0x8f,0x92,0x9d,0x38,0xf5,0xbc,0xb6,0xda,0x21,0x10,0xff,0xf3,0xd2,
  0xcd,0x0c,0x13,0xec,0x5f,0x97,0x44,0x17,0xc4,0xa7,0x7e,0x3d,0x64,0x5d,0x19,0x73,
  0x60,0x81,0x4f,0xdc,0x22,0x2a,0x90,0x88,0x46,0xee,0xb8,0x14,0xde,0x5e,0x0b,0xdb,
  0xe0,0x32,0x3a,0x0a,0x49,0x06,0x24,0x5c,0xc2,0xd3,0xac,0x62,0x91,0x95,0xe4,0x79,
  0xe7,0xc8,0x37,0x6d,0x8d,0xd5,0x4e,0xa9,0x6c,0x56,0xf4,0xea,0x65,0x7a,0xae,0x08,
  0xba,0x78,0x25,0x2e,0x1c,0xa6,0xb4,0xc6,0xe8,0xdd,0x74,0x1f,0x4b,0xbd,0x8b,0x8a,
  0x70,0x3e,0xb5,0x66,0x48,0x03,0xf6,0x0e,0x61,0x35,0x57,0xb9,0x86,0xc1,0x1d,0x9e,
  0xe1,0xf8,0x98,0x11,0x69,0xd9,0x8e,0x94,0x9b,0x1e,0x87,0xe9,0xce,0x55,0x28,0xdf,
  0x8c,0xa1,0x89,0x0d,0xbf,0xe6,0x42,0x68,0x41,0x99,0x2d,0x0f,0xb0,0x54,0xbb,0x16,
]);
const RSBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) RSBOX[SBOX[i]] = i;

function gmul(a, b) {
  let p = 0;
  for (let i = 0; i < 8; i++) {
    if (b & 1) p ^= a;
    const hi = a & 0x80;
    a = (a << 1) & 0xff;
    if (hi) a ^= 0x1b;
    b >>= 1;
  }
  return p;
}

function expandKey(key) {
  const w = new Uint8Array(176);
  w.set(key, 0);
  let rcon = 1;
  for (let i = 16; i < 176; i += 4) {
    let t0 = w[i - 4], t1 = w[i - 3], t2 = w[i - 2], t3 = w[i - 1];
    if (i % 16 === 0) {
      const tmp = t0;
      t0 = SBOX[t1] ^ rcon;
      t1 = SBOX[t2];
      t2 = SBOX[t3];
      t3 = SBOX[tmp];
      rcon = gmul(rcon, 2);
    }
    w[i] = w[i - 16] ^ t0; w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2; w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

function decryptBlock(rk, inp) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = inp[i] ^ rk[160 + i];
  for (let round = 9; round >= 1; round--) {
    let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
    t = s[2]; s[2] = s[10]; s[10] = t;
    t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
    for (let i = 0; i < 16; i++) s[i] = RSBOX[s[i]];
    const off = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= rk[off + i];
    for (let c = 0; c < 4; c++) {
      const i = c * 4;
      const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
      s[i]     = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
      s[i + 1] = gmul(a0, 9)  ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
      s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9)  ^ gmul(a2, 14) ^ gmul(a3, 11);
      s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9)  ^ gmul(a3, 14);
    }
  }
  let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
  t = s[2]; s[2] = s[10]; s[10] = t;
  t = s[6]; s[6] = s[14]; s[14] = t;
  t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
  for (let i = 0; i < 16; i++) s[i] = RSBOX[s[i]] ^ rk[i];
  return s;
}

function aesEcbDecrypt(key, data) {
  const usable = data.length - (data.length % 16);
  if (usable === 0) return new Uint8Array(0);
  const rk = expandKey(key);
  const out = new Uint8Array(usable);
  for (let off = 0; off < usable; off += 16) {
    out.set(decryptBlock(rk, data.subarray(off, off + 16)), off);
  }
  let pad = out[usable - 1];
  if (pad > 16) pad = 0;
  return out.subarray(0, usable - pad);
}

// ============ ncm ============
const CORE_KEY = new Uint8Array([0x68,0x7A,0x48,0x52,0x41,0x6D,0x73,0x6F,0x35,0x6B,0x49,0x6E,0x62,0x61,0x78,0x57]);
const MODIFY_KEY = new Uint8Array([0x23,0x31,0x34,0x6C,0x6A,0x6B,0x5F,0x21,0x5C,0x5D,0x26,0x30,0x55,0x3C,0x27,0x28]);

function buildKeybox(key) {
  const box = new Uint8Array(256);
  for (let i = 0; i < 256; i++) box[i] = i;
  let last = 0, koff = 0;
  for (let i = 0; i < 256; i++) {
    const swap = box[i];
    const c = (swap + last + key[koff]) & 0xff;
    koff++;
    if (koff >= key.length) koff = 0;
    box[i] = box[c];
    box[c] = swap;
    last = c;
  }
  return box;
}

function keystream(box) {
  const ks = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    const j = (i + 1) & 0xff;
    const a = box[j];
    const b = (a + j) & 0xff;
    const c = box[b];
    const d = (a + c) & 0xff;
    ks[i] = box[d];
  }
  return ks;
}

function decryptAudio(data, box) {
  const ks = keystream(box);
  const n = data.length;
  const out = new Uint8Array(n);
  // 密钥流每 256 字节循环，打包成 64 个 32 位字，一次异或 4 字节
  const ks32 = new Uint32Array(64);
  for (let k = 0; k < 64; k++) {
    ks32[k] = (ks[k * 4] | (ks[k * 4 + 1] << 8) | (ks[k * 4 + 2] << 16) | (ks[k * 4 + 3] << 24)) >>> 0;
  }
  const full = n - (n % 4);
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < full; i += 4) {
    ov.setUint32(i, (dv.getUint32(i, true) ^ ks32[(i >> 2) & 63]) >>> 0, true);
  }
  for (let i = full; i < n; i++) out[i] = data[i] ^ ks[i & 0xff];
  return out;
}

const xorInPlace = (arr, v) => {
  const out = new Uint8Array(arr.length);
  for (let i = 0; i < arr.length; i++) out[i] = arr[i] ^ v;
  return out;
};

function parseMeta(raw) {
  try {
    const body = raw.subarray(22);
    let bin = '';
    for (let i = 0; i < body.length; i++) bin += String.fromCharCode(body[i]);
    const decoded = atob(bin);
    const bytes = new Uint8Array(decoded.length);
    for (let i = 0; i < decoded.length; i++) bytes[i] = decoded.charCodeAt(i);
    const plain = aesEcbDecrypt(MODIFY_KEY, bytes);
    const text = new TextDecoder().decode(plain.subarray(6));
    return JSON.parse(text);
  } catch (e) {
    return {};
  }
}

function decryptNcm(data) {
  if (data.length < 16) throw new Error('文件太小，不是 ncm');
  let magic = '';
  for (let i = 0; i < 8; i++) magic += String.fromCharCode(data[i]);
  if (magic !== 'CTENFDAM') throw new Error('这不是 ncm 文件（文件头不是 CTENFDAM）');

  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 10;

  const keyLen = dv.getUint32(pos, true); pos += 4;
  if (keyLen <= 0 || pos + keyLen > data.length) throw new Error('ncm 文件已损坏（key 段异常）');
  const keyPlain = aesEcbDecrypt(CORE_KEY, xorInPlace(data.subarray(pos, pos + keyLen), 0x64));
  pos += keyLen;
  if (keyPlain.length <= 17) throw new Error('ncm 文件已损坏（密钥段太短）');
  const box = buildKeybox(keyPlain.subarray(17));

  const metaLen = dv.getUint32(pos, true); pos += 4;
  let meta = {};
  if (metaLen > 0) {
    if (pos + metaLen > data.length) throw new Error('ncm 文件已损坏（元数据段异常）');
    meta = parseMeta(xorInPlace(data.subarray(pos, pos + metaLen), 0x63));
    pos += metaLen;
  }

  pos += 5;
  const coverFrameLen = dv.getUint32(pos, true); pos += 4;
  const coverLen = dv.getUint32(pos, true); pos += 4;
  let cover = new Uint8Array(0);
  if (coverLen > 0) cover = data.subarray(pos, pos + coverLen);
  pos += coverLen;
  const extra = coverFrameLen - coverLen;
  if (extra > 0) pos += extra;

  if (pos >= data.length) throw new Error('ncm 里没有音频数据');
  const audio = decryptAudio(data.subarray(pos), box);
  if (!audio.length) throw new Error('解密后没有音频数据');

  let ext;
  if (audio[0] === 0x66 && audio[1] === 0x4c && audio[2] === 0x61 && audio[3] === 0x43) ext = 'flac';
  else if (audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) ext = 'mp3';
  else {
    const g = String(meta.format || '').toLowerCase();
    ext = (g === 'mp3' || g === 'flac') ? g : 'mp3';
  }

  const artists = [];
  for (const item of (meta.artist || [])) {
    if (Array.isArray(item) && item.length) artists.push(String(item[0]));
    else if (typeof item === 'string') artists.push(item);
  }
  const title = String(meta.musicName || '');
  const artist = artists.join('/');
  const album = String(meta.album || '');
  const coverMime = (cover[0] === 0x89 && cover[1] === 0x50) ? 'image/png' : 'image/jpeg';
  const stem = [artist, title].filter(Boolean).join(' - ') || title || 'output';
  const safe = stem.replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 120) || 'output';

  return { audio, ext, title, artist, album, cover, coverMime, meta, outName: safe + '.' + ext };
}

// ============ 验证 ============
let pass = 0, fail = 0;
const check = (ok, msg) => { console.log((ok ? '  [OK] ' : '  [XX] ') + msg); ok ? pass++ : fail++; };

const sha = (b) => createHash('sha256').update(Buffer.from(b)).digest('hex').slice(0, 16);

console.log('=== JS 解密 Python 生成的 ncm 样本 ===');
const raw = new Uint8Array(fs.readFileSync('sample.ncm'));
const original = new Uint8Array(fs.readFileSync('test.mp3'));
const cover = new Uint8Array(fs.readFileSync('sample_cover.png'));

const r = decryptNcm(raw);
check(r.audio.length === original.length, `音频长度 ${r.audio.length} == ${original.length}`);
check(sha(r.audio) === sha(original), `音频 SHA256 一致（${sha(r.audio)}）`);
check(r.ext === 'mp3', `格式判定 = ${r.ext}`);
check(r.title === 'JS 解密测试', `歌名 = ${r.title}`);
check(r.artist === '测试歌手/第二歌手', `歌手 = ${r.artist}`);
check(r.album === '测试专辑', `专辑 = ${r.album}`);
check(r.cover.length === cover.length && sha(r.cover) === sha(cover), `封面一致（${r.cover.length} 字节）`);
check(r.coverMime === 'image/png', `封面类型 = ${r.coverMime}`);
check(r.outName === '测试歌手_第二歌手 - JS 解密测试.mp3', `输出名 = ${r.outName}`);

console.log('=== 坏文件处理 ===');
for (const [name, blob] of [
  ['非 ncm 文件', new Uint8Array(200).fill(65)],
  ['只有文件头', new Uint8Array([...'CTENFDAM'].map(c => c.charCodeAt(0)))],
]) {
  try { decryptNcm(blob); check(false, `${name}：应该报错但没有`); }
  catch (e) { check(true, `${name}：正确报错「${e.message}」`); }
}

console.log();
console.log(`结果：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
