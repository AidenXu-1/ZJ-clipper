const TIMESTAMP_HEADING = '## 时间戳笔记';

export function formatTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 用当前地址生成 B站回看链接，仅保留 BV、分 P 和时间点。 */
export function buildBilibiliTimestampUrl(currentUrl: string, seconds: number): string | null {
  const bvid = currentUrl.match(/bilibili\.com\/video\/(BV[0-9A-Za-z]+)/)?.[1];
  if (!bvid) return null;
  const current = new URL(currentUrl);
  const target = new URL(`/video/${bvid}`, current.origin);
  const part = current.searchParams.get('p');
  if (part && part !== '1') target.searchParams.set('p', part);
  target.searchParams.set('t', String(Math.max(0, Math.floor(seconds))));
  return target.toString();
}

/** 在唯一的“时间戳笔记”区块末尾追加一条，保留其余人工编辑内容。 */
export function appendTimestampNote(markdown: string, line: string): string {
  if (markdown.includes(line)) return markdown;
  const headingMatch = /^## 时间戳笔记\s*$/m.exec(markdown);
  if (!headingMatch) {
    const base = markdown.trimEnd();
    return `${base}${base ? '\n\n' : ''}${TIMESTAMP_HEADING}\n\n${line}\n`;
  }
  const sectionStart = headingMatch.index + headingMatch[0].length;
  const rest = markdown.slice(sectionStart);
  const nextHeading = /\n##\s+/.exec(rest);
  const insertAt = nextHeading ? sectionStart + nextHeading.index : markdown.length;
  const before = markdown.slice(0, insertAt).trimEnd();
  const after = markdown.slice(insertAt).replace(/^\n*/, '');
  return `${before}\n${line}\n${after ? `\n${after}` : ''}`;
}
