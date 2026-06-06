// 兆基clipper —— B站专用提取器（Defuddle 无 B站 extractor，自建：嵌入播放器 + 元数据 + 简介 + 字幕）
// 注：本模块会被打进 content.js，受 ASCII 约束 —— 正则字面量里禁止出现中文/零宽字符。
import { ClipStats, ExtractedPage } from '@/utils/types';
import {
  ExtractContext,
  SiteExtractor,
  cleanTags,
  metaContent,
  readInitialState,
} from '@/utils/extract-core';

/** 从页面 script 标签里读取 window.__INITIAL_STATE__（内容脚本读 DOM 文本，绕过隔离世界） */
function readBiliState(): any | null {
  return readInitialState('window.__INITIAL_STATE__');
}

function fmtSec(sec: number): string {
  const s = Math.floor(sec || 0);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
}

function unixToDate(unix: number): string {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 带登录态请求 B站 API。no-store 强制绕过浏览器 HTTP 缓存（字幕接口偶发脏缓存串台） */
async function biliApiGet(path: string): Promise<any | null> {
  try {
    const r = await fetch(`https://api.bilibili.com${path}`, {
      credentials: 'include',
      cache: 'no-store',
    });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  }
}

// ===== wbi 签名（B站新接口要求）=====
// 注：所有正则均为纯 ASCII，置换表为数字，符合 content.js 的 ASCII 约束。
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
];

let wbiKeysCache: { img: string; sub: string; ts: number } | null = null;

/** 从 .../wbi/<key>.png 的 URL 中取出 <key>（用字符串操作，不用正则） */
function wbiKeyFromUrl(u: string): string {
  const base = u.slice(u.lastIndexOf('/') + 1);
  const dot = base.indexOf('.');
  return dot >= 0 ? base.slice(0, dot) : base;
}

/** 取 wbi 的 img_key/sub_key（来自 nav，游客也返回），按小时缓存避免每次剪藏都打 nav */
async function getWbiKeys(): Promise<{ img: string; sub: string } | null> {
  const now = Date.now();
  if (wbiKeysCache && now - wbiKeysCache.ts < 3600_000) {
    return { img: wbiKeysCache.img, sub: wbiKeysCache.sub };
  }
  const j = await biliApiGet('/x/web-interface/nav');
  const wi = j?.data?.wbi_img;
  const img = wbiKeyFromUrl(wi?.img_url || '');
  const sub = wbiKeyFromUrl(wi?.sub_url || '');
  if (!img || !sub) return null;
  wbiKeysCache = { img, sub, ts: now };
  return { img, sub };
}

/** img_key+sub_key 按置换表重排取前 32 位 → mixin_key */
function getMixinKey(orig: string): string {
  let s = '';
  for (let i = 0; i < 32; i++) s += orig.charAt(MIXIN_KEY_ENC_TAB[i]);
  return s;
}

