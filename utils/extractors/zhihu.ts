// 兆基clipper —— 知乎专用提取器（专栏文章 / 单条回答 / 问题说明 / 单条想法）
//  知乎同页常混有推荐、评论与多个回答，通用正文算法容易把它们一起带走。
//  本适配器只读取 URL 对应的已渲染正文容器，不调用私有 API，不遍历评论区。
// 注：本模块会被打进 content.js，受 ASCII 约束 —— 中文只可出现在字符串里，禁止进正则字面量。
import { ClipStats, ExtractedPage } from '@/utils/types';
import {
  ExtractContext,
  SiteExtractor,
  cleanMarkdown,
  cleanTags,
  htmlToMarkdown,
  metaContent,
  pageMetaTags,
  parseCjkDate,
  parseCount,
  stripZeroWidth,
} from '@/utils/extract-core';

type ZhihuKind = 'article' | 'answer' | 'question' | 'pin';

function pageKind(ctx: ExtractContext): ZhihuKind | null {
  const path = location.pathname;
  if (/(^|\.)zhuanlan\.zhihu\.com$/.test(ctx.hostname) && /^\/p\/\d+\/?$/.test(path)) {
    return 'article';
  }
  if (/^\/question\/\d+\/answer\/\d+\/?$/.test(path)) return 'answer';
  if (/^\/question\/\d+\/?$/.test(path)) return 'question';
  if (/^\/pin\/\d+\/?$/.test(path)) return 'pin';
  return null;
}

function answerId(): string {
  return (location.pathname.match(/\/answer\/(\d+)/) || [])[1] || '';
}

function markerHasAnswerId(marker: string, id: string): boolean {
  return !!marker && new RegExp(`(^|\\D)${id}(\\D|$)`).test(marker);
}

function hasAnswerLink(root: Element, id: string): boolean {
  for (const link of Array.from(root.querySelectorAll('a[href*="/answer/"]'))) {
    try {
      const linkedId = (new URL(link.getAttribute('href') || '', location.href).pathname.match(
        /\/answer\/(\d+)/,
      ) || [])[1];
      if (linkedId === id) return true;
    } catch {
      // 非法 href 不作为回答身份凭据。
    }
  }
  return false;
}

/** 多回答页必须用 URL answer id 锁定目标，避免误抓问题描述或别人的回答。 */
function findAnswerRoot(): Element | null {
  const id = answerId();
  if (!id) return null;
  const candidates = Array.from(
    document.querySelectorAll('.AnswerItem, .AnswerCard, [data-zop]'),
  );
  for (const el of candidates) {
    const marker = [
      el.getAttribute('name') || '',
      el.getAttribute('data-zop') || '',
      el.getAttribute('data-za-extra-module') || '',
    ].join(' ');
    if (
      markerHasAnswerId(marker, id) ||
      hasAnswerLink(el, id) ||
      el.querySelector(`[name="${id}"]`)
    ) {
      const card = el.closest('.AnswerItem, .AnswerCard');
      if (card) return card;
      // 无标准卡片 class 的 data-zop 根也可接管，但不能是包着多条回答的共同外壳。
      if (
        el.querySelectorAll('.AnswerItem, .AnswerCard').length <= 1 &&
        firstMatch(el, ['.RichContent-inner', '.RichText.ztext', '.CopyrightRichText-richText'])
      ) {
        return el;
      }
    }
  }

  // 部分独立回答页只有 QuestionAnswer-content。仅在它最多包含一张回答卡且
  // 内部仍能验证目标 ID 时采用，避免多回答共同外壳把第一条正文冒充成目标。
  const dedicated = document.querySelector('.QuestionAnswer-content');
  const cards = dedicated?.querySelectorAll('.AnswerItem, .AnswerCard') || [];
  if (dedicated && cards.length <= 1) {
    const marker = [
      dedicated.getAttribute('name') || '',
      dedicated.getAttribute('data-zop') || '',
      dedicated.getAttribute('data-za-extra-module') || '',
    ].join(' ');
    if (
      markerHasAnswerId(marker, id) ||
      hasAnswerLink(dedicated, id) ||
      dedicated.querySelector(`[name="${id}"]`)
    ) {
      return cards[0] || dedicated;
    }
  }
  // URL 指定的回答没有出现在已渲染 DOM 时必须放弃，不能拿页面第一条回答冒充目标。
  return null;
}

