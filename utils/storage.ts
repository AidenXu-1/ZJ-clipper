// Nomo Clipper —— 普通设置使用 sync；API Key 与仓库档（含密钥）单独留在当前设备的 local
import { ClipDraft, Settings, DEFAULT_SETTINGS, SaveDestination, VaultProfile } from './types';

const KEY = 'nomo_clipper_settings';
const REST_API_KEY = 'nomo_clipper_rest_api_key';
const PROFILES_KEY = 'nomo_clipper_vault_profiles'; // 仓库档（含密钥）只存本地，不同步
const DRAFTS_KEY = 'nomo_clipper_clip_drafts';
const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const DRAFT_LIMIT = 10;

function isFeishuDisplayName(value: unknown): boolean {
  const name = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return name === '飞书知识库' || name === 'feishu' || name === 'feishu wiki';
}

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
    chrome.storage.sync.get(KEY),
    chrome.storage.local.get([REST_API_KEY, PROFILES_KEY]),
  ]);
  const stored = (syncRaw?.[KEY] ?? {}) as Partial<Settings>;
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
  if (!syncRaw?.[KEY] || syncedApiKey) {
    await chrome.storage.sync.set({ [KEY]: safeStored });
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
    // 旧仓库档可能没有 defaultFolder（功能上线前建的），补默认值；飞书档补默认数据中心
    merged.vaultProfiles = merged.vaultProfiles.map((p) => ({
      ...p,
      defaultFolder: p.defaultFolder ?? merged.defaultFolder ?? DEFAULT_SETTINGS.defaultFolder,
      ...(p.saveMethod === 'feishu' && !p.feishuDomain ? { feishuDomain: 'feishu.cn' as const } : {}),
    }));
    if (!merged.vaultProfiles.some((p) => p.id === merged.activeProfileId)) {
      merged.activeProfileId = merged.vaultProfiles[0].id;
    }
  }

  // 双目标上线前，用户可能把同一张卡片在飞书和 Obsidian 之间切换，导致
  // “飞书知识库”被误当作 obsidian:// 的 vault 参数。优先用旧顶层值或其他
  // Obsidian 档恢复；确实无法推断时清空，让弹窗明确要求配置，而不是唤起错误仓库。
  const recoverableVaultName = [
    safeStored.vaultName,
    merged.vaultName,
    ...merged.vaultProfiles
      .filter((p) => p.saveMethod !== 'feishu')
      .map((p) => p.vaultName),
  ].find((name) => typeof name === 'string' && name.trim() && !isFeishuDisplayName(name));
  let repairedVaultProfile = false;
  merged.vaultProfiles = merged.vaultProfiles.map((p) => {
    if (p.saveMethod === 'feishu' || !isFeishuDisplayName(p.vaultName)) return p;
    repairedVaultProfile = true;
    return { ...p, vaultName: recoverableVaultName?.trim() || '' };
  });
  if (repairedVaultProfile) {
    await chrome.storage.local.set({ [PROFILES_KEY]: merged.vaultProfiles });
  }

  // 旧版本没有默认多目标设置：按已经存在的配置推导，保留原先“配置两边即默认全选”的行为。
  const configuredTargets: SaveDestination[] = [
    ...(merged.vaultProfiles.some((p) => p.saveMethod !== 'feishu') ? (['obsidian'] as const) : []),
    ...(merged.vaultProfiles.some((p) => p.saveMethod === 'feishu') ? (['feishu'] as const) : []),
  ];
  const storedTargets = Array.isArray(safeStored.defaultSaveTargets)
    ? safeStored.defaultSaveTargets.filter(
        (target): target is SaveDestination => target === 'obsidian' || target === 'feishu',
      )
    : [];
  merged.defaultSaveTargets = storedTargets.length > 0
    ? Array.from(new Set(storedTargets))
    : configuredTargets.length > 0
      ? configuredTargets
      : DEFAULT_SETTINGS.defaultSaveTargets;

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
const TAG_KEY = 'nomo_clipper_tag_history';

export async function loadTagHistory(): Promise<string[]> {
  const raw = await chrome.storage.local.get(TAG_KEY);
  return (raw?.[TAG_KEY] ?? []) as string[];
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

// ===== 未保存剪藏草稿（只存表单，不含任何凭据） =====

function isClipDraft(value: unknown): value is ClipDraft {
  if (!value || typeof value !== 'object') return false;
  const d = value as Partial<ClipDraft>;
  return (
    d.version === 1 &&
    typeof d.sourceUrl === 'string' &&
    typeof d.updatedAt === 'number' &&
    typeof d.targetProfileId === 'string' &&
    typeof d.title === 'string' &&
    typeof d.body === 'string' &&
    typeof d.useSelection === 'boolean' &&
    typeof d.author === 'string' &&
    typeof d.published === 'string' &&
    typeof d.modified === 'string' &&
    typeof d.description === 'string' &&
    typeof d.learned === 'boolean' &&
    typeof d.folder === 'string' &&
    typeof d.filename === 'string' &&
    typeof d.vault === 'string' &&
    typeof d.saveImagesLocal === 'boolean'
  );
}

function draftSourceKey(sourceUrl: string): string {
  try {
    const u = new URL(sourceUrl);
    u.hash = '';
    return u.toString();
  } catch {
    return sourceUrl.split('#')[0];
  }
}

async function readClipDrafts(): Promise<ClipDraft[]> {
  const raw = await chrome.storage.local.get([DRAFTS_KEY]);
  const now = Date.now();
  return (Array.isArray(raw?.[DRAFTS_KEY]) ? raw[DRAFTS_KEY] : [])
    .filter(isClipDraft)
    .filter((d) => now - d.updatedAt <= DRAFT_TTL_MS)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, DRAFT_LIMIT);
}

/** 读取同一来源页面最近的未保存草稿，并顺手清理过期/超量记录。 */
export async function loadClipDraft(sourceUrl: string): Promise<ClipDraft | undefined> {
  const drafts = await readClipDrafts();
  await chrome.storage.local.set({ [DRAFTS_KEY]: drafts });
  const key = draftSourceKey(sourceUrl);
  return drafts.find((d) => draftSourceKey(d.sourceUrl) === key);
}

/**
 * 保存草稿时逐字段重建对象，确保调用方即使误传额外字段，也不会把设置或凭据写进草稿。
 */
export async function saveClipDraft(draft: ClipDraft): Promise<void> {
  const safe: ClipDraft = {
    version: 1,
    sourceUrl: draftSourceKey(draft.sourceUrl),
    updatedAt: draft.updatedAt,
    targetProfileId: draft.targetProfileId,
    title: draft.title,
    body: draft.body,
    useSelection: draft.useSelection,
    author: draft.author,
    published: draft.published,
    modified: draft.modified,
    description: draft.description,
    learned: draft.learned,
    folder: draft.folder,
    filename: draft.filename,
    vault: draft.vault,
    saveImagesLocal: draft.saveImagesLocal,
  };
  const drafts = (await readClipDrafts()).filter(
    (d) => draftSourceKey(d.sourceUrl) !== safe.sourceUrl,
  );
  await chrome.storage.local.set({
    [DRAFTS_KEY]: [safe, ...drafts].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, DRAFT_LIMIT),
  });
}

export async function removeClipDraft(sourceUrl: string): Promise<void> {
  const key = draftSourceKey(sourceUrl);
  const drafts = (await readClipDrafts()).filter((d) => draftSourceKey(d.sourceUrl) !== key);
  await chrome.storage.local.set({ [DRAFTS_KEY]: drafts });
}
