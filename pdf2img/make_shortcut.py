# -*- coding: utf-8 -*-
"""
在桌面创建（或重建）「PDF 转图片」快捷方式。

什么时候用：
  - 桌面上没有快捷方式了
  - 工具目录挪过位置，旧快捷方式点了没反应

直接双击同目录的「重建桌面快捷方式.bat」即可。
"""
from __future__ import annotations

import os
import sys

import win32com.client

TOOL_DIR = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(TOOL_DIR, "启动工具.bat")
ICON = os.path.join(TOOL_DIR, "icon.ico")
LNK_NAME = "PDF 转图片.lnk"


def desktop_dir() -> str:
    """取真实桌面路径（兼容 OneDrive 把桌面重定向走的情况）。"""
    import winreg

    try:
        key = winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            r"Software\Microsoft\Windows\CurrentVersion\Explorer\Shell Folders",
        )
        val, _ = winreg.QueryValueEx(key, "Desktop")
        winreg.CloseKey(key)
        return os.path.expandvars(val)
    except OSError:
        return os.path.join(os.path.expanduser("~"), "Desktop")


def write_shortcut(shell, lnk: str) -> None:
    """写快捷方式。覆盖失败时删掉重来——资源管理器占着这个 .lnk 时就会这样。"""
    def build():
        sc = shell.CreateShortcut(lnk)
        sc.TargetPath = TARGET
        sc.WorkingDirectory = TOOL_DIR
        if os.path.isfile(ICON):
            sc.IconLocation = ICON + ",0"
        sc.Description = "PDF 转图片 · 本地工具"
        sc.WindowStyle = 1
        return sc

    try:
        build().Save()
        return
    except Exception as first_error:  # noqa: BLE001
        if not os.path.isfile(lnk):
            raise
        # 常见于快捷方式正被资源管理器选中/预览。删掉再写一遍。
        try:
            os.remove(lnk)
        except OSError:
            raise first_error
        build().Save()


def main() -> int:
    if not os.path.isfile(TARGET):
        print(f"[x] 找不到启动文件：{TARGET}")
        print("    这个脚本必须放在工具目录里运行。")
        return 1

    desktop = desktop_dir()
    lnk = os.path.join(desktop, LNK_NAME)

    try:
        shell = win32com.client.Dispatch("WScript.Shell")
        write_shortcut(shell, lnk)
    except Exception as exc:  # noqa: BLE001
        print(f"[x] 创建失败：{exc}")
        print()
        print("    如果提示「拒绝访问」，通常是这个快捷方式正被资源管理器占用，")
        print("    或者被安全软件拦了。可以先手动删掉桌面上的旧快捷方式再试一次。")
        return 1

    # 回读校验，别只看文件存不存在
    chk = shell.CreateShortcut(lnk)
    ok = (os.path.normcase(chk.TargetPath) == os.path.normcase(TARGET)
          and os.path.normcase(chk.WorkingDirectory) == os.path.normcase(TOOL_DIR))

    print(f"桌面路径  ：{desktop}")
    print(f"快捷方式  ：{lnk}")
    print(f"指向      ：{chk.TargetPath}")
    print(f"工作目录  ：{chk.WorkingDirectory}")
    print(f"图标      ：{chk.IconLocation or '（默认）'}")
    print()
    print("结果：" + ("创建成功，去桌面双击试试" if ok else "写入校验没通过，请反馈"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
