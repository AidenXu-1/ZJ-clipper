// 兆基clipper —— 后台 service worker：右键菜单 + 打开 obsidian:// URI
import { SaveRequest } from '@/utils/types';
import { sendToTab } from '@/utils/messaging';
import { isAuthGatedHost } from '@/utils/hosts';

const MENU_ID = 'zhaoji-clipper-clip';
const MENU_HL = 'zhaoji-clipper-highlight';

/** 通知当前激活标签页的内容脚本高亮选区（内容脚本不在时自动注入） */
async function highlightActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await sendToTab(tab.id, { type: 'ZHAOJI_CLIPPER_HIGHLIGHT' }).catch(() => {});
  }
}

/** 创建右键菜单（幂等：先清空再建，兼容 SW 重启/更新） */
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '用兆基clipper剪藏此页',
      contexts: ['page', 'selection'],
    });
    chrome.contextMenus.create({
      id: MENU_HL,
      title: '用兆基clipper高亮选区',
      contexts: ['selection'],
    });
  });
}

export default defineBackground(() => {
  chrome.runtime.onInstalled.addListener(setupMenus);
  chrome.runtime.onStartup.addListener(setupMenus);

  // 点击右键菜单
  chrome.contextMenus.onClicked.addListener((info) => {
    if (info.menuItemId === MENU_ID) {
      // openPopup 需要 Chrome 127+；失败则静默（用户可点图标）
      chrome.action.openPopup?.().catch(() => {});
    } else if (info.menuItemId === MENU_HL) {
      highlightActiveTab();
    }
  });

  // 快捷键命令：高亮选区
  chrome.commands.onCommand.addListener((command) => {
    if (command === 'highlight-selection') highlightActiveTab();
  });

  // 消息：保存 obsidian:// URI / 跨域下载图片
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'ZHAOJI_CLIPPER_SAVE') {
      openObsidian((msg as SaveRequest).url)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'ZHAOJI_CLIPPER_FETCH_IMAGE') {
      fetchImage(msg.url)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'ZHAOJI_CLIPPER_CAPTURE_VISIBLE_TAB') {
      captureVisibleTab(_sender.tab?.windowId)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
  });
});

async function captureVisibleTab(
  windowId?: number,
): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }> {
  try {
    const dataUrl =
      windowId == null
        ? await chrome.tabs.captureVisibleTab({ format: 'png' })
        : await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
    return dataUrl ? { ok: true, dataUrl } : { ok: false, error: '截图为空' };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** ArrayBuffer → base64（分块，避免大图爆栈） */
function bufToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** 跨域下载图片字节（带登录态，可取鉴权图片如飞书） */
async function fetchImage(
  url: string,
): Promise<{ ok: true; base64: string; mime: string } | { ok: false; error: string }> {
  try {
    // 仅对需登录的站点（飞书/Lark）带 Cookie；公开图一律不带，最小化 Cookie 暴露面
    const credentials = isAuthGatedHost(url) ? 'include' : 'omit';
    const res = await fetch(url, { credentials });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || '';
    if (!mime.startsWith('image/')) return { ok: false, error: `非图片(${mime})` };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 12 * 1024 * 1024) return { ok: false, error: '图片过大(>12MB)' };
    return { ok: true, base64: bufToBase64(buf), mime };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 打开 obsidian:// URI 触发 Obsidian 建笔记。
 *
 * 首次点击时 Chrome 会弹出“是否打开 Obsidian”的外部协议授权框，
 * 需要给用户足够时间点击（并勾选“始终允许”），否则过早关闭标签页
 * 会连同授权框一起取消，导致笔记没被创建。
 * 因此用较长延迟（6s）后再清理，且仅当标签页仍是空白页时才关闭。
 */
async function openObsidian(url: string): Promise<void> {
  const tab = await chrome.tabs.create({ url, active: true });
  const tabId = tab.id;
  if (tabId == null) return;
  setTimeout(async () => {
    try {
      const t = await chrome.tabs.get(tabId);
      // 只关闭仍停留在空白/协议页的标签，避免误关用户已切换的页面
      if (!t.url || t.url === 'about:blank' || t.url.startsWith('obsidian://')) {
        await chrome.tabs.remove(tabId);
      }
    } catch {
      /* 标签已不存在，忽略 */
    }
  }, 6000);
}
