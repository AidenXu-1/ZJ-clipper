import { Fragment, useEffect, useState } from 'react';
import { T } from '@/utils/strings';
import { loadSettings, saveSettings, newProfileId } from '@/utils/storage';
import { testRest } from '@/utils/rest';
import {
  testFeishu,
  listSpaces,
  listNodes,
  getSpaceInfo,
  getNodeInfo,
  FeishuConfig,
  FeishuSpace,
  FeishuNode,
} from '@/utils/feishu-api';
import { authorizeFeishuUser, feishuRedirectUri } from '@/utils/feishu/oauth';
import { DEFAULT_SETTINGS, SaveMethod, Settings, VaultProfile } from '@/utils/types';

/** 保存方式简称（仓库折叠头里的小标签） */
function methodLabel(m: SaveMethod): string {
  return m === 'rest' ? 'REST' : m === 'feishu' ? '飞书' : '链接';
}

type FieldKey = keyof Settings['frontmatterFields'];

type SettingsTab = 'vaults' | 'archive' | 'status' | 'props' | 'theme';

const TAB_META: Array<{
  key: SettingsTab;
  label: string;
  eyebrow: string;
  description: string;
}> = [
  {
    key: 'vaults',
    label: '保存方式',
    eyebrow: 'DESTINATIONS',
    description: '分别配置 Obsidian 与飞书；剪藏时直接点击对应的保存按钮。',
  },
  {
    key: 'archive',
    label: '归档命名',
    eyebrow: 'ARCHIVE RULES',
    description: '统一笔记目录、附件位置与文件名，让长期归档保持整洁。',
  },
  {
    key: 'status',
    label: '学习状态',
    eyebrow: 'READING FLOW',
    description: '设置剪藏后的默认状态标签，连接阅读与复习流程。',
  },
  {
    key: 'props',
    label: '属性字段',
    eyebrow: 'NOTE SCHEMA',
    description: '选择写入笔记的属性，并补充适合自己工作流的自定义字段。',
  },
  {
    key: 'theme',
    label: '主题',
    eyebrow: 'APPEARANCE',
    description: '让 Nomo 跟随系统，或固定使用浅色与深色界面。',
  },
];

/** 从仓库档取飞书配置（picker 与测试用） */
function feishuCfg(
  p: VaultProfile,
  onUserTokenRefresh?: FeishuConfig['onUserTokenRefresh'],
): FeishuConfig {
  return {
    appId: p.feishuAppId || '',
    appSecret: p.feishuAppSecret || '',
    domain: p.feishuDomain || 'feishu.cn',
    spaceId: p.feishuSpaceId || '',
    parentToken: p.feishuParentToken || '',
    host: p.feishuHost || '',
    userAccessToken: p.feishuUserAccessToken || '',
    userRefreshToken: p.feishuUserRefreshToken || '',
    userTokenExpireAt: p.feishuUserTokenExpireAt || 0,
    onUserTokenRefresh,
  };
}

/** 飞书开放平台自建应用后台地址 */
function feishuOpenBase(p: VaultProfile): string {
  return (p.feishuDomain || 'feishu.cn') === 'larksuite.com'
    ? 'https://open.larksuite.com'
    : 'https://open.feishu.cn';
}

/** 尽量直达当前应用的「安全设置」；没填 App ID 时退回应用列表 */
function openFeishuSecuritySettings(p: VaultProfile) {
  const appId = (p.feishuAppId || '').trim();
  const base = feishuOpenBase(p);
  window.open(appId ? `${base}/app/${encodeURIComponent(appId)}/safe` : `${base}/app`, '_blank');
}

/** 尽量直达当前应用的「权限管理」；没填 App ID 时退回应用列表 */
function openFeishuPermissionSettings(p: VaultProfile) {
  const appId = (p.feishuAppId || '').trim();
  const base = feishuOpenBase(p);
  window.open(appId ? `${base}/app/${encodeURIComponent(appId)}/auth` : `${base}/app`, '_blank');
}

/** 节点选择器的当前下钻路径（面包屑），最后一项的子节点即当前列出的内容 */
interface NodeCrumb {
  token: string;
  title: string;
}

