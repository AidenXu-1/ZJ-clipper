# Development Guide

这份文档给想继续开发兆基clipper的人和本地 Agent 使用。读完它，应该能快速理解项目边界、目录职责、常见坑和新增站点适配器的方法。

## 项目定位

兆基clipper 是一个 Chrome / Edge MV3 浏览器扩展，把网页内容提取为 Markdown，并保存到用户自己的 Obsidian 仓库。

核心原则是 **capture-only**：

- 做精准抓取、Markdown 转换、预览编辑、保存落地。
- 不做 AI 摘要、总结、语义改写、智能分类、看图起名。
- 语义整理交给 Obsidian 里的下游工作流或 Agent。

开发时优先维护这个边界。不要为了方便把 AI 服务、云端依赖或隐式上传能力加进扩展。

> 例外：v3.1.0 起新增「飞书知识库」保存方式（`saveMethod: 'feishu'`），会把剪藏内容上传到用户自己的飞书知识库。这是用户**显式选择并配置自建应用凭证后**才会发生的上传通道，是对「不做隐式上传」的有意例外——默认仍是本地 Obsidian。除此之外不要再引入隐式/自动的远程上传。

## Agent 接手提示词

如果你要让 Codex、Claude Code 或其它本地 Agent 继续开发，可以复制这段：

```text
请先阅读 README.md 和 DEVELOPMENT.md，理解兆基clipper 的 capture-only 边界、WXT/React 架构、站点适配器注册表和构建检查要求。

开发原则：
- 不要加入 AI 摘要、云端上传或自动语义分类。
- 新增平台优先新建 utils/extractors/<platform>.ts，并在 utils/extractors/index.ts 注册。
- 平台特异 DOM 选择器留在各自适配器里，不要过度抽象。
- 抓取不准时先加诊断或根据用户提供的诊断结果修，不要盲猜。
- 改完至少运行 npm run compile、npm run build，并检查 content.js 是否纯 ASCII。

请先给我说明你读到的架构和准备修改的文件，再开始动代码。
```

## 技术栈

- WXT：MV3 扩展框架，负责 manifest、多入口、Vite 构建。
- React + TypeScript：弹窗和设置页。
- Defuddle：正文提取，通用网页兜底。
- Turndown + GFM：HTML 转 Obsidian Markdown。
- Obsidian 保存通道：`obsidian://` URI 或 Obsidian Local REST API。

## 目录职责

```text
wxt.config.ts
  Manifest、权限、快捷键、图标、esbuild charset: ascii。

entrypoints/background.ts
  后台 service worker。
  负责右键菜单、快捷键、打开 obsidian://、跨域带登录态下载图片。

entrypoints/content.ts
  内容脚本壳层。
  负责消息监听、网页高亮、诊断信息（含飞书图片布局/坐标/排布诊断）、blob 图片就地解析。
  正文提取委托给 utils/extractors 注册表。

entrypoints/popup/
  剪藏弹窗 React UI。
  负责提取请求、预览编辑、属性面板、标签、完整抓取、保存、诊断按钮。

entrypoints/options/
  设置页 React UI。
  负责主题、仓库配置档（每个仓库一张卡片：仓库名/保存方式/REST 配置/默认文件夹）、
  归档命名、学习状态取值、自定义 frontmatter 字段等设置。图片下载/引用模式改在弹窗里选。

utils/extractors/
  站点适配器。
  每个平台一个文件，index.ts 统一注册和分发。

utils/extract-core.ts
  抓取共享层。
  包括 Defuddle 封装、Turndown 规则、Markdown 清洗、滚动抓取、日期/计数/标签解析等。

utils/storage.ts
  chrome.storage 设置读写。含「仓库配置档（vaultProfiles）」的读写与迁移：
  档为单一数据源，当前生效档的配置镜像到顶层字段；API Key 与仓库档（含密钥）只存 local。

utils/frontmatter.ts
  frontmatter 生成和 YAML 标量转义。

utils/obsidian.ts
  obsidian://new 和 obsidian://open URI 构造。

utils/rest.ts
  Obsidian Local REST API 写入、连接测试、文件存在检查、二进制附件写入。

utils/feishu-api.ts
  飞书知识库写入通道（仅 popup/options 引用，不进内容脚本）。
  App ID+Secret + OAuth user_access_token（access token 过期时用 refresh token 刷新）、列知识库/节点、
  测试连接、saveToFeishu（上传 md→导入为 docx→移入知识库；公开图片交给飞书导入器解析）。
  所需 OAuth user scope：offline_access、drive:file:upload、drive:drive、docs:document:import、wiki:wiki。
  飞书保存走 user_access_token，以用户本人身份访问/写入其有权限的知识库。

utils/hosts.ts
  需登录鉴权才能取图的站点清单（飞书/Lark）。供两处共用：
  引用模式下判定「该图必须下载」，以及后台下载时判定「该图请求要带 Cookie」。

utils/images.ts
  本地图片保存流水线 + 图片双模式。
  isUnreferenceable 判定引用模式下仍需下载的图（飞书/blob）；
  processNoteImages 支持按 alt 里的 |宽 保留宽度；
  inlineImageRowsToHtml 把「并排嵌入 + 斜体图注」转成 HTML 让图注居中显示在每张图下方。

utils/messaging.ts
  内容脚本消息发送与按需注入重试。

utils/highlighter.ts
  网页划词高亮、持久化和恢复。
```