function firstMatch(scope: ParentNode, selectors: string[]): Element | null {
  for (const selector of selectors) {
    const el = scope.querySelector(selector);
    if (el) return el;
  }
  return null;
}

function contentFor(kind: ZhihuKind): { root: Element; content: Element } | null {
  if (kind === 'article') {
    const root =
      document.querySelector('.Post-Main') ||
      document.querySelector('article') ||
      document.querySelector('main');
    const content = firstMatch(root || document, [
      '.Post-RichText',
      '.Post-RichTextContainer .RichText',
      '.RichText.ztext',
    ]);
    return root && content ? { root, content } : null;
  }

  if (kind === 'answer') {
    const root = findAnswerRoot();
    const content = root
      ? firstMatch(root, ['.RichContent-inner', '.RichText.ztext', '.CopyrightRichText-richText'])
      : null;
    return root && content ? { root, content } : null;
  }

  if (kind === 'question') {
    const root =
      document.querySelector('.QuestionHeader') ||
      document.querySelector('.QuestionPage') ||
      document.querySelector('main');
    const content = firstMatch(root || document, [
      '.QuestionRichText .RichText.ztext',
      '.QuestionHeader-detail .RichText.ztext',
      '.QuestionHeader-detail',
    ]);
    // 没有补充说明的问题也要保留标题与来源，但绝不擅自抓第一条回答。
    if (root && !content) {
      const empty = document.createElement('div');
      empty.textContent = '该问题暂无补充说明。';
      return { root, content: empty };
    }
    return root && content ? { root, content } : null;
  }

  const root =
    document.querySelector('.PinItem') ||
    document.querySelector('.Pin-content') ||
    document.querySelector('main');
  const content = firstMatch(root || document, [
    '.PinItem-content',
    '.Pin-content',
    '.Rich-content',
    '.RichContent-inner',
    '.RichText.ztext',
    '.Rich-text',
  ]);
  if (!root || !content) return null;

  // 想法的图片画廊可能与 RichText 是兄弟节点。合成一个离线容器交给后续转换，
  // 只补正文媒体区的图片，不把头像、推荐卡片或评论区带进来。
  const media = Array.from(
    root.querySelectorAll(
      '.PinItem-content img, .Pin-content img, .Rich-content img, .Image-Wrapper-Preview img, img.pin-header-image',
    ),
  ).filter((img) => !content.contains(img));
  if (!media.length) return { root, content };

  const combined = document.createElement('div');
  const seen = new Set(
    Array.from(content.querySelectorAll('img')).map(zhihuImageSource).filter(Boolean),
  );
  for (const img of media) {
    const src = zhihuImageSource(img);
    if (!src || seen.has(src)) continue;
    seen.add(src);
    combined.appendChild(img.cloneNode(true));
  }
  combined.appendChild(content.cloneNode(true));
  return { root, content: combined };
}

function zhihuImageSource(img: Element): string {
  return (
    img.getAttribute('data-original') ||
    img.getAttribute('data-actualsrc') ||
    img.getAttribute('data-src') ||
    img.getAttribute('src') ||
    ''
  );
}

/**
 * 专栏的封面与标题位于 Post-RichText 之前，正文容器本身不包含它们。
 * 新版从文章级 image 元数据取封面，旧版才从标题前图片回退，避免误抓头像或推荐图。
 */
