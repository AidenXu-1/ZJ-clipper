// 兆基clipper —— 本地图片保存：解析正文图片 → 后台下载 → 存入仓库附件 → 改写为 ![[名]]
import { FetchImageResponse } from './types';
import { RestConfig, putBinary } from './rest';
import { safeName } from './filename';
import { isAuthGatedHost } from './hosts';

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/avif': 'avif',
};

function mimeExt(mime: string): string {
  return MIME_EXT[mime] || 'png';
}

/** 标题安全化并截断，作为图片名前缀；空标题回退为「图片」 */
function imageBase(title: string): string {
  const b = safeName((title || '').trim()).slice(0, 40).trim();
  return b || '图片';
}

/** alt/caption 片段：安全化、去多余符号、截断，供拼进文件名 */
function altFragment(alt: string): string {
  const a = safeName((alt || '').trim()).slice(0, 24).trim();
  return a ? `-${a}` : '';
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 视频嵌入用的 ![](url) 不是图片，跳过 */
function isVideoEmbed(u: string): boolean {
  return /(youtube\.com|youtu\.be|player\.bilibili\.com|bilibili\.com\/video|vimeo\.com)/.test(u);
}

// 并排图片在 alt 末尾带 Obsidian 原生宽度（如 "团购搜索|341" / "图|341x200"）。
// 下载改写成 ![[名|宽]] 时要保留，文件名里则要去掉。
function parseAltWidth(alt: string): string {
  const m = (alt || '').match(/\|(\d+(?:x\d+)?)\s*$/);
  return m ? m[1] : '';
}
function stripAltWidth(alt: string): string {
  return (alt || '').replace(/\|\d+(?:x\d+)?\s*$/, '');
}

/**
 * 该图片地址能否被 Obsidian 直接按链接预览。
 * 返回 true 表示「引用模式」下也必须下载到本地，否则裂图：
 * - blob: 仅在原页面上下文有效；
 * - 飞书/Lark 等需登录鉴权的域名。
 */
export function isUnreferenceable(url: string): boolean {
  if (!url) return false;
  if (url.startsWith('blob:')) return true;
  return isAuthGatedHost(url);
}

// 匹配 https:// 远程图与 blob: 就地图（blob 由内容脚本预解析为 base64 传入）
const IMG_RE = /!\[([^\]]*)\]\(((?:https?:\/\/|blob:)[^)\s]+)\)/g;

/**
 * 处理正文里的远程图片：下载并存入仓库附件，正文链接改写为 Obsidian 嵌入 ![[名]]。
 * 仅在 REST 保存方式下调用。返回改写后的正文。
 */
export interface ImageResult {
  note: string;
  saved: number;
  total: number;
  lastError: string;
}

