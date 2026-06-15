// 兆基clipper —— X/Twitter 提取器（单条推文 + 整串 thread + Article 长文）
//  普通推文直读 tweet data-testid；Article 使用独立富文本容器与 Defuddle 专用提取器。
//  反爬不构成障碍（读已渲染 DOM，不打签名 API）。视频是 blob 流，无法下载，用官方公开嵌入。
//  整串：仅在用户点「完整抓取」(ctx.fullCapture) 时触发，滚动收集「围绕焦点、连续同作者」的块。
//   边界按视觉序（出现顺序）而非 id/时间序——外人秒回的评论 id 可能插进自串中间，但视觉上排在串后。
// 注：本模块会被打进 content.js，受 ASCII 约束 —— 中文只可出现在字符串里，禁止进正则字面量。
import { ClipStats, ExtractedPage } from '@/utils/types';
import {
  ExtractContext,
  SiteExtractor,
  cleanMarkdown,
  htmlToMarkdown,
  parseWithSelector,
  sleep,
  stripZeroWidth,
} from '@/utils/extract-core';

/** 读推文正文，剥掉沉浸式翻译等插件注入的译文节点，只留原文 */
function cleanTweetText(el: Element | null): string {
  if (!el) return '';
  const clone = el.cloneNode(true) as HTMLElement;
  clone
    .querySelectorAll(
      '.immersive-translate-target-wrapper, .immersive-translate-target-inner, font[class*="immersive-translate"]',
    )
    .forEach((n) => n.remove());
  return (clone.innerText || clone.textContent || '').replace(/\n{3,}/g, '\n\n').trim();
}

/** 从互动按钮的 aria-label 里取精确数字（"9123 Likes" → 9123） */
function countFrom(el: Element | null): number | undefined {
  const m = (el?.getAttribute('aria-label') || '').match(/[\d,]+/);
  if (!m) return undefined;
  const n = parseInt(m[0].replace(/,/g, ''), 10);
  return isNaN(n) ? undefined : n;
}

/**
 * 外链卡片（推文挂的外部文章/视频预览卡）。
 * card.wrapper 里只有图与一个 t.co 锚点，标题/域名在指向同一 t.co 的推文锚点文本里
 * （且常被沉浸式翻译注入译文，需 cleanTweetText 剥掉）。t.co 短链能正常跳转，
 * 不解析为真实地址（解析需联网=tracking 请求，违背零风险原则）。
 */
function extractCard(
  scope: Element,
): { href: string; img: string; title: string; domain: string } | null {
  const card = scope.querySelector('[data-testid="card.wrapper"]');
  if (!card) return null;
  const href = card.querySelector('a[href]')?.getAttribute('href') || '';
  if (!href) return null;
  const img = card.querySelector('img')?.getAttribute('src') || '';
  let title = '';
  let domain = '';
  // 收集所有指向该 t.co 的锚点（属性选择器：t.co URL 不含引号，安全）
  for (const a of Array.from(scope.querySelectorAll(`a[href="${href}"]`))) {
    const t = cleanTweetText(a).replace(/\s+/g, ' ').trim();
    if (!t) continue;
    const dm = (t.match(/([a-z0-9-]+\.)+[a-z]{2,}/i) || [])[0] || '';
    // 纯域名 / "From 域名" → 当域名；其余取最长者当标题
    const stripped = t.replace(/^from\s+/i, '').trim();
    if (dm && stripped === dm) {
      domain = dm;
    } else if (t.length > title.length) {
      title = t;
      if (!domain && dm) domain = dm;
    }
  }
  return { href, img, title, domain };
}

interface TweetData {
  id: string;
  handle: string;
  userName: string;
  published: string;
  text: string;
  imgs: string[];
  card: { href: string; img: string; title: string; domain: string } | null;
  isVideo: boolean;
  stats: ClipStats;
}

