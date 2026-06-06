// 兆基clipper —— 内容脚本（壳层）：
//  · 注册消息监听（剪藏/高亮/诊断）
//  · 抓取交给站点适配器注册表（utils/extractors）：对应平台用对应的活，互不串扰
//  · 高亮器 UI（划词浮动按钮 + Option 点击移除）与诊断保留在此
import { ExtractedPage, ExtractResponse } from '@/utils/types';
import {
  Highlight,
  ensureHighlightStyle,
  highlightSelection,
  loadHighlights,
  reapplyHighlight,
  saveHighlights,
  unwrapHighlight,
} from '@/utils/highlighter';
import {
  ExtractContext,
  findScroller,
  htmlToMarkdown,
  parseWithSelector,
  readInitialState,
  sleep,
} from '@/utils/extract-core';
import { dispatchExtract, resolveAdapter } from '@/utils/extractors';
import { diagnoseBili } from '@/utils/extractors/bilibili';

// 本页高亮内存副本（与 storage 同步）
let pageHighlights: Highlight[] = [];

/** 页面加载后恢复已保存的高亮 */
async function restoreHighlights() {
  pageHighlights = await loadHighlights();
  if (!pageHighlights.length) return;
  ensureHighlightStyle();
  // SPA/懒加载页面内容可能晚到，重试几次恢复
  let tries = 0;
  const tick = () => {
    for (const hl of pageHighlights) reapplyHighlight(hl);
    if (++tries < 4) setTimeout(tick, 800);
  };
  tick();
}

/** 高亮当前选区并持久化 */
async function doHighlightSelection(): Promise<number> {
  ensureHighlightStyle();
  const hl = highlightSelection();
  if (!hl) return pageHighlights.length;
  pageHighlights.push(hl);
  await saveHighlights(pageHighlights);
  return pageHighlights.length;
}

/** 划词浮动按钮：选中文字后在旁边显示「🖍 高亮」，点击即高亮（零快捷键，最直观） */
function setupSelectionButton() {
  const btn = document.createElement('button');
  btn.textContent = '🖍 高亮';
  btn.id = 'zhaoji-clipper-hl-btn';
  btn.style.cssText = [
    'position:absolute !important',
    'z-index:2147483647 !important',
    'display:none !important',
    'padding:5px 11px !important',
    'margin:0 !important',
    'font-size:13px !important',
    'font-family:-apple-system,sans-serif !important',
    'line-height:1.2 !important',
    'background:#ED7D1C !important',
    'color:#fff !important',
    'border:none !important',
    'border-radius:6px !important',
    'cursor:pointer !important',
    'box-shadow:0 2px 8px rgba(0,0,0,.25) !important',
  ].join(';');
  const hide = () => {
    btn.style.setProperty('display', 'none', 'important');
  };
  // 防止按钮 mousedown 清掉选区
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await doHighlightSelection();
    window.getSelection()?.removeAllRanges();
    hide();
  });
  (document.body || document.documentElement).appendChild(btn);

  document.addEventListener('mouseup', () => {
    setTimeout(() => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        hide();
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      if (!rect.width && !rect.height) {
        hide();
        return;
      }
      btn.style.setProperty('top', `${window.scrollY + rect.top - 40}px`, 'important');
      btn.style.setProperty('left', `${window.scrollX + rect.left}px`, 'important');
      btn.style.setProperty('display', 'block', 'important');
    }, 10);
  });
  document.addEventListener('mousedown', (e) => {
    if (e.target !== btn) hide();
  });
  document.addEventListener('scroll', hide, true);
}