## 核心子系统（v3.0.0）

### 仓库配置档（多仓库切换）

- `Settings.vaultProfiles: VaultProfile[]` + `activeProfileId` 是单一数据源；每个档含 `vaultName / saveMethod / restBaseUrl / restApiKey / defaultFolder`。
- 顶层的 `saveMethod / vaultName / restBaseUrl / restApiKey / defaultFolder` 是「当前生效档」的镜像，保存/打开逻辑直接读顶层，改动小。
- `loadSettings` 加载后把生效档镜像到顶层；`saveSettings` 反向：顶层由生效档派生，不反写档。旧单套配置首次加载时自动迁移成一个档。
- 弹窗顶部「保存到」下拉调用 `switchProfile`：把所选档拷到顶层 + 立即持久化。
- 安全：`vaultProfiles`（含密钥）与 API Key 都只存 `chrome.storage.local`，不进 sync。

### 图片处理双模式

- 弹窗里二选一（`saveImagesLocal`）：下载到本地 / 引用链接。引用模式仍会下载「无法被引用」的图（飞书/Lark 鉴权图、blob:），判定在 `utils/images.ts` 的 `isUnreferenceable` + `utils/hosts.ts`。
- 后台 `fetchImage` 只对 `isAuthGatedHost` 命中的站点带 Cookie（`credentials: 'include'`），公开图不带。
- 「下载到本地」需 REST 方式；obsidian:// 方式写不了二进制。

### 飞书并排图与图注

- `utils/extractors/feishu.ts` 的 `groupInlineImages`：把「同一行连续多张图（中间只隔空行/百分比/图注）」合并成一行带 `|宽` 的嵌入，并保留图注；用「中间是否夹实质正文」区分「并排一组」与「各自单图」。
- 折叠在标题下的内容（`.heading-children`）转标题时会保留，避免居中副标题被丢。
- 标题取自 `.note-title` 元素（`document.title` 在后台标签页常是占位），去掉「分享/编辑」等按钮词——注意这些词放字符串数组，不能进正则（ASCII 约束）。
- 图注居中显示：下载后由 `inlineImageRowsToHtml` 把「并排 ![[名|宽]] + 斜体图注行」转成 HTML 弹性布局，相对路径 src（仅 folderPerClip 同文件夹时）。

### 飞书虚拟滚动与画板截图

- 飞书正文会在滚动过程中复用 DOM，并可能把嵌套列表子树临时暴露成顶层块；`dedupeFeishuListSubtrees` 不能把缩进级别放进重复 key，否则同一子树在不同挂载层级会漏去重。
- 飞书画板截图要在截图前隐藏分享页标题栏、固定浮层和水印类干扰元素；长画板分段截图时，后续片段需要跳过顶部保护区，避免拼进上一段或页面背景形成白条。
- 诊断按钮保留飞书实际 adapter、Defuddle 对照、图片布局和重复窗口信息，修复飞书抓取问题时优先看这些真实页面数据。

