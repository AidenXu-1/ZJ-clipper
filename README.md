# Nomo Clipper

<p align="center">
  <img src="./public/icon/128.png" width="96" alt="Nomo Clipper 图标" />
</p>

<p align="center">
  <a href="https://github.com/lihua2003419-cmyk/Nomo-clipper/releases/latest"><img src="https://img.shields.io/github/v/release/lihua2003419-cmyk/Nomo-clipper?label=latest" alt="Latest Release" /></a>
  <a href="https://github.com/lihua2003419-cmyk/Nomo-clipper/actions/workflows/ci.yml"><img src="https://github.com/lihua2003419-cmyk/Nomo-clipper/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-personal%20use-orange" alt="Personal Use License" /></a>
</p>

Nomo Clipper 是一款面向中文知识工作流的 Chrome / Edge 浏览器扩展，用来把网页内容精准剪藏成 Markdown，并保存到你的 **Obsidian 仓库**。

它对标 Obsidian 官方 Web Clipper，但更偏向中文内容平台、多站点精准适配、本地图片落地和个人知识库归档。

**核心闭环**：正文提取 → Markdown 转换 → 弹窗预览/编辑 → 保存到 Obsidian。

**产品原则**：只做**精准完整抓取**，不做总结、改写、分类或远程语义处理。抖音仅在用户主动点击后进行本机语音识别，语义整理仍交给 Obsidian 里的下游 agent。

## 功能亮点

- 多平台专属适配，减少通用提取算法带来的侧栏、评论、推荐内容杂质。
- 支持整页正文、选区剪藏、完整滚动抓取、X thread 抓取和网页划词高亮。
- 保存为 Obsidian Markdown，支持 frontmatter、标签、作者、发布时间、来源 URL 等属性。
- 支持 `obsidian://` 零配置保存，也支持 Obsidian Local REST API 写入超长内容与本地图片。
- 支持「一键存入飞书知识库」：用自建应用 + OAuth 授权把剪藏转成飞书文档并放入指定知识库节点；公网图片通常由飞书导入器解析，需登录图片可能受飞书导入能力限制。
- 支持每篇独立文件夹归档、图片随文保存、标签黑名单、常用标签复用、阅读状态标签、按网站自动加标签和暗色主题。
- 支持抖音视频本地语音转字幕：本机 Whisper 识别并生成时间戳，不把视频上传到转录云端。
- 默认不依赖云端服务，剪藏内容在浏览器与用户本地 Obsidian 之间流转；飞书保存为可选上传项，仅在用户主动配置并点击保存后生效。

## 支持的平台

针对这些平台做了专属适配（绕开通用算法的杂质，抓得更准）：

| 平台 | 抓取内容 |
|------|---------|
| 飞书文档 | 完整正文 + 标题/高亮/引用/Callout 转换 + 画板 PNG 截图 + 本地图片下载 |
| B站 | 简介 + 可播放嵌入 + 字幕 + 互动数据 |
| YouTube | 正文 + 字幕 transcript + 可播放嵌入 + 互动数据 |
| 小红书 | 图文/视频笔记 + 图集 + 互动 + 话题标签 |
| X / Twitter | 单条 + 整串 thread + Article 长文 + 外链卡片 + 视频嵌入 + 互动 |
| 微信公众号 | 正文 + 全部图片 |
| Reddit | 帖子本体（不抓评论树）+ 图片/外链 + 互动 |
| 抖音 | 当前视频页面信息 + 可选本地 Whisper 时间戳字幕 |
| 其它网页 | Defuddle 通用提取兜底 |

## 安装

### 普通用户：下载成品包