/** Option/Alt + 点击高亮标记 → 移除该条（避免阅读时误删） */
function onHighlightClick(e: MouseEvent) {
  if (!e.altKey) return;
  const mark = (e.target as HTMLElement)?.closest?.(`mark.zhaoji-clipper-hl`) as HTMLElement | null;
  if (!mark) return;
  const id = mark.dataset.jhl;
  if (!id) return;
  e.preventDefault();
  e.stopPropagation();
  unwrapHighlight(id);
  pageHighlights = pageHighlights.filter((h) => h.id !== id);
  saveHighlights(pageHighlights);
}

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_idle',
  main() {
    // 防重复初始化：按需注入（chrome.scripting）时本脚本会再次执行
    if ((window as unknown as { __ZHAOJI_CLIPPER__?: boolean }).__ZHAOJI_CLIPPER__) return;
    (window as unknown as { __ZHAOJI_CLIPPER__?: boolean }).__ZHAOJI_CLIPPER__ = true;

    // 消息监听器最先、同步注册，确保即使后续初始化出错也能响应剪藏请求
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg?.type === 'ZHAOJI_CLIPPER_HIGHLIGHT') {
        doHighlightSelection().then((count) => sendResponse({ ok: true, count }));
        return true;
      }
      if (msg?.type === 'ZHAOJI_CLIPPER_GET_HIGHLIGHTS') {
        sendResponse({ ok: true, highlights: pageHighlights.map((h) => h.text) });
        return false;
      }
      if (msg?.type === 'ZHAOJI_CLIPPER_CLEAR_HIGHLIGHTS') {
        for (const h of pageHighlights) unwrapHighlight(h.id);
        pageHighlights = [];
        saveHighlights(pageHighlights).then(() => sendResponse({ ok: true }));
        return true;
      }
      if (msg?.type === 'ZHAOJI_CLIPPER_DIAGNOSE') {
        diagnoseFull()
          .then((dump) => sendResponse({ ok: true, dump }))
          .catch((e) =>
            sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) }),
          );
        return true;
      }
      if (msg?.type !== 'ZHAOJI_CLIPPER_EXTRACT') return;
      extract(!!msg.fullCapture)
        .then((data) => sendResponse({ ok: true, data } satisfies ExtractResponse))
        .catch((e) =>
          sendResponse({
            ok: false,
            error: e instanceof Error ? e.message : String(e),
          } satisfies ExtractResponse),
        );
      return true; // 异步响应
    });

    // 高亮相关初始化（放在监听器注册之后，出错也不影响剪藏）
    try {
      restoreHighlights();
      setupSelectionButton();
      document.addEventListener('click', onHighlightClick, true);
    } catch {
      /* 某些受限页面初始化失败，忽略 */
    }
  },
});

/** 读取当前选区的 HTML */
function getSelectionHtml(): string {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return '';
  const container = document.createElement('div');
  for (let i = 0; i < sel.rangeCount; i++) {
    container.appendChild(sel.getRangeAt(i).cloneContents());
  }
  return container.innerHTML;
}

// blob: 图片只在页面上下文有效，后台/弹窗无法下载。由内容脚本就地解析为 base64。
const BLOB_IMG_RE = /!\[[^\]]*\]\((blob:[^)\s]+)\)/g;

/** fetch blob: → base64（页面上下文里 blob 才有效） */
async function blobUrlToBase64(blobUrl: string): Promise<{ base64: string; mime: string } | null> {
  try {
    const r = await fetch(blobUrl);
    const blob = await r.blob();
    if (!blob.size) return null;
    const base64 = await new Promise<string>((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(((fr.result as string) || '').split(',')[1] || '');
      fr.onerror = rej;
      fr.readAsDataURL(blob);
    });
    return base64 ? { base64, mime: blob.type || 'image/png' } : null;
  } catch {
    return null;
  }
}

/** 兜底：从已渲染的 <img> 元素经 canvas 取像素 → base64（fetch blob 失败时用） */
function imgElToBase64(blobUrl: string): { base64: string; mime: string } | null {
  try {
    const img = document.querySelector<HTMLImageElement>(`img[src="${CSS.escape(blobUrl)}"]`);
    if (!img || !img.naturalWidth || !img.naturalHeight) return null;
    const canvas = document.createElement('canvas');
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const cx = canvas.getContext('2d');
    if (!cx) return null;
    cx.drawImage(img, 0, 0);
    const base64 = canvas.toDataURL('image/png').split(',')[1] || '';
    return base64 ? { base64, mime: 'image/png' } : null;
  } catch {
    return null; // 跨源污染等
  }
}

/** 把正文里的 blob: 图片就地解析为 base64，挂到 page.inlineImages 供保存管线使用 */
async function resolveInlineBlobImages(page: ExtractedPage): Promise<void> {
  const urls = new Set<string>();
  let m: RegExpExecArray | null;
  BLOB_IMG_RE.lastIndex = 0;
  while ((m = BLOB_IMG_RE.exec(page.contentMarkdown))) urls.add(m[1]);
  if (!urls.size) return;
  const out: Array<{ url: string; base64: string; mime: string }> = [];
  for (const url of Array.from(urls).slice(0, 40)) {
    const got = (await blobUrlToBase64(url)) || imgElToBase64(url);
    if (got) out.push({ url, base64: got.base64, mime: got.mime });
  }
  if (out.length) page.inlineImages = out;
}

/** 抓取入口：快照请求级上下文 → 交给站点适配器注册表 → 就地解析 blob 图 */
async function extract(fullCapture: boolean): Promise<ExtractedPage> {
  const ctx: ExtractContext = {
    url: location.href,
    hostname: location.hostname,
    fullCapture,
    highlights: pageHighlights.map((h) => h.text),
    selectionHtml: getSelectionHtml(),
  };
  const { page } = await dispatchExtract(ctx);
  await resolveInlineBlobImages(page);
  return page;
}

