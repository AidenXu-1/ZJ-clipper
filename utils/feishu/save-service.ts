import { base64ToBytes, FeishuConfig, feishuJson, feishuUpload } from './client';
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
const DIRECT_BLOCK_LIMIT = 1000;
const IMAGE_LIMIT = 40;

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

interface ConvertedDocument {
  blocks: Array<Record<string, unknown>>;
  firstLevelBlockIds: string[];
}

function stripReadonlyBlockFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripReadonlyBlockFields);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // 飞书转换接口返回的表格 merge_info 为只读字段，创建嵌套块时必须移除。
    if (key === 'merge_info') continue;
    out[key] = stripReadonlyBlockFields(item);
  }
  return out;
}

async function convertMarkdown(cfg: FeishuConfig, markdown: string): Promise<ConvertedDocument> {
  const data = await feishuJson(cfg, '/open-apis/docx/v1/documents/blocks/convert', {
    method: 'POST',
    body: { content_type: 'markdown', content: markdown },
  });
  const blocks = Array.isArray(data?.blocks)
    ? (stripReadonlyBlockFields(data.blocks) as Array<Record<string, unknown>>)
    : [];
  const firstLevelBlockIds = Array.isArray(data?.first_level_block_ids)
    ? data.first_level_block_ids.filter((id: unknown): id is string => typeof id === 'string' && !!id)
    : [];
  if (blocks.length > DIRECT_BLOCK_LIMIT) {
    throw new Error(`正文转换后有 ${blocks.length} 个文档块，超过直接写入上限`);
  }
  if (blocks.length > 0 && firstLevelBlockIds.length === 0) {
    throw new Error('飞书已转换正文，但未返回一级文档块');
  }
  return { blocks, firstLevelBlockIds };
}

async function createDirectDocument(cfg: FeishuConfig, title: string): Promise<string> {
  const data = await feishuJson(cfg, '/open-apis/docx/v1/documents', {
    method: 'POST',
    body: { title: sanitizeFileName(title) },
  });
  const token = pickString(data, ['document_id', 'docx_token', 'token']);
  if (!token) throw new Error('飞书已创建文档，但未返回 document_id');
  return token;
}

async function insertConvertedBlocks(
  cfg: FeishuConfig,
  documentId: string,
  converted: ConvertedDocument,
): Promise<string[]> {
  if (converted.blocks.length === 0) return [];
  const data = await feishuJson(
    cfg,
    `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(documentId)}/descendant`,
    {
      method: 'POST',
      query: { document_revision_id: '-1' },
      body: {
        index: -1,
        children_id: converted.firstLevelBlockIds,
        descendants: converted.blocks,
      },
    },
  );
  return collectCreatedImageBlockIds(data);
}

/**
 * 创建嵌套块接口已经返回新建块及其真实 block_id。直接消费该响应，避免为了
 * 找图片块再读取整篇文档；后者不仅更慢，还会额外要求 readonly OAuth 权限。
 */
function collectCreatedImageBlockIds(data: unknown): string[] {
  const blocks = new Map<string, Record<string, unknown>>();
  const encounterOrder: string[] = [];
  const seen = new Set<unknown>();

  const collect = (value: unknown): void => {
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      value.forEach(collect);
      return;
    }
    const record = value as Record<string, unknown>;
    if (typeof record.block_id === 'string' && typeof record.block_type === 'number') {
      if (!blocks.has(record.block_id)) encounterOrder.push(record.block_id);
      blocks.set(record.block_id, record);
    }
    Object.values(record).forEach(collect);
  };
  collect(data);

  const referenced = new Set<string>();
  for (const block of blocks.values()) {
    if (!Array.isArray(block.children)) continue;
    for (const id of block.children) if (typeof id === 'string') referenced.add(id);
  }

  const ids: string[] = [];
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const block = blocks.get(id);
    if (!block) return;
    if (block.block_type === 27) ids.push(id);
    if (Array.isArray(block.children)) {
      for (const child of block.children) if (typeof child === 'string') visit(child);
    }
  };

  // 先按树顺序遍历；若响应没有完整 parent/children 关系，再按接口返回顺序兜底。
  encounterOrder.filter((id) => !referenced.has(id)).forEach(visit);
  encounterOrder.forEach(visit);
  return ids;
}

function markdownImageUrls(markdown: string): string[] {
  const out: string[] = [];
  const re = /!\[[^\]]*\]\(((?:https?:\/\/|blob:)[^)\s]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) && out.length < IMAGE_LIMIT) {
    const url = match[1];
    if (/(youtube\.com|youtu\.be|player\.bilibili\.com|bilibili\.com\/video|vimeo\.com)/.test(url)) continue;
    out.push(url);
  }
  return out;
}

function imageExtension(mime: string): string {
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg';
  if (mime.includes('webp')) return 'webp';
  if (mime.includes('gif')) return 'gif';
  if (mime.includes('svg')) return 'svg';
  if (mime.includes('avif')) return 'avif';
  return 'png';
}

