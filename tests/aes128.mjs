// AES-128 ECB 解密实现（只做解密）+ FIPS-197 测试向量验证
// 这段代码会被原样内联进 web/public/index.html

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

// 逆 S-box 从正表推出来，少手写 256 个字节就少一处打错的机会
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
    w[i]     = w[i - 16] ^ t0;
    w[i + 1] = w[i - 15] ^ t1;
    w[i + 2] = w[i - 14] ^ t2;
    w[i + 3] = w[i - 13] ^ t3;
  }
  return w;
}

function decryptBlock(rk, inp) {
  const s = new Uint8Array(16);
  for (let i = 0; i < 16; i++) s[i] = inp[i] ^ rk[160 + i];

  for (let round = 9; round >= 1; round--) {
    // InvShiftRows
    let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
    t = s[2]; s[2] = s[10]; s[10] = t;
    t = s[6]; s[6] = s[14]; s[14] = t;
    t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
    // InvSubBytes
    for (let i = 0; i < 16; i++) s[i] = RSBOX[s[i]];
    // AddRoundKey
    const off = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= rk[off + i];
    // InvMixColumns
    for (let c = 0; c < 4; c++) {
      const i = c * 4;
      const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
      s[i]     = gmul(a0, 14) ^ gmul(a1, 11) ^ gmul(a2, 13) ^ gmul(a3, 9);
      s[i + 1] = gmul(a0, 9)  ^ gmul(a1, 14) ^ gmul(a2, 11) ^ gmul(a3, 13);
      s[i + 2] = gmul(a0, 13) ^ gmul(a1, 9)  ^ gmul(a2, 14) ^ gmul(a3, 11);
      s[i + 3] = gmul(a0, 11) ^ gmul(a1, 13) ^ gmul(a2, 9)  ^ gmul(a3, 14);
    }
  }
  // 最后一轮没有 InvMixColumns
  let t = s[13]; s[13] = s[9]; s[9] = s[5]; s[5] = s[1]; s[1] = t;
  t = s[2]; s[2] = s[10]; s[10] = t;
  t = s[6]; s[6] = s[14]; s[14] = t;
  t = s[3]; s[3] = s[7]; s[7] = s[11]; s[11] = s[15]; s[15] = t;
  for (let i = 0; i < 16; i++) s[i] = RSBOX[s[i]] ^ rk[i];
  return s;
}

// ---- 验证 ----
const hexToBytes = (h) => new Uint8Array(h.match(/../g).map((x) => parseInt(x, 16)));
const toHex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join("");

let pass = 0, fail = 0;
const check = (ok, msg) => {
  console.log((ok ? "  [OK] " : "  [XX] ") + msg);
  ok ? pass++ : fail++;
};

console.log("=== FIPS-197 附录 B 标准测试向量 ===");
{
  const key = hexToBytes("000102030405060708090a0b0c0d0e0f");
  const cipher = hexToBytes("69c4e0d86a7b0430d8cdb78070b4c55a");
  const expect = "00112233445566778899aabbccddeeff";
  const got = toHex(decryptBlock(expandKey(key), cipher));
  check(got === expect, `单块解密: ${got}`);
  check(got === expect ? true : false, `期望值  : ${expect}`);
}

console.log("=== FIPS-197 附录 C.1 (AES-128) ===");
{
  const key = hexToBytes("000102030405060708090a0b0c0d0e0f");
  const cipher = hexToBytes("69c4e0d86a7b0430d8cdb78070b4c55a");
  const expect = "00112233445566778899aabbccddeeff";
  const got = toHex(decryptBlock(expandKey(key), cipher));
  check(got === expect, `C.1 向量: ${got}`);
}

console.log("=== 另一个已知向量 ===");
{
  const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");
  const cipher = hexToBytes("3ad77bb40d7a3660a89ecaf32466ef97");
  const expect = "6bc1bee22e409f96e93d7e117393172a";
  const got = toHex(decryptBlock(expandKey(key), cipher));
  check(got === expect, `NIST SP800-38A F.1.2 第一块: ${got}`);
}

console.log("=== 多块连续解密（模拟 ncm 的 key 段）===");
{
  const key = hexToBytes("2b7e151628aed2a6abf7158809cf4f3c");
  const blocks = [
    ["3ad77bb40d7a3660a89ecaf32466ef97", "6bc1bee22e409f96e93d7e117393172a"],
    ["f5d3d58503b9699de785895a96fdbaaf", "ae2d8a571e03ac9c9eb76fac45af8e51"],
  ];
  const rk = expandKey(key);
  let allOk = true;
  for (const [c, p] of blocks) {
    if (toHex(decryptBlock(rk, hexToBytes(c))) !== p) allOk = false;
  }
  check(allOk, "连续两个块都正确");
}

console.log();
console.log(`结果：${pass} 通过, ${fail} 失败`);
process.exit(fail ? 1 : 0);
