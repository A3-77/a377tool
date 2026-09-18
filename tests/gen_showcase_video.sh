#!/usr/bin/env bash
# =========================================================================
# 生成画廊的占位视频（弧形画廊支持放视频，这两个用来做默认素材 + 测试夹具）
#
# 需要 ffmpeg。Windows 上注意：ffmpeg 是原生程序，不认 Git Bash 的 /c/ 路径，
# 输出路径必须写成 C:/... （踩过，报 "No such file or directory" 但其实目录是存在的）。
#
#   bash tests/gen_showcase_video.sh
#
# 静态占位图（g1-g8 / ps-front / ps-back）由 tests/gen_showcase_svg.py 生成。
# =========================================================================
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../web/public/assets/showcase"
mkdir -p "$OUT"

if ! command -v ffmpeg >/dev/null 2>&1; then
  echo "找不到 ffmpeg。装一个再跑：winget install Gyan.FFmpeg / brew install ffmpeg" >&2
  exit 1
fi

# ffmpeg 是原生程序，Git Bash 下拿到 /c/... 会报 "No such file or directory"，
# 但目录明明存在 —— 必须转成 Windows 形式再传给它。
winpath() {
  if command -v cygpath >/dev/null 2>&1; then cygpath -w "$1"; else printf '%s' "$1"; fi
}
OUTW="$(winpath "$OUT")"

# 参数说明：
#   gradients  多色渐变随时间流动，无外部素材依赖，体积小
#   d=4        4 秒短循环，loop 起来看不出接缝
#   720x480    3:2，和画廊默认 aspect=1.5 一致
#   crf 30     视觉够用，单个约 50KB
#   +faststart moov 前置，边下边播（不然要等整个文件下完）
#   -an        不要音轨 —— 画廊里的视频必须静音才能自动播放，音轨纯浪费
gen() {
  local name="$1" grad="$2"
  ffmpeg -hide_banner -loglevel error -y \
    -f lavfi -i "gradients=s=720x480:d=4:${grad}:nb_colors=4" \
    -c:v libx264 -preset slow -crf 30 -pix_fmt yuv420p -movflags +faststart -an \
    "$OUTW/$name.mp4"
  echo "  $name.mp4  $(wc -c <"$OUTW/$name.mp4" | tr -d ' ') 字节"
}

echo "生成到 $OUT"
# 冷色（蓝 + 绿）
gen v1 "speed=0.06:c0=0x1f6feb:c1=0x0d1117:c2=0x2ea043:c3=0x161b22"
# 暖色（琥珀 + 橙）
gen v2 "speed=0.05:c0=0xf0b429:c1=0x1a202c:c2=0xdd6b20:c3=0x2d3748"

echo "完成。校验："
for f in v1 v2; do
  printf '  %s  ' "$f.mp4"
  ffprobe -v error -show_entries stream=codec_name,width,height,nb_frames \
    -show_entries format=duration -of default=noprint_wrappers=1 "$OUTW/$f.mp4" | tr '\n' ' '
  echo
done
