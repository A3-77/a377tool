# -*- coding: utf-8 -*-
"""
PDF 工具箱 · 本地工具（后端）

功能：PDF 转图片、重排页面、合并、拆分，以及网易云音乐 ncm 转 mp3/flac。

- 双击「启动工具.bat」即可，浏览器自动打开界面
- 只监听 127.0.0.1，文件不出本机
- 依赖：PyMuPDF（PDF 渲染）、pycryptodome（ncm 解密）、mutagen（写音频标签）
"""
from __future__ import annotations

import io
import json
import os
import re
import socket
import sys
import threading
import time
import traceback
import webbrowser
import zipfile
from email.parser import BytesParser
from email.policy import default as email_default
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import parse_qs, quote, urlparse

try:
    import pymupdf  # PyMuPDF >= 1.24
except ImportError:  # pragma: no cover
    import fitz as pymupdf

import ncm
import pdfops
from pdfops import parse_page_spec

HERE = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
PORT_CANDIDATES = range(8777, 8800)
MAX_UPLOAD_BYTES = 800 * 1024 * 1024
MAX_PAGE_PIXELS = 80_000_000
ALLOWED_FORMATS = {"png": "png", "jpg": "jpg", "jpeg": "jpg"}
VERSION = "1.0"


# --------------------------------------------------------------------------- #
# 转换核心
# --------------------------------------------------------------------------- #
# parse_page_spec 已挪到 pdfops.py，这里直接复用，避免两份实现漂移


def parse_multipart(content_type: str, body: bytes) -> list[tuple[str, bytes]]:
    """解析 multipart/form-data，返回 [(文件名, 数据)]。

    Python 3.13 已经移除 cgi 模块，这里借 email 解析器来做，够用且是标准库。
    """
    head = f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n".encode("latin-1")
    try:
        msg = BytesParser(policy=email_default).parsebytes(head + body)
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"上传数据解析失败：{exc}") from exc

    out = []
    for part in msg.iter_parts():
        filename = part.get_filename()
        if not filename:
            continue
        payload = part.get_payload(decode=True)
        if payload:
            out.append((filename, payload))
    return out


def safe_stem(name: str) -> str:
    stem = os.path.splitext(os.path.basename(name or "document"))[0]
    stem = re.sub(r'[\\/:*?"<>|\r\n\t]+', "_", stem).strip(" .")
    return stem[:80] or "document"


def render_pdf(data: bytes, dpi: int, fmt: str, page_spec: str,
               quality: int, stem: str, pack: str = "auto") -> tuple[bytes, dict, str]:
    """把 PDF 渲染成图片。

    pack="auto"（默认）：只出 1 张图时直接给图片文件，多张才打包 ZIP
    pack="zip" ：无论多少张都打包 ZIP
    返回 (响应体字节, 元信息, "image" | "zip")

    所有可预期的失败都转成 ValueError，方便上层回 400 而不是 500。
    """
    try:
        return _render(data, dpi, fmt, page_spec, quality, stem, pack)
    except ValueError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise ValueError(f"这个文件读不了，可能不是 PDF 或已经损坏（{exc}）") from exc


