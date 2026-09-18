#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成首页展示组件的占位图（SVG）。

用途：弧形画廊和 Photo Stack 的默认内容。这些图只是占位，
真实内容在后台管理页填自己的图片 URL 即可。

跑法：python tests/gen_showcase_svg.py
产出：web/public/assets/showcase/*.svg
"""

import os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "web", "public", "assets", "showcase"))

W, H = 960, 640          # 画廊卡片
PW, PH = 900, 1200       # Photo Stack 竖版


def head(w, h, bg):
    return (
        "<svg xmlns='http://www.w3.org/2000/svg' width='%d' height='%d' "
        "viewBox='0 0 %d %d' fill='none'>"
        "<rect width='%d' height='%d' fill='%s'/>" % (w, h, w, h, w, h, bg)
    )


def chrome(ink, w=W):
    """窗口标题栏：三个圆点 + 一条地址条"""
    c = []
    c.append("<rect x='0' y='0' width='%d' height='52' fill='%s' opacity='0.06'/>" % (w, ink))
    for i in range(3):
        c.append("<circle cx='%d' cy='26' r='5.5' fill='%s' opacity='0.28'/>" % (28 + i * 20, ink))
    c.append("<rect x='110' y='17' width='%d' height='18' rx='9' fill='%s' opacity='0.10'/>" % (w - 160, ink))
    return "".join(c)


def motif_grid(ink, accent):
    c = []
    for r in range(2):
        for k in range(3):
            x, y = 56 + k * 292, 96 + r * 250
            c.append("<rect x='%d' y='%d' width='256' height='208' rx='16' fill='%s' opacity='0.09'/>" % (x, y, ink))
            c.append("<rect x='%d' y='%d' width='72' height='72' rx='20' fill='%s' opacity='0.85'/>" % (x + 24, y + 24, accent))
            c.append("<rect x='%d' y='%d' width='150' height='13' rx='6.5' fill='%s' opacity='0.34'/>" % (x + 24, y + 122, ink))
            c.append("<rect x='%d' y='%d' width='104' height='13' rx='6.5' fill='%s' opacity='0.18'/>" % (x + 24, y + 150, ink))
    return "".join(c)


def motif_list(ink, accent):
    c = ["<rect x='56' y='96' width='848' height='490' rx='20' fill='%s' opacity='0.06'/>" % ink]
    for i in range(6):
        y = 132 + i * 74
        c.append("<circle cx='106' cy='%d' r='17' fill='%s' opacity='%s'/>" % (y + 10, accent, "0.9" if i == 0 else "0.35"))
        c.append("<rect x='146' y='%d' width='%d' height='14' rx='7' fill='%s' opacity='0.32'/>" % (y, 300 - i * 24, ink))
        c.append("<rect x='146' y='%d' width='190' height='12' rx='6' fill='%s' opacity='0.15'/>" % (y + 26, ink))
        c.append("<rect x='790' y='%d' width='62' height='26' rx='13' fill='%s' opacity='0.22'/>" % (y, ink))
    return "".join(c)


def motif_split(ink, accent):
    c = []
    c.append("<rect x='56' y='96' width='216' height='490' rx='18' fill='%s' opacity='0.10'/>" % ink)
    for i in range(5):
        c.append("<rect x='82' y='%d' width='%d' height='13' rx='6.5' fill='%s' opacity='%s'/>" % (136 + i * 44, 160 - i * 12, accent if i == 0 else ink, "0.85" if i == 0 else "0.24"))
    c.append("<rect x='304' y='96' width='600' height='230' rx='18' fill='%s' opacity='0.09'/>" % ink)
    c.append("<rect x='340' y='140' width='240' height='18' rx='9' fill='%s' opacity='0.36'/>" % ink)
    c.append("<rect x='340' y='176' width='380' height='12' rx='6' fill='%s' opacity='0.16'/>" % ink)
    c.append("<rect x='340' y='202' width='320' height='12' rx='6' fill='%s' opacity='0.16'/>" % ink)
    c.append("<rect x='340' y='252' width='128' height='40' rx='20' fill='%s' opacity='0.9'/>" % accent)
    for k in range(2):
        c.append("<rect x='%d' y='356' width='288' height='230' rx='18' fill='%s' opacity='0.07'/>" % (304 + k * 312, ink))
    return "".join(c)


def motif_hero(ink, accent):
    c = []
    c.append("<rect x='56' y='96' width='848' height='300' rx='22' fill='%s' opacity='0.09'/>" % ink)
    c.append("<circle cx='760' cy='196' r='74' fill='%s' opacity='0.9'/>" % accent)
    c.append("<rect x='104' y='152' width='392' height='26' rx='13' fill='%s' opacity='0.40'/>" % ink)
    c.append("<rect x='104' y='198' width='300' height='26' rx='13' fill='%s' opacity='0.26'/>" % ink)
    c.append("<rect x='104' y='262' width='146' height='44' rx='22' fill='%s' opacity='0.85'/>" % accent)
    for k in range(4):
        c.append("<rect x='%d' y='428' width='196' height='158' rx='16' fill='%s' opacity='0.07'/>" % (56 + k * 214, ink))
    return "".join(c)


def motif_chart(ink, accent):
    c = ["<rect x='56' y='96' width='848' height='490' rx='20' fill='%s' opacity='0.06'/>" % ink]
    hs = [110, 190, 84, 240, 150, 300, 208, 128]
    for i, h in enumerate(hs):
        c.append("<rect x='%d' y='%d' width='56' height='%d' rx='12' fill='%s' opacity='%s'/>"
                 % (108 + i * 96, 546 - h, h, accent if i == 5 else ink, "0.85" if i == 5 else "0.20"))
    c.append("<rect x='108' y='124' width='180' height='16' rx='8' fill='%s' opacity='0.32'/>" % ink)
    return "".join(c)


def motif_cards(ink, accent):
    c = []
    for k in range(3):
        x = 56 + k * 292
        c.append("<rect x='%d' y='116' width='256' height='420' rx='20' fill='%s' opacity='0.08'/>" % (x, ink))
        c.append("<rect x='%d' y='148' width='192' height='150' rx='14' fill='%s' opacity='0.85'/>" % (x + 32, accent if k == 1 else ink))
        c.append("<rect x='%d' y='330' width='140' height='15' rx='7.5' fill='%s' opacity='0.34'/>" % (x + 32, ink))
        c.append("<rect x='%d' y='362' width='192' height='11' rx='5.5' fill='%s' opacity='0.16'/>" % (x + 32, ink))
        c.append("<rect x='%d' y='386' width='160' height='11' rx='5.5' fill='%s' opacity='0.16'/>" % (x + 32, ink))
        c.append("<rect x='%d' y='452' width='104' height='36' rx='18' fill='%s' opacity='0.28'/>" % (x + 32, ink))
    return "".join(c)


def motif_form(ink, accent):
    c = ["<rect x='248' y='96' width='464' height='490' rx='22' fill='%s' opacity='0.07'/>" % ink]
    c.append("<circle cx='480' cy='172' r='38' fill='%s' opacity='0.85'/>" % accent)
    c.append("<rect x='356' y='240' width='248' height='17' rx='8.5' fill='%s' opacity='0.34'/>" % ink)
    for i in range(3):
        c.append("<rect x='300' y='%d' width='360' height='52' rx='14' fill='%s' opacity='0.10'/>" % (300 + i * 72, ink))
    c.append("<rect x='300' y='522' width='360' height='48' rx='24' fill='%s' opacity='0.9'/>" % accent)
    return "".join(c)


GALLERY = [
    ("g1", "#f4f1ea", "#1c1b19", "#c96442", motif_grid),
    ("g2", "#101014", "#f2f2f2", "#6f9ad0", motif_split),
    ("g3", "#ffe94d", "#1c1b19", "#d63a6a", motif_hero),
    ("g4", "#f7c9d8", "#4a1f2e", "#b03060", motif_cards),
    ("g5", "#0f3d2e", "#e8f5ef", "#7fd1a8", motif_chart),
    ("g6", "#ffffff", "#111111", "#836953", motif_list),
    ("g7", "#1b2334", "#dce6f5", "#6f9ad0", motif_form),
    ("g8", "#e8e2d5", "#2b2620", "#836953", motif_grid),
]

# Photo Stack 的照片：做成风景照的样子。
# 原版 DialKit 的 example/src/PhotoStack.tsx 里是 4 张（one..four.avif），
# 每张带一个 color 当阴影底色 —— 这里照 4 张来，颜色对齐原版那四个值。
# ps-front / ps-back 是第一版只有「正片+背片」时留下的，留着免得旧配置 404。
PHOTO = [
    ("ps1", "#f6b48a", "#7a2436", "#ffe0c2", "#c41e3a", 0.2),
    ("ps2", "#2b3358", "#1a1a2e", "#dfe6ff", "#39426b", 0.6),
    ("ps3", "#efe6d2", "#c9b48c", "#fff8ea", "#e8d5b7", 1.4),
    ("ps4", "#cfe3d0", "#2d5a27", "#f2f7ec", "#4a7c42", 1.9),
    ("ps-front", "#8ec5e8", "#2f4a63", "#e8e2d5", "#3f6b52", 0.0),
    ("ps-back", "#f0c9a8", "#5a3a4a", "#f6ede0", "#7a4b3a", 1.0),
]

# 照片对应的阴影底色（原版是 PHOTOS[i].color）
PHOTO_COLORS = {
    "ps1": "#c41e3a",
    "ps2": "#1a1a2e",
    "ps3": "#e8d5b7",
    "ps4": "#2d5a27",
}


def photo(name, sky, deep, sun, hill, shift):
    c = [head(PW, PH, sky)]
    # 天空渐变
    c.append(
        "<defs><linearGradient id='sky-%s' x1='0' y1='0' x2='0' y2='1'>"
        "<stop offset='0' stop-color='%s'/><stop offset='1' stop-color='%s'/>"
        "</linearGradient></defs>" % (name, sky, sun)
    )
    c.append("<rect width='%d' height='%d' fill='url(#sky-%s)'/>" % (PW, PH, name))
    c.append("<circle cx='%d' cy='%d' r='104' fill='%s' opacity='0.9'/>" % (620 - shift * 120, 300 + shift * 60, sun))
    # 远山
    c.append("<path d='M0 %d L200 %d L360 %d L560 %d L760 %d L%d %d L%d %d Z' fill='%s' opacity='0.55'/>"
             % (700, 560, 640, 720, 600, PW, 660, PW, PH, deep))
    # 近山
    c.append("<path d='M0 %d L240 %d L430 %d L640 %d L%d %d L%d %d Z' fill='%s' opacity='0.85'/>"
             % (880, 780, 830, 900, PW, 860, PW, PH, hill))
    # 水面
    c.append("<rect x='0' y='1020' width='%d' height='180' fill='%s' opacity='0.35'/>" % (PW, deep))
    c.append("</svg>")
    return "".join(c)


def main():
    os.makedirs(OUT, exist_ok=True)
    made = []
    for name, bg, ink, accent, motif in GALLERY:
        body = head(W, H, bg) + chrome(ink) + motif(ink, accent) + "</svg>"
        path = os.path.join(OUT, name + ".svg")
        with open(path, "w", encoding="utf-8") as f:
            f.write(body)
        made.append(os.path.basename(path))
    for name, sky, deep, sun, hill, shift in PHOTO:
        path = os.path.join(OUT, name + ".svg")
        with open(path, "w", encoding="utf-8") as f:
            f.write(photo(name, sky, deep, sun, hill, shift))
        made.append(os.path.basename(path))
    print("已生成 %d 个文件 -> %s" % (len(made), OUT))
    for m in made:
        print("  " + m)


if __name__ == "__main__":
    main()
