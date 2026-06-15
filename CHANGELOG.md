# Changelog

## v2.0.1 - 2026-06-15

安全与发布流程加固版本。

### Security

- Local REST API Key 从 `chrome.storage.sync` 迁移到当前设备的 `chrome.storage.local`，并自动清除旧同步副本。
- 增加常见密钥与本机配置文件的 Git 忽略规则。
- GitHub Actions 固定到官方发布提交 SHA，降低工作流供应链风险。
- CI 增加生产依赖安全审计；当前生产依赖漏洞为 0。
- 增加 Dependabot 配置和私密漏洞报告说明。

## v2.0.0 - 2026-06-15

兆基clipper 2.0 重点优化飞书文档与 X / Twitter 长文章的剪存质量。

### 飞书文档

- 飞书画板无法直接转换为 Obsidian Markdown 时，自动截取为 PNG 图片，并插入原文对应位置。
- 修复飞书高亮块、标题、引用和 Callout 转换异常及多余空行问题。
- 支持提取可见的文档作者与最后修改日期，并写入笔记属性。

### X / Twitter

- 新增长文章 Article 正文提取，不再只保存图片而缺失中文文字。
- 「完整抓取全文」仅滚动当前文章区域，到正文最后一行即停止，避免误抓评论与其他推文。
- 保留普通推文和 thread 的原有剪存能力。

### 自动标签

- 每篇剪存默认添加 `unread` 标签，可在保存前勾选「本篇已学习」切换为 `已学习`。
- 支持按网站域名自动添加标签，默认内置 `woshipm.com` → `PM`，并可在设置页继续扩展。

## v0.1.0 - 2026-06-07

兆基clipper 第一个成品版本。

### Added

- 支持 Chrome / Edge MV3 扩展形态。
- 支持 Obsidian `obsidian://` URI 保存。
- 支持 Obsidian Local REST API 保存超长内容与本地图片。
- 支持飞书文档、B站、YouTube、小红书、X / Twitter、微信公众号、Reddit 与通用网页剪藏。
- 支持选区剪藏、完整滚动抓取、X thread 抓取和网页划词高亮。
- 支持 frontmatter、标签、作者、发布时间、来源 URL、描述等属性编辑。
- 支持每篇独立文件夹、图片随文归档、文件名模板、标签黑名单、常用标签复用。
- 支持暗色主题和设置页。
- 支持诊断信息复制，用于按真实页面结构修复站点适配器。

### Notes

- 产品边界为 capture-only，不做 AI 摘要、总结、改写或分类。
- 知乎、微博、Medium、Daily Note 追加等能力仍在后续规划中。
