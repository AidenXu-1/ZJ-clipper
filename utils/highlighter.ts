// 兆基clipper —— 网页高亮：选区包裹 <mark>、文本引用锚定、按 URL 持久化与恢复
// 仅在内容脚本中使用（依赖 DOM 与 chrome.storage.local）

export interface Highlight {
  id: string;
  text: string; // 高亮文本
  prefix: string; // 前文上下文（用于消歧）
  suffix: string; // 后文上下文
  createdAt: number;
}

const CONTEXT_LEN = 30;
const HL_CLASS = 'zhaoji-clipper-hl';

// ---------- 存储（按页面 URL，忽略 hash）----------

function pageKey(prefix = 'zhaoji_clipper_hl'): string {
  const u = new URL(location.href);
  return `${prefix}:${u.origin}${u.pathname}${u.search}`;
}

export async function loadHighlights(): Promise<Highlight[]> {
  const k = pageKey();
  const legacy = pageKey('jicun_hl');
  const r = await chrome.storage.local.get([k, legacy]);
  const list = ((r[k] ?? r[legacy]) as Highlight[]) || [];
  if (!r[k] && r[legacy]) {
    await chrome.storage.local.set({ [k]: list });
  }
  return list;
}

export async function saveHighlights(list: Highlight[]): Promise<void> {
  await chrome.storage.local.set({ [pageKey()]: list });
}

// ---------- 文本索引：拼接正文文本 + 文本节点偏移表 ----------

interface TextIndex {
  text: string;
  segs: Array<{ node: Text; start: number }>; // 每个文本节点在全局文本中的起始偏移
}

function buildTextIndex(root: Node): TextIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(n) {
      const v = n.nodeValue;
      if (!v) return NodeFilter.FILTER_REJECT;
      const p = (n as Text).parentElement;
      if (!p) return NodeFilter.FILTER_REJECT;
      const tag = p.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT')
        return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let text = '';
  const segs: TextIndex['segs'] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) {
    const t = n as Text;
    segs.push({ node: t, start: text.length });
    text += t.nodeValue || '';
  }
  return { text, segs };
}

/** 全局偏移 → {文本节点, 节点内偏移} */
function locate(idx: TextIndex, offset: number): { node: Text; offset: number } | null {
  for (let i = idx.segs.length - 1; i >= 0; i--) {
    const s = idx.segs[i];
    if (offset >= s.start) {
      return { node: s.node, offset: offset - s.start };
    }
  }
  return null;
}

/** 某文本节点在全局文本中的起始偏移 */
function nodeGlobalStart(idx: TextIndex, node: Node): number {
  for (const s of idx.segs) if (s.node === node) return s.start;
  return -1;
}

// ---------- 包裹 / 取消包裹 ----------

/** 用 <mark> 包裹一个 Range（按文本节点切分，跨元素也可） */
function wrapRange(range: Range, id: string): boolean {
  const start = range.startContainer;
  const end = range.endContainer;
  // 收集 range 内的文本节点及其需要包裹的区间（先收集，后包裹，避免 DOM 变动影响）
  const targets: Array<{ node: Text; s: number; e: number }> = [];
  const root =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentNode!
      : range.commonAncestorContainer;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let n: Node | null;
  while ((n = walker.nextNode())) {
    if (!range.intersectsNode(n)) continue;
    const t = n as Text;
    const len = t.nodeValue?.length || 0;
    let s = 0;
    let e = len;
    if (t === start) s = range.startOffset;
    if (t === end) e = range.endOffset;
    if (s >= e) continue;
    targets.push({ node: t, s, e });
  }
  if (!targets.length) return false;
  for (const { node, s, e } of targets) {
    try {
      const r = document.createRange();
      r.setStart(node, s);
      r.setEnd(node, e);
      const mark = document.createElement('mark');
      mark.className = HL_CLASS;
      mark.dataset.jhl = id;
      r.surroundContents(mark);
    } catch {
      /* 跨元素边界等情况跳过该片段 */
    }
  }
  return true;
}

/** 移除某 id 的全部高亮标记（保留文本） */
export function unwrapHighlight(id: string): void {
  const marks = document.querySelectorAll<HTMLElement>(`mark.${HL_CLASS}[data-jhl="${id}"]`);
  for (const m of Array.from(marks)) {
    const parent = m.parentNode;
    if (!parent) continue;
    while (m.firstChild) parent.insertBefore(m.firstChild, m);
    parent.removeChild(m);
    parent.normalize();
  }
}

// ---------- 创建 / 恢复 ----------

function genId(): string {
  return `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** 高亮当前选区，返回锚定信息（失败返回 null） */
export function highlightSelection(): Highlight | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  const text = sel.toString();
  if (!text.trim()) return null;

  const idx = buildTextIndex(document.body);
  const startGlobal = nodeGlobalStart(idx, range.startContainer);
  let prefix = '';
  let suffix = '';
  if (startGlobal >= 0) {
    const gs = startGlobal + range.startOffset;
    prefix = idx.text.slice(Math.max(0, gs - CONTEXT_LEN), gs);
    suffix = idx.text.slice(gs + text.length, gs + text.length + CONTEXT_LEN);
  }
  const id = genId();
  if (!wrapRange(range, id)) return null;
  sel.removeAllRanges();
  return { id, text, prefix, suffix, createdAt: Date.now() };
}

function commonPrefixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}
function commonSuffixLen(a: string, b: string): number {
  let i = 0;
  while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/** 把一条已保存的高亮恢复到页面（文本引用锚定 + 上下文消歧） */
export function reapplyHighlight(hl: Highlight): boolean {
  // 已存在则跳过
  if (document.querySelector(`mark.${HL_CLASS}[data-jhl="${hl.id}"]`)) return true;
  const idx = buildTextIndex(document.body);
  if (!hl.text) return false;

  let best = -1;
  let bestScore = -1;
  let from = 0;
  for (;;) {
    const i = idx.text.indexOf(hl.text, from);
    if (i < 0) break;
    const pre = idx.text.slice(Math.max(0, i - CONTEXT_LEN), i);
    const suf = idx.text.slice(i + hl.text.length, i + hl.text.length + CONTEXT_LEN);
    const score = commonSuffixLen(pre, hl.prefix) + commonPrefixLen(suf, hl.suffix);
    if (score > bestScore) {
      bestScore = score;
      best = i;
    }
    from = i + 1;
  }
  if (best < 0) return false;

  const startPos = locate(idx, best);
  const endPos = locate(idx, best + hl.text.length);
  if (!startPos || !endPos) return false;
  const range = document.createRange();
  try {
    range.setStart(startPos.node, startPos.offset);
    range.setEnd(endPos.node, endPos.offset);
  } catch {
    return false;
  }
  return wrapRange(range, hl.id);
}

/** 注入高亮样式（每页一次） */
export function ensureHighlightStyle(): void {
  if (document.getElementById('zhaoji-clipper-hl-style')) return;
  const style = document.createElement('style');
  style.id = 'zhaoji-clipper-hl-style';
  style.textContent = `mark.${HL_CLASS}{background:#fff3a3;color:inherit;border-radius:2px;cursor:pointer;padding:0 1px;box-shadow:inset 0 -2px 0 #f4d03f;}`;
  (document.head || document.documentElement).appendChild(style);
}
