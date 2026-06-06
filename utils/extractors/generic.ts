// 兆基clipper —— 通用提取器：Defuddle 自动定位正文 → Turndown 转 Markdown。
//  作为注册表的最后兜底，match 永远 true。YouTube 等站点经 Defuddle 的异步 extractor 在此路径生效。
import { ExtractedPage } from '@/utils/types';
import {
  ExtractContext,
  SiteExtractor,
  captureFullContent,
  cleanMarkdown,
  cleanTags,
  htmlToMarkdown,
  pageMetaTags,
  parseWithSelector,
  stripZeroWidth,
} from '@/utils/extract-core';

async function extractGeneric(ctx: ExtractContext): Promise<ExtractedPage> {
  // Defuddle 提取正文 + 元数据 + 正文容器选择器（contentSelector）
  // parseAsync 会触发 YouTube 等站点的异步 extractor（含字幕 transcript）
  const parsed = await parseWithSelector(ctx.url);
  const defuddleMd = cleanMarkdown(htmlToMarkdown(parsed.content || ''));

  // 完整抓取：把滚动收集限定在 Defuddle 选中的正文容器内，排除目录/导航/侧栏等
  let contentMarkdown = defuddleMd;
  if (ctx.fullCapture) {
    const scope = parsed.debug?.contentSelector;
    const fullHtml = await captureFullContent(scope);
    const fullMd = cleanMarkdown(htmlToMarkdown(fullHtml));
    if (fullMd.length > defuddleMd.length) contentMarkdown = fullMd;
  }

  const cleanTitle = stripZeroWidth(parsed.title || document.title || '未命名').trim();
  const tags = cleanTags(pageMetaTags()); // 页面声明的 meta keywords / article:tag，纯提取

  return {
    title: cleanTitle || '未命名',
    author: parsed.author || '',
    published: parsed.published || '',
    description: parsed.description || '',
    site: parsed.site || '',
    domain: parsed.domain || location.hostname,
    url: ctx.url,
    image: parsed.image || '',
    contentMarkdown,
    selectionMarkdown: htmlToMarkdown(ctx.selectionHtml),
    wordCount: parsed.wordCount || 0,
    highlights: ctx.highlights,
    tags: tags.length ? tags : undefined,
  };
}

export const genericExtractor: SiteExtractor = {
  name: 'generic',
  match: () => true,
  extract: (ctx) => extractGeneric(ctx),
};
