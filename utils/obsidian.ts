// Nomo Clipper —— 构造 obsidian://new URI
// 文档：https://help.obsidian.md/Extending+Obsidian/Obsidian+URI

export interface ObsidianTarget {
  vault: string;
  /** 仓库内相对路径，含文件夹与文件名（不带 .md） */
  filePath: string;
  /** 笔记完整内容 */
  content: string;
}

/**
 * 构造 obsidian://new URI。
 * 使用 encodeURIComponent 编码各参数，Obsidian 会按 file 路径创建笔记。
 */
export function buildObsidianUri({ vault, filePath, content }: ObsidianTarget): string {
  const params = new URLSearchParams();
  params.set('vault', vault);
  params.set('file', filePath);
  params.set('content', content);
  // 注意：Obsidian URI 的布尔参数“只要存在即为 true”，
  // 所以这里不传 append/overwrite，保持默认“新建笔记”。
  // URLSearchParams 用 + 表示空格，Obsidian URI 更兼容 %20
  return `obsidian://new?${params.toString().replace(/\+/g, '%20')}`;
}

/**
 * 构造 obsidian://open URI，用于保存后跳转到该笔记。
 * vault 为空时省略（Obsidian 在含该文件的仓库中打开）。
 */
export function buildOpenUri(vault: string, filePath: string): string {
  const params = new URLSearchParams();
  if (vault.trim()) params.set('vault', vault.trim());
  params.set('file', filePath);
  return `obsidian://open?${params.toString().replace(/\+/g, '%20')}`;
}

/** 经验阈值：obsidian:// URI 过长在部分系统会被截断 */
export const URI_LENGTH_WARN = 8000;
