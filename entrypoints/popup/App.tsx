import { useEffect, useMemo, useState } from 'react';
import { T } from '@/utils/strings';
import {
  activeProfile,
  loadClipDraft,
  loadSettings,
  removeClipDraft,
  saveClipDraft,
  saveSettings,
} from '@/utils/storage';
import { composeNote } from '@/utils/frontmatter';
import { buildObsidianUri, buildOpenUri, URI_LENGTH_WARN } from '@/utils/obsidian';
import { checkFileState, findAvailableCopyPath, saveViaRest } from '@/utils/rest';
import { saveToFeishu } from '@/utils/feishu-api';
import { collectAllImages, processNoteImages, isUnreferenceable, inlineImageRowsToHtml } from '@/utils/images';
import { sendToTab } from '@/utils/messaging';
import { appendTimestampNote } from '@/utils/timestamp';
import { transcribeDouyinMedia, upsertDouyinTranscript } from '@/utils/douyin-transcript';
import {
  channelName,
  renderFilename,
  renderFolderName,
  safeName,
  today,
  todayCompact,
} from '@/utils/filename';
import {
  BilibiliTimestampResponse,
  ClipDraft,
  ClipProperties,
  DouyinMediaResponse,
  ExtractedPage,
  ExtractResponse,
  NativeTranscriberPingResponse,
  DEFAULT_SETTINGS,
  Settings,
  VaultProfile,
} from '@/utils/types';

type Phase = 'loading' | 'ready' | 'error';
type SaveTarget = 'obsidian' | 'feishu';
type ConflictChoice = 'overwrite' | 'copy';
type SaveOutcome = 'saved' | 'failed' | 'conflict';
type SaveResult = {
  outcome: SaveOutcome;
  message: string;
  uri?: string;
};

const PREVIEW_PAGE: ExtractedPage = {
  title: '把网页整理成可以继续思考的笔记',
  author: 'Nomo 示例',
  published: today(),
  modified: today(),
  description: '保留来源、正文和上下文，再送入自己的知识库。',
  site: 'Nomo Preview',
  domain: 'example.com',
  url: 'https://example.com/nomo-clipper',
  image: '',
  contentMarkdown: '这是 Nomo Clipper 的界面预览。\n\n你可以编辑正文、调整属性，再选择保存到 Obsidian 或飞书。',
  selectionMarkdown: '',
  wordCount: 48,
  highlights: [],
};

function isUiPreview(): boolean {
  return (
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('ui-preview')
  );
}

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

