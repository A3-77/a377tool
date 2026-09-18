# AI 协作说明

给要修改这个项目的 AI 看。读完再动手。

---

## 这是什么

个人工具站，线上地址 https://a377.xyz，跑在 **Cloudflare Pages + D1**。

| 路径 | 模块 |
| --- | --- |
| `/` | 门户首页：进入文件、生图、见面三个模块 |
| `/file/` | 文件工具箱：PDF 转图 / 重排 / 合并 / 拆分、ncm 转音频 |
| `/trips/` | 周末去哪见面：两人选中间城市，含高铁时长和地图 |
| `/draw/` | 生图落地页 |
| `/draw/studio/` | Right Code 绘图工作台（浏览器直连 rightapi.ai） |
| `/draw/code0/` | Code0 图片工作台（经 `/api/code0/*` 代理到 code0.ai） |
| `/api/*` | 后端接口（Pages Functions） |

## 目录结构

```
web/
├── public/                 静态资源（这就是部署目录）
│   ├── index.html          门户首页
│   ├── file/index.html     文件工具箱
│   ├── assets/             共享 tokens / theme / shell / ZIP
│   ├── favicon.svg
│   ├── trips/index.html    周末去哪见面
│   ├── draw/               生图（index / studio / code0）
│   └── vendor/             pdf.js、pdf-lib、标准字体（本地副本，不依赖 CDN）
├── functions/api/*.js      后端接口，自动映射成 /api/*
├── schema.sql              D1 建表语句
└── wrangler.toml           D1 绑定配置（database_id 在这里）
```

`pdf2img/` 是本地版 PDF 工具（Python），`tests/` 是测试脚本。

---

## 部署

**只有一条路**：wrangler 直接上传（Direct Upload），没有接 Git 自动部署。

```bash
cd web
CLOUDFLARE_API_TOKEN='<令牌>' CLOUDFLARE_ACCOUNT_ID='5117ffc876a76ef7302775c45a3b6918' \
  npx --yes wrangler@latest pages deploy public \
  --project-name=a377tool --branch=main --commit-dirty=true
```

> **不要用 curl 直接调 Pages 上传 API** —— 那是两段式的，会返回 success 但访问 500。

本地预览要跑 Functions 和 D1，**必须用 wrangler**：

```bash
cd web
npx wrangler pages dev public --d1=DB --persist-to .d1dev --port 8789
```

只看工具箱静态页面的话 `python -m http.server` 也行。

---

## Git 与仓库操作

仓库没配 git 身份，提交时用 `-c` 临时传，**身份要和历史提交一致**：

```bash
git -c user.name="A377" -c user.email="1357390150@qq.com" commit -m "..."
```

### 不要用 `git rebase`

**实测踩过**：rebase 被 SIGTERM 打断后，`.git/refs/` 整个目录被删、`.git/logs/` 消失、
新提交的 tree 对象丢失，git 直接报 `fatal: not a git repository`。

push 被拒（`non-fast-forward`）时**不要 `git pull --rebase`**，用 plumbing 在远端提交之上重建：

```bash
git fetch origin main
git log --oneline HEAD..FETCH_HEAD              # 远端多了什么
git show --stat FETCH_HEAD
git diff HEAD FETCH_HEAD -- README.md           # 具体差异

# 远端改动和本地不重叠时，直接套补丁到工作区
git diff <基线提交> FETCH_HEAD -- README.md | git apply -v

git add -A
TREE=$(git write-tree)
NEW=$(git -c user.name="A377" -c user.email="1357390150@qq.com" \
        commit-tree "$TREE" -p "$(git rev-parse FETCH_HEAD)" -F .git/COMMIT_EDITMSG)
git update-ref refs/heads/main "$NEW"
git reset --mixed HEAD
git push origin main
```

`commit-tree -p` 显式指定 parent，新提交就是远端提交的直接子提交 → push 是 fast-forward。
全程无中间状态，哪一步失败都不会破坏仓库。

### 改 `README.md` 前先 `git fetch`

用户在 GitHub 网页上手动编辑过它（删掉了内置测试账号和「API Key 内置在前端」那两行）。
不先 fetch 就改，会把用户删掉的敏感信息又提交回去。

### `update-ref` 写 `refs/remotes/origin/*` 不生效

`git fetch` 会打印 `abc..def  main -> origin/main`，看着成功了，但 `git rev-parse origin/main`
读到的还是旧值，`git status` 一直显示 `ahead N`。真实值在 `.git/packed-refs` 里，松散 ref 没写进去。
直接写文件绕过（松散 ref 优先于 `packed-refs`）：

```bash
mkdir -p .git/refs/remotes/origin
printf '<sha>\n' > .git/refs/remotes/origin/main
```

### 仓库损坏怎么恢复

**先确认工作区文件是否完好** —— 只要文件在，代码就没丢，`.git` 怎么坏都能重建。