### 学习状态字段

- 「学习状态」是独立 frontmatter 字段（取值 = `unreadTag/learnedTag`，默认 未学习/已学习），不再放进 tags，避免被下游 Agent 重写关键词时冲掉。
- 关键词不再由插件自动生成。

## 开发命令

```bash
npm install
npm run dev
npm run dev:edge
npm run compile
npm run build
npm run build:edge
npm run zip
npm run zip:edge
```

开发时常用：

```bash
npm run compile
npm run build
python3 -c "d=open('.output/chrome-mv3/content-scripts/content.js','rb').read();print([b for b in d if b>=0x80][:1])"
```

最后一条输出 `[]` 表示 `content.js` 为纯 ASCII。

## 版本管理与发布

仓库保持精简，只使用：

- `main`：始终对应最新稳定源码。
- 短期分支：每项功能或修复一个分支，合并后删除。
- Pull Request：所有进入 `main` 的改动都经过 CI。
- Git Tag + GitHub Release：永久保存每个正式版本及 Chrome / Edge 安装包。

### 开发流程

```bash
git switch main
git pull --ff-only
git switch -c feature/简短功能名
```

完成修改后运行：

```bash
npm run compile
npm run build
npm run build:edge
```

然后提交、推送分支并创建 Pull Request。CI 会再次执行类型检查、双浏览器构建和内容脚本 ASCII 检查。CI 通过后再合并到 `main`。

### 版本号规则

使用语义化版本：

- Patch，例如 `2.0.1`：修复问题，不新增主要能力。
- Minor，例如 `2.1.0`：新增向后兼容的功能或平台适配。
- Major，例如 `3.0.0`：存在不兼容变化或整体大改版。

不要覆盖或移动已经发布的标签，也不要删除旧 Release。旧版本依靠对应标签和 Release 永久保留。

### 发布流程

1. 在发布 PR 中更新 `package.json`、`package-lock.json`、`CHANGELOG.md`。
2. 可选新增 `RELEASE_NOTES_vX.Y.Z.md`，用于自定义该版本 Release 说明。
3. PR 合并且 `main` 的 CI 通过后，在本地同步 `main`。
4. 创建并推送与版本号一致的标签：

```bash
git switch main
git pull --ff-only
git tag -a vX.Y.Z -m "兆基clipper X.Y.Z"
git push origin vX.Y.Z
```

推送标签后，`.github/workflows/release.yml` 会自动：

- 校验 Tag 与 `package.json` 版本一致。
- 执行类型检查。
- 构建 Chrome / Edge 安装包。
- 创建 GitHub Release，或更新同标签 Release 的安装包。
- 同时上传带版本号的历史归档和固定名称的最新版附件：`zhaoji-clipper-chrome.zip`、`zhaoji-clipper-edge.zip`。

日常开发不要直接向 `main` 推送，也不需要维护长期 `develop` 分支。

## 新增站点适配器

优先保持“平台物理隔离”：

1. 新建 `utils/extractors/<platform>.ts`。
2. 实现 `SiteExtractor`：
   - `name`
   - `match(ctx)`
   - `extract(ctx)`
3. 在 `utils/extractors/index.ts` 的 `REGISTRY` 中注册，放在 `genericExtractor` 前。
4. 只有稳定通用的逻辑才放进 `extract-core.ts`。
5. 平台特有选择器、接口、DOM 规则留在对应适配器里。

适配器返回 `ExtractedPage`。如果 URL 命中但解析失败，可以返回 `null`，让后续适配器或通用兜底继续处理。

## 抓取调试原则

不要盲猜页面结构。

当某个平台抓取不准时，优先：

1. 让用户在弹窗点击诊断按钮。
2. 收集诊断输出：当前 URL、命中的适配器、页面结构、候选容器、实际 Markdown。
3. 先加厚诊断探针，再根据真实 DOM 修适配器。

对于虚拟滚动、Web Components、沉浸式翻译、登录态图片、blob 图片等场景，通用正文提取经常不够，需要站点适配器直读稳定 DOM 或页面内联状态。