function isInvalidObsidianVaultName(value: string): boolean {
  const name = value.trim().toLowerCase();
  return !name || name === '飞书知识库' || name === 'feishu' || name === 'feishu wiki';
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
  const [timestamping, setTimestamping] = useState(false);
  const [douyinTranscribing, setDouyinTranscribing] = useState(false);
  const [douyinStatus, setDouyinStatus] = useState('');
  const [douyinStatusKind, setDouyinStatusKind] = useState<'idle' | 'success' | 'error'>('idle');
  const [conflictPath, setConflictPath] = useState('');
  const [pendingDraft, setPendingDraft] = useState<ClipDraft | null>(null);
  const [draftReady, setDraftReady] = useState(false);
  const [draftTouched, setDraftTouched] = useState(false);

  useEffect(() => {
    (async () => {
      const preview = isUiPreview();
      const [resp, s] = preview
        ? ([{ ok: true, data: PREVIEW_PAGE }, {
            ...DEFAULT_SETTINGS,
            vaultProfiles: [
              {
                id: 'preview-obsidian',
                vaultName: 'Nomo 知识库',
                saveMethod: 'uri',
                restBaseUrl: DEFAULT_SETTINGS.restBaseUrl,
                restApiKey: '',
                defaultFolder: '剪藏/',
              },
              {
                id: 'preview-feishu',
                vaultName: '飞书知识库',
                saveMethod: 'feishu',
                restBaseUrl: DEFAULT_SETTINGS.restBaseUrl,
                restApiKey: '',
                defaultFolder: '',
                feishuSpaceName: '产品学习库',
                feishuParentTitle: 'AI 产品',
              },
            ],
            activeProfileId: 'preview-obsidian',
            vaultName: 'Nomo 知识库',
            defaultFolder: '剪藏/',
          }] as [ExtractResponse, Settings])
        : await Promise.all([extractActiveTab(), loadSettings()]);
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
      const draft = preview ? undefined : await loadClipDraft(d.url).catch(() => undefined);
      setPendingDraft(draft || null);
      setDraftReady(true);
      setPhase('ready');
    })();
  }, []);

  function touchDraft() {
    setDraftTouched(true);
    setSavedUri(null);
    setConflictPath('');
  }

  function currentDraft(): ClipDraft | null {
    if (!page || !settings) return null;
    return {
      version: 1,
      sourceUrl: page.url,
      updatedAt: Date.now(),
      targetProfileId: settings.activeProfileId,
      title,
      body,
      useSelection,
      author,
      published,
      modified,
      description,
      learned,
      folder,
      filename,
      vault,
      saveImagesLocal,
    };
  }

  async function persistCurrentDraft(): Promise<void> {
    const draft = currentDraft();
    if (draft) await saveClipDraft(draft);
  }

  // 用户编辑后防抖保存；popup 被意外关闭或保存失败时可恢复。
  useEffect(() => {
    if (!draftReady || !draftTouched || pendingDraft || savingTarget || !page || !settings) return;
    const draft = currentDraft();
    if (!draft) return;
    const timer = window.setTimeout(() => {
      saveClipDraft(draft).catch(() => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [
    draftReady,
    draftTouched,
    pendingDraft,
    savingTarget,
    page,
    settings,
    title,
    body,
    useSelection,
    author,
    published,
    modified,
    description,
    learned,
    folder,
    filename,
    vault,
    saveImagesLocal,
  ]);

  // 尽力覆盖“刚编辑就关闭弹窗、尚未等到防抖定时器”的情况。
  useEffect(() => {
    if (!draftReady || !draftTouched || pendingDraft || savingTarget || !page || !settings) return;
    const saveBeforeClose = () => {
      const draft = currentDraft();
      if (draft) void saveClipDraft(draft);
    };
    window.addEventListener('pagehide', saveBeforeClose);
    return () => window.removeEventListener('pagehide', saveBeforeClose);
  }, [
    draftReady,
    draftTouched,
    pendingDraft,
    savingTarget,
    page,
    settings,
    title,
    body,
    useSelection,
    author,
    published,
    modified,
    description,
    learned,
    folder,
    filename,
    vault,
    saveImagesLocal,
  ]);

  function restorePendingDraft() {
    if (!pendingDraft || !settings) return;
    const d = pendingDraft;
    const profile = settings.vaultProfiles.find(
      (p) => p.id === d.targetProfileId && p.saveMethod !== 'feishu',
    );
    if (profile) {
      const next: Settings = {
        ...settings,
        activeProfileId: profile.id,
        saveMethod: profile.saveMethod,
        vaultName: profile.vaultName,
        restBaseUrl: profile.restBaseUrl,
        restApiKey: profile.restApiKey,
        defaultFolder: profile.defaultFolder,
      };
      setSettings(next);
      void saveSettings(next).catch(() => {});
    }
    setTitle(d.title);
    setBody(d.body);
    setUseSelection(d.useSelection);
    setAuthor(d.author);
    setPublished(d.published);
    setModified(d.modified);
    setDescription(d.description);
    setLearned(d.learned);
    setFolder(d.folder);
    setFilename(d.filename);
    setVault(d.vault);
    setSaveImagesLocal(d.saveImagesLocal);
    setPendingDraft(null);
    setDraftTouched(true);
    setSavedMsg(T.draftRestored);
  }

  async function discardPendingDraft() {
    if (pendingDraft) await removeClipDraft(pendingDraft.sourceUrl).catch(() => {});
    setPendingDraft(null);
    setDraftTouched(false);
    setSavedMsg(T.draftDiscarded);
  }

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
        touchDraft();
      } else {
        setSavedMsg(resp.error);
      }
    } finally {
      setFullCapturing(false);
    }
  }

  async function handleBilibiliTimestamp() {
    if (timestamping) return;
    setTimestamping(true);
    setSavedMsg('');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('未找到当前 B站标签页');
      const resp = await sendToTab<BilibiliTimestampResponse>(tab.id, {
        type: 'ZHAOJI_CLIPPER_BILI_TIMESTAMP',
      });
      if (!resp?.ok) throw new Error(resp?.error || '无法读取当前播放时间');
      const line = `- [${resp.label}](${resp.url})`;
      setBody((prev) => appendTimestampNote(prev, line));
      touchDraft();
      setSavedMsg(T.biliTimestampAdded(resp.label));
    } catch (e) {
      setSavedMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setTimestamping(false);
    }
  }

  async function handleDouyinTranscript() {
    if (douyinTranscribing) return;
    setDouyinTranscribing(true);
    setDouyinStatus(T.douyinConnecting);
    setDouyinStatusKind('idle');
    setSavedMsg('');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('未找到当前抖音标签页');
      setDouyinStatus('正在检查本地字幕助手…');
      const ping = (await chrome.runtime.sendMessage({
        type: 'NOMO_CLIPPER_NATIVE_PING',
      })) as NativeTranscriberPingResponse | undefined;
      if (!ping) throw new Error('本地字幕助手没有返回自检结果');
      if (!ping.ok) {
        throw new Error(
          `本地字幕助手连接失败（扩展 ID：${ping.extensionId}）：${ping.error}`,
        );
      }
      setDouyinStatus(`本地字幕助手 v${ping.version} 已连接，正在读取当前视频…`);
      const media = await sendToTab<DouyinMediaResponse>(tab.id, {
        type: 'NOMO_CLIPPER_DOUYIN_MEDIA',
      });
      if (!media?.ok) throw new Error(media?.error || '无法读取当前抖音视频');
      if (!media.mediaUrl.startsWith('https:')) {
        throw new Error(
          '尚未捕获到当前视频地址。请刷新抖音页面，播放 3 秒后再点“转录抖音字幕”。',
        );
      }
      if (media.duration > 30 * 60) {
        throw new Error('当前视频超过 30 分钟，请选择更短的视频后重试');
      }
      const sourceLabel =
        media.mediaSource === 'response'
          ? '页面响应'
          : media.mediaSource === 'player'
            ? '播放器'
            : '网络请求';
      setDouyinStatus(
        `已从${sourceLabel}读取当前视频${media.awemeId ? `（${media.awemeId}）` : ''}，正在提取音频并识别…`,
      );
      const result = await transcribeDouyinMedia({
        mediaUrl: media.mediaUrl,
        pageUrl: media.pageUrl,
        title: media.title,
      });
      if (!result.segments.length) throw new Error('没有识别到清晰的人声');
      setBody((prev) => upsertDouyinTranscript(prev, result.segments));
      touchDraft();
      setDouyinStatus(
        T.douyinTranscriptAdded(
          result.segments.length,
          result.device === 'cuda' ? 'RTX 显卡' : 'CPU',
          result.elapsed,
        ),
      );
      setDouyinStatusKind('success');
    } catch (e) {
      setDouyinStatus(e instanceof Error ? e.message : String(e));
      setDouyinStatusKind('error');
    } finally {
      setDouyinTranscribing(false);
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
    touchDraft();
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
    touchDraft();
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
    setConflictPath('');
    touchDraft();
    await saveSettings(next).catch(() => {});
  }

  // 切换图片处理方式（下载到本地 / 引用链接）。与设置页同一开关，改动同步回设置，两处保持一致
  async function changeImageMode(download: boolean) {
    setSaveImagesLocal(download);
    touchDraft();
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

  // REST 模式下预查目标路径，仅用于提前提示；点击保存时仍会实时复查并阻断异常。
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
    checkFileState(
      { baseUrl: obsidianProfile.restBaseUrl, apiKey: obsidianProfile.restApiKey },
      path,
    )
      .then((state) => {
        if (!cancelled) setAlreadyExists(state === 'exists');
      })
      .catch(() => {
        if (!cancelled) setAlreadyExists(false);
      });
    return () => {
      cancelled = true;
    };
  }, [settings, obsidianMethod, obsidianProfile, clipFolder, filename]);

  async function handleSave(
    target: SaveTarget,
    conflictChoice?: ConflictChoice,
    preserveSavedUri = false,
  ): Promise<SaveResult> {
    if (!page || !settings) return { outcome: 'failed', message: '页面内容尚未准备完成' };
    if (pendingDraft) {
      setSavedMsg(T.draftChooseFirst);
      return { outcome: 'failed', message: T.draftChooseFirst };
    }
    const method = obsidianProfile?.saveMethod || settings.saveMethod;
    const isRest = method === 'rest';
    const obsVault = (obsidianProfile?.vaultName || vault).trim();

    if (target === 'obsidian' && !obsidianProfile) {
      const message = '请先在设置里添加一个 Obsidian 保存目标';
      setSavedMsg(message);
      return { outcome: 'failed', message };
    }
    if (target === 'obsidian' && isRest && !obsidianProfile?.restApiKey.trim()) {
      setSavedMsg(T.needApiKey);
      return { outcome: 'failed', message: T.needApiKey };
    }
    if (target === 'obsidian' && method === 'uri' && isInvalidObsidianVaultName(obsVault)) {
      const message = obsVault
        ? `Obsidian 仓库名称被误设为“${obsVault}”，请在设置中填写真实仓库名`
        : T.needVault;
      setSavedMsg(message);
      return { outcome: 'failed', message };
    }
    if (target === 'feishu' && !feishuProfile) {
      const message = '请先在设置里添加一个飞书知识库保存目标';
      setSavedMsg(message);
      return { outcome: 'failed', message };
    }
    if (target === 'feishu' && (!feishuProfile?.feishuAppId?.trim() || !feishuProfile?.feishuAppSecret?.trim())) {
      setSavedMsg(T.feishuNeedApp);
      return { outcome: 'failed', message: T.feishuNeedApp };
    }
    if (target === 'feishu' && !feishuProfile?.feishuSpaceId) {
      setSavedMsg(T.feishuNeedSpace);
      return { outcome: 'failed', message: T.feishuNeedSpace };
    }

    setSavingTarget(target);
    if (!preserveSavedUri) setSavedUri(null);
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
    const requestedFilePath = joinPath(clipFolder, filename);
    let finalFilePath = requestedFilePath;
    let savedAsCopy = false;

    try {
      // 外部写入前先落一份白名单草稿；失败和取消都保留，明确成功后才清除。
      await persistCurrentDraft().catch(() => {});

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
        setSavedMsg('正在读取网页配图…');
        const imageResult = await collectAllImages(
          md,
          page.inlineImages,
          (done, total) => setSavedMsg(`正在读取网页配图 ${done}/${total}…`),
        );
        const r = await saveToFeishu(fcfg, title, md, imageResult.images, (m) => setSavedMsg(m));
        if (imageResult.lastError && !r.lastError) r.lastError = imageResult.lastError;
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
        const message = (r.partial ? T.savedPartial : T.savedOk) + tail + warn;
        setSavedMsg(message);
        await removeClipDraft(page.url).catch(() => {});
        setDraftTouched(false);
        return { outcome: 'saved', message, uri: r.url || undefined };
      }

      let note = composeNote(props, body, settings);
      const imagesFolder = settings.folderPerClip ? clipFolder : settings.attachmentsFolder;
      let tailMsg = '';
      if (isRest) {
        const restCfg = {
          baseUrl: obsidianProfile?.restBaseUrl || settings.restBaseUrl,
          apiKey: obsidianProfile?.restApiKey || settings.restApiKey,
        };

        // 冲突检查必须先于任何图片 PUT，取消时不会留下或覆盖附件。
        if (!conflictChoice || conflictPath !== requestedFilePath) {
          const state = await checkFileState(restCfg, requestedFilePath);
          if (state === 'exists') {
            setConflictPath(requestedFilePath);
            return { outcome: 'conflict', message: T.conflictTitle };
          }
        } else if (conflictChoice === 'copy') {
          finalFilePath = await findAvailableCopyPath(restCfg, requestedFilePath);
          savedAsCopy = true;
        }
        setConflictPath('');
        setAlreadyExists(false);

        // 下载模式：下载全部图片；引用模式：只下载无法被引用的图（飞书/blob），其余保留链接
        const urlFilter = saveImagesLocal ? undefined : isUnreferenceable;
        const imageTitle = savedAsCopy ? finalFilePath.split('/').pop() || title : title;
        const r = await processNoteImages(
          note,
          imageTitle,
          imagesFolder,
          restCfg,
          (d, t) => setSavedMsg(`正在保存图片 ${d}/${t}…`),
          page.inlineImages,
          urlFilter,
        );
        note = r.note;
        if (r.total > 0) {
          const base = saveImagesLocal
            ? T.imagesSavedAll(r.saved, r.total)
            : T.imagesSavedGated(r.saved, r.total);
          setSavedMsg(
            base + (r.saved < r.total && r.lastError ? T.imagesSavedFail(r.lastError) : ''),
          );
          await new Promise((res) => setTimeout(res, 900));
        }
        note = inlineImageRowsToHtml(note, settings.folderPerClip);
        await saveViaRest(restCfg, finalFilePath, note);
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
          IMG_LINK_RE.lastIndex = 0;
          if (gated) tailMsg = T.gatedImagesUriNote;
        }
        const uri = buildObsidianUri({ vault: obsVault, filePath: finalFilePath, content: note });
        const opened = (await chrome.runtime.sendMessage({
          type: 'ZHAOJI_CLIPPER_SAVE',
          url: uri,
        })) as { ok?: boolean; error?: string } | undefined;
        if (!opened?.ok) throw new Error(opened?.error || '未能打开 Obsidian');
      }

      const canOpenVault = !isInvalidObsidianVaultName(obsVault);
      const openUri = canOpenVault ? buildOpenUri(obsVault, finalFilePath) : undefined;
      if (openUri) setSavedUri(openUri);
      let message: string;
      if (savedAsCopy) {
        const leaf = finalFilePath.split('/').pop() || filename;
        setFilename(leaf);
        message = T.savedAsCopy(leaf) + tailMsg;
      } else {
        message = T.savedOk + tailMsg;
      }
      if (!canOpenVault) message += '（已保存，但需填写正确仓库名后才能直接打开）';
      setSavedMsg(message);
      await removeClipDraft(page.url).catch(() => {});
      setDraftTouched(false);
      return { outcome: 'saved', message, uri: openUri };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setSavedMsg(message);
      return { outcome: 'failed', message };
    } finally {
      setSavingTarget(null);
    }
  }

  async function saveOneTarget(target: SaveTarget, conflictChoice?: ConflictChoice) {
    setSavedUri(null);
    const result = await handleSave(target, conflictChoice);
    if (result.outcome === 'conflict') return;
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
    touchDraft();
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
        <div className="zc-logo">Nomo Clipper</div>
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
        <div className="zc-brand-lockup">
          <span className="zc-brand-name">Nomo Clipper</span>
        </div>
        {page && (
          <span className="zc-muted zc-words" title={page.domain}>
            {page.domain} · {T.wordCount(page.wordCount)}
          </span>
        )}
        <button
          className="zc-icon-btn"
          title={T.openSettings}
          onClick={() => chrome.runtime.openOptionsPage()}
        >
          设置
        </button>
      </header>

      <main className="zc-scroll">
        {pendingDraft && (
          <div className="zc-draft-banner" role="status">
            <div>
              <strong>{T.draftFound}</strong>
              <span>{new Date(pendingDraft.updatedAt).toLocaleString()}</span>
            </div>
            <div className="zc-draft-actions">
              <button onClick={restorePendingDraft}>{T.draftRestore}</button>
              <button className="zc-draft-discard" onClick={discardPendingDraft}>
                {T.draftDiscard}
              </button>
            </div>
          </div>
        )}

        {(douyinStatus || savedMsg) && (
          <div
            className={
              'zc-feedback' +
              (douyinTranscribing
                ? ' busy'
                : douyinStatus
                  ? ` ${douyinStatusKind}`
                  : savedUri
                    ? ' success'
                    : '')
            }
            role="status"
            aria-live="polite"
          >
            {douyinTranscribing && <span className="zc-mini-spinner" aria-hidden="true" />}
            <span>{douyinStatus || savedMsg}</span>
          </div>
        )}

        <textarea
          className="zc-hero"
          value={title}
          placeholder="未命名"
          rows={1}
          onChange={(e) => {
            setTitle(e.target.value);
            touchDraft();
          }}
        />

        <div className="zc-toolgrid">
          <button
            className="zc-fullcap zc-fullcap-primary"
            onClick={handleFullCapture}
            disabled={fullCapturing}
            title={T.fullCaptureHint}
          >
            {fullCapturing ? T.fullCapturing : T.fullCapture}
          </button>
          {page?.domain === 'bilibili.com' && (
            <button className="zc-fullcap" onClick={handleBilibiliTimestamp} disabled={timestamping}>
              {timestamping ? T.biliTimestamping : T.biliTimestamp}
            </button>
          )}
          {page && /(^|\.)douyin\.com$/i.test(page.domain) && (
            <button
              className="zc-fullcap zc-transcribe"
              onClick={handleDouyinTranscript}
              disabled={douyinTranscribing}
              title={T.douyinTranscriptHint}
            >
              {douyinTranscribing ? T.douyinTranscribing : T.douyinTranscript}
            </button>
          )}
        </div>
        {fullCapturing && <div className="zc-muted zc-caphint">{T.fullCaptureHint}</div>}
        {douyinTranscribing && <div className="zc-muted zc-caphint">{T.douyinKeepOpen}</div>}

        <div className="zc-row zc-between zc-content-head">
          <label className="zc-label zc-section">{T.fieldContent}</label>
          {page?.selectionMarkdown.trim() && (
            <div className="zc-toggle">
              <button className={useSelection ? 'on' : ''} onClick={() => toggleSource(true)}>
                {T.useSelection}
              </button>
              <button className={!useSelection ? 'on' : ''} onClick={() => toggleSource(false)}>
                {T.useFullArticle}
              </button>
            </div>
          )}
        </div>

        <textarea
          className="zc-input zc-textarea"
          value={body}
          onChange={(e) => {
            setBody(e.target.value);
            touchDraft();
          }}
          rows={8}
        />

        <details className="zc-content-options">
          <summary>
            <span className="zc-option-dots" aria-hidden="true">
              <i className="on" />
              <i className={settings?.highlightFloatingButton ? 'on' : ''} />
              <i className={saveImagesLocal ? 'on' : ''} />
            </span>
            <strong>内容选项</strong>
            <span>属性 · 图片 · 高亮 · 文件名</span>
          </summary>
          <div className="zc-options-body">
            <div className="zc-options-panel-head">
              <div>
                <strong>内容选项</strong>
                <span>属性、图片、高亮与文件名</span>
              </div>
              <button
                onClick={(event) => {
                  const details = event.currentTarget.closest('details');
                  if (details) details.open = false;
                }}
              >
                完成
              </button>
            </div>
            <section className="zc-option-section">
              <div className="zc-option-title">{T.properties}</div>
              <div className="zc-props">
                <div className="zc-prop">
                  <span className="zc-prop-key">学习状态</span>
                  <label className="zc-learned">
                    <input type="checkbox" checked={learned} onChange={(e) => toggleLearned(e.target.checked)} />
                    {T.markLearned}
                    <span>{learned ? settings?.learnedTag : settings?.unreadTag}</span>
                  </label>
                </div>
                <div className="zc-prop">
                  <span className="zc-prop-key">{T.propLabels.source}</span>
                  <input className="zc-prop-val zc-ro" value={page?.url ?? ''} readOnly />
                </div>
                <div className="zc-prop">
                  <span className="zc-prop-key">{T.propLabels.author}</span>
                  <input className="zc-prop-val" value={author} onChange={(e) => { setAuthor(e.target.value); touchDraft(); }} />
                </div>
                <div className="zc-prop">
                  <span className="zc-prop-key">{T.propLabels.published}</span>
                  <input className="zc-prop-val" value={published} placeholder="YYYY-MM-DD" onChange={(e) => { setPublished(e.target.value); touchDraft(); }} />
                </div>
                <div className="zc-prop">
                  <span className="zc-prop-key">{T.propLabels.modified}</span>
                  <input className="zc-prop-val" value={modified} placeholder="YYYY-MM-DD" onChange={(e) => { setModified(e.target.value); touchDraft(); }} />
                </div>
                <div className="zc-prop">
                  <span className="zc-prop-key">{T.propLabels.created}</span>
                  <input className="zc-prop-val zc-ro" value={today()} readOnly />
                </div>
                <div className="zc-prop zc-prop-top">
                  <span className="zc-prop-key">{T.propLabels.description}</span>
                  <textarea className="zc-prop-val zc-prop-ta" value={description} rows={2} onChange={(e) => { setDescription(e.target.value); touchDraft(); }} />
                </div>
              </div>
            </section>

            {settings && (
              <section className="zc-option-section">
                <div className="zc-hlbar">
                  <div className="zc-hltop">
                    <div className="zc-hlmain">
                      <span className="zc-hltitle">{T.highlightTool}</span>
                      <span className="zc-hlhint">{T.highlightShortcutHint}</span>
                    </div>
                    <label className="zc-switch">
                      <input type="checkbox" checked={settings.highlightFloatingButton} onChange={(e) => changeHighlightFloating(e.target.checked)} />
                      <span>{T.highlightFloatingToggle}</span>
                    </label>
                  </div>
                  {page && page.highlights.length > 0 && (
                    <div className="zc-hlactions">
                      <span className="zc-hlcount">{T.highlightsCount(page.highlights.length)}</span>
                      <button className="zc-hlbtn" onClick={insertHighlights}>{T.insertHighlights}</button>
                      <button className="zc-hlbtn zc-hlbtn-ghost" onClick={clearHighlights}>{T.clearHighlights}</button>
                    </div>
                  )}
                </div>
              </section>
            )}

            <section className="zc-option-section">
              {settings && obsidianProfiles.length > 1 && (
                <div className="zc-row zc-between zc-profilerow">
                  <label className="zc-label zc-section">{T.saveTo}</label>
                  <select className="zc-profile-select" value={obsidianProfile?.id || ''} onChange={(e) => switchProfile(e.target.value)}>
                    {obsidianProfiles.map((p) => <option key={p.id} value={p.id}>{profileLabel(p.vaultName, p.saveMethod)}</option>)}
                  </select>
                </div>
              )}
              {feishuProfile && <div className="zc-fieldhint">{T.feishuImageHint}</div>}
              {(() => {
                const isRest = obsidianMethod === 'rest';
                const downloadActive = isRest && saveImagesLocal;
                return (
                  <div className="zc-imgblock">
                    <div className="zc-row zc-between">
                      <label className="zc-label zc-section">{T.imageSection}</label>
                      <div className="zc-toggle">
                        <button className={downloadActive ? 'on' : ''} disabled={!isRest} title={isRest ? '' : T.imageDownloadNeedRest} onClick={() => changeImageMode(true)}>{T.imageDownload}</button>
                        <button className={!downloadActive ? 'on' : ''} onClick={() => changeImageMode(false)}>{T.imageReference}</button>
                      </div>
                    </div>
                    <div className="zc-fieldhint">{!isRest ? T.imageDownloadNeedRest : downloadActive ? T.imageDownloadHint : T.imageReferenceHint}</div>
                  </div>
                );
              })()}
            </section>

            <section className="zc-option-section">
              <div className="zc-destgrid">
                <div className="zc-dest-open">
                  <div className="zc-dest-pathline" title={T.saveLocation}>
                    <span className="zc-dest-path">{(clipFolder ? `${clipFolder}/` : '') + safeName(filename)}.md</span>
                  </div>
                  <label className="zc-label">{T.fieldFilename}</label>
                  <input className="zc-input" value={filename} onChange={(e) => { setFilename(e.target.value); touchDraft(); }} />
                  <div className="zc-fieldhint">{T.filenameNote}</div>
                </div>
                <div className="zc-dest-open">
                  <div className="zc-dest-pathline" title={T.feishuDest}>
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
            </section>

            {obsidianMethod === 'uri' && uriPreviewLength > URI_LENGTH_WARN && <div className="zc-warn">{T.tooLongWarn}</div>}
            {alreadyExists && !savedUri && <div className="zc-warn">{T.existsWarn}</div>}
            <button className="zc-diaglink" onClick={handleDiagnose} disabled={diagnosing}>
              {diagnosing ? T.diagnosing : T.diagnose}
            </button>
          </div>
        </details>
      </main>

      <footer className="zc-actionbar">
        <div className="zc-save-actions zc-save-actions-split">
          <button
            className="zc-save zc-save-obsidian"
            onClick={() => saveOneTarget('obsidian')}
            disabled={!!savingTarget || !!pendingDraft}
            title={obsidianProfile ? '保存到 Obsidian' : '尚未配置 Obsidian'}
          >
            <span>{savingTarget === 'obsidian' ? T.saving : '保存到 Obsidian'}</span>
          </button>
          <button
            className="zc-save zc-save-feishu"
            onClick={() => saveOneTarget('feishu')}
            disabled={!!savingTarget || !!pendingDraft}
            title={feishuProfile ? '保存到飞书知识库' : '尚未配置飞书知识库'}
          >
            <span>{savingTarget === 'feishu' ? T.saving : '保存到飞书'}</span>
          </button>
        </div>
      </footer>

      {conflictPath && (
        <div className="zc-dialog-backdrop" role="presentation">
          <div className="zc-dialog" role="dialog" aria-modal="true" aria-labelledby="zc-conflict-title">
            <div id="zc-conflict-title" className="zc-dialog-title">
              {T.conflictTitle}
            </div>
            <div className="zc-dialog-path">{conflictPath}.md</div>
            <p>{T.conflictHint}</p>
            <div className="zc-dialog-actions">
              <button
                className="zc-dialog-danger"
                disabled={!!savingTarget}
                onClick={() => saveOneTarget('obsidian', 'overwrite')}
              >
                {T.conflictOverwrite}
              </button>
              <button
                className="zc-dialog-primary"
                disabled={!!savingTarget}
                onClick={() => saveOneTarget('obsidian', 'copy')}
              >
                {T.conflictCopy}
              </button>
              <button
                disabled={!!savingTarget}
                onClick={() => setConflictPath('')}
              >
                {T.conflictCancel}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