// ---------------- 诊断：导出页面结构供开发者分析 ----------------

function describeEl(el: Element): string {
  const cls = (el.getAttribute('class') || '')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3)
    .join('.');
  const attrs = Array.from(el.attributes)
    .filter((a) => a.name.startsWith('data-') || a.name === 'role' || a.name === 'contenteditable')
    .map((a) => a.name)
    .slice(0, 5)
    .join(',');
  return (
    el.tagName.toLowerCase() +
    (el.id ? `#${el.id}` : '') +
    (cls ? `.${cls}` : '') +
    (attrs ? ` [${attrs}]` : '')
  );
}

/** 生成滚动容器内的结构大纲，便于定位飞书等页面的正文容器 */
function diagnose(): string {
  const scroller = findScroller();
  const lines: string[] = [];
  lines.push(`URL: ${location.href}`);
  lines.push(`title: ${document.title}`);
  lines.push(
    `scroller: ${describeEl(scroller)} scrollH=${scroller.scrollHeight} clientH=${scroller.clientHeight}`,
  );
  lines.push('--- 结构大纲（缩进=层级，[宽x高] kids=子元素数 text=字符数）---');

  const walk = (el: Element, depth: number) => {
    if (depth > 7 || lines.length > 350) return;
    const rect = (el as HTMLElement).getBoundingClientRect();
    if (rect.width < 60 || rect.height < 16) return;
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    lines.push(
      `${'  '.repeat(depth)}${describeEl(el)} [${Math.round(rect.width)}x${Math.round(
        rect.height,
      )}] kids=${el.childElementCount} text=${text.length} "${text.slice(0, 28)}"`,
    );
    if (el.childElementCount <= 50) {
      for (const c of Array.from(el.children)) walk(c, depth + 1);
    }
  };
  walk(scroller, 0);
  return lines.join('\n');
}

/**
 * 小红书 DOM 结构诊断：笔记是开在浮层 modal 里（盖在信息流上），Defuddle/findScroller 会抓错区域。
 * 直接探笔记容器：标题/正文/作者/标签/图片元素及其真实 src，供写 xiaohongshu 适配器（不盲猜）。
 */