| 症状 | 病因 |
| --- | --- |
| `fatal: not a git repository`（`.git` 明明在） | `.git/refs/` 目录没了 |
| `bad tree object HEAD` | HEAD 的 commit 在，它的 tree 丢了 |
| `unable to read <sha>` | `.git/index` 的 cache-tree 引用了已丢失的对象 |
| `invalid reflog entry <sha>`（fsck） | `.git/logs/` 里的 reflog 指向已删对象 |

```bash
mkdir -p .git/refs/heads .git/refs/tags
printf '<good-sha>\n' > .git/refs/heads/main   # 先指回一个对象完整的提交
cp .git/index .git/index.bak && rm -f .git/index
git read-tree HEAD                              # 重建索引
git status --short                              # 改动全部重新浮现，逐条核对
# 再用上面的 commit-tree 流程重新提交

rm -rf .git/logs                                # 清掉指向已删对象的 reflog
git fsck --no-progress                          # 无输出 = 干净
```

### 发布 release

先对齐历史约定：`gh release list` 看标题风格，`git cat-file -p v0.4.0 | head -8` 看 tag 是
轻量还是 annotated（**历史都是 annotated**）。

```bash
git tag -a v1.0.0 -m "A377Tool v1.0.0" <sha> && git push origin v1.0.0
gh release create v1.0.0 --title "A377Tool v1.0.0" --notes-file "C:/path/notes.md"
```

发之前把 `RELEASE_NOTES.md` 里的「待发布 / 发布日期：待定」落定成实际日期，单独提交一次。

> **`gh` 的路径参数要用 Windows 形式** —— Git Bash 的 `/c/Users/...` 传给 `gh` 会报
> `The system cannot find the path specified.`，要写成 `C:/Users/...`。

---

## 安全红线

**1. 不要把任何密钥写进代码**

已经有一个反面案例：`web/public/draw/studio/index.html` 里硬编码了 Right Code 的
API Key，**已经永久写进 git 历史，删不掉了**。别再加第二个。

新功能需要密钥时，走服务端代理（参照 `functions/api/code0/[[path]].js`），
key 从环境变量读：

```bash
npx wrangler pages secret put <名字> --project-name=a377tool
```

**2. 不要动 D1 生产数据**

除非用户明确要求，且**先导出一份**：

```bash
npx wrangler d1 export meet-db --remote --output=./backup.sql
```

需要改数据时，写出 SQL 让用户确认后再执行。

**3. 环境变量（6 个）只有名字，值在 Cloudflare 里，取不回**

`SESSION_SECRET`、`ADMIN_TOKEN`、`ADMIN_EMAIL`、`MAIL_FROM`、`RESEND_KEY`、`CODE0_API_KEY`

**4. 不要向用户索要 Cloudflare API Token**

这个账户下有 9 个 Pages 项目，token 是账户级的，给出去等于把全部项目交出去。
改代码就好，部署让用户自己跑上面那条命令。

---

## 皮肤（skin）机制

两套皮肤 `classic`（v0.2 原版）/ `one`（黑白网格），由 `assets/skin.js` 写在
`<html data-skin="...">` 上，偏好存 `localStorage.a377skin`。

**核心原则：皮肤是「两套并列的完整样式」，不是「一层覆盖」。**

| 页面 | classic 怎么来 | one 怎么来 |
| --- | --- | --- |
| `/`、`/draw/` | 页面内联 `<style>` 里的 `html[data-skin="classic"]` 段 | 同一份 `<style>` 里的 `html[data-skin="one"]` 段 |
| `/file/`、`/trips/`、`/draw/studio/`、`/draw/code0/` | 页面自己的基础样式（就是 v0.2 的，没动过） | `assets/onepage.css` 覆盖层 |

`assets/skin.js` 必须在 `<head>` **末尾**（页面自身 `<style>` 之后）：它要在解析 body 前
就把 `data-skin` 定下来（否则闪皮肤），同时决定覆盖层的 `media`。

覆盖层用的是 **`<link id="a377-onepage" … media="not all">`**，skin.js 按皮肤把 `media`
切成 `all` / `not all`。`classic` 下规则完全不参与匹配 —— 这是防覆盖层泄漏的根本手段，
比「给每条规则加前缀」更彻底（前缀还是要加，当保险）。
**`/` 和 `/draw/` 不放这个 link**：它们自带两套样式，而 `onepage.css` 里
`html[data-skin="one"] .tool{background:#fff!important}` 会把那两页的 hover 反色压死。
`test_skins.mjs` 里有一条 hover 检查专门盯这个。

`one` 皮肤自成浅色配色，不跟随 `data-theme`：`/file/` `/trips/` 这些页面是深色优先写的，
浅色靠 `html[data-theme="light"]` 覆盖；`onepage.css` 又把 `--text` 强制成黑色，
如果 `data-theme` 还是 `dark`，就会出现黑底黑字。所以 skin.js 在 one 皮肤下把生效主题压成
`light`，并隐藏深浅色开关（one 没有深色变体）。