function articleLead(root: Element, content: Element): { content: Element; cover: Element | null } {
  const title = firstMatch(root, ['h1.Post-Title']);
  if (!title) return { content, cover: null };

  let cover: Element | null = null;
  // 新版专栏把可见封面渲染在 Post-Main 的前一个兄弟节点里，只在文章根内留下
  // itemprop=image 元数据。优先采用这条文章级凭据，避免跨出正文根误抓导航或推荐图。
  const coverUrl = root.querySelector('meta[itemprop="image"][content]')?.getAttribute('content') || '';
  if (coverUrl) {
    cover = document.createElement('img');
    cover.setAttribute('src', coverUrl);
    cover.setAttribute('alt', (title.textContent || '').trim());
  } else {
    // 兼容旧版结构：封面图片仍在 Post-Main 内、标题之前。
    for (const node of Array.from(root.querySelectorAll('img, h1.Post-Title'))) {
      if (node === title) break;
      const img = node;
      if (content.contains(img) || !zhihuImageSource(img)) continue;
      cover = img;
    }
  }

  const combined = document.createElement('div');
  if (cover) combined.appendChild(cover.cloneNode(true));
  combined.appendChild(title.cloneNode(true));
  combined.appendChild(content.cloneNode(true));
  return { content: combined, cover };
}

/** 在克隆节点上展开知乎懒加载图片与相对链接，不改动用户正在看的页面。 */
function normalizedContentHtml(content: Element): string {
  const clone = content.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      '.RichContent-actions, .ContentItem-actions, .ContentItem-expandButton, .Reward, .Comments-container, script, style, noscript',
    )
    .forEach((el) => el.remove());

  for (const img of Array.from(clone.querySelectorAll('img'))) {
    const src = zhihuImageSource(img);
    if (src) img.setAttribute('src', src);
  }
  for (const link of Array.from(clone.querySelectorAll('a[href]'))) {
    const href = link.getAttribute('href') || '';
    try {
      link.setAttribute('href', new URL(href, location.href).href);
    } catch {
      // 异常链接交给共享 Turndown 规则按原值处理。
    }
  }
  return clone.innerHTML;
}

function stripZhihuSuffix(raw: string): string {
  let title = stripZeroWidth(raw).trim();
  for (const suffix of [' - 知乎', ' – 知乎', '_知乎']) {
    if (title.endsWith(suffix)) title = title.slice(0, -suffix.length).trim();
  }
  return title;
}

function pageTitle(kind: ZhihuKind, root: Element, bodyText: string): string {
  const titleEl = firstMatch(document, [
    'h1.Post-Title',
    '.QuestionHeader-title',
    'meta[property="og:title"]',
    'h1',
  ]);
  const metaTitle = titleEl?.tagName === 'META' ? titleEl.getAttribute('content') || '' : '';
  const title = stripZhihuSuffix(titleEl?.textContent || metaTitle || document.title || '');
  if (title) return title;

  const author = authorName(root);
  const firstLine = bodyText.split('\n').map((s) => s.trim()).find(Boolean) || '';
  if (kind === 'pin' && firstLine) return firstLine.slice(0, 42);
  return author ? `知乎内容｜${author}` : '知乎内容';
}

function authorName(root: Element): string {
  const el = firstMatch(root, [
    '.AuthorInfo-name',
    '.Post-Author .UserLink-link',
    '.UserLink.AuthorInfo-name',
    '[itemprop="author"] [itemprop="name"]',
  ]);
  const fromDom = (el?.textContent || '').replace(/\s+/g, ' ').trim();
  if (fromDom) return fromDom;

  const zop = root.getAttribute('data-zop') || '';
  if (zop) {
    try {
      const parsed = JSON.parse(zop) as { authorName?: string };
      if (parsed.authorName) return parsed.authorName.trim();
    } catch {
      // data-zop 不是合法 JSON 时继续走 meta 回退。
    }
  }
  return metaContent('author').trim();
}

function isoDate(raw: string): string {
  const iso = (raw || '').match(/\d{4}-\d{2}-\d{2}/)?.[0] || '';
  return iso || parseCjkDate(raw || '');
}

