import { FeishuConfig, feishuJson, feishuUpload } from './client';
import { wikiWebUrl } from './wiki';

/** 保留旧接口：import 方案暂不逐张上传图片，Markdown 中的公开图片交给飞书导入器解析。 */
export interface FeishuImage {
  url: string;
  base64: string;
  mime: string;
}

export interface FeishuSaveResult {
  url: string;
  imagesSaved: number;
  imagesTotal: number;
  lastError: string;
  warnings: string[];
  partial: boolean;
}

const IMPORT_TIMEOUT_MS = 90_000;
const MOVE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 1500;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sanitizeFileName(name: string): string {
  const n = (name || '未命名').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
  return (n || '未命名').slice(0, 120);
}

function pickString(obj: unknown, keys: string[]): string {
  const seen = new Set<unknown>();
  const walk = (x: unknown): string => {
    if (!x || typeof x !== 'object' || seen.has(x)) return '';
    seen.add(x);
    const rec = x as Record<string, unknown>;
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === 'string' && v) return v;
    }
    for (const v of Object.values(rec)) {
      const got = walk(v);
      if (got) return got;
    }
    return '';
  };
  return walk(obj);
}

function isDone(obj: unknown): boolean {
  const status = pickNumber(obj, ['job_status', 'status']);
  if (status === 0) return true;
  const raw = JSON.stringify(obj).toLowerCase();
  return /\b(success|succeeded|done|completed|finish|finished)\b/.test(raw);
}

function isFailed(obj: unknown): boolean {
  const status = pickNumber(obj, ['job_status', 'status']);
  if (status === -1 || (status != null && status !== 0 && status !== 1 && status !== 2)) return true;
  const raw = JSON.stringify(obj).toLowerCase();
  return /\b(fail|failed|error|timeout)\b/.test(raw);
}

function pickNumber(obj: unknown, keys: string[]): number | null {
  const seen = new Set<unknown>();
  const walk = (x: unknown): number | null => {
    if (!x || typeof x !== 'object' || seen.has(x)) return null;
    seen.add(x);
    const rec = x as Record<string, unknown>;
    for (const k of keys) {
      const v = rec[k];
      if (typeof v === 'number') return v;
      if (typeof v === 'string' && /^-?\d+$/.test(v)) return Number(v);
    }
    for (const v of Object.values(rec)) {
      const got = walk(v);
      if (got != null) return got;
    }
    return null;
  };
  return walk(obj);
}

async function uploadMarkdownFile(
  cfg: FeishuConfig,
  title: string,
  markdown: string,
): Promise<string> {
  const fileName = `${sanitizeFileName(title)}.md`;
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'ccm_import_open');
  form.append('size', String(blob.size));
  form.append('extra', JSON.stringify({ obj_type: 'docx', file_extension: 'md' }));
  form.append('file', blob, fileName);

  const data = await feishuUpload(cfg, '/open-apis/drive/v1/medias/upload_all', form);
  const token = pickString(data, ['file_token', 'token']);
  if (!token) throw new Error('Markdown 文件已上传，但飞书未返回 file_token');
  return token;
}

async function getRootFolderToken(cfg: FeishuConfig): Promise<string> {
  const data = await feishuJson(cfg, '/open-apis/drive/explorer/v2/root_folder/meta');
  const token = pickString(data, ['token']);
  if (!token) throw new Error('飞书未返回我的空间根目录 token，无法创建导入任务');
  return token;
}

async function createImportTask(cfg: FeishuConfig, title: string, fileToken: string): Promise<string> {
  const rootToken = await getRootFolderToken(cfg);
  const body = {
    file_extension: 'md',
    file_name: sanitizeFileName(title),
    file_token: fileToken,
    point: { mount_type: 1, mount_key: rootToken },
    type: 'docx',
  };
  const data = await feishuJson(cfg, '/open-apis/drive/v1/import_tasks', {
    method: 'POST',
    body,
  });
  const ticket = pickString(data, ['ticket', 'task_id', 'job_id', 'import_task_id']);
  if (!ticket) throw new Error('飞书导入任务已创建，但未返回任务 ticket');
  return ticket;
}

