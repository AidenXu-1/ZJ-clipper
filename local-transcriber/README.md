# Nomo 本地字幕助手

Nomo v2.0.3 使用 Chrome Native Messaging 按需启动本机 Whisper。它不再常驻监听本地端口，也不需要每次打开黑色命令窗口。

## 首次安装（只需一次）

1. 双击 `一键安装本地字幕助手.cmd`，看到安装成功后关闭窗口。
2. 打开 `chrome://extensions`，找到 Nomo Clipper 并点一次“重新加载”。
3. 打开抖音视频并播放几秒，在 Nomo Clipper 中点击「转录抖音字幕」。

Chrome 会自动启动本地助手，识别完成后助手自动退出。默认采用低占用模式：继续使用已缓存的 Whisper `small` 模型和 RTX 加速，但将搜索强度降为 1、CPU 限制为 2 线程、工作进程设为低优先级。首次转录会下载隔离的 Python 环境、模型和 NVIDIA 运行库，约需 2–3 GB 空间，因此会比后续转录明显更久。

低占用模式会显著减少对浏览器和日常操作的影响，但模型加载和实际识别期间仍可能短时使用显卡。它不会改用新模型，所以升级后不会再次下载模型。

字幕会写入剪藏正文的 `## 抖音字幕` 区块，校对后再保存到 Obsidian。需要移除集成时，双击 `卸载本地字幕助手.cmd`。

## 数据位置

- 本机助手：`%LOCALAPPDATA%\NomoClipper\NativeHost`
- 模型与依赖缓存：`%LOCALAPPDATA%\NomoClipper\Transcriber`
- 排错日志：`%LOCALAPPDATA%\NomoClipper\logs\native-host.log`

卸载助手默认保留模型缓存，重新安装无需再次下载。若要释放空间，可手动删除 `Transcriber` 目录。

## 隐私与限制

- 转录计算完全在本机完成，视频和识别文本不会发送到 Nomo 或转录云端。
- 助手会直接从抖音当前媒体地址读取音频；首次使用会从 Python 软件源和 Hugging Face 下载运行依赖与模型。
- 只有安装器登记过的 Nomo 扩展 ID 能启动助手；助手仅接受 `douyin.com` 页面和解析后仍为公网地址的 HTTPS 媒体 URL。
- 最长处理 30 分钟；同一时间只运行一个任务；Chrome 单条响应上限约 1 MiB。