function diagnoseXhs(): string {
  if (!/xiaohongshu\.com|xhslink\.com/.test(location.hostname)) return '';
  const out: string[] = ['--- 小红书 DOM 结构诊断 ---'];
  out.push(`__INITIAL_STATE__: ${readInitialState('window.__INITIAL_STATE__') ? 'found' : 'none'}`);
  const txt = (sel: string): string =>
    (document.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
  const box = (sel: string): string => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return '-';
    const r = el.getBoundingClientRect();
    return `found [${Math.round(r.width)}x${Math.round(r.height)}] imgs=${el.querySelectorAll('img').length}`;
  };
  // 笔记容器候选
  for (const sel of [
    '#noteContainer',
    '.note-container',
    '.note-detail-mask',
    '.note-content',
    '.note-scroller',
    '.media-container',
    '.swiper-wrapper',
    '.slider-container',
  ]) {
    out.push(`${sel}: ${box(sel)}`);
  }
  // 标题/正文/作者
  out.push(`#detail-title: ${txt('#detail-title')}`);
  out.push(`#detail-desc .note-text: ${txt('#detail-desc .note-text').slice(0, 120)}`);
  for (const sel of [
    '.author-wrapper .username',
    '.author-container .username',
    '.note-content .author .name',
    '.author-wrapper .name',
    'a.name',
    '.username',
  ]) {
    const t = txt(sel);
    if (t) out.push(`author ${sel}: ${t}`);
  }
  // 标签
  const tags = Array.from(document.querySelectorAll('a#hash-tag, #detail-desc .tag'))
    .map((t) => (t.textContent || '').trim())
    .filter(Boolean);
  out.push(`tags(${tags.length}): ${tags.join(' ')}`);
  // 日期/互动
  out.push(`date .bottom-container/.date: ${txt('.bottom-container') || txt('.date')}`);
  out.push(`engage .engage-bar: ${txt('.engage-bar').slice(0, 80)}`);
  // 图片：在笔记容器内找 img，dump 真实 src（看是 http/blob/还是带 token）
  const root =
    (document.querySelector('#noteContainer') as HTMLElement | null) ||
    (document.querySelector('.note-container') as HTMLElement | null) ||
    (document.querySelector('.note-detail-mask') as HTMLElement | null);
  out.push(`imgRoot: ${root ? root.className || root.id : '(none, 用 document)'} `);
  const imgs = Array.from((root || document).querySelectorAll('img'));
  out.push(`imgs in root (${imgs.length})，前 12 个：`);
  imgs.slice(0, 12).forEach((im, i) => {
    const w = (im as HTMLImageElement).naturalWidth;
    const h = (im as HTMLImageElement).naturalHeight;
    const src = im.getAttribute('src') || '';
    out.push(`  img[${i}] ${w}x${h}: ${src.slice(0, 100)}`);
  });

  // 互动区探测：找点赞/收藏/评论/转发数的真实选择器（不盲猜）
  out.push('-- 互动区探测 --');
  const scope2: ParentNode = root || document;
  for (const sel of [
    '.engage-bar',
    '.interact-container',
    '.interaction-container',
    '.left .count',
    '.like-wrapper',
    '.collect-wrapper',
    '.chat-wrapper',
    '.share-wrapper',
    '.like-lottie',
    '[class*="like"]',
    '[class*="collect"]',
  ]) {
    const els = scope2.querySelectorAll(sel);
    if (els.length) {
      const txt = Array.from(els)
        .map((e) => (e.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean)
        .join(' | ')
        .slice(0, 120);
      out.push(`${sel} (${els.length}): ${txt}`);
    }
  }
  // engage-bar 子树（class + 文本）便于定位计数元素
  const eb = scope2.querySelector('.engage-bar') || scope2.querySelector('.interact-container');
  if (eb) {
    const kids = Array.from(eb.querySelectorAll('*'))
      .slice(0, 40)
      .map((e) => {
        const cls = typeof e.className === 'string' ? e.className.split(' ')[0] : '';
        const t = (e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 12);
        return cls ? `.${cls}{${t}}` : '';
      })
      .filter(Boolean);
    out.push(`engage 子树: ${kids.join(' ')}`);
  }
  // 视频探测：判断是 blob(MSE,抓不了) 还是真 URL；并查 meta 里有没有零风险可用的视频地址
  const v = scope2.querySelector('video') as HTMLVideoElement | null;
  out.push(
    `video: ${
      v
        ? `src=${(v.getAttribute('src') || '').slice(0, 90)} | poster=${(v.getAttribute('poster') || '').slice(0, 90)}`
        : 'none'
    }`,
  );
  const itemprop = (p: string): string =>
    document.querySelector(`meta[itemprop="${p}"]`)?.getAttribute('content') || '';
  out.push(`og:video: ${metaContent('og:video')}`);
  out.push(`og:video:url: ${metaContent('og:video:url')}`);
  out.push(`og:video:secure_url: ${metaContent('og:video:secure_url')}`);
  out.push(`meta itemprop contentUrl: ${itemprop('contentUrl')}`);
  out.push(`og:image(封面候选): ${metaContent('og:image')}`);
  return out.join('\n');
}

/**
 * X/Twitter DOM 探测：tweet 结构靠 data-testid，dump 正文/作者/时间/图片/视频/互动，供写 x 适配器。
 */
function diagnoseX(): string {
  if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(location.hostname)) return '';
  const out: string[] = ['--- X/Twitter DOM 探测 ---'];
  const tweets = document.querySelectorAll('article[data-testid="tweet"]');
  out.push(`article[data-testid=tweet] 数量: ${tweets.length}`);
  const first = tweets[0];
  if (first) {
    const txt = (sel: string): string =>
      (first.querySelector(sel)?.textContent || '').replace(/\s+/g, ' ').trim();
    out.push(`tweetText: ${txt('[data-testid="tweetText"]').slice(0, 140)}`);
    out.push(`User-Name: ${txt('[data-testid="User-Name"]').slice(0, 80)}`);
    out.push(`time datetime: ${first.querySelector('time')?.getAttribute('datetime') || ''}`);
    const photos = first.querySelectorAll(
      '[data-testid="tweetPhoto"] img, img[src*="pbs.twimg.com/media"]',
    );
    out.push(`photos: ${photos.length}`);
    Array.from(photos)
      .slice(0, 4)
      .forEach((im, i) => out.push(`  photo[${i}]: ${(im.getAttribute('src') || '').slice(0, 95)}`));
    const video = first.querySelector('video');
    out.push(`video: ${video ? (video.getAttribute('src') || '').slice(0, 70) : 'none'}`);
    out.push(
      `videoPlayer testid: ${first.querySelector('[data-testid="videoPlayer"]') ? 'yes' : 'no'} | videoComponent: ${first.querySelector('[data-testid="videoComponent"]') ? 'yes' : 'no'}`,
    );
    // 外链卡片（推文链向外部视频/文章时）—— 详尽 dump 卡片结构，供写采集逻辑
    const card = first.querySelector('[data-testid="card.wrapper"]');
    out.push(`card.wrapper: ${card ? 'yes' : 'no'}`);
    if (card) {
      // 卡片里所有锚点的 href（destination 可能是 t.co 或已展开域名）
      const cardLinks = Array.from(card.querySelectorAll('a'))
        .map((a) => a.getAttribute('href') || '')
        .filter(Boolean);
      out.push(`  card links: ${Array.from(new Set(cardLinks)).slice(0, 4).join(' | ')}`);
      // 卡片内部的 data-testid（标题/描述/媒体各有不同 testid，定位用）
      const tids = Array.from(card.querySelectorAll('[data-testid]'))
        .map((e) => e.getAttribute('data-testid') || '')
        .filter(Boolean);
      out.push(`  card testids: ${Array.from(new Set(tids)).slice(0, 10).join(', ')}`);
      // 卡片缩略图
      const cimg = card.querySelector('img');
      out.push(`  card img: ${(cimg?.getAttribute('src') || '-').slice(0, 90)}`);
      // 卡片各文本块（域名/标题/描述通常是分开的 span/div）
      const texts = Array.from(card.querySelectorAll('span, div'))
        .map((e) => (e.childElementCount === 0 ? (e.textContent || '').trim() : ''))
        .filter((t) => t.length > 0);
      out.push(`  card texts: ${Array.from(new Set(texts)).slice(0, 8).join(' ⟂ ').slice(0, 200)}`);
    }
    // 推文正文里的外链锚点（含展开后的 vanity 显示域名）
    const links = Array.from(first.querySelectorAll('a[href*="t.co/"]'))
      .map((a) => `${a.getAttribute('href')}(${(a.textContent || '').trim().slice(0, 30)})`)
      .filter(Boolean);
    out.push(`t.co links: ${Array.from(new Set(links)).slice(0, 5).join(' ')}`);
    for (const tt of ['reply', 'retweet', 'like', 'bookmark']) {
      const el = first.querySelector(`[data-testid="${tt}"]`);
      out.push(
        `${tt}: aria=${el?.getAttribute('aria-label') || '-'} text=${(el?.textContent || '').trim()}`,
      );
    }
  }
  return out.join('\n');
}

