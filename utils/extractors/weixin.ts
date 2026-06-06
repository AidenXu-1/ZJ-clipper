// 兆基clipper —— 微信公众号文章专用提取器
//  公众号正文容器是稳定的 #js_content，但 Defuddle 认不出它（回退选中整个 body），
//  激进清洗时会把正文里的图片丢掉大半（实测 19 张只剩 1 张）。
//  故直接读 #js_content 的 DOM 转 Markdown，绕开 Defuddle，图片一张不丢。
//  图片为 mmbiz.qpic.cn 真实 https 地址（懒加载已 settle，src 即真实），可走本地图片下载。
// 注：本模块会被打进 content.js，受 ASCII 约束 —— 中文只可出现在字符串里，禁止进正则字面量。
import { ExtractedPage } from '@/utils/types';
import {
  ExtractContext,
  SiteExtractor,
  cleanMarkdown,
  htmlToMarkdown,
  metaContent,
  parseCjkDate,
  stripZeroWidth,
} from '@/utils/extract-core';

function tryWeixin(ctx: ExtractContext): ExtractedPage | null {
  const content = document.querySelector('#js_content');
  // 非文章页（如分享中转页/图片消息）无 #js_content → 放行给通用适配器
  if (!content) return null;

  const contentMarkdown = cleanMarkdown(htmlToMarkdown(content.innerHTML));
  if (!contentMarkdown) return null;

  const title = stripZeroWidth(
    (document.querySelector('#activity-name')?.textContent || '').trim() ||
      metaContent('og:title') ||
      document.title ||
      '公众号文章',
  ).trim();

  // 作者 = 公众号名（#js_name）；正文内的「XX 发自 XX」是文中署名，不取
  const author =
    (document.querySelector('#js_name')?.textContent || '').trim() ||
    metaContent('author');

  const published = parseCjkDate(
    (document.querySelector('#publish_time')?.textContent ||
      document.querySelector('em#publish_time')?.textContent ||
      '').trim(),
  );

  const bodyText = (content as HTMLElement).innerText || content.textContent || '';
  const description =
    metaContent('og:description') ||
    bodyText.replace(/\s+/g, ' ').trim().slice(0, 120);

  // 封面：og:image 优先；否则取正文首图
  let image = metaContent('og:image');
  if (!image) image = content.querySelector('img')?.getAttribute('src') || '';

  return {
    title: title || '公众号文章',
    author,
    published,
    description,
    site: '公众号',
    domain: 'mp.weixin.qq.com',
    url: ctx.url,
    image,
    contentMarkdown,
    selectionMarkdown: htmlToMarkdown(ctx.selectionHtml),
    wordCount: bodyText.replace(/\s+/g, '').length,
    highlights: ctx.highlights,
  };
}

export const weixinExtractor: SiteExtractor = {
  name: 'weixin',
  match: (ctx) =>
    /mp\.weixin\.qq\.com/.test(ctx.hostname) && !!document.querySelector('#js_content'),
  extract: async (ctx) => tryWeixin(ctx),
};
