// 兆基clipper —— 飞书/Lark 文档专用提取器
//  Defuddle 自动定位会选到 body（混入评论/点赞/导航），故强制指定正文容器并过滤噪声行。
// 注：本模块会被打进 content.js，受 ASCII 约束 —— 中文只可出现在字符串/Set 中，禁止进正则字面量。
import { ExtractedPage } from '@/utils/types';
import {
  ExtractContext,
  SiteExtractor,
  captureFullContent,
  htmlToMarkdown,
  parseWithSelector,
  stripZeroWidth,
} from '@/utils/extract-core';

/** 是否飞书/Lark 文档页，是则返回正文容器选择器 */
function feishuContentSelector(): string | null {
  if (!/feishu\.(cn|net)|larksuite\.com|larkoffice\.com/.test(location.hostname)) return null;
  for (const sel of ['.page-main-item.editor', '.editor-container', '.docx-page-block']) {
    if (document.querySelector(sel)) return sel;
  }
  return null;
}

// 飞书正文里仍可能混入的噪声行（评论/点赞/工具条/占位等）——用字符串集合，避免中文进正则
const FEISHU_JUNK = new Set([
  '附件不支持打印',
  '加载中...',
  '跳转至首条评论',
  '真诚点赞，手留余香',
  '当前工作表',
  '当前文档通知',
  '取消发送',
  '上传日志',
  '联系客服',
  '功能更新',
  '帮助中心',
  '效率指南',
]);

function isFeishuJunk(t: string): boolean {
  if (FEISHU_JUNK.has(t)) return true;
  if (/^\d+%$/.test(t)) return true; // 缩放/进度指示
  if (t.startsWith('评论（') && t.endsWith('）')) return true;
  const m = t.match(/^(\d+)\s*(\S+)$/); // “N 字”
  if (m && m[2] === '字') return true;
  return false;
}

/** 飞书正文清洗：去零宽字符 → 过滤噪声行 → 折叠多余空行 */
function cleanFeishuMarkdown(md: string): string {
  let s = stripZeroWidth(md);
  s = s
    .split('\n')
    .filter((line) => {
      const t = line.replace(/^[-*>\s]+/, '').trim();
      return !t || !isFeishuJunk(t);
    })
    .join('\n');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

async function extractFeishu(ctx: ExtractContext, sel: string): Promise<ExtractedPage> {
  const parsed = await parseWithSelector(ctx.url, sel);
  const defuddleMd = cleanFeishuMarkdown(htmlToMarkdown(parsed.content || ''));

  // 完整抓取：把滚动收集“限定在正文容器内”，排除目录/导航/侧栏/通知等
  let contentMarkdown = defuddleMd;
  if (ctx.fullCapture) {
    const scope = sel || parsed.debug?.contentSelector;
    const fullHtml = await captureFullContent(scope);
    const fullMd = cleanFeishuMarkdown(htmlToMarkdown(fullHtml));
    if (fullMd.length > defuddleMd.length) contentMarkdown = fullMd;
  }

  // 标题：去零宽字符 + 去掉“ - 飞书云文档”等站点后缀（用字符串而非正则避免中文进正则）
  let cleanTitle = stripZeroWidth(parsed.title || document.title || '未命名').trim();
  const sufIdx = cleanTitle.lastIndexOf('飞书云文档');
  if (sufIdx > 0) cleanTitle = cleanTitle.slice(0, sufIdx).replace(/[\s\-|]+$/, '').trim();

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
  };
}

export const feishuExtractor: SiteExtractor = {
  name: 'feishu',
  // 仅当确为飞书页且定位到正文容器时才接管；否则放行给通用适配器（与重构前一致）
  match: () => feishuContentSelector() !== null,
  extract: (ctx) => extractFeishu(ctx, feishuContentSelector()!),
};