/**
 * 公众号图片探测：数 #js_content 里的 img 及其 data-src/src 形态，对比正文 markdown 抓到的图片数，
 * 判断「没抓全」是懒加载/Defuddle 丢图（A）还是下载 403（B）。
 */
function diagnoseWeixin(): string {
  if (!/mp\.weixin\.qq\.com/.test(location.hostname)) return '';
  const out: string[] = ['--- 公众号图片探测 ---'];
  const content = document.querySelector('#js_content') || document.body;
  const imgs = Array.from(content.querySelectorAll('img'));
  let withDataSrc = 0;
  let withRealSrc = 0;
  let emptySrc = 0;
  for (const im of imgs) {
    const ds = im.getAttribute('data-src') || '';
    const s = im.getAttribute('src') || '';
    if (ds) withDataSrc++;
    if (s && !s.startsWith('data:')) withRealSrc++;
    if (!s || s.startsWith('data:')) emptySrc++;
  }
  out.push(`#js_content <img> 总数: ${imgs.length}`);
  out.push(`有 data-src: ${withDataSrc} | 有真实 src: ${withRealSrc} | 空/占位 src: ${emptySrc}`);
  imgs.slice(0, 6).forEach((im, i) => {
    out.push(
      `  img[${i}] src=${(im.getAttribute('src') || '').slice(0, 45)} data-src=${(im.getAttribute('data-src') || '').slice(0, 45)}`,
    );
  });
  return out.join('\n');
}

/**
 * Reddit DOM 探测：新版用 Web Components(<shreddit-post>)，标题/作者/分数等在元素属性上。
 * dump 这些属性 + 正文容器候选 + 图片形态，据真实结构写适配器。
 */
