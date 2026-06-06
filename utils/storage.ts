// 兆基clipper —— 设置读写（chrome.storage.sync）
import { Settings, DEFAULT_SETTINGS } from './types';

const KEY = 'zhaoji_clipper_settings';
const LEGACY_KEY = 'jicun_settings';

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.sync.get([KEY, LEGACY_KEY]);
  const stored = (raw?.[KEY] ?? raw?.[LEGACY_KEY] ?? {}) as Partial<Settings>;
  if (!raw?.[KEY] && raw?.[LEGACY_KEY]) {
    await chrome.storage.sync.set({ [KEY]: stored });
  }
  // 深合并，保证新增字段有默认值
  return {
    ...DEFAULT_SETTINGS,
    ...stored,
    frontmatterFields: {
      ...DEFAULT_SETTINGS.frontmatterFields,
      ...(stored.frontmatterFields ?? {}),
    },
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  await chrome.storage.sync.set({ [KEY]: settings });
}

// ===== 标签历史（本地，用于"常用标签"复用补全；非全仓库扫描）=====
const TAG_KEY = 'zhaoji_clipper_tag_history';
const LEGACY_TAG_KEY = 'jicun_tag_history';

export async function loadTagHistory(): Promise<string[]> {
  const raw = await chrome.storage.local.get([TAG_KEY, LEGACY_TAG_KEY]);
  const tags = (raw?.[TAG_KEY] ?? raw?.[LEGACY_TAG_KEY] ?? []) as string[];
  if (!raw?.[TAG_KEY] && raw?.[LEGACY_TAG_KEY]) {
    await chrome.storage.local.set({ [TAG_KEY]: tags });
  }
  return tags;
}

/** 把本次用到的标签并入历史：最近用的排前、去重（忽略大小写）、上限 40 */
export async function pushTagHistory(tags: string[]): Promise<void> {
  if (!tags.length) return;
  const cur = await loadTagHistory();
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of [...tags, ...cur]) {
    const k = (t || '').trim();
    if (!k || seen.has(k.toLowerCase())) continue;
    seen.add(k.toLowerCase());
    out.push(k);
    if (out.length >= 40) break;
  }
  await chrome.storage.local.set({ [TAG_KEY]: out });
}
