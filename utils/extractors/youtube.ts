// 兆基clipper —— YouTube 观看页提取器
//  正文（可播放嵌入 + 字幕 transcript）仍走 Defuddle 的 YouTube 异步 extractor（parseAsync），
//  本适配器在其基础上「额外」从已渲染 DOM 补抓互动数据：观看数/点赞数/发布日期/频道名。
//  全部读 DOM 的文本与 aria-label（精确数藏在 aria-label，显示文本是缩写），零签名、零风控。
// 注：本模块会被打进 content.js，受 ASCII 约束 —— 中文只可出现在字符串里，禁止进正则字面量。
import { ClipStats, ExtractedPage } from '@/utils/types';
import {
  ExtractContext,
  SiteExtractor,
  cleanMarkdown,
  htmlToMarkdown,
  parseCjkDate,
  parseCount,
  parseWithSelector,
  sleep,
} from '@/utils/extract-core';

/** 评论数所在的标题元素（懒加载，滚到评论区才渲染） */
const COMMENT_COUNT_SEL =
  'ytd-comments-header-renderer #count, ytd-comments-header-renderer #count .count-text, #comments #count';

/** 点赞数：精确值在按钮 aria-label 里（如「与另外 15,407 人一起顶此视频」），显示文本是缩写 */
function ytLikes(): number | undefined {
  for (const sel of [
    'like-button-view-model button',
    'segmented-like-dislike-button-view-model button',
    'ytd-menu-renderer #top-level-buttons-computed button',
  ]) {
    const a = document.querySelector(sel)?.getAttribute('aria-label') || '';
    const m = a.match(/[\d,]+/);
    if (m) {
      const n = parseInt(m[0].replace(/,/g, ''), 10);
      if (!isNaN(n)) return n;
    }
  }
  return undefined;
}

/** 观看数：优先取带千分位逗号的精确数（811,154），无则用缩写「81万次观看」经 parseCount 还原 */
function ytViews(): number | undefined {
  const SELS = ['ytd-video-view-count-renderer', 'ytd-watch-info-text', '#info-container'];
  for (const sel of SELS) {
    const t = document.querySelector(sel)?.textContent || '';
    const m = t.match(/\d{1,3}(?:,\d{3})+/);
    if (m) return parseInt(m[0].replace(/,/g, ''), 10);
  }
  // 退：缩写形式（如「81万次观看」），截到「次观看」前的数字片段交 parseCount（识别万/亿）
  const VIEW = '次观看';
  for (const sel of SELS) {
    const t = (document.querySelector(sel)?.textContent || '').trim();
    const i = t.indexOf(VIEW);
    if (i > 0) {
      const seg = (t.slice(0, i).match(/[\d.,]+\S*$/) || [''])[0].replace(/,/g, '');
      const n = parseCount(seg);
      if (n != null) return n;
    }
  }
  return undefined;
}

/** 发布日期：从 watch-info-text 里解析「2025年5月23日」→「2025-05-23」（共享 parseCjkDate） */
function ytDate(): string {
  for (const sel of ['ytd-watch-info-text', '#info-container']) {
    const d = parseCjkDate(document.querySelector(sel)?.textContent || '');
    if (d) return d;
  }
  return '';
}

/** 评论数：从评论区标题「343 条评论」解析（精确逗号数 / 简单数 / 万亿缩写） */
function ytComments(): number | undefined {
  const t = (document.querySelector(COMMENT_COUNT_SEL)?.textContent || '').trim();
  if (!t) return undefined;
  const m = t.match(/\d{1,3}(?:,\d{3})+/);
  if (m) return parseInt(m[0].replace(/,/g, ''), 10);
  const seg = (t.match(/[\d.,]+\S*/) || [''])[0].replace(/,/g, '');
  return parseCount(seg);
}

/** 评论区懒加载：未渲染时滚到评论区触发加载，读完由调用方还原视图 */
async function ensureCommentsLoaded(): Promise<number> {
  const origY = window.scrollY;
  if (!document.querySelector(COMMENT_COUNT_SEL)) {
    window.scrollTo(0, Math.max(700, window.innerHeight));
    await sleep(700);
    if (!document.querySelector(COMMENT_COUNT_SEL)) {
      window.scrollTo(0, window.innerHeight * 1.8);
      await sleep(700);
    }
  }
  return origY;
}

/** 去掉标题尾部「 - YouTube」（用字符串操作避免中文/特例进正则） */
function stripYtSuffix(t: string): string {
  const i = t.lastIndexOf(' - YouTube');
  return i > 0 ? t.slice(0, i).trim() : t.trim();
}

async function tryYoutube(ctx: ExtractContext): Promise<ExtractedPage | null> {
  // 正文 = Defuddle 的 YouTube extractor 产物（可播放嵌入 + transcript 字幕），与现状一致
  const parsed = await parseWithSelector(ctx.url);
  const contentMarkdown = cleanMarkdown(htmlToMarkdown(parsed.content || ''));
  // Defuddle 没认出是 YouTube（极少数情况）→ 放行给通用适配器，避免丢字幕
  if (!contentMarkdown) return null;

  const channel = (
    document.querySelector('#owner #channel-name a, ytd-channel-name a')?.textContent || ''
  )
    .replace(/\s+/g, ' ')
    .trim();

  // 评论懒加载：先确保评论区渲染（滚动触发），读完还原用户视图
  const origY = await ensureCommentsLoaded();
  const stats: ClipStats = {};
  const views = ytViews();
  const likes = ytLikes();
  const comments = ytComments();
  if (views != null) stats.views = views;
  if (likes != null) stats.likes = likes;
  if (comments != null) stats.comments = comments;
  window.scrollTo(0, origY);

  return {
    title: stripYtSuffix(parsed.title || document.title || 'YouTube 视频') || 'YouTube 视频',
    author: channel || parsed.author || '',
    published: ytDate() || parsed.published || '',
    description: parsed.description || '',
    site: 'YouTube',
    domain: 'youtube.com',
    url: ctx.url,
    image: parsed.image || '',
    contentMarkdown,
    selectionMarkdown: htmlToMarkdown(ctx.selectionHtml),
    wordCount: parsed.wordCount || contentMarkdown.length,
    highlights: ctx.highlights,
    stats: Object.keys(stats).length ? stats : undefined,
  };
}

export const youtubeExtractor: SiteExtractor = {
  name: 'youtube',
  match: (ctx) =>
    /(^|\.)youtube\.com$/.test(ctx.hostname) &&
    (location.pathname.indexOf('/watch') === 0 || location.search.includes('v=')),
  extract: (ctx) => tryYoutube(ctx),
};
