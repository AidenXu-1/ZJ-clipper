// Nomo Clipper —— 后台 service worker：右键菜单 + 打开 obsidian:// URI
import {
  DouyinTranscribeRequest,
  DouyinTranscribeResponse,
  NativeTranscriberPingResponse,
  SaveRequest,
} from '@/utils/types';
import { sendToTab } from '@/utils/messaging';
import { isAuthGatedHost } from '@/utils/hosts';

const MENU_ID = 'nomo-clipper-clip';
const MENU_HL = 'nomo-clipper-highlight';
const NATIVE_HOST = 'com.nomo.clipper.transcriber';

/** 通知当前激活标签页的内容脚本高亮选区（内容脚本不在时自动注入） */
async function highlightActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) {
    await sendToTab(tab.id, { type: 'NOMO_CLIPPER_HIGHLIGHT' }).catch(() => {});
  }
}

/** 创建右键菜单（幂等：先清空再建，兼容 SW 重启/更新） */
function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '用 Nomo Clipper 剪藏此页',
      contexts: ['page', 'selection'],
    });
    chrome.contextMenus.create({
      id: MENU_HL,
      title: '用 Nomo Clipper 高亮选区',
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

  // 消息：保存 obsidian:// URI / 跨域下载图片 / 本地抖音转录
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'NOMO_CLIPPER_SAVE') {
      openObsidian((msg as SaveRequest).url)
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'NOMO_CLIPPER_FETCH_IMAGE') {
      fetchImage(msg.url)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'NOMO_CLIPPER_CAPTURE_VISIBLE_TAB') {
      captureVisibleTab(_sender.tab?.windowId)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, error: String(e) }));
      return true;
    }
    if (msg?.type === 'NOMO_CLIPPER_TRANSCRIBE_DOUYIN') {
      transcribeDouyinNative(msg as DouyinTranscribeRequest)
        .then((r) => sendResponse(r))
        .catch((e) =>
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          } satisfies DouyinTranscribeResponse),
        );
      return true;
    }
    if (msg?.type === 'NOMO_CLIPPER_NATIVE_PING') {
      pingNativeTranscriber().then(sendResponse);
      return true;
    }
  });
});

async function pingNativeTranscriber(): Promise<NativeTranscriberPingResponse> {
  try {
    const response = await sendNativeMessage<Record<string, unknown>>({ type: 'ping' }, 10_000);
    return response?.ok
      ? {
          ok: true,
          version: typeof response.version === 'string' ? response.version : 'unknown',
          extensionId: chrome.runtime.id,
        }
      : {
          ok: false,
          error: typeof response?.error === 'string' ? response.error : '本地字幕助手自检失败',
          extensionId: chrome.runtime.id,
        };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      extensionId: chrome.runtime.id,
    };
  }
}

function validDouyinPageUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      (url.hostname === 'douyin.com' || url.hostname.endsWith('.douyin.com'))
    );
  } catch {
    return false;
  }
}

function validPublicMediaUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 16384) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !!url.hostname;
  } catch {
    return false;
  }
}

const MAX_BROWSER_AUDIO_BYTES = 20 * 1024 * 1024;

