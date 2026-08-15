// Nomo Clipper —— 抓取核心：站点适配器共享的工具与类型
//  · Turndown 服务 + 规则、HTML→Markdown
//  · Defuddle 封装、Markdown 清洗、完整抓取（滚动累积）
//  · __INITIAL_STATE__ 解析（B站/小红书等共用）
// 注：本模块会被打进 content.js，受 ASCII 约束 —— 正则字面量里禁止出现中文/零宽字符。
import Defuddle from 'defuddle/full';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';
import { ExtractedPage } from '@/utils/types';

/** 一次抓取的请求级上下文（依赖内容脚本状态的值由 content.ts 快照传入） */
export interface ExtractContext {
  url: string;
  hostname: string;
  fullCapture: boolean;
  highlights: string[];
  selectionHtml: string;
}

/** 站点适配器：match 命中即由 extract 干活；extract 返回 null 表示放行给下一个适配器 */
export interface SiteExtractor {
  name: string;
  match(ctx: ExtractContext): boolean;
  extract(ctx: ExtractContext): Promise<ExtractedPage | null>;
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
  hr: '---',
});
turndown.use(gfm);
turndown.remove((node) =>
  ['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG'].includes(node.nodeName),
);

// 网页内联高亮（飞书 mark/背景色文字等会先规整为 mark）→ Obsidian 高亮语法
turndown.addRule('nomoClipperMark', {
  filter: (node) => node.nodeName === 'MARK',
  replacement: (content) => {
    const text = content.trim();
    return text ? `==${text}==` : '';
  },
});

// 飞书 callout 规整后的专用标记，直接输出 Obsidian callout，避免 [!note] 被转义。
turndown.addRule('nomoClipperCallout', {
  filter: (node) =>
    node.nodeName === 'BLOCKQUOTE' &&
    (node as HTMLElement).getAttribute('data-obsidian-callout') === 'note',
  replacement: (content) => {
    const lines = content
      .split('\n')
      .map((line) =>
        line.replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '').trim(),
      )
      .filter((line) => !!line && !/^>(?:\s*>)*\s*$/.test(line));
    // Feishu callouts render their leading emoji as a separate block. Keep it
    // beside the first text line so Obsidian matches the original layout.
    if (lines.length > 1 && /^\p{Extended_Pictographic}\uFE0F?$/u.test(lines[0])) {
      lines.splice(0, 2, `${lines[0]} ${lines[1]}`);
    }
    const body = lines.map((line) => `> ${line}`).join('\n');
    return `\n\n> [!note]${body ? `\n${body}` : ''}\n\n`;
  },
});

// 站内锚点链接（#xxx，如飞书目录/标题）→ 纯文本；空链接 → 丢弃
turndown.addRule('nomoClipperAnchors', {
  filter: (node) => node.nodeName === 'A',
  replacement: (content, node) => {
    const href = (node as HTMLElement).getAttribute('href') || '';
    const text = content.trim();
    if (!text) return '';
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return text;
    return `[${text}](${href})`;
  },
});

/** 相对地址转绝对地址 */
function absUrl(u: string): string {
  try {
    return new URL(u, document.baseURI).href;
  } catch {
    return u;
  }
}

/** 从 srcset 里挑分辨率最高的地址 */
function pickFromSrcset(srcset: string | null): string {
  if (!srcset) return '';
  let best = '';
  let bestW = -1;
  for (const part of srcset.split(',')) {
    const [u, w] = part.trim().split(/\s+/);
    if (!u) continue;
    const width = w ? parseInt(w, 10) || 0 : 0;
    if (width >= bestW) {
      best = u;
      bestW = width;
    }
  }
  return best;
}

