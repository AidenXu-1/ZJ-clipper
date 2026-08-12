// 兆基clipper —— 站点适配器注册表：按顺序匹配，首个命中即由其提取；generic 永远兜底。
//  加新平台 = 新增一个适配器文件 + 在 REGISTRY 里插一行，物理上碰不到其他平台。
import { ExtractedPage } from '@/utils/types';
import { ExtractContext, SiteExtractor } from '@/utils/extract-core';
import { formatStatsLine } from '@/utils/frontmatter';
import { biliExtractor } from './bilibili';
import { feishuExtractor } from './feishu';
import { xiaohongshuExtractor } from './xiaohongshu';
import { xExtractor } from './x';
import { weixinExtractor } from './weixin';
import { youtubeExtractor } from './youtube';
import { redditExtractor } from './reddit';
import { zhihuExtractor } from './zhihu';
import { genericExtractor } from './generic';

// 顺序即优先级；genericExtractor 必须最后（其 match 永远 true）
const REGISTRY: SiteExtractor[] = [
  biliExtractor,
  feishuExtractor,
  xiaohongshuExtractor,
  xExtractor,
  weixinExtractor,
  youtubeExtractor,
  redditExtractor,
  zhihuExtractor,
  genericExtractor,
];

/**
 * 互动数据放正文：若有 stats，把「**互动**：播放 X · 点赞 Y …」prepend 到正文顶部
 * （视频嵌入/作品链接的上方）。放正文而非 frontmatter——下游 agent 规范化 YAML 不会洗掉它。
 */
function prependStats(page: ExtractedPage): void {
  const line = formatStatsLine(page.stats);
  if (line) page.contentMarkdown = `**互动**：${line}\n\n${page.contentMarkdown}`;
}

/**
 * 调度抓取：遍历注册表，首个 match 命中且 extract 返回非 null 即采用。
 * 适配器返回 null 表示放行给下一个（如 B站 URL 命中但解析失败 → 落到通用）。
 */
export async function dispatchExtract(
  ctx: ExtractContext,
): Promise<{ page: ExtractedPage; matched: string }> {
  for (const a of REGISTRY) {
    if (a.match(ctx)) {
      const page = await a.extract(ctx);
      if (page) {
        prependStats(page);
        return { page, matched: a.name };
      }
    }
  }
  // 理论不可达（generic 永远 match 且非 null），仅为类型安全兜底
  const page = await genericExtractor.extract(ctx);
  return { page: page!, matched: genericExtractor.name };
}

/** 仅解析命中哪个适配器（不抓取），供 🔧 诊断报告 */
export function resolveAdapter(ctx: ExtractContext): string {
  for (const a of REGISTRY) if (a.match(ctx)) return a.name;
  return genericExtractor.name;
}
