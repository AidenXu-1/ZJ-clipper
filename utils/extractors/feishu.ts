// 兆基clipper —— 飞书/Lark 文档专用提取器
//  Defuddle 自动定位会选到 body（混入评论/点赞/导航），故强制指定正文容器并过滤噪声行。
// 注：本模块会被打进 content.js，受 ASCII 约束 —— 中文只可出现在字符串/Set 中，禁止进正则字面量。
import { CaptureVisibleTabResponse, ExtractedPage } from '@/utils/types';
import {
  ExtractContext,
  SiteExtractor,
  captureFullContent,
  htmlToMarkdown,
  parseWithSelector,
  stripZeroWidth,
} from '@/utils/extract-core';

/** 是否飞书/Lark 文档页，是则返回正文容器选择器 */
function feishuContentSelector(): string | null {
  if (!/feishu\.(cn|net)|larksuite\.com|larkoffice\.com/.test(location.hostname)) return null;
  for (const sel of ['.page-main-item.editor', '.editor-container', '.docx-page-block']) {
    if (document.querySelector(sel)) return sel;
  }
  return null;
}

// 飞书正文里仍可能混入的噪声行（评论/点赞/工具条/占位等）——用字符串集合，避免中文进正则
const FEISHU_JUNK = new Set([
  '附件不支持打印',
  '加载中...',
  '跳转至首条评论',
  '真诚点赞，手留余香',
  '当前工作表',
  '当前文档通知',
  '取消发送',
  '上传日志',
  '联系客服',
  '功能更新',
  '帮助中心',
  '效率指南',
  '输入“/”快速插入内容',
]);

function isFeishuJunk(t: string): boolean {
  if (FEISHU_JUNK.has(t)) return true;
  if (/^\d+%$/.test(t)) return true; // 缩放/进度指示
  if (t.startsWith('评论（') && t.endsWith('）')) return true;
  const m = t.match(/^(\d+)\s*(\S+)$/); // “N 字”
  if (m && m[2] === '字') return true;
  return false;
}

function feishuAuthor(): string {
  const header = document.querySelector('.page-block-header');
  if (!header) return '';
  const name = header.querySelector(
    [
      '.doc-info-user-name',
      '.doc-info-owner-name',
      '.doc-info-group-user [class*="name"]',
      '.doc-info-group-owner [class*="name"]',
      '[class*="author-name"]',
      '[class*="owner-name"]',
    ].join(', '),
  );
  const text = stripZeroWidth(name?.textContent || '').replace(/\s+/g, ' ').trim();
  if (text) return text;

  for (const group of Array.from(header.querySelectorAll('.doc-info-group'))) {
    if (group.classList.contains('doc-info-group-time')) continue;
    const groupText = stripZeroWidth(group.textContent || '').replace(/\s+/g, ' ').trim();
    if (
      groupText &&
      groupText.length <= 60 &&
      !groupText.includes('修改') &&
      !groupText.includes('更新')
    ) {
      return groupText;
    }
  }

  const avatar = header.querySelector<HTMLElement>(
    '.doc-info-group-user img, .doc-info-group-owner img, [class*="author"] img, [class*="owner"] img',
  );
  return stripZeroWidth(
    avatar?.getAttribute('alt') ||
      avatar?.getAttribute('title') ||
      avatar?.getAttribute('aria-label') ||
      '',
  ).trim();
}