def _render(data: bytes, dpi: int, fmt: str, page_spec: str,
            quality: int, stem: str, pack: str = "auto") -> tuple[bytes, dict, str]:
    t0 = time.time()
    doc = pymupdf.open(stream=data, filetype="pdf")
    try:
        if doc.needs_pass:
            raise ValueError("这个 PDF 有密码保护，暂不支持（可先去掉密码再转）")
        if doc.page_count == 0:
            raise ValueError("PDF 里没有可渲染的页面")

        pages = parse_page_spec(page_spec, doc.page_count)
        width = max(3, len(str(doc.page_count)))
        zoom = dpi / 72.0
        rendered = []  # [(文件名, 图片字节, 宽, 高)]

        for pno in pages:
            page = doc.load_page(pno - 1)
            # 先按尺寸预估拦截，避免真去分配几百 MB 的位图
            est_w = int(round(page.rect.width * zoom))
            est_h = int(round(page.rect.height * zoom))
            if est_w * est_h > MAX_PAGE_PIXELS:
                raise ValueError(
                    f"第 {pno} 页按 {dpi} DPI 会渲染成 {est_w}×{est_h} "
                    f"（约 {est_w * est_h / 1e6:.0f} 百万像素），超出安全上限，请降低 DPI"
                )

            pix = page.get_pixmap(dpi=dpi, alpha=False)
            if fmt == "jpg":
                img = pix.tobytes("jpg", jpg_quality=quality)
            else:
                img = pix.tobytes("png")
            rendered.append((f"{stem}_p{pno:0{width}d}.{fmt}", img, pix.width, pix.height))
            pix = None  # 及时释放，高 DPI 时很关键

        info = {
            "pages_total": doc.page_count,
            "pages_done": len(rendered),
            "dpi": dpi,
            "format": fmt,
            "source_bytes": len(data),
            "items": [
                {"page": p, "file": n, "width": w, "height": h, "bytes": len(b)}
                for p, (n, b, w, h) in zip(pages, rendered)
            ],
            "elapsed": round(time.time() - t0, 2),
        }

        # 只有一张图就直接给图片文件，别让用户为了 1 张图去解压
        if pack == "auto" and len(rendered) == 1:
            name, blob, _w, _h = rendered[0]
            info["packed"] = "image"
            info["download_name"] = name
            return blob, info, "image"

        # 多张图打包。PNG/JPG 本身已压缩，用 STORE 不再压一遍：
        # 体积几乎一样，但省掉 CPU，前端也能直接切分出每张图。
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for name, blob, _w, _h in rendered:
                zf.writestr(name, blob)
        info["packed"] = "zip"
        info["download_name"] = f"{stem}_{len(rendered)}p_{dpi}dpi.zip"
        return buf.getvalue(), info, "zip"
    finally:
        doc.close()


