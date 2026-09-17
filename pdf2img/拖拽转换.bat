@echo off
title PDF 转图片 · 拖拽转换
cd /d "%~dp0"

if "%~1"=="" goto USAGE

call "%~dp0_find_python.bat"
if errorlevel 1 goto NOPY

%PYEXE% -c "import pymupdf" >nul 2>nul
if errorlevel 1 (
    echo   正在安装渲染组件 PyMuPDF，请稍候……
    %PYEXE% -m pip install -q pymupdf
)

%PYEXE% "%~dp0cli.py" %*

echo.
pause
exit /b 0

:USAGE
echo.
echo   ============================================================
echo     PDF 转图片 · 拖拽转换
echo   ============================================================
echo.
echo     把 PDF 文件直接拖到本文件的图标上，即可转成图片。
echo     可以一次拖多个。
echo.
echo     输出位置：PDF 同目录下的「文件名_图片」文件夹
echo     默认参数：200 DPI、PNG
echo.
echo     想调分辨率 / 页码 / 格式？双击「启动工具.bat」用网页界面。
echo.
echo   ============================================================
echo.
pause
exit /b 0

:NOPY
echo.
echo   [x] 没有找到可用的 Python，请先安装 Python 3。
echo.
pause
exit /b 1
