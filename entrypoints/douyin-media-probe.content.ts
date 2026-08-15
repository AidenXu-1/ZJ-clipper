import { extractDouyinMediaCandidates } from '@/utils/douyin-media-payload';

const EVENT_NAME = 'nomo-clipper:douyin-media-url';
const SNAPSHOT_EVENT = 'nomo-clipper:douyin-media-snapshot';
const MAX_JSON_RESPONSE_BYTES = 8 * 1024 * 1024;

interface ObservedDouyinMedia {
  url: string;
  pageUrl: string;
  capturedAt: number;
  awemeId?: string;
  priority?: number;
  source?: 'response' | 'request';
}

export default defineContentScript({
  matches: ['https://*.douyin.com/*'],
  runAt: 'document_start',
  world: 'MAIN',
  main() {
    if (
      (window as unknown as { __NOMO_DOUYIN_MEDIA_PROBE__?: boolean })
        .__NOMO_DOUYIN_MEDIA_PROBE__
    ) {
      return;
    }
    (window as unknown as { __NOMO_DOUYIN_MEDIA_PROBE__?: boolean })
      .__NOMO_DOUYIN_MEDIA_PROBE__ = true;

    const observed = new Map<string, ObservedDouyinMedia>();
    let currentPage = location.href;
    const seenPerformanceEntries = new Set<string>();
    let pageChangedAt = performance.now();

    const syncPage = () => {
      if (location.href === currentPage) return;
      currentPage = location.href;
      observed.clear();
      pageChangedAt = performance.now();
    };

    const emit = (item: ObservedDouyinMedia) => {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: item }));
    };

    const looksLikeMedia = (value: string) => {
      try {
        const url = new URL(value, location.href);
        if (url.protocol !== 'https:' || !url.hostname) return false;
        if (/\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i.test(url.pathname + url.search)) {
          return false;
        }
        return (
          /(?:\.mp4|\.m4a|\.mp3|\.aac)(?:$|[?#])/i.test(url.pathname + url.search) ||
          /(?:bytevod|douyinvod)/i.test(url.hostname) ||
          /(?:\/video\/|\/play\/|video_id=|mime_type=video|format=mp4)/i.test(
            url.pathname + url.search,
          )
        );
      } catch {
        return false;
      }
    };

    const requestPriority = (url: string) => {
      try {
        const parsed = new URL(url, location.href);
        const value = (parsed.pathname + parsed.search).toLowerCase();
        // 抖音精选使用分离式 DASH：media-video-* 没有音轨，转录必须选 media-audio-*。
        if (/media-audio-|mime_type=audio|\.(?:m4a|mp3|aac)(?:$|[?#])/.test(value)) return 85;
        if (/media-video-/.test(value)) return 10;
        return 25;
      } catch {
        return 0;
      }
    };

    const report = (
      value: unknown,
      details: Partial<
        Pick<ObservedDouyinMedia, 'awemeId' | 'priority' | 'source' | 'capturedAt'>
      > = {},
    ) => {
      syncPage();
      if (typeof value !== 'string' || !looksLikeMedia(value)) return;
      const url = new URL(value, location.href).href;
      const normalizedDetails = {
        priority: details.priority ?? requestPriority(url),
        source: details.source ?? ('request' as const),
        ...details,
      };
      const key = `${normalizedDetails.awemeId || ''}\n${url}`;
      const previous = observed.get(key);
      if (previous && (previous.priority || 0) >= normalizedDetails.priority) return;
      const item = {
        url,
        pageUrl: currentPage,
        capturedAt: normalizedDetails.capturedAt ?? Date.now(),
        ...normalizedDetails,
      };
      observed.set(key, item);
      if (observed.size > 96) {
        const oldest = observed.keys().next().value;
        if (typeof oldest === 'string') observed.delete(oldest);
      }
      emit(item);
    };

    const reportPayload = (payload: unknown) => {
      for (const candidate of extractDouyinMediaCandidates(payload)) {
        report(candidate.url, {
          awemeId: candidate.awemeId,
          priority: candidate.priority,
          source: 'response',
        });
      }
    };

    const looksLikeAwemeJson = (value: string) => {
      try {
        const url = new URL(value, location.href);
        const path = url.pathname;
        return (
          /\/aweme\/v1\/web\//i.test(path) &&
          /(?:detail|feed|search|post|favorite|mix|collection|recommend)/i.test(path)
        );
      } catch {
        return false;
      }
    };

    const parseJsonText = (text: string) => {
      if (!text || text.length > MAX_JSON_RESPONSE_BYTES) return;
      try {
        reportPayload(JSON.parse(text));
      } catch {
        // 抖音响应可能不是 JSON；探针不能影响页面正常请求。
      }
    };

    const inspectFetchResponse = async (response: Response, requestUrl: string) => {
      const responseUrl = response.url || requestUrl;
      if (!looksLikeAwemeJson(responseUrl) && !looksLikeAwemeJson(requestUrl)) return;
      const length = Number(response.headers.get('content-length') || '0');
      if (Number.isFinite(length) && length > MAX_JSON_RESPONSE_BYTES) return;
      try {
        const text = await response.clone().text();
        parseJsonText(text);
      } catch {
        // clone/read 失败只会失去这一条候选，不应干扰抖音自身的 fetch。
      }
    };

    const scanHydration = () => {
      const globals = window as unknown as Record<string, unknown>;
      for (const key of ['_ROUTER_DATA', '__INITIAL_STATE__', '__UNIVERSAL_DATA_FOR_REHYDRATION__']) {
        if (globals[key]) reportPayload(globals[key]);
      }
      for (const selector of [
        'script#RENDER_DATA',
        'script#__UNIVERSAL_DATA_FOR_REHYDRATION__',
        'script[id*="RENDER_DATA"]',
      ]) {
        const text = document.querySelector(selector)?.textContent?.trim();
        if (!text || text.length > MAX_JSON_RESPONSE_BYTES) continue;
        try {
          parseJsonText(text.startsWith('%7B') || text.startsWith('%7b') ? decodeURIComponent(text) : text);
        } catch {
          // 非 URI 编码或不完整 hydration 数据，忽略并继续使用网络响应。
        }
      }
    };

    const originalFetch = window.fetch;
    if (typeof originalFetch === 'function') {
      window.fetch = function (this: Window, ...args: Parameters<typeof fetch>) {
        const target = args[0];
        const requestUrl =
          typeof target === 'string' ? target : target instanceof Request ? target.url : String(target);
        report(requestUrl, { source: 'request' });
        const request = originalFetch.apply(this, args);
        void request
          .then((response) => inspectFetchResponse(response, requestUrl))
          .catch(() => undefined);
        return request;
      } as typeof fetch;
    }

    const originalOpen = XMLHttpRequest.prototype.open;
    const xhrUrls = new WeakMap<XMLHttpRequest, string>();
    XMLHttpRequest.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: Parameters<XMLHttpRequest['open']> extends [unknown, unknown, ...infer R] ? R : never[]
    ) {
      const requestUrl = String(url);
      xhrUrls.set(this, requestUrl);
      report(requestUrl, { source: 'request' });
      this.addEventListener(
        'load',
        () => {
          const responseUrl = this.responseURL || xhrUrls.get(this) || requestUrl;
          if (!looksLikeAwemeJson(responseUrl) && !looksLikeAwemeJson(requestUrl)) return;
          try {
            if (this.responseType === 'json') reportPayload(this.response);
            else if (this.responseType === '' || this.responseType === 'text') {
              parseJsonText(this.responseText);
            }
          } catch {
            // responseText 对不兼容 responseType 会抛错，忽略即可。
          }
        },
        { once: true },
      );
      return originalOpen.call(this, method, url, ...rest);
    } as typeof XMLHttpRequest.prototype.open;

    const scanResources = () => {
      syncPage();
      const entries = performance.getEntriesByType('resource');
      // Performance 列表在部分 SPA/浏览器中会被清理，按资源条目签名去重比数组下标更稳。
      for (const entry of entries) {
        const key = `${entry.name}\n${entry.startTime}\n${entry.duration}`;
        if (seenPerformanceEntries.has(key)) continue;
        seenPerformanceEntries.add(key);
        if (entry.startTime + entry.duration < pageChangedAt) continue;
        report(entry.name, {
          source: 'request',
          capturedAt: Math.round(performance.timeOrigin + entry.startTime),
        });
      }
    };

    const bootstrapResources = () => {
      const entries = performance.getEntriesByType('resource');
      for (const entry of entries) {
        const key = `${entry.name}\n${entry.startTime}\n${entry.duration}`;
        if (seenPerformanceEntries.has(key)) continue;
        seenPerformanceEntries.add(key);
        report(entry.name, {
          source: 'request',
          capturedAt: Math.round(performance.timeOrigin + entry.startTime),
        });
      }
    };

    const wrapHistory = (method: 'pushState' | 'replaceState') => {
      const original = history[method];
      history[method] = function (...args: Parameters<History[typeof method]>) {
        const result = original.apply(this, args);
        syncPage();
        return result;
      };
    };
    wrapHistory('pushState');
    wrapHistory('replaceState');
    window.addEventListener('popstate', syncPage);
    window.addEventListener('hashchange', syncPage);

    // 通用内容脚本在 document_idle 才启动；收到快照请求时重放早期捕获结果，避免事件丢失。
    window.addEventListener(SNAPSHOT_EVENT, () => {
      syncPage();
      scanHydration();
      scanResources();
      for (const item of observed.values()) emit(item);
    });

    scanHydration();
    bootstrapResources();
    pageChangedAt = performance.now();
    window.setInterval(scanResources, 3000);
  },
});
