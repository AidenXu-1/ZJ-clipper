# Nomo Clipper 2.0.3 Windows 整合包

## 第一次使用

1. 在 Chrome 打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择整合包里的 `Chrome扩展` 文件夹。
3. 双击 `本地字幕助手/一键安装本地字幕助手.cmd`。
4. 回到扩展管理页，点击 Nomo Clipper 的“重新加载”。

以后转录抖音字幕时，只需要点击插件中的「转录抖音字幕」。Chrome 会自动启动本地助手，完成后自动退出。默认低占用模式会限制 CPU 线程、降低识别搜索强度，并继续使用已有的 `small` 模型与 RTX 加速，不会重新下载模型。

如果当前 Chrome 已经从 `Nomo-Clipper-Chrome-4.0.2` 加载过 Nomo，请继续使用原目录，不要删除它；本安装器已允许该目录对应的扩展 ID，这样可以保留原有设置。

首次识别需要下载 Whisper 模型及 Python 依赖，约占 2–3 GB。模型缓存在 `%LOCALAPPDATA%\NomoClipper\Transcriber`。

## 卸载

双击 `本地字幕助手/卸载本地字幕助手.cmd`。卸载默认保留模型缓存，方便以后重装；如需彻底释放空间，可再删除 `%LOCALAPPDATA%\NomoClipper\Transcriber`。