function diagnoseReddit(): string {
  if (!/(^|\.)reddit\.com$/.test(location.hostname)) return '';
  const out: string[] = ['--- Reddit DOM 探测 ---'];
  out.push(`path: ${location.pathname}`);
  const sp = document.querySelector('shreddit-post');
  out.push(`shreddit-post: ${sp ? 'yes' : 'no'}`);
  if (sp) {
    for (const a of [
      'post-title',
      'author',
      'subreddit-prefixed-name',
      'score',
      'comment-count',
      'created-timestamp',
      'content-href',
      'post-type',
      'domain',
    ]) {
      out.push(`  @${a}: ${(sp.getAttribute(a) || '(无)').slice(0, 80)}`);
    }
    const probe = (label: string, sel: string) => {
      const el = sp.querySelector(sel);
      const len = el ? (el.textContent || '').replace(/\s+/g, ' ').trim().length : 0;
      out.push(`  body ${label} [${sel}]: ${el ? `len=${len}` : '(无)'}`);
    };
    probe('text-body', '[slot="text-body"]');
    probe('.md', '.md');
    probe('articleBody', '[property="schema:articleBody"]');
    out.push(`  imgs in post: ${sp.querySelectorAll('img').length}`);
    // 内容图候选（reddit 图床），排除社区图标/头像
    const contentImgs = Array.from(sp.querySelectorAll('img'))
      .map((e) => e.getAttribute('src') || '')
      .filter((s) => /(i|preview|external-preview)\.redd\.it\//.test(s));
    out.push(`  content imgs(redd.it): ${contentImgs.length}`);
    contentImgs.slice(0, 4).forEach((s, i) => out.push(`    [${i}] ${s.slice(0, 80)}`));
    const vid = sp.querySelector('shreddit-player, video, [slot="post-media-container"]');
    out.push(`  media(video/player): ${vid ? vid.tagName.toLowerCase() : '(无)'}`);
  }
  out.push(`old reddit .usertext-body .md: ${document.querySelector('.usertext-body .md') ? 'yes' : 'no'}`);
  out.push(`shreddit-comment count: ${document.querySelectorAll('shreddit-comment').length}`);
  return out.join('\n');
}

/**
 * 知乎 DOM 探测：知乎页面类型多(专栏/回答/问题/想法)，结构各异。
 * 把各类型的标题/正文容器/作者候选选择器全 dump(含文本长度)，据真实结构写适配器。
 */
function diagnoseZhihu(): string {
  if (!/(^|\.)zhihu\.com$/.test(location.hostname)) return '';
  const out: string[] = ['--- 知乎 DOM 探测 ---'];
  const path = location.pathname;
  let kind = 'other';
  if (/(^|\.)zhuanlan\.zhihu\.com$/.test(location.hostname) || /^\/p\//.test(path))
    kind = 'article(专栏)';
  else if (/\/answer\/\d+/.test(path)) kind = 'answer(回答)';
  else if (/^\/question\/\d+/.test(path)) kind = 'question(问题)';
  else if (/^\/pin\/\d+/.test(path)) kind = 'pin(想法)';
  out.push(`page kind: ${kind} | path: ${path}`);
  const ansId = (path.match(/\/answer\/(\d+)/) || [])[1] || '';
  out.push(`answerId(URL): ${ansId || '-'}`);
  const probe = (label: string, sel: string) => {
    const el = document.querySelector(sel);
    const len = el ? (el.textContent || '').replace(/\s+/g, ' ').trim().length : 0;
    const snip = el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 36) : '';
    out.push(`  ${label} [${sel}]: ${el ? `found len=${len} "${snip}"` : '(无)'}`);
  };
  // 标题候选
  probe('title.Post', 'h1.Post-Title');
  probe('title.Question', '.QuestionHeader-title');
  probe('title.h1', 'h1');
  // 正文容器候选
  probe('rich.Post', '.Post-RichText');
  probe('rich.Answer', '.QuestionAnswer-content .RichContent-inner');
  probe('rich.ztext', '.RichText.ztext');
  // 作者候选
  probe('author', '.AuthorInfo-name');
  // 多回答页：.RichText.ztext / AnswerItem 数量(判断是否需按 answerId 锁定)
  out.push(
    `  counts: RichText.ztext=${document.querySelectorAll('.RichText.ztext').length} ` +
      `AnswerItem=${document.querySelectorAll('.List-item .AnswerItem, .AnswerCard').length} ` +
      `img(content)=${document.querySelectorAll('.RichText.ztext img').length}`,
  );
  // 图片真实地址形态(知乎懒加载常把真图放 data-actualsrc/data-original)
  const im = document.querySelector('.RichText.ztext img');
  if (im) {
    out.push(
      `  img sample: src=${(im.getAttribute('src') || '').slice(0, 40)} ` +
        `data-actualsrc=${(im.getAttribute('data-actualsrc') || '').slice(0, 40)} ` +
        `data-original=${(im.getAttribute('data-original') || '').slice(0, 40)}`,
    );
  }
  return out.join('\n');
}

/**
 * X thread 探测：自动滚一遍会话，收集每条推文的 id/作者/片段，按 id 升序 dump。
 * 用来确认「同作者连续成串=thread、被异作者打断=回复区」的判定，及 id/handle 提取选择器。
 */
async function diagnoseXThread(): Promise<string> {
  if (!/(^|\.)x\.com$|(^|\.)twitter\.com$/.test(location.hostname)) return '';
  if (!/\/status\/\d+/.test(location.href)) return '';
  const focusedId = (location.pathname.match(/status\/(\d+)/) || [])[1] || '';
  const handleOf = (tw: Element): string =>
    ((tw.querySelector('[data-testid="User-Name"]')?.textContent || '').match(/@\w+/) || [])[0] || '';
  const idOf = (tw: Element): string => {
    const a = tw.querySelector('time')?.closest('a');
    return (a?.getAttribute('href')?.match(/status\/(\d+)/) || [])[1] || '';
  };
  const seen = new Map<string, { handle: string; text: string; order: number }>();
  let app = 0; // 出现顺序计数器（DOM 视觉序，自顶向下滚动时首次出现的次序）
  const collect = () => {
    for (const tw of Array.from(document.querySelectorAll('article[data-testid="tweet"]'))) {
      const id = idOf(tw);
      if (!id || seen.has(id)) continue;
      const text = (tw.querySelector('[data-testid="tweetText"]')?.textContent || '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 40);
      seen.set(id, { handle: handleOf(tw), text, order: app++ });
    }
  };
  const MAX_TWEETS = 60; // 硬上限：绝不无限抓
  const origY = window.scrollY;
  collect(); // 先就地收集（焦点推文可见），拿到作者
  const fh = seen.get(focusedId)?.handle || handleOf(document.querySelector('article[data-testid="tweet"]')!) || '';
  const countSame = () =>
    [...seen.values()].filter((v) => v.handle === fh).length;
  // 先上滚加载祖先推文（同作者，往上不会越界到评论）
  for (let i = 0; i < 14; i++) {
    collect();
    if (window.scrollY === 0 || seen.size >= MAX_TWEETS) break;
    window.scrollTo(0, Math.max(0, window.scrollY - 700));
    await sleep(220);
  }
  // 再下滚收集，但「离开 thread 即停」：连续 2 步没新增同作者推文 → 已进评论区，停。
  let lastY = -1;
  let dry = 0;
  let prevSame = countSame();
  for (let guard = 0; guard < 24; guard++) {
    window.scrollTo(0, window.scrollY + 700);
    await sleep(220);
    collect();
    const now = countSame();
    if (now > prevSame) {
      dry = 0;
      prevSame = now;
    } else {
      dry++;
    }
    if (window.scrollY === lastY) break; // 到底，无法再滚
    lastY = window.scrollY;
    if (seen.size >= MAX_TWEETS) break; // 硬上限
    if (dry >= 2 && prevSame >= 1) break; // 离开 thread：连续 2 步没新增同作者
  }
  window.scrollTo(0, origY);
  // 按出现顺序（视觉序）排，对照按 id（时间序）排，看自串边界用哪个对
  const byApp = [...seen.entries()].sort((a, b) => a[1].order - b[1].order);
  const byId = [...seen.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // 视觉序里「从顶起连续同作者」的段长 = 自串边界候选
  let leadRun = 0;
  for (const [, info] of byApp) {
    if (info.handle === fh) leadRun++;
    else break;
  }
  const out = [
    '--- X thread 探测 ---',
    `focusedId:${focusedId} focusedHandle:${fh} collected:${seen.size} 视觉序连续同作者段长:${leadRun}`,
    '[按出现顺序/视觉序]',
  ];
  for (const [id, info] of byApp) {
    out.push(
      `${id === focusedId ? '>>' : '  '} ${info.handle === fh ? '[同]' : '[异]'} #${info.order} ...${id.slice(-7)} @${info.handle.slice(1)} | ${info.text}`,
    );
  }
  out.push('[按 id/时间序]');
  for (const [id, info] of byId) {
    out.push(
      `${id === focusedId ? '>>' : '  '} ${info.handle === fh ? '[同]' : '[异]'} #${info.order} ...${id.slice(-7)} @${info.handle.slice(1)}`,
    );
  }
  return out.join('\n');
}

/**
 * YouTube 互动数据探测：观看数/点赞数/发布日期的 DOM 经常 A/B 改版且中英文文案不同，
 * 这里把多个候选选择器的 aria-label 与文本全 dump 出来，据真实结构再写采集逻辑（不盲猜）。
 */
function diagnoseYoutube(): string {
  if (!/(^|\.)youtube\.com$/.test(location.hostname)) return '';
  if (location.pathname.indexOf('/watch') !== 0 && !location.search.includes('v=')) return '';
  const out: string[] = ['--- YouTube 互动数据探测 ---'];
  const ariaOf = (sel: string): string => {
    const el = document.querySelector(sel);
    if (!el) return '(无此元素)';
    const a = el.getAttribute('aria-label');
    if (a) return `aria="${a}"`;
    const inner = el.querySelector('[aria-label]');
    return inner ? `innerAria="${inner.getAttribute('aria-label')}"` : `text="${(el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60)}"`;
  };
  const textOf = (sel: string): string => {
    const el = document.querySelector(sel);
    return el ? (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 90) : '(无此元素)';
  };
  // 点赞按钮候选
  out.push('[点赞按钮候选]');
  for (const sel of [
    'like-button-view-model button',
    'segmented-like-dislike-button-view-model button',
    '#segmented-like-button button',
    'ytd-menu-renderer #top-level-buttons-computed button',
    'button[aria-label*="like" i]',
  ]) {
    out.push(`  ${sel} -> ${ariaOf(sel)}`);
  }
  // 观看数 + 发布日期候选
  out.push('[观看数/日期候选]');
  for (const sel of [
    'ytd-watch-info-text #info',
    'ytd-watch-info-text',
    '#info-container',
    'yt-formatted-string#info',
    'ytd-video-view-count-renderer',
  ]) {
    out.push(`  ${sel} -> ${textOf(sel)}`);
  }
  // 频道名/标题，辅助核对没串台
  out.push(`title: ${textOf('ytd-watch-metadata #title, #title h1')}`);
  out.push(`channel: ${textOf('#owner #channel-name a, ytd-channel-name a')}`);
  out.push(`subs: ${textOf('#owner #owner-sub-count, #subscriber-count')}`);
  // 评论数（懒加载，未滚到评论区可能为空）
  out.push(`comments: ${textOf('ytd-comments-header-renderer #count, #comments #count')}`);
  return out.join('\n');
}

/**
 * 完整诊断：实际跑一遍提取，导出「命中适配器 + 抓到了什么 + Defuddle 选中的容器 + 页面结构」，
 * 一键复制发给开发者即可数据驱动地修复抓取精度。
 */
async function diagnoseFull(): Promise<string> {
  const lines: string[] = [];
  lines.push('=== 兆基clipper抓取诊断 ===');
  lines.push(`URL: ${location.href}`);
  const ctx: ExtractContext = {
    url: location.href,
    hostname: location.hostname,
    fullCapture: false,
    highlights: [],
    selectionHtml: '',
  };
  lines.push(`matchedAdapter: ${resolveAdapter(ctx)}`);
  try {
    const parsed = await parseWithSelector(location.href);
    const md = htmlToMarkdown(parsed.content || '');
    lines.push(`extractorType: ${parsed.extractorType || '(通用算法)'}`);
    lines.push(`contentSelector: ${parsed.debug?.contentSelector || '(无)'}`);
    lines.push(`title: ${parsed.title} | author: ${parsed.author} | words: ${parsed.wordCount}`);
    lines.push(`正文Markdown长度: ${md.length}`);
    lines.push(`正文Markdown图片数(![]): ${(md.match(/!\[/g) || []).length}`);
    lines.push('--- 正文Markdown 前 800 字 ---');
    lines.push(md.slice(0, 800));
    lines.push('--- 正文Markdown 末 200 字 ---');
    lines.push(md.slice(-200));
  } catch (e) {
    lines.push(`提取失败: ${e instanceof Error ? e.message : String(e)}`);
  }
  const biliTrace = await diagnoseBili();
  if (biliTrace) {
    lines.push('');
    lines.push(biliTrace);
  }
  const xhsTrace = diagnoseXhs();
  if (xhsTrace) {
    lines.push('');
    lines.push(xhsTrace);
  }
  const wxTrace = diagnoseWeixin();
  if (wxTrace) {
    lines.push('');
    lines.push(wxTrace);
  }
  const zhihuTrace = diagnoseZhihu();
  if (zhihuTrace) {
    lines.push('');
    lines.push(zhihuTrace);
  }
  const redditTrace = diagnoseReddit();
  if (redditTrace) {
    lines.push('');
    lines.push(redditTrace);
  }
  const xTrace = diagnoseX();
  if (xTrace) {
    lines.push('');
    lines.push(xTrace);
    const xThread = await diagnoseXThread();
    if (xThread) lines.push('', xThread);
  }
  const ytTrace = diagnoseYoutube();
  if (ytTrace) {
    lines.push('');
    lines.push(ytTrace);
  }
  lines.push('');
  lines.push(diagnose());
  return lines.join('\n');
}
