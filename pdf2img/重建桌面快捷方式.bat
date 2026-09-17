@echo off
title PDF 转图片 · 重建桌面快捷方式
cd /d "%~dp0"

call "%~dp0_find_python.bat"
if errorlevel 1 goto NOPY

%PYEXE% -c "import win32com" >nul 2>nul
if errorlevel 1 (
    echo   首次使用，正在安装组件 pywin32，请稍候……
    %PYEXE% -m pip install -q pywin32
    %PYEXE% -c "import win32com" >nul 2>nul
    if errorlevel 1 (
        echo.
        echo   [x] 组件安装失败，请检查网络后重试。
        echo.
        pause
        exit /b 1
    )
)

%PYEXE% "%~dp0make_shortcut.py"

echo.
pause
exit /b 0

:NOPY
echo.
echo   [x] 没有找到可用的 Python，请先安装 Python 3。
echo.
pause
exit /b 1
