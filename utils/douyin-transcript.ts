const TRANSCRIPT_START = '<!-- nomo-douyin-transcript:start -->';
const TRANSCRIPT_END = '<!-- nomo-douyin-transcript:end -->';
import type { DouyinTranscribeResponse, TranscriptSegment } from '@/utils/types';

/** 通过 Chrome Native Messaging 按需启动本机 Whisper，不需要常驻黑色窗口。 */
export async function transcribeDouyinMedia(input: {
  mediaUrl?: string;
  audioBase64?: string;
  audioMime?: string;
  pageUrl: string;
  title: string;
}): Promise<Extract<DouyinTranscribeResponse, { ok: true }>> {
  const data = (await chrome.runtime.sendMessage({
    type: 'NOMO_CLIPPER_TRANSCRIBE_DOUYIN',
    ...input,
  })) as DouyinTranscribeResponse | undefined;
  if (!data?.ok) {
    throw new Error(data?.error || '无法启动 Nomo 本地字幕助手');
  }
  return data;
}

export function formatTranscriptTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 只替换由 Nomo 生成的抖音字幕区块，不改写用户手工正文。 */
export function upsertDouyinTranscript(markdown: string, segments: TranscriptSegment[]): string {
  const lines = segments
    .map((segment) => `${formatTranscriptTime(segment.start)} ${(segment.text || '').trim()}`)
    .filter((line) => /\S/.test(line));
  const block = [
    TRANSCRIPT_START,
    '## 抖音字幕',
    '',
    '> 由 Nomo 在本机进行语音识别，请结合原视频校对。',
    '',
    ...lines,
    TRANSCRIPT_END,
  ].join('\n');
  const start = markdown.indexOf(TRANSCRIPT_START);
  const end = markdown.indexOf(TRANSCRIPT_END);
  if (start >= 0 && end >= start) {
    const after = end + TRANSCRIPT_END.length;
    return `${markdown.slice(0, start).trimEnd()}\n\n${block}${markdown.slice(after)}`.trimStart();
  }
  const base = markdown.trimEnd();
  return `${base}${base ? '\n\n' : ''}${block}\n`;
}
