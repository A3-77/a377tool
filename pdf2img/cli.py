# -*- coding: utf-8 -*-
"""
PDF 转图片 · 命令行 / 拖拽版

用法：
    把 PDF 文件拖到「拖拽转换.bat」上，
    或在命令行执行：python cli.py 文件1.pdf 文件2.pdf

可选环境变量：
    PDF2IMG_DPI=300     分辨率（默认 200）
    PDF2IMG_FORMAT=jpg  输出格式 png/jpg（默认 png）
    PDF2IMG_QUALITY=92  JPG 质量（默认 92）

输出：每个 PDF 同目录下新建 <文件名>_图片/ 文件夹。
"""
from __future__ import annotations

import io
import os
import sys
import zipfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from app import render_pdf, safe_stem  # noqa: E402


def main(argv: list[str]) -> int:
    targets = [p for p in argv if p.lower().endswith(".pdf")]
    if not targets:
        print("用法：把 PDF 文件拖到这个 bat 图标上，或执行")
        print("      python cli.py <文件.pdf> [更多.pdf ...]")
        return 2

    dpi = int(os.environ.get("PDF2IMG_DPI", "200"))
    fmt = os.environ.get("PDF2IMG_FORMAT", "png").lower()
    fmt = "jpg" if fmt in ("jpg", "jpeg") else "png"
    quality = int(os.environ.get("PDF2IMG_QUALITY", "92"))

    print(f"参数：{dpi} DPI · {fmt.upper()} · JPG 质量 {quality}")
    print("-" * 60)
    ok = fail = 0

    for path in targets:
        name = os.path.basename(path)
        if not os.path.isfile(path):
            print(f"[跳过] 找不到文件：{path}")
            fail += 1
            continue
        try:
            with open(path, "rb") as fh:
                raw = fh.read()
            stem = safe_stem(name)
            # 命令行直接落盘，统一走 zip 形态再解出来，逻辑跟网页版保持一致
            payload, info, _kind = render_pdf(raw, dpi, fmt, "", quality, stem, pack="zip")

            outdir = os.path.join(os.path.dirname(os.path.abspath(path)), stem + "_图片")
            os.makedirs(outdir, exist_ok=True)
            with zipfile.ZipFile(io.BytesIO(payload)) as zf:
                zf.extractall(outdir)

            print(f"[完成] {name} → {info['pages_done']}/{info['pages_total']} 页 "
                  f"@ {dpi} DPI，用时 {info['elapsed']}s")
            print(f"       输出：{outdir}")
            ok += 1
        except Exception as exc:  # noqa: BLE001
            print(f"[失败] {name}：{exc}")
            fail += 1

    print("-" * 60)
    print(f"共成功 {ok} 个，失败 {fail} 个。")
    return 0 if fail == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
