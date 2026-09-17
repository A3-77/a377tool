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
