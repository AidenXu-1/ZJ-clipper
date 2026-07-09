// 兆基clipper —— 飞书/Lark 文档专用提取器
//  Defuddle 自动定位会选到 body（混入评论/点赞/导航），故强制指定正文容器并过滤噪声行。
// 注：本模块会被打进 content.js，受 ASCII 约束 —— 中文只可出现在字符串/Set 中，禁止进正则字面量。
import { CaptureVisibleTabResponse, ExtractedPage } from '@/utils/types';
import {
  ExtractContext,
  SiteExtractor,
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

function isBroadSelector(sel: string): boolean {
  const s = (sel || '').trim().toLowerCase();
  return !s || s === 'html' || s === 'body' || s.includes('body#') || s.includes('html.');
}

function scopedFeishuSelector(fallback = ''): string {
  const exact = feishuContentSelector();
  if (exact) return exact;
  return isBroadSelector(fallback) ? '' : fallback;
}

// 飞书正文里仍可能混入的噪声行（评论/点赞/工具条/占位等）——用字符串集合，避免中文进正则
const FEISHU_JUNK = new Set([
  '飞书云文档',
  '互联网公开',
  '搜索',
  '问问知识库',
  '目录',
  '取消',
  '确认',
  '编辑封面',
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

function htmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function normalizeFeishuHref(raw: string): string {
  const value = (raw || '').trim();
  if (!value) return '';
  const direct = value.match(/https?:\/\/[^\s"'<>]+/i)?.[0] || '';
  const candidate = direct || value;
  if (candidate.startsWith('#')) return '';
  if (/^javascript:/i.test(candidate) && !direct) return '';
  if (/^https?:\/\//i.test(candidate)) return candidate;
  if (candidate.startsWith('//')) return `https:${candidate}`;
  if (candidate.startsWith('/')) {
    try {
      return new URL(candidate, location.origin).href;
    } catch {
      return candidate;
    }
  }
  return '';
}

function feishuElementHref(el: HTMLElement): string {
  const preferredAttrs = [
    'href',
    'data-href',
    'data-url',
    'data-link',
    'data-link-url',
    'data-open-url',
    'data-target-url',
    'data-clipboard-text',
  ];
  for (const attr of preferredAttrs) {
    const href = normalizeFeishuHref(el.getAttribute(attr) || '');
    if (href) return href;
  }

  for (const attr of Array.from(el.attributes)) {
    if (!/(href|url|link)/i.test(attr.name)) continue;
    const href = normalizeFeishuHref(attr.value);
    if (href) return href;
  }
  return '';
}

function feishuInlineHtml(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return htmlEscape(node.textContent || '');
  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = node as HTMLElement;
  if (el.matches('.docx-block-zero-space, [data-zero-space="true"]')) return '';
  const tag = el.tagName;
  if (tag === 'BR') return '<br>';
  if (tag === 'IMG') {
    const src = el.getAttribute('data-src') || el.getAttribute('src') || '';
    if (!src) return '';
    const alt = el.getAttribute('alt') || '';
    return `<img src="${htmlEscape(src)}" alt="${htmlEscape(alt)}">`;
  }

  const inner = Array.from(el.childNodes).map(feishuInlineHtml).join('');
  if (!inner.trim()) return '';

  const style = (el.getAttribute('style') || '').toLowerCase();
  const cls = (el.className || '').toLowerCase();
  const bg = (style.match(/background(?:-color)?\s*:\s*([^;]+)/) || [])[1] || '';
  const highlighted =
    (!!bg &&
      !/transparent|inherit|initial|unset|none/.test(bg) &&
      !/rgba\([^)]*,\s*0(?:\.0+)?\s*\)/.test(bg)) ||
    /highlight|text-background|bg-color/.test(cls) ||
    !!el.getAttribute('data-background-color') ||
    tag === 'MARK';
  const bold = tag === 'STRONG' || tag === 'B' || /font-weight\s*:\s*(bold|[6-9]00)/.test(style);
  const italic = tag === 'EM' || tag === 'I' || /font-style\s*:\s*italic/.test(style);
  const code = tag === 'CODE';

  let out = inner;
  if (code) out = `<code>${out}</code>`;
  if (bold) out = `<strong>${out}</strong>`;
  if (italic) out = `<em>${out}</em>`;
  if (highlighted) out = `<mark>${out}</mark>`;
  const href = feishuElementHref(el);
  if (href && (tag === 'A' || /link|url|reference|mention/.test(cls))) {
    out = `<a href="${htmlEscape(href)}">${out}</a>`;
  }
  return out;
}

function feishuTableCellHtml(cell: Element): string {
  const lines = outermostElements(Array.from(cell.querySelectorAll('.ace-line')));
  const parts = lines.length
    ? lines.map((line) => Array.from(line.childNodes).map(feishuInlineHtml).join('').trim())
    : [Array.from(cell.childNodes).map(feishuInlineHtml).join('').trim()];
  return parts.filter(Boolean).join('<br>');
}

const LIST_SELECTOR = '[data-block-type="bullet"], [data-block-type="ordered"], [data-block-type="todo"]';
const LIST_MARKERS = ['•', '◦', '▪', '▫', '●', '○'];
const FEISHU_FULL_BLOCK_SELECTOR =
  '[data-block-id], [data-record-id], figure, img, iframe, video, [class*="image" i]';
const FEISHU_BOARD_SELECTOR = [
  '.docx-page-block [data-block-type="whiteboard"]',
  '.docx-page-block .docx-whiteboard-block',
  '.docx-page-block [data-block-type="board"]',
  '.docx-page-block .docx-board-block',
].join(', ');
const FEISHU_ISV_SELECTOR = [
  '.docx-page-block [data-block-type="isv"]',
  '.docx-page-block .docx-isv-block',
].join(', ');

function stripLeadingListMarker(html: string): string {
  let out = html.trim();
  let changed = true;
  while (changed) {
    changed = false;
    out = out.replace(/^(&nbsp;|\s)+/, '');
    for (const marker of LIST_MARKERS) {
      if (out.startsWith(marker)) {
        out = out.slice(marker.length).trimStart();
        changed = true;
      }
    }
  }
  return out;
}

function closestListBlock(el: Element): Element | null {
  return el.closest(LIST_SELECTOR);
}

function listLineHtml(el: Element): string {
  const lines = Array.from(el.querySelectorAll('.ace-line'));
  const own = lines.find((line) => closestListBlock(line) === el);
  const source = own || meaningfulContent(el);
  return stripLeadingListMarker(Array.from(source.childNodes).map(feishuInlineHtml).join('').trim());
}

function directChildListBlocks(el: Element): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(LIST_SELECTOR)).filter((child) => {
    if (child === el) return false;
    const parent = child.parentElement?.closest(LIST_SELECTOR);
    return parent === el;
  });
}

function directOwnedMediaBlocks(el: Element): HTMLElement[] {
  const candidates = Array.from(
    el.querySelectorAll<HTMLElement>(
      'figure, img, iframe, video, [data-zhaoji-board], [data-zhaoji-isv], [class*="image" i]',
    ),
  ).filter((media) => {
    if (media.closest('table')) return false;
    if (media.closest('.ace-line')) return false;
    return media.closest(LIST_SELECTOR) === el;
  });
  return outermostElements(candidates) as HTMLElement[];
}

function cleanListMediaClone(media: HTMLElement): HTMLElement {
  const clone = media.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll('button, svg, [role="button"], [contenteditable="true"], .docx-block-zero-space')
    .forEach((node) => node.remove());
  return clone;
}

function hasUsableImageSource(el: Element): boolean {
  return Array.from(el.querySelectorAll<HTMLImageElement>('img')).some((img) =>
    !!(img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('srcset')),
  );
}

function isLikelyLoadingVisualBlock(el: HTMLElement): boolean {
  const text = stripZeroWidth(el.textContent || '').replace(/\s+/g, '').trim();
  const cls = `${el.className || ''} ${el.getAttribute('class') || ''}`.toLowerCase();
  const hasLoadingNode = !!el.querySelector(
    '[class*="loading" i], [class*="spinner" i], [class*="skeleton" i], [class*="placeholder" i], [aria-busy="true"]',
  );
  return !hasUsableImageSource(el) && text.length <= 12 && (hasLoadingNode || /loading|spinner|skeleton|placeholder/.test(cls));
}

function safeQueryElement(selector?: string): HTMLElement | null {
  if (!selector) return null;
  try {
    return document.querySelector<HTMLElement>(selector);
  } catch {
    return null;
  }
}

function listTagForKind(kind: string): 'ul' | 'ol' {
  return kind === 'ordered' ? 'ol' : 'ul';
}

function buildListItem(doc: Document, el: HTMLElement): HTMLLIElement {
  const li = doc.createElement('li');
  const kind = feishuBlockKind(el);
  const checked =
    kind === 'todo' &&
    (el.getAttribute('aria-checked') === 'true' || /checked|completed|done/.test(`${el.className}`));
  const line = listLineHtml(el);
  li.innerHTML = kind === 'todo' ? `${checked ? '[x]' : '[ ]'} ${line}`.trim() : line;

  const groups: Array<{ tag: 'ul' | 'ol'; items: HTMLElement[] }> = [];
  for (const child of directChildListBlocks(el)) {
    const tag = listTagForKind(feishuBlockKind(child));
    const last = groups[groups.length - 1];
    if (last?.tag === tag) last.items.push(child);
    else groups.push({ tag, items: [child] });
  }
  for (const group of groups) {
    const list = doc.createElement(group.tag);
    for (const child of group.items) list.appendChild(buildListItem(doc, child));
    li.appendChild(list);
  }
  for (const media of directOwnedMediaBlocks(el)) {
    const p = doc.createElement('p');
    p.appendChild(cleanListMediaClone(media));
    li.appendChild(p);
  }
  return li;
}

function buildListFromTopBlocks(doc: Document, blocks: HTMLElement[]): HTMLOListElement | HTMLUListElement {
  const firstKind = feishuBlockKind(blocks[0]);
  const list = doc.createElement(listTagForKind(firstKind));
  for (const block of blocks) list.appendChild(buildListItem(doc, block));
  return list;
}

function areAdjacentTopListBlocks(prev: HTMLElement, next: HTMLElement): boolean {
  return prev.parentElement === next.parentElement && prev.nextElementSibling === next;
}

function normalizeFeishuLists(doc: Document, root: Element): void {
  const all = Array.from(root.querySelectorAll<HTMLElement>(LIST_SELECTOR));
  const top = all.filter((el) => !el.parentElement?.closest(LIST_SELECTOR));
  const consumed = new Set<HTMLElement>();
  let i = 0;
  while (i < top.length) {
    const start = top[i];
    if (!start.isConnected || consumed.has(start)) {
      i++;
      continue;
    }
    const tag = listTagForKind(feishuBlockKind(start));
    const group: HTMLElement[] = [];
    while (i < top.length && listTagForKind(feishuBlockKind(top[i])) === tag) {
      const current = top[i];
      const previous = group[group.length - 1];
      if (previous && !areAdjacentTopListBlocks(previous, current)) break;
      if (current.isConnected && !consumed.has(current)) group.push(current);
      i++;
    }
    if (!group.length) continue;
    const list = buildListFromTopBlocks(doc, group);
    group[0].replaceWith(list);
    for (const block of group.slice(1)) block.remove();
    for (const block of group) consumed.add(block);
  }
}

function readTableColumnWidths(table: HTMLTableElement): number[] {
  const cols = Array.from(table.querySelectorAll('col'))
    .map((col) => parseInt(col.getAttribute('width') || '', 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (cols.length) return cols;

  const grid = table.querySelector('tr')?.getAttribute('style') || '';
  const m = grid.match(/grid-template-columns\s*:\s*([^;]+)/);
  if (!m) return [];
  return m[1]
    .split(/\s+/)
    .map((part) => parseInt(part, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
}

function appendSemanticTableRows(
  doc: Document,
  dest: Element,
  rows: HTMLTableRowElement[],
  header: boolean,
): void {
  for (const row of rows) {
    const outRow = doc.createElement('tr');
    for (const cell of Array.from(row.children).filter((c) => /^T[HD]$/.test(c.tagName))) {
      const outCell = doc.createElement(header ? 'th' : 'td');
      const rowspan = cell.getAttribute('rowspan');
      const colspan = cell.getAttribute('colspan');
      if (rowspan && rowspan !== '1') outCell.setAttribute('rowspan', rowspan);
      if (colspan && colspan !== '1') outCell.setAttribute('colspan', colspan);
      outCell.setAttribute(
        'style',
        'border:1px solid var(--background-modifier-border);padding:6px 8px;vertical-align:top;word-break:break-word;white-space:normal;',
      );
      outCell.innerHTML = feishuTableCellHtml(cell);
      outRow.appendChild(outCell);
    }
    if (outRow.children.length) dest.appendChild(outRow);
  }
}

function buildSemanticFeishuTable(
  doc: Document,
  headerRows: HTMLTableRowElement[],
  bodyRows: HTMLTableRowElement[],
  widths: number[],
): HTMLTableElement | null {
  if (!headerRows.length && !bodyRows.length) return null;
  const table = doc.createElement('table');
  table.setAttribute('data-zhaoji-wide-table', 'true');
  table.setAttribute('width', '100%');
  table.setAttribute('cellspacing', '0');
  table.setAttribute(
    'style',
    'width:100%;min-width:100%;border-collapse:collapse;table-layout:fixed;',
  );

  if (widths.length) {
    const total = widths.reduce((sum, n) => sum + n, 0);
    const colgroup = doc.createElement('colgroup');
    for (const width of widths) {
      const col = doc.createElement('col');
      col.setAttribute('style', `width:${((width / total) * 100).toFixed(2)}%;`);
      colgroup.appendChild(col);
    }
    table.appendChild(colgroup);
  }

  if (headerRows.length) {
    const thead = doc.createElement('thead');
    appendSemanticTableRows(doc, thead, headerRows, true);
    if (thead.children.length) table.appendChild(thead);
  }
  if (bodyRows.length) {
    const tbody = doc.createElement('tbody');
    appendSemanticTableRows(doc, tbody, bodyRows, false);
    if (tbody.children.length) table.appendChild(tbody);
  }
  return table;
}

function tableRowText(row: HTMLTableRowElement): string {
  return Array.from(row.children)
    .filter((cell) => /^T[HD]$/.test(cell.tagName))
    .map((cell) => stripZeroWidth(cell.textContent || '').replace(/\s+/g, ' ').trim())
    .join('\t');
}

function normalizeFeishuTables(doc: Document, root: Element): void {
  const tables = outermostElements(Array.from(root.querySelectorAll('table'))) as HTMLTableElement[];
  const consumed = new Set<HTMLTableElement>();

  for (const [index, table] of tables.entries()) {
    if (!table.isConnected || consumed.has(table)) continue;
    const isStickyHeader = table.classList.contains('sticky-row-wrapper');
    const nextTable =
      isStickyHeader && tables[index + 1]?.isConnected && !consumed.has(tables[index + 1])
        ? tables[index + 1]
        : null;

    const headerSource = isStickyHeader ? table : null;
    const bodySource = nextTable || table;
    const headerRows = headerSource
      ? Array.from(headerSource.querySelectorAll('tr')) as HTMLTableRowElement[]
      : [];
    let bodyRows = Array.from(bodySource.querySelectorAll('tr')) as HTMLTableRowElement[];
    // Feishu renders the first table row twice: once as a sticky header clone and
    // once as the real first row. Keep the sticky row as <thead>, drop the clone
    // from <tbody> so Obsidian does not show a fake blank row/gap.
    if (headerRows.length && bodyRows.length && tableRowText(headerRows[0]) === tableRowText(bodyRows[0])) {
      bodyRows = bodyRows.slice(1);
    }
    const widths = readTableColumnWidths(bodySource).length
      ? readTableColumnWidths(bodySource)
      : readTableColumnWidths(table);
    const semantic = buildSemanticFeishuTable(doc, headerRows, bodyRows, widths);
    if (!semantic) continue;

    table.replaceWith(semantic);
    consumed.add(table);
    if (nextTable) {
      nextTable.remove();
      consumed.add(nextTable);
    }
  }
}

const FEISHU_CODE_BLOCK_SELECTORS = [
  '[data-block-type="code"]',
  '[data-block-type="code_block"]',
  '[data-block-type="codeblock"]',
  '.docx-code-block',
  '.code-block',
  '.ace_editor',
  '.cm-editor',
  '.monaco-editor',
];

const FEISHU_CODE_LINE_SELECTOR = [
  '.ace_line',
  '.ace-line',
  '.cm-line',
  '.view-line',
  '.monaco-line',
  '[data-code-line]',
  '[class*="code-line"]',
  '[data-slate-editor] > div',
  '[data-zone-container][contenteditable] > div',
  '.zone-container.text-editor > div',
].join(', ');

function normalizeCodeText(raw: string): string {
  const s = stripZeroWidth(raw)
    .replace(/\u00A0/g, ' ')
    .replace(/\r\n?/g, '\n')
    .replace(/\n+$/g, '');
  const lines = s.split('\n');
  while (lines.length && ['代码块', 'PlainText', '复制'].includes(lines[0].trim())) lines.shift();
  let out = lines.join('\n');
  for (const prefix of ['代码块PlainText复制', 'PlainText复制']) {
    if (out.replace(/\s+/g, '').startsWith(prefix)) {
      let cursor = 0;
      for (const ch of prefix) {
        while (/\s/.test(out[cursor] || '')) cursor++;
        if (out[cursor] === ch) cursor++;
      }
      while (/\s/.test(out[cursor] || '')) cursor++;
      out = out.slice(cursor);
      break;
    }
  }
  return out;
}

function outermostElements(nodes: Element[]): Element[] {
  return nodes.filter((node) => !nodes.some((other) => other !== node && other.contains(node)));
}

function feishuCodeHost(el: Element): Element {
  return (
    el.closest(
      [
        '[data-block-type="code"]',
        '[data-block-type="code_block"]',
        '[data-block-type="codeblock"]',
        '.docx-code-block',
        '.code-block',
      ].join(', '),
    ) || el
  );
}

function feishuCodeLanguage(el: Element): string {
  const raw =
    el.getAttribute('data-language') ||
    el.getAttribute('data-code-language') ||
    el.querySelector('[data-language], [data-code-language]')?.getAttribute('data-language') ||
    el.querySelector('[data-language], [data-code-language]')?.getAttribute('data-code-language') ||
    '';
  const clean = raw.toLowerCase().replace(/[^a-z0-9_+#.-]/g, '');
  if (clean) return clean;
  const cls = `${el.className || ''} ${el.querySelector('code')?.className || ''}`;
  const m = cls.match(/(?:language|lang)-([a-z0-9_+#.-]+)/i);
  return m ? m[1].toLowerCase() : '';
}

function feishuCodeText(el: Element): string {
  const lineNodes = outermostElements(Array.from(el.querySelectorAll(FEISHU_CODE_LINE_SELECTOR)));
  if (lineNodes.length) {
    return normalizeCodeText(lineNodes.map((line) => line.textContent || '').join('\n'));
  }

  const codeContent =
    el.querySelector(
      [
        '.ace_text-layer',
        '.cm-content',
        '.view-lines',
        '[data-slate-editor]',
        '[data-zone-container][contenteditable]',
        '.zone-container.text-editor',
        'code',
        'pre',
      ].join(', '),
    ) || el;
  const clone = codeContent.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      [
        'button',
        'svg',
        '[role="button"]',
        '[contenteditable="false"]',
        '[class*="copy"]',
        '[class*="toolbar"]',
        '[class*="language"]',
      ].join(', '),
    )
    .forEach((n) => n.remove());
  return normalizeCodeText(clone.textContent || '');
}

function replaceWithCodeBlock(el: Element): boolean {
  const codeText = feishuCodeText(el);
  if (!codeText.trim()) return false;

  const pre = el.ownerDocument.createElement('pre');
  const code = el.ownerDocument.createElement('code');
  const lang = feishuCodeLanguage(el);
  if (lang) code.setAttribute('class', `language-${lang}`);
  code.textContent = codeText;
  pre.appendChild(code);
  el.replaceWith(pre);
  return true;
}

interface FeishuBoardCapture {
  recordId: string;
  blockId: string;
  index: number;
  url: string;
  alt: string;
  kind: 'board' | 'isv';
}

interface FeishuCodeCapture {
  recordId: string;
  blockId: string;
  index: number;
  text: string;
  language: string;
}

function codeCaptureKey(recordId: string, blockId: string, index: number): string {
  return recordId || blockId || `index:${index}`;
}

function codeBlockId(el: Element): { recordId: string; blockId: string } {
  const host = feishuCodeHost(el);
  return {
    recordId: host.getAttribute('data-record-id') || '',
    blockId: host.getAttribute('data-block-id') || '',
  };
}

function normalizeCodePresenceText(text: string): string {
  return stripZeroWidth(text)
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function dataUrlImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('截图加载失败'));
    img.src = dataUrl;
  });
}

function isFeishuScreenshotOverlay(el: HTMLElement, target: HTMLElement): boolean {
  if (el === target || target.contains(el) || el.contains(target)) return false;
  const style = getComputedStyle(el);
  if (style.position === 'fixed' || style.position === 'sticky') return true;

  const marker = `${el.id || ''} ${el.className || ''} ${el.getAttribute('class') || ''}`.toLowerCase();
  if (
    /water[-_]?mark|watermark|wmk|print[-_]?mark/.test(marker) ||
    /note-title|header-ssr|suite-title|page-block-header|doc-info/.test(marker)
  ) {
    return true;
  }

  if (style.position === 'absolute' || style.zIndex !== 'auto') {
    const a = el.getBoundingClientRect();
    const b = target.getBoundingClientRect();
    return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
  }
  return false;
}

function hideFeishuScreenshotOverlays(target: HTMLElement): () => void {
  const changed: Array<{ el: HTMLElement; style: string | null }> = [];
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('body *'))) {
    if (!isFeishuScreenshotOverlay(el, target)) continue;
    changed.push({ el, style: el.getAttribute('style') });
    el.style.setProperty('visibility', 'hidden', 'important');
  }
  return () => {
    for (const item of changed.reverse()) {
      if (item.style == null) item.el.removeAttribute('style');
      else item.el.setAttribute('style', item.style);
    }
  };
}

async function cropVisibleElement(el: HTMLElement, scrollIntoView = true): Promise<string | null> {
  if (scrollIntoView) {
    el.scrollIntoView({ block: 'center', inline: 'center' });
    await new Promise((resolve) => setTimeout(resolve, 450));
  }
  const rect = el.getBoundingClientRect();
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(window.innerWidth, rect.right);
  const bottom = Math.min(window.innerHeight, rect.bottom);
  if (right - left < 40 || bottom - top < 40) return null;

  const restoreOverlays = hideFeishuScreenshotOverlays(el);
  const resp = (await chrome.runtime
    .sendMessage({
      type: 'ZHAOJI_CLIPPER_CAPTURE_VISIBLE_TAB',
    })
    .finally(restoreOverlays)) as CaptureVisibleTabResponse;
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

async function captureFeishuVisualElement(
  el: HTMLElement,
  getTop: () => number,
  setTop: (v: number) => void,
  maxTop: () => number,
): Promise<string | null> {
  const initialTop = getTop();
  const initialWindowX = window.scrollX;
  const initialWindowY = window.scrollY;
  let restoreOverlays: (() => void) | null = null;
  try {
    const firstRect = el.getBoundingClientRect();
    const docTop = initialTop + firstRect.top;
    const cssWidth = Math.min(window.innerWidth, Math.max(0, firstRect.right) - Math.max(0, firstRect.left));
    const cssHeight = Math.min(3600, Math.max(0, firstRect.height));
    if (cssWidth < 40 || cssHeight < 40) return null;

    let canvas: HTMLCanvasElement | null = null;
    let ctx: CanvasRenderingContext2D | null = null;
    let scaleX = 1;
    let scaleY = 1;
    let coveredUntil = 0;
    let guard = 0;
    const margin = 72;
    const topGuard = 96;

    while (coveredUntil < cssHeight - 2 && guard++ < 12) {
      const skipTop = coveredUntil > 0 ? topGuard : 0;
      const targetTop = Math.max(0, Math.min(maxTop(), docTop + coveredUntil - margin - skipTop));
      setTop(targetTop);
      await new Promise((resolve) => setTimeout(resolve, 420));
      restoreOverlays?.();
      restoreOverlays = hideFeishuScreenshotOverlays(el);

      const rect = el.getBoundingClientRect();
      const left = Math.max(0, rect.left);
      const right = Math.min(window.innerWidth, rect.right);
      const visibleTop = Math.max(0, rect.top);
      const visibleBottom = Math.min(window.innerHeight, rect.bottom, rect.top + cssHeight);
      const usableTop = Math.min(visibleBottom, visibleTop + skipTop);
      const visibleHeight = visibleBottom - usableTop;
      const visibleWidth = right - left;
      if (visibleWidth < 40 || visibleHeight < 40) break;

      const resp = (await chrome.runtime.sendMessage({
        type: 'ZHAOJI_CLIPPER_CAPTURE_VISIBLE_TAB',
      })) as CaptureVisibleTabResponse;
      if (!resp?.ok) break;

      const screenshot = await dataUrlImage(resp.dataUrl);
      scaleX = screenshot.naturalWidth / window.innerWidth;
      scaleY = screenshot.naturalHeight / window.innerHeight;
      if (!canvas) {
        canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(cssWidth * scaleX));
        canvas.height = Math.max(1, Math.round(cssHeight * scaleY));
        ctx = canvas.getContext('2d');
        if (!ctx) return null;
      }

      const visibleDocY = getTop() + usableTop;
      const destY = Math.max(0, Math.round((visibleDocY - docTop) * scaleY));
      const sourceX = Math.round(left * scaleX);
      const sourceY = Math.round(usableTop * scaleY);
      const sourceW = Math.max(1, Math.min(canvas.width, Math.round(visibleWidth * scaleX)));
      const sourceH = Math.max(1, Math.round(visibleHeight * scaleY));
      ctx!.drawImage(
        screenshot,
        sourceX,
        sourceY,
        sourceW,
        sourceH,
        0,
        destY,
        sourceW,
        Math.min(sourceH, canvas.height - destY),
      );

      const nextCovered = visibleDocY + visibleHeight - docTop;
      if (nextCovered <= coveredUntil + 8) break;
      coveredUntil = nextCovered;
    }

    if (!canvas || coveredUntil < 40) return null;
    const blob = await new Promise<Blob | null>((resolve) => canvas!.toBlob(resolve, 'image/png'));
    return blob ? URL.createObjectURL(blob) : null;
  } finally {
    restoreOverlays?.();
    setTop(initialTop);
    window.scrollTo(initialWindowX, initialWindowY);
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
}

function visibleLineKey(el: Element): string {
  const r = el.getBoundingClientRect();
  return [
    Math.round(r.top + window.scrollY),
    Math.round(r.left + window.scrollX),
    normalizeCodeText(el.textContent || ''),
  ].join(':');
}

function collectVisibleCodeLines(scope: Element): Array<{ y: number; text: string; key: string }> {
  const rows = outermostElements(Array.from(scope.querySelectorAll(FEISHU_CODE_LINE_SELECTOR)));
  if (rows.length) {
    return rows
      .map((row) => {
        const r = row.getBoundingClientRect();
        return {
          y: Math.round(r.top + window.scrollY),
          text: normalizeCodeText(row.textContent || ''),
          key: visibleLineKey(row),
        };
      })
      .filter((row) => row.text.trim() || row.text.length > 0);
  }
  const text = feishuCodeText(scope);
  return text ? [{ y: 0, text, key: text }] : [];
}

function isCodeCopyControl(el: HTMLElement): boolean {
  const text = stripZeroWidth(el.textContent || '').replace(/\s+/g, '').trim();
  const aria = stripZeroWidth(
    el.getAttribute('aria-label') ||
      el.getAttribute('title') ||
      el.getAttribute('data-tooltip') ||
      el.getAttribute('data-lark-tooltip') ||
      '',
  )
    .replace(/\s+/g, '')
    .trim();
  const cls = (el.className || '').toLowerCase();
  return text.includes('复制') || aria.includes('复制') || /copy|clipboard/.test(cls);
}

function findCodeCopyButton(el: HTMLElement): HTMLElement | null {
  const selectors = [
    'button',
    '[role="button"]',
    '[class*="copy" i]',
    '[class*="clipboard" i]',
    '[aria-label*="copy" i]',
    '[title*="copy" i]',
    '[data-tooltip*="copy" i]',
    '[aria-label*="复制"]',
    '[title*="复制"]',
    '[data-tooltip*="复制"]',
    '[data-lark-tooltip*="复制"]',
  ].join(', ');
  const candidates = Array.from(
    el.querySelectorAll<HTMLElement>(selectors),
  );
  return candidates.find(isCodeCopyControl) || null;
}

async function tryCopyCodeText(el: HTMLElement): Promise<string> {
  const documentScroller = findFeishuDocumentScroller();
  const originalDocumentTop = documentScroller.scrollTop;
  const originalWindowX = window.scrollX;
  const originalWindowY = window.scrollY;
  const restoreScroll = () => {
    documentScroller.scrollTop = originalDocumentTop;
    window.scrollTo(originalWindowX, originalWindowY);
  };

  el.scrollIntoView({ block: 'center', inline: 'nearest' });
  for (const type of ['mouseenter', 'mouseover']) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
  }
  await new Promise((resolve) => setTimeout(resolve, 120));

  const btn = findCodeCopyButton(el);
  if (!btn) {
    restoreScroll();
    return '';
  }

  let copied = '';
  const onCopy = (ev: ClipboardEvent) => {
    const text = normalizeCodeText(ev.clipboardData?.getData('text/plain') || '');
    if (text.trim()) copied = text;
  };

  let previous: string | null = null;
  try {
    previous = await navigator.clipboard?.readText();
  } catch {
    previous = null;
  }

  document.addEventListener('copy', onCopy, true);
  try {
    for (const type of ['mouseenter', 'mouseover', 'mousedown', 'mouseup']) {
      btn.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
    }
    btn.click();
    await new Promise((resolve) => setTimeout(resolve, 450));
    if (!copied.trim()) {
      try {
        copied = normalizeCodeText((await navigator.clipboard?.readText()) || '');
      } catch {
        copied = '';
      }
    }
  } finally {
    document.removeEventListener('copy', onCopy, true);
    if (previous != null && copied.trim() && copied !== previous) {
      try {
        await navigator.clipboard?.writeText(previous);
      } catch {
        // Clipboard restoration is best-effort; extraction must not fail here.
      }
    }
    restoreScroll();
  }

  return copied;
}

function findScrollableCodeElement(el: HTMLElement): HTMLElement {
  const preferred = el.matches('.code-block-content, .ace_scroller, .cm-scroller, .monaco-scrollable-element')
    ? el
    : el.querySelector<HTMLElement>('.code-block-content, .ace_scroller, .cm-scroller, .monaco-scrollable-element');
  if (preferred && preferred.scrollHeight > preferred.clientHeight + 8) return preferred;

  let best: HTMLElement = el;
  let bestScore = el.scrollHeight - el.clientHeight;
  for (const node of Array.from(el.querySelectorAll<HTMLElement>('*'))) {
    if (node.clientHeight < 24) continue;
    const score = node.scrollHeight - node.clientHeight;
    if (score <= Math.max(8, bestScore)) continue;
    const style = getComputedStyle(node);
    const marker = `${node.className || ''} ${node.getAttribute('class') || ''}`.toLowerCase();
    const looksScrollable =
      style.overflowY === 'auto' ||
      style.overflowY === 'scroll' ||
      style.overflowY === 'overlay' ||
      /scroll|scroller|code|content|editor/.test(marker);
    if (!looksScrollable) continue;
    best = node;
    bestScore = score;
  }
  return best;
}

function isCodeScroller(el: Element): boolean {
  return !!el.closest(
    [
      '.docx-code-block',
      '.code-block',
      '.ace_editor',
      '.cm-editor',
      '.monaco-editor',
      '[data-block-type="code"]',
      '[data-block-type="code_block"]',
      '[data-block-type="codeblock"]',
    ].join(', '),
  );
}

function findFeishuDocumentScroller(): HTMLElement {
  // 优先查找包含正文编辑器的滚动容器
  const editorContainer = document.querySelector<HTMLElement>(
    '.page-main-item.editor, .editor-container, .docx-page-block',
  );
  if (editorContainer) {
    // 向上查找最近的可滚动父元素
    let parent: HTMLElement | null = editorContainer;
    while (parent) {
      const oy = getComputedStyle(parent).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') {
        if (parent.scrollHeight > parent.clientHeight + 100) {
          return parent;
        }
      }
      parent = parent.parentElement;
    }
  }

  // 回退：选择 scrollHeight 最大的滚动容器，但排除侧边栏
  let best: HTMLElement =
    (document.scrollingElement as HTMLElement) || document.documentElement;
  let bestScore = best.scrollHeight - best.clientHeight;
  for (const el of Array.from(document.querySelectorAll<HTMLElement>('*'))) {
    if (isCodeScroller(el)) continue;
    if (el.clientHeight < 200) continue;
    // 排除明显的侧边栏容器（包含 "sidebar" 或 "tree" 类名）
    const cls = (el.className || '').toLowerCase();
    if (/sidebar|tree|nav|toc|directory/.test(cls)) continue;
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

async function captureScrollableCode(el: HTMLElement): Promise<string> {
  const copied = await tryCopyCodeText(el).catch(() => '');
  if (copied.trim()) return copied;

  const scroller = findScrollableCodeElement(el);
  const maxTop = () => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  if (scroller.scrollHeight <= scroller.clientHeight + 8) return feishuCodeText(el);

  const origTop = scroller.scrollTop;
  const rows = new Map<string, { y: number; text: string }>();
  const capture = () => {
    const base = scroller.scrollTop;
    for (const row of collectVisibleCodeLines(el)) {
      const key = `${Math.round(base + row.y)}:${row.text}`;
      if (!rows.has(key)) rows.set(key, { y: base + row.y, text: row.text });
    }
  };

  scroller.scrollTop = 0;
  await new Promise((resolve) => setTimeout(resolve, 180));
  capture();

  let guard = 0;
  let lastTop = -1;
  const step = Math.max(120, Math.floor(scroller.clientHeight * 0.75));
  while (scroller.scrollTop < maxTop() - 2 && guard++ < 1200) {
    scroller.scrollTop = Math.min(maxTop(), scroller.scrollTop + step);
    await new Promise((resolve) => setTimeout(resolve, 140));
    capture();
    if (scroller.scrollTop === lastTop) break;
    lastTop = scroller.scrollTop;
  }

  // Feishu code blocks often virtualize their tail. Force the exact bottom and
  // sample a few times so the final rows have time to enter the DOM.
  for (let i = 0; i < 4; i++) {
    scroller.scrollTop = maxTop();
    await new Promise((resolve) => setTimeout(resolve, 180));
    capture();
  }
  scroller.scrollTop = origTop;

  const ordered = [...rows.values()].sort((a, b) => a.y - b.y);
  const text = ordered.map((row) => row.text).join('\n');
  return text.trim() ? normalizeCodeText(text) : feishuCodeText(el);
}

interface FeishuFullCapture {
  html: string;
  boards: FeishuBoardCapture[];
  codes: FeishuCodeCapture[];
}

interface CapturedFeishuBlock {
  y: number;
  html: string;
  signature: string;
}

function feishuCapturedBlockSignature(sourceEl: HTMLElement): string {
  const clone = sourceEl.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll('button, svg, [aria-hidden="true"], [contenteditable="false"]')
    .forEach((n) => n.remove());
  const text = stripZeroWidth(clone.textContent || '').replace(/\s+/g, ' ').trim();
  const media = Array.from(clone.querySelectorAll<HTMLElement>('img, iframe, video, source'))
    .map((n) => n.getAttribute('src') || n.getAttribute('data-src') || n.getAttribute('srcset') || '')
    .filter(Boolean)
    .join('|');
  const sig = (text || media).replace(/\s+/g, ' ').trim();
  return sig.slice(0, 1600);
}

function dedupeCapturedFeishuBlocks(blocks: CapturedFeishuBlock[]): CapturedFeishuBlock[] {
  const kept: CapturedFeishuBlock[] = [];
  const recent: Array<{ signature: string; y: number; index: number }> = [];
  const exactSeen = new Set<string>();
  for (const block of blocks) {
    const sig = block.signature;
    let duplicated = false;
    let duplicateIndex = -1;
    if (sig.length >= 6) {
      if (sig.length >= 40 && exactSeen.has(sig)) {
        duplicated = true;
      }
      for (const prev of recent) {
        if (duplicated) break;
        if (sig === prev.signature) {
          duplicated = true;
          duplicateIndex = prev.index;
          break;
        }
        if (sig.length >= 30 && prev.signature.length >= sig.length && prev.signature.includes(sig)) {
          duplicated = true;
          duplicateIndex = prev.index;
          break;
        }
        if (prev.signature.length >= 6 && sig.length >= 30 && sig.startsWith(prev.signature)) {
          duplicated = true;
          duplicateIndex = prev.index;
          break;
        }
      }
    }
    if (duplicated) {
      const prev = duplicateIndex >= 0 ? kept[duplicateIndex] : undefined;
      if (prev && block.html.length > prev.html.length && sig.startsWith(prev.signature)) {
        prev.html = block.html;
        prev.signature = sig;
        prev.y = Math.min(prev.y, block.y);
        const recentPrev = recent.find((item) => item.index === duplicateIndex);
        if (recentPrev) {
          recentPrev.signature = sig;
          recentPrev.y = prev.y;
        }
      }
      continue;
    }
    kept.push(block);
    if (sig) {
      if (sig.length >= 40) exactSeen.add(sig);
      recent.push({ signature: sig, y: block.y, index: kept.length - 1 });
    }
    if (recent.length > 100) recent.shift();
  }
  return kept;
}

function feishuFullSourceElement(el: HTMLElement, root: HTMLElement): HTMLElement {
  const isMediaNode =
    /^(IMG|IFRAME|VIDEO|FIGURE)$/.test(el.tagName) ||
    !!el.querySelector('img, iframe, video');
  if (isMediaNode) {
    const ownerList = el.closest<HTMLElement>(LIST_SELECTOR);
    if (ownerList && ownerList !== root) return ownerList;
    const ownerBlock = el.closest<HTMLElement>('[data-block-id], [data-record-id]');
    if (ownerBlock && ownerBlock !== root && root.contains(ownerBlock)) {
      const kind = feishuBlockKind(ownerBlock);
      if (kind !== 'page') return ownerBlock;
    }
    return el;
  }

  let candidate: HTMLElement | null = el;
  let parentBlock = candidate.parentElement?.closest<HTMLElement>('[data-block-id]') || null;
  while (parentBlock && parentBlock !== root) {
    if (parentBlock.getAttribute('data-block-type') === 'page') break;
    candidate = parentBlock;
    parentBlock = candidate.parentElement?.closest<HTMLElement>('[data-block-id]') || null;
  }
  return candidate;
}

function feishuBlockKey(sourceEl: HTMLElement, leafEl: HTMLElement, y: number): string {
  const blockId =
    sourceEl.getAttribute('data-block-id') ||
    sourceEl.getAttribute('data-record-id') ||
    leafEl.getAttribute('data-block-id') ||
    leafEl.getAttribute('data-record-id') ||
    '';
  if (blockId) return blockId;

  const text = (sourceEl.textContent || '').trim();
  const media =
    /^(IMG|IFRAME|VIDEO)$/.test(sourceEl.tagName)
      ? sourceEl
      : sourceEl.querySelector('img, iframe, video');
  if (!text && media) {
    const src = media.getAttribute('src') || media.getAttribute('data-src') || sourceEl.outerHTML.slice(0, 120);
    return `media:${Math.round(y)}:${src}`;
  }
  return `${sourceEl.tagName}:${Math.round(y)}:${text.slice(0, 160)}`;
}

function visibleElementY(el: Element, base: number): number {
  return Math.round(base + el.getBoundingClientRect().top);
}

async function captureFeishuFullContentOnce(contentSelector?: string): Promise<FeishuFullCapture> {
  const mainScroller = findFeishuDocumentScroller();
  const picked = safeQueryElement(contentSelector);
  const tooBroad =
    !picked ||
    picked === document.body ||
    picked === document.documentElement ||
    picked.tagName === 'HTML' ||
    picked.tagName === 'BODY';
  const root: HTMLElement = tooBroad ? mainScroller : picked;
  const isWin =
    mainScroller === document.scrollingElement ||
    mainScroller === document.documentElement ||
    mainScroller === document.body;

  const getTop = () => (isWin ? window.scrollY : mainScroller.scrollTop);
  const setTop = (v: number) =>
    isWin ? window.scrollTo(0, v) : (mainScroller.scrollTop = v);
  const viewH = isWin ? window.innerHeight : mainScroller.clientHeight;
  const maxTop = () =>
    isWin
      ? document.scrollingElement!.scrollHeight - window.innerHeight
      : mainScroller.scrollHeight - mainScroller.clientHeight;

  const origX = window.scrollX;
  const origY = window.scrollY;
  const origTop = getTop();
  const blocks = new Map<string, CapturedFeishuBlock>();
  const boards: FeishuBoardCapture[] = [];
  const codes: FeishuCodeCapture[] = [];
  const seenBoards = new Set<string>();
  const seenCodes = new Set<string>();

  const captureBlocks = () => {
    const base = getTop();
    const nodes = root.querySelectorAll<HTMLElement>(FEISHU_FULL_BLOCK_SELECTOR);
    for (const el of Array.from(nodes)) {
      if (el.querySelector(FEISHU_FULL_BLOCK_SELECTOR)) continue;
      const sourceEl = feishuFullSourceElement(el, root);
      const text = (sourceEl.textContent || '').trim();
      const media =
        /^(IMG|IFRAME|VIDEO)$/.test(sourceEl.tagName)
          ? sourceEl
          : sourceEl.querySelector('img, iframe, video');
      if (!text && !media) continue;

      const y = visibleElementY(sourceEl, base);
      const key = feishuBlockKey(sourceEl, el, y);
      const outerHTML = sourceEl.outerHTML;
      const signature = feishuCapturedBlockSignature(sourceEl);
      const prev = blocks.get(key);
      if (!prev) {
        blocks.set(key, { y, html: outerHTML, signature });
      } else if (outerHTML.length > prev.html.length) {
        prev.y = Math.min(prev.y, y);
        prev.html = outerHTML;
        prev.signature = signature;
      } else {
        prev.y = Math.min(prev.y, y);
      }
    }
  };

  const captureVisuals = async () => {
    const base = getTop();
    const candidates = [
      ...Array.from(document.querySelectorAll<HTMLElement>(FEISHU_BOARD_SELECTOR)).map((el) => ({
        el,
        kind: 'board' as const,
        alt: '飞书画板',
      })),
      ...Array.from(document.querySelectorAll<HTMLElement>(FEISHU_ISV_SELECTOR)).map((el) => ({
        el,
        kind: 'isv' as const,
        alt: '飞书嵌入内容',
      })),
    ];
    for (const item of candidates) {
      if (!root.contains(item.el)) continue;
      if (item.kind === 'isv' && hasUsableImageSource(item.el)) continue;
      if (isLikelyLoadingVisualBlock(item.el)) continue;
      const recordId = item.el.getAttribute('data-record-id') || '';
      const blockId = item.el.getAttribute('data-block-id') || '';
      const y = visibleElementY(item.el, base);
      const key = recordId || blockId || `${item.kind}:${y}:${stripZeroWidth(item.el.textContent || '').slice(0, 60)}`;
      if (seenBoards.has(key) || boards.length >= 24) continue;
      const url = await captureFeishuVisualElement(item.el, getTop, setTop, maxTop).catch(() => null);
      if (!url) continue;
      seenBoards.add(key);
      boards.push({ recordId, blockId, index: boards.length, url, alt: item.alt, kind: item.kind });
    }
  };

  const captureCodes = async () => {
    const base = getTop();
    const hosts = outermostElements(
      Array.from(document.querySelectorAll(FEISHU_CODE_BLOCK_SELECTORS.join(', '))).map(feishuCodeHost),
    ) as HTMLElement[];
    for (const host of hosts) {
      if (!root.contains(host)) continue;
      const { recordId, blockId } = codeBlockId(host);
      const y = visibleElementY(host, base);
      const key = recordId || blockId || `code:${y}:${stripZeroWidth(host.textContent || '').slice(0, 80)}`;
      if (seenCodes.has(key) || codes.length >= 80) continue;
      seenCodes.add(key);
      const text = await captureScrollableCode(host).catch(() => feishuCodeText(host));
      if (!text.trim()) continue;
      codes.push({ recordId, blockId, index: codes.length, text, language: feishuCodeLanguage(host) });
    }
  };

  const captureCurrentScreen = async () => {
    captureBlocks();
    await captureVisuals();
    await captureCodes();
  };

  setTop(0);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await captureCurrentScreen();

  let guard = 0;
  let lastTop = -1;
  while (getTop() < maxTop() - 2 && guard++ < 3000) {
    setTop(getTop() + viewH * 0.8);
    await new Promise((resolve) => setTimeout(resolve, 220));
    await captureCurrentScreen();
    if (getTop() === lastTop) break;
    lastTop = getTop();
  }
  const tailTops = [
    Math.max(0, maxTop() - viewH * 0.55),
    Math.max(0, maxTop() - viewH * 0.25),
    maxTop(),
  ];
  for (const top of tailTops) {
    setTop(top);
    await new Promise((resolve) => setTimeout(resolve, 280));
    await captureCurrentScreen();
  }
  setTop(origTop);
  window.scrollTo(origX, origY);

  const ordered = dedupeCapturedFeishuBlocks([...blocks.values()].sort((a, b) => a.y - b.y));
  return {
    html: ordered.length ? `<div>${ordered.map((b) => b.html).join('\n')}</div>` : '',
    boards,
    codes,
  };
}

/**
 * 把飞书的视觉块 DOM 规整为语义 HTML，再交给 Turndown。
 * 飞书经常用 div + data-block-type 表示标题/引用/高亮块，不先规整就会被压成普通段落。
 */
function normalizeFeishuHtml(
  html: string,
  boards: FeishuBoardCapture[] = [],
  codes: FeishuCodeCapture[] = [],
): string {
  if (!html.trim()) return '';
  const doc = new DOMParser().parseFromString(`<div id="zj-feishu-root">${html}</div>`, 'text/html');
  const root = doc.querySelector('#zj-feishu-root');
  if (!root) return html;

  const fallbackBoards = Array.from(
    root.querySelectorAll(
      [
        '[data-block-type="whiteboard"]',
        '.docx-whiteboard-block',
        '[data-block-type="board"]',
        '.docx-board-block',
      ].join(', '),
    ),
  );
  const fallbackIsvs = Array.from(
    root.querySelectorAll(
      [
        '[data-block-type="isv"]',
        '.docx-isv-block',
      ].join(', '),
    ),
  );
  for (const board of boards) {
    const selector = board.recordId
      ? `[data-record-id="${CSS.escape(board.recordId)}"]`
      : board.blockId
        ? `[data-block-id="${CSS.escape(board.blockId)}"]`
        : '';
    const fallback = board.kind === 'isv' ? fallbackIsvs : fallbackBoards;
    const el = (selector ? root.querySelector(selector) : null) || fallback[board.index] || null;
    if (!el) continue;
    const img = doc.createElement('img');
    img.setAttribute('src', board.url);
    img.setAttribute('alt', board.alt || '飞书画板');
    el.replaceWith(img);
  }

  // Remaining ISV/mini-app blocks have no screenshot. Preserve an explicit
  // placeholder instead of silently dropping source content.
  root.querySelectorAll('[data-block-type="isv"], .docx-isv-block').forEach((n) => {
    const p = doc.createElement('p');
    p.textContent = '[飞书嵌入内容：未能截图]';
    n.replaceWith(p);
  });

  const codeByKey = new Map<string, FeishuCodeCapture>();
  for (const code of codes) {
    if (code.recordId) codeByKey.set(code.recordId, code);
    if (code.blockId) codeByKey.set(code.blockId, code);
    codeByKey.set(`index:${code.index}`, code);
    codeByKey.set(codeCaptureKey(code.recordId, code.blockId, code.index), code);
  }
  const codeBlocks = outermostElements(
    Array.from(root.querySelectorAll(FEISHU_CODE_BLOCK_SELECTORS.join(', '))).map(feishuCodeHost),
  );
  for (const [index, el] of codeBlocks.entries()) {
    if (!el.isConnected) continue;
    const { recordId, blockId } = codeBlockId(el);
    const captured =
      codeByKey.get(codeCaptureKey(recordId, blockId, index)) ||
      (recordId ? codeByKey.get(recordId) : undefined) ||
      (blockId ? codeByKey.get(blockId) : undefined) ||
      codeByKey.get(`index:${index}`);
    if (captured) {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      const lang = captured.language || feishuCodeLanguage(el);
      if (lang) code.setAttribute('class', `language-${lang}`);
      code.textContent = captured.text;
      pre.appendChild(code);
      el.replaceWith(pre);
    } else {
      replaceWithCodeBlock(el);
    }
  }

  normalizeFeishuTables(doc, root);
  normalizeFeishuLists(doc, root);

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
    if (/^code(?:_?block)?$/.test(kind) && el.tagName !== 'PRE') {
      replaceWithCodeBlock(el);
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

  let existingCodeText = normalizeCodePresenceText(root.textContent || '');
  for (const captured of codes) {
    const codeText = normalizeCodePresenceText(captured.text);
    if (!codeText || existingCodeText.includes(codeText)) continue;
    const pre = doc.createElement('pre');
    const code = doc.createElement('code');
    if (captured.language) code.setAttribute('class', `language-${captured.language}`);
    code.textContent = captured.text;
    pre.appendChild(code);
    root.appendChild(pre);
    existingCodeText = `${existingCodeText} ${codeText}`.trim();
  }

  return root.innerHTML;
}

function feishuHtmlToMarkdown(
  html: string,
  boards: FeishuBoardCapture[] = [],
  codes: FeishuCodeCapture[] = [],
): string {
  return htmlToMarkdown(normalizeFeishuHtml(html, boards, codes));
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
  const filtered: string[] = [];
  let inFence = false;
  for (const line of s.split('\n')) {
    if (/^```/.test(line.trim())) {
      inFence = !inFence;
      filtered.push(line);
      continue;
    }
    if (inFence) {
      filtered.push(line);
      continue;
    }
    const t = line.replace(/^[-*>\s]+/, '').trim();
    if (t.startsWith('[▶ 嵌入内容](')) {
      continue;
    }
    if (!t || !isFeishuJunk(t)) filtered.push(line);
  }
  s = filtered.join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

function markdownBlockSignature(block: string): string {
  return stripZeroWidth(block)
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '![img]')
    .replace(/\[\[[^|\]]+(?:\|[^\]]+)?\]\]/g, '[[img]]')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[ \t>*-]+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function meaningfulRepeatBlock(sig: string): boolean {
  if (/^!\[img\]/.test(sig) || /^\[\[img\]\]/.test(sig)) return true;
  return sig.length >= 8;
}

function dedupeFeishuMarkdownRepeats(md: string): string {
  const blocks = md
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean);
  if (blocks.length < 4) return md;

  const sigs = blocks.map(markdownBlockSignature);
  const removed = new Set<number>();
  const seen = new Map<string, number>();
  const maxRun = 8;

  // 第一遍：检测单个块的重复（非连续重复）
  const singleBlockSeen = new Map<string, number>();
  for (let i = 0; i < blocks.length; i++) {
    const sig = sigs[i];
    if (!meaningfulRepeatBlock(sig) || sig.length < 80) continue;
    const prevIndex = singleBlockSeen.get(sig);
    if (prevIndex !== undefined) {
      // 标记后出现的重复块为删除
      removed.add(i);
    } else {
      singleBlockSeen.set(sig, i);
    }
  }

  // 第二遍：检测连续重复块组
  for (let i = 0; i < blocks.length; i++) {
    if (removed.has(i) || !meaningfulRepeatBlock(sigs[i])) continue;

    let bestLen = 0;
    for (let len = Math.min(maxRun, blocks.length - i); len >= 2; len--) {
      const run = sigs.slice(i, i + len);
      if (run.some((sig) => !meaningfulRepeatBlock(sig))) continue;
      const total = run.reduce((sum, sig) => sum + sig.length, 0);
      if (total < 80) continue;
      const key = run.join('\n---\n');
      if (seen.has(key)) {
        bestLen = len;
        break;
      }
    }

    if (bestLen) {
      for (let j = i; j < i + bestLen; j++) removed.add(j);
      i += bestLen - 1;
      continue;
    }

    for (let len = 2; len <= Math.min(maxRun, blocks.length - i); len++) {
      const run = sigs.slice(i, i + len);
      if (run.some((sig) => !meaningfulRepeatBlock(sig))) continue;
      const total = run.reduce((sum, sig) => sum + sig.length, 0);
      if (total < 80) continue;
      const key = run.join('\n---\n');
      if (!seen.has(key)) seen.set(key, i);
    }
  }

  if (!removed.size) return md;
  return blocks.filter((_block, index) => !removed.has(index)).join('\n\n').trim();
}

function markdownListItem(line: string): { indent: number; text: string } | null {
  const m = line.match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.+)$/);
  if (!m) return null;
  return {
    indent: m[1].replace(/\t/g, '    ').length,
    text: m[2].trim(),
  };
}

function normalizeMarkdownListSubtree(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/!\[\[[^\]]+\]\]/g, '')
    .replace(/\[\[[^|\]]+(?:\|[^\]]+)?\]\]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[ \t]+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2400);
}

function dedupeFeishuListSubtrees(md: string): string {
  const lines = md.split('\n');
  const removed = new Set<number>();
  const seen = new Map<string, number>();

  for (let i = 0; i < lines.length; i++) {
    if (removed.has(i)) continue;
    const item = markdownListItem(lines[i]);
    if (!item || item.text.length < 6) continue;

    let end = i + 1;
    while (end < lines.length) {
      const next = markdownListItem(lines[end]);
      if (next && next.indent <= item.indent) break;
      end++;
    }
    if (end <= i + 1) continue;

    const subtree = lines.slice(i, end);
    const signature = normalizeMarkdownListSubtree(subtree);
    if (signature.length < 80) continue;
    const key = `${markdownBlockSignature(item.text)}:${signature}`;
    if (seen.has(key)) {
      for (let j = i; j < end; j++) removed.add(j);
      i = end - 1;
      continue;
    }
    seen.set(key, i);
  }

  if (!removed.size) return md;
  return lines.filter((_line, index) => !removed.has(index)).join('\n').replace(/\n{3,}/g, '\n\n').trim();
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

/** 全局图片 URL 去重：同一 URL 的图片只保留首次出现，删除后续重复
 *  解决 Grid 布局下同一图片在 Markdown 多个位置重复出现的问题 */
function dedupeImagesByGlobalUrl(md: string): string {
  const seen = new Set<string>();
  const lines = md.split('\n');
  const out: string[] = [];

  for (const line of lines) {
    const img = parseImgLine(line);
    if (img) {
      if (seen.has(img.url)) {
        continue; // 跳过已出现的图片（URL 相同）
      }
      seen.add(img.url);
    }
    out.push(line);
  }

  return out.join('\n');
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
    const urls = new Set([first.url]);
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
        if (!urls.has(img.url)) {
          group.push(img);
          urls.add(img.url);
        }
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
// 标题里可能混入的按钮文字（放在字符串里，避免中文进正则——内容脚本要求纯 ASCII）
const TITLE_TAIL_WORDS = ['分享', '编辑', '更多', '复制链接', '收藏'];

function feishuDocTitle(): string {
  const el = document.querySelector(
    [
      '#ssrHeaderTitle',
      '.note-title__input.disabled',
      '.note-title__input',
      '.wiki-suite-title',
      '.note-title__input-container',
      '.note-title',
    ].join(', '),
  );
  if (!el) return '';
  const clone = el.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('button, a, svg, [role="button"]').forEach((n) => n.remove());
  let t = stripZeroWidth(clone.textContent || '').replace(/\s+/g, ' ').trim();
  // 反复去掉尾部的按钮残留词（用字符串 endsWith，不用中文正则）
  for (let changed = true; changed; ) {
    changed = false;
    for (const w of TITLE_TAIL_WORDS) {
      if (t.endsWith(w)) {
        t = t.slice(0, -w.length).trim();
        changed = true;
      }
    }
  }
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
  const fromEl = cleanDocTitle(feishuDocTitle());
  const fromDocument = cleanDocTitle(document.title);
  const fromParsed = cleanDocTitle(parsedTitle);
  const suspicious =
    fromEl.length > 120 ||
    fromEl.includes('最近修改') ||
    (!!fromDocument && fromEl.length > fromDocument.length * 1.8);
  if (fromEl && !suspicious && !GENERIC_TITLES.has(fromEl.toLowerCase())) return fromEl;
  for (const c of [fromDocument, fromParsed, fromEl]) {
    if (c && !GENERIC_TITLES.has(c.toLowerCase())) return c;
  }
  return fromEl || fromParsed || fromDocument || '未命名';
}

async function extractFeishu(ctx: ExtractContext, sel: string): Promise<ExtractedPage> {
  await waitForFeishuTitle(); // 标题未加载完时（显示 Docs）先等一下，避免文件名取到占位
  const scopeSelector = scopedFeishuSelector(sel);
  const parsed = await parseWithSelector(ctx.url, scopeSelector || sel);
  const defuddleMd = cleanFeishuMarkdown(feishuHtmlToMarkdown(parsed.content || '', [], []));

  // 完整抓取：把滚动收集“限定在正文容器内”，排除目录/导航/侧栏/通知等
  let contentMarkdown = defuddleMd;
  if (ctx.fullCapture) {
    const scope = scopeSelector || scopedFeishuSelector(parsed.debug?.contentSelector || '');
    const full = await captureFeishuFullContentOnce(scope);
    const fullMd = dedupeFeishuMarkdownRepeats(
      cleanFeishuMarkdown(feishuHtmlToMarkdown(full.html, full.boards, full.codes)),
    );
    // Feishu's Defuddle result often includes comments, recommendations, and
    // footer UI. That noisy fallback can be longer than the scoped full capture,
    // so length is not a reliable quality signal here. In full-capture mode,
    // prefer the scoped result when it is substantive; it is the only path that
    // can replace virtualized code blocks with the separately collected text.
    if (fullMd.trim() && (full.codes.length || fullMd.length >= Math.max(80, defuddleMd.length * 0.25))) {
      contentMarkdown = fullMd;
    }
  }

  // 图片去重 + 并排图片：先全局去重（删除重复 URL），再并排合并（相邻图片合并成一行）
  contentMarkdown = dedupeImagesByGlobalUrl(contentMarkdown);
  contentMarkdown = groupInlineImages(contentMarkdown);
  contentMarkdown = dedupeFeishuListSubtrees(contentMarkdown);

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
