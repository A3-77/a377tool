# A377Tool v0.6.0

发布日期：2026-09-18

本版给首页加了两块**后台可控**的展示组件，并补上一套不依赖 React 的实时调参后台。

## 新功能

**1. 弧形画廊（默认开启）**

一圈卡片排在一个圆柱面上，自动旋转，可以按住拖动。卡片从容器宽度反解几何，
所以换屏幕宽度不会跑偏 —— `perView` / `angleStep` / `aspect` 都是比例参数，不是像素。

**2. Photo Stack（默认关闭，后台一键打开）**

一张主照片，后面压一张错位的背片，悬停时背片按弹簧推开、压暗层变淡。
弹簧是真解微分方程（半隐式欧拉，`bounce` 换算成阻尼比），不是 CSS transition 近似。
触屏没有 hover，自动退化成点按切换。

**3. 展示组件后台**

`/api/site-admin?key=<ADMIN_TOKEN>`，管理页里新增「展示组件」入口。
左侧是首页实时预览（`postMessage`，不落库），右侧按控件渲染表单，
图片内容、视觉参数、显示开关都能改。

控件体系借了 [DialKit](https://www.dialkit.dev/) 的分类（slider / toggle / select /
color / image / spring / folder），但**没有引入它的依赖** —— DialKit 是 React 库，
而这里是纯静态 HTML + Pages Functions，没有 React、没有构建步骤。
照搬的是它的心智模型，实现是自己写的，参数落 D1。

## 数据

新增 `site_blocks` 表（`kind` / `enabled` / `config` JSON / `updated_at`），
首次请求幂等建表并种下默认值，不需要手工跑 SQL。

- `GET /api/site` —— 公开，只返回启用的组件，前台据此渲染。
- `GET /api/site-admin` —— 控制面板（`ADMIN_TOKEN` 鉴权）。
- `POST /api/site-admin` —— 保存；也可以只传 `{ enabled }` 来只翻开关、不动配置。

## 修复

- **画廊第一版把半径和卡片尺寸写死了 px**，换到 `classic` 的 900px 窄栏后
  只有 ±1 张卡可见，卡片巨大且扁平。改成从容器宽度反解后，两种皮肤下
  卡片占容器的比例一致。
- **Photo Stack 的背片被容器裁掉了**，截图里整个消失（断言全绿也查不出来，
  因为 transform 和尺寸都对）。根因是给画廊做的 `overflow:hidden` + 左右渐隐
  被无差别套在了展示带上。现在这层拆成 `.a377-showcase-bleed`，只有画廊挂。
- 背片探出的空间按 `offsetX / offsetY / scale` 算出来并预留，
  否则要么被裁、要么悬停时溢到展示带外面。
- 背片默认压暗层从 0.58 降到 0.32 —— 原来那张背片被压得全黑，等于没有背片。

## 验证

新增 `tests/test_showcase.mjs`，50 项断言：

```bash
cd web && npx wrangler pages dev public --d1=DB --persist-to .d1dev --port 8791 &
cd tests && node test_showcase.mjs http://127.0.0.1:8791 <ADMIN_TOKEN>
```

覆盖接口鉴权与返回结构、画廊 3D 几何、切皮肤后组件搬移、
**响应式回归**（卡片尺寸必须随容器宽度等比变化）、Photo Stack 的弹簧收敛与背片可见性。

> 断言查不出「好不好看」。本版两个真实视觉 bug（背片被裁、背片被压黑）
> 都是**看截图**发现的，断言当时全绿。改视觉一定要打开 `tests/out_showcase/` 里的图。

## 兼容性

- 新增 D1 表，首次请求自动建，不需要手工迁移。
- 本地开发要 `web/.dev.vars`（模板见 `web/.dev.vars.example`），
  里面是 `SESSION_SECRET` 和 `ADMIN_TOKEN`，已在 `.gitignore` 里。
- 展示组件不依赖 D1 之外的任何新服务；D1 不可用时画廊不渲染，首页其余部分正常。

---

# A377Tool v0.5.0

发布日期：2026-09-18

本版重做双皮肤机制。v0.3 / v0.4 的皮肤切换是坏的 —— 既没有把 v0.2 的原版还回来，
切过去也没反应。根因是当时把皮肤实现成了「一层全局覆盖」，而不是「两套并列样式」。

## 修复

**1. `classic` 现在真的等于 v0.2**

- `/` 和 `/draw/` 的 `classic` 视图换回 v0.2.0 的原始结构和样式，逐行还原。
- 之前 `assets/classic.css` 里的那套 `.classic-card` / `.classic-eyebrow` 布局是新写的近似版，
  跟 v0.2 不是一回事，已删除。
- `/` 和 `/draw/` 补回 `tokens.css` / `theme.js` / `shell.css` / `shell.js`，
  顶栏和浅色 / 深色主题回来了（v0.3 重写这两个页面时把它们一起删掉了）。

**2. 切到 `classic` 没反应 —— 两个原因都修了**

- `shell.js` 建完顶栏会调 `A377Skin.refresh()`（不带参数）。旧代码把 `undefined`
  当成皮肤值处理，于是**每个有顶栏的页面加载时都会把皮肤偏好重置掉**，
  `classic` 永远切不过去。现在非法值会保持当前皮肤不动。
- 顶栏里的 `SKIN` 按钮从来就没绑过点击事件（`shell.js` 用 `innerHTML` 造按钮，
  `skin.js` 只给自己创建的悬浮按钮加了监听）。改用事件委托。

**3. 覆盖层不再泄漏到 classic**

- `onepage.css` 里有两条规则漏了 `html[data-skin="one"]` 前缀却带 `!important`，
  切到 `classic` 后仍然生效，把卡片强制成白底黑边方角 —— 深色主题下就是一块块白板。已补前缀。
- 更彻底的一层：`onepage.css` 现在只在那四个工作台页挂
  `<link id="a377-onepage" … media="not all">`，`skin.js` 按皮肤切 `media`。
  `classic` 下覆盖层完全不参与匹配。顺带 `classic` 下不会去请求这个文件。

**4. `classic` 覆盖面从 2 个页面变成 6 个**

- `classic.css` 之前只在 `/` 和 `/draw/` 被引用，`/file/`、`/trips/`、`/draw/studio/`、
  `/draw/code0/` 切过去没有任何对应样式。这四页的基础样式本来就是 v0.2 的，
  去掉 `one` 的覆盖层即回到原样。

**5. `one` 皮肤的黑底黑字**

- `onepage.css` 把 `--s2` 强制成 `#000`，而 `/trips/` 有 34 处引用它
  （`.vibe` 玩法标签、`.prop` 城市卡片、`.delta`、`.hswitch` …），
  这些元素的文字色是 `--text`(#000) / `--dim`(#333) → 直接看不见。改成浅灰。
- `one` 皮肤现在强制按浅色渲染：这几个页面是深色优先写的，浅色靠
  `html[data-theme="light"]` 覆盖；`one` 皮肤把 `--text` 压成黑色后，
  只要 `data-theme` 还是 `dark` 就会出现黑底黑字（例如 `/trips/` 的「示意图」分段按钮）。
- `one` 皮肤没有深色变体，深浅色开关在该皮肤下自动隐藏。
- 补了几处按深色调的硬编码强调色（`.delta .d`、`.tag.ok/worn/rain`、`.iconbtn.accent`）。

## 行为变化

1. **默认皮肤从 `one` 改成 `classic`。** 老用户打开站点回到 v0.2 的样子。
   想默认走新版，改 `assets/skin.js` 里的 `DEFAULT_SKIN`。
2. 皮肤按钮统一在顶栏右侧。`/` 和 `/draw/` 现在也有顶栏了，不再需要左下角悬浮按钮
   （没有顶栏的页面仍会自动回落到悬浮按钮）。
3. `one` 皮肤下不显示深浅色开关。

## 验证

新增 `tests/test_skins.mjs`：自带静态服务器 + 无头 Chrome，覆盖 6 个页面 ×
2 套皮肤 × 2 个主题，检查皮肤是否生效、`onepage.css` 是否只在 `one` 皮肤加载、
顶栏 SKIN 按钮是否真能切换，并自动扫「深底深字」。

```bash
cd tests && node test_skins.mjs
```

低对比度扫描剩 7 处历史遗留（`home` 的 `drag the letters` 提示、`code0` 页脚小字、
`trips` classic 皮肤的「邀请 TA」按钮 `#9dc0e4` 等），都不是本次改动引入的，未动。

---

# A377Tool v0.4.0

发布日期：2026-09-17

本版修复皮肤切换和地图主题问题。

## 修复

- 皮肤切换按钮在带顶栏的页面移入顶栏右侧，不再悬浮在左下角挡住工作台操作按钮。
- 没有顶栏的 `/` 和 `/draw/` 仍然保留左下角悬浮皮肤按钮。
- 见面地图颜色不再固定深色：
  - SVG 网格、长江、走廊、节点、标签、图例、提示条全部改为 `--map-*` 变量。
  - 浅色主题下地图切为浅色底，深色主题保持深色底。
  - 高德地图会在 `amap://styles/light` 和 `amap://styles/darkblue` 之间切换。
- 主题切换时会自动重绘 SVG 地图并更新高德地图样式。
- `/trips/` 支持 `?local=1` 本地静态预览，不连接后端，方便调试。

---
# A377Tool v0.3.0

发布日期：2026-09-17

本版把整站改造成 One Page Love / Shawn Golden 风格，并加入双皮肤一键切换。

## 新功能

- 全站新视觉：黑白 1px 网格、超大标题、跑马灯、棕色 `#836953` 点缀、硬边框按钮。
- 双皮肤：
  - `one`：新版 One Page Love 风格，默认。
  - `classic`：旧版工具站布局。
- 左下角 `SKIN` 按钮一键切换，偏好保存在 `localStorage.a377skin`，跨页面同步。
- `/` 和 `/draw/` 内置两套布局；文件、见面、绘图工作台通过 `assets/onepage.css` / `assets/classic.css` 切换。
- 新版皮肤覆盖：`/`、`/file/`、`/draw/`、`/draw/studio/`、`/draw/code0/`、`/trips/`。

## 兼容性

- 旧的 `a377theme` 浅色/深色主题和新的 `a377skin` 皮肤互不影响。
- 切到 `classic` 后，文件、见面、绘图工作台回到旧版视觉，功能不变。

---
# A377Tool v0.2.0

发布日期：2026-09-17

本次更新把网站从「单页工具」整理成统一的门户 + 模块结构，并补齐文件工具箱 P3 交互、见面页三个 bug、后端行程归属校验，以及全站共享主题和顶栏。

## 亮点

- **新门户**：`/` 现在是门户首页，文件工具箱移到 `/file/`。
- **全站共享设计系统**：`assets/tokens.css`、`assets/theme.js`、`assets/shell.css`、`assets/shell.js` 统一顶栏、主题和通用组件。
- **文件工具箱 P3 完成**：分组切换、清空结果、取消任务、ncm 汇总 ZIP、大文件重排确认。
- **见面页修复**：
  - 邀请链接签到线上模式后也会导入 `#s=...` 状态。
  - `Cloud.pull()` 不再先清空本地，详情失败会保留本地并报错。
  - 行程接口按归属校验，GET / PUT / DELETE 不能跨账号操作。
- **生图模块**：
  - `/draw/` 落地页接入共享 shell / theme。
  - `/draw/studio/`、`/draw/code0/` 接入共享顶栏，并补了基础深色主题映射。
- **文档**：README、AGENTS、在线版部署说明、本更新说明同步。

## 重要行为变化

1. 文件工具箱入口从 `/` 改为 `/file/`；旧书签请更新。
2. 见面页服务端行程按账号归属：
   - 新行程 `created_by` 写入当前用户 `user.id`。
   - 旧数据 `created_by` 为 `seat` 时仍兼容。
   - 跨人协作继续通过前端 `#s=...` 邀请链接传递状态，不依赖服务端共享同一 trip。
3. 生图工作台开始使用全站顶栏，原页面右下角返回链接仍保留。

## 部署

```bash
cd web
CLOUDFLARE_API_TOKEN='<你的令牌>' CLOUDFLARE_ACCOUNT_ID='5117ffc876a76ef7302775c45a3b6918' \
  npx --yes wrangler@latest pages deploy public \
  --project-name=a377tool --branch=main --commit-dirty=true
```

部署后自检：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://a377.xyz/          # 200
curl -s -o /dev/null -w "%{http_code}\n" https://a377.xyz/file/     # 200
curl -s -o /dev/null -w "%{http_code}\n" https://a377.xyz/draw/     # 200
curl -s -o /dev/null -w "%{http_code}\n" https://a377.xyz/trips/    # 200
curl -s https://a377.xyz/api/me                                     # 未登录 401
```

## 本版验证

- 文件页 / 见面页 / 生图页 / 两个绘图工作台的 inline script 均通过 `node --check`。
- 后端 `trips.js`、`_lib.js` 通过语法检查。
- 用 Chrome headless 对 `/`、`/file/`、`/draw/`、`/trips/`、`/draw/studio/`、`/draw/code0/` 做了 DOM 和截图自检。
