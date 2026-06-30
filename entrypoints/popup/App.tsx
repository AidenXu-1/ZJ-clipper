import { useEffect, useMemo, useState } from 'react';
import { T } from '@/utils/strings';
import { loadSettings, saveSettings, activeProfile } from '@/utils/storage';
import { composeNote } from '@/utils/frontmatter';
import { buildObsidianUri, buildOpenUri, URI_LENGTH_WARN } from '@/utils/obsidian';
import { saveViaRest, fileExists } from '@/utils/rest';
import { saveToFeishu } from '@/utils/feishu-api';
import { processNoteImages, isUnreferenceable, inlineImageRowsToHtml } from '@/utils/images';
import { sendToTab } from '@/utils/messaging';
import {
  channelName,
  renderFilename,
  renderFolderName,
  safeName,
  today,
  todayCompact,
} from '@/utils/filename';
import {
  ClipProperties,
  ExtractedPage,
  ExtractResponse,
  Settings,
  VaultProfile,
} from '@/utils/types';

type Phase = 'loading' | 'ready' | 'error';
type SaveTarget = 'obsidian' | 'feishu';

/** 向当前激活标签页请求提取 */
async function extractActiveTab(fullCapture = false): Promise<ExtractResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  if (
    !tab?.id ||
    !url ||
    /^(chrome|edge|about|view-source|chrome-extension):/.test(url) ||
    url.startsWith('https://chromewebstore.google.com')
  ) {
    return { ok: false, error: T.restrictedPage };
  }
  try {
    return await sendToTab<ExtractResponse>(tab.id, { type: 'ZHAOJI_CLIPPER_EXTRACT', fullCapture });
  } catch {
    return { ok: false, error: '无法连接到页面，请刷新页面后重试' };
  }
}

/** 匹配正文里的图片链接 ![alt](url)，仅捕获 url（用于 URI 模式下探测需登录的图） */
const IMG_LINK_RE = /!\[[^\]]*\]\(([^)\s]+)\)/g;

/** 拼接 仓库内路径：文件夹 + 文件名 */
function joinPath(folder: string, filename: string): string {
  const f = folder.trim().replace(/^\/+|\/+$/g, '');
  const name = safeName(filename);
  return f ? `${f}/${name}` : name;
}

/** 拼接两段文件夹路径 */
function joinFolder(a: string, b: string): string {
  const x = a.trim().replace(/^\/+|\/+$/g, '');
  const y = b.trim().replace(/^\/+|\/+$/g, '');
  return [x, y].filter(Boolean).join('/');
}

/** 仓库档下拉显示文案：仓库名 +（方式） */
function profileLabel(name: string, method: string): string {
  const m = method === 'rest' ? 'REST' : method === 'feishu' ? '飞书' : '链接';
  return `${name || '未命名仓库'}（${m}）`;
}

function activeObsidianProfile(s: Settings): VaultProfile | undefined {
  const active = activeProfile(s);
  if (active && active.saveMethod !== 'feishu') return active;
  return s.vaultProfiles.find((p) => p.saveMethod !== 'feishu');
}

function activeFeishuProfile(s: Settings): VaultProfile | undefined {
  const active = activeProfile(s);
  if (active?.saveMethod === 'feishu') return active;
  return s.vaultProfiles.find((p) => p.saveMethod === 'feishu');
}

/**
 * 飞书文档正文：不带 Obsidian 的 YAML frontmatter（飞书会当普通文本），
 * 改成一段引用抬头承载元信息，标题交由文档名承载。公网图片保留内联链接由飞书抓取。
 */
function buildFeishuMarkdown(props: ClipProperties, body: string): string {
  const meta: string[] = [];
  if (props.source) meta.push(`来源：${props.source}`);
  const line2: string[] = [];
  if (props.author) line2.push(`作者：${props.author}`);
  if (props.published) line2.push(`发布：${props.published}`);
  if (props.modified) line2.push(`修改：${props.modified}`);
  if (props.clipped) line2.push(`剪藏：${props.clipped}`);
  if (props.learningStatus) line2.push(`学习状态：${props.learningStatus}`);
  if (line2.length) meta.push(line2.join('　'));
  if (props.description) meta.push(props.description.replace(/\s+/g, ' ').trim());
  const head = meta.map((l) => `> ${l}`).join('\n');
  return head ? `${head}\n\n${body}\n` : `${body}\n`;
}

