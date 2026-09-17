# -*- coding: utf-8 -*-
"""
网易云音乐 ncm 解密。

算法实现参考 taurusxin/ncmdump（MIT License）的 src/ncmcrypt.cpp。
文件结构（顺序）：
    "CTENFDAM" | 2 字节保留 | key 段 | meta 段 | CRC32(4)+版本(1) | 封面段 | 音频流
所有多字节整数都是小端。
"""
from __future__ import annotations

import base64
import json
import os
import re
import struct
from dataclasses import dataclass, field

from Crypto.Cipher import AES

MAGIC = b"CTENFDAM"

# ncmdump 里 sCoreKey / sModifyKey，各 16 字节（源码里是 17 字节含结尾 \0）
CORE_KEY = bytes([
    0x68, 0x7A, 0x48, 0x52, 0x41, 0x6D, 0x73, 0x6F,
    0x35, 0x6B, 0x49, 0x6E, 0x62, 0x61, 0x78, 0x57,
])
MODIFY_KEY = bytes([
    0x23, 0x31, 0x34, 0x6C, 0x6A, 0x6B, 0x5F, 0x21,
    0x5C, 0x5D, 0x26, 0x30, 0x55, 0x3C, 0x27, 0x28,
])

KEY_XOR = 0x64
META_XOR = 0x63
KEY_PREFIX = b"neteasecloudmusic"      # 17 字节
META_PREFIX = b"163 key(Don't modify):"  # 22 字节
MUSIC_PREFIX = b"music:"                # 6 字节

CHUNK = 1 << 20  # 1 MB，必须是 256 的整数倍（见 _keystream 的周期性）


# --------------------------------------------------------------------------- #
# 基础密码学
# --------------------------------------------------------------------------- #
def _aes_ecb_decrypt(key: bytes, data: bytes) -> bytes:
    """AES-128-ECB 解密并按末字节去填充，等价于 ncmdump 的 aesEcbDecrypt。"""
    usable = len(data) - (len(data) % 16)
    if usable == 0:
        return b""
    plain = AES.new(key, AES.MODE_ECB).decrypt(data[:usable])
    pad = plain[-1]
    if pad > 16:      # 源码里的保护：异常填充值当 0 处理
        pad = 0
    return plain[: len(plain) - pad]


def _build_keybox(key: bytes) -> bytes:
    """RC4 KSA，等价于 ncmdump 的 buildKeyBox。"""
    box = bytearray(range(256))
    last = 0
    koff = 0
    klen = len(key)
    if klen == 0:
        raise ValueError("ncm 文件已损坏（密钥为空）")
    for i in range(256):
        swap = box[i]
        c = (swap + last + key[koff]) & 0xFF
        koff += 1
        if koff >= klen:
            koff = 0
        box[i] = box[c]
        box[c] = swap
        last = c
    return bytes(box)


def _keystream(box: bytes) -> bytes:
    """返回 256 字节密钥流，第 i 个音频字节异或 ks[i % 256]。

    源码用的是 (i + 1)，所以这里必须跟着偏移一位：
        int j = (i + 1) & 0xff;
        buffer[i] ^= mKeyBox[(mKeyBox[j] + mKeyBox[(mKeyBox[j] + j) & 0xff]) & 0xff];
    """
    ks = bytearray(256)
    for i in range(256):
        j = (i + 1) & 0xFF
        a = box[j]
        b = (a + j) & 0xFF
        c = box[b]
        d = (a + c) & 0xFF
        ks[i] = box[d]
    return bytes(ks)


