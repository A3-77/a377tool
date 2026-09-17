@echo off
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
