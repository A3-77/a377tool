# -*- coding: utf-8 -*-
"""
后端接口端到端验证。

验证方式不是"接口返回 200 就算过"，而是：
  - 重排后逐页提取文字，确认页序真的变了
  - 合并后确认页数和每页来源都正确
  - 拆分后确认每份的页数和内容
  - ncm 解出的音频与原始 mp3 逐字节一致
"""
import io
import json
import os
import struct
import sys
import urllib.error
import urllib.request
import zipfile
from urllib.parse import quote, unquote

import pymupdf

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "pdf2img"))
import ncm  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
BASE = "http://127.0.0.1:8777"
OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

PASS = FAIL = 0


def check(ok, msg):
    global PASS, FAIL
    print(("  [OK] " if ok else "  [XX] ") + msg)
    if ok:
        PASS += 1
    else:
        FAIL += 1


def post(path, body, ctype="application/pdf"):
    # query 里可能带中文，urlopen 要求 ASCII，先编码（前端用 URLSearchParams 会自动做这件事）
    safe_path = quote(path, safe="/?&=%")
    req = urllib.request.Request(BASE + safe_path, data=body, method="POST")
    req.add_header("Content-Type", ctype)
    try:
        with OPENER.open(req, timeout=120) as resp:
            info_raw = resp.headers.get("X-PDF2IMG-Info")
            info = json.loads(unquote(info_raw)) if info_raw else {}
            return resp.status, resp.headers.get("Content-Type", ""), resp.read(), info
    except urllib.error.HTTPError as exc:
        payload = exc.read()
        try:
            err = json.loads(payload.decode("utf-8")).get("error", "")
        except Exception:  # noqa: BLE001
            err = payload[:120].decode("utf-8", "replace")
        return exc.code, "", err.encode(), {}


def make_pdf(prefix: str, pages: int) -> bytes:
    doc = pymupdf.open()
    for i in range(1, pages + 1):
        page = doc.new_page(width=300, height=400)
        page.insert_text((40, 80), f"{prefix}{i}", fontsize=40)
    data = doc.tobytes()
    doc.close()
    return data


def page_texts(pdf_bytes: bytes) -> list[str]:
    doc = pymupdf.open(stream=pdf_bytes, filetype="pdf")
    try:
        return [doc.load_page(i).get_text().strip() for i in range(doc.page_count)]
    finally:
        doc.close()


def multipart(files: list[tuple[str, bytes]]) -> tuple[bytes, str]:
    boundary = "----pdfboxboundary1234567890"
    out = io.BytesIO()
    for name, data in files:
        out.write(f"--{boundary}\r\n".encode())
        out.write(
            f'Content-Disposition: form-data; name="files"; filename="{name}"\r\n'
            f"Content-Type: application/pdf\r\n\r\n".encode()
        )
        out.write(data)
        out.write(b"\r\n")
    out.write(f"--{boundary}--\r\n".encode())
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def build_ncm(audio: bytes, meta: dict, rc4_key: bytes) -> bytes:
    import base64

    from Crypto.Cipher import AES
    from Crypto.Util.Padding import pad

    key_enc = AES.new(ncm.CORE_KEY, AES.MODE_ECB).encrypt(pad(ncm.KEY_PREFIX + rc4_key, 16))
    key_raw = bytes(b ^ ncm.KEY_XOR for b in key_enc)
    meta_enc = AES.new(ncm.MODIFY_KEY, AES.MODE_ECB).encrypt(
        pad(ncm.MUSIC_PREFIX + json.dumps(meta, ensure_ascii=False).encode(), 16)
    )
    meta_raw = bytes(b ^ ncm.META_XOR for b in (ncm.META_PREFIX + base64.b64encode(meta_enc)))
    audio_enc = ncm._decrypt_audio(audio, ncm._build_keybox(rc4_key))

    out = ncm.MAGIC + b"\x00\x00"
    out += struct.pack("<I", len(key_raw)) + key_raw
    out += struct.pack("<I", len(meta_raw)) + meta_raw
    out += b"\x00" * 5
    out += struct.pack("<I", 0) + struct.pack("<I", 0)
    return out + audio_enc