## 关键技术注意事项

### 内容脚本必须保持 ASCII

`wxt.config.ts` 设置了：

```ts
esbuild: { charset: 'ascii' }
```

但正则字面量里的非 ASCII 字符不会被自动转义。写会进入 content script 的代码时：

- 字符串里可以有中文。
- 正则字面量里不要直接写中文、全角符号或零宽字符。
- 用字符串 `includes/indexOf` 或 `\uXXXX` 转义。

构建后必须检查：

```bash
python3 -c "d=open('.output/chrome-mv3/content-scripts/content.js','rb').read();print([b for b in d if b>=0x80][:1])"
```

### Obsidian iframe 链接

Obsidian 是 `app://` 环境，视频 iframe 或嵌入链接不要使用协议相对地址 `//example.com`，应显式转成 `https://example.com`。

### 内容脚本隔离世界

内容脚本不能直接读页面 JS 变量，比如 `window.__INITIAL_STATE__`。需要从 DOM 的 `<script>` 文本中解析。

### Local REST API

REST 模式依赖用户本机 Obsidian 的 Local REST API 插件。

- 默认地址：`http://127.0.0.1:27123`（HTTP，需在插件高级设置里开启并可改端口；27124 是 HTTPS，扩展用不上）。
- 多仓库：每个仓库各装一个 Local REST API、各占一个端口、各有自己的 Key（Key 是 per-vault 的）。仓库配置档里分别填各自的地址+Key。
- API Key 与仓库配置档（含密钥）只保存在 `chrome.storage.local`，不进 `chrome.storage.sync`。不要把密钥并入整份同步设置。
- 用户可能把 `Bearer xxx` 整行粘贴进来，`utils/rest.ts` 会自动去掉多余前缀。
- 保存后「打开」用 `obsidian://open?vault=仓库名&file=路径`，所以每个档必须有正确的仓库名，否则打开会「未找到」。

### frontmatter

用户可编辑标题和描述，可能输入换行、冒号、引号等字符。写 YAML 时必须通过 `yamlScalar` 转义，避免破坏 frontmatter。

## 权限说明

扩展 manifest 使用：

- `activeTab`
- `scripting`
- `storage`
- `contextMenus`
- `host_permissions: <all_urls>`

`<all_urls>` 是为了在用户主动剪藏任意网页时读取页面内容、下载图片和执行站点适配器。它会让浏览器显示较高权限提示。新增权限时要谨慎，并在 README 或隐私说明中解释用途。

## 测试清单

改动后至少检查：

```bash
npm run compile
npm run build
python3 -c "d=open('.output/chrome-mv3/content-scripts/content.js','rb').read();print([b for b in d if b>=0x80][:1])"
```

建议手动验证：

- 普通网页能打开弹窗并生成 Markdown。
- Chrome 构建能在 `chrome://extensions` 加载。
- Edge 构建能在 `edge://extensions` 加载。
- `obsidian://` 保存能调起 Obsidian。
- REST 模式连接测试、保存、图片落地正常。
- 改了权限后，需要移除扩展再重新加载，单纯刷新扩展不一定授予新权限。

## 发布

源码仓库不提交生成物：

- `node_modules/`
- `.output/`
- `.wxt/`
- zip 构建包

发布流程：

```bash
npm run compile
npm run build
npm run build:edge
npm run zip
npm run zip:edge
```

把生成的 zip 上传到 GitHub Release：

- `zhaoji-clipper-<version>-chrome.zip`
- `zhaoji-clipper-<version>-edge.zip`
- `zhaoji-clipper-chrome.zip`（最新版固定直链）
- `zhaoji-clipper-edge.zip`（最新版固定直链）

## 当前开放方向

- 知乎适配器。
- 微博、Medium 等更多平台适配器。
- 追加到 Daily Note。
- 自定义 frontmatter 字段模板变量。
- Firefox 实测。
- 长尾页面抓取精度优化。

明确不建议加入：

- AI 摘要、总结、改写。
- 隐式/自动的远程内容上传（用户显式配置的飞书知识库保存除外，见上文 capture-only 例外）。
- 抖音等需要音频转写才能得到正文语义的平台。
