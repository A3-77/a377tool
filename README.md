# a377tool

<https://a377.xyz> 上的四个入口，共用 `web/public/assets/` 下的设计令牌和主题：

| 路径 | 是什么 | 需要登录 |
| --- | --- | --- |
| `/` | **门户首页** —— 进入文件、生图、见面三个模块 | 否 |
| `/file/` | **文件工具箱** —— PDF 转图片、重排页面、合并、拆分、ncm 转音频 | 否 |
| `/trips/` | **周末去哪见面** —— 两个人一起挑见面的中间城市 | 是 |
| `/draw/` | **生图** —— 两个绘图工作台，支持文生图 / 图生图 / 批量 | 否 |

所有页面都有**浅色 / 深色主题**，共用 `assets/theme.js` 和 `localStorage` 的 `a377theme` 键——切一次全站都变。
首次访问跟随系统设置；顶栏和通用组件由 `assets/shell.js` 统一注入。

版本更新记录见 [RELEASE_NOTES.md](RELEASE_NOTES.md)。

---

## 文件工具箱（`/file/`）

纯浏览器实现，**文件不上传任何服务器**。

| 功能 | 说明 |
| --- | --- |
| PDF 转图片 | 每页导出成 PNG / JPG，可选 DPI（72–600）和页码范围 |
| 重排页面 | 拖缩略图调整页序，支持反向、重复页 |
| 合并 PDF | 多个 PDF 按指定顺序拼成一个 |
| 拆分 PDF | 按页码范围拆成多份，如 `1-3;4-6;7-` |
| ncm 转音频 | 网易云音乐的 `.ncm` 还原成 mp3 / flac，自动写标签和封面 |

单文件时不打包 ZIP——只转 1 页就直接给图片，多页才列出每张单独下载。

技术栈：pdf.js（渲染）+ pdf-lib（页面操作）+ 手写的 AES-128（ncm 解密）。
**全部离线自包含**，vendor 目录里是本地副本，不依赖任何 CDN。

---

## 周末去哪见面

给异地见面的两个人用的：各自表态想去哪，系统算出对双方都合适的中间城市，
配上高铁时长和地图。

- 注册需要审批（防陌生人注册）
- 每个行程可以反复讨论、改期、定案
- 有地图视图，支持示意图 / 高德切换
- 邀请链接把日期、表态、空闲日和权重编码在 `#s=...` 里，线上登录后也会导入，不依赖服务器
- 接口按归属校验：新行程归属创建者 user id，旧数据兼容 seat；列表、详情、修改、删除都会校验

技术栈：单文件前端 + Cloudflare Pages Functions + D1（SQLite）。

> 内置测试账号：`南京` / `111`、`黄石` / `222`。上线前建议改掉。

---

## 生图

`/draw/` 下两个绘图工作台，都是单文件前端：

| | Right Code 绘图工作台 | Code0 图片工作台 |
| --- | --- | --- |
| 路径 | `/draw/studio/` | `/draw/code0/` |
| API Key | **内置在前端 JS 里** | **存在服务端环境变量** |
| 接口 | 浏览器直连 `rightapi.ai` | 经 `/api/code0/*` 代理到 `code0.ai` |
| 功能 | 单张 / 批量、1K / 2K / 4K | 文生图 / 图生图 / 批量队列，6 个模型 |

Code0 那个是从本地的 `code0_web.py`（Python 本地服务）改造来的：它的后端逻辑搬到了
Pages Functions，API Key 从环境变量 `CODE0_API_KEY` 读，**前端源码里看不到**。

> ⚠️ Right Code 那个的 key 是内置在页面里的（按需求保留）。公开站点的源码谁都能看，
> 介意的话建议换成服务端代理。

本地版仍在桌面：`glmyytest\图片工作台.bat`（双击启动，端口 8765）。
`/draw/` 落地页底部有启动说明和一个探测按钮。

---

## 目录结构

```
.
├── web/                        ← 部署到 Cloudflare Pages 的完整项目
│   ├── public/                 静态资源（部署目录）
│   │   ├── index.html          门户首页
│   │   ├── file/index.html     文件工具箱
│   │   ├── assets/             共享 tokens / theme / shell / ZIP
│   │   ├── favicon.svg
│   │   ├── vendor/             pdf.js、pdf-lib、标准字体
│   │   ├── draw/               生图（index / studio / code0）
│   │   └── trips/index.html    周末去哪见面
│   ├── functions/api/*.js      后端接口 → 自动变成 /api/*
│   ├── schema.sql              D1 建表语句
│   └── wrangler.toml           D1 绑定配置
│
├── pdf2img/                    本地版工具箱（跑本机 Python，功能更全）
├── tests/                      测试脚本与素材
└── 在线版部署说明.md            重新部署的步骤和踩过的坑
```

