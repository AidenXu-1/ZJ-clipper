// 兆基clipper —— 向标签页发消息；若内容脚本不在（页面早于插件加载/插件更新过），
// 按需用 chrome.scripting 注入后重试，避免“必须手动重载插件才能用”的问题。

export async function sendToTab<T = any>(tabId: number, msg: unknown): Promise<T> {
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as T;
  } catch {
    // 注入内容脚本后重试一次
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-scripts/content.js'],
    });
    await new Promise((r) => setTimeout(r, 80));
    return (await chrome.tabs.sendMessage(tabId, msg)) as T;
  }
}