到 [最新 Release](https://github.com/lihua2003419-cmyk/Nomo-clipper/releases/latest) 下载对应浏览器的 zip：

- Chrome：[直接下载最新版](https://github.com/lihua2003419-cmyk/Nomo-clipper/releases/latest/download/nomo-clipper-chrome.zip)
- Edge：[直接下载最新版](https://github.com/lihua2003419-cmyk/Nomo-clipper/releases/latest/download/nomo-clipper-edge.zip)

这两个最新版直链的文件名保持固定；每次发布新 Release 后会自动指向新的安装包。带版本号的附件继续保留，用于历史归档和复现。

体验包只包含浏览器扩展运行文件。首次安装不预设个人仓库、API Key、飞书凭证或网站标签规则，所有保存目标均由用户自行配置。

下载后先解压 zip，再把解压后的文件夹加载到浏览器。

Chrome：

1. 打开 `chrome://extensions`。
2. 开启右上角「开发者模式」。
3. 点击「加载已解压的扩展程序」。
4. 选择解压后的文件夹。

Edge：

1. 打开 `edge://extensions`。
2. 开启左侧「开发人员模式」。
3. 点击「加载解压缩的扩展」。
4. 选择解压后的文件夹。

### 给 Agent 自动安装

如果你把这个仓库链接交给 Codex、Claude Code 或其它本地 Agent，请让它优先下载最新 Release 中对应浏览器的成品包，而不是直接 clone 源码：

Chrome 用户复制：

```text
请帮我安装这个浏览器插件：
https://github.com/lihua2003419-cmyk/Nomo-clipper

我是 Chrome 用户。请下载最新 Release 里的 chrome.zip，解压后告诉我在 chrome://extensions 里应该选择哪个文件夹加载。
```

Edge 用户复制：

```text
请帮我安装这个浏览器插件：
https://github.com/lihua2003419-cmyk/Nomo-clipper

我是 Edge 用户。请下载最新 Release 里的 edge.zip，解压后告诉我在 edge://extensions 里应该选择哪个文件夹加载。
```

Chrome 和 Edge 都要的用户复制：

```text
请帮我安装这个浏览器插件：
https://github.com/lihua2003419-cmyk/Nomo-clipper

我同时使用 Chrome 和 Edge。请下载最新 Release 里的 chrome.zip 和 edge.zip，分别解压；然后告诉我在 chrome://extensions 里应该选择哪个 Chrome 文件夹、在 edge://extensions 里应该选择哪个 Edge 文件夹加载。
```

推荐顺序：

1. 优先下载最新版成品包：`nomo-clipper-chrome.zip` 或 `nomo-clipper-edge.zip`。
2. 解压 zip。
3. 指引用户在浏览器扩展管理页加载解压后的文件夹。
4. 只有在无法下载 Release 附件、或需要二次开发时，才从源码构建。

浏览器出于安全限制，通常不允许 Agent 静默安装本地扩展；最后的「加载已解压扩展」一般仍需要用户在浏览器里确认。

### 开发者：从源码构建

源码仓库不提交 `.output/`、`.wxt/`、`node_modules/` 等生成物。开发者可以本地构建：

```bash
npm install
npm run build
```

Chrome 构建产物在 `.output/chrome-mv3`。

### 抖音本地字幕

抖音通常不提供可以直接保存的字幕文件，因此 Nomo 使用本机 Whisper 从视频音频生成字幕：

1. 首次双击 `local-transcriber/一键安装本地字幕助手.cmd`，然后在 `chrome://extensions` 重新加载一次 Nomo。
2. 打开抖音视频并播放几秒。
3. 打开 Nomo Clipper，点击「转录抖音字幕」；Chrome 会自动启动本地助手，完成后自动退出。
4. 检查正文里的 `## 抖音字幕`，确认后保存到 Obsidian。

首次转录会通过 `uv` 下载隔离的 Python 环境、Whisper `small` 模型和 NVIDIA 运行库，约需 2–3 GB 空间。Nomo 会优先使用 NVIDIA 显卡，显卡不可用时自动改用 CPU。正常使用不需要保持任何命令窗口开启。

Edge 浏览器可使用：

```bash
npm run build:edge
```

Edge 构建产物在 `.output/edge-mv3`。

## 技术栈

- [WXT](https://wxt.dev)（MV3 框架，内置 Vite + 热更新）
- React + TypeScript
- [Defuddle](https://github.com/kepano/defuddle)（正文提取，Obsidian 原版同款库）+ Turndown（HTML→Markdown）
- 站点适配器注册表：每个平台一个文件，物理隔离，加新平台不影响其它
- 保存通道：Obsidian（`obsidian://` URI 或 **Local REST API 插件**）以及用户自己的**飞书知识库**

## 开发

想继续改代码或让 Agent 接手开发，请先阅读 [`DEVELOPMENT.md`](./DEVELOPMENT.md)。

完整回归范围见 [`docs/TESTING.md`](./docs/TESTING.md)。

```bash
npm install        # 安装依赖
npm run dev        # 开发模式（自动开带扩展的 Chrome，热更新）
npm run dev:edge   # Edge 开发模式
npm run build      # 生产构建，产物在 .output/chrome-mv3
npm run compile    # 仅类型检查
```

发布前建议检查：

```bash
npm run compile
npm run build
python3 -c "d=open('.output/chrome-mv3/content-scripts/content.js','rb').read();print([b for b in d if b>=0x80][:1])"
```

最后一条输出 `[]` 表示内容脚本产物为纯 ASCII，避免 Chrome 在大体积中文内容脚本上出现编码拒载。

版本开发和发布统一通过短期分支、Pull Request、版本标签和 GitHub Release 完成，具体步骤见 [`DEVELOPMENT.md`](./DEVELOPMENT.md#版本管理与发布)。

## 使用

1. 首次：点扩展图标右上角 ⚙ 进设置，选**保存方式**——
   - `obsidian://`（零配置）：填 **Obsidian 仓库名**即可；
   - **Local REST API**（推荐，超长不截断、可存本地图片）：在 Obsidian 装「Local REST API」插件、开 HTTP 服务、把 API Key 填进来。
   - **飞书知识库**：在飞书开放平台建「自建应用」，开通 `offline_access`、`drive:file:upload`、`drive:drive`、`docs:document:import`、`wiki:wiki` 权限，配置重定向 URL 后登录授权，选好目标知识库节点。插件会以用户本人身份保存，用户本人能访问/写入的知识库即可。多套保存目标可在弹窗顶部「保存到」一键切换。
2. 在任意文章页点扩展图标（或快捷键 `Ctrl/Cmd+Shift+S`，或右键「用Nomo Clipper剪藏此页」）。
3. 弹窗中预览/编辑标题、正文、属性（标签为 chip 编辑器）、保存位置，点「保存到 Obsidian」，存完可一键「在 Obsidian 打开」。
4. 选中部分文字后再剪藏，会默认只存选中内容（可切整页）。
5. 长文 / 整串 thread → 点「📜 完整抓取全文」。

支持**暗色主题**（设置页可选跟随系统/浅色/深色）、每篇独立文件夹归档、网页划词高亮、自定义 frontmatter 字段、标签黑名单与常用标签复用。

## 隐私

Nomo Clipper 默认不提供云端服务、不采集用户剪藏内容，也不向第三方上传网页正文、图片、标签或 Obsidian 配置。Local REST API Key 与飞书应用凭证（App Secret / OAuth token）单独保存在当前设备的 `chrome.storage.local`，不会写入 GitHub，也不会通过 `chrome.storage.sync` 随浏览器账号同步。

唯一的对外上传发生在用户**主动选择「飞书知识库」保存方式并配置自建应用后**：此时剪藏内容会上传到用户自己的飞书知识库（用用户自己的应用凭证，直连飞书开放平台，不经过任何第三方服务器）。不选飞书则不发生任何上传。

详见 [`PRIVACY.md`](./PRIVACY.md)。

## 目录结构

```
entrypoints/
  content.ts         内容脚本壳层：消息/高亮UI/诊断；提取委托给适配器注册表
  background.ts      右键菜单 + 快捷键 + 打开 obsidian:// + 跨域下载图片
  popup/             剪藏弹窗（React）
  options/           设置页（React）
utils/
  extractors/        ★站点适配器：bilibili/feishu/xiaohongshu/x/weixin/youtube/reddit/generic + index 注册表
  extract-core.ts    抓取共享层（Turndown/Defuddle 封装、滚动抓取、共享解析工具）
  types/strings/storage/filename/frontmatter/obsidian/rest/images/messaging/highlighter.ts
public/icon/         扩展图标
docs/                接力开发所需的测试与回归文档
```

## 仍在迭代

知乎适配器（探针就位待数据）、微博 / Medium、追加到 Daily Note 等。**不做** AI 摘要/总结；抖音仅提供用户主动触发的本地语音转录。

## 许可

Copyright (c) 2026 Aiden. All rights reserved.

官方编译版允许个人、非商业安装与使用；源码修改、再分发、重新打包和商业使用需要事先获得书面许可。详见 [`LICENSE`](./LICENSE)。
