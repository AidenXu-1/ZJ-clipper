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
    const name = `${base}-${seq}${altFragment(alt)}.${mimeExt(mime)}`;
    try {
      await putBinary(restCfg, `${folder}/${name}`, base64ToBytes(base64), mime);
      map.set(url, name);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }

  const newNote = map.size
    ? note.replace(IMG_RE, (full, _alt, url) => {
        const name = map.get(url);
        return name ? `![[${name}]]` : full;
      })
    : note;
  return { note: newNote, saved: map.size, total: unique.length, lastError };
}