export async function processNoteImages(
  note: string,
  title: string,
  targetFolder: string,
  restCfg: RestConfig,
  onProgress?: (done: number, total: number) => void,
  inlineImages: Array<{ url: string; base64: string; mime: string }> = [],
  // 仅下载满足该判定的图片；其余原样保留 ![](url)。下载模式不传=全部下载；
  // 引用模式传 isUnreferenceable=只下载飞书/blob 等无法被引用的图。
  urlFilter?: (url: string) => boolean,
): Promise<ImageResult> {
  const folder = (targetFolder || 'attachments').replace(/^\/+|\/+$/g, '');
  // blob: 等后台下不了的图，由内容脚本预解析为 base64 传进来，按 url 查表直接落盘
  const inlineMap = new Map(inlineImages.map((i) => [i.url, i]));

  // 按正文出现顺序收集图片（url + alt），跳过视频嵌入，按 url 去重保留首个 alt
  const items: Array<{ url: string; alt: string }> = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  IMG_RE.lastIndex = 0;
  while ((m = IMG_RE.exec(note))) {
    const alt = m[1];
    const url = m[2];
    if (isVideoEmbed(url) || seen.has(url)) continue;
    seen.add(url);
    if (urlFilter && !urlFilter(url)) continue; // 引用模式：只下载无法被引用的图，其余保留链接
    items.push({ url, alt });
  }
  const unique = items.slice(0, 40);
  if (!unique.length) return { note, saved: 0, total: 0, lastError: '' };

  const base = imageBase(title);
  const pad = unique.length >= 100 ? 3 : 2; // 序号位数随图片数自适应
  const map = new Map<string, string>(); // url -> 文件名
  let done = 0;
  let lastError = '';
  for (let i = 0; i < unique.length; i++) {
    const { url, alt } = unique[i];
    onProgress?.(++done, unique.length);
    let base64 = '';
    let mime = '';
    if (url.startsWith('blob:')) {
      // blob: 用内容脚本预解析好的 base64（后台无法 fetch）
      const inl = inlineMap.get(url);
      if (!inl) {
        lastError = 'blob 图未解析';
        continue;
      }
      base64 = inl.base64;
      mime = inl.mime;
    } else {
      const resp = (await chrome.runtime.sendMessage({
        type: 'ZHAOJI_CLIPPER_FETCH_IMAGE',
        url,
      })) as FetchImageResponse;
      if (!resp?.ok) {
        lastError = resp?.error || '下载失败';
        continue;
      }
      base64 = resp.base64;
      mime = resp.mime;
    }
    const seq = String(i + 1).padStart(pad, '0');
    const name = `${base}-${seq}${altFragment(stripAltWidth(alt))}.${mimeExt(mime)}`;
    try {
      await putBinary(restCfg, `${folder}/${name}`, base64ToBytes(base64), mime);
      map.set(url, name);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  const newNote = map.size
    ? note.replace(IMG_RE, (full, alt, url) => {
        const name = map.get(url);
        if (!name) return full;
        const w = parseAltWidth(alt); // 并排图保留宽度：![[名|宽]]
        return w ? `![[${name}|${w}]]` : `![[${name}]]`;
      })
    : note;
  return { note: newNote, saved: map.size, total: unique.length, lastError };
}

// ===== 飞书图片辅助（预留给未来的文档块写入方案，当前 Markdown 导入链路未接入）=====
// 收集正文里飞书服务端抓不到的图（飞书鉴权图/blob），供另行上传。
// 公网 http(s) 图保留 ![](url) 内联（飞书导入时服务端自行抓取）；鉴权/blob 图从正文移除、
// 取回字节交给上层追加进飞书文档。移除而非保留是为了避免导入时产生裂图。
export interface GatedImage {
  alt: string;
  base64: string;
  mime: string;
}

export interface GatedImagesResult {
  note: string;
  images: GatedImage[];
  lastError: string;
}

export async function collectGatedImages(
  note: string,
  inlineImages: Array<{ url: string; base64: string; mime: string }> = [],
  onProgress?: (done: number, total: number) => void,
): Promise<GatedImagesResult> {
  const inlineMap = new Map(inlineImages.map((i) => [i.url, i]));
  // 按出现顺序收集需上传的图（去重、跳过视频嵌入），保留首个 alt
  const items: Array<{ url: string; alt: string }> = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  IMG_RE.lastIndex = 0;
  while ((m = IMG_RE.exec(note))) {
    const alt = m[1];
    const url = m[2];
    if (isVideoEmbed(url) || seen.has(url)) continue;
    seen.add(url);
    if (!isUnreferenceable(url)) continue; // 公网图留在正文内联，飞书自行抓取
    items.push({ url, alt });
  }
  const unique = items.slice(0, 40);

  const gotBytes = new Map<string, GatedImage>(); // url -> 字节
  let lastError = '';
  for (let i = 0; i < unique.length; i++) {
    const { url, alt } = unique[i];
    onProgress?.(i + 1, unique.length);
    let base64 = '';
    let mime = '';
    if (url.startsWith('blob:')) {
      const inl = inlineMap.get(url);
      if (!inl) {
        lastError = 'blob 图未解析';
        continue;
      }
      base64 = inl.base64;
      mime = inl.mime;
    } else {
      const resp = (await chrome.runtime.sendMessage({
        type: 'ZHAOJI_CLIPPER_FETCH_IMAGE',
        url,
      })) as FetchImageResponse;
      if (!resp?.ok) {
        lastError = resp?.error || '下载失败';
        continue;
      }
      base64 = resp.base64;
      mime = resp.mime;
    }
    gotBytes.set(url, { alt: stripAltWidth(alt), base64, mime });
  }

  // 从正文移除已收集（及收集失败）的鉴权/blob 图链接，避免导入裂图
  const gatedUrls = new Set(unique.map((u) => u.url));
  const newNote = note.replace(IMG_RE, (full, _alt, url) => (gatedUrls.has(url) ? '' : full));
  return { note: newNote, images: [...gotBytes.values()], lastError };
}

// 飞书文档块写入预留：按 url 取回正文里全部图片的字节。当前 saveToFeishu 走
// Markdown 导入，尚未按文档块逐张插入图片。
export async function collectAllImages(
  note: string,
  inlineImages: Array<{ url: string; base64: string; mime: string }> = [],
  onProgress?: (done: number, total: number) => void,
): Promise<{ images: GatedImage2[]; lastError: string }> {
  const inlineMap = new Map(inlineImages.map((i) => [i.url, i]));
  const urls: string[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  IMG_RE.lastIndex = 0;
  while ((m = IMG_RE.exec(note))) {
    const url = m[2];
    if (isVideoEmbed(url) || seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
  }
  const unique = urls.slice(0, 40);
  const out: GatedImage2[] = [];
  let lastError = '';
  for (let i = 0; i < unique.length; i++) {
    const url = unique[i];
    onProgress?.(i + 1, unique.length);
    if (url.startsWith('blob:')) {
      const inl = inlineMap.get(url);
      if (!inl) {
        lastError = 'blob 图未解析';
        continue;
      }
      out.push({ url, base64: inl.base64, mime: inl.mime });
    } else {
      const resp = (await chrome.runtime.sendMessage({
        type: 'ZHAOJI_CLIPPER_FETCH_IMAGE',
        url,
      })) as FetchImageResponse;
      if (!resp?.ok) {
        lastError = resp?.error || '下载失败';
        continue;
      }
      out.push({ url, base64: resp.base64, mime: resp.mime });
    }
  }
  return { images: out, lastError };
}

/** 飞书图片字节（按 url 关联） */
export interface GatedImage2 {
  url: string;
  base64: string;
  mime: string;
}

// ===== 并排图的「每图下方居中图注」：把 markdown 嵌入行转成 HTML 弹性布局 =====
// 触发条件：一行有 2+ 张本地嵌入 ![[名|宽]]，且紧随一行斜体图注 *a*  *b*。
// 仅当图片与笔记同文件夹（folderPerClip）时用相对路径 src，可移植、不依赖绝对路径。
const EMBED_ROW = /^(?:!\[\[[^\]]+\]\]\s*)+$/;
const EMBED_ONE = /!\[\[([^\]|]+?)(?:\|\d+)?\]\]/g;
const CAPTION_ROW = /^(?:\*[^*]+\*\s*)+$/;
const CAPTION_ONE = /\*([^*]+)\*/g;

function buildHtmlImageRow(names: string[], caps: string[]): string {
  const width = Math.max(1, Math.floor(100 / names.length) - 2);
  const items = names
    .map((name, idx) => {
      const src = name.replace(/ /g, '%20'); // 相对路径，仅转义空格（中文可原样）
      const cap = (caps[idx] || '').trim();
      const capDiv = cap
        ? `<div style="font-weight:bold;font-size:12.5px;line-height:1.3;margin-top:4px;">${cap}</div>`
        : '';
      return `<div style="width:${width}%;text-align:center;"><img src="${src}" style="width:100%;"/>${capDiv}</div>`;
    })
    .join('');
  return `<div style="display:flex;flex-wrap:wrap;gap:10px;">${items}</div>`;
}

/**
 * 把「并排嵌入行 + 斜体图注行」转成 HTML，使图注居中显示在每张图正下方（可移植）。
 * coLocated=false（图片与笔记不在同一文件夹）时原样返回，避免相对路径失效。
 */
export function inlineImageRowsToHtml(note: string, coLocated: boolean): string {
  if (!coLocated) return note;
  const lines = note.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (EMBED_ROW.test(line)) {
      const names: string[] = [];
      let m: RegExpExecArray | null;
      EMBED_ONE.lastIndex = 0;
      while ((m = EMBED_ONE.exec(line))) names.push(m[1].trim());
      if (names.length >= 2) {
        let k = i + 1;
        while (k < lines.length && lines[k].trim() === '') k++;
        const capLine = k < lines.length ? lines[k].trim() : '';
        if (CAPTION_ROW.test(capLine)) {
          const caps: string[] = [];
          let c: RegExpExecArray | null;
          CAPTION_ONE.lastIndex = 0;
          while ((c = CAPTION_ONE.exec(capLine))) caps.push(c[1]);
          out.push(buildHtmlImageRow(names, caps));
          i = k; // 吞掉图注行
          continue;
        }
      }
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}
