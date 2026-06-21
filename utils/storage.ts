// 兆基clipper —— 普通设置使用 sync；API Key 与仓库档（含密钥）单独留在当前设备的 local
import { Settings, DEFAULT_SETTINGS, VaultProfile } from './types';

const KEY = 'zhaoji_clipper_settings';
const LEGACY_KEY = 'jicun_settings';
const REST_API_KEY = 'zhaoji_clipper_rest_api_key';
const PROFILES_KEY = 'zhaoji_clipper_vault_profiles'; // 仓库档（含密钥）只存本地，不同步

/** 生成仓库档 id（扩展运行时可用 Math.random） */
export function newProfileId(): string {
  return 'p' + Math.random().toString(36).slice(2, 9);
}

/** 取当前生效的仓库档；找不到则取第一个 */
export function activeProfile(s: Settings): VaultProfile | undefined {
  return s.vaultProfiles.find((p) => p.id === s.activeProfileId) || s.vaultProfiles[0];
}

export async function loadSettings(): Promise<Settings> {
  const [syncRaw, localRaw] = await Promise.all([
    chrome.storage.sync.get([KEY, LEGACY_KEY]),
    chrome.storage.local.get([REST_API_KEY, PROFILES_KEY]),
  ]);
  const stored = (syncRaw?.[KEY] ?? syncRaw?.[LEGACY_KEY] ?? {}) as Partial<Settings>;
  const { restApiKey: syncedApiKey = '', vaultProfiles: _drop, ...safeStored } = stored;
  const localApiKey = typeof localRaw?.[REST_API_KEY] === 'string'
    ? localRaw[REST_API_KEY]
    : '';
  const localProfiles = Array.isArray(localRaw?.[PROFILES_KEY])
    ? (localRaw[PROFILES_KEY] as VaultProfile[])
    : [];

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
  const merged: Settings = {
    ...DEFAULT_SETTINGS,
    ...safeStored,
    restApiKey: localApiKey || syncedApiKey,
    vaultProfiles: localProfiles,
    siteTagRules: safeStored.siteTagRules ?? DEFAULT_SETTINGS.siteTagRules,
    frontmatterFields: {
      ...DEFAULT_SETTINGS.frontmatterFields,
      ...(safeStored.frontmatterFields ?? {}),
    },
  };

  // 迁移：没有仓库档时，用当前单套配置生成一个默认档并设为生效
  if (!merged.vaultProfiles.length) {
    const id = newProfileId();
    merged.vaultProfiles = [
      {
        id,
        vaultName: merged.vaultName,
        saveMethod: merged.saveMethod,
        restBaseUrl: merged.restBaseUrl,
        restApiKey: merged.restApiKey,
        defaultFolder: merged.defaultFolder,
      },
    ];
    merged.activeProfileId = id;
  } else {
    // 旧仓库档可能没有 defaultFolder（功能上线前建的），补默认值
    merged.vaultProfiles = merged.vaultProfiles.map((p) => ({
      ...p,
      defaultFolder: p.defaultFolder ?? merged.defaultFolder ?? DEFAULT_SETTINGS.defaultFolder,
    }));
    if (!merged.vaultProfiles.some((p) => p.id === merged.activeProfileId)) {
      merged.activeProfileId = merged.vaultProfiles[0].id;
    }
  }

  // 仓库档是单一数据源：把当前生效档的配置镜像到顶层字段（保存/打开逻辑直接读顶层）
  const active = activeProfile(merged);
  if (active) {
    merged.saveMethod = active.saveMethod;
    merged.vaultName = active.vaultName;
    merged.restBaseUrl = active.restBaseUrl;
    merged.restApiKey = active.restApiKey;
    merged.defaultFolder = active.defaultFolder;
  }
  return merged;
}

export async function saveSettings(settings: Settings): Promise<void> {
  // 仓库档为准：顶层字段由当前生效档派生（不反向覆盖档）
  const active = activeProfile(settings);
  const top = active
    ? {
        saveMethod: active.saveMethod,
        vaultName: active.vaultName,
        restBaseUrl: active.restBaseUrl,
        restApiKey: active.restApiKey,
        defaultFolder: active.defaultFolder,
      }
    : {};
  const merged = { ...settings, ...top };
  // sync 不含密钥、不含仓库档（仓库档含密钥）；密钥与仓库档存 local
  const { restApiKey, vaultProfiles, ...safeSettings } = merged;
  await Promise.all([
    chrome.storage.sync.set({ [KEY]: safeSettings }),
    chrome.storage.local.set({
      [PROFILES_KEY]: vaultProfiles,
      ...(restApiKey ? { [REST_API_KEY]: restApiKey } : {}),
    }),
    restApiKey ? Promise.resolve() : chrome.storage.local.remove(REST_API_KEY),
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