async function uploadImageToBlock(
  cfg: FeishuConfig,
  documentId: string,
  blockId: string,
  image: FeishuImage,
  index: number,
): Promise<void> {
  const bytes = base64ToBytes(image.base64);
  if (bytes.byteLength > 20 * 1024 * 1024) throw new Error('图片超过飞书 20MB 上限');
  const fileName = `image-${String(index + 1).padStart(2, '0')}.${imageExtension(image.mime)}`;
  const blob = new Blob([Uint8Array.from(bytes)], { type: image.mime || 'image/png' });
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'docx_image');
  form.append('parent_node', blockId);
  form.append('size', String(blob.size));
  form.append('file', blob, fileName);
  const uploaded = await feishuUpload(cfg, '/open-apis/drive/v1/medias/upload_all', form);
  const token = pickString(uploaded, ['file_token', 'token']);
  if (!token) throw new Error('飞书图片上传成功，但未返回 file_token');
  await feishuJson(
    cfg,
    `/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks/${encodeURIComponent(blockId)}`,
    { method: 'PATCH', body: { replace_image: { token } } },
  );
}

async function attachDocumentImages(
  cfg: FeishuConfig,
  documentId: string,
  blockIds: string[],
  markdown: string,
  images: FeishuImage[],
  onStage?: (msg: string) => void,
): Promise<{ saved: number; total: number; lastError: string }> {
  const urls = markdownImageUrls(markdown);
  if (urls.length === 0) return { saved: 0, total: 0, lastError: '' };
  const byUrl = new Map(images.map((image) => [image.url, image]));
  const total = Math.min(urls.length, blockIds.length);
  let cursor = 0;
  let completed = 0;
  let saved = 0;
  let lastError = blockIds.length < urls.length ? `只创建了 ${blockIds.length}/${urls.length} 个图片块` : '';
  async function worker(): Promise<void> {
    while (true) {
      const index = cursor++;
      if (index >= total) return;
      const image = byUrl.get(urls[index]);
      try {
        if (!image) throw new Error('网页图片下载失败');
        await uploadImageToBlock(cfg, documentId, blockIds[index], image, index);
        saved++;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      } finally {
        completed++;
        onStage?.(`正在上传配图 ${completed}/${urls.length}…`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(2, total) }, () => worker()));
  return { saved, total: urls.length, lastError };
}

async function saveViaDirectBlocks(
  cfg: FeishuConfig,
  docTitle: string,
  markdown: string,
  images: FeishuImage[],
  converted: ConvertedDocument,
  onStage?: (msg: string) => void,
): Promise<FeishuSaveResult> {
  onStage?.('正在创建飞书文档…');
  const documentId = await createDirectDocument(cfg, docTitle);
  try {
    onStage?.('正在写入文档内容…');
    const imageBlockIds = await insertConvertedBlocks(cfg, documentId, converted);
    const imageResult = await attachDocumentImages(cfg, documentId, imageBlockIds, markdown, images, onStage);
    onStage?.('正在保存到目标知识库…');
    const nodeToken = await moveDocToWiki(cfg, documentId);
    const url = wikiWebUrl(cfg, nodeToken);
    const warnings: string[] = [];
    if (imageResult.saved < imageResult.total) {
      warnings.push(`有 ${imageResult.total - imageResult.saved} 张图片未能上传`);
    }
    if (!url) warnings.push('已保存到飞书，但尚未配置用于打开文档的飞书站点地址');
    return {
      url,
      imagesSaved: imageResult.saved,
      imagesTotal: imageResult.total,
      lastError: imageResult.lastError || warnings[0] || '',
      warnings,
      partial: imageResult.saved < imageResult.total,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}。飞书已经在「我的空间」创建了临时文档，请先检查后再重试，避免重复。`);
  }
}

async function saveViaImportTask(
  cfg: FeishuConfig,
  docTitle: string,
  markdown: string,
  onStage?: (msg: string) => void,
  fallbackReason = '',
): Promise<FeishuSaveResult> {
  onStage?.('新接口暂不可用，正在使用兼容保存…');
  const fileToken = await uploadMarkdownFile(cfg, docTitle, markdown);
  onStage?.('正在导入为飞书文档…');
  const ticket = await createImportTask(cfg, docTitle, fileToken);
  const docToken = await waitImportTask(cfg, ticket);
  onStage?.('正在移动到目标知识库…');
  let nodeToken = '';
  try {
    nodeToken = await moveDocToWiki(cfg, docToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${message}。导入步骤已经生成临时飞书文档，可能留在你的「我的空间」根目录，请检查并手动删除重复文档。`);
  }
  const url = wikiWebUrl(cfg, nodeToken);
  const warnings = [
    ...(fallbackReason ? [`已使用兼容保存：${fallbackReason}`] : []),
    ...(!url ? ['已保存到飞书；请在设置里配置飞书站点地址以便一键打开'] : []),
  ];
  return {
    url,
    imagesSaved: 0,
    imagesTotal: markdownImageUrls(markdown).length,
    lastError: warnings[0] || '',
    warnings,
    partial: warnings.length > 0,
  };
}

export async function saveToFeishu(
  cfg: FeishuConfig,
  docTitle: string,
  markdown: string,
  images: FeishuImage[] = [],
  onStage?: (msg: string) => void,
): Promise<FeishuSaveResult> {
  if (!cfg.appId.trim() || !cfg.appSecret.trim()) throw new Error('请先在设置里填写飞书 App ID / App Secret');
  if (!cfg.userAccessToken) throw new Error('请先在设置页点击「飞书登录授权」，飞书保存需要以用户身份写入');
  if (!cfg.spaceId) throw new Error('请先在设置里选择目标知识库');

  onStage?.('正在转换文档内容…');
  let converted: ConvertedDocument;
  try {
    converted = await convertMarkdown(cfg, markdown);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return saveViaImportTask(cfg, docTitle, markdown, onStage, reason);
  }
  return saveViaDirectBlocks(cfg, docTitle, markdown, images, converted, onStage);
}
