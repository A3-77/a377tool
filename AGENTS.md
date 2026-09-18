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
│   │   ├── showcase.js     首页展示组件（画廊 / Photo Stack），读 /api/site
│   │   ├── showcase.css    展示组件样式
│   │   ├── showcase/       占位素材（图由 tests/gen_showcase_svg.py 生成，
│   │   │                    视频由 tests/gen_showcase_video.sh 用 ffmpeg 生成）
│   │   ├── site-admin.js   后台控制面板（控件定义 SCHEMA + 上传/压缩逻辑在这里）
│   │   └── site-admin.css
│   ├── favicon.svg
│   ├── trips/index.html    周末去哪见面
│   ├── draw/               生图（index / studio / code0）
│   └── vendor/             pdf.js、pdf-lib、标准字体（本地副本，不依赖 CDN）
├── functions/api/*.js      后端接口，自动映射成 /api/*
│   ├── _ddl.js             建表 + 展示组件的默认配置（DEFAULT_BLOCKS）
│   ├── _media.js           素材上传的共用逻辑（白名单 / 体积上限 / key 生成）
│   ├── site.js             GET /api/site（公开，只吐启用的组件）
│   ├── site-admin.js       /api/site-admin（ADMIN_TOKEN 鉴权，控制面板 + 保存）
│   └── media/[[key]].js    /api/media（上传 / 读取 / 删除，存 KV）
├── schema.sql              D1 建表语句
└── wrangler.toml           D1 + KV 绑定配置（database_id / namespace id 在这里）
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

本地预览要跑 Functions、D1 和 KV，**必须用 wrangler**：

```bash
cd web
npx wrangler pages dev public --d1=DB --kv=MEDIA --persist-to .d1dev --port 8789
```

`--d1=DB --kv=MEDIA` **都不能省** —— `wrangler.toml` 里那两段绑定只管**部署**，
本地 dev 的绑定是靠命令行标志给进去的。少了 `--kv=MEDIA` 时 `env.MEDIA` 是 `undefined`，
启动日志的绑定列表里也不会出现它（看那行列表就能确认），上传返回 503。

KV 命名空间只建一次（`npx wrangler kv namespace create MEDIA`），
把 id 填进 `wrangler.toml`，然后重新部署才在线上生效。

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

改完 **必须重新部署**才生效（secrets 在部署时绑定）。验证方法：拿新值 curl 一下，
`/api/site-admin?key=<值>` 返回 200 就是生效了。

`ADMIN_TOKEN` 护着 `/api/approve`（能**批准注册**，等于发放 `/trips` 访问权）
和 `/api/site-admin`（能**改首页**），两个接口都没有失败次数限制。

> **2026-09-18：用户知情后选择使用弱口令。**
> 已把风险、影响范围、生成强口令的命令都说明过，用户回复「就用 admin」。
> 这是用户的站点、用户的选择 —— 不再重复劝阻。
>
> 但要记住两件事：
> 1. **本仓库是公开的**，`README.md` / `AGENTS.md` 写明了这两个后台的路径。
>    路径 + 弱口令 = 任何人可进。所以**绝不要把这个口令的值写进仓库**，
>    也别写进 commit message（git 历史删不掉）。
> 2. 用户以后改主意的话，`wrangler pages secret put ADMIN_TOKEN` 重设 + 重新部署即可，
>    命令见 `在线版部署说明.md`。

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

## 首页展示组件（gallery / photostack）

首页 `/` 上可以挂「后台可控」的展示组件。目前两个：

| kind | 组件 | 默认 |
| --- | --- | --- |
| `gallery` | 3D 弧形画廊（一圈卡片绕圆柱面自动旋转，可拖拽，图片 / 视频混排） | 开启 |
| `photostack` | Photo Stack（多张照片叠放，**点最上面那张换下一张**） | **关闭** |

**参数体系照搬 DialKit**（`dialkit.dev`，MIT）。当初评估过直接装它，结论是装不了：
dialkit 是 React 库，而这个项目是纯静态 HTML + Pages Functions，没有 React、没有构建步骤。
所以只借它的**控件分类心智模型**（slider / toggle / text / select / color / image / spring / folder），
自己实现一遍，参数落 D1。

### Photo Stack 是对着原版源码对齐的

原版实现在 **`github.com/joshpuckett/dialkit` → `example/src/PhotoStack.tsx`**。
我们的 `stackSection()` 是按那份源码逐条对齐的，**改动前先去看源码，别照自己的口味改**。
几个容易改错、又很难自己发现的地方：

| 点 | 原版 | 踩过的错法 |
| --- | --- | --- |
| 照片 | `PHOTOS[]` 多张轮转，`visibleCount = 2` | 只做「正片 + 背片」两个 URL，换不了片 |
| 换片 | 点**最上面那张** → `next()`（`step++`） | 做成悬停展开 |
| 出场 | `x: -shape.width, scale: 1, opacity: 0`（向左滑出 + 淡出） | 直接删节点，没有过渡 |
| 进场 | 从背片位 `(offsetX, offsetY, scale×0.8)` 弹入 | 从正面淡入 |
| 首帧 | `AnimatePresence initial={false}` —— **首次挂载不播进场动画** | 页面一打开照片自己抖一下 |
| 圆角 | `borderRadius: 2`（几乎是直角） | 用 16px 圆角卡片 |
| 背片压暗 | `linear-gradient(to right, tint, transparent)` | 用纯色 + `opacity` |
| 阴影 | **整张照片的模糊副本**，独立一层，`scale/blur/yOffset` | 用 `box-shadow` |
| 缩放原点 | `transformOrigin: 'bottom left'` —— 背片底边与正片对齐 | 用默认 center，背片上下都缩 |
| 布局 | 标题在照片**上方**（flex column + align-start） | 做成标题在左、照片在右两列 |

原版是 React + `motion`，我们没动画库，所以按同一套状态机手写了多属性弹簧
（`x / y / scale / opacity / 压暗` 各一个弹簧，共用一个 rAF）。
`spring.duration + bounce` 的换算与原版一致：`bounce 0 → 阻尼比 1`，`bounce 1 → 0.15`。

原版是满屏 demo，尺寸写死（竖版 340×480 / 方形 400×400 / 横版 480×320）。
我们这里是个 section，窄屏放不下，所以**外面套一层按可用宽度算的 `scale()`**，
内部几何仍然全部按原版的固定 px 算 —— 缩放只发生在最外层，
弹簧、`clip-path`、错位量都不用跟着屏幕宽度改。

### 数据流

后台地址 `/api/site-admin?key=<ADMIN_TOKEN>` —— **和 `/api/approve`（账号审批）
共用同一个 `ADMIN_TOKEN`**，没另开一套口令。审批页底部有「首页展示组件 →」入口。
两个后台地址都记在 `在线版部署说明.md` 里。

> 只有 D1 里的**配置**是热的（改完刷新即可见）。
> 改了 `functions/` 或 `public/` 的**代码**必须重新部署才生效。

```
后台 /api/site-admin?key=<ADMIN_TOKEN>
   │  左侧 iframe 预览首页，右侧按控件渲染表单
   │  改任何字段 → postMessage('a377:showcase-preview') → iframe 内实时预览（不落库）
   │  点保存 → POST { key, blocks } → 写 D1
   ▼
D1 site_blocks(kind, enabled, config JSON)
   ▼
GET /api/site  → 只返回 enabled 的组件，blocks.<kind> 直接就是 config
   ▼
assets/showcase.js 读 /api/site → 渲染进当前皮肤视图里的 [data-showcase] 空 slot
```

- 两套皮肤各有一个 `<div data-showcase hidden>` slot，只有当前皮肤那个被填。
  切皮肤时 `relocate()` 把已渲染的节点**搬**过去（不重建，避免重新加载图片）。
- `[data-showcase][hidden]{display:none!important}` 是必须的 —— slot 在 grid 里，
  不显式 `!important` 会被 `display:block` 顶回来，出现一条空白。
- **`/api/site` 是扁平的**（`blocks.gallery` = config 本身），
  **`/api/site-admin` 的 GET 是 `{ enabled, config }`**（要回显开关）。两个接口结构不一样，
  改的时候别搞混。
- POST 可以**只传 `{ enabled }`** 来只翻开关、不动配置 —— 否则改个开关要回传整份配置，
  漏一个字段就把设置冲掉了。

### 素材上传（`functions/api/media/[[key]].js` + `assets/site-admin.js` 的上传部分）

后台「＋ 上传」传的图片 / 视频存 **KV**（绑定名 `MEDIA`），不是 R2。

**为什么不是 R2**：R2 免费额度更大（10GB 存储、无出口费），但**激活必须绑付款方式**。
KV 免费额度是 1GB 总量 / 单值 25MiB / 每天 1000 次写 / 每天 10 万次读，
不要付款方式，放几十张图和几秒的短视频绰绰有余。**用户是学生，别为了 10GB 让他去绑卡。**

```
POST   /api/media?key=<ADMIN_TOKEN>   multipart/form-data，字段名 file（可重复）
GET    /api/media/m/<日期>-<随机>.<扩展名>   公开，可长缓存
DELETE /api/media/m/<...>?key=<ADMIN_TOKEN>
```

- **`--kv=MEDIA` 本地开发必须显式加**。`wrangler.toml` 里的 `[[kv_namespaces]]`
  只管**部署**；本地 dev 的绑定是靠命令行标志给进去的（D1 也是同理，一直传着 `--d1=DB`）。
  少了它 `env.MEDIA` 是 `undefined`，上传返回 503。
- **`[[key]]` 捕获到的是数组**（`["m","20260918-xxx.png"]`），不是字符串。
  直接当字符串用会得到 `"m,20260918-xxx.png"`，读回来永远 404。见 `_media.js` 的 `keyFromPath`。
- **不要拆成 `media.js` + `media/[[key]].js` 两个文件**。`[[key]]` 这个 catch-all
  连 `/api/media`（零段）也会匹配，于是同一个路径被两个文件抢，Pages 按
  「先匹配到的路由没有这个方法就往后找」来兜 —— POST 落到 `media.js`、GET 落到 `[[key]].js`。
  能跑，但依赖的是没写进文档的路由顺序。合成一个文件就没这个问题。
- **白名单按 Content-Type 判，不按扩展名**。扩展名是上传方随便写的。
  名单里**故意没有 SVG** —— 它能内嵌脚本，而素材是同源的。
- 单文件上限 图片 10MB / 视频 20MB（KV 单值 25MiB 留余量）。这是**防呆**，
  不是「推荐规格」；推荐体积（图 ≤800KB、视频 ≤1.5MB）写在后台的规格块里。
- **浏览器里先压一遍再传**：长边压到 1600px、jpeg q0.86。手机直出 4032×3024 的
  11.4MB 照片 → 1600×1200 的 612KB（实测 0.5 秒）。压完比原图大就不压（已经压过的高质量图很常见）。
  GIF 不碰（canvas 重编码会把动图压成静图）。
- **平均色**：`drawImage(img,0,0,1,1)` 到 1×1 canvas 再读那个像素，等价于求平均色。
  `imageSmoothingQuality` 必须给 `"high"` —— `low` 是抽样不是平均，取出来会明显偏一边。
  Photo Stack 的每张照片靠这个自动填阴影底色。
- **Cache API 必须显式用**：Pages Functions 的响应默认不进边缘缓存，光写 `Cache-Control`
  只是告诉浏览器。而每次读 KV 都算一次「读」，首页一轮画廊 + Photo Stack 就是十几次读，
  10 万次/天的免费额度撑不住几千次访问。所以 `caches.default` 手动缓存，
  写缓存走 `waitUntil` 别挡响应。
- key 里带**随机段**（`crypto.getRandomValues`，不是 `Math.random`），
  所以「换素材 = 换 key」成立，`immutable` 长缓存才站得住，也不会被人猜出文件名。

### 控件（`assets/site-admin.js` 的 `SCHEMA`）

`SCHEMA` 是唯一的字段定义处，加一个参数只要在对应 group 里加一行。
字段类型：`slider`（range + number 双向同步）、`toggle`、`select`、`color`（色板 + hex 输入）、
`text`、`image`（带缩略图）、`list`（增删 + 上下移 + 缩略图）、`note`（只读说明块，不绑数据）。
点号路径（`spring.duration`）可写嵌套。

`list` 是通用的，靠 `spec.newItem` 决定新增项的模板、`spec.unit` 决定量词
（画廊用「项」、照片用「张」）；列表项字段支持 `text` / `select` / `color`。

`list` 自带上传：列表头有「＋ 上传」（多选），整个列表是拖放区（拖文件进来就传），
每项的缩略图本身是个 `<button>`，点它只换那一项。上传后：
`src` 一定填，`title` 取文件名（只有这个列表声明了 `title` 才填），
`color` 取图的平均色（同理，只有 `newItem` 里有 `color` 才填）。
**替换**某项时，`color` 只在它还是 `newItem.color` 默认值时才覆盖 ——
不然上传一张新照片会把用户调好的阴影色调冲掉。

**规格要求要写在面板里，不能只写在文档里** —— 改配置的人就在这个页面上。
画廊的「视频」分组顶上就有一块 `note`：格式 / 分辨率 / 比例 / 时长 / 体积 / 音轨。
里面的数字是实测的（卡片在默认参数下最大约 380×270），不是拍的。
上传的硬上限（图 10MB / 视频 20MB）是**防呆**，跟这个「推荐规格」不是一回事，别混。

### 几何不能写死 px

**画廊**踩过这个坑：第一版把半径 / 卡片尺寸写成固定 px，换到 classic 的 900px 窄栏就崩了
（只有 ±1 张卡可见，卡片巨大且扁平）。现在一律「给比例，从容器宽度反解」：

```
画廊： r = (W/2)·(CAM + 1 - cos θ)/(CAM · sin θ)     CAM = 2.2
       卡片宽 = r · θstep（弧长）→ 卡片正好首尾相接
```

后台里的 `perView` / `angleStep` / `aspect` 是比例参数，不是 px。
改 `assets/showcase.js` 的 `layout()` 之前先读那段推导注释。

**Photo Stack 走另一条路**：原版几何就是固定 px，照搬才是「对齐原版」。
所以它在最外层套了一个 `scale()`（系数由 `.a377-ps-inner` 的宽度算出，clamp 到 0.35–1），
`.a377-ps-fit` 的宽高由 JS 按缩放后的尺寸写死 —— **光缩 `transform` 不改布局盒，
会在页面上留一块空白**（这条有断言盯着）。
量可用宽度要用 `inner.clientWidth` 而不是 `ps.clientWidth`：
后者是「内容 + padding」，会把左右 padding 多算进去，窄屏上正好溢出那么多。

### 画廊支持视频（图片 / 视频混排）

原版 DialKit 画廊用的就是 22 个 `<video>`，所以我们这边也得支持。

- **判定要两边一致**：显式 `type` 优先（`image` / `video`），否则按扩展名猜
  （`mp4 / m4v / webm / ogv / ogg / mov`）。后台（`site-admin.js` 的 `itemIsVideo`）
  和前台（`showcase.js` 的 `isVideo`）各有一份，不一致就会出现
  「后台标着视频、前台渲染成图片」，很难查。
- **播放预算**：一圈会复制成二十多张卡，视频全播会把带宽和 CPU 吃光。
  策略是只播**离正前方最近的 `videoMaxPlaying` 个**，其余 `pause()` 停在首帧。
  排序按环转角节流（转过 0.5° 才重排），不是每帧重排。
- **`IntersectionObserver` 停掉 rAF 之后 `paint()` 就不会再跑** ——
  视频必须在 observer 回调里**显式暂停**，否则滚出视口后还在后台播。
- **复制卡懒加载**：`videoPreload !== "none"` 时副本也带 `src`；
  设成 `"none"` 时让副本保持无 `src`（副本大部分时间在背面，
  而 `.a377-gal-card` 有 `backface-visibility:hidden`，所以是安全的）。

### 出血带 vs 普通块

`.a377-showcase` 是展示带的底（深色背景 + 上下 padding）。**它本身不裁切**。
画廊额外挂 `.a377-showcase-bleed`（`overflow:hidden` + 左右渐隐），因为一圈 3D 卡片
两侧本来就会飞出容器，必须裁。

**Photo Stack 绝对不能挂 bleed** —— 背片要探出正片右缘（默认错位 239px，比容器预留的 180 还多），
被裁掉就等于没有背片（这个 bug 真发生过：截图里背片整个消失，
断言查不出来，因为 transform 和尺寸都对）。

原版是靠 `clip-path: inset(-100px -200px 0 0)` 处理这个矛盾的：
**照片层只在左边缘和下边缘裁**（出场动画往左滑出去要切干净），
右侧放行 200px 给背片；阴影层则完全不裁（模糊本来就要溢出去）。

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
- **展示组件：`overflow:hidden` 不能无脑套** —— 画廊需要它（卡片飞出容器要裁），
  Photo Stack 需要它**不**生效（背片要探出去）。见上面「出血带 vs 普通块」。
- **后台管理页的 `.panel` 必须带 `contain:paint`** —— 面板是个滚动容器
  （内容 5000+px，视口 900px），但它的溢出会一路传到文档层：
  实测 `body` 只有 900px，`documentElement.scrollHeight` 却是 5088，页面能往下滚
  4188px 的**空白**。于是鼠标停在左侧预览 iframe 上滚滚轮时，iframe 滚到底后
  滚动链传给父文档，整个后台被滚出视口、满屏空白，按 End 也回不来。
  `overflow:hidden` 治不了（根元素上的 hidden 只禁用户滚动，程序化仍可滚，
  而且窄屏布局本来就该整页滚）；`grid-template-rows:minmax(0,1fr)` 也没用。
  实测只有 `contain:paint` 有效，且两种宽度下都正确。
  **这类问题断言默认查不出来** —— 现在有两条断言盯着（程序化 + 真实滚轮）。
- **`_lib.js` 的 `json()` 是 `(data, init)`，不是 `(data, status)`** ——
  写 `json(x, 404)` 会把 404 当成 `init` 展开（数字展开成空对象），**状态码静默变成 200**。
  错误一律走 `fail(msg, code)`。这个坑在 `media/[[key]].js` 上真踩过一次，
  表现是「所有错误都返回 200」，测试里一眼能看出，但肉眼扫代码看不出来。
- **`[[key]]` 这类 catch-all 参数是数组**，不是字符串。见上面「素材上传」。
- **`wrangler pages dev` 的绑定靠命令行标志，不靠 wrangler.toml** ——
  本地起服务要 `--d1=DB --kv=MEDIA`；少了 `--kv=MEDIA` 时 `env.MEDIA` 是 `undefined`，
  启动日志的绑定列表里也不会有它（**看那行列表就能确认**），上传返回 503。
- **同一个端口起了两个 wrangler 会留下两个 `workerd` 一起监听** ——
  `netstat` 里能看到两行同一个端口，请求时通时不通，`npx` 的父进程被杀掉后
  `workerd` 仍活着。要清就按进程树清（先找 `npx wrangler` 的 PID，再往下杀
  `workerd.exe`），或者直接换端口。
- **`gh` 是原生 Windows 程序，不认 Git Bash 的 `/tmp/...` 路径** ——
  `--notes-file /tmp/x.md` 会报「找不到文件」，要 `cygpath -w` 转一下。
- **`documentElement.scrollHeight` 和 `body.scrollHeight` 会不一致** ——
  排查「页面为什么能滚出空白」时两个都要看，只看 `body` 会以为没问题。
- **`ffmpeg` 是原生 Windows 程序，不认 Git Bash 的 `/c/...` 路径** ——
  拿 `/c/Users/...` 当输出路径会报 `No such file or directory`（目录明明存在）。
  脚本里要用 `cygpath -w` 转一下，见 `tests/gen_showcase_video.sh` 的 `winpath()`。
- **视频缩略图的 `src` 要加 `#t=0.1`** —— 不加的话 `<video>` 不渲染首帧，
  后台列表里视频项就是一块黑（图片没这个问题）。
- **`<video>` 要自动播放必须 `muted`**，而且 `play()` 返回 Promise 会被策略拒绝，
  一定要 `.catch()` 掉，否则控制台一堆 unhandled rejection。
- **后台预览靠 `postMessage`，必须校验 `e.origin`**，否则任何嵌入页面都能改预览。
- **`structuredClone` 在 Workers 里别用** —— 可用性不确定，用
  `JSON.parse(JSON.stringify(x))` 深拷贝。
- **管理页注入配置时把 `<` 转成 `\u003c`** —— 配置里出现 `</script>` 会把脚本标签截断。
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

低对比度扫描目前有 8 处已知历史遗留（`home` 的 `drag the letters` 提示、
`code0` 页脚小字、`trips` classic 皮肤的 `邀请 TA` 按钮和 `.delta .d` 等），
都不影响判定，也不是展示组件引入的。

要**人眼确认视觉效果**（断言查不出来的「看着不对」），跑这个出对照图：

```bash
cd tests && node skin-compare/gen.mjs
```

它把 6 个页面 × 3 种状态（classic 浅色 / classic 深色 / one）截成一张对照页，
输出 `tests/skin-compare/index.html`。截图和对照页都是生成产物，已在 `.gitignore` 里。

改了**首页展示组件**（画廊 / Photo Stack / 后台管理页）之后跑这个。
它需要先起本地服务（展示组件依赖 D1，静态服务器不够）：

```bash
cd web && npx wrangler pages dev public --d1=DB --kv=MEDIA --persist-to .d1dev --port 8791 &
cd tests && node test_showcase.mjs http://127.0.0.1:8791 <ADMIN_TOKEN>
```

覆盖 125 项：接口鉴权与结构、画廊渲染与 3D 几何、视频播放调度、
切皮肤后搬移、**响应式回归**（卡片尺寸必须随容器宽度等比变化，防止有人再写死 px）、
Photo Stack 的几何与换片动画、**素材上传**（类型/体积/空文件/路径穿越都挡住、
读回来字节一致、后台拖图真上传且压缩真跑了、视频真的渲染成 `<video>`）、
后台面板（含「不能有幽灵滚动区」）。
跑完在 `tests/out_showcase/` 留四张截图（`01`–`04`）。
调试时手动截的图也放这里（`05` 起），它们不会被测试覆盖，看的时候别搞混。

上传那几条断言是**在浏览器里现场造图**再拖进去的（2400×1600 的噪点 JPEG）——
用噪点不用纯色是有意的：纯色 jpeg 会压到几 KB，「压缩到底跑没跑」就测不出来了。
视频用仓库里那个真的 `v1.mp4`，不是造的假字节。
测试结束会把 photostack 恢复成默认关闭、并删掉自己上传的素材，所以可以反复跑。

> 断言查不出「好不好看」。改完视觉**一定要打开截图看**：
> 画廊背片是否可见、Photo Stack 的背片有没有被裁掉，这两类问题断言全绿也会发生。
> 截图前记得 `scrollIntoView()` —— Photo Stack 在首屏下方，
> 不滚过去 `boundingBox()` 给的是视口外坐标，鼠标移上去什么都不会发生（踩过）。
> 元素级截图用 `elementHandle.screenshot()`：`page.screenshot({clip})` 的 clip 是
> **文档坐标**，而 `getBoundingClientRect()` 是视口坐标，直接拿来裁会裁错位置（踩过）。