/** 从一个 tweet article 节点提取全部渲染所需数据（虚拟滚动会回收节点，故收集时一次性取全） */
function extractTweetData(tw: Element): TweetData {
  const userName = (tw.querySelector('[data-testid="User-Name"]')?.textContent || '')
    .replace(/\s+/g, ' ')
    .trim();
  const handle = (userName.match(/@\w+/) || [])[0] || '';
  const a = tw.querySelector('time')?.closest('a');
  const id = (a?.getAttribute('href')?.match(/status\/(\d+)/) || [])[1] || '';
  const datetime = tw.querySelector('time')?.getAttribute('datetime') || '';
  const published = (datetime.match(/\d{4}-\d{2}-\d{2}/) || [])[0] || '';
  const text = cleanTweetText(tw.querySelector('[data-testid="tweetText"]'));

  // 图片：tweetPhoto（pbs.twimg.com 真 https，可下）；尽量取大图（name=large）
  const imgs: string[] = [];
  for (const im of Array.from(tw.querySelectorAll('[data-testid="tweetPhoto"] img'))) {
    let s = im.getAttribute('src') || '';
    if (!s || !/pbs\.twimg\.com/.test(s)) continue;
    s = s.replace(/name=[a-zA-Z0-9]+/, 'name=large');
    if (!imgs.includes(s)) imgs.push(s);
  }
  const isVideo = !!tw.querySelector('[data-testid="videoPlayer"] video, video');
  const card = extractCard(tw);

  // 互动：从 aria-label 取精确数（转推→shares、书签→bookmarks）
  const stats: ClipStats = {};
  const like = countFrom(tw.querySelector('[data-testid="like"]'));
  const rt = countFrom(tw.querySelector('[data-testid="retweet"]'));
  const reply = countFrom(tw.querySelector('[data-testid="reply"]'));
  const bookmark = countFrom(tw.querySelector('[data-testid="bookmark"]'));
  if (like != null) stats.likes = like;
  if (rt != null) stats.shares = rt;
  if (reply != null) stats.comments = reply;
  if (bookmark != null) stats.bookmarks = bookmark;

  return { id, handle, userName, published, text, imgs, card, isVideo, stats };
}

/** 用 URL 的 status id 锁定主推文；找不到时退回页面第一条。 */
function findFocusedTweet(): Element | null {
  const tweets = document.querySelectorAll('article[data-testid="tweet"]');
  if (!tweets.length) return null;
  const focusedId = (location.pathname.match(/status\/(\d+)/) || [])[1] || '';
  if (focusedId) {
    for (const tweet of Array.from(tweets)) {
      if (tweet.querySelector(`a[href*="/status/${focusedId}"]`)) return tweet;
    }
  }
  return tweets[0] || null;
}

/** 只滚动 X Article 正文范围，正文底部进入视口后立即停止。 */
async function scrollXArticleToEnd(container: HTMLElement): Promise<void> {
  const origY = window.scrollY;
  const top = Math.max(0, window.scrollY + container.getBoundingClientRect().top - 80);
  window.scrollTo(0, top);
  await sleep(300);

  let lastY = -1;
  for (let guard = 0; guard < 300; guard++) {
    const rect = container.getBoundingClientRect();
    if (rect.bottom <= window.innerHeight - 20) break;
    const articleBottom = window.scrollY + rect.bottom;
    const target = Math.min(articleBottom - window.innerHeight + 40, window.scrollY + window.innerHeight * 0.8);
    window.scrollTo(0, Math.max(window.scrollY, target));
    await sleep(220);
    if (window.scrollY === lastY) break;
    lastY = window.scrollY;
  }

  await sleep(250);
  window.scrollTo(0, origY);
}

