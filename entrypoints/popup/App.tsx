import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { T } from '@/utils/strings';
import { loadSettings, loadTagHistory, pushTagHistory } from '@/utils/storage';
import { composeNote } from '@/utils/frontmatter';
import { buildObsidianUri, buildOpenUri, URI_LENGTH_WARN } from '@/utils/obsidian';
import { saveViaRest, fileExists } from '@/utils/rest';
import { processNoteImages } from '@/utils/images';
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
} from '@/utils/types';

type Phase = 'loading' | 'ready' | 'error';

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

function parseTags(input: string): string[] {
  return input
    .split(/[,，]/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** 按用户黑名单机械过滤页面标签（归一化大小写/空格/连字符比较），非 AI 判断 */
function filterTags(tags: string[], blocklist: string[]): string[] {
  const norm = (s: string) => s.toLowerCase().replace(/[\s\-]+/g, '');
  const block = new Set(blocklist.map(norm).filter(Boolean));
  return tags.filter((t) => !block.has(norm(t)));
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
  const [description, setDescription] = useState('');
  const [tagsStr, setTagsStr] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [folder, setFolder] = useState('');
  const [filename, setFilename] = useState('');
  const [vault, setVault] = useState('');

  const [saving, setSaving] = useState(false);
  const [savedMsg, setSavedMsg] = useState('');
  const [savedUri, setSavedUri] = useState<string | null>(null); // 保存成功后的"打开"URI（#2）
  const [alreadyExists, setAlreadyExists] = useState(false); // 目标已存在（#1 去重，仅 REST）
  const [tagHistory, setTagHistory] = useState<string[]>([]); // 常用标签历史（#3）
  const [fullCapturing, setFullCapturing] = useState(false);
  const [diagnosing, setDiagnosing] = useState(false);

  useEffect(() => {
    (async () => {
      const [resp, s, th] = await Promise.all([
        extractActiveTab(),
        loadSettings(),
        loadTagHistory(),
      ]);
      setSettings(s);
      document.documentElement.dataset.theme = s.theme; // 应用主题（auto/light/dark）
      setVault(s.vaultName);
      setFolder(s.defaultFolder);
      setTagHistory(th);
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
      setDescription(d.description || '');
      if (d.tags?.length) {
        const kept = filterTags(d.tags, s.tagBlocklist || []);
        if (kept.length) setTagsStr(kept.join(', '));
      }
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
        if (d.tags?.length) {
          const kept = filterTags(d.tags, settings?.tagBlocklist || []);
          if (kept.length) setTagsStr(kept.join(', '));
        }
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

  // 切换选区/整页
  function toggleSource(useSel: boolean) {
    if (!page) return;
    setUseSelection(useSel);
    setBody(useSel ? page.selectionMarkdown : page.contentMarkdown);
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

  const uriPreviewLength = useMemo(() => {
    if (!page || !settings) return 0;
    const props: ClipProperties = {
      title,
      source: page.url,
      author,
      published,
      description,
      clipped: today(),
      tags: parseTags(tagsStr),
      stats: page.stats,
    };
    const note = composeNote(props, body, settings);
    return buildObsidianUri({ vault, filePath: joinPath(clipFolder, filename), content: note })
      .length;
  }, [page, settings, title, author, published, tagsStr, body, vault, clipFolder, filename]);

  // #1 去重：REST 模式下查目标路径是否已存在（仅提示，不阻断；失败按不存在）
  useEffect(() => {
    if (
      !settings ||
      settings.saveMethod !== 'rest' ||
      !settings.restApiKey.trim() ||
      !filename.trim()
    ) {
      setAlreadyExists(false);
      return;
    }
    let cancelled = false;
    const path = joinPath(clipFolder, filename);
    fileExists({ baseUrl: settings.restBaseUrl, apiKey: settings.restApiKey }, path).then((ex) => {
      if (!cancelled) setAlreadyExists(ex);
    });
    return () => {
      cancelled = true;
    };
  }, [settings, clipFolder, filename]);

  async function handleSave() {
    if (!page || !settings) return;
    const isRest = settings.saveMethod === 'rest';
    if (isRest && !settings.restApiKey.trim()) {
      setSavedMsg(T.needApiKey);
      return;
    }
    if (!isRest && !vault.trim()) {
      setSavedMsg(T.needVault);
      return;
    }
    setSaving(true);
    setSavedMsg('');
    const props: ClipProperties = {
      title,
      source: page.url,
      author,
      published,
      description,
      clipped: today(),
      tags: parseTags(tagsStr),
      stats: page.stats,
    };
    let note = composeNote(props, body, settings);
    const filePath = joinPath(clipFolder, filename);
    // 开启独立文件夹时，图片就放进该文件夹；否则放全局附件夹
    const imagesFolder = settings.folderPerClip ? clipFolder : settings.attachmentsFolder;
    try {
      if (isRest) {
        const restCfg = { baseUrl: settings.restBaseUrl, apiKey: settings.restApiKey };
        if (settings.saveImagesLocal) {
          const r = await processNoteImages(
            note,
            title,
            imagesFolder,
            restCfg,
            (d, t) => setSavedMsg(`正在保存图片 ${d}/${t}…`),
            page.inlineImages,
          );
          note = r.note;
          if (r.total > 0) {
            setSavedMsg(
              `图片 ${r.saved}/${r.total} 已保存` +
                (r.saved < r.total && r.lastError ? `（失败：${r.lastError}）` : ''),
            );
            await new Promise((res) => setTimeout(res, 900));
          }
        }
        await saveViaRest(restCfg, filePath, note);
      } else {
        const uri = buildObsidianUri({ vault: vault.trim(), filePath, content: note });
        await chrome.runtime.sendMessage({ type: 'ZHAOJI_CLIPPER_SAVE', url: uri });
      }
      await pushTagHistory(props.tags); // #3 记住用过的标签
      setSavedUri(buildOpenUri(vault.trim(), filePath)); // #2 保存后可打开
      setSavedMsg(T.savedOk);
    } catch (e) {
      setSavedMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  // #2 保存后在 Obsidian 打开该笔记（复用 background 的 obsidian:// 打开通道）
  async function handleOpenNote() {
    if (!savedUri) return;
    await chrome.runtime.sendMessage({ type: 'ZHAOJI_CLIPPER_SAVE', url: savedUri });
    window.close();
  }

  // 标签编辑（chip 式）：追加 / 移除 / 输入提交
  function appendTag(tag: string) {
    const t = tag.trim().replace(/^#+/, '');
    if (!t) return;
    const cur = parseTags(tagsStr);
    if (cur.some((x) => x.toLowerCase() === t.toLowerCase())) return;
    setTagsStr([...cur, t].join(', '));
  }
  function removeTag(tag: string) {
    setTagsStr(parseTags(tagsStr).filter((t) => t !== tag).join(', '));
  }
  function commitTagInput() {
    if (tagInput.trim()) appendTag(tagInput);
    setTagInput('');
  }
  function handleTagKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
      e.preventDefault();
      commitTagInput();
    } else if (e.key === 'Backspace' && !tagInput) {
      const cur = parseTags(tagsStr);
      if (cur.length) setTagsStr(cur.slice(0, -1).join(', '));
    }
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
          <span className="zc-prop-icon">🔗</span>
          <span className="zc-prop-key">source</span>
          <input className="zc-prop-val zc-ro" value={page?.url ?? ''} readOnly />
        </div>
        <div className="zc-prop">
          <span className="zc-prop-icon">👤</span>
          <span className="zc-prop-key">author</span>
          <input
            className="zc-prop-val"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
          />
        </div>
        <div className="zc-prop">
          <span className="zc-prop-icon">📅</span>
          <span className="zc-prop-key">published</span>
          <input
            className="zc-prop-val"
            value={published}
            placeholder="YYYY-MM-DD"
            onChange={(e) => setPublished(e.target.value)}
          />
        </div>
        <div className="zc-prop">
          <span className="zc-prop-icon">🕐</span>
          <span className="zc-prop-key">created</span>
          <input className="zc-prop-val zc-ro" value={today()} readOnly />
        </div>
        <div className="zc-prop zc-prop-top">
          <span className="zc-prop-icon">📄</span>
          <span className="zc-prop-key">description</span>
          <textarea
            className="zc-prop-val zc-prop-ta"
            value={description}
            rows={2}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="zc-prop zc-prop-top">
          <span className="zc-prop-icon">🏷️</span>
          <span className="zc-prop-key">tags</span>
          <div className="zc-prop-val zc-tagbox">
            <div className="zc-taglist">
              {parseTags(tagsStr).map((t) => (
                <span className="zc-tag" key={t}>
                  {t}
                  <button className="zc-tag-x" title="移除" onClick={() => removeTag(t)}>
                    ✕
                  </button>
                </span>
              ))}
              <input
                className="zc-tag-input"
                value={tagInput}
                placeholder={parseTags(tagsStr).length ? '' : T.addTag}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={handleTagKey}
                onBlur={commitTagInput}
              />
            </div>
            {(() => {
              const recent = tagHistory.filter(
                (t) => !parseTags(tagsStr).some((c) => c.toLowerCase() === t.toLowerCase()),
              );
              return recent.length > 0 ? (
                <div className="zc-tagrecent">
                  <span className="zc-tagrecent-label">{T.recentTags}</span>
                  {recent.slice(0, 5).map((t) => (
                    <button key={t} type="button" className="zc-chip" onClick={() => appendTag(t)}>
                      {t}
                    </button>
                  ))}
                </div>
              ) : null;
            })()}
          </div>
        </div>
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

      {page && page.highlights.length > 0 && (
        <div className="zc-hlbar">
          <span>🖍 {T.highlightsCount(page.highlights.length)}</span>
          <button className="zc-hlbtn" onClick={insertHighlights}>
            {T.insertHighlights}
          </button>
          <button className="zc-hlbtn zc-hlbtn-ghost" onClick={clearHighlights}>
            {T.clearHighlights}
          </button>
        </div>
      )}

      <textarea
        className="zc-input zc-textarea"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        rows={8}
      />

      <details className="zc-dest">
        <summary>
          <span className="zc-dest-icon">📁</span>
          <span className="zc-dest-path">
            {(clipFolder ? `${clipFolder}/` : '') + safeName(filename)}.md
          </span>
          <span className="zc-dest-edit">{T.saveLocation}</span>
        </summary>
        <div className="zc-dest-body">
          <div className="zc-grid2">
            <div>
              <label className="zc-label">{T.fieldVault}</label>
              <input className="zc-input" value={vault} onChange={(e) => setVault(e.target.value)} />
            </div>
            <div>
              <label className="zc-label">{T.fieldFolder}</label>
              <input
                className="zc-input"
                value={folder}
                onChange={(e) => setFolder(e.target.value)}
              />
            </div>
          </div>
          <label className="zc-label">{T.fieldFilename}</label>
          <input
            className="zc-input"
            value={filename}
            onChange={(e) => setFilename(e.target.value)}
          />
          <div className="zc-fieldhint">{T.filenameNote}</div>
        </div>
      </details>

      {settings?.saveMethod !== 'rest' && uriPreviewLength > URI_LENGTH_WARN && (
        <div className="zc-warn">⚠ {T.tooLongWarn}</div>
      )}
      {alreadyExists && !savedUri && <div className="zc-warn">{T.existsWarn}</div>}
      {savedMsg && <div className="zc-savedmsg">{savedMsg}</div>}

      {savedUri ? (
        <div className="zc-saveddone">
          <button className="zc-save" onClick={handleOpenNote}>
            {T.openInObsidian}
          </button>
          <button className="zc-save zc-save-ghost" onClick={() => window.close()}>
            {T.closeWindow}
          </button>
        </div>
      ) : (
        <button className="zc-save" onClick={handleSave} disabled={saving}>
          {saving ? T.saving : T.save}
        </button>
      )}

      <button className="zc-diaglink" onClick={handleDiagnose} disabled={diagnosing}>
        {diagnosing ? T.diagnosing : T.diagnose}
      </button>
    </div>
  );
}
