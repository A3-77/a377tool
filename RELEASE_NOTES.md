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