def _decrypt_audio(data: bytes, box: bytes) -> bytes:
    """按 256 周期异或密钥流。用大整数异或走 C 层，比逐字节循环快两个数量级。"""
    n = len(data)
    if n == 0:
        return b""
    ks = _keystream(box)
    out = bytearray()
    for off in range(0, n, CHUNK):
        chunk = data[off:off + CHUNK]
        m = len(chunk)
        full = ks * (m // 256) + ks[: m % 256]
        out += (int.from_bytes(chunk, "big") ^ int.from_bytes(full, "big")).to_bytes(m, "big")
    return bytes(out)


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
@dataclass
class NcmResult:
    audio: bytes
    ext: str
    title: str = ""
    artist: str = ""
    album: str = ""
    cover: bytes = b""
    cover_mime: str = "image/jpeg"
    meta: dict = field(default_factory=dict)

    @property
    def out_name(self) -> str:
        """输出文件名，优先「歌手 - 歌名」。"""
        stem = " - ".join(p for p in (self.artist, self.title) if p) or self.title or "output"
        return sanitize(stem) + "." + self.ext


def sanitize(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", name).strip(" .")
    return name[:120] or "output"


def _parse_meta(raw: bytes) -> dict:
    """解析 meta 段。失败不致命——音频照样能解出来。"""
    try:
        body = raw[len(META_PREFIX):]
        plain = _aes_ecb_decrypt(MODIFY_KEY, base64.b64decode(body))
        if not plain.startswith(MUSIC_PREFIX):
            return {}
        return json.loads(plain[len(MUSIC_PREFIX):].decode("utf-8"))
    except Exception:  # noqa: BLE001
        return {}


def _meta_fields(meta: dict) -> tuple[str, str, str]:
    title = str(meta.get("musicName") or "")
    album = str(meta.get("album") or "")
    artists = []
    for item in meta.get("artist") or []:
        # 形如 [["歌手名", id], ...]
        if isinstance(item, (list, tuple)) and item:
            artists.append(str(item[0]))
        elif isinstance(item, str):
            artists.append(item)
    return title, "/".join(artists), album


def decrypt(data: bytes) -> NcmResult:
    if len(data) < 16 or data[:8] != MAGIC:
        raise ValueError("这不是 ncm 文件（文件头不是 CTENFDAM）")

    pos = 10  # 跳过 8 字节 magic + 2 字节保留

    # ---- key 段：解出 RC4 密钥盒 ----
    if pos + 4 > len(data):
        raise ValueError("ncm 文件已损坏（读不到 key 段长度）")
    (key_len,) = struct.unpack_from("<I", data, pos)
    pos += 4
    if key_len <= 0 or pos + key_len > len(data):
        raise ValueError("ncm 文件已损坏（key 段长度异常）")

    key_raw = bytearray(data[pos:pos + key_len])
    pos += key_len
    for i in range(len(key_raw)):
        key_raw[i] ^= KEY_XOR

    key_plain = _aes_ecb_decrypt(CORE_KEY, bytes(key_raw))
    if len(key_plain) <= len(KEY_PREFIX):
        raise ValueError("ncm 文件已损坏（密钥段太短，可能是下载不完整）")
    box = _build_keybox(key_plain[len(KEY_PREFIX):])

    # ---- meta 段 ----
    if pos + 4 > len(data):
        raise ValueError("ncm 文件已损坏（读不到元数据段长度）")
    (meta_len,) = struct.unpack_from("<I", data, pos)
    pos += 4
    meta = {}
    if meta_len > 0:
        if pos + meta_len > len(data):
            raise ValueError("ncm 文件已损坏（元数据段长度异常）")
        meta_raw = bytearray(data[pos:pos + meta_len])
        pos += meta_len
        for i in range(len(meta_raw)):
            meta_raw[i] ^= META_XOR
        meta = _parse_meta(bytes(meta_raw))

    # ---- 跳过 CRC32(4) + 版本(1) ----
    pos += 5
    if pos + 8 > len(data):
        raise ValueError("ncm 文件已损坏（读不到封面段）")
    (cover_frame_len,) = struct.unpack_from("<I", data, pos)
    pos += 4
    (cover_len,) = struct.unpack_from("<I", data, pos)
    pos += 4

    cover = b""
    if cover_len > 0:
        cover = data[pos:pos + cover_len]
    pos += cover_len
    extra = cover_frame_len - cover_len
    if extra > 0:
        pos += extra

    if pos >= len(data):
        raise ValueError("ncm 文件里没有音频数据（可能只下载了封面）")

    audio = _decrypt_audio(data[pos:], box)
    if not audio:
        raise ValueError("解密后没有音频数据")

    # ---- 判断真实格式 ----
    if audio[:4] == b"fLaC":
        ext = "flac"
    elif audio[:3] == b"ID3" or audio[:2] in (b"\xff\xfb", b"\xff\xf3", b"\xff\xf2"):
        ext = "mp3"
    else:
        guess = str(meta.get("format") or "").strip().lower()
        ext = guess if guess in ("mp3", "flac") else "mp3"

    title, artist, album = _meta_fields(meta)
    cover_mime = "image/png" if cover[:8] == b"\x89PNG\r\n\x1a\n" else "image/jpeg"

    return NcmResult(
        audio=audio, ext=ext, title=title, artist=artist, album=album,
        cover=cover, cover_mime=cover_mime, meta=meta,
    )


# --------------------------------------------------------------------------- #
# 写标签（让转出来的文件在播放器里有歌名、歌手、封面）
# --------------------------------------------------------------------------- #
def write_tags(path: str, result: NcmResult) -> str | None:
    """写入标签，成功返回 None，失败返回错误说明（不影响音频本身）。"""
    try:
        if result.ext == "mp3":
            from mutagen.id3 import APIC, ID3, ID3NoHeaderError, TALB, TPE1, TIT2

            try:
                tags = ID3(path)
            except ID3NoHeaderError:
                tags = ID3()
            if result.title:
                tags.add(TIT2(encoding=3, text=result.title))
            if result.artist:
                tags.add(TPE1(encoding=3, text=result.artist))
            if result.album:
                tags.add(TALB(encoding=3, text=result.album))
            if result.cover:
                tags.add(APIC(encoding=3, mime=result.cover_mime, type=3,
                              desc="Cover", data=result.cover))
            tags.save(path, v2_version=3)

        elif result.ext == "flac":
            from mutagen.flac import FLAC, Picture

            audio = FLAC(path)
            if result.title:
                audio["title"] = result.title
            if result.artist:
                audio["artist"] = result.artist
            if result.album:
                audio["album"] = result.album
            if result.cover:
                pic = Picture()
                pic.type = 3
                pic.mime = result.cover_mime
                pic.desc = "Cover"
                pic.data = result.cover
                audio.add_picture(pic)
            audio.save()
        return None
    except Exception as exc:  # noqa: BLE001
        return f"{type(exc).__name__}: {exc}"