function feishuModified(title: string): string {
  const raw = stripZeroWidth(
    document.querySelector('.page-block-header .doc-info-time-item')?.textContent || '',
  ).trim();
  if (!raw || (!raw.includes('修改') && !raw.includes('更新'))) return '';

  const full = raw.match(/(\d{4})\D{1,3}(\d{1,2})\D{1,3}(\d{1,2})/);
  let year = full ? parseInt(full[1], 10) : 0;
  let month = full ? parseInt(full[2], 10) : 0;
  let day = full ? parseInt(full[3], 10) : 0;
  if (!full) {
    const short = raw.match(/(\d{1,2})\D{1,3}(\d{1,2})/);
    if (!short) return '';
    month = parseInt(short[1], 10);
    day = parseInt(short[2], 10);
    const titleYear = title.match(/(?:^|\D)(20\d{2})\d{4}(?:\D|$)/);
    year = titleYear ? parseInt(titleYear[1], 10) : new Date().getFullYear();
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** 从飞书块属性/类名读出标准块类型。 */
function feishuBlockKind(el: Element): string {
  return (el.getAttribute('data-block-type') || '').toLowerCase();
}

function headingLevel(el: Element, kind: string): number {
  const aria = parseInt(el.getAttribute('aria-level') || '', 10);
  if (aria >= 1 && aria <= 9) return Math.min(aria, 6);

  const m = kind.match(/^heading([1-9])$/);
  return m ? Math.min(parseInt(m[1], 10), 6) : 0;
}

function meaningfulContent(el: Element): Element {
  return (
    el.querySelector('.ace-line') ||
    el.querySelector('.text-content, .block-content') ||
    el.querySelector('[data-contents="true"]') ||
    el.querySelector('[contenteditable="true"]') ||
    el
  );
}

function replaceWithSemanticTag(el: Element, tag: string, preserveContainer = false): Element {
  const out = el.ownerDocument.createElement(tag);
  const source = preserveContainer ? el : meaningfulContent(el);
  while (source.firstChild) out.appendChild(source.firstChild);
  el.replaceWith(out);
  return out;
}

interface FeishuBoardCapture {
  recordId: string;
  blockId: string;
  index: number;
  url: string;
}

function dataUrlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('截图加载失败'));
    img.src = dataUrl;
  });
}

async function cropVisibleElement(el: HTMLElement): Promise<string | null> {
  el.scrollIntoView({ block: 'center', inline: 'center' });
  await new Promise((resolve) => setTimeout(resolve, 450));
  const rect = el.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right - left < 40 || bottom - top < 40) return null;

  const resp = (await chrome.runtime.sendMessage({
    type: 'ZHAOJI_CLIPPER_CAPTURE_VISIBLE_TAB',
  })) as CaptureVisibleTabResponse;
  if (!resp?.ok) return null;

  const screenshot = await dataUrlImage(resp.dataUrl);
  const scaleX = screenshot.naturalWidth / window.innerWidth;
  const scaleY = screenshot.naturalHeight / window.innerHeight;
  const sx = Math.round(left * scaleX);
  const sy = Math.round(top * scaleY);
  const sw = Math.max(1, Math.round((right - left) * scaleX));
  const sh = Math.max(1, Math.round((bottom - top) * scaleY));
  const canvas = document.createElement('canvas');
  canvas.width = sw;
  canvas.height = sh;
  const cx = canvas.getContext('2d');
  if (!cx) return null;
  cx.drawImage(screenshot, sx, sy, sw, sh, 0, 0, sw, sh);

  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return blob ? URL.createObjectURL(blob) : null;
}

/** 飞书画板无法转成 Markdown，将渲染结果裁剪为 PNG 并回填到原块位置。 */
async function captureFeishuBoards(): Promise<FeishuBoardCapture[]> {
  const origX = window.scrollX;
  const origY = window.scrollY;
  const out: FeishuBoardCapture[] = [];
  const boards = Array.from(
    document.querySelectorAll<HTMLElement>(
      [
        '.docx-page-block [data-block-type="whiteboard"]',
        '.docx-page-block .docx-whiteboard-block',
        '.docx-page-block [data-block-type="board"]',
        '.docx-page-block .docx-board-block',
      ].join(', '),
    ),
  );
  for (const [index, board] of boards.slice(0, 12).entries()) {
    const recordId = board.getAttribute('data-record-id') || '';
    const blockId = board.getAttribute('data-block-id') || '';
    const url = await cropVisibleElement(board).catch(() => null);
    if (url) out.push({ recordId, blockId, index, url });
  }
  window.scrollTo(origX, origY);
  return out;
}

/**
 * 把飞书的视觉块 DOM 规整为语义 HTML，再交给 Turndown。
 * 飞书经常用 div + data-block-type 表示标题/引用/高亮块，不先规整就会被压成普通段落。
 */
