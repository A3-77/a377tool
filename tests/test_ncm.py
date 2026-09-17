# -*- coding: utf-8 -*-
"""
ncm 解密验证。

思路：按 ncmdump 的算法**反向**写一个加密器，把真实 mp3/flac 打包成 ncm，
再用交付的 ncm.py 解开，逐字节比对。这样能验证字节偏移、XOR、padding、
RC4 keybox、密钥流周期等全部环节。

另外用一份朴素逐字节实现（完全照抄 ncmdump 的循环）对照优化版，
确保大整数异或的加速没有改变语义。
"""
import base64
import json
import os
import struct
import sys

import pymupdf
from Crypto.Cipher import AES
from Crypto.Util.Padding import pad

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pdf2img"))
import ncm  # noqa: E402

PASS = FAIL = 0


def check(ok, msg):
    global PASS, FAIL
    print(("  [OK] " if ok else "  [XX] ") + msg)
    if ok:
        PASS += 1
    else:
        FAIL += 1


# --------------------------------------------------------------------------- #
# 反向加密器：造 ncm 测试样本
# --------------------------------------------------------------------------- #
def build_ncm(audio: bytes, meta: dict, cover: bytes, rc4_key: bytes) -> bytes:
    key_plain = ncm.KEY_PREFIX + rc4_key
    key_enc = AES.new(ncm.CORE_KEY, AES.MODE_ECB).encrypt(pad(key_plain, 16))
    key_raw = bytes(b ^ ncm.KEY_XOR for b in key_enc)

    meta_plain = ncm.MUSIC_PREFIX + json.dumps(meta, ensure_ascii=False).encode("utf-8")
    meta_enc = AES.new(ncm.MODIFY_KEY, AES.MODE_ECB).encrypt(pad(meta_plain, 16))
    meta_raw = bytes(
        b ^ ncm.META_XOR for b in (ncm.META_PREFIX + base64.b64encode(meta_enc))
    )

    box = ncm._build_keybox(rc4_key)
    audio_enc = ncm._decrypt_audio(audio, box)  # 异或对称，同一函数即可

    out = ncm.MAGIC + b"\x00\x00"
    out += struct.pack("<I", len(key_raw)) + key_raw
    out += struct.pack("<I", len(meta_raw)) + meta_raw
    out += b"\x00\x00\x00\x00" + b"\x01"          # CRC32 + version
    out += struct.pack("<I", len(cover))          # cover_frame_len
    out += struct.pack("<I", len(cover))          # cover_len
    out += cover
    out += audio_enc
    return out


def naive_audio(data: bytes, box: bytes) -> bytes:
    """完全照抄 ncmdump 的循环，用作对照。"""
    out = bytearray(data)
    for i in range(len(out)):
        j = (i + 1) & 0xFF
        out[i] ^= box[(box[j] + box[(box[j] + j) & 0xFF]) & 0xFF]
    return bytes(out)


def make_cover() -> bytes:
    doc = pymupdf.open()
    page = doc.new_page(width=64, height=64)
    page.draw_rect(pymupdf.Rect(0, 0, 64, 64), color=None, fill=(0.79, 0.39, 0.26))
    pix = page.get_pixmap(alpha=False)
    png = pix.tobytes("png")
    doc.close()
    return png


