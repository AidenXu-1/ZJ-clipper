// 兆基clipper —— 普通设置使用 sync；API Key 单独留在当前设备的 local
import { Settings, DEFAULT_SETTINGS } from './types';

const KEY = 'zhaoji_clipper_settings';
const LEGACY_KEY = 'jicun_settings';
const REST_API_KEY = 'zhaoji_clipper_rest_api_key';

export async function loadSettings(): Promise<Settings> {
  const [syncRaw, localRaw] = await Promise.all([
    chrome.storage.sync.get([KEY, LEGACY_KEY]),
    chrome.storage.local.get(REST_API_KEY),
  ]);
  const stored = (syncRaw?.[KEY] ?? syncRaw?.[LEGACY_KEY] ?? {}) as Partial<Settings>;
  const { restApiKey: syncedApiKey = '', ...safeStored } = stored;
  const localApiKey = typeof localRaw?.[REST_API_KEY] === 'string'
    ? localRaw[REST_API_KEY]
    : '';

  // 旧版本把整份设置存入 sync。首次升级时把密钥迁到 local，随后清除同步副本。
  if (!localApiKey && syncedApiKey) {
    await chrome.storage.local.set({ [REST_API_KEY]: syncedApiKey });
  }
  if (!syncRaw?.[KEY] || syncedApiKey || syncRaw?.[LEGACY_KEY]) {
    await chrome.storage.sync.set({ [KEY]: safeStored });
    await chrome.storage.sync.remove(LEGACY_KEY);
  }

  // 旧版「未读标签」占位默认是英文 'unread'；升级为「学习状态」字段后统一显示为「未学习」
  if (safeStored.unreadTag === 'unread') {
    safeStored.unreadTag = DEFAULT_SETTINGS.unreadTag;
  }

  // 深合并，保证新增字段有默认值
  return {
    ...DEFAULT_SETTINGS,
    ...safeStored,
    restApiKey: localApiKey || syncedApiKey,
    siteTagRules: safeStored.siteTagRules ?? DEFAULT_SETTINGS.siteTagRules,
    frontmatterFields: {
      ...DEFAULT_SETTINGS.frontmatterFields,
      ...(safeStored.frontmatterFields ?? {}),
    },
  };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const { restApiKey, ...safeSettings } = settings;
  await Promise.all([
    chrome.storage.sync.set({ [KEY]: safeSettings }),
    restApiKey
      ? chrome.storage.local.set({ [REST_API_KEY]: restApiKey })
      : chrome.storage.local.remove(REST_API_KEY),
  ]);
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