export function App() {
  const [phase, setPhase] = useState<Phase>('loading');
  const [errMsg, setErrMsg] = useState('');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [page, setPage] = useState<ExtractedPage | null>(null);

  // 可编辑字段
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [useSelection, setUseSelection] = useState(false);
  const [author, setAuthor] = useState('');
  const [published, setPublished] = useState('');
  const [modified, setModified] = useState('');
  const [description, setDescription] = useState('');
  const [learned, setLearned] = useState(false);
  const [folder, setFolder] = useState('');
  const [filename, setFilename] = useState('');
  const [vault, setVault] = useState('');
  const [saveImagesLocal, setSaveImagesLocal] = useState(false); // 图片处理：true=下载到本地，false=引用链接

  const [savingTarget, setSavingTarget] = useState<SaveTarget | null>(null);
  const [savedMsg, setSavedMsg] = useState('');
  const [savedUri, setSavedUri] = useState<string | null>(null); // 保存成功后的"打开"URI（#2）
  const [alreadyExists, setAlreadyExists] = useState(false); // 目标已存在（#1 去重，仅 REST）
  const [fullCapturing, setFullCapturing] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);

  useEffect(() => {
    (async () => {
      const [resp, s] = await Promise.all([
        extractActiveTab(),
        loadSettings(),
      ]);
      setSettings(s);
      document.documentElement.dataset.theme = s.theme; // 应用主题（auto/light/dark）
      const obsProfile = activeObsidianProfile(s);
      setVault(obsProfile?.vaultName || s.vaultName);
      setFolder(obsProfile?.defaultFolder || s.defaultFolder);
      setSaveImagesLocal(s.saveImagesLocal);
      if (!resp.ok) {
        setErrMsg(resp.error);
        setPhase('error');
        return;
      }
      const d = resp.data;
      setPage(d);
      setTitle(d.title);
      const hasSel = !!d.selectionMarkdown.trim();
      setUseSelection(hasSel);
      setBody(hasSel ? d.selectionMarkdown : d.contentMarkdown);
      setAuthor(d.author);
      setPublished(d.published);
      setModified(d.modified || '');
      setDescription(d.description || '');
      setFilename(renderFilename(s.filenameTemplate, { title: d.title, date: todayCompact() }));
      setPhase('ready');
    })();
  }, []);

  // 完整抓取：让页面自动滚动加载全文后重新提取
  async function handleFullCapture() {
    if (fullCapturing) return;
    setFullCapturing(true);
    setSavedMsg('');
    try {
      const resp = await extractActiveTab(true);
      if (resp.ok) {
        const d = resp.data;
        setPage(d);
        setUseSelection(false);
        setBody(d.contentMarkdown);
        setAuthor(d.author);
        setPublished(d.published);
        setModified(d.modified || '');
      } else {
        setSavedMsg(resp.error);
      }
    } finally {
      setFullCapturing(false);
    }
  }

  // 生成诊断信息并复制到剪贴板（用于排查抓取不准的页面）
  async function handleDiagnose() {
    if (diagnosing) return;
    if (!window.confirm(T.diagnosePrivacyConfirm)) return;
    setDiagnosing(true);
    setSavedMsg('');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      const resp = await sendToTab<{ ok: boolean; dump?: string }>(tab.id, {
        type: 'ZHAOJI_CLIPPER_DIAGNOSE',
      });
      if (resp?.ok && resp.dump) {
        await navigator.clipboard.writeText(resp.dump);
        setSavedMsg(T.diagnoseCopied);
      } else {
        setSavedMsg(T.diagnoseFailed);
      }
    } catch {
      setSavedMsg(T.diagnoseFailed);
    } finally {
      setDiagnosing(false);
    }
  }

  // 把本页高亮插入正文顶部
  function insertHighlights() {
    if (!page?.highlights.length) return;
    const md =
      '## 高亮\n\n' +
      page.highlights.map((h) => `> ${h.replace(/\s+/g, ' ').trim()}`).join('\n\n');
    setBody((prev) => `${md}\n\n${prev}`);
  }

  // 清除本页高亮
  async function clearHighlights() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await sendToTab(tab.id, { type: 'ZHAOJI_CLIPPER_CLEAR_HIGHLIGHTS' }).catch(() => {});
    }
    setPage((p) => (p ? { ...p, highlights: [] } : p));
  }

  async function changeHighlightFloating(enabled: boolean) {
    if (!settings) return;
    const next = { ...settings, highlightFloatingButton: enabled };
    setSettings(next);
    await saveSettings(next).catch(() => {});
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await sendToTab(tab.id, {
        type: 'ZHAOJI_CLIPPER_SET_HIGHLIGHT_FLOATING',
        enabled,
      }).catch(() => {});
    }
  }

  // 切换选区/整页
  function toggleSource(useSel: boolean) {
    if (!page) return;
    setUseSelection(useSel);
    setBody(useSel ? page.selectionMarkdown : page.contentMarkdown);
  }

  // 一键切换仓库档：把所选档的配置镜像到当前生效配置，立即持久化（不用进设置/刷新）
  async function switchProfile(id: string) {
    if (!settings) return;
    const p = settings.vaultProfiles.find((x) => x.id === id);
    if (!p || p.saveMethod === 'feishu') return;
    const next: Settings = {
      ...settings,
      activeProfileId: id,
      saveMethod: p.saveMethod,
      vaultName: p.vaultName,
      restBaseUrl: p.restBaseUrl,
      restApiKey: p.restApiKey,
      defaultFolder: p.defaultFolder,
    };
    setSettings(next);
    setVault(p.vaultName);
    setFolder(p.defaultFolder);
    setSavedMsg('');
    await saveSettings(next).catch(() => {});
  }

  // 切换图片处理方式（下载到本地 / 引用链接）。与设置页同一开关，改动同步回设置，两处保持一致
  async function changeImageMode(download: boolean) {
    setSaveImagesLocal(download);
    if (!settings) return;
    const next = { ...settings, saveImagesLocal: download };
    setSettings(next);
    await saveSettings(next).catch(() => {});
  }

  // 目标子文件夹：开启「每篇独立文件夹」时 = 基础文件夹/年月日-渠道-标题
  const clipFolder = useMemo(() => {
    if (!settings?.folderPerClip || !page) return folder;
    const channel = channelName(page.domain, page.site);
    const sub = renderFolderName(settings.folderNameTemplate, {
      date: todayCompact(),
      channel,
      title: safeName(title || page.title),
    });
    return joinFolder(folder, sub);
  }, [settings, page, folder, title]);

  // 学习状态字段值：已学习 / 未学习（独立 frontmatter 字段，不再混进 tags）
  const learningStatus = learned
    ? settings?.learnedTag || '已学习'
    : settings?.unreadTag || '未学习';

  const obsidianProfile = settings ? activeObsidianProfile(settings) : undefined;
  const feishuProfile = settings ? activeFeishuProfile(settings) : undefined;
  const obsidianMethod = obsidianProfile?.saveMethod || settings?.saveMethod;
  const obsidianProfiles = settings?.vaultProfiles.filter((p) => p.saveMethod !== 'feishu') ?? [];

  const uriPreviewLength = useMemo(() => {
    if (!page || !settings) return 0;
    const props: ClipProperties = {
      title,
      source: page.url,
      author,
      published,
      modified,
      description,
      clipped: today(),
      learningStatus,
      tags: [],
      stats: page.stats,
    };
    const note = composeNote(props, body, settings);
    return buildObsidianUri({
      vault: obsidianProfile?.vaultName || vault,
      filePath: joinPath(clipFolder, filename),
      content: note,
    })
      .length;
  }, [page, settings, title, author, published, modified, learningStatus, body, obsidianProfile, vault, clipFolder, filename]);

  // #1 去重：REST 模式下查目标路径是否已存在（仅提示，不阻断；失败按不存在）
  useEffect(() => {
    if (
      !settings ||
      obsidianMethod !== 'rest' ||
      !obsidianProfile?.restApiKey.trim() ||
      !filename.trim()
    ) {
      setAlreadyExists(false);
      return;
    }
    let cancelled = false;
    const path = joinPath(clipFolder, filename);
    fileExists({ baseUrl: obsidianProfile.restBaseUrl, apiKey: obsidianProfile.restApiKey }, path).then((ex) => {
      if (!cancelled) setAlreadyExists(ex);
    });
    return () => {
      cancelled = true;
    };
  }, [settings, obsidianMethod, obsidianProfile, clipFolder, filename]);

  async function handleSave(target: SaveTarget) {
    if (!page || !settings) return;
    const method = obsidianProfile?.saveMethod || settings.saveMethod;
    const isRest = method === 'rest';
    const obsVault = (obsidianProfile?.vaultName || vault).trim();

    if (target === 'obsidian' && !obsidianProfile) {
      setSavedMsg('请先在设置里添加一个 Obsidian 保存目标');
      return;
    }
    if (target === 'obsidian' && isRest && !obsidianProfile?.restApiKey.trim()) {
      setSavedMsg(T.needApiKey);
      return;
    }
    if (target === 'obsidian' && method === 'uri' && !obsVault) {
      setSavedMsg(T.needVault);
      return;
    }
    if (target === 'feishu' && !feishuProfile) {
      setSavedMsg('请先在设置里添加一个飞书知识库保存目标');
      return;
    }
    if (target === 'feishu' && (!feishuProfile?.feishuAppId?.trim() || !feishuProfile?.feishuAppSecret?.trim())) {
      setSavedMsg(T.feishuNeedApp);
      return;
    }
    if (target === 'feishu' && !feishuProfile?.feishuSpaceId) {
      setSavedMsg(T.feishuNeedSpace);
      return;
    }
    setSavingTarget(target);
    setSavedMsg('');
    const props: ClipProperties = {
      title,
      source: page.url,
      author,
      published,
      modified,
      description,
      clipped: today(),
      learningStatus,
      tags: [],
      stats: page.stats,
    };
    try {
      if (target === 'feishu' && feishuProfile) {
        const fcfg = {
          appId: feishuProfile.feishuAppId || '',
          appSecret: feishuProfile.feishuAppSecret || '',
          domain: feishuProfile.feishuDomain || 'feishu.cn',
          spaceId: feishuProfile.feishuSpaceId || '',
          parentToken: feishuProfile.feishuParentToken || '',
          host: feishuProfile.feishuHost || '',
          userAccessToken: feishuProfile.feishuUserAccessToken || '',
          userRefreshToken: feishuProfile.feishuUserRefreshToken || '',
          userTokenExpireAt: feishuProfile.feishuUserTokenExpireAt || 0,
          onUserTokenRefresh: async (tokens: { accessToken: string; refreshToken: string; expireAt: number }) => {
            const next: Settings = {
              ...settings,
              vaultProfiles: settings.vaultProfiles.map((p) =>
                p.id === feishuProfile.id
                  ? {
                      ...p,
                      feishuUserAccessToken: tokens.accessToken,
                      feishuUserRefreshToken: tokens.refreshToken,
                      feishuUserTokenExpireAt: tokens.expireAt,
                    }
                  : p,
              ),
            };
            setSettings(next);
            await saveSettings(next);
          },
        };
        const md = buildFeishuMarkdown(props, body);
        const r = await saveToFeishu(fcfg, title, md, [], (m) => setSavedMsg(m));
        let tail = '';
        if (r.imagesTotal > 0) {
          const err = r.lastError;
          tail =
            ' ' +
            T.feishuImages(r.imagesSaved, r.imagesTotal) +
            (r.imagesSaved < r.imagesTotal && err ? T.imagesSavedFail(err) : '');
        }
        if (r.url) setSavedUri(r.url);
        const warn = r.warnings[0] ? `（${r.warnings[0]}）` : '';
        setSavedMsg((r.partial ? T.savedPartial : T.savedOk) + tail + warn);
        return;
      }
      let note = composeNote(props, body, settings);
      const filePath = joinPath(clipFolder, filename);
      // 开启独立文件夹时，图片就放进该文件夹；否则放全局附件夹
      const imagesFolder = settings.folderPerClip ? clipFolder : settings.attachmentsFolder;
      let tailMsg = '';
      if (isRest) {
        const restCfg = {
          baseUrl: obsidianProfile?.restBaseUrl || settings.restBaseUrl,
          apiKey: obsidianProfile?.restApiKey || settings.restApiKey,
        };
        // 下载模式：下载全部图片；引用模式：只下载无法被引用的图（飞书/blob），其余保留链接
        const urlFilter = saveImagesLocal ? undefined : isUnreferenceable;
        const r = await processNoteImages(
          note,
          title,
          imagesFolder,
          restCfg,
          (d, t) => setSavedMsg(`正在保存图片 ${d}/${t}…`),
          page.inlineImages,
          urlFilter,
        );
        note = r.note;
        if (r.total > 0) {
          // 下载模式：报全部；引用模式：说明这些是「需登录、无法引用」才下载的图，避免用户困惑
          const base = saveImagesLocal
            ? T.imagesSavedAll(r.saved, r.total)
            : T.imagesSavedGated(r.saved, r.total);
          setSavedMsg(
            base + (r.saved < r.total && r.lastError ? T.imagesSavedFail(r.lastError) : ''),
          );
          await new Promise((res) => setTimeout(res, 900));
        }
        // 并排图的图注：图片与笔记同文件夹时，转成 HTML 让图注居中显示在每张图正下方
        note = inlineImageRowsToHtml(note, settings.folderPerClip);
        await saveViaRest(restCfg, filePath, note);
      } else {
        // obsidian:// 方式无法下载图片；引用模式下若含需登录的图（飞书等），提示用户改用 REST
        if (!saveImagesLocal) {
          let gated = false;
          let im: RegExpExecArray | null;
          IMG_LINK_RE.lastIndex = 0;
          while ((im = IMG_LINK_RE.exec(note))) {
            if (isUnreferenceable(im[1])) {
              gated = true;
              break;
            }
          }
          IMG_LINK_RE.lastIndex = 0; // 复位全局正则状态，避免影响下次保存
          if (gated) tailMsg = T.gatedImagesUriNote;
        }
        const uri = buildObsidianUri({ vault: obsVault, filePath, content: note });
        await chrome.runtime.sendMessage({ type: 'ZHAOJI_CLIPPER_SAVE', url: uri });
      }
      setSavedUri(buildOpenUri(obsVault, filePath)); // #2 保存后可打开
      setSavedMsg(T.savedOk + tailMsg);
    } catch (e) {
      setSavedMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingTarget(null);
    }
  }

  // #2 保存后打开该笔记：飞书是 https 网页（直接开新标签），Obsidian 走 obsidian:// 通道
  async function handleOpenNote() {
    if (!savedUri) return;
    if (/^https?:/.test(savedUri)) {
      await chrome.tabs.create({ url: savedUri });
    } else {
      await chrome.runtime.sendMessage({ type: 'ZHAOJI_CLIPPER_SAVE', url: savedUri });
    }
    window.close();
  }

  // 学习状态切换：已学习 / 未学习（写入独立 frontmatter 字段）
  function toggleLearned(next: boolean) {
    setLearned(next);
  }

  if (phase === 'loading') {
    return (
      <div className="zc-wrap zc-center">
        <div className="zc-spinner" />
        <div className="zc-muted">{T.loading}</div>
      </div>
    );
  }

  if (phase === 'error') {
    return (
      <div className="zc-wrap zc-center">
        <div className="zc-logo">兆基clipper</div>
        <div className="zc-error">{errMsg}</div>
        <button className="zc-link" onClick={() => chrome.runtime.openOptionsPage()}>
          {T.openSettings}
        </button>
      </div>
    );
  }

  return (
    <div className="zc-wrap">
      <header className="zc-header">
        <img className="zc-logo-img" src="/logo.png" alt="" />
        <span className="zc-logo">兆基clipper</span>
        {page && <span className="zc-muted zc-words">{T.wordCount(page.wordCount)}</span>}
        <button
          className="zc-icon-btn"
          title={T.openSettings}
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          ⚙
        </button>
      </header>

      <textarea
        className="zc-hero"
        value={title}
        placeholder="未命名"
        rows={1}
        onChange={(e) => setTitle(e.target.value)}
      />

      <div className="zc-sectionlabel">{T.properties}</div>
      {/* 笔记属性面板（实时可编辑，仿 Obsidian） */}
      <div className="zc-props">
        <div className="zc-prop">
          <span className="zc-prop-icon">✓</span>
          <span className="zc-prop-key">学习状态</span>
          <label className="zc-learned">
            <input
              type="checkbox"
              checked={learned}
              onChange={(e) => toggleLearned(e.target.checked)}
            />
            {T.markLearned}
            <span>{learned ? settings?.learnedTag : settings?.unreadTag}</span>
          </label>
        </div>
        <div className="zc-prop">
          <span className="zc-prop-icon">🔗</span>
          <span className="zc-prop-key">{T.propLabels.source}</span>
          <input className="zc-prop-val zc-ro" value={page?.url ?? ''} readOnly />
        </div>
        <div className="zc-prop">
          <span className="zc-prop-icon">👤</span>
          <span className="zc-prop-key">{T.propLabels.author}</span>
          <input
            className="zc-prop-val"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>
        <div className="zc-prop">
          <span className="zc-prop-icon">📅</span>
          <span className="zc-prop-key">{T.propLabels.published}</span>
          <input
            className="zc-prop-val"
            value={published}
            placeholder="YYYY-MM-DD"
            onChange={(e) => setPublished(e.target.value)}
          />
        </div>
        <div className="zc-prop">
          <span className="zc-prop-icon">📝</span>
          <span className="zc-prop-key">{T.propLabels.modified}</span>
          <input
            className="zc-prop-val"
            value={modified}
            placeholder="YYYY-MM-DD"
            onChange={(e) => setModified(e.target.value)}
          />
        </div>
        <div className="zc-prop">
          <span className="zc-prop-icon">🕐</span>
          <span className="zc-prop-key">{T.propLabels.created}</span>
          <input className="zc-prop-val zc-ro" value={today()} readOnly />
        </div>
        <div className="zc-prop zc-prop-top">
          <span className="zc-prop-icon">📄</span>
          <span className="zc-prop-key">{T.propLabels.description}</span>
          <textarea
            className="zc-prop-val zc-prop-ta"
            value={description}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        {/* 关键词（tags）不再由 clipper 生成，交给下游 Agent 重写 YAML 时补全 */}
        {/* 互动数据已改放正文顶部（视频/链接上方），不再作为属性显示 */}
      </div>

      <div className="zc-row zc-between">
        <label className="zc-label zc-section">{T.fieldContent}</label>
        {page?.selectionMarkdown.trim() && (
          <div className="zc-toggle">
            <button
              className={useSelection ? 'on' : ''}
              onClick={() => toggleSource(true)}
            >
              {T.useSelection}
            </button>
            <button
              className={!useSelection ? 'on' : ''}
              onClick={() => toggleSource(false)}
            >
              {T.useFullArticle}
            </button>
          </div>
        )}
      </div>
      <button
        className="zc-fullcap"
        onClick={handleFullCapture}
        disabled={fullCapturing}
        title={T.fullCaptureHint}
      >
        {fullCapturing ? `📜 ${T.fullCapturing}` : `📜 ${T.fullCapture}`}
      </button>
      {fullCapturing && <div className="zc-muted zc-caphint">{T.fullCaptureHint}</div>}

      {settings && (
        <div className="zc-hlbar">
          <div className="zc-hltop">
            <div className="zc-hlmain">
              <span className="zc-hltitle">🖍 {T.highlightTool}</span>
              <span className="zc-hlhint">{T.highlightShortcutHint}</span>
            </div>
            <label className="zc-switch">
              <input
                type="checkbox"
                checked={settings.highlightFloatingButton}
                onChange={(e) => changeHighlightFloating(e.target.checked)}
              />
              <span>{T.highlightFloatingToggle}</span>
            </label>
          </div>
          {page && page.highlights.length > 0 && (
            <div className="zc-hlactions">
              <span className="zc-hlcount">{T.highlightsCount(page.highlights.length)}</span>
              <button className="zc-hlbtn" onClick={insertHighlights}>
                {T.insertHighlights}
              </button>
              <button className="zc-hlbtn zc-hlbtn-ghost" onClick={clearHighlights}>
                {T.clearHighlights}
              </button>
            </div>
          )}
        </div>
      )}

      <textarea
        className="zc-input zc-textarea"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
      />

      {settings && obsidianProfiles.length > 1 && (
        <div className="zc-row zc-between zc-profilerow">
          <label className="zc-label zc-section">{T.saveTo}</label>
          <select
            className="zc-profile-select"
            value={obsidianProfile?.id || ''}
            onChange={(e) => switchProfile(e.target.value)}
          >
            {obsidianProfiles.map((p) => (
              <option key={p.id} value={p.id}>
                {profileLabel(p.vaultName, p.saveMethod)}
              </option>
            ))}
          </select>
        </div>
      )}

      {feishuProfile && (
        <div className="zc-imgblock zc-fieldhint">{T.feishuImageHint}</div>
      )}

      {(() => {
        const isRest = obsidianMethod === 'rest';
        const downloadActive = isRest && saveImagesLocal;
        return (
          <div className="zc-imgblock">
            <div className="zc-row zc-between">
              <label className="zc-label zc-section">{T.imageSection}</label>
              <div className="zc-toggle">
                <button
                  className={downloadActive ? 'on' : ''}
                  disabled={!isRest}
                  title={isRest ? '' : T.imageDownloadNeedRest}
                  onClick={() => changeImageMode(true)}
                >
                  {T.imageDownload}
                </button>
                <button
                  className={!downloadActive ? 'on' : ''}
                  onClick={() => changeImageMode(false)}
                >
                  {T.imageReference}
                </button>
              </div>
            </div>
            <div className="zc-fieldhint">
              {!isRest
                ? T.imageDownloadNeedRest
                : downloadActive
                  ? T.imageDownloadHint
                  : T.imageReferenceHint}
            </div>
          </div>
        );
      })()}

      {/* 仓库与保存文件夹由「保存到」下拉/设置页决定，这里直接显示路径预览 + 文件名 */}
      <div className="zc-destgrid">
        <div className="zc-dest-open">
          <div className="zc-dest-pathline" title={T.saveLocation}>
            <span className="zc-dest-icon">📁</span>
            <span className="zc-dest-path">
              {(clipFolder ? `${clipFolder}/` : '') + safeName(filename)}.md
            </span>
          </div>
          <label className="zc-label">{T.fieldFilename}</label>
          <input
            className="zc-input"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
          />
          <div className="zc-fieldhint">{T.filenameNote}</div>
        </div>

        <div className="zc-dest-open">
          <div className="zc-dest-pathline" title={T.feishuDest}>
            <span className="zc-dest-icon">📘</span>
            <span className="zc-dest-path">
              {feishuProfile
                ? (feishuProfile.feishuSpaceName || feishuProfile.vaultName || '飞书知识库') +
                  (feishuProfile.feishuParentTitle ? ` / ${feishuProfile.feishuParentTitle}` : ' / 根目录')
                : '未配置飞书知识库'}
            </span>
          </div>
          <div className="zc-fieldhint">{T.feishuDestHint}</div>
        </div>
      </div>

      {obsidianMethod === 'uri' && uriPreviewLength > URI_LENGTH_WARN && (
        <div className="zc-warn">⚠ {T.tooLongWarn}</div>
      )}
      {alreadyExists && !savedUri && <div className="zc-warn">{T.existsWarn}</div>}
      {savedMsg && <div className="zc-savedmsg">{savedMsg}</div>}

      <div className="zc-save-actions">
        <button
          className="zc-save"
          onClick={() => handleSave('obsidian')}
          disabled={!!savingTarget}
        >
          {savingTarget === 'obsidian' ? T.saving : T.save}
        </button>
        <button
          className="zc-save zc-save-feishu"
          onClick={() => handleSave('feishu')}
          disabled={!!savingTarget}
        >
          {savingTarget === 'feishu' ? T.saving : T.saveFeishu}
        </button>
      </div>

      {savedUri && (
        <div className="zc-saveddone">
          <button className="zc-save" onClick={handleOpenNote}>
            {/^https?:/.test(savedUri) ? T.openInFeishu : T.openInObsidian}
          </button>
          <button className="zc-save zc-save-ghost" onClick={() => window.close()}>
            {T.closeWindow}
          </button>
        </div>
      )}

      <button className="zc-diaglink" onClick={handleDiagnose} disabled={diagnosing}>
        {diagnosing ? T.diagnosing : T.diagnose}
      </button>
    </div>
  );
}
