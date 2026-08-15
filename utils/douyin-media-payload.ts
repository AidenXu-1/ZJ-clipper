export interface DouyinMediaCandidate {
  url: string;
  awemeId?: string;
  priority: number;
  sourceField: string;
}

type UnknownRecord = Record<string, unknown>;

const MAX_VISITED_NODES = 3000;
const MAX_DEPTH = 10;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringId(value: unknown): string | undefined {
  if (typeof value === 'string' && /^\d{8,}$/.test(value)) return value;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return undefined;
}

/** 从作品页、弹窗参数或分享链接中读取抖音作品 ID。 */
export function extractDouyinAwemeId(value: string): string | undefined {
  try {
    const url = new URL(value, 'https://www.douyin.com/');
    const pathMatch = url.pathname.match(/\/(?:video|note|gallery)\/(\d{8,})/i);
    if (pathMatch?.[1]) return pathMatch[1];
    for (const key of ['modal_id', 'aweme_id', 'item_id']) {
      const id = stringId(url.searchParams.get(key));
      if (id) return id;
    }
  } catch {
    const match = value.match(/(?:video|note|gallery)[=/](\d{8,})/i);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function normalizeHttpsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 16_384) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname) return undefined;
    if (/\.(?:jpe?g|png|webp|gif|avif)(?:$|[?#])/i.test(url.pathname + url.search)) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function addressUrls(value: unknown): string[] {
  const raw = isRecord(value)
    ? value.url_list ?? value.urlList ?? value.urls ?? value.url
    : value;
  const items = Array.isArray(raw) ? raw : [raw];
  return items.map(normalizeHttpsUrl).filter((url): url is string => Boolean(url));
}

function extractAwemeId(item: UnknownRecord): string | undefined {
  return (
    stringId(item.aweme_id) ||
    stringId(item.awemeId) ||
    stringId(item.item_id) ||
    stringId(item.itemId)
  );
}

function pushAddress(
  output: DouyinMediaCandidate[],
  seen: Map<string, number>,
  value: unknown,
  awemeId: string | undefined,
  priority: number,
  sourceField: string,
) {
  for (const url of addressUrls(value)) {
    const key = `${awemeId || ''}\n${url}`;
    const previous = seen.get(key);
    if (previous != null && previous >= priority) continue;
    seen.set(key, priority);
    const old = output.findIndex((item) => item.url === url && item.awemeId === awemeId);
    const candidate = { url, awemeId, priority, sourceField };
    if (old >= 0) output[old] = candidate;
    else output.push(candidate);
  }
}

function mediaCandidatesFromVideo(
  video: UnknownRecord,
  awemeId: string | undefined,
  output: DouyinMediaCandidate[],
  seen: Map<string, number>,
) {
  // 优先 H.264 和高码率地址，最后才使用可能带水印的 download_addr。
  pushAddress(output, seen, video.play_addr_h264 ?? video.playAddrH264, awemeId, 120, 'play_addr_h264');

  const bitRates = Array.isArray(video.bit_rate)
    ? video.bit_rate
    : Array.isArray(video.bitRate)
      ? video.bitRate
      : [];
  const sortedBitRates = [...bitRates].sort((a, b) => {
    const aRate = isRecord(a) && typeof a.bit_rate === 'number' ? a.bit_rate : 0;
    const bRate = isRecord(b) && typeof b.bit_rate === 'number' ? b.bit_rate : 0;
    return bRate - aRate;
  });
  sortedBitRates.forEach((entry, index) => {
    if (!isRecord(entry)) return;
    pushAddress(
      output,
      seen,
      entry.play_addr ?? entry.playAddr,
      awemeId,
      110 - Math.min(index, 20),
      'bit_rate.play_addr',
    );
  });

  pushAddress(output, seen, video.play_addr ?? video.playAddr, awemeId, 90, 'play_addr');
  pushAddress(output, seen, video.play_addr_265 ?? video.playAddr265, awemeId, 60, 'play_addr_265');
  pushAddress(output, seen, video.download_addr ?? video.downloadAddr, awemeId, 30, 'download_addr');
}

/**
 * 从 aweme/detail、feed、search 及页面 hydration 数据中提取媒体候选。
 * 遍历有节点/深度上限，避免异常大响应拖慢页面。
 */
export function extractDouyinMediaCandidates(payload: unknown): DouyinMediaCandidate[] {
  const output: DouyinMediaCandidate[] = [];
  const candidatePriorities = new Map<string, number>();
  const visited = new WeakSet<object>();
  const stack: Array<{ value: unknown; depth: number; inheritedId?: string }> = [
    { value: payload, depth: 0 },
  ];
  let visitedNodes = 0;

  while (stack.length && visitedNodes < MAX_VISITED_NODES) {
    const current = stack.pop();
    if (!current || current.depth > MAX_DEPTH) continue;
    const value = current.value;
    if (!value || typeof value !== 'object') continue;
    if (visited.has(value)) continue;
    visited.add(value);
    visitedNodes += 1;

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: value[index], depth: current.depth + 1, inheritedId: current.inheritedId });
      }
      continue;
    }

    const record = value as UnknownRecord;
    const awemeId = extractAwemeId(record) || current.inheritedId;
    if (isRecord(record.video)) {
      mediaCandidatesFromVideo(record.video, awemeId, output, candidatePriorities);
    }

    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') {
        stack.push({ value: child, depth: current.depth + 1, inheritedId: awemeId });
      }
    }
  }

  return output.sort((a, b) => b.priority - a.priority);
}