// 图片：优先取真实地址(data-src/srcset)→绝对化；丢弃表情贴纸/占位/加载/小图标
turndown.addRule('nomoClipperImages', {
  filter: (node) => node.nodeName === 'IMG',
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const src =
      el.getAttribute('data-src') ||
      el.getAttribute('data-original') ||
      pickFromSrcset(el.getAttribute('srcset')) ||
      el.getAttribute('src') ||
      '';
    const alt = el.getAttribute('alt') || '';
    const w = parseInt(el.getAttribute('width') || '0', 10);
    const h = parseInt(el.getAttribute('height') || '0', 10);
    if (!src || src.startsWith('data:')) return '';
    if (/sticker|emoji|placeholder|loading|spinner|blank|default-face|skeleton/i.test(src)) {
      return '';
    }
    if ((w && w <= 48) || (h && h <= 48)) return '';
    return `![${alt}](${absUrl(src)})`;
  },
});

/** 把嵌入视频地址规整成可点击的观看链接（YouTube / B站 等） */
function normalizeVideoUrl(raw: string): string {
  let s = raw.startsWith('//') ? `https:${raw}` : raw;
  try {
    const url = new URL(s, document.baseURI);
    const host = url.hostname.replace(/^www\./, '');
    if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
      const m = url.pathname.match(/\/embed\/([^/?]+)/);
      if (m) return `https://www.youtube.com/watch?v=${m[1]}`;
    }
    if (host === 'youtu.be') return `https://www.youtube.com/watch?v=${url.pathname.slice(1)}`;
    if (host.endsWith('bilibili.com')) {
      const bvid = url.searchParams.get('bvid');
      if (bvid) return `https://www.bilibili.com/video/${bvid}`;
      const aid = url.searchParams.get('aid');
      if (aid) return `https://www.bilibili.com/video/av${aid}`;
    }
    return url.href;
  } catch {
    return s;
  }
}

/** YouTube 链接 → Obsidian 可播放嵌入语法 ![](watch链接)；否则返回 null */
function obsidianVideoEmbed(url: string): string | null {
  if (/^https:\/\/www\.youtube\.com\/watch\?v=[\w-]+/.test(url)) {
    return `\n\n![](${url})\n\n`;
  }
  return null;
}

// iframe 嵌入（视频/网页）→ YouTube 转可播放嵌入，其余转可点击链接
turndown.addRule('nomoClipperIframe', {
  filter: (node) => node.nodeName === 'IFRAME',
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    const src = el.getAttribute('src') || el.getAttribute('data-src') || '';
    if (!src || src.startsWith('data:') || src === 'about:blank') return '';
    const url = normalizeVideoUrl(src);
    const embed = obsidianVideoEmbed(url);
    if (embed) return embed;
    const title = (el.getAttribute('title') || '').trim() || '嵌入内容';
    return `\n\n[▶ ${title}](${url})\n\n`;
  },
});

// video 标签 → 视频链接
turndown.addRule('nomoClipperVideo', {
  filter: (node) => node.nodeName === 'VIDEO',
  replacement: (_content, node) => {
    const el = node as HTMLElement;
    let src = el.getAttribute('src') || '';
    if (!src) src = el.querySelector('source')?.getAttribute('src') || '';
    if (!src || src.startsWith('data:')) return '';
    return `\n\n[▶ 视频](${absUrl(normalizeVideoUrl(src))})\n\n`;
  },
});

// 飞书表格先在站点适配器里规整为干净 HTML。这里保留 HTML 表格，
// 避免 GFM Markdown 表格丢失宽度信息，导致 Obsidian 里被挤成窄列。
turndown.addRule('nomoClipperWideTable', {
  filter: (node) =>
    node.nodeName === 'TABLE' &&
    (node as HTMLElement).getAttribute('data-nomo-wide-table') === 'true',
  replacement: (_content, node) => {
    const table = node as HTMLElement;
    table.removeAttribute('data-nomo-wide-table');
    return `\n\n${table.outerHTML}\n\n`;
  },
});

