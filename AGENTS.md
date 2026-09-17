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

## 已知的坑（别重复踩）

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
