// 兆基clipper —— 小红书图文笔记专用提取器
//  笔记开在浮层 modal 里（盖在信息流上），Defuddle/findScroller 会抓到背后的信息流+AI面板，
//  故直接读笔记 modal 的 DOM（标题/图集/正文/作者），绕开 Defuddle。
//  小红书无 window.__INITIAL_STATE__，全部走 DOM。反爬不构成障碍（读已渲染 DOM，不打签名 API）。
// 注：本模块会被打进 content.js，受 ASCII 约束 —— 中文只可出现在字符串里，禁止进正则字面量。
import { ClipStats, ExtractedPage } from '@/utils/types';
import {
  ExtractContext,
  SiteExtractor,
  cleanTags,
  metaContent,
  parseCount,
} from '@/utils/extract-core';

/** 笔记浮层根容器 */
function noteRoot(): HTMLElement | null {
  return (
    (document.querySelector('#noteContainer') as HTMLElement | null) ||
    (document.querySelector('.note-container') as HTMLElement | null)
  );
}

/** 去掉 document.title 的“ - 小红书”后缀（用字符串操作，避免中文进正则破坏 ASCII 打包） */
function stripXhsTitleSuffix(t: string): string {
  const i = t.lastIndexOf(' - ');
  return i > 0 ? t.slice(0, i).trim() : t.trim();
}

function tryXiaohongshu(ctx: ExtractContext): ExtractedPage | null {
  const root = noteRoot();
  const scope: ParentNode = root || document;
  const titleEl = scope.querySelector('#detail-title');
  const descEl =
    scope.querySelector('#detail-desc .note-text') || scope.querySelector('#detail-desc');
  // 笔记浮层未打开（如在信息流/搜索页）→ 返回 null 放行给通用适配器
  if (!titleEl && !descEl) return null;

  const title =
    (titleEl?.textContent || '').trim() ||
    stripXhsTitleSuffix(document.title) ||
    '小红书笔记';
  const author =
    (
      (scope.querySelector('.author-wrapper .username') ||
        scope.querySelector('.author-container .username') ||
        scope.querySelector('.author-wrapper .name'))?.textContent || ''
    ).trim();

  // 图集：媒体容器内的内容图（排除头像/图标），按 src 去重保序
  const uniqImgs: string[] = [];
  for (const im of Array.from(scope.querySelectorAll('.media-container img, .swiper-wrapper img'))) {
    const s = im.getAttribute('src') || '';
    if (!s || !/xhscdn\.com/.test(s) || /\/avatar\//.test(s)) continue;
    if (!uniqImgs.includes(s)) uniqImgs.push(s);
  }
  // 视频笔记：媒体区是 <video>（blob MSE 流，无法下载/嵌入），用 og:image 取封面
  const isVideo = !!scope.querySelector('.media-container video') || !!scope.querySelector('video');
  let cover = uniqImgs[0] || '';
  if (!cover) cover = metaContent('og:image');

  // 正文：innerText 保留换行、话题标签为纯文本（#xxx）
  const body = descEl
    ? ((descEl as HTMLElement).innerText || descEl.textContent || '').trim()
    : '';
  // 日期：从 .bottom-container 文本里抽出日期（“编辑于 2025-04-09” → 2025-04-09），抽不到则留空
  const dateText = (scope.querySelector('.bottom-container')?.textContent || '').trim();
  const dm = dateText.match(/\d{4}-\d{2}-\d{2}|\d{1,2}-\d{1,2}/);
  const published = dm ? dm[0] : '';

  // 互动数据：限定在 note 的 .interact-container 内取（避免抓到评论的赞），归一化为数字写入 frontmatter
  const ic = scope.querySelector('.interact-container');
  const countOf = (sel: string): number | undefined =>
    parseCount(ic?.querySelector(sel)?.textContent || '');
  const stats: ClipStats = {};
  const likes = countOf('.like-wrapper .count');
  const collects = countOf('.collect-wrapper .count');
  const comments = countOf('.chat-wrapper .count');
  if (likes != null) stats.likes = likes;
  if (collects != null) stats.collects = collects;
  if (comments != null) stats.comments = comments;

  // 页面自带话题标签：笔记正文里的 #话题# 锚点（class 含 tag），纯提取
  const tags = cleanTags(
    Array.from((descEl ?? scope).querySelectorAll('a'))
      .map((a) => (a.textContent || '').trim())
      .filter((t) => t.startsWith('#')),
  );

  // 组装：封面/图集在前（小红书以图为主）→ 视频标注 → 正文
  const parts: string[] = [];
  if (isVideo) {
    if (cover) parts.push(`![](${cover})`);
    parts.push('> 📹 视频笔记：小红书视频为 blob 流，无法下载/嵌入，此处仅存封面+文案。');
  } else {
    for (const u of uniqImgs) parts.push(`![](${u})`);
  }
  if (body) parts.push(body);
  const content = parts.join('\n\n');

  return {
    title,
    author,
    published,
    description: body.replace(/\s+/g, ' ').trim().slice(0, 120),
    site: '小红书',
    domain: 'xiaohongshu.com',
    url: ctx.url,
    image: cover,
    contentMarkdown: content,
    selectionMarkdown: '',
    wordCount: body.length,
    highlights: ctx.highlights,
    stats,
    tags: tags.length ? tags : undefined,
  };
}

export const xiaohongshuExtractor: SiteExtractor = {
  name: 'xiaohongshu',
  // 仅当确为小红书页且笔记浮层（#detail-title）已打开时接管，否则放行给通用
  match: (ctx) =>
    /xiaohongshu\.com|xhslink\.com/.test(ctx.hostname) &&
    !!document.querySelector('#detail-title'),
  extract: async (ctx) => tryXiaohongshu(ctx),
};