async function fetchDouyinAudioInBrowser(
  mediaUrl: string,
  pageUrl: string,
): Promise<{ audioBase64: string; audioMime: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  try {
    const response = await fetch(mediaUrl, {
      credentials: 'omit',
      referrer: pageUrl,
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`浏览器下载音轨失败：HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') || '0');
    if (Number.isFinite(declared) && declared > MAX_BROWSER_AUDIO_BYTES) {
      throw new Error('当前音轨超过 20MB，请选择更短的视频');
    }
    if (!response.body) throw new Error('浏览器没有返回可读取的音轨');

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value?.byteLength) continue;
      total += value.byteLength;
      if (total > MAX_BROWSER_AUDIO_BYTES) {
        await reader.cancel('audio too large').catch(() => undefined);
        throw new Error('当前音轨超过 20MB，请选择更短的视频');
      }
      chunks.push(value);
    }
    if (total < 1024) throw new Error('浏览器读取到的音轨为空');

    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
    return {
      audioBase64: bufToBase64(merged.buffer),
      audioMime: contentType || 'audio/mp4',
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('浏览器下载音轨超时，请重试');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/** Chrome 按需启动已注册的 Native Messaging host，任务响应后进程自动结束。 */
async function transcribeDouyinNative(
  request: DouyinTranscribeRequest,
): Promise<DouyinTranscribeResponse> {
  const hasRemoteMedia = validPublicMediaUrl(request.mediaUrl);
  const hasInlineAudio =
    typeof request.audioBase64 === 'string' &&
    request.audioBase64.length > 0 &&
    request.audioBase64.length <= 27 * 1024 * 1024 &&
    /^audio\/(?:wav|x-wav)$/i.test(request.audioMime || 'audio/wav');
  if (!validDouyinPageUrl(request.pageUrl) || (!hasRemoteMedia && !hasInlineAudio)) {
    return { ok: false, error: '当前抖音音频无效，请重新播放视频后再试' };
  }
  try {
    const browserAudio = hasRemoteMedia
      ? await fetchDouyinAudioInBrowser(request.mediaUrl!, request.pageUrl)
      : undefined;
    const response = await sendNativeTranscribe({
      type: 'transcribe',
      ...(
        browserAudio ||
        (hasInlineAudio
          ? { audioBase64: request.audioBase64, audioMime: request.audioMime || 'audio/wav' }
          : {})
      ),
      pageUrl: request.pageUrl,
      title: typeof request.title === 'string' ? request.title.slice(0, 500) : '抖音视频',
    });
    return response?.ok
      ? response
      : { ok: false, error: response?.error || '本地字幕助手没有返回结果' };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const setupRequired = /native messaging host|host.*not found|specified native/i.test(detail);
    return {
      ok: false,
      setupRequired,
      error: setupRequired
        ? '本地字幕助手尚未安装，请先运行一次“一键安装本地字幕助手.cmd”'
        : `本地转录准备失败：${detail}`,
    };
  }
}

/** connectNative 会在长时间 Whisper 任务期间保持 MV3 service worker 存活。 */
function sendNativeTranscribe(payload: Record<string, unknown>): Promise<DouyinTranscribeResponse> {
  return sendNativeMessage<DouyinTranscribeResponse>(payload, 31 * 60_000);
}

function sendNativeMessage<T>(payload: Record<string, unknown>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connectNative(NATIVE_HOST);
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      port.disconnect();
      reject(new Error('本地字幕识别超时，请重试'));
    }, timeoutMs);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    port.onMessage.addListener((message: T) => {
      finish(() => {
        port.disconnect();
        resolve(message);
      });
    });
    port.onDisconnect.addListener(() => {
      const detail = chrome.runtime.lastError?.message || '本地字幕助手已断开';
      finish(() => reject(new Error(detail)));
    });
    try {
      port.postMessage(payload);
    } catch (error) {
      finish(() => reject(error));
    }
  });
}

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
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    // 仅对需登录的站点（飞书/Lark）带 Cookie；公开图一律不带，最小化 Cookie 暴露面
    const credentials = isAuthGatedHost(url) ? 'include' : 'omit';
    const res = await fetch(url, { credentials, signal: controller.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const mime = res.headers.get('content-type')?.split(';')[0]?.trim() || '';
    if (!mime.startsWith('image/')) return { ok: false, error: `非图片(${mime})` };
    const buf = await res.arrayBuffer();
    if (buf.byteLength > 12 * 1024 * 1024) return { ok: false, error: '图片过大(>12MB)' };
    return { ok: true, base64: bufToBase64(buf), mime };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      return { ok: false, error: '图片下载超时（20 秒）' };
    }
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(timer);
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
