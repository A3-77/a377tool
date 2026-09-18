# 视频资产管线

把任何视频变成某个**档位**要求的规格。独立层，不依赖站点、也不依赖任何展示组件。

```
web/public/assets/video-spec.js    档位定义 + 判定（浏览器 / Node / 测试三端共用）
web/public/assets/video-prep.js    网页端处理引擎（浏览器自带编码器）
tools/video-prep/ffmpeg.mjs        ffmpeg / ffprobe 封装
tools/video-prep/cli.mjs           命令行工具
```

## 为什么分成两层

「什么算合规、该缩到多大」和「怎么把它变成那样」是两件事。

判断只写一次（`video-spec.js`），三条执行路径都消费同一份结果：

| 路径 | 什么时候用 | 代价 |
| --- | --- | --- |
| **网页端**（后台自动） | 默认。拖进后台就处理，不用装东西 | 实时 —— 8 秒片段约 8 秒出结果 |
| **命令行**（本地 ffmpeg） | 批量、要最高画质、要精确控体积、浏览器解不开的编码 | 要在本机装 ffmpeg |
| 以后可能的第三条 | 换了别的视频组件、或者上了服务端转码 | —— |

判断和执行要是各写一份，迟早会不一致 —— 用户会遇到「命令行说合规、后台说超了」这种事。

## 档位

档位按**用途**命名，不按组件命名：组件会被换掉，用途不会。

| 档位 | 用途 | 长边 | 比例 | 时长 | 体积 | 音轨 |
| --- | --- | --- | --- | --- | --- | --- |
| `loop-card` | 卡片循环（弧形画廊在用） | 720 | 1.5:1 | 3–8 秒 | ≤ 1.5 MB | 去掉 |
| `inline` | 内嵌播放（暂无使用者） | 1280 | 原比例 | 1–120 秒 | ≤ 8 MB | 可留 |

组件只声明自己用哪个档位 —— 在 `site-admin.js` 里就是 `VIDEO_PROFILE` 那一行。
换组件改这一行，管线代码一个字都不用动。

```js
const V = require("./web/public/assets/video-spec.js");
V.analyze(meta, "loop-card");
```

## 服务端硬上限 ≠ 档位

两件事，别混：

- **硬上限** 20 MB —— KV 单值 25 MiB 留的余量，超了接口直接 413，**不可协商**
- **档位** ≤ 1.5 MB —— 组件的要求，是「好不好用」的问题

档位再宽松也越不过硬上限，所以 `analyze` 两个都查。
硬上限必须和 `web/functions/api/_media.js` 的 `MAX_VIDEO` 一致 ——
测试会解析那个文件来断言，防止两处悄悄漂移。

## 命令行

```bash
node tools/video-prep/cli.mjs profiles                  # 看有哪些档位
node tools/video-prep/cli.mjs probe   <文件...>          # 只看信息
node tools/video-prep/cli.mjs judge   <文件...>          # 判定，不改文件（不合规退出码 1）
node tools/video-prep/cli.mjs fix     <文件...>          # 处理成合规文件
```

常用参数：

```bash
--profile loop-card        用哪个档位
--out <目录>               输出目录，默认 <原文件同目录>/prepped
--local                    输出到 web/public/assets/showcase/（直接进仓库）
--upload                   处理完直接传到线上 KV（配 --base / --token）
--trim 2-9                 截取第 2 到 9 秒
--target-size 300KB        目标体积
--max-edge 480 --aspect 1  改尺寸和比例
--keep-audio               保留音轨
--poster                   顺便导出一张封面
--dry-run                  只打印 ffmpeg 命令
--json                     输出 JSON
```

处理完会**真的把所有帧解一遍**确认文件没坏 —— 编码成功不代表文件完整。

批量 + 直接上线：

```bash
node tools/video-prep/cli.mjs fix ~/照片/2026/*.MOV \
  --profile loop-card --upload \
  --base https://a377tool.pages.dev --token <ADMIN_TOKEN>
```

## 网页端

后台拖视频进来时会自动处理：改尺寸、截片段、压体积、去音轨，然后把「改了什么」写在提示里。

用的是浏览器**自带**的编码器（`<video>` 解码 → canvas 缩放裁剪 → `MediaRecorder` 录制），
没有用 ffmpeg.wasm，原因是硬的：

> Cloudflare Pages 单个文件上限 25 MiB，而 `@ffmpeg/core` 的 wasm 就 30+ MB，
> 根本传不进部署产物；改从 jsdelivr / unpkg 拉，国内又不稳。

浏览器自带编码器的代价是**实时** —— 转 8 秒要 8 秒。但档位本来就只要 3–8 秒的片段，
这个代价正好可以接受；解码是硬解的，拖 200MB 的 4K 手机视频进来也不吃力。

### 网页端的限制（说清楚，别让人踩空）

- **浏览器解不开的编码做不了**：HEVC / ProRes 之类。后台会明确告诉你，那种要走命令行
- **码率是目标值不是精确值**：`MediaRecorder` 会上下浮动，所以压完会复核体积，超了就降码率重来一次
- **帧率会略低于请求值**：请求 24fps 实测约 20fps（canvas 抓流按刷新率采样）。画面速度是对的，只是帧少一点
- **没有 faststart 那套**：输出是分片 mp4，没有 moov 前置的概念。实测浏览器能正常读时长、能循环
- **看不到音轨信息**：浏览器没有对应 API，所以判定里不会报「带音轨」。但要求静音的档位一律不录音轨，结果是对的

## 判定与执行必须一致

`analyze()` 返回的 `ok` 和 `worthFixing` 是一回事：

> `judge` 说合规 ⟺ `fix` 不会动手

不一致的话，用户看到「合规」却被打包重编一遍，就不敢信这个工具了。

同理，`issues` 的等级和「会不会动手」对齐：

- `hard` —— 服务端会拒（体积超硬上限、容器不支持）→ 会处理
- `warn` —— 档位不符（尺寸、体积、时长、比例、帧率、编码）→ 会处理
- `info` —— 只是提示，**不触发**处理。音轨在这里：留着不影响功能，
  只有因为别的原因本来就要重编时才顺手去掉

## 容差

编码器不可能精确停在某一帧上，所以有两处刻意的余量：

| 项 | 值 | 为什么 |
| --- | --- | --- |
| 时长 | ±0.5 秒 | ffmpeg 能出 8.000，浏览器实测到 8.3。为 0.3 秒判「不合规」没意义 |
| 帧率 | ×1.15 | 为把 25fps 降到 24 而重编一整遍，省 4% 的帧却掉一次画质，这笔账是亏的 |

## 测试

```bash
cd tests && node test_video_prep.mjs
```

三段：档位模块纯函数、命令行真跑 ffmpeg、网页端在无头 Chrome 里真转码
（产出物落盘后用 ffprobe 独立复核）。