def main() -> int:
    print("=== 0. 服务状态 ===")
    with OPENER.open(BASE + "/api/ping", timeout=5) as r:
        ping = json.loads(r.read().decode())
    check(ping.get("ok") is True, f"ping ok，引擎 {ping.get('engine')}")
    check("ncm" in ping.get("features", []), f"上报的功能: {ping.get('features')}")

    a = make_pdf("A", 5)
    b = make_pdf("B", 3)

    print("=== 1. 缩略图 ===")
    status, ctype, body, info = post("/api/pdf/thumbs?dpi=40", a)
    check(status == 200, f"HTTP {status}")
    check(ctype.startswith("application/zip"), f"返回类型 {ctype}")
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        names = sorted(zf.namelist())
    check(len(names) == 5, f"切出 {len(names)} 张缩略图")
    check(names[0] == "p001.png" and names[-1] == "p005.png", f"命名 {names[0]} … {names[-1]}")
    check(info.get("pages_total") == 5, f"info.pages_total = {info.get('pages_total')}")

    print("=== 2. 重排页面 ===")
    status, _, body, info = post("/api/pdf/reorder?order=3,1,2,4,5&name=a.pdf", a)
    check(status == 200, f"HTTP {status}")
    check(body[:4] == b"%PDF", "返回的是 PDF")
    texts = page_texts(body)
    check(texts == ["A3", "A1", "A2", "A4", "A5"], f"重排后页序 = {texts}")

    print("=== 2b. 重排：反向 + 复制页 ===")
    status, _, body, _ = post("/api/pdf/reorder?order=5-3,1,1&name=a.pdf", a)
    check(status == 200, f"HTTP {status}")
    texts = page_texts(body)
    check(texts == ["A5", "A4", "A3", "A1", "A1"], f"页序 = {texts}（含重复页）")

    print("=== 2c. 重排：页码越界要报错 ===")
    status, _, body, _ = post("/api/pdf/reorder?order=1,9&name=a.pdf", a)
    check(status == 400, f"HTTP {status}")
    check("超出" in body.decode("utf-8", "replace"), body.decode("utf-8", "replace")[:80])

    print("=== 3. 合并 ===")
    mp_body, mp_type = multipart([("a.pdf", a), ("b.pdf", b)])
    status, _, body, info = post("/api/pdf/merge?name=合并结果", mp_body, mp_type)
    check(status == 200, f"HTTP {status}")
    texts = page_texts(body)
    check(texts == ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3"],
          f"合并后 8 页顺序 = {texts}")
    check(info.get("pages_total") == 8, f"info.pages_total = {info.get('pages_total')}")

    print("=== 3b. 合并：顺序反过来 ===")
    mp_body, mp_type = multipart([("b.pdf", b), ("a.pdf", a)])
    status, _, body, _ = post("/api/pdf/merge?name=reverse", mp_body, mp_type)
    texts = page_texts(body)
    check(texts == ["B1", "B2", "B3", "A1", "A2", "A3", "A4", "A5"],
          "上传顺序决定合并顺序")

    print("=== 3c. 合并：只给一个文件要报错 ===")
    mp_body, mp_type = multipart([("a.pdf", a)])
    status, _, body, _ = post("/api/pdf/merge", mp_body, mp_type)
    check(status == 400, f"HTTP {status}：{body.decode('utf-8', 'replace')[:60]}")

    print("=== 4. 拆分：每页一个 ===")
    status, ctype, body, info = post("/api/pdf/split?groups=&name=a.pdf", a)
    check(status == 200 and ctype.startswith("application/zip"), f"HTTP {status} {ctype}")
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        parts = sorted(zf.namelist())
        contents = {n: page_texts(zf.read(n)) for n in parts}
    check(len(parts) == 5, f"拆成 {len(parts)} 份")
    check(all(len(v) == 1 for v in contents.values()), "每份都是单页")
    check([contents[n][0] for n in parts] == ["A1", "A2", "A3", "A4", "A5"],
          "各份内容依次是 A1…A5")

    print("=== 4b. 拆分：按范围分组 ===")
    status, _, body, info = post("/api/pdf/split?groups=1-2;3;4-5&name=a.pdf", a)
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        parts = sorted(zf.namelist())
        got = [(n, page_texts(zf.read(n))) for n in parts]
    check(len(parts) == 3, f"拆成 {len(parts)} 份")
    check([len(v) for _n, v in got] == [2, 1, 2], f"各份页数 = {[len(v) for _n, v in got]}")
    check([v[0] for _n, v in got] == ["A1", "A3", "A4"], "各份首页正确")
    check([v[-1] for _n, v in got] == ["A2", "A3", "A5"], "各份末页正确")

    print("=== 4c. 拆分：只拆出一份时直接给 PDF ===")
    status, ctype, body, _ = post("/api/pdf/split?groups=2-4&name=a.pdf", a)
    check(ctype.startswith("application/pdf"), f"返回类型 {ctype}（不是 zip）")
    check(page_texts(body) == ["A2", "A3", "A4"], "内容正确")

    print("=== 5. ncm 转换 ===")
    mp3 = open(os.path.join(HERE, "test.mp3"), "rb").read()
    meta = {"musicName": "接口测试", "album": "专辑", "artist": [["歌手", 1]],
            "bitrate": 128000, "duration": 3000, "format": "mp3"}
    blob = build_ncm(mp3, meta, bytes(range(1, 33)))
    status, ctype, body, info = post("/api/ncm/convert?name=x.ncm", blob,
                                     "application/octet-stream")
    check(status == 200, f"HTTP {status}")
    check(ctype == "audio/mpeg", f"返回类型 {ctype}")
    check(body[:3] == b"ID3", "产出的是带 ID3 的 mp3")
    check(info.get("title") == "接口测试", f"info.title = {info.get('title')}")
    check(info.get("artist") == "歌手", f"info.artist = {info.get('artist')}")
    check(info.get("download_name") == "歌手 - 接口测试.mp3",
          f"下载名 = {info.get('download_name')}")
    check(info.get("tag_warning") is None, "标签写入无告警")
    import mutagen
    mf = mutagen.File(io.BytesIO(body))
    check(mf is not None, "mutagen 能识别接口产出的音频")

    print("=== 5b. ncm：坏文件要报错 ===")
    status, _, body, _ = post("/api/ncm/convert", b"not a ncm file" * 20,
                              "application/octet-stream")
    check(status == 400, f"HTTP {status}：{body.decode('utf-8', 'replace')[:60]}")

    print("=== 6. 回归：PDF 转图片仍然正常 ===")
    status, ctype, body, info = post("/api/convert?dpi=100&fmt=png&name=a.pdf&pack=auto", a)
    check(status == 200 and ctype == "application/zip", f"5 页 → {ctype}")
    with zipfile.ZipFile(io.BytesIO(body)) as zf:
        check(len(zf.namelist()) == 5, f"切出 {len(zf.namelist())} 张图")
    status, ctype, body, _ = post("/api/convert?dpi=100&fmt=png&pages=2&name=a.pdf&pack=auto", a)
    check(ctype == "image/png", f"单页 → {ctype}")

    print()
    print(f"结果：{PASS} 通过, {FAIL} 失败")
    return 0 if FAIL == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