export function htmlToMarkdown(html: string): string {
  if (!html?.trim()) return '';
  return turndown
    .turndown(html)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 运行 Defuddle 并取回正文容器选择器（静音其 debug 日志，避免污染页面控制台）。
 * 使用 parseAsync 以触发站点专用异步 extractor（如 YouTube 字幕抓取）。
 * contentSelector：强制指定正文容器（用于飞书等 Defuddle 自动定位不准的站点）。
 */
export async function parseWithSelector(url: string, contentSelector?: string) {
  const c = console as unknown as Record<string, (...a: unknown[]) => void>;
  const saved = { log: c.log, warn: c.warn, info: c.info, debug: c.debug };
  c.log = c.warn = c.info = c.debug = () => {};
  try {
    return await new Defuddle(document, { url, debug: true, contentSelector }).parseAsync();
  } finally {
    Object.assign(c, saved);
  }
}

/** 去除零宽/隐形字符（飞书等会注入，污染标题与正文）。用 \u 转义避免破坏 ASCII 打包 */
export function stripZeroWidth(s: string): string {
  return s.replace(/[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '');
}

/** 通用正文清洗：去零宽字符 + 折叠多余空行 + 去首尾空白 */
export function cleanMarkdown(md: string): string {
  return stripZeroWidth(md).replace(/\n{3,}/g, '\n\n').trim();
}

/** 取 og/meta 内容 */
export function metaContent(prop: string): string {
  const el =
    document.querySelector(`meta[property="${prop}"]`) ||
    document.querySelector(`meta[name="${prop}"]`);
  return el?.getAttribute('content') || '';
}

/**
 * 清洗页面自带标签：去首尾空白、剥前导 #、空白转连字符（Obsidian 标签不允许空格）、
 * 去重、限长限量。纯提取，不做任何语义处理。
 * 注：， = 中文逗号，用转义避免破坏 content.js 的 ASCII 打包。
 */
export function cleanTags(raw: string[]): string[] {
  const out: string[] = [];
  for (const r of raw) {
    const t = (r || '').trim().replace(/^#+/, '').trim().replace(/\s+/g, '-');
    if (!t || t.length > 40) continue;
    if (!out.includes(t)) out.push(t);
    if (out.length >= 5) break; // 页面标签最多取 5 个（取页面靠前的，通常最相关）
  }
  return out;
}

/** 读页面声明的标签：meta keywords（逗号分隔）+ article:tag（可多个）。通用适配器用 */
export function pageMetaTags(): string[] {
  const out: string[] = [];
  const kw = metaContent('keywords');
  if (kw) out.push(...kw.replace(/\uFF0C/g, ',').split(','));
  for (const el of Array.from(document.querySelectorAll('meta[property="article:tag"]'))) {
    const c = el.getAttribute('content') || '';
    if (c) out.push(c);
  }
  return out;
}

/**
 * 从文本里解析首个「年/点分」日期 → ISO：2026年6月5日 / 2025.5.23 → 2026-06-05。
 * \D 为 ASCII 安全字符类，分隔符(年/月/点)不进正则字面量，符合 content.js 的 ASCII 约束。
 * 公众号、YouTube 等共用。
 */
export function parseCjkDate(s: string): string {
  const m = (s || '').match(/(\d{4})\D{1,2}(\d{1,2})\D{1,2}(\d{1,2})/);
  if (!m) return '';
  const pad = (n: string) => n.padStart(2, '0');
  return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
}

/**
 * 把显示用计数文本解析为数字：「7644」→7644、「1.2万」→12000、「3.5亿」→350000000、「1.2K」→1200。
 * 非数字开头（如占位标签「赞」）返回 undefined。注：万/亿 用字符串 indexOf 判断，不进正则（ASCII 约束）。
 */
export function parseCount(text: string): number | undefined {
  const s = (text || '').trim();
  if (!/^\d/.test(s)) return undefined;
  const n = parseFloat(s);
  if (isNaN(n)) return undefined;
  if (s.indexOf('万') >= 0) return Math.round(n * 10000);
  if (s.indexOf('亿') >= 0) return Math.round(n * 100000000);
  if (/[kK]$/.test(s)) return Math.round(n * 1000);
  if (/[mM]$/.test(s)) return Math.round(n * 1000000);
  return Math.round(n);
}

/** 从字符串里 startKey 之后，提取首个配平的 JSON 对象 */
export function extractJsonObject(s: string, startKey: string): any | null {
  const idx = s.indexOf(startKey);
  if (idx < 0) return null;
  const start = s.indexOf('{', idx);
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let j = start; j < s.length; j++) {
    const ch = s[j];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(s.slice(start, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * 从页面 script 标签里读取 window.__INITIAL_STATE__ 等内联状态对象
 * （内容脚本读 DOM 文本，绕过隔离世界）。B站、小红书等 SPA 共用。
 */
export function readInitialState(key = 'window.__INITIAL_STATE__'): any | null {
  for (const sc of Array.from(document.querySelectorAll('script'))) {
    const t = sc.textContent || '';
    if (t.includes(key)) {
      return extractJsonObject(t, key);
    }
  }
  return null;
}

/** 找到页面里真正可滚动、内容最长的容器（飞书等用内部滚动容器而非 window） */
export function findScroller(): HTMLElement {
  let best: HTMLElement =
    (document.scrollingElement as HTMLElement) || document.documentElement;
  let bestScore = best.scrollHeight - best.clientHeight;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    if (
      el.closest(
        [
          'pre',
          'code',
          '.docx-code-block',
          '.code-block',
          '.ace_editor',
          '.cm-editor',
          '.monaco-editor',
          '[data-block-type="code"]',
          '[data-block-type="code_block"]',
          '[data-block-type="codeblock"]',
        ].join(', '),
      )
    ) {
      continue;
    }
    if (el.clientHeight < 200) continue;
    const oy = getComputedStyle(el).overflowY;
    if (oy !== 'auto' && oy !== 'scroll' && oy !== 'overlay') continue;
    const score = el.scrollHeight - el.clientHeight;
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 候选内容块选择器（叶子块），尽量覆盖各类编辑器。
 * 注意：不含裸 img —— 图片随其所在块的 outerHTML 一起被抓，
 * 避免“段落含内嵌图片时丢失段落文字”。含 iframe/video 以保留视频嵌入。
 */
const BLOCK_SELECTOR =
  'p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, figure, iframe, video, ' +
  '[data-record-id], [data-block-id], [data-line-id], [contenteditable] > div';

/** 安全地按选择器取元素（contentSelector 可能含非法字符或匹配失败） */
function safeQuery(selector?: string): HTMLElement | null {
  if (!selector) return null;
  try {
    return document.querySelector<HTMLElement>(selector);
  } catch {
    return null;
  }
}

/**
 * 自动从头滚到尾，累积每屏渲染出的内容块。
 * 用“内容签名”去重，用“在滚动内容中的绝对纵坐标”排序，
 * 最终按文档顺序拼接为一段 HTML。
 *
 * @param contentSelector Defuddle 选中的正文容器选择器；提供时只在该容器内
 *   收集内容块，从而排除目录/导航/侧栏等非正文区域。
 */
export async function captureFullContent(
  contentSelector?: string,
  blockSelector?: string,
): Promise<string> {
  const scroller = findScroller();
  // 收集范围限定到正文容器；但若容器过宽（body/html）或落到滚动容器之外，
  // 则退回整个滚动容器，避免把整页杂物都圈进来。
  const picked = safeQuery(contentSelector);
  const tooBroad =
    !picked ||
    picked === document.body ||
    picked === document.documentElement ||
    picked.tagName === 'HTML' ||
    picked.tagName === 'BODY';
  const root: HTMLElement = tooBroad ? scroller : picked;
  const isWin =
    scroller === document.scrollingElement ||
    scroller === document.documentElement ||
    scroller === document.body;

  const getTop = () => (isWin ? window.scrollY : scroller.scrollTop);
  const setTop = (v: number) =>
    isWin ? window.scrollTo(0, v) : (scroller.scrollTop = v);
  const viewH = isWin ? window.innerHeight : scroller.clientHeight;
  const maxTop = () =>
    isWin
      ? document.scrollingElement!.scrollHeight - window.innerHeight
      : scroller.scrollHeight - scroller.clientHeight;

  const origTop = getTop();
  // key -> { y: 绝对纵坐标, html }
  const blocks = new Map<string, { y: number; html: string }>();

  const capture = () => {
    const base = getTop();
    // 仅在正文容器内收集（root 可能等于 scroller，即未定位到容器时的兜底）
    const nodeSelector = blockSelector || BLOCK_SELECTOR;
    const nodes = root.querySelectorAll<HTMLElement>(nodeSelector);
    for (const el of Array.from(nodes)) {
      // 只保留叶子块，避免父子重复
      if (el.querySelector(nodeSelector)) continue;
      let sourceEl = el;
      if (blockSelector) {
        const isMediaNode =
          /^(IMG|IFRAME|VIDEO|FIGURE)$/.test(el.tagName) ||
          !!el.querySelector('img, iframe, video');
        if (isMediaNode) {
          const ownerList = el.closest<HTMLElement>(
            '[data-block-type="bullet"], [data-block-type="ordered"], [data-block-type="todo"]',
          );
          if (ownerList && ownerList !== root) {
            sourceEl = ownerList;
          }
        } else {
          let candidate: HTMLElement | null = el;
          let parentBlock = candidate.parentElement?.closest<HTMLElement>('[data-block-id]') || null;
          while (parentBlock && parentBlock !== root) {
            if (parentBlock.getAttribute('data-block-type') === 'page') break;
            candidate = parentBlock;
            parentBlock = candidate.parentElement?.closest<HTMLElement>('[data-block-id]') || null;
          }
          sourceEl = candidate;
        }
      }

      const text = (sourceEl.textContent || '').trim();
      // 媒体块（图片/视频/嵌入）即使无文字也要保留
      const media =
        /^(IMG|IFRAME|VIDEO)$/.test(sourceEl.tagName)
          ? sourceEl
          : sourceEl.querySelector('img, iframe, video');
      if (!text && !media) continue;
      // 纯媒体块按地址去重；文本块按内容签名去重
      const blockId = blockSelector
        ? sourceEl.getAttribute('data-block-id') ||
          sourceEl.getAttribute('data-record-id') ||
          el.getAttribute('data-block-id') ||
          el.getAttribute('data-record-id') ||
          ''
        : '';
      const key =
        blockId || (!text && media
          ? `media:${media.getAttribute('src') || media.getAttribute('data-src') || sourceEl.outerHTML.slice(0, 120)}`
          : `${sourceEl.tagName}:${text.slice(0, 160)}`);
      const y = Math.round(base + sourceEl.getBoundingClientRect().top);
      let outerHTML = sourceEl.outerHTML;
      if (blockSelector) {
        outerHTML = sourceEl.outerHTML;
      }
      const prev = blocks.get(key);
      if (!prev) {
        blocks.set(key, { y, html: outerHTML });
      } else {
        // 同一块在飞书虚拟滚动中可能被多次采样。HTML 变完整时要一起保留
        // 最靠前的文档坐标，否则标题和它的子内容会按旧采样位置错序。
        prev.y = Math.min(prev.y, y);
        if (outerHTML.length > prev.html.length) {
          prev.html = outerHTML;
        }
      }
    }
  };

  // 从顶部开始，逐屏向下，每屏等待虚拟渲染后采集
  setTop(0);
  await sleep(400);
  capture();
  let guard = 0;
  let lastTop = -1;
  while (getTop() < maxTop() - 2 && guard++ < 3000) {
    setTop(getTop() + viewH * 0.8);
    await sleep(220);
    capture();
    if (getTop() === lastTop) break; // 无法再滚动
    lastTop = getTop();
  }
  await sleep(350);
  capture(); // 底部再采一次
  setTop(origTop); // 还原用户视图

  const ordered = [...blocks.values()].sort((a, b) => a.y - b.y);
  return ordered.length ? `<div>${ordered.map((b) => b.html).join('\n')}</div>` : '';
}
