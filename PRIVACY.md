# Privacy Policy

兆基clipper 是一个本地优先的浏览器扩展。它的目标是把用户当前浏览的网页内容转换为 Markdown，并保存到用户自己的 Obsidian 仓库。

## 数据处理原则

- 不提供云端服务。
- 不收集、出售或共享用户数据。
- 不上传网页正文、图片、标签、URL、Obsidian 仓库名或 Local REST API Key 到任何第三方服务器。
- 不做 AI 总结、改写、分类或远程语义处理。

## 本地存储

扩展会使用浏览器扩展存储保存必要配置，例如：

- Obsidian 仓库名。
- 保存方式。
- Local REST API 地址与 API Key。
- 默认保存文件夹、命名模板、主题设置、标签黑名单和常用标签历史。
- 用户在网页上保存的高亮锚点。

普通偏好设置可能通过浏览器的 `chrome.storage.sync` 在用户已登录的浏览器之间同步。Local REST API Key 与网页高亮保存在当前设备的 `chrome.storage.local`，不会进入同步存储。

## 页面内容访问

当用户主动点击扩展、快捷键或右键菜单时，扩展会读取当前页面内容，用于生成剪藏预览和 Markdown 正文。读取结果只在扩展弹窗、当前页面内容脚本和用户配置的 Obsidian 保存通道之间流转。

## Obsidian 保存通道

扩展支持两种保存方式：

- `obsidian://` URI：通过系统协议交给本机 Obsidian 处理。
- Obsidian Local REST API：通过用户本机配置的 Local REST API 地址写入仓库。

Local REST API Key 只用于访问用户本机 Obsidian 插件提供的接口。

API Key 单独保存在当前设备的浏览器扩展本地存储（`chrome.storage.local`）中，不写入同步存储，不随浏览器账号同步。旧版本升级后会自动把已有 Key 迁移到本地存储，并清除同步副本。

## 第三方网站限制

部分平台图片、视频或字幕内容可能受登录态、反盗链、跨域策略或平台接口限制。扩展只在用户主动剪藏时尝试读取或下载这些资源。

## 联系

如果你发现隐私或安全问题，请使用 GitHub 仓库的私密漏洞报告功能。不要在公开 Issue 或 Pull Request 中提交 API Key、Token、私人文档或其它敏感数据。
