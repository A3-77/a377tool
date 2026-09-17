@echo off
rem ============================================================
rem  供其他 bat 调用：探测可用的 Python，把结果写进 PYEXE 变量
rem  注意：本文件不能使用 setlocal，否则变量传不回调用方
rem ============================================================

if defined PYEXE exit /b 0

set "VENV_PY=%USERPROFILE%\.workbuddy-ai\binaries\python\envs\default\Scripts\python.exe"

if exist "%VENV_PY%" (
    set "PYEXE=%VENV_PY%"
    exit /b 0
)

where py >nul 2>nul
if not errorlevel 1 (
    set "PYEXE=py"
    exit /b 0
)

where python >nul 2>nul
if not errorlevel 1 (
    set "PYEXE=python"
    exit /b 0
)

exit /b 1
