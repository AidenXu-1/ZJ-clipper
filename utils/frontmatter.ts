// 兆基clipper —— 由属性生成 YAML frontmatter
import { ClipProperties, ClipStats, Settings } from './types';

// 互动数据：内部英文字段 → frontmatter 中文键（跨平台归一，便于阅读+按数值排序）
export const STAT_LABELS: Array<[keyof ClipStats, string]> = [
  ['views', '播放'],
  ['likes', '点赞'],
  ['coins', '投币'],
  ['collects', '收藏'],
  ['comments', '评论'],
  ['shares', '分享'],
  ['bookmarks', '书签'],
  ['danmaku', '弹幕'],
];

/** 弹窗用：把互动数据拼成一行「播放 6万 · 点赞 …」可读文本 */
export function formatStatsLine(stats?: ClipStats): string {
  if (!stats) return '';
  return STAT_LABELS.filter(([k]) => typeof stats[k] === 'number')
    .map(([k, label]) => `${label} ${stats[k]}`)
    .join(' · ');
}

/** 对 YAML 标量做必要的转义/引号包裹 */
function yamlScalar(value: string): string {
  const v = (value ?? '').toString();
  if (v === '') return '""';
  // 含特殊字符时用双引号包裹并转义。换行/制表符必须转义成 \n \t——
  // 否则双引号标量里的裸换行会破坏 frontmatter 解析（title 是 textarea，用户可输入回车）。
  if (/[:#\[\]{}&*!|>'"%@`,\n\r\t]/.test(v) || /^\s|\s$/.test(v)) {
    return `"${v
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r?\n/g, '\\n')
      .replace(/\t/g, '\\t')}"`;
  }
  return v;
}

/**
 * 根据设置生成 frontmatter 字符串（含首尾 ---）。
 * 关闭 frontmatter 时返回空串。
 */
export function buildFrontmatter(props: ClipProperties, settings: Settings): string {
  if (!settings.includeFrontmatter) return '';

  const lines: string[] = ['---'];
  const f = settings.frontmatterFields;

  // title 始终写入
  lines.push(`title: ${yamlScalar(props.title)}`);
  // 学习状态：独立字段（已学习/未学习），与 tags 分开，避免被下游 Agent 重写关键词时冲掉
  if (props.learningStatus) lines.push(`学习状态: ${yamlScalar(props.learningStatus)}`);
  if (f.source && props.source) lines.push(`source: ${yamlScalar(props.source)}`);
  if (f.author && props.author) lines.push(`author: ${yamlScalar(props.author)}`);
  if (f.published && props.published) lines.push(`published: ${yamlScalar(props.published)}`);
  if (f.modified && props.modified) lines.push(`modified: ${yamlScalar(props.modified)}`);
  if (f.description && props.description) {
    // 描述折叠为单行，避免破坏 YAML
    lines.push(`description: ${yamlScalar(props.description.replace(/\s+/g, ' ').trim())}`);
  }
  if (f.clipped && props.clipped) lines.push(`clipped: ${yamlScalar(props.clipped)}`);
  if (f.tags && props.tags.length > 0) {
    lines.push('tags:');
    for (const tag of props.tags) lines.push(`  - ${yamlScalar(tag)}`);
  }
  // 用户自定义字段（固定写入，如 状态: 未读）；键去空白，值按标量转义
  if (settings.customFields?.length) {
    for (const cf of settings.customFields) {
      const k = (cf.key || '').trim();
      if (!k) continue;
      lines.push(`${k}: ${yamlScalar(cf.value || '')}`);
    }
  }
  // 互动数据不写入 frontmatter（中文键会被下游 agent 规范化 YAML 时洗掉）；
  // 改由调度层 prepend 到正文顶部（视频/链接上方），见 utils/extractors/index.ts。

  lines.push('---', '');
  return lines.join('\n');
}

/** 拼接最终笔记内容：frontmatter + 正文 */
export function composeNote(
  props: ClipProperties,
  body: string,
  settings: Settings,
): string {
  const fm = buildFrontmatter(props, settings);
  return fm ? `${fm}\n${body}\n` : `${body}\n`;
}
