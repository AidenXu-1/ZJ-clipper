// Nomo Clipper —— 向标签页发消息；若内容脚本不在（页面早于插件加载/插件更新过），
// 按需用 chrome.scripting 注入后重试，避免“必须手动重载插件才能用”的问题。

export async function sendToTab<T = any>(tabId: number, msg: unknown): Promise<T> {
  const messageType =
    typeof msg === 'object' && msg !== null && 'type' in msg
      ? (msg as { type?: unknown }).type
      : undefined;
  // 抖音标签页可能保留了旧 content.js 却没有新版 MAIN-world 探针；每次按需确保一次。
  // 探针自身有 window 标记，重复 executeScript 不会重复包装 fetch/XHR。
  if (messageType === 'NOMO_CLIPPER_DOUYIN_MEDIA') {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/douyin-media-probe.js'],
      world: 'MAIN',
    });
  }
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as T;
  } catch {
    // 老标签页完全没有内容脚本：补注入后重试一次。
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/content.js'],
    });
    await new Promise((r) => setTimeout(r, 80));
    return (await chrome.tabs.sendMessage(tabId, msg)) as T;
  }
}
