// Nomo Clipper - Douyin video extractor.
// Douyin is an SPA with messaging, recommendations, and comments beside the active video.
// Generic readability extraction can mistake those panels for article content, so this adapter
// intentionally keeps only metadata that belongs to the visible player.
import { ExtractedPage } from '@/utils/types';
import { extractDouyinAwemeId } from '@/utils/douyin-media-payload';
import {
  ExtractContext,
  SiteExtractor,
  cleanTags,
  htmlToMarkdown,
  metaContent,
  stripZeroWidth,
} from '@/utils/extract-core';

function visibleVideo(): HTMLVideoElement | null {
  const ranked = Array.from(document.querySelectorAll('video'))
    .map((video) => {
      const rect = video.getBoundingClientRect();
      const visible =
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom > 0 &&
        rect.right > 0 &&
        rect.top < window.innerHeight &&
        rect.left < window.innerWidth;
      const area = visible ? rect.width * rect.height : 0;
      const playing = !video.paused && !video.ended ? 1 : 0;
      return { video, score: playing * 1_000_000_000 + area };
    })
    .sort((a, b) => b.score - a.score);
  return ranked[0]?.score > 0 ? ranked[0].video : null;
}

function playerScope(video: HTMLVideoElement | null): ParentNode {
  let node: HTMLElement | null = video?.parentElement || null;
  for (let depth = 0; node && depth < 12; depth += 1, node = node.parentElement) {
    if (
      node.querySelector(
        '[data-e2e="video-desc"], [data-e2e="video-title"], [data-e2e="video-author-name"]',
      )
    ) return node;
    if (node === document.body) break;
  }
  return document;
}

function firstText(scope: ParentNode, selectors: string[]): string {
  for (const selector of selectors) {
    const value = (scope.querySelector(selector)?.textContent || '').replace(/\s+/g, ' ').trim();
    if (value) return stripZeroWidth(value);
  }
  return '';
}

function cleanDocumentTitle(value: string): string {
  const title = stripZeroWidth(value).trim();
  for (const suffix of [' - 抖音', '_抖音', ' | 抖音']) {
    const index = title.lastIndexOf(suffix);
    if (index > 0) return title.slice(0, index).trim();
  }
  return title;
}

function isGenericDouyinText(value: string): boolean {
  const text = value.replace(/\s+/g, ' ').trim();
  return (
    !text ||
    text === '抖音' ||
    text.includes('抖音精选电脑版') ||
    text.includes('抖音旗下优质视频平台') ||
    text.includes('记录美好生活')
  );
}

function extractDescription(scope: ParentNode): string {
  const scoped = firstText(scope, [
    '[data-e2e="video-desc"]',
    '[data-e2e="video-title"]',
    '[data-e2e="aweme-desc"]',
  ]);
  if (scoped && !isGenericDouyinText(scoped)) return scoped;
  const meta = metaContent('og:description') || metaContent('description');
  return isGenericDouyinText(meta) ? '' : stripZeroWidth(meta).replace(/\s+/g, ' ').trim();
}

function extractAuthor(scope: ParentNode): string {
  return firstText(scope, [
    '[data-e2e="video-author-name"]',
    '[data-e2e="video-author"]',
    'a[href*="/user/"] [data-e2e="user-name"]',
    'a[href*="/user/"]',
  ]).replace(/^@/, '');
}

function tryDouyin(ctx: ExtractContext): ExtractedPage {
  const video = visibleVideo();
  const scope = playerScope(video);
  const description = extractDescription(scope);
  const author = extractAuthor(scope);
  const metaTitle = metaContent('og:title');
  const titleCandidate = firstText(scope, ['[data-e2e="video-title"]', 'h1']);
  const title =
    [titleCandidate, description, metaTitle, cleanDocumentTitle(document.title)].find(
      (value) => value && !isGenericDouyinText(value),
    )?.slice(0, 120) || '抖音视频';
  const cover = video?.poster || metaContent('og:image');
  const awemeId = extractDouyinAwemeId(ctx.url);
  const playerUrl = awemeId
    ? `https://open.douyin.com/player/video?vid=${encodeURIComponent(awemeId)}&autoplay=0`
    : '';
  const embed = playerUrl
    ? `<iframe src="${playerUrl}" width="100%" height="600" scrolling="no" ` +
      'frameborder="0" referrerpolicy="unsafe-url" allowfullscreen="true"></iframe>'
    : '';

  const parts: string[] = [];
  if (embed) parts.push(embed);
  else if (cover) parts.push(`![](${cover})`);
  if (description) parts.push(description);
  parts.push(`[在抖音中查看原视频](${ctx.url})`);

  const tags = cleanTags(
    Array.from(description.matchAll(/#([^\s#]+)/g), (match) => match[1]),
  );
  return {
    title,
    author,
    published: '',
    description: description.slice(0, 160),
    site: '抖音',
    domain: 'douyin.com',
    url: ctx.url,
    image: cover,
    contentMarkdown: parts.join('\n\n'),
    selectionMarkdown: htmlToMarkdown(ctx.selectionHtml),
    wordCount: description.length,
    highlights: ctx.highlights,
    tags: tags.length ? tags : undefined,
  };
}

export const douyinExtractor: SiteExtractor = {
  name: 'douyin',
  match: (ctx) => /(^|\.)douyin\.com$/i.test(ctx.hostname),
  extract: async (ctx) => tryDouyin(ctx),
};