/** 给参数加 wts、排序、附 mixin_key、MD5 → w_rid，返回已签名 query 串 */
function encWbi(params: Record<string, string>, imgKey: string, subKey: string): string {
  const mixin = getMixinKey(imgKey + subKey);
  const wts = Math.round(Date.now() / 1000);
  const q: Record<string, string> = { ...params, wts: String(wts) };
  const query = Object.keys(q)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(q[k].replace(/[!'()*]/g, ''))}`)
    .join('&');
  return `${query}&w_rid=${md5(query + mixin)}&wts=${wts}`;
}

async function signWbiQuery(params: Record<string, string>): Promise<string> {
  const keys = await getWbiKeys();
  return keys ? encWbi(params, keys.img, keys.sub) : '';
}

// 内联 MD5（Web Crypto 不支持 MD5）。Joseph Myers 紧凑实现，纯 ASCII。
function md5(str: string): string {
  return hex(md51(unescape(encodeURIComponent(str))));
}
function md51(s: string): number[] {
  const n = s.length;
  const state = [1732584193, -271733879, -1732584194, 271733878];
  let i;
  for (i = 64; i <= n; i += 64) md5cycle(state, md5blk(s.substring(i - 64, i)));
  s = s.substring(i - 64);
  const tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (i = 0; i < s.length; i++) tail[i >> 2] |= s.charCodeAt(i) << ((i % 4) << 3);
  tail[i >> 2] |= 0x80 << ((i % 4) << 3);
  if (i > 55) {
    md5cycle(state, tail);
    for (i = 0; i < 16; i++) tail[i] = 0;
  }
  tail[14] = n * 8;
  md5cycle(state, tail);
  return state;
}
function md5blk(s: string): number[] {
  const m: number[] = [];
  for (let i = 0; i < 64; i += 4)
    m[i >> 2] =
      s.charCodeAt(i) +
      (s.charCodeAt(i + 1) << 8) +
      (s.charCodeAt(i + 2) << 16) +
      (s.charCodeAt(i + 3) << 24);
  return m;
}
function add32(a: number, b: number): number {
  return (a + b) & 0xffffffff;
}
function cmn(q: number, a: number, b: number, x: number, s: number, t: number): number {
  a = add32(add32(a, q), add32(x, t));
  return add32((a << s) | (a >>> (32 - s)), b);
}
function ff(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return cmn((b & c) | (~b & d), a, b, x, s, t);
}
function gg(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return cmn((b & d) | (c & ~d), a, b, x, s, t);
}
function hh(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return cmn(b ^ c ^ d, a, b, x, s, t);
}
function ii(a: number, b: number, c: number, d: number, x: number, s: number, t: number) {
  return cmn(c ^ (b | ~d), a, b, x, s, t);
}
function md5cycle(x: number[], k: number[]) {
  let a = x[0], b = x[1], c = x[2], d = x[3];
  a = ff(a, b, c, d, k[0], 7, -680876936);
  d = ff(d, a, b, c, k[1], 12, -389564586);
  c = ff(c, d, a, b, k[2], 17, 606105819);
  b = ff(b, c, d, a, k[3], 22, -1044525330);
  a = ff(a, b, c, d, k[4], 7, -176418897);
  d = ff(d, a, b, c, k[5], 12, 1200080426);
  c = ff(c, d, a, b, k[6], 17, -1473231341);
  b = ff(b, c, d, a, k[7], 22, -45705983);
  a = ff(a, b, c, d, k[8], 7, 1770035416);
  d = ff(d, a, b, c, k[9], 12, -1958414417);
  c = ff(c, d, a, b, k[10], 17, -42063);
  b = ff(b, c, d, a, k[11], 22, -1990404162);
  a = ff(a, b, c, d, k[12], 7, 1804603682);
  d = ff(d, a, b, c, k[13], 12, -40341101);
  c = ff(c, d, a, b, k[14], 17, -1502002290);
  b = ff(b, c, d, a, k[15], 22, 1236535329);
  a = gg(a, b, c, d, k[1], 5, -165796510);
  d = gg(d, a, b, c, k[6], 9, -1069501632);
  c = gg(c, d, a, b, k[11], 14, 643717713);
  b = gg(b, c, d, a, k[0], 20, -373897302);
  a = gg(a, b, c, d, k[5], 5, -701558691);
  d = gg(d, a, b, c, k[10], 9, 38016083);
  c = gg(c, d, a, b, k[15], 14, -660478335);
  b = gg(b, c, d, a, k[4], 20, -405537848);
  a = gg(a, b, c, d, k[9], 5, 568446438);
  d = gg(d, a, b, c, k[14], 9, -1019803690);
  c = gg(c, d, a, b, k[3], 14, -187363961);
  b = gg(b, c, d, a, k[8], 20, 1163531501);
  a = gg(a, b, c, d, k[13], 5, -1444681467);
  d = gg(d, a, b, c, k[2], 9, -51403784);
  c = gg(c, d, a, b, k[7], 14, 1735328473);
  b = gg(b, c, d, a, k[12], 20, -1926607734);
  a = hh(a, b, c, d, k[5], 4, -378558);
  d = hh(d, a, b, c, k[8], 11, -2022574463);
  c = hh(c, d, a, b, k[11], 16, 1839030562);
  b = hh(b, c, d, a, k[14], 23, -35309556);
  a = hh(a, b, c, d, k[1], 4, -1530992060);
  d = hh(d, a, b, c, k[4], 11, 1272893353);
  c = hh(c, d, a, b, k[7], 16, -155497632);
  b = hh(b, c, d, a, k[10], 23, -1094730640);
  a = hh(a, b, c, d, k[13], 4, 681279174);
  d = hh(d, a, b, c, k[0], 11, -358537222);
  c = hh(c, d, a, b, k[3], 16, -722521979);
  b = hh(b, c, d, a, k[6], 23, 76029189);
  a = hh(a, b, c, d, k[9], 4, -640364487);
  d = hh(d, a, b, c, k[12], 11, -421815835);
  c = hh(c, d, a, b, k[15], 16, 530742520);
  b = hh(b, c, d, a, k[2], 23, -995338651);
  a = ii(a, b, c, d, k[0], 6, -198630844);
  d = ii(d, a, b, c, k[7], 10, 1126891415);
  c = ii(c, d, a, b, k[14], 15, -1416354905);
  b = ii(b, c, d, a, k[5], 21, -57434055);
  a = ii(a, b, c, d, k[12], 6, 1700485571);
  d = ii(d, a, b, c, k[3], 10, -1894986606);
  c = ii(c, d, a, b, k[10], 15, -1051523);
  b = ii(b, c, d, a, k[1], 21, -2054922799);
  a = ii(a, b, c, d, k[8], 6, 1873313359);
  d = ii(d, a, b, c, k[15], 10, -30611744);
  c = ii(c, d, a, b, k[6], 15, -1560198380);
  b = ii(b, c, d, a, k[13], 21, 1309151649);
  a = ii(a, b, c, d, k[4], 6, -145523070);
  d = ii(d, a, b, c, k[11], 10, -1120210379);
  c = ii(c, d, a, b, k[2], 15, 718787259);
  b = ii(b, c, d, a, k[9], 21, -343485551);
  x[0] = add32(a, x[0]);
  x[1] = add32(b, x[1]);
  x[2] = add32(c, x[2]);
  x[3] = add32(d, x[3]);
}
function rhex(n: number): string {
  const hexChr = '0123456789abcdef';
  let s = '';
  for (let j = 0; j < 4; j++)
    s += hexChr.charAt((n >> (j * 8 + 4)) & 0x0f) + hexChr.charAt((n >> (j * 8)) & 0x0f);
  return s;
}
function hex(x: number[]): string {
  return x.map(rhex).join('');
}
// ===== wbi 签名结束 =====

/** 从 player 接口取字幕轨列表 */
async function playerSubs(path: string): Promise<Array<{ lan?: string; subtitle_url?: string }>> {
  const j = await biliApiGet(path);
  return j?.data?.subtitle?.subtitles || [];
}

// 上一次字幕抓取的过程录像（🔧 诊断回看用）
let lastSubtitleTrace = '';

type SubTrack = { lan?: string; subtitle_url?: string };

/** 优先中文字幕轨，避免误取到其它语言/无关轨 */
function pickTrack(subs: SubTrack[]): SubTrack | null {
  return subs.find((s) => /^zh|^ai-zh|zh-/i.test(s.lan || '')) || subs[0] || null;
}

/**
 * 校验字幕是否属于当前 cid。B站 AI 字幕 URL 路径形如 /bfs/ai_subtitle/prod/{aid}{cid}...，
 * 含 cid 可核对；普通上传字幕是 /bfs/subtitle/{hash}.json 不含 cid，无法核对 → 默认放行。
 * 返回 false 即"串台"（接口对正确 cid 返回了别的视频字幕，B站脏缓存所致）。
 */
function subtitleMatchesCid(su: string, cid: number): boolean {
  const path = (su || '').split('?')[0];
  if (path.indexOf('ai_subtitle') < 0) return true; // 非 AI 字幕，URL 是 hash，无从核对
  return String(cid).length >= 6 && path.indexOf(String(cid)) >= 0;
}

/** 拉取 B站字幕（best-effort，需视频有字幕且已登录）。带 cid 校验 + 串台重试 + 拒收保底 */
async function fetchBiliSubtitle(aid: number, cid: number, bvid: string): Promise<string> {
  const dbg: string[] = [`req aid:${aid} cid:${cid}`];
  const trace = (su: string, via: string) => {
    const path = (su || '').split('?')[0];
    const ok = subtitleMatchesCid(su, cid);
    dbg.push(`via:${via} cidInUrl:${ok ? 'YES' : 'NO'} path:${path.slice(-80)}`);
    return ok;
  };
  try {
    // 主路径：旧接口（多数视频可用）
    let subs = await playerSubs(`/x/player/v2?aid=${aid}&cid=${cid}&bvid=${bvid}`);
    let track = pickTrack(subs);
    let via = 'v2';
    dbg.push(`v2 tracks:${subs.length} langs:${subs.map((s) => s.lan || '?').join('/')}`);
    let matched = track ? trace(track.subtitle_url || '', 'v2') : true;

    // 触发 wbi 重试的两种情况：v2 无轨；或 v2 串台(cid 不匹配)。
    // wbi 是不同 endpoint(/x/player/wbi/v2)，URL 不同 → 绕开 v2 的脏缓存键，多半能拿到正确字幕。
    if (!subs.length || !matched) {
      const signed = await signWbiQuery({ aid: String(aid), cid: String(cid), bvid });
      if (signed) {
        const wbiSubs = await playerSubs(`/x/player/wbi/v2?${signed}`);
        const wbiTrack = pickTrack(wbiSubs);
        dbg.push(`wbi tracks:${wbiSubs.length} langs:${wbiSubs.map((s) => s.lan || '?').join('/')}`);
        if (wbiTrack) {
          const wbiOk = trace(wbiTrack.subtitle_url || '', 'wbi');
          // wbi 结果不串台、或原本 v2 就无轨 → 采用 wbi
          if (wbiOk || !subs.length) {
            subs = wbiSubs;
            track = wbiTrack;
            via = 'wbi';
            matched = wbiOk;
          }
        }
      }
    }

    if (!track) {
      lastSubtitleTrace = `${dbg.join(' | ')} | no-tracks`;
      return '';
    }
    // 保底：两条路都串台 → 拒收，宁可没字幕也绝不静默存错字幕
    if (!matched) {
      lastSubtitleTrace = `${dbg.join(' | ')} | REJECTED-cid-mismatch(防串台)`;
      return '';
    }
    let su = track.subtitle_url || '';
    if (!su) {
      lastSubtitleTrace = `${dbg.join(' | ')} | empty-url`;
      return '';
    }
    if (su.startsWith('//')) su = `https:${su}`;
    const sr = await fetch(su, { cache: 'no-store' });
    const sj = await sr.json();
    const body: Array<{ from: number; content: string }> = sj?.body || [];
    dbg.push(`adopt:${via} body:${body.length}`);
    lastSubtitleTrace = dbg.join(' | ');
    if (!body.length) return '';
    // 时间与文字之间留一个空格；两个尾随空格 + 换行 = Markdown 硬换行，每条独占一行
    const lines = body.map((seg) => `${fmtSec(seg.from)} ${(seg.content || '').trim()}`);
    return `\n\n## 字幕\n\n${lines.join('  \n')}\n`;
  } catch (e) {
    lastSubtitleTrace = `${dbg.join(' | ')} | err:${e instanceof Error ? e.message : String(e)}`;
    return '';
  }
}

/** 从 location.href 解析当前 bvid */
function currentBvid(): string {
  const m = location.href.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/);
  return m ? m[1] : '';
}

// 上一次真实剪藏时刻的信号录像（🔧 诊断回看用）。因为 🔧 总在页面 settle 后才跑、
// 抓不到串台瞬间，所以在真实剪藏的那一刻把所有候选信号录下来。
let lastBiliResolveTrace = '';

/** 同步快照各候选「当前视频」信号，用于判断切视频时哪个信号跟随播放器 */
function biliSnapshot(): string {
  const onPageTitle = (
    document.querySelector('.video-info-title-inner')?.textContent ||
    document.querySelector('.video-info-title')?.textContent ||
    ''
  )
    .trim()
    .slice(0, 36);
  const onPageMeta = (document.querySelector('.video-info-meta')?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  const vsrc = (document.querySelector('video')?.getAttribute('src') || '(none)').slice(0, 46);
  return (
    `urlBvid:${currentBvid()} | docTitle:${document.title.slice(0, 26)} | ` +
    `onPageTitle:${onPageTitle} | meta:${onPageMeta} | video:${vsrc}`
  );
}

/**
 * 解析当前 B站视频：从 location.href 取 bvid，再查官方 view API 拿可靠的 aid/cid/元数据。
 * 注：诊断证实切视频时 URL 与 view 数据始终自洽（id 解析层无串台），故直接读取即可。
 */
async function resolveBiliVideo(): Promise<{ bvid: string; apiData: any } | null> {
  const bvid = currentBvid();
  if (!bvid) return null;
  const apiData = (await biliApiGet(`/x/web-interface/view?bvid=${bvid}`))?.data;
  return { bvid, apiData: apiData || null };
}

/** B站视频页 → 自建提取（嵌入播放器 + 元数据 + 简介 + 字幕） */
async function tryBilibili(ctx: ExtractContext): Promise<ExtractedPage | null> {
  if (!/bilibili\.com\/video\/BV[0-9A-Za-z]+/.test(ctx.url)) return null;

  // 录像：抓取触发瞬间（settle 前）的信号快照
  const snapBefore = biliSnapshot();
  // 解析当前视频并等 URL 追平 SPA 导航（防抓到上一个视频字幕）
  const resolved = await resolveBiliVideo();
  if (!resolved) {
    lastBiliResolveTrace = `before-resolve: ${snapBefore}\nresolve=null`;
    return null;
  }
  const bvid = resolved.bvid;
  const apiData = resolved.apiData;
  // 失败再退回 __INITIAL_STATE__ / og 标签（仅作元数据兜底）
  const stateVd = readBiliState()?.videoData;
  // ids 只信任经 document.title 校验过的 view API 数据
  const idsTrusted = apiData?.bvid === bvid;
  const vd =
    apiData?.bvid === bvid ? apiData : stateVd?.bvid === bvid ? stateVd : apiData || {};
  // 去掉 og:title 的站点后缀（用字符串而非正则，避免中文进入正则字面量破坏 ASCII 打包）
  let ogTitle = metaContent('og:title').trim();
  const sufIdx = ogTitle.indexOf('_哔哩哔哩');
  if (sufIdx > 0) ogTitle = ogTitle.slice(0, sufIdx);
  const title: string = vd.title || ogTitle || document.title || bvid;
  const author: string = vd.owner?.name || metaContent('author') || '';
  const published = unixToDate(vd.pubdate);
  const desc: string =
    (typeof vd.desc === 'string' && vd.desc.trim()) || metaContent('og:description') || '';
  let cover: string = vd.pic || metaContent('og:image') || '';
  if (cover.startsWith('//')) cover = `https:${cover}`;
  const watch = `https://www.bilibili.com/video/${bvid}`;

  // 当前分P：取 URL 的 ?p=N，再从 pages 里取该分P的 cid（多P视频不会错位）
  const p = parseInt(new URLSearchParams(location.search).get('p') || '1', 10) || 1;
  const pages: Array<{ cid: number }> = Array.isArray(vd.pages) ? vd.pages : [];
  const aid: number | undefined = idsTrusted ? vd.aid : undefined;
  const cid: number | undefined = idsTrusted ? pages[p - 1]?.cid || vd.cid : undefined;

  // 关键：用 https://（Obsidian app:// 环境下 // 会坏掉），带 aid+cid+当前分P
  const src =
    `https://player.bilibili.com/player.html?bvid=${bvid}` +
    (aid ? `&aid=${aid}` : '') +
    (cid ? `&cid=${cid}` : '') +
    `&p=${p}&high_quality=1&danmaku=0&autoplay=0`;
  const embed =
    `<iframe src="${src}" width="100%" height="500" ` +
    `scrolling="no" frameborder="no" allowfullscreen="true"></iframe>`;

  // 互动数据：view API 响应里已带 stat（零新请求、零风险），归一化为数字写入 frontmatter
  const stat = vd.stat || {};
  const stats: ClipStats = {};
  if (typeof stat.view === 'number') stats.views = stat.view;
  if (typeof stat.like === 'number') stats.likes = stat.like;
  if (typeof stat.coin === 'number') stats.coins = stat.coin;
  if (typeof stat.favorite === 'number') stats.collects = stat.favorite;
  if (typeof stat.reply === 'number') stats.comments = stat.reply;
  if (typeof stat.share === 'number') stats.shares = stat.share;
  if (typeof stat.danmaku === 'number') stats.danmaku = stat.danmaku;

  const parts: string[] = [embed];
  if (desc) parts.push(`## 简介\n\n${desc}`);
  let content = parts.join('\n\n');

  let subBlock = '';
  if (aid && cid) {
    subBlock = await fetchBiliSubtitle(aid, cid, bvid);
    content += subBlock;
  }

  // 页面自带视频标签（DOM，view API 的 data 不含 tag）；纯提取。
  // 只取内容标签 .not-btn-tag，排除「科技猎手」等活动入口标签（带箭头的 btn 类）。
  const tags = cleanTags(
    Array.from(document.querySelectorAll('.video-tag-container .tag.not-btn-tag')).map(
      (e) => e.textContent || '',
    ),
  );

  // 录像：把抓取瞬间 + settle 后 + 最终采用的 ids + 字幕首行存起来，供 🔧 回看
  const subFirst = subBlock.split('\n').find((l) => /^\d/.test(l.trim())) || '(无字幕行)';
  lastBiliResolveTrace = [
    `before-resolve: ${snapBefore}`,
    `after-resolve : ${biliSnapshot()}`,
    `采用: bvid:${bvid} aid:${aid} cid:${cid} idsTrusted:${idsTrusted} p:${p}`,
    `字幕首行: ${subFirst.trim().slice(0, 50)}`,
    `字幕过程: ${lastSubtitleTrace}`,
  ].join('\n');

  return {
    title,
    author,
    published,
    description: desc,
    site: '哔哩哔哩',
    domain: 'bilibili.com',
    url: watch,
    image: cover,
    contentMarkdown: content,
    selectionMarkdown: '',
    wordCount: 0,
    highlights: ctx.highlights,
    stats,
    tags: tags.length ? tags : undefined,
  };
}

/**
 * B站专用 id 解析诊断：把各个数据源的 bvid/title/aid/cid 并排列出，
 * 用来定位「抓到别的视频字幕」是哪个源串台（URL / view API / __INITIAL_STATE__）。
 */
export async function diagnoseBili(): Promise<string> {
  const m = location.href.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/);
  if (!m) return '';
  const out: string[] = ['--- B站 id 解析诊断 ---'];
  const urlBvid = m[1];
  // 同步快照：在任何 await 前读，反映点击诊断的瞬间。
  // 目的：找出切视频时哪个 DOM 信号真正跟随播放器（已证实 URL+document.title 会一起滞后）。
  const onPageTitle = (
    document.querySelector('.video-info-title-inner')?.textContent ||
    document.querySelector('.video-info-title')?.textContent ||
    ''
  ).trim();
  const onPageMeta = (document.querySelector('.video-info-meta')?.textContent || '').trim();
  const upName = (document.querySelector('.up-info-container')?.textContent || '').trim().slice(0, 30);
  const videoSrc = document.querySelector('video')?.getAttribute('src') || '(none)';
  out.push(`URL bvid: ${urlBvid}`);
  out.push(`document.title: ${document.title}`);
  out.push(`on-page title (.video-info-title): ${onPageTitle}`);
  out.push(`on-page meta (.video-info-meta): ${onPageMeta}`);
  out.push(`up name (.up-info-container): ${upName}`);
  out.push(`<video> src: ${videoSrc}`);
  out.push(`og:title: ${metaContent('og:title')}`);
  out.push(`og:url: ${metaContent('og:url')}`);
  const canon =
    document.querySelector('link[rel="canonical"]')?.getAttribute('href') || '(none)';
  out.push(`canonical: ${canon}`);
  out.push(`?p=: ${new URLSearchParams(location.search).get('p') || '1'}`);
  try {
    const ad = (await biliApiGet(`/x/web-interface/view?bvid=${urlBvid}`))?.data;
    out.push(
      `view API -> bvid:${ad?.bvid} title:${ad?.title} aid:${ad?.aid} cid:${ad?.cid}`,
    );
  } catch (e) {
    out.push(`view API err: ${e instanceof Error ? e.message : String(e)}`);
  }
  const sv = readBiliState()?.videoData;
  out.push(
    `__INITIAL_STATE__ -> bvid:${sv?.bvid} title:${sv?.title} aid:${sv?.aid} cid:${sv?.cid}`,
  );
  const keys = await getWbiKeys();
  out.push(`wbi keys: ${keys ? 'ok' : '(none)'}`);
  if (lastBiliResolveTrace) {
    out.push('--- 上次真实剪藏时刻录像（关键！反映抓字幕那一刻，非现在）---');
    out.push(lastBiliResolveTrace);
  }
  return out.join('\n');
}

export const biliExtractor: SiteExtractor = {
  name: 'bilibili',
  match: (ctx) => /bilibili\.com\/video\/BV[0-9A-Za-z]+/.test(ctx.url),
  extract: (ctx) => tryBilibili(ctx),
};
