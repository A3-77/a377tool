#!/usr/bin/env bash
# =========================================================================
# 一条命令把 web/ 发上线，并当场校验发对了。
#
# 凭据二选一：
#   npx wrangler login                # 开浏览器点一下，之后直接跑下面这条
#   bash tools/deploy.sh
#
#   或者用 API 令牌（不用登录）：
#   CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy bash tools/deploy.sh
#
# 为什么要有这个脚本，而不是三条命令手敲：
#   1. KV 命名空间那步一直没做（wrangler.toml 里是全 0 占位值）。
#      漏了它部署也能成功，但上传会 503 —— 看起来像「传不上去」。
#   2. Pages 对不存在的路径会回落到 index.html 并返回 200。
#      所以「功能没部署上去」在浏览器里看不出任何异常，
#      必须主动校验（最后一步会跑 tools/verify-deploy.mjs）。
#
# 幂等：KV 已配好就跳过，重复跑不会建第二个命名空间。
# =========================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT/web"

WR="npx --yes wrangler@latest"
NODE="${NODE:-node}"
PLACEHOLDER="00000000000000000000000000000000"
TOML="wrangler.toml"

[ -f "$TOML" ] || { echo "找不到 $TOML，确认在项目里跑"; exit 1; }

# ---- 0. 凭据 ----------------------------------------------------------
if [ -n "${CLOUDFLARE_API_TOKEN:-}" ]; then
  [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || {
    echo "设了 CLOUDFLARE_API_TOKEN 但没设 CLOUDFLARE_ACCOUNT_ID。"; exit 1; }
  echo "==> 用环境变量里的 API 令牌"
elif ! $WR whoami 2>&1 | grep -qi "not authenticated"; then
  echo "==> 用 wrangler 已登录的账号"
else
  cat <<'MSG'
没有可用的凭据。二选一：

  1. 登录（开浏览器点一下，之后直接重跑本脚本）：
       npx wrangler login

  2. 用 API 令牌（Cloudflare 控制台 → My Profile → API Tokens）：
       CLOUDFLARE_API_TOKEN=xxx CLOUDFLARE_ACCOUNT_ID=yyy bash tools/deploy.sh
MSG
  exit 1
fi

strip_ansi() { sed 's/\x1b\[[0-9;]*m//g'; }

# ---- 1. KV 命名空间 ----------------------------------------------------
CUR="$(grep -A4 'binding = "MEDIA"' "$TOML" \
       | grep -oE 'id = "[0-9a-f]{32}"' | grep -oE '[0-9a-f]{32}' | head -1 || true)"

if [ -n "$CUR" ] && [ "$CUR" != "$PLACEHOLDER" ]; then
  echo "==> MEDIA 命名空间已配好：$CUR"
else
  echo "==> MEDIA 命名空间还没建，先建（一次性，幂等）"
  OUT="$($WR kv namespace create MEDIA 2>&1)" || {
    echo "$OUT"; echo
    echo "创建失败。如果是「namespace already exists」，"
    echo "去控制台 Workers & Pages → KV 抄 id，手填进 $TOML 的 [[kv_namespaces]] 再重跑。"
    exit 1; }
  NEW="$(printf '%s' "$OUT" | strip_ansi | grep -oE '[0-9a-f]{32}' | head -1 || true)"
  if [ -z "$NEW" ]; then
    echo "建好了但没从输出里解析出 id。原始输出："; echo "$OUT"; echo
    echo "手动把 id 填进 $TOML 的 [[kv_namespaces]] 再重跑本脚本。"; exit 1
  fi
  if [ -n "$CUR" ]; then
    sed -i "s/$PLACEHOLDER/$NEW/" "$TOML"
  else
    printf '\n[[kv_namespaces]]\nbinding = "MEDIA"\nid = "%s"\n' "$NEW" >> "$TOML"
  fi
  echo "    id = $NEW 已写进 $TOML"
fi

# ---- 2. 部署 ----------------------------------------------------------
echo "==> 部署 public/（functions/ 会被自动打包上传）"
$WR pages deploy public --project-name=a377tool --branch=main --commit-dirty=true

# ---- 3. 校验（这步不能省）---------------------------------------------
echo
echo "==> 校验线上"
sleep 8   # 边缘同步要几秒，立刻查会假失败
# 注意在子 shell 里 cd 回项目根、用相对路径。
# Git Bash 的 $ROOT 是 /c/Users/... 形式，直接传给 node 会被当成 C:\c\Users\...
(cd "$ROOT" && "$NODE" tools/verify-deploy.mjs) || {
  echo
  echo "校验没过。上面的 ✗ 每条都写了原因。"
  echo "刚部署完可以先等 30 秒重跑一次：node tools/verify-deploy.mjs"
  exit 1; }