def main() -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    mp3 = open(os.path.join(here, "test.mp3"), "rb").read()
    flac = open(os.path.join(here, "test.flac"), "rb").read()
    cover = make_cover()
    rc4_key = bytes(range(1, 33))  # 32 字节任意密钥

    meta = {
        "musicName": "测试歌曲",
        "album": "测试专辑",
        "artist": [["测试歌手", 12345], ["第二歌手", 67890]],
        "bitrate": 128000,
        "duration": 3000,
        "format": "mp3",
    }

    print("=== 1. mp3 样本 ===")
    blob = build_ncm(mp3, meta, cover, rc4_key)
    check(blob[:8] == b"CTENFDAM", "生成的样本文件头是 CTENFDAM")
    check(len(blob) > len(mp3), f"样本大小 {len(blob)} > 原始音频 {len(mp3)}")
    r = ncm.decrypt(blob)
    check(r.audio == mp3, f"解密后与原始 mp3 逐字节一致（{len(r.audio)} 字节）")
    check(r.ext == "mp3", f"格式判定为 {r.ext}")
    check(r.title == "测试歌曲", f"歌名 = {r.title}")
    check(r.artist == "测试歌手/第二歌手", f"歌手 = {r.artist}")
    check(r.album == "测试专辑", f"专辑 = {r.album}")
    check(r.cover == cover, f"封面一致（{len(r.cover)} 字节）")
    check(r.cover_mime == "image/png", f"封面类型 = {r.cover_mime}")
    check(r.out_name == "测试歌手_第二歌手 - 测试歌曲.mp3", f"输出名 = {r.out_name}")

    print("=== 2. flac 样本 ===")
    meta2 = dict(meta, format="flac", musicName="无损测试")
    r2 = ncm.decrypt(build_ncm(flac, meta2, cover, rc4_key))
    check(r2.audio == flac, f"解密后与原始 flac 逐字节一致（{len(r2.audio)} 字节）")
    check(r2.ext == "flac", f"格式判定为 {r2.ext}（靠 fLaC 魔数，不靠元数据）")

    print("=== 3. 密钥流：优化版 vs 朴素版 ===")
    box = ncm._build_keybox(rc4_key)
    sample = mp3[:5000]
    check(ncm._decrypt_audio(sample, box) == naive_audio(sample, box),
          "5000 字节（非 256 整数倍）结果一致")
    big = (mp3 * 40)[: 1_100_000]      # 超过 CHUNK，验证分块
    check(ncm._decrypt_audio(big, box) == naive_audio(big, box),
          f"1.1 MB（跨分块）结果一致")
    check(ncm._decrypt_audio(b"", box) == b"", "空数据不报错")

    print("=== 4. 没有封面 / 没有元数据的容错 ===")
    r3 = ncm.decrypt(build_ncm(mp3, {}, b"", rc4_key))
    check(r3.audio == mp3, "无封面无元数据时音频仍然正确")
    check(r3.cover == b"", "封面为空")
    check(r3.out_name == "output.mp3", f"退化为默认名 {r3.out_name}")

    print("=== 5. 坏文件处理 ===")
    for name, blob_bad in [
        ("非 ncm 文件", b"this is not a ncm file at all" * 10),
        ("只有文件头", ncm.MAGIC + b"\x00" * 4),
        ("截断在 key 段", ncm.MAGIC + b"\x00\x00" + struct.pack("<I", 999) + b"short"),
    ]:
        try:
            ncm.decrypt(blob_bad)
            check(False, f"{name}：应该报错但没有")
        except ValueError as exc:
            check(True, f"{name}：正确报错「{exc}」")
        except Exception as exc:  # noqa: BLE001
            check(False, f"{name}：抛了非预期异常 {type(exc).__name__}: {exc}")

    print("=== 6. 真实落盘 + 标签写入 ===")
    out_mp3 = os.path.join(here, "out_test.mp3")
    out_flac = os.path.join(here, "out_test.flac")
    for path, res in ((out_mp3, r), (out_flac, r2)):
        with open(path, "wb") as fh:
            fh.write(res.audio)
        err = ncm.write_tags(path, res)
        check(err is None, f"{os.path.basename(path)} 写标签: {err or '成功'}")

    import mutagen
    from mutagen.flac import FLAC
    from mutagen.id3 import ID3

    tags = ID3(out_mp3)
    check(str(tags.get("TIT2")) == "测试歌曲", f"mp3 读回歌名 = {tags.get('TIT2')}")
    check(str(tags.get("TPE1")) == "测试歌手/第二歌手", f"mp3 读回歌手 = {tags.get('TPE1')}")
    apic = tags.getall("APIC")
    check(len(apic) == 1 and apic[0].data == cover, "mp3 封面嵌入正确")

    f = FLAC(out_flac)
    check(f["title"][0] == "无损测试", f"flac 读回歌名 = {f['title'][0]}")
    check(len(f.pictures) == 1 and f.pictures[0].data == cover, "flac 封面嵌入正确")

    check(mutagen.File(out_mp3) is not None, "mutagen 能识别产出的 mp3")
    check(mutagen.File(out_flac) is not None, "mutagen 能识别产出的 flac")

    print()
    print(f"结果：{PASS} 通过, {FAIL} 失败")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
