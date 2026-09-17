# -*- coding: utf-8 -*-
"""
PDF 页面操作：读页面信息、渲染缩略图、重排、合并、拆分。

页面范围写法统一为：逗号分隔的页号或区间，页号从 1 开始。
    "1-3,7,12-"   第 1 到 3 页、第 7 页、第 12 页到末尾
    ""            全部
分组写法用分号隔开，用于拆分：
    "1-3;4-6;7"   拆成三个文件
"""
from __future__ import annotations

import io
import re

import pymupdf

MAX_PAGE_PIXELS = 80_000_000
THUMB_DPI = 40


# --------------------------------------------------------------------------- #
# 参数解析
# --------------------------------------------------------------------------- #
def parse_page_spec(spec: str, total: int) -> list[int]:
    """把 "1-3,7,10-" 解析成 [1,2,3,7,10,...]（页号从 1 开始）。"""
    spec = (spec or "").strip()
    if not spec or spec.lower() in {"all", "*", "全部"}:
        return list(range(1, total + 1))

    picked: list[int] = []
    for token in re.split(r"[,，;；\s]+", spec):
        if not token:
            continue
        m = re.fullmatch(r"(\d+)?\s*[-–—~]\s*(\d+)?", token)
        if m:
            start = int(m.group(1)) if m.group(1) else 1
            end = int(m.group(2)) if m.group(2) else total
            if start > end:
                start, end = end, start
            picked.extend(range(start, end + 1))
        elif token.isdigit():
            picked.append(int(token))
        else:
            raise ValueError(f"看不懂的页码：{token}")

    seen, out = set(), []
    for p in picked:
        if 1 <= p <= total and p not in seen:
            seen.add(p)
            out.append(p)
    if not out:
        raise ValueError(f"页码没落在 PDF 的 1-{total} 页之内")
    return out


def parse_order(spec: str, total: int) -> list[int]:
    """重排用的页序。跟 parse_page_spec 的区别：这里允许重复页，且不自动去重。

    "3,1,2" → [3,1,2]；"1-3,1" → [1,2,3,1]
    """
    spec = (spec or "").strip()
    if not spec:
        return list(range(1, total + 1))

    out: list[int] = []
    for token in re.split(r"[,，\s]+", spec):
        if not token:
            continue
        m = re.fullmatch(r"(\d+)\s*[-–—~]\s*(\d+)", token)
        if m:
            a, b = int(m.group(1)), int(m.group(2))
            step = 1 if a <= b else -1
            out.extend(range(a, b + step, step))
        elif token.isdigit():
            out.append(int(token))
        else:
            raise ValueError(f"看不懂的页序：{token}")

    bad = [p for p in out if not (1 <= p <= total)]
    if bad:
        raise ValueError(f"页序里有超出 1-{total} 的页码：{bad[0]}")
    if not out:
        raise ValueError("页序是空的")
    return out


def parse_groups(spec: str, total: int) -> list[list[int]]:
    """拆分用的分组。空则每页一组。"""
    spec = (spec or "").strip()
    if not spec:
        return [[i] for i in range(1, total + 1)]
    groups = []
    for chunk in re.split(r"[;；|]+", spec):
        chunk = chunk.strip()
        if chunk:
            groups.append(parse_page_spec(chunk, total))
    if not groups:
        raise ValueError("拆分规则是空的")
    return groups


# --------------------------------------------------------------------------- #
# 基础
# --------------------------------------------------------------------------- #
def _open(data: bytes) -> pymupdf.Document:
    try:
        doc = pymupdf.open(stream=data, filetype="pdf")
    except Exception as exc:  # noqa: BLE001
        raise ValueError("这个文件打不开，可能不是 PDF 或已经损坏") from exc
    if doc.needs_pass:
        doc.close()
        raise ValueError("这个 PDF 有密码保护，暂不支持（可先去掉密码）")
    if doc.page_count == 0:
        doc.close()
        raise ValueError("PDF 里没有页面")
    return doc