## 已知的坑（别重复踩）

- **不要用 `git rebase`** —— 被 SIGTERM 打断会删掉 `.git/refs`，仓库直接报
  `not a git repository`。push 被拒时改用 `commit-tree` 在远端提交之上重建，
  见上面「Git 与仓库操作」。改 `README.md` 前也要先 `git fetch`（用户在网页上手动改过）。
- **`Cloud.pull()` 不能再先清空本地**：先拉完云端详情再合并，本地独有的行程会补传；接口按 `created_by` 归属校验。
- **邀请链接是前端状态编码**：`#s=...` 在线上登录后也会导入，不依赖后端。

- **改完 secret 必须重新部署才生效** —— Pages 的 secrets 是部署时绑定的。第一次配
  `CODE0_API_KEY` 后忘了重新部署，`/api/code0/status` 一直返回 `key: false`，查了半天。
- **PDF 渲染必须配 `standardFontDataUrl`** —— 用标准字体又没嵌入的 PDF，不给这个
  参数**文字会静默消失**（图形正常，只有字不见）。
- **Resend 免费版只能发给注册邮箱** —— 要发给别人得先在 Resend 验证 `a377.xyz` 域名。
- **ncm 解密是手写 AES-128** —— Web Crypto 不支持 ECB 模式，别想着替换成原生实现。
- **`.bat` 文件是 GBK 编码，不要加 `chcp 65001`** —— cmd 按字节偏移读 bat，切代码页
  会让后续行错位，报出看不出根因的错。
- **`A377Skin.refresh` 不能写成 `refresh: paint`** —— `shell.js` 建完顶栏会调
  `A377Skin.refresh()`（**不带参数**）。旧版把 `undefined` 当成皮肤值处理，
  结果每个有顶栏的页面加载时都会把皮肤偏好重置掉，`classic` 永远切不过去。
  现在 `paint()` 收到非法值会保持当前皮肤不动。
- **顶栏里的动态按钮必须用事件委托绑** —— `shell.js` 用 `innerHTML` 造按钮，
  在 `skin.js` 里 `addEventListener` 到具体元素上是绑不到的（v0.4 的 SKIN 按钮就是这样点不动的）。
  参照 `theme.js` 的 `document.addEventListener("click", ...)` 写法。
- **`onepage.css` 里每条规则都要带 `html[data-skin="one"]` 前缀** —— 漏了前缀又带
  `!important` 的规则会穿透到 classic 皮肤和深色主题。虽然现在 classic 下覆盖层的
  `media` 是 `not all`（不参与匹配），但别把这道保险拆了。
- **别把 `onepage.css` 挂到 `/` 和 `/draw/` 上** —— 这两页的 one 视图是内联样式自带的，
  覆盖层里 `html[data-skin="one"] .tool{background:#fff!important}` 会把 hover 反色压死。
- **密集 curl 测试会触发 Cloudflare 429**（免费套餐频率限制），不是代码问题。
- `tests/` 下 `npm install` 前**确认 `tests/package.json` 存在**，否则 npm 会一路向上
  找到别的 package.json，把包装到主目录去。
- `.gitignore` 已排除 `backup-*/`、`backup-*.zip`，别把备份快照提交进来。

---

## 改完怎么验

```bash
curl -s https://a377.xyz/api/code0/status          # 应返回 {"key":true}
curl -s -o /dev/null -w "%{http_code}" https://a377.xyz/trips/   # 应 200
cd tests && node test_cloud_flow.mjs               # 线上真实流程（会建测试行程，记得删）
```

`test_cloud_flow.mjs` 打的是**线上真实站点**，用真实 cookie 模拟浏览器行为。

改了皮肤 / 主题 / 配色之后，跑这个（自带静态服务器 + 无头 Chrome，不用手动开服务）：

```bash
cd tests && node test_skins.mjs
```

它覆盖 6 个页面 × 2 套皮肤 × 2 个主题，检查皮肤是否生效、`onepage.css` 是否只在 one
皮肤加载、顶栏 SKIN 按钮是否真能切换，并自动扫「深底深字」（对比度 < 2.6 会列出来）。
需要 `puppeteer-core`（已在 `tests/package.json`）和本机 Chrome；
Chrome 不在默认路径就设 `CHROME_PATH`。也可以 `node test_skins.mjs https://a377.xyz` 直接打线上。

低对比度扫描目前有 7 处已知历史遗留（`home` 的 `drag the letters` 提示、
`code0` 页脚小字、`trips` classic 皮肤的 `邀请 TA` 按钮等），都不影响判定。

要**人眼确认视觉效果**（断言查不出来的「看着不对」），跑这个出对照图：

```bash
cd tests && node skin-compare/gen.mjs
```

它把 6 个页面 × 3 种状态（classic 浅色 / classic 深色 / one）截成一张对照页，
输出 `tests/skin-compare/index.html`。截图和对照页都是生成产物，已在 `.gitignore` 里。