**为什么还留着 `pdf2img/`**：本地版能处理超大文件（几百页 / 600 DPI），
在线版受浏览器内存限制。另外本地版不依赖网络，隐私上更放心。

---

## 部署

**已接 GitHub 自动部署**：推到 `main` 分支，Cloudflare Pages 自动构建上线，约 1 分钟。

| 配置项 | 值 |
| --- | --- |
| Git 仓库 | `A3-77/a377tool`（私有） |
| 生产分支 | `main` |
| 根目录 | `web` |
| 构建命令 | 空（纯静态，不需要构建） |
| 输出目录 | `public` |

推送其他分支会生成**预览环境**（独立 URL），不影响线上——想先试效果就推别的分支。

手动部署（应急用，平时不需要）：

```bash
cd web
CLOUDFLARE_API_TOKEN='<令牌>' CLOUDFLARE_ACCOUNT_ID='<账户ID>' \
  npx --yes wrangler@latest pages deploy public \
  --project-name=a377tool --branch=main --commit-dirty=true
```

> ⚠️ 接了 Git 之后**别再手动部署** —— 两个来源都在部署会让线上版本和仓库对不上。
> 真要手动，只在 Git 挂了的紧急情况下用，之后记得让两者重新对齐。
>
> 另外别用 curl 直接调 Pages 上传 API —— 那是两段式的，会返回 success 但访问 500。

---

## 本地预览

```bash
cd web
npx wrangler pages dev public --d1=DB --persist-to .d1dev --port 8789
```

必须走 wrangler（要跑 Functions 和 D1），不能用 `python -m http.server`。

只想看静态页（门户 / 文件 / 生图落地页 / 绘图工作台）的话，`cd web/public && python -m http.server 8899` 也行；见面页要后端和 D1，必须走 wrangler。

---

## 测试

```bash
cd tests

node aes128.mjs            # AES 是否符合 FIPS-197 标准向量
node ncm_web.mjs           # ncm 解密是否与 Python 版逐字节一致
node test_web_pdflib.mjs   # pdf-lib 的合并 / 拆分 / 重排逻辑
node test_web_pdfjs.mjs    # pdf.js 的解析链路
node test_web_render.mjs   # 真实 canvas 渲染（依赖见下）
node test_cloud_flow.mjs   # 线上云端流程（登录 → 拉行程 → 新建 → 登出）
python test_api.py         # 本地版后端接口（需先启动服务）
```

`test_cloud_flow.mjs` 打的是**线上真实站点**（`https://a377.xyz`），用 Node 的 `fetch`
和真实 cookie 模拟浏览器行为，覆盖了「带 cookie 拉行程」这个曾经崩掉的环节。
**它会在云端建一条测试行程，跑完记得删掉。**

`test_web_render.mjs` 需要 `@napi-rs/canvas`。**`tests/` 里已经装好了**（有自己的
`package.json` 和 `node_modules`）。

> ⚠️ 如果要重装，**必须先确认 `tests/package.json` 存在**再 `npm install`。
> 否则 npm 会一路向上找到别的 `package.json`，把包装到那个目录去——
> 我踩过一次，装到你主目录去了。

`test_web_render.mjs` 会打印**墨迹占比**（非白像素比例）——这是判断"到底画没画上去"的
可靠指标，光看有没有报错是不够的：

| 样本 | 墨迹 | 说明 |
| --- | --- | --- |
| `embedded_font.pdf` | ~1.9% | 字体已嵌入，正常 |
| `A.pdf` | 0% | 用标准字体但没嵌入，Node 里 pdf.js 加载不了 `standardFontDataUrl` 的字体 |

**`A.pdf` 那个 0% 是 Node 环境的已知限制，不是 bug**——浏览器里 pdf.js 走 HTTP 取字体，
没这个问题。所以验证渲染链路要用 `embedded_font.pdf`。

---

## 几个技术点

**ncm 解密是纯 JS 手写的**，因为 Web Crypto 不支持 ECB 模式。AES-128 用 FIPS-197
标准测试向量验证过；音频流的 RC4 变体按 256 字节周期打包成 32 位字加速。

**PDF 渲染必须配 `standardFontDataUrl`**。PDF 里用 Helvetica 这类标准字体又没嵌入时，
pdf.js 需要本地替代字体，不给的话**文字会静默消失**（图形正常，只有字不见）。

**见面地的地图区域在浅色主题下也保持深色**。地图本来就适合深底，而且这样能避开
改一大批写在 JS 里的 SVG 绘图颜色。

**`.bat` 文件是 GBK 编码且不切代码页**。cmd 按字节偏移读 bat，用 `chcp 65001` 切代码页
会让后续行错位，报出完全看不出根因的错。

---

## 许可

个人使用。ncm 解密部分仅供备份自己已下载的音乐，别拿去传播受版权保护的内容。