# --------------------------------------------------------------------------- #
# HTTP 服务
# --------------------------------------------------------------------------- #
class Handler(BaseHTTPRequestHandler):
    server_version = f"PDF2Img/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stdout.write(f"[{time.strftime('%H:%M:%S')}] {fmt % args}\n")
        sys.stdout.flush()

    # ---------------------------- helpers ---------------------------------- #
    def _send(self, code: int, body: bytes, ctype: str, extra: dict | None = None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            # HTTP 头只允许 latin-1；非 ASCII 会让整条响应写坏，这里强制降级兜底
            self.send_header(k, v.encode("latin-1", "replace").decode("latin-1"))
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _send_json(self, code: int, payload: dict):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send(code, body, "application/json; charset=utf-8")

    def _read_body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n <= 0:
            raise ValueError("请求体是空的，没有收到文件数据")
        if n > MAX_UPLOAD_BYTES:
            raise ValueError("文件太大了（上限 800 MB）")
        chunks, remain = [], n
        while remain > 0:
            chunk = self.rfile.read(min(remain, 1 << 20))
            if not chunk:
                break
            chunks.append(chunk)
            remain -= len(chunk)
        return b"".join(chunks)

    def _q1(self, key: str, default: str = "") -> str:
        q = parse_qs(urlparse(self.path).query)
        return (q.get(key) or [default])[0]

    def _send_download(self, payload: bytes, ctype: str, dl_name: str,
                       info: dict | None = None):
        """统一的下发逻辑：文件名头只能是 ASCII，原名走 RFC 5987 的 filename*。"""
        ascii_name = re.sub(r"[^A-Za-z0-9._-]+", "_", dl_name).strip("_") or "download"
        extra = {
            "Content-Disposition":
                f'attachment; filename="{ascii_name}"; '
                f"filename*=UTF-8''{quote(dl_name, safe='')}",
        }
        if info is not None:
            extra["X-PDF2IMG-Info"] = quote(json.dumps(info, ensure_ascii=False))
        self._send(200, payload, ctype, extra)

    # ------------------------------ routes --------------------------------- #
    ROUTES = {
        "/api/convert": "_handle_convert",
        "/api/pdf/thumbs": "_handle_thumbs",
        "/api/pdf/reorder": "_handle_reorder",
        "/api/pdf/split": "_handle_split",
        "/api/pdf/merge": "_handle_merge",
        "/api/ncm/convert": "_handle_ncm",
    }

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            page = os.path.join(HERE, "index.html")
            if not os.path.isfile(page):
                self._send(500, "index.html 不见了".encode("utf-8"),
                           "text/plain; charset=utf-8")
                return
            with open(page, "rb") as fh:
                self._send(200, fh.read(), "text/html; charset=utf-8")
        elif path == "/api/ping":
            self._send_json(200, {
                "ok": True, "version": VERSION,
                "engine": f"PyMuPDF {pymupdf.version[0]}",
                "features": ["convert", "thumbs", "reorder", "merge", "split", "ncm"],
            })
        elif path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
        else:
            self._send_json(404, {"error": "没有这个地址"})

    def do_POST(self):
        path = urlparse(self.path).path
        name = self.ROUTES.get(path)
        if not name:
            self._send_json(404, {"error": "没有这个地址"})
            return
        try:
            getattr(self, name)()
        except ValueError as exc:
            self._send_json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            self._send_json(500, {"error": f"处理失败：{exc}"})

    def _handle_convert(self):
        q1 = self._q1

        try:
            dpi = int(q1("dpi", "200"))
        except ValueError:
            raise ValueError("DPI 必须是数字")
        dpi = max(30, min(dpi, 1200))

        fmt = ALLOWED_FORMATS.get(q1("fmt", "png").lower())
        if not fmt:
            raise ValueError("格式只支持 png / jpg")

        try:
            quality = int(q1("quality", "92"))
        except ValueError:
            quality = 92
        quality = max(10, min(quality, 100))

        page_spec = q1("pages", "")
        stem = safe_stem(q1("name", "document"))

        pack = q1("pack", "auto").lower()
        if pack not in ("auto", "zip"):
            pack = "auto"

        raw = self._read_body()
        payload, info, kind = render_pdf(raw, dpi, fmt, page_spec, quality, stem, pack)

        dl_name = info["download_name"]
        if kind == "image":
            ctype = "image/jpeg" if fmt == "jpg" else "image/png"
        else:
            ctype = "application/zip"
            if not dl_name.lower().endswith(".zip"):
                dl_name += ".zip"
        self._send_download(payload, ctype, dl_name, info)
        self.log_message("转换完成 %s → %d 页 @%ddpi %s，输出 %s，用时 %.2fs",
                         stem, info["pages_done"], dpi, fmt, kind, info["elapsed"])

    # --------------------------- PDF 页面操作 ------------------------------ #
    def _handle_thumbs(self):
        """把每页渲染成小图，打包返回，前端用来做拖拽排序的预览。"""
        raw = self._read_body()
        try:
            dpi = int(self._q1("dpi", str(pdfops.THUMB_DPI)))
        except ValueError:
            dpi = pdfops.THUMB_DPI
        dpi = max(12, min(dpi, 150))

        items, info = pdfops.render_thumbs(raw, dpi)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for name, blob in items:
                zf.writestr(name, blob)
        info["count"] = len(items)
        self._send_download(buf.getvalue(), "application/zip", "thumbs.zip", info)
        self.log_message("缩略图 %d 页 @%ddpi", info["count"], dpi)

    def _handle_reorder(self):
        raw = self._read_body()
        stem = safe_stem(self._q1("name", "document"))
        payload, info = pdfops.reorder(raw, self._q1("order", ""))
        info["kind"] = "reorder"
        info["download_name"] = f"{stem}_重排.pdf"
        self._send_download(payload, "application/pdf", info["download_name"], info)
        self.log_message("重排 %s：%d 页 → %d 页", stem, info["pages_total"], info["pages_out"])

    def _handle_split(self):
        raw = self._read_body()
        stem = safe_stem(self._q1("name", "document"))
        parts, info = pdfops.split(raw, self._q1("groups", ""))
        info["kind"] = "split"

        if len(parts) == 1:
            name, blob = parts[0]
            info["download_name"] = f"{stem}_{name}"
            self._send_download(blob, "application/pdf", info["download_name"], info)
        else:
            buf = io.BytesIO()
            with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
                for name, blob in parts:
                    zf.writestr(name, blob)
            info["download_name"] = f"{stem}_拆分{len(parts)}份.zip"
            self._send_download(buf.getvalue(), "application/zip",
                                info["download_name"], info)
        self.log_message("拆分 %s：%d 页 → %d 份", stem, info["pages_total"], info["parts"])

    def _handle_merge(self):
        ctype = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in ctype:
            raise ValueError("合并需要一次上传多个文件（multipart/form-data）")
        files = parse_multipart(ctype, self._read_body())
        if len(files) < 2:
            raise ValueError(f"合并至少要 2 个 PDF，这次只收到 {len(files)} 个")

        payload, info = pdfops.merge([data for _name, data in files])
        info["kind"] = "merge"
        info["names"] = [name for name, _ in files]
        stem = safe_stem(self._q1("name", "合并结果"))
        info["download_name"] = f"{stem}.pdf"
        self._send_download(payload, "application/pdf", info["download_name"], info)
        self.log_message("合并 %d 个文件 → %d 页", info["files"], info["pages_total"])

    # ----------------------------- ncm 转换 -------------------------------- #
    def _handle_ncm(self):
        import tempfile

        raw = self._read_body()
        stem = safe_stem(self._q1("name", "music"))
        result = ncm.decrypt(raw)

        tag_note = None
        if self._q1("tags", "1") != "0":
            # mutagen 只能对文件操作，落到临时文件写完再读回来
            fd, tmp = tempfile.mkstemp(suffix="." + result.ext, prefix="ncm_")
            os.close(fd)
            try:
                with open(tmp, "wb") as fh:
                    fh.write(result.audio)
                tag_note = ncm.write_tags(tmp, result)
                if tag_note is None:
                    with open(tmp, "rb") as fh:
                        result.audio = fh.read()
            finally:
                try:
                    os.remove(tmp)
                except OSError:
                    pass

        info = {
            "kind": "ncm",
            "format": result.ext,
            "title": result.title,
            "artist": result.artist,
            "album": result.album,
            "bitrate": result.meta.get("bitrate"),
            "duration": result.meta.get("duration"),
            "cover_bytes": len(result.cover),
            "tag_warning": tag_note,
            "size": len(result.audio),
            "download_name": result.out_name or f"{stem}.{result.ext}",
        }
        ctype = "audio/flac" if result.ext == "flac" else "audio/mpeg"
        self._send_download(result.audio, ctype, info["download_name"], info)
        self.log_message("ncm 转换 %s → %s（%s），%.1f KB",
                         stem, info["download_name"], result.ext, len(result.audio) / 1024)


def pick_port() -> int:
    for port in PORT_CANDIDATES:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((HOST, port))
                return port
            except OSError:
                continue
    raise SystemExit("端口 8777-8799 都被占用了，请先关掉占用这些端口的程序")


def find_running_instance() -> int | None:
    """看看本工具是不是已经在跑了，避免重复启动第二个服务。"""
    import urllib.error
    import urllib.request

    # 必须显式绕开系统代理：本机 HTTP_PROXY 会把 127.0.0.1 的探测也转发出去，
    # 拿到一个 502，于是误判成「没在运行」而重复起服务。
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    for port in PORT_CANDIDATES:
        try:
            with opener.open(f"http://{HOST}:{port}/api/ping", timeout=0.3) as resp:
                data = json.loads(resp.read().decode("utf-8"))
                if data.get("ok") and data.get("version"):
                    return port
        except Exception:  # noqa: BLE001 - 探测失败就是没在跑，继续试下一个端口
            continue
    return None


def main():
    # 已经在跑就直接把界面叫出来，不再起第二个
    alive = find_running_instance()
    if alive:
        url = f"http://{HOST}:{alive}/"
        print(f"  工具已经在运行，直接打开界面：{url}")
        if "--no-browser" not in sys.argv:
            webbrowser.open(url)
        time.sleep(0.4)
        return

    port = pick_port()
    url = f"http://{HOST}:{port}/"
    engine = f"PyMuPDF {pymupdf.version[0]}"

    print("=" * 52)
    print("  PDF 转图片 · 本地工具")
    print("=" * 52)
    print(f"  界面地址 : {url}")
    print(f"  渲染引擎 : {engine}")
    print(f"  工作目录 : {HERE}")
    print()
    print("  浏览器会自动打开。用完直接关掉这个黑窗口即可。")
    print("=" * 52)

    if "--no-browser" not in sys.argv:
        threading.Timer(0.7, lambda: webbrowser.open(url)).start()
    httpd = ThreadingHTTPServer((HOST, port), Handler)
    httpd.daemon_threads = True
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
