# 兆基clipper 2.0.1

本版本主要进行安全加固，建议使用 Local REST API 的用户升级。

## API Key 本地化

- Local REST API Key 现在只保存在当前设备的 `chrome.storage.local`。
- Key 不再写入 `chrome.storage.sync`，不会随浏览器账号同步。
- 从旧版本升级后会自动迁移已有 Key，并清除旧的同步副本，无需重新配置。

## 仓库与发布安全

- GitHub Actions 固定到官方发布提交 SHA。
- CI 增加生产依赖安全审计。
- 修复可兼容升级的间接开发依赖，critical 漏洞降为 0。
- 增加 Dependabot、安全报告说明和敏感文件忽略规则。
- 已扫描完整 Git 历史、公开 Release 安装包、PR 和 Issue，未发现真实 API Key、Token、私钥或本机路径泄露。

第一版 `v0.1.0` 和 `v2.0.0` 继续保留在 Releases 页面。