def _dump(doc: pymupdf.Document) -> bytes:
    buf = io.BytesIO()
    doc.save(buf, garbage=4, deflate=True)
    return buf.getvalue()


def page_info(data: bytes) -> dict:
    """页面数量和每页尺寸（pt）。"""
    doc = _open(data)
    try:
        pages = []
        for i in range(doc.page_count):
            rect = doc.load_page(i).rect
            pages.append({
                "page": i + 1,
                "width": round(rect.width, 1),
                "height": round(rect.height, 1),
                "landscape": rect.width > rect.height,
            })
        return {"pages_total": doc.page_count, "pages": pages}
    finally:
        doc.close()


def render_thumbs(data: bytes, dpi: int = THUMB_DPI) -> tuple[list[tuple[str, bytes]], dict]:
    """渲染每页缩略图，返回 [(文件名, png 字节)] 和元信息。"""
    doc = _open(data)
    try:
        total = doc.page_count
        zoom = dpi / 72.0
        out = []
        for i in range(total):
            page = doc.load_page(i)
            est_w = int(page.rect.width * zoom)
            est_h = int(page.rect.height * zoom)
            if est_w * est_h > MAX_PAGE_PIXELS:
                raise ValueError(f"第 {i + 1} 页缩略图尺寸异常，请降低 DPI")
            pix = page.get_pixmap(dpi=dpi, alpha=False)
            out.append((f"p{i + 1:03d}.png", pix.tobytes("png")))
            pix = None
        return out, {"pages_total": total, "dpi": dpi}
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# 三种操作
# --------------------------------------------------------------------------- #
def reorder(data: bytes, order_spec: str) -> tuple[bytes, dict]:
    """按 order_spec 重排页面，返回新的 PDF。"""
    src = _open(data)
    try:
        order = parse_order(order_spec, src.page_count)
        out = pymupdf.open()
        try:
            for p in order:
                out.insert_pdf(src, from_page=p - 1, to_page=p - 1)
            return _dump(out), {
                "pages_total": src.page_count,
                "pages_out": len(order),
                "order": order,
            }
        finally:
            out.close()
    finally:
        src.close()


def merge(datas: list[bytes]) -> tuple[bytes, dict]:
    """按给定顺序合并多个 PDF。"""
    if not datas:
        raise ValueError("没有收到要合并的 PDF")
    out = pymupdf.open()
    sources = []
    try:
        detail = []
        for idx, data in enumerate(datas):
            doc = _open(data)
            sources.append(doc)
            out.insert_pdf(doc)
            detail.append({"index": idx + 1, "pages": doc.page_count})
        total = out.page_count
        if total == 0:
            raise ValueError("合并后没有页面")
        return _dump(out), {
            "files": len(datas),
            "pages_total": total,
            "detail": detail,
        }
    finally:
        for doc in sources:
            doc.close()
        out.close()


def split(data: bytes, groups_spec: str = "") -> tuple[list[tuple[str, bytes]], dict]:
    """按分组拆分，返回 [(文件名, pdf 字节)]。"""
    src = _open(data)
    try:
        total = src.page_count
        groups = parse_groups(groups_spec, total)
        width = max(3, len(str(total)))
        parts = []
        for gi, pages in enumerate(groups, start=1):
            out = pymupdf.open()
            try:
                for p in pages:
                    out.insert_pdf(src, from_page=p - 1, to_page=p - 1)
                if pages[0] == pages[-1]:
                    name = f"p{pages[0]:0{width}d}.pdf"
                else:
                    name = f"p{pages[0]:0{width}d}-{pages[-1]:0{width}d}.pdf"
                parts.append((name, _dump(out)))
            finally:
                out.close()
        return parts, {
            "pages_total": total,
            "parts": len(parts),
            "detail": [{"file": n, "pages": len(g)} for (n, _), g in zip(parts, groups)],
        }
    finally:
        src.close()
