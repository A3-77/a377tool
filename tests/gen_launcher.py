# -*- coding: utf-8 -*-
"""重新生成「启动工具.bat」——现在要检查三个依赖（GBK 编码，不切代码页）"""
import os

TOOL = r"<workspace>\pdf2img"

BAT = r"""@echo off
title 文件工具箱 · 本地工具
cd /d "%~dp0"

call "%~dp0_find_python.bat"
if errorlevel 1 goto NOPY

%PYEXE% -c "import pymupdf, Crypto, mutagen" >nul 2>nul
if errorlevel 1 (
    echo.
    echo   首次运行，正在安装所需组件，请稍候……
    echo.
    %PYEXE% -m pip install -q pymupdf pycryptodome mutagen
    %PYEXE% -c "import pymupdf, Crypto, mutagen" >nul 2>nul
    if errorlevel 1 (
        echo.
        echo   [x] 组件安装失败，请检查网络后重试。
        echo.
        pause
        exit /b 1
    )
)

%PYEXE% "%~dp0app.py" %*

echo.
echo   服务已停止，可以直接关闭这个窗口。
pause
exit /b 0

:NOPY
echo.
echo   [x] 没有找到可用的 Python。
echo       请先安装 Python 3（安装时勾选 Add to PATH），再双击本文件。
echo.
pause
exit /b 1
"""

if __name__ == "__main__":
    path = os.path.join(TOOL, "启动工具.bat")
    data = BAT.replace("\n", "\r\n").encode("gbk")
    with open(path, "wb") as fh:
        fh.write(data)
    text = open(path, "rb").read().decode("gbk")
    assert "chcp" not in text and "\r\n" in text
    print(f"已更新：{path}")
    print(f"  {len(data)} bytes, GBK, CRLF, {len(text.splitlines())} 行, 无 chcp ✓")
    print("  依赖检查：pymupdf + Crypto + mutagen")
