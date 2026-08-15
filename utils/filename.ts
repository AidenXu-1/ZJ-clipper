// Nomo Clipper —— 文件名安全化 & 文件名模板渲染

/** 去除文件名中的非法字符（Obsidian / Windows / macOS 通用） */
export function safeName(name: string): string {
  return (
    name
      .replace(/[\u0000-\u001F\u007F]/g, '') // 控制字符
      .replace(/[\\/:*?"<>|#^[\]]/g, ' ') // 非法/保留字符
      .replace(/\s+/g, ' ')
      .replace(/^\.+/, '') // 开头的点
      .replace(/[. ]+$/, '') // 结尾的点/空格（Windows/同步盘非法）
      .trim()
      .slice(0, 200) || // 防止过长
    '未命名'
  );
}

/** 渲染文件名模板，支持 {{title}} {{date}} */
export function renderFilename(
  template: string,
  vars: { title: string; date: string },
): string {
  const out = (template || '{{title}}')
    .replace(/\{\{\s*title\s*\}\}/g, vars.title)
    .replace(/\{\{\s*date\s*\}\}/g, vars.date);
  return safeName(out);
}

// 域名 → 渠道名
const CHANNELS: Array<[RegExp, string]> = [
  [/feishu|larksuite|larkoffice/, '飞书'],
  [/bilibili/, 'B站'],
  [/youtube|youtu\.be/, 'YouTube'],
  [/mp\.weixin\.qq\.com/, '公众号'],
  [/zhihu/, '知乎'],
  [/xiaohongshu|xhslink/, '小红书'],
  [/weibo/, '微博'],
  [/juejin/, '掘金'],
  [/jianshu/, '简书'],
  [/github/, 'GitHub'],
  [/medium\.com/, 'Medium'],
  [/notion\./, 'Notion'],
  [/douyin/, '抖音'],
  [/(^|\.)x\.com|twitter/, 'X'],
  [/reddit/, 'Reddit'],
];

/** 根据域名/站点名推断渠道名 */
export function channelName(domain: string, site?: string): string {
  const d = (domain || '').toLowerCase();
  for (const [re, name] of CHANNELS) if (re.test(d)) return name;
  if (site && site.trim()) return site.trim();
  const parts = d.replace(/^www\./, '').split('.');
  return parts.length >= 2 ? parts[parts.length - 2] : d || '网页';
}

/** 渲染子文件夹名，支持 {{date}} {{channel}} {{title}} */
export function renderFolderName(
  template: string,
  vars: { date: string; channel: string; title: string },
): string {
  const out = (template || '{{date}}-{{channel}}-{{title}}')
    .replace(/\{\{\s*date\s*\}\}/g, vars.date)
    .replace(/\{\{\s*channel\s*\}\}/g, vars.channel)
    .replace(/\{\{\s*title\s*\}\}/g, vars.title);
  return safeName(out);
}

/** YYYY-MM-DD（frontmatter 日期属性用，Obsidian 标准格式） */
export function today(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** YYYYMMDD（文件夹/文件名模板的 {{date}} 用，避免与分隔符 - 撞在一起） */
export function todayCompact(d: Date = new Date()): string {
  return today(d).replace(/-/g, '');
}
