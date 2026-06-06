// 兆基clipper —— Reddit 帖子提取器
//  新版 Reddit 用 Web Components：<shreddit-post> 把标题/作者/分数/类型等放在元素属性上，
//  正文在 [slot="text-body"] 光 DOM 里。直接读属性+正文容器，绕开 Defuddle(它会把评论树当正文)。
//  只抓「帖子本体」(标题+正文+媒体+互动)，不抓评论——评论是噪声，语义活交下游 agent。
//  纯读已渲染 DOM/属性，不打 API，零风控。
// 注：本模块会被打进 content.js，受 ASCII 约束 —— 中文只可出现在字符串里，禁止进正则字面量。
import { ClipStats, ExtractedPage } from '@/utils/types';
import { ExtractContext, SiteExtractor, cleanTags, htmlToMarkdown } from '@/utils/extract-core';

function intAttr(el: Element, name: string): number | undefined {
  const v = parseInt(el.getAttribute(name) || '', 10);
  return isNaN(v) ? undefined : v;
}

/** 帖子内容图：只留 reddit 图床(i/preview/external-preview.redd.it)，排除社区图标/头像/奖章 */
function contentImages(sp: Element): string[] {
  const out: string[] = [];
  for (const im of Array.from(sp.querySelectorAll('img'))) {
    const s = im.getAttribute('src') || '';
    if (!/(i|preview|external-preview)\.redd\.it\//.test(s)) continue;
    if (!out.includes(s)) out.push(s);
  }
  return out;
}

function tryReddit(ctx: ExtractContext): ExtractedPage | null {
  const sp = document.querySelector('shreddit-post');
  if (!sp) return null;

  const title = (sp.getAttribute('post-title') || document.title || 'Reddit 帖子').trim();
  const author = (sp.getAttribute('author') || '').trim();
  const sub = (sp.getAttribute('subreddit-prefixed-name') || '').trim(); // r/xxx
  const published = (sp.getAttribute('created-timestamp') || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
  const postType = (sp.getAttribute('post-type') || '').trim();
  const contentHref = (sp.getAttribute('content-href') || '').trim();

  const bodyEl = sp.querySelector('[slot="text-body"]');
  const body = bodyEl ? htmlToMarkdown(bodyEl.innerHTML) : '';

  const imgs = contentImages(sp);
  // 单图帖：content-href 即图片直链，补进图集
  if (
    postType === 'image' &&
    /(i|preview)\.redd\.it\//.test(contentHref) &&
    !imgs.includes(contentHref)
  ) {
    imgs.unshift(contentHref);
  }

  const parts: string[] = [];
  if (body) parts.push(body);

  if (postType === 'link' && contentHref && !/reddit\.com/.test(contentHref)) {
    // 外链帖：渲染成 标题—域名 链接（同 X 卡片）
    let host = '';
    try {
      host = new URL(contentHref).hostname.replace(/^www\./, '');
    } catch {
      host = '';
    }
    parts.push(`🔗 [${[title, host].filter(Boolean).join(' — ')}](${contentHref})`);
  } else if (postType === 'video' || sp.querySelector('shreddit-player, video')) {
    // Reddit 视频是 HLS/blob 流，无法嵌入/下载 → 给原帖链接
    parts.push(`> 📹 Reddit 视频（无法嵌入）：[在 Reddit 查看](${ctx.url})`);
  } else {
    // image / gallery / text：有内容图就放图
    for (const u of imgs) parts.push(`![](${u})`);
  }

  const stats: ClipStats = {};
  const score = intAttr(sp, 'score');
  const comments = intAttr(sp, 'comment-count');
  if (score != null) stats.likes = score;
  if (comments != null) stats.comments = comments;

  // 子版块当标签（r/xxx → xxx），纯提取
  const tags = cleanTags(sub ? [sub.replace(/^r\//, '')] : []);

  return {
    title,
    author: author ? `u/${author}` : '',
    published,
    description: (body || title).replace(/\s+/g, ' ').trim().slice(0, 120),
    site: sub || 'Reddit',
    domain: 'reddit.com',
    url: ctx.url,
    image: imgs[0] || '',
    contentMarkdown: parts.join('\n\n'),
    selectionMarkdown: '',
    wordCount: body.length,
    highlights: ctx.highlights,
    stats,
    tags: tags.length ? tags : undefined,
  };
}

export const redditExtractor: SiteExtractor = {
  name: 'reddit',
  match: (ctx) =>
    /(^|\.)reddit\.com$/.test(ctx.hostname) &&
    /\/comments\//.test(ctx.url) &&
    !!document.querySelector('shreddit-post'),
  extract: async (ctx) => tryReddit(ctx),
};