function normalizeFeishuHtml(html: string, boards: FeishuBoardCapture[] = []): string {
  if (!html.trim()) return '';
  const doc = new DOMParser().parseFromString(`<div id="zj-feishu-root">${html}</div>`, 'text/html');
  const root = doc.querySelector('#zj-feishu-root');
  if (!root) return html;

  const fallbackBoards = Array.from(
    root.querySelectorAll(
      '[data-block-type="whiteboard"], .docx-whiteboard-block, [data-block-type="board"], .docx-board-block',
    ),
  );
  for (const board of boards) {
    const selector = board.recordId
      ? `[data-record-id="${CSS.escape(board.recordId)}"]`
      : board.blockId
        ? `[data-block-id="${CSS.escape(board.blockId)}"]`
        : '';
    const el = (selector ? root.querySelector(selector) : null) || fallbackBoards[board.index] || null;
    if (!el) continue;
    const img = doc.createElement('img');
    img.setAttribute('src', board.url);
    img.setAttribute('alt', '飞书画板');
    el.replaceWith(img);
  }

  // 先处理外层块；替换后原子节点会脱离文档，避免同一块被重复规整。
  const blocks = Array.from(root.querySelectorAll('[data-block-type]'));
  for (const el of blocks) {
    if (!el.isConnected) continue;
    const kind = feishuBlockKind(el);
    const level = headingLevel(el, kind);

    if (kind === 'page') continue;
    if (kind === 'callout') {
      const quote = replaceWithSemanticTag(el, 'blockquote', true);
      quote.setAttribute('data-obsidian-callout', 'note');
      continue;
    }
    if (kind === 'quote_container' && el.tagName !== 'BLOCKQUOTE') {
      replaceWithSemanticTag(el, 'blockquote', true);
      continue;
    }
    if (level && !/^H[1-6]$/.test(el.tagName)) {
      // 飞书把"折叠/缩进在标题下"的内容嵌套进 .heading-children；转 h 标签只会取标题那一行，
      // 会丢掉这些子块（如标题下的居中副标题）。先取出来，转完标题再接到其后继续规整。
      const childrenZone = el.querySelector('.heading-children');
      const heading = replaceWithSemanticTag(el, `h${level}`);
      if (childrenZone) heading.after(childrenZone);
      continue;
    }
    if (kind === 'bullet') {
      const li = replaceWithSemanticTag(el, 'li');
      const ul = doc.createElement('ul');
      li.replaceWith(ul);
      ul.appendChild(li);
      continue;
    }
    if (kind === 'ordered') {
      const li = replaceWithSemanticTag(el, 'li');
      const ol = doc.createElement('ol');
      li.replaceWith(ol);
      ol.appendChild(li);
      continue;
    }
    if (kind === 'todo') {
      const checked =
        el.getAttribute('aria-checked') === 'true' || /checked|completed|done/.test(kind);
      const p = replaceWithSemanticTag(el, 'p');
      p.insertBefore(doc.createTextNode(checked ? '[x] ' : '[ ] '), p.firstChild);
      continue;
    }
    if (kind === 'code' && el.tagName !== 'PRE') {
      const pre = replaceWithSemanticTag(el, 'pre');
      const code = doc.createElement('code');
      while (pre.firstChild) code.appendChild(pre.firstChild);
      pre.appendChild(code);
    }
  }

  // 飞书行内背景色是语义高亮，转为 mark 后由共享规则输出 ==text==。
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('span, font'))) {
    const style = (el.getAttribute('style') || '').toLowerCase();
    const cls = (el.className || '').toLowerCase();
    const bg = (style.match(/background(?:-color)?\s*:\s*([^;]+)/) || [])[1] || '';
    const hasVisibleBg =
      !!bg &&
      !/transparent|inherit|initial|unset|none/.test(bg) &&
      !/rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(bg);
    const highlighted =
      hasVisibleBg ||
      /highlight|text-background|bg-color/.test(cls) ||
      !!el.getAttribute('data-background-color');
    if (!highlighted || !el.textContent?.trim()) continue;
    const mark = doc.createElement('mark');
    for (const child of Array.from(el.childNodes)) mark.appendChild(child.cloneNode(true));
    el.replaceWith(mark);
  }

  return root.innerHTML;
}