function dateFrom(root: Element, kind: 'published' | 'modified'): string {
  const metaSelectors =
    kind === 'published'
      ? ['meta[property="article:published_time"]', 'meta[itemprop="datePublished"]']
      : ['meta[property="article:modified_time"]', 'meta[itemprop="dateModified"]'];
  for (const selector of metaSelectors) {
    const value = document.querySelector(selector)?.getAttribute('content') || '';
    const date = isoDate(value);
    if (date) return date;
  }

  if (kind === 'published') {
    const datetime = root.querySelector('time[datetime]')?.getAttribute('datetime') || '';
    const timeDate = isoDate(datetime);
    if (timeDate) return timeDate;
  }

  const timeText = (
    firstMatch(root, ['.ContentItem-time', '.Post-Header .ContentItem-time', '.Special-time'])
      ?.textContent || ''
  ).trim();
  if (kind === 'modified' && timeText.includes('编辑')) return isoDate(timeText);
  if (kind === 'published' && !timeText.includes('编辑')) return isoDate(timeText);
  return '';
}

function countInText(raw: string): number | undefined {
  const start = (raw || '').search(/\d/);
  if (start < 0) return undefined;
  return parseCount(raw.slice(start).replace(/,/g, '').trim());
}

function statsFrom(root: Element): ClipStats | undefined {
  const stats: ClipStats = {};
  const vote = firstMatch(root, [
    '.VoteButton--up',
    'button[aria-label*="赞同"]',
    '[itemprop="upvoteCount"]',
  ]);
  const likes = countInText(
    vote?.getAttribute('content') || vote?.getAttribute('aria-label') || vote?.textContent || '',
  );
  if (likes != null) stats.likes = likes;

  for (const el of Array.from(root.querySelectorAll('button, a'))) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!text.includes('评论')) continue;
    const comments = countInText(text);
    if (comments != null) {
      stats.comments = comments;
      break;
    }
  }
  return Object.keys(stats).length ? stats : undefined;
}

function tagsFrom(root: Element, content: Element): string[] {
  const raw = pageMetaTags();
  for (const el of Array.from(
    root.querySelectorAll('.Tag-content, .QuestionHeader-topics a, .Post-Topics a'),
  )) {
    raw.push(el.textContent || '');
  }
  for (const el of Array.from(content.querySelectorAll('a.hash_tag'))) {
    raw.push((el.textContent || '').trim().replace(/^#+|#+$/g, ''));
  }
  return cleanTags(raw);
}

async function tryZhihu(ctx: ExtractContext): Promise<ExtractedPage | null> {
  const kind = pageKind(ctx);
  if (!kind) return null;
  const found = contentFor(kind);
  if (!found) return null;

  const bodyText = ((found.content as HTMLElement).innerText || found.content.textContent || '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const lead = kind === 'article' ? articleLead(found.root, found.content) : null;
  const markdownContent = lead?.content || found.content;
  const contentMarkdown = cleanMarkdown(htmlToMarkdown(normalizedContentHtml(markdownContent)));
  if (!contentMarkdown) return null;

  const title = pageTitle(kind, found.root, bodyText);
  const author = authorName(found.root);
  const tags = tagsFrom(found.root, found.content);
  const firstImage = lead?.cover || found.content.querySelector('img');
  const image = (firstImage && zhihuImageSource(firstImage)) || metaContent('og:image');

  const siteNames: Record<ZhihuKind, string> = {
    article: '知乎专栏',
    answer: '知乎回答',
    question: '知乎问题',
    pin: '知乎想法',
  };

  return {
    title,
    author,
    published: dateFrom(found.root, 'published'),
    modified: dateFrom(found.root, 'modified'),
    description: bodyText.replace(/\s+/g, ' ').slice(0, 120),
    site: siteNames[kind],
    domain: 'zhihu.com',
    url: ctx.url,
    image,
    contentMarkdown,
    selectionMarkdown: htmlToMarkdown(ctx.selectionHtml),
    wordCount: bodyText.replace(/\s+/g, '').length,
    highlights: ctx.highlights,
    stats: statsFrom(found.root),
    tags: tags.length ? tags : undefined,
  };
}

export const zhihuExtractor: SiteExtractor = {
  name: 'zhihu',
  match: (ctx) => /(^|\.)zhihu\.com$/.test(ctx.hostname) && pageKind(ctx) !== null,
  extract: (ctx) => tryZhihu(ctx),
};