export function Options() {
  const [s, setS] = useState<Settings>(DEFAULT_SETTINGS);
  const [savedMsg, setSavedMsg] = useState('');
  const [testMsg, setTestMsg] = useState(''); // 测试连接结果文案
  const [testId, setTestId] = useState(''); // 该结果属于哪张卡片
  const [testingId, setTestingId] = useState(''); // 正在测试的卡片 id
  const [authingId, setAuthingId] = useState('');
  const [authMsg, setAuthMsg] = useState<{ id: string; msg: string }>({ id: '', msg: '' });
  // 飞书 picker：按卡片 id 暂存知识库列表、当前层级节点、下钻路径、加载态/报错
  const [fzSpaces, setFzSpaces] = useState<Record<string, FeishuSpace[]>>({});
  const [fzNodes, setFzNodes] = useState<Record<string, FeishuNode[]>>({});
  const [fzPath, setFzPath] = useState<Record<string, NodeCrumb[]>>({});
  const [fzBusy, setFzBusy] = useState('');
  const [fzErr, setFzErr] = useState<{ id: string; msg: string }>({ id: '', msg: '' });
  const [fzLink, setFzLink] = useState<Record<string, string>>({}); // 粘贴的知识库/页面链接
  // 设置页分区：默认落在「保存目标」（飞书/Obsidian 配置都在这），避免一路下拉
  const [tab, setTab] = useState<SettingsTab>('vaults');
  // 仓库手风琴：当前展开编辑的仓库 id（折叠时只占一行，避免多仓库上下太长）
  const [openVault, setOpenVault] = useState('');

  useEffect(() => {
    loadSettings().then((v) => {
      setS(v);
      setOpenVault(v.activeProfileId); // 默认展开当前生效的仓库
      v.vaultProfiles
        .filter((p) => p.saveMethod === 'feishu' && p.feishuUserAccessToken && p.feishuSpaceId)
        .forEach((p) => loadSpaces(p).catch(() => {}));
    });
  }, []);

  // 应用主题到设置页本身（弹窗在 App.tsx 应用）
  useEffect(() => {
    document.documentElement.dataset.theme = s.theme;
  }, [s.theme]);

  function update<K extends keyof Settings>(key: K, value: Settings[K]) {
    setS((prev) => ({ ...prev, [key]: value }));
  }

  // 仓库档为单一数据源：每张卡片直接编辑对应档
  function updateProfile(id: string, patch: Partial<VaultProfile>) {
    setS((prev) => ({
      ...prev,
      vaultProfiles: prev.vaultProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    }));
  }

  function patchProfile(settings: Settings, id: string, patch: Partial<VaultProfile>): Settings {
    return {
      ...settings,
      vaultProfiles: settings.vaultProfiles.map((p) => (p.id === id ? { ...p, ...patch } : p)),
    };
  }

  async function updateProfileAndSave(id: string, patch: Partial<VaultProfile>) {
    const nextSettings = patchProfile(s, id, patch);
    setS(nextSettings);
    await saveSettings(nextSettings);
  }

  function feishuCfgFor(p: VaultProfile): FeishuConfig {
    return feishuCfg(p, (tokens) =>
      updateProfileAndSave(p.id, {
        feishuUserAccessToken: tokens.accessToken,
        feishuUserRefreshToken: tokens.refreshToken,
        feishuUserTokenExpireAt: tokens.expireAt,
      }),
    );
  }

  function setActiveProfile(id: string) {
    setS((prev) => ({ ...prev, activeProfileId: id }));
  }

  function addProfile() {
    const id = newProfileId();
    setS((prev) => {
      const np: VaultProfile = {
        id,
        vaultName: '',
        saveMethod: 'uri',
        restBaseUrl: DEFAULT_SETTINGS.restBaseUrl,
        restApiKey: '',
        defaultFolder: DEFAULT_SETTINGS.defaultFolder,
      };
      return { ...prev, vaultProfiles: [...prev.vaultProfiles, np], activeProfileId: id };
    });
    setOpenVault(id); // 新建后自动展开编辑
  }

  function removeProfile(id: string) {
    setS((prev) => {
      if (prev.vaultProfiles.length <= 1) return prev;
      const remaining = prev.vaultProfiles.filter((p) => p.id !== id);
      return {
        ...prev,
        vaultProfiles: remaining,
        activeProfileId: prev.activeProfileId === id ? remaining[0].id : prev.activeProfileId,
      };
    });
  }

  async function testProfile(p: VaultProfile) {
    setTestId(p.id);
    setTestingId(p.id);
    setTestMsg('');
    const r = p.saveMethod === 'feishu'
      ? await testFeishu(feishuCfgFor(p))
      : await testRest({ baseUrl: p.restBaseUrl, apiKey: p.restApiKey });
    setTestMsg(r.msg);
    setTestingId('');
  }

  async function authFeishuProfile(p: VaultProfile) {
    setAuthingId(p.id);
    setAuthMsg({ id: p.id, msg: '' });
    try {
      const tokens = await authorizeFeishuUser(feishuCfgFor(p));
      await updateProfileAndSave(p.id, {
        feishuUserAccessToken: tokens.accessToken,
        feishuUserRefreshToken: tokens.refreshToken,
        feishuUserTokenExpireAt: tokens.expireAt,
      });
      setAuthMsg({ id: p.id, msg: '飞书用户授权成功 ✓' });
    } catch (e) {
      setAuthMsg({ id: p.id, msg: e instanceof Error ? e.message : String(e) });
    } finally {
      setAuthingId('');
    }
  }

  // ===== 飞书知识库 / 节点选择器 =====
  function setFzError(id: string, msg: string) {
    setFzErr({ id, msg });
  }

  // 拉取知识库列表
  async function loadSpaces(p: VaultProfile) {
    if (!p.feishuUserAccessToken) {
      setFzError(p.id, '请先完成「飞书登录授权」，再选择保存位置');
      return;
    }
    setFzBusy(p.id);
    setFzError('', '');
    try {
      const spaces = await listSpaces(feishuCfgFor(p));
      setFzSpaces((m) => ({ ...m, [p.id]: spaces }));
      if (p.feishuSpaceId) {
        setFzPath((m) => ({
          ...m,
          [p.id]: p.feishuParentToken
            ? [{ token: p.feishuParentToken, title: p.feishuParentTitle || '(已选页面)' }]
            : [],
        }));
        const nodes = await listNodes(
          { ...feishuCfgFor(p), spaceId: p.feishuSpaceId },
          p.feishuSpaceId,
          p.feishuParentToken || '',
        );
        setFzNodes((m) => ({ ...m, [p.id]: nodes }));
      }
      if (!spaces.length)
        setFzError(
          p.id,
          '列表接口没有返回知识库。优先用上面的「粘贴知识库 / 页面链接定位」；如果链接也解析失败，再检查应用是否已加入目标知识库、权限已开通并发布上线。',
        );
    } catch (e) {
      setFzError(p.id, e instanceof Error ? e.message : String(e));
    } finally {
      setFzBusy('');
    }
  }

  // 列出某层级的子节点
  async function loadNodes(p: VaultProfile, spaceId: string, parentToken: string) {
    setFzBusy(p.id);
    setFzError('', '');
    try {
      const nodes = await listNodes({ ...feishuCfgFor(p), spaceId }, spaceId, parentToken);
      setFzNodes((m) => ({ ...m, [p.id]: nodes }));
    } catch (e) {
      setFzError(p.id, e instanceof Error ? e.message : String(e));
    } finally {
      setFzBusy('');
    }
  }

  // 选定知识库：写入档，重置路径并列出目录第一层节点
  async function chooseSpace(p: VaultProfile, space: FeishuSpace) {
    await updateProfileAndSave(p.id, {
      feishuSpaceId: space.spaceId,
      feishuSpaceName: space.name,
      feishuParentToken: '',
      feishuParentTitle: '',
    });
    setFzPath((m) => ({ ...m, [p.id]: [] }));
    await loadNodes({ ...p, feishuSpaceId: space.spaceId }, space.spaceId, '');
  }

  // 下钻进入某节点（列出它的子节点）
  async function enterNode(p: VaultProfile, node: FeishuNode) {
    const path = [...(fzPath[p.id] || []), { token: node.nodeToken, title: node.title }];
    setFzPath((m) => ({ ...m, [p.id]: path }));
    await loadNodes(p, p.feishuSpaceId || '', node.nodeToken);
  }

  // 点面包屑回到某层级（idx=-1 表示目录第一层）
  async function gotoCrumb(p: VaultProfile, idx: number) {
    const path = (fzPath[p.id] || []).slice(0, idx + 1);
    setFzPath((m) => ({ ...m, [p.id]: path }));
    const parent = idx < 0 ? '' : path[idx].token;
    await loadNodes(p, p.feishuSpaceId || '', parent);
  }

  // 把某节点设为「目标位置」（新文档建在它下面）
  async function chooseTarget(p: VaultProfile, token: string, title: string) {
    await updateProfileAndSave(p.id, { feishuParentToken: token, feishuParentTitle: title });
    setSavedMsg('飞书保存目录已更新 ✓');
    setTimeout(() => setSavedMsg(''), 1600);
  }

  // 直接粘贴知识库/页面链接定位（不依赖列表接口——和别的工具一样直接用 token）
  async function resolveLink(p: VaultProfile) {
    const raw = (fzLink[p.id] || '').trim();
    if (!raw) return;
    if (!p.feishuUserAccessToken) {
      setFzError(p.id, '请先完成「飞书登录授权」，再解析保存位置');
      return;
    }
    setFzBusy(p.id);
    setFzError('', '');
    try {
      const cfg = feishuCfgFor(p);
      let spaceId = '';
      let parentToken = '';
      let parentTitle = '';
      // 知识库首页/设置页链接 → 直接是 space_id；wiki 页面链接 → 是 node_token，需解析
      const mSpace = raw.match(/\/wiki\/(?:space|settings)\/([A-Za-z0-9]+)/);
      const mNode = raw.match(/\/wiki\/([A-Za-z0-9]+)/);
      if (mSpace) {
        spaceId = mSpace[1];
      } else if (mNode) {
        const n = await getNodeInfo(cfg, mNode[1]);
        spaceId = n.spaceId;
        parentToken = n.nodeToken;
        parentTitle = n.title;
      } else {
        // 裸 token：先按节点解析，失败再当作 space_id
        try {
          const n = await getNodeInfo(cfg, raw);
          spaceId = n.spaceId;
          parentToken = n.nodeToken;
          parentTitle = n.title;
        } catch {
          spaceId = raw;
        }
      }
      const info = await getSpaceInfo(cfg, spaceId);
      let host = '';
      try {
        host = new URL(raw).origin; // 记下租户站点域名，用于保存后的"打开"链接
      } catch {
        /* 不是完整链接（裸 token），host 留空走兜底 */
      }
      await updateProfileAndSave(p.id, {
        feishuSpaceId: info.spaceId,
        feishuSpaceName: info.name,
        feishuParentToken: parentToken,
        feishuParentTitle: parentTitle,
        ...(host ? { feishuHost: host } : {}),
      });
      setFzPath((m) => ({ ...m, [p.id]: parentTitle ? [{ token: parentToken, title: parentTitle }] : [] }));
      await loadNodes({ ...p, feishuSpaceId: info.spaceId }, info.spaceId, parentToken);
    } catch (e) {
      setFzError(p.id, e instanceof Error ? e.message : String(e));
    } finally {
      setFzBusy('');
    }
  }

  function toggleField(key: FieldKey) {
    setS((prev) => ({
      ...prev,
      frontmatterFields: {
        ...prev.frontmatterFields,
        [key]: !prev.frontmatterFields[key],
      },
    }));
  }

  function copyText(text: string) {
    navigator.clipboard.writeText(text).catch(() => {});
  }

  function copyFeishuScopesAndOpenAuth(p: VaultProfile) {
    copyText(T.settingsFeishuScopesSearch);
    openFeishuPermissionSettings(p);
  }

  function feishuAuthStatus(p: VaultProfile): string {
    if (!p.feishuUserAccessToken) return T.settingsFeishuUnauthed;
    if ((p.feishuUserTokenExpireAt || 0) <= Date.now() + 60_000) return '授权已过期，请重新授权';
    return T.settingsFeishuAuthed;
  }

  // 自定义字段增删改
  function setCustomField(i: number, patch: Partial<{ key: string; value: string }>) {
    setS((prev) => {
      const next = [...prev.customFields];
      next[i] = { ...next[i], ...patch };
      return { ...prev, customFields: next };
    });
  }
  function addCustomField() {
    setS((prev) => ({ ...prev, customFields: [...prev.customFields, { key: '', value: '' }] }));
  }
  function removeCustomField(i: number) {
    setS((prev) => ({ ...prev, customFields: prev.customFields.filter((_, j) => j !== i) }));
  }

  async function handleSave() {
    await saveSettings(s);
    setSavedMsg(T.settingsSaved);
    setTimeout(() => setSavedMsg(''), 1800);
  }

  const currentTab = TAB_META.find((item) => item.key === tab) || TAB_META[0];

  return (
    <div className="zc-opt">
      <header className="zc-opt-head">
        <img className="zc-opt-logo" src="/logo.png" alt="Nomo" />
        <div className="zc-opt-brand">
          <span className="zc-opt-kicker">NOMO / CLIPPER</span>
          <h1>{T.settingsTitle}</h1>
          <p>把网页整理成可以继续思考的笔记。</p>
        </div>
      </header>

      <div className="zc-opt-body">
        <nav className="zc-opt-nav" aria-label="设置分类">
          <span className="zc-nav-label">保存</span>
          {TAB_META.map((item, index) => (
            <Fragment key={item.key}>
              {index === 1 && <span className="zc-nav-label">内容</span>}
              {index === 4 && <span className="zc-nav-label">外观</span>}
              <button
                className={'zc-nav-item' + (tab === item.key ? ' on' : '')}
                aria-current={tab === item.key ? 'page' : undefined}
                onClick={() => setTab(item.key)}
              >
                <span className="zc-nav-index">{String(index + 1).padStart(2, '0')}</span>
                <span>{item.label}</span>
              </button>
            </Fragment>
          ))}
        </nav>

        <div className="zc-opt-main">
          <section className="zc-page-intro" aria-labelledby="zc-page-title">
            <span>{currentTab.eyebrow}</span>
            <h2 id="zc-page-title">{currentTab.label}</h2>
            <p>{currentTab.description}</p>
          </section>
          {tab === 'theme' && (
            <div className="zc-group">
              <div className="zc-group-title">{T.settingsTheme}</div>
              <div className="zc-radios">
                {([
                  ['auto', T.themeAuto],
                  ['light', T.themeLight],
                  ['dark', T.themeDark],
                ] as const).map(([val, label]) => (
                  <label className="zc-check" key={val}>
                    <input
                      type="radio"
                      name="theme"
                      checked={s.theme === val}
                      onChange={() => update('theme', val)}
                    />
                    <span className={`zc-theme-preview zc-theme-${val}`} aria-hidden="true">
                      <i />
                      <i />
                    </span>
                    <span className="zc-theme-label">{label}</span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {tab === 'archive' && (
            <div className="zc-group">
        <div className="zc-group-title">{T.settingsGroupArchive}</div>
        <p className="zc-hint">{T.settingsArchiveFolderMoved}</p>

        <label className="zc-check">
          <input
            type="checkbox"
            checked={s.folderPerClip}
            onChange={(e) => update('folderPerClip', e.target.checked)}
          />
          {T.settingsFolderPerClip}
        </label>
        {s.folderPerClip ? (
          <>
            <label className="zc-l">{T.settingsFolderTpl}</label>
            <input
              className="zc-i"
              value={s.folderNameTemplate}
              onChange={(e) => update('folderNameTemplate', e.target.value)}
            />
            <p className="zc-hint">{T.settingsFolderTplHint}</p>
          </>
        ) : (
          <>
            <label className="zc-l">{T.settingsAttachFolder}</label>
            <input
              className="zc-i"
              value={s.attachmentsFolder}
              onChange={(e) => update('attachmentsFolder', e.target.value)}
            />
            <p className="zc-hint">{T.settingsAttachFolderHint}</p>
          </>
        )}

        <label className="zc-l zc-mt">{T.settingsFilename}</label>
        <input
          className="zc-i"
          value={s.filenameTemplate}
          onChange={(e) => update('filenameTemplate', e.target.value)}
        />
        <p className="zc-hint">{T.settingsFilenameHint}</p>
            </div>
          )}

          {tab === 'status' && (
            <div className="zc-group">
        <div className="zc-group-title">{T.settingsAutoTags}</div>
        <div className="zc-two-cols">
          <div>
            <label className="zc-l">{T.settingsUnreadTag}</label>
            <input
              className="zc-i"
              value={s.unreadTag}
              onChange={(e) => update('unreadTag', e.target.value)}
            />
          </div>
          <div>
            <label className="zc-l">{T.settingsLearnedTag}</label>
            <input
              className="zc-i"
              value={s.learnedTag}
              onChange={(e) => update('learnedTag', e.target.value)}
            />
          </div>
        </div>
        <p className="zc-hint">{T.settingsReadingTagHint}</p>
            </div>
          )}

          {tab === 'props' && (
            <div className="zc-group">
        <div className="zc-group-title">{T.settingsGroupProps}</div>
        <label className="zc-check">
          <input
            type="checkbox"
            checked={s.includeFrontmatter}
            onChange={(e) => update('includeFrontmatter', e.target.checked)}
          />
          {T.settingsFrontmatter}
        </label>
        {s.includeFrontmatter && (
          <>
            <div className="zc-fields">
              {/* tags 字段已交给下游 Agent 处理，clipper 不再写入，故不在此提供开关 */}
              {(Object.keys(s.frontmatterFields) as FieldKey[])
                .filter((key) => key !== 'tags')
                .map((key) => (
                <label className="zc-check" key={key}>
                  <input
                    type="checkbox"
                    checked={s.frontmatterFields[key]}
                    onChange={() => toggleField(key)}
                  />
                  {T.fieldNames[key]}
                </label>
              ))}
            </div>

            <label className="zc-l zc-mt">{T.settingsCustomFields}</label>
            {s.customFields.map((cf, i) => (
              <div className="zc-cf-row" key={i}>
                <input
                  className="zc-i zc-cf-key"
                  placeholder={T.cfKey}
                  value={cf.key}
                  onChange={(e) => setCustomField(i, { key: e.target.value })}
                />
                <input
                  className="zc-i zc-cf-val"
                  placeholder={T.cfValue}
                  value={cf.value}
                  onChange={(e) => setCustomField(i, { value: e.target.value })}
                />
                <button
                  className="zc-cf-del"
                  title="删除"
                  onClick={() => removeCustomField(i)}
                >
                  ✕
                </button>
              </div>
            ))}
            <button className="zc-cf-add" onClick={addCustomField}>
              {T.cfAdd}
            </button>
            <p className="zc-hint">{T.settingsCustomFieldsHint}</p>
          </>
        )}
            </div>
          )}

          {tab === 'vaults' && (
            <div className="zc-group">
        <div className="zc-group-title">{T.settingsGroupVaults}</div>
        <p className="zc-hint">{T.settingsVaultsHint}</p>
        {s.vaultProfiles.map((p) => {
          const pRest = p.saveMethod === 'rest';
          const pFeishu = p.saveMethod === 'feishu';
          const active = p.id === s.activeProfileId;
          const open = openVault === p.id;
          const dispName =
            p.saveMethod === 'feishu'
              ? p.feishuSpaceName || '飞书知识库'
              : p.vaultName || T.profileVaultPlaceholder;
          return (
            <div
              className={'zc-vault-card' + (active ? ' on' : '') + (open ? ' open' : '')}
              key={p.id}
            >
              <button
                type="button"
                className="zc-vault-summary"
                aria-expanded={open}
                onClick={() => setOpenVault(open ? '' : p.id)}
                title={open ? '点击收起' : '点击展开'}
              >
                <span className="zc-vault-sumname">{dispName}</span>
                <span className={'zc-method-chip zc-method-' + p.saveMethod}>
                  {methodLabel(p.saveMethod)}
                </span>
                {active && <span className="zc-active-badge">{T.profileActive}</span>}
                <span className="zc-vault-toggle">
                  {open ? '收起' : '展开'}
                  <span className="zc-vault-caret">▾</span>
                </span>
              </button>
              {open && (
              <div className="zc-vault-body">
              {!pFeishu && (
                <>
                  <label className="zc-l">Obsidian 仓库名称</label>
                  <input
                    className="zc-i"
                    value={p.vaultName}
                    placeholder="必须与 Obsidian 左下角显示的仓库名完全一致"
                    onChange={(e) => updateProfile(p.id, { vaultName: e.target.value })}
                  />
                  <p className="zc-hint">此处不是自定义显示名称；名称错误会导致 Obsidian 提示 Vault not found。</p>
                </>
              )}

              <label className="zc-l zc-mt">{pFeishu ? '目标类型' : T.settingsSaveMethod}</label>
              <div className={'zc-method-cards' + (pFeishu ? ' single' : '')}>
                {(pFeishu
                  ? ([['feishu', T.methodFeishuTitle, T.methodFeishuDesc]] as const)
                  : ([
                      ['uri', T.methodUriTitle, T.methodUriDesc],
                      ['rest', T.methodRestTitle, T.methodRestDesc],
                    ] as const)
                ).map(([m, mt, md]) => (
                  <button
                    type="button"
                    key={m}
                    className={'zc-mcard' + (p.saveMethod === m ? ' on' : '')}
                    aria-pressed={p.saveMethod === m}
                    disabled={pFeishu}
                    onClick={() => !pFeishu && updateProfile(p.id, { saveMethod: m })}
                  >
                    <span className="zc-mcard-radio" />
                    <span className="zc-mcard-text">
                      <span className="zc-mcard-title">{mt}</span>
                      <span className="zc-mcard-desc">{md}</span>
                    </span>
                  </button>
                ))}
              </div>
              {pRest && (
                <>
                  <label className="zc-l">{T.settingsRestUrl}</label>
                  <input
                    className="zc-i"
                    value={p.restBaseUrl}
                    onChange={(e) => updateProfile(p.id, { restBaseUrl: e.target.value })}
                  />
                  <label className="zc-l">{T.settingsRestKey}</label>
                  <input
                    className="zc-i"
                    type="password"
                    value={p.restApiKey}
                    onChange={(e) => updateProfile(p.id, { restApiKey: e.target.value })}
                  />
                  <div className="zc-actions">
                    <button
                      className="zc-btn zc-btn-ghost"
                      onClick={() => testProfile(p)}
                      disabled={testingId === p.id}
                    >
                      {testingId === p.id ? '…' : T.settingsRestTest}
                    </button>
                    {testId === p.id && testMsg && <span className="zc-ok">{testMsg}</span>}
                  </div>
                  <p className="zc-hint">{T.settingsRestKeyHint}</p>
                </>
              )}
              {p.saveMethod === 'uri' && <p className="zc-hint">{T.settingsMethodUriHint}</p>}
              {pFeishu && (
                <>
                  <div className="zc-feishu-steps">
                    <section className="zc-feishu-step">
                      <div className="zc-step-head">
                        <span className="zc-step-no">1</span>
                        <div>
                          <div className="zc-step-title">创建飞书应用</div>
                          <p className="zc-hint">{T.settingsFeishuGuide}</p>
                        </div>
                      </div>
                      <div className="zc-actions">
                        <button
                          className="zc-btn zc-btn-ghost"
                          onClick={() => window.open('https://open.feishu.cn/app', '_blank')}
                        >
                          {T.settingsFeishuOpenDev}
                        </button>
                        <button
                          className="zc-btn zc-btn-ghost"
                          onClick={() => copyFeishuScopesAndOpenAuth(p)}
                        >
                          {T.settingsFeishuCopyScopes}
                        </button>
                        <button
                          className="zc-btn zc-btn-ghost"
                          onClick={() => openFeishuSecuritySettings(p)}
                        >
                          {T.settingsFeishuOpenRedirectGuide}
                        </button>
                      </div>
                      <p className="zc-hint">权限清单：{T.settingsFeishuScopes}</p>
                      <p className="zc-hint">{T.settingsFeishuPermissionSearchHint}</p>
                      <label className="zc-l zc-mt">{T.settingsFeishuRedirectUri}</label>
                      <div className="zc-link-row">
                        <input className="zc-i" value={feishuRedirectUri()} readOnly />
                        <button className="zc-btn zc-btn-ghost" onClick={() => copyText(feishuRedirectUri())}>
                          复制
                        </button>
                      </div>
                      <p className="zc-hint">{T.settingsFeishuRedirectHint}</p>
                      <div className="zc-row2">
                        <div>
                          <label className="zc-l">{T.settingsFeishuAppId}</label>
                          <input
                            className="zc-i"
                            value={p.feishuAppId || ''}
                            placeholder="cli_xxxxxxxx"
                            onChange={(e) => updateProfile(p.id, { feishuAppId: e.target.value })}
                          />
                        </div>
                        <div>
                          <label className="zc-l">{T.settingsFeishuAppSecret}</label>
                          <input
                            className="zc-i"
                            type="password"
                            value={p.feishuAppSecret || ''}
                            onChange={(e) => updateProfile(p.id, { feishuAppSecret: e.target.value })}
                          />
                        </div>
                      </div>
                      <details className="zc-advanced">
                        <summary>高级设置：数据中心</summary>
                        <div className="zc-seg">
                          <button
                            type="button"
                            className={'zc-seg-btn' + ((p.feishuDomain || 'feishu.cn') === 'feishu.cn' ? ' on' : '')}
                            onClick={() => updateProfile(p.id, { feishuDomain: 'feishu.cn' })}
                          >
                            飞书 feishu.cn
                          </button>
                          <button
                            type="button"
                            className={'zc-seg-btn' + (p.feishuDomain === 'larksuite.com' ? ' on' : '')}
                            onClick={() => updateProfile(p.id, { feishuDomain: 'larksuite.com' })}
                          >
                            Lark larksuite.com
                          </button>
                        </div>
                      </details>
                    </section>

                    <section className="zc-feishu-step">
                      <div className="zc-step-head">
                        <span className="zc-step-no">2</span>
                        <div>
                          <div className="zc-step-title">登录授权</div>
                          <p className="zc-hint">授权后，插件会以你本人身份读取和写入你有权限的飞书知识库。</p>
                        </div>
                      </div>
                      <div className="zc-actions">
                        <button
                          className="zc-btn"
                          onClick={() => authFeishuProfile(p)}
                          disabled={authingId === p.id}
                        >
                          {authingId === p.id ? '…' : T.settingsFeishuOAuth}
                        </button>
                        <span className={p.feishuUserAccessToken ? 'zc-ok' : 'zc-muted-inline'}>
                          {feishuAuthStatus(p)}
                        </span>
                        {authMsg.id === p.id && authMsg.msg && <span className="zc-ok">{authMsg.msg}</span>}
                      </div>
                    </section>

                    <section className="zc-feishu-step">
                      <div className="zc-step-head">
                        <span className="zc-step-no">3</span>
                        <div>
                          <div className="zc-step-title">存到哪里</div>
                          <p className="zc-hint">
                            先选飞书仓库；下面会显示当前目录层级里的真实页面选项。如果列表里找不到，再用链接定位。
                          </p>
                        </div>
                      </div>
                      <div className="zc-primary-picker">
                        <div className="zc-actions zc-mt">
                          <button
                            className="zc-btn zc-btn-ghost"
                            onClick={() => loadSpaces(p)}
                            disabled={fzBusy === p.id}
                          >
                            {fzBusy === p.id ? '…' : T.settingsFeishuLoadSpaces}
                          </button>
                        </div>
                        {(fzSpaces[p.id]?.length ?? 0) > 0 && (
                          <select
                            className="zc-i"
                            value={p.feishuSpaceId || ''}
                            onChange={(e) => {
                              const sp = fzSpaces[p.id].find((x) => x.spaceId === e.target.value);
                              if (sp) chooseSpace(p, sp);
                            }}
                          >
                            <option value="">{T.settingsFeishuPickSpace}</option>
                            {fzSpaces[p.id].map((sp) => (
                              <option key={sp.spaceId} value={sp.spaceId}>
                                {sp.name}
                              </option>
                            ))}
                          </select>
                        )}
                        {p.feishuSpaceId && (
                          <div className="zc-feishu-picker">
                            <div className="zc-feishu-crumbs">
                              <button className="zc-crumb" onClick={() => gotoCrumb(p, -1)}>
                                {T.feishuRoot}
                              </button>
                              {(fzPath[p.id] || []).map((c, idx) => (
                                <span key={c.token}>
                                  <span className="zc-crumb-sep"> / </span>
                                  <button className="zc-crumb" onClick={() => gotoCrumb(p, idx)}>
                                    {c.title}
                                  </button>
                                </span>
                              ))}
                            </div>
                            <div className="zc-feishu-current">
                              <span>
                                当前层级：
                                <b>{(fzPath[p.id] || []).at(-1)?.title || T.feishuRoot}</b>
                              </span>
                              <button
                                className="zc-btn zc-btn-ghost zc-btn-sm"
                                onClick={() => chooseTarget(
                                  p,
                                  (fzPath[p.id] || []).at(-1)?.token || '',
                                  (fzPath[p.id] || []).at(-1)?.title || '',
                                )}
                              >
                                保存到当前层级
                              </button>
                            </div>
                            <div className="zc-feishu-nodes">
                              {(fzNodes[p.id] || []).map((n) => (
                                <div className="zc-feishu-node" key={n.nodeToken}>
                                  <span className="zc-feishu-node-title">{n.title}</span>
                                  <button
                                    className="zc-btn zc-btn-ghost zc-btn-sm"
                                    onClick={() => chooseTarget(p, n.nodeToken, n.title)}
                                  >
                                    {T.feishuPickHere}
                                  </button>
                                  {n.hasChild && (
                                    <button
                                      className="zc-btn zc-btn-ghost zc-btn-sm"
                                      onClick={() => enterNode(p, n)}
                                      disabled={fzBusy === p.id}
                                    >
                                      {T.feishuEnter}
                                    </button>
                                  )}
                                </div>
                              ))}
                              {!fzNodes[p.id]?.length && (
                                <p className="zc-hint">{T.feishuNoChild}</p>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      <details className="zc-advanced">
                        <summary>备用：用飞书链接定位保存位置</summary>
                        <label className="zc-l">飞书知识库或页面链接</label>
                        <p className="zc-hint">
                          粘知识库首页：新文档保存到这个仓库的目录第一层；粘知识库内某一页：新文档保存到那一页下面。
                        </p>
                        <div className="zc-link-row">
                          <input
                            className="zc-i"
                            placeholder="https://xxx.feishu.cn/wiki/…"
                            value={fzLink[p.id] || ''}
                            onChange={(e) => setFzLink((m) => ({ ...m, [p.id]: e.target.value }))}
                          />
                          <button
                            className="zc-btn zc-btn-ghost"
                            onClick={() => resolveLink(p)}
                            disabled={fzBusy === p.id}
                          >
                            {fzBusy === p.id ? '…' : '解析为保存位置'}
                          </button>
                        </div>
                      </details>
                    </section>
                  </div>
                  {fzErr.id === p.id && fzErr.msg && <p className="zc-hint zc-err">{fzErr.msg}</p>}
                  <p className="zc-feishu-target">
                    {T.settingsFeishuTarget}
                    <b>
                      {' '}
                      {p.feishuSpaceName || '—'}
                      {' / '}
                      {p.feishuParentTitle || T.feishuRoot}
                    </b>
                  </p>
                </>
              )}
              {!pFeishu && (
                <>
                  <label className="zc-l zc-mt">{T.settingsFolder}</label>
                  <input
                    className="zc-i"
                    value={p.defaultFolder}
                    placeholder="如 剪藏/"
                    onChange={(e) => updateProfile(p.id, { defaultFolder: e.target.value })}
                  />
                  <p className="zc-hint">{T.settingsFolderHint}</p>
                </>
              )}
              <div className="zc-vault-foot">
                {!active && (
                  <button className="zc-btn zc-btn-ghost" onClick={() => setActiveProfile(p.id)}>
                    {T.profileSetActiveFull}
                  </button>
                )}
                <button
                  className="zc-btn-danger"
                  aria-label={`删除保存目标 ${dispName}`}
                  disabled={s.vaultProfiles.length <= 1}
                  onClick={() => removeProfile(p.id)}
                >
                  {T.profileDelete}
                </button>
              </div>
              </div>
              )}
            </div>
          );
        })}
        <button className="zc-cf-add" onClick={addProfile}>
          {T.profileAdd}
        </button>
        <p className="zc-hint">{T.settingsVaultNameHint}</p>
            </div>
          )}
          <div className="zc-sticky-save">
            <span className="zc-save-note" aria-live="polite">
              {savedMsg || '设置保存在当前浏览器中'}
            </span>
            <button className="zc-btn" onClick={handleSave}>
              {T.settingsSave}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