async function waitImportTask(cfg: FeishuConfig, ticket: string): Promise<string> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < IMPORT_TIMEOUT_MS) {
    const data = await feishuJson(cfg, `/open-apis/drive/v1/import_tasks/${encodeURIComponent(ticket)}`);
    const result = (data?.result && typeof data.result === 'object') ? data.result : data;
    const docToken = pickString(result, ['docx_token', 'document_id', 'obj_token', 'token']);
    if (docToken && isDone(data)) return docToken;
    if (docToken && !isFailed(data)) return docToken;
    if (isFailed(data)) throw new Error(`飞书导入失败：${JSON.stringify(data)}`);
    last = JSON.stringify(data);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`飞书导入超时：${last || ticket}`);
}

async function moveDocToWiki(cfg: FeishuConfig, docToken: string): Promise<string> {
  const body = {
    parent_wiki_token: cfg.parentToken || '',
    obj_type: 'docx',
    obj_token: docToken,
  };
  const data = await feishuJson(
    cfg,
    `/open-apis/wiki/v2/spaces/${encodeURIComponent(cfg.spaceId)}/nodes/move_docs_to_wiki`,
    { method: 'POST', body },
  );
  const nodeToken = pickString(data, ['node_token', 'wiki_token']);
  if (nodeToken) return nodeToken;

  const taskId = pickString(data, ['task_id', 'ticket']);
  if (!taskId) throw new Error(`飞书移动到知识库后未返回 node token：${JSON.stringify(data)}`);
  return waitMoveTask(cfg, taskId);
}

async function waitMoveTask(cfg: FeishuConfig, taskId: string): Promise<string> {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < MOVE_TIMEOUT_MS) {
    const data = await feishuJson(cfg, `/open-apis/wiki/v2/tasks/${encodeURIComponent(taskId)}`, {
      query: { task_type: 'move' },
    });
    const nodeToken = pickString(data, ['node_token', 'wiki_token']);
    if (nodeToken && isDone(data)) return nodeToken;
    if (nodeToken && !isFailed(data)) return nodeToken;
    if (isFailed(data)) throw new Error(`飞书移动失败：${JSON.stringify(data)}`);
    last = JSON.stringify(data);
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`飞书移动到知识库超时：${last || taskId}`);
}

export async function saveToFeishu(
  cfg: FeishuConfig,
  docTitle: string,
  markdown: string,
  _images: FeishuImage[] = [],
  onStage?: (msg: string) => void,
): Promise<FeishuSaveResult> {
  if (!cfg.appId.trim() || !cfg.appSecret.trim()) throw new Error('请先在设置里填写飞书 App ID / App Secret');
  if (!cfg.userAccessToken) throw new Error('请先在设置页点击「飞书登录授权」，飞书保存需要以用户身份写入');
  if (!cfg.spaceId) throw new Error('请先在设置里选择目标知识库');

  onStage?.('正在上传 Markdown 到飞书…');
  const fileToken = await uploadMarkdownFile(cfg, docTitle, markdown);

  onStage?.('正在导入为飞书文档…');
  const ticket = await createImportTask(cfg, docTitle, fileToken);
  const docToken = await waitImportTask(cfg, ticket);

  onStage?.('正在移动到目标知识库…');
  let nodeToken = '';
  try {
    nodeToken = await moveDocToWiki(cfg, docToken);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `${msg}。导入步骤已经生成临时飞书文档，可能留在你的「我的空间」根目录，请检查并手动删除重复文档。`,
    );
  }
  const url = wikiWebUrl(cfg, nodeToken);
  const warnings = url
    ? []
    : ['已保存到飞书；如需一键打开，请在设置里用「备用：用飞书链接定位保存位置」粘贴一次目标知识库链接'];

  return {
    url,
    imagesSaved: 0,
    imagesTotal: 0,
    lastError: warnings[0] || '',
    warnings,
    partial: false,
  };
}