/** X Article 使用独立富文本 DOM，不在 tweetText 里。 */
async function tryXArticle(ctx: ExtractContext): Promise<ExtractedPage | null> {
  const articleContainer = document.querySelector<HTMLElement>(
    '[data-testid="twitterArticleRichTextView"]',
  );
  if (!articleContainer) return null;

  // 只滚动这一篇文章，用于触发正文图片懒加载；不进入回复区。
  if (ctx.fullCapture) {
    await scrollXArticleToEnd(articleContainer);
  }

  // Defuddle 0.18.1 内置 XArticleExtractor，会处理长文标题、段落、图片、代码块和嵌入推文。
  const parsed = await parseWithSelector(ctx.url);
  let contentMarkdown = cleanMarkdown(htmlToMarkdown(parsed.content || ''));
  // Article videos are page-local blob streams. Without the official X API
  // they cannot be embedded reliably outside X, so omit only the dead media.
  if (/\]\(blob:https?:\/\/[^)]+\)/.test(contentMarkdown)) {
    contentMarkdown = contentMarkdown.replace(
      /\[[^\]]*\]\(blob:https?:\/\/[^)]+\)/g,
      '',
    );
  }
  contentMarkdown = cleanMarkdown(contentMarkdown);
  if (!contentMarkdown) return null;

  const mainTweet = findFocusedTweet();
  const tweetData = mainTweet ? extractTweetData(mainTweet) : null;
  const titleEl = document.querySelector('[data-testid="twitter-article-title"]');
  const title = stripZeroWidth(
    titleEl?.textContent || parsed.title || document.title || 'X 文章',
  ).trim();
  const description = stripZeroWidth(parsed.description || '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    title: title || 'X 文章',
    author: parsed.author || tweetData?.userName || '',
    published: parsed.published || tweetData?.published || '',
    description:
      description ||
      contentMarkdown
        .replace(/[#>*_`\[\]()!-]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120),
    site: 'X (Article)',
    domain: 'x.com',
    url: ctx.url,
    image: parsed.image || tweetData?.imgs[0] || '',
    contentMarkdown,
    selectionMarkdown: htmlToMarkdown(ctx.selectionHtml),
    wordCount: parsed.wordCount || contentMarkdown.length,
    highlights: ctx.highlights,
    stats: tweetData?.stats,
  };
}

/** 把一条推文渲染成 Markdown 块（正文 + 卡片 + 图片 + 视频嵌入） */
function renderTweetBlock(d: TweetData): string {
  const parts: string[] = [];
  if (d.text) parts.push(d.text);
  if (d.card) {
    const label = [d.card.title, d.card.domain].filter(Boolean).join(' — ') || d.card.href;
    parts.push(`🔗 [${label}](${d.card.href})`);
    if (d.card.img) parts.push(`![](${d.card.img})`);
  }
  for (const u of d.imgs) parts.push(`![](${u})`);
  // 视频推文：X 官方公开嵌入（platform.twitter.com/embed），零风险、需 Media Extended 渲染
  if (d.isVideo && d.id) {
    parts.push(
      `<iframe src="https://platform.twitter.com/embed/Tweet.html?id=${d.id}" ` +
        `width="100%" height="640" scrolling="no" frameborder="0" allowfullscreen="true"></iframe>`,
    );
  }
  return parts.join('\n\n');
}

/**
 * 整串收集：滚动会话，取「围绕焦点推文、视觉上连续同作者」的块。
 * 视觉序 = 自顶向下首次出现的次序（先上滚到顶加载祖先，再自顶向下记录，保证序正确）。
 * 「下边界一出现外人 → 封口停」：不进评论区；硬上限 60 条兜底。返回 null 表示退回单条。
 */
async function collectThread(focusedId: string, focusedHandle: string): Promise<TweetData[] | null> {
  const seen = new Map<string, { d: TweetData; handle: string; order: number }>();
  let app = 0;
  const collect = () => {
    for (const tw of Array.from(document.querySelectorAll('article[data-testid="tweet"]'))) {
      const d = extractTweetData(tw);
      if (!d.id || seen.has(d.id)) continue;
      seen.set(d.id, { d, handle: d.handle, order: app++ });
    }
  };
  const origY = window.scrollY;
  // 1) 上滚到顶加载祖先（此遍不记录，记录留给自顶向下那遍以保证视觉序）
  for (let i = 0; i < 18 && window.scrollY > 0; i++) {
    window.scrollTo(0, Math.max(0, window.scrollY - 800));
    await sleep(200);
  }
  await sleep(200);
  // 2) 自顶向下收集，焦点作者块下边界封口即停
  let lastY = -1;
  for (let guard = 0; guard < 40; guard++) {
    collect();
    const byApp = [...seen.values()].sort((a, b) => a.order - b.order);
    const fi = byApp.findIndex((v) => v.d.id === focusedId);
    if (fi >= 0) {
      let hi = fi;
      while (hi < byApp.length - 1 && byApp[hi + 1].handle === focusedHandle) hi++;
      if (byApp[hi + 1] && byApp[hi + 1].handle !== focusedHandle) break; // 下边界封口
    }
    if (seen.size >= 60) break;
    if (window.scrollY === lastY) break; // 到底，无法再滚
    lastY = window.scrollY;
    window.scrollTo(0, window.scrollY + 800);
    await sleep(220);
  }
  window.scrollTo(0, origY);
  // 3) 取围绕焦点、连续同作者的块（焦点在串中间也能上下展开）
  const byApp = [...seen.values()].sort((a, b) => a.order - b.order);
  const fi = byApp.findIndex((v) => v.d.id === focusedId);
  if (fi < 0) return null;
  let lo = fi;
  let hi = fi;
  while (lo > 0 && byApp[lo - 1].handle === focusedHandle) lo--;
  while (hi < byApp.length - 1 && byApp[hi + 1].handle === focusedHandle) hi++;
  return byApp.slice(lo, hi + 1).map((v) => v.d);
}

async function tryX(ctx: ExtractContext): Promise<ExtractedPage | null> {
  const article = await tryXArticle(ctx);
  if (article) return article;

  const tweets = document.querySelectorAll('article[data-testid="tweet"]');
  if (!tweets.length) return null;
  // 用 URL 的 status id 锁定焦点推文（页面含主推+多条回复）
  const focusedId = (location.pathname.match(/status\/(\d+)/) || [])[1] || '';
  const mainEl = findFocusedTweet();
  if (!mainEl) return null;
  const mainData = extractTweetData(mainEl);

  // 整串：仅当用户点「完整抓取」时滚动收集（默认单条，零滚动零风险）
  let chain: TweetData[] | null = null;
  if (ctx.fullCapture) {
    chain = await collectThread(focusedId || mainData.id, mainData.handle);
  }
  const list = chain && chain.length > 1 ? chain : [mainData];
  const isThread = list.length > 1;
  const root = list[0]; // 串首（或单条）

  const content = list.map(renderTweetBlock).join('\n\n---\n\n');
  const titleSnippet = root.text.replace(/\s+/g, ' ').trim().slice(0, 50);
  const title = titleSnippet || (root.handle ? `${root.handle} 的推文` : 'X 推文');
  // 封面：串里第一张图，否则卡片图
  const cover = (list.find((t) => t.imgs.length)?.imgs[0] || '') || root.card?.img || '';
  const totalWords = list.reduce((n, t) => n + t.text.length, 0);

  return {
    title,
    author: root.userName,
    published: root.published,
    description: root.text.replace(/\s+/g, ' ').trim().slice(0, 120),
    site: isThread ? 'X (thread)' : 'X',
    domain: 'x.com',
    url: ctx.url,
    image: cover,
    contentMarkdown: content,
    selectionMarkdown: '',
    wordCount: totalWords,
    highlights: ctx.highlights,
    stats: root.stats,
  };
}

export const xExtractor: SiteExtractor = {
  name: 'x',
  match: (ctx) =>
    /(^|\.)x\.com$|(^|\.)twitter\.com$/.test(ctx.hostname) &&
    (/\/(status|article)\/\d+/.test(ctx.url) || /\/i\/article\/\d+/.test(ctx.url)) &&
    !!document.querySelector(
      'article[data-testid="tweet"], [data-testid="twitterArticleRichTextView"]',
    ),
  extract: (ctx) => tryX(ctx),
};