function feishuHtmlToMarkdown(html: string, boards: FeishuBoardCapture[] = []): string {
  return htmlToMarkdown(normalizeFeishuHtml(html, boards));
}

/** 飞书正文清洗：去零宽字符 → 过滤噪声行 → 折叠多余空行 */
function cleanFeishuMarkdown(md: string): string {
  let s = stripZeroWidth(md);
  // 标题标记和文字必须同行；兼容飞书编辑器偶发残留的块级换行。
  s = s.replace(/^(#{1,6})[ \t]*\n+(?:[ \t]*\n+)*([^\n]+)$/gm, '$1 $2');
  // Callout/引用内不保留飞书编辑器包装层制造的空引用行。
  s = s
    .split('\n')
    .filter((line) => !/^>(?:\s*>)*\s*$/.test(line.trim()))
    .join('\n');
  s = s
    .split('\n')
    .filter((line) => {
      const t = line.replace(/^[-*>\s]+/, '').trim();
      return !t || !isFeishuJunk(t);
    })
    .join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// ===== 并排图片：把飞书里并排的图，在 Obsidian 里也排成同一行 =====
// 区分"并排一组"与"各自独立的单图"：飞书并排的图之间只隔着空行/百分比/图注（=图 alt），
// 而单图被标题/列表/正文夹着。据此把"连续且只被这些'胶水'隔开的多张图"合并成一行带宽度的嵌入。
// 仅命中并排组；单图、被正文隔开的图、其它内容都不动（普通文档基本不受影响）。

const ROW_TARGET_WIDTH = 620; // 一行并排图的总宽(px)，分摊后约 300/张，常规阅读宽度内不换行

/** 整行恰好是一张图 ![alt](url) 时返回其 alt/url，否则 null */
function parseImgLine(line: string): { alt: string; url: string } | null {
  const m = stripZeroWidth(line).trim().match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
  return m ? { alt: m[1].trim(), url: m[2] } : null;
}

function groupInlineImages(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const first = parseImgLine(lines[i]);
    if (!first) {
      out.push(lines[i]);
      i++;
      continue;
    }
    // 从这张图起，向下收集"只被空行/百分比/图注隔开"的连续图片
    const group = [first];
    const alts = new Set([first.alt]);
    const captions: string[] = []; // 图注：合并后放到并排图下方保留，不丢
    let j = i + 1;
    while (j < lines.length) {
      const t = stripZeroWidth(lines[j]).trim();
      if (t === '' || /^\d{1,3}%$/.test(t)) {
        j++;
        continue; // 空行 / 宽度百分比 = 胶水
      }
      const img = parseImgLine(lines[j]);
      if (img) {
        group.push(img);
        alts.add(img.alt);
        j++;
        continue;
      }
      if (alts.has(t)) {
        captions.push(lines[j]);
        j++;
        continue; // 单独成行、且文字等于某张图 alt = 图注（飞书图注），保留
      }
      break; // 实质正文/标题/列表 → 这组到此为止
    }
    if (group.length >= 2) {
      const w = Math.round(ROW_TARGET_WIDTH / group.length);
      out.push(group.map((g) => `![${g.alt}|${w}](${g.url})`).join(' '));
      // 图注：斜体、并排图正下方一行（保持可移植，不用 HTML）
      const caps = captions.map((c) => stripZeroWidth(c).trim()).filter(Boolean);
      if (caps.length) out.push(caps.map((c) => `*${c}*`).join('  '));
      out.push(''); // 与后续正文留空行
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

// 飞书加载中标题占位（真实标题稍后才注入），命中视为"未就绪"
const GENERIC_TITLES = new Set(['', 'docs', 'doc', 'untitled', '无标题', 'lark', '飞书', '飞书云文档']);

/** 去零宽 + 去 " - 飞书云文档" 后缀，返回干净标题 */
function cleanDocTitle(raw: string): string {
  const s = stripZeroWidth(raw || '').trim();
  const i = s.lastIndexOf('飞书云文档');
  return (i > 0 ? s.slice(0, i).replace(/[\s\-|]+$/, '') : s).trim();
}

function isGenericTitle(t: string): boolean {
  return GENERIC_TITLES.has(cleanDocTitle(t).toLowerCase());
}

/**
 * 从页面的标题元素 .note-title 读真实文档标题（document.title 在后台标签页常停在
 * "飞书云文档" 占位，不可靠）。.note-title 里混有"分享/编辑"等按钮文字，去掉。
 */
function feishuDocTitle(): string {
  const el = document.querySelector('.note-title');
  if (!el) return '';
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button, a, svg, [role="button"]').forEach((n) => n.remove());
  let t = stripZeroWidth(clone.textContent || '').replace(/\s+/g, ' ').trim();
  t = t.replace(/(分享|编辑|更多|复制链接|收藏)+$/g, '').trim(); // 去尾部按钮残留
  return t;
}

/** 等飞书真实标题就绪：占位时轮询 .note-title，最多 ~2s */
async function waitForFeishuTitle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const t = feishuDocTitle();
    if (t && !GENERIC_TITLES.has(t.toLowerCase())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** 取真实文档标题：优先 .note-title 元素，再回退 parsed.title / document.title */
function bestFeishuTitle(parsedTitle: string): string {
  const fromEl = feishuDocTitle();
  if (fromEl && !GENERIC_TITLES.has(fromEl.toLowerCase())) return fromEl;
  for (const c of [cleanDocTitle(parsedTitle), cleanDocTitle(document.title)]) {
    if (c && !GENERIC_TITLES.has(c.toLowerCase())) return c;
  }
  return fromEl || cleanDocTitle(parsedTitle) || cleanDocTitle(document.title) || '未命名';
}

async function extractFeishu(ctx: ExtractContext, sel: string): Promise<ExtractedPage> {
  await waitForFeishuTitle(); // 标题未加载完时（显示 Docs）先等一下，避免文件名取到占位
  const boards = await captureFeishuBoards();
  const parsed = await parseWithSelector(ctx.url, sel);
  const defuddleMd = cleanFeishuMarkdown(feishuHtmlToMarkdown(parsed.content || '', boards));

  // 完整抓取：把滚动收集“限定在正文容器内”，排除目录/导航/侧栏/通知等
  let contentMarkdown = defuddleMd;
  if (ctx.fullCapture) {
    const scope = sel || parsed.debug?.contentSelector;
    const fullHtml = await captureFullContent(scope, '[data-block-id], [data-record-id]');
    const fullMd = cleanFeishuMarkdown(feishuHtmlToMarkdown(fullHtml, boards));
    if (fullMd.length > defuddleMd.length) contentMarkdown = fullMd;
  }

  // 并排图片：把"同一行连续多张图"加宽度排成并排（仅命中并排行，普通内容不动）
  contentMarkdown = groupInlineImages(contentMarkdown);

  // 标题：优先非占位标题（避免抓到加载中的 "Docs"），并去 " - 飞书云文档" 后缀
  const cleanTitle = bestFeishuTitle(parsed.title);
  const author = feishuAuthor() || parsed.author || '';
  const modified = feishuModified(cleanTitle);

  return {
    title: cleanTitle || '未命名',
    author,
    published: parsed.published || '',
    modified,
    description: parsed.description || '',
    site: parsed.site || '',
    domain: parsed.domain || location.hostname,
    url: ctx.url,
    image: parsed.image || '',
    contentMarkdown,
    selectionMarkdown: htmlToMarkdown(ctx.selectionHtml),
    wordCount: parsed.wordCount || 0,
    highlights: ctx.highlights,
  };
}

export const feishuExtractor: SiteExtractor = {
  name: 'feishu',
  // 仅当确为飞书页且定位到正文容器时才接管；否则放行给通用适配器（与重构前一致）
  match: () => feishuContentSelector() !== null,
  extract: (ctx) => extractFeishu(ctx, feishuContentSelector()!),
};
