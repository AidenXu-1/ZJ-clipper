import type { SiteTagRule } from './types';

function cleanTag(tag: string): string {
  return tag.trim().replace(/^#+/, '');
}

/** 标签去空、去前导 #，并按大小写不敏感去重。 */
export function uniqueTags(tags: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = cleanTag(raw);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
  }
  return result;
}

function ruleDomain(input: string): string {
  const value = input.trim().toLowerCase();
  if (!value) return '';
  try {
    return new URL(value.includes('://') ? value : `https://${value}`).hostname.replace(/^www\./, '');
  } catch {
    return value.replace(/^https?:\/\//, '').split('/')[0].replace(/^www\./, '');
  }
}

/** 返回当前网址命中的站点标签；主域名规则同时匹配其子域名。 */
export function tagsForSite(url: string, rules: SiteTagRule[]): string[] {
  let hostname = '';
  try {
    hostname = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return [];
  }

  return uniqueTags(
    rules
      .filter((rule) => {
        const domain = ruleDomain(rule.domain);
        return domain && (hostname === domain || hostname.endsWith(`.${domain}`));
      })
      .map((rule) => rule.tag),
  );
}

/** 在 unread / 已学习之间切换，同时保留其他标签。 */
export function applyReadingStatus(
  tags: string[],
  learned: boolean,
  unreadTag: string,
  learnedTag: string,
): string[] {
  const statusKeys = new Set(
    [unreadTag, learnedTag].map(cleanTag).filter(Boolean).map((tag) => tag.toLowerCase()),
  );
  const otherTags = uniqueTags(tags).filter((tag) => !statusKeys.has(tag.toLowerCase()));
  const statusTag = cleanTag(learned ? learnedTag : unreadTag);
  return uniqueTags(statusTag ? [statusTag, ...otherTags] : otherTags);
}
