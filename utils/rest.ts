// Nomo Clipper —— 通过 Obsidian「Local REST API」插件直接写入仓库
// 插件文档：https://github.com/coddingtonbear/obsidian-local-rest-api
// 端点：PUT /vault/{path}  创建/覆盖文件；GET /  查询状态与鉴权

export interface RestConfig {
  baseUrl: string;
  apiKey: string;
}

function normBase(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

/** 容错：去掉用户可能误粘的 "Bearer " 前缀与首尾空格，再拼成鉴权头 */
function authHeader(apiKey: string): string {
  const key = apiKey.trim().replace(/^Bearer\s+/i, '');
  return `Bearer ${key}`;
}

/** 把仓库内路径编码为 /vault/ 后的安全路径（不含 .md，函数内补上） */
function vaultUrl(baseUrl: string, filePath: string): string {
  const encoded = filePath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  return `${normBase(baseUrl)}/vault/${encoded}.md`;
}

/** 创建（或覆盖）一篇笔记 */
export async function saveViaRest(
  cfg: RestConfig,
  filePath: string,
  content: string,
): Promise<void> {
  let res: Response;
  try {
    res = await fetch(vaultUrl(cfg.baseUrl, filePath), {
      method: 'PUT',
      headers: {
        Authorization: authHeader(cfg.apiKey),
        'Content-Type': 'text/markdown; charset=utf-8',
      },
      body: content,
    });
  } catch {
    throw new Error(
      '无法连接到 Obsidian：请确认已安装并启用 Local REST API 插件，且已开启 HTTP 服务、地址填写正确',
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error('鉴权失败：API Key 不正确');
  }
  if (!res.ok) {
    throw new Error(`保存失败：HTTP ${res.status} ${res.statusText}`);
  }
}

/**
 * 查询仓库内是否已存在该笔记。
 * 只有明确 404 才是“不存在”；网络、鉴权和服务异常必须阻断保存，
 * 避免把检查失败误判成可安全创建并覆盖已有笔记。
 */
export async function checkFileState(
  cfg: RestConfig,
  filePath: string,
): Promise<'exists' | 'missing'> {
  let res: Response;
  try {
    res = await fetch(vaultUrl(cfg.baseUrl, filePath), {
      method: 'GET',
      headers: { Authorization: authHeader(cfg.apiKey) },
    });
  } catch {
    throw new Error('无法确认目标笔记是否存在：请检查 Obsidian Local REST API 连接');
  }
  if (res.status === 404) return 'missing';
  if (res.status === 401 || res.status === 403) {
    throw new Error('无法确认目标笔记：API Key 鉴权失败');
  }
  if (!res.ok) {
    throw new Error(`无法确认目标笔记：HTTP ${res.status} ${res.statusText}`);
  }
  return 'exists';
}

/** 为“另存副本”寻找首个明确不存在的路径；任何检查异常都会中止。 */
export async function findAvailableCopyPath(
  cfg: RestConfig,
  filePath: string,
): Promise<string> {
  const slash = filePath.lastIndexOf('/');
  const folder = slash >= 0 ? filePath.slice(0, slash + 1) : '';
  const rawName = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const name = rawName.replace(/ \(副本(?: \d+)?\)$/, '');
  for (let i = 1; i <= 99; i++) {
    const suffix = i === 1 ? ' (副本)' : ` (副本 ${i})`;
    const candidate = `${folder}${name}${suffix}`;
    if ((await checkFileState(cfg, candidate)) === 'missing') return candidate;
  }
  throw new Error('同名副本过多，请修改文件名后再保存');
}

/** 写入二进制文件（图片附件）到仓库 filePath（含扩展名） */
export async function putBinary(
  cfg: RestConfig,
  filePath: string,
  bytes: Uint8Array,
  mime: string,
): Promise<void> {
  const encoded = filePath
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent)
    .join('/');
  const res = await fetch(`${normBase(cfg.baseUrl)}/vault/${encoded}`, {
    method: 'PUT',
    headers: { Authorization: authHeader(cfg.apiKey), 'Content-Type': mime || 'application/octet-stream' },
    body: bytes as unknown as BodyInit,
  });
  if (!res.ok) throw new Error(`写入图片失败：HTTP ${res.status}`);
}

/** 测试连接与鉴权（请求需要鉴权的 /vault/ 端点，以状态码判定，最可靠） */
export async function testRest(cfg: RestConfig): Promise<{ ok: boolean; msg: string }> {
  let res: Response;
  try {
    res = await fetch(`${normBase(cfg.baseUrl)}/vault/`, {
      headers: { Authorization: authHeader(cfg.apiKey) },
    });
  } catch {
    return {
      ok: false,
      msg: '无法连接：请检查插件是否启用、HTTP 服务是否开启、地址是否正确',
    };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, msg: 'API Key 不正确：请在插件里重新复制（注意首尾不要有空格）' };
  }
  if (res.ok) {
    return { ok: true, msg: '连接成功，鉴权通过 ✓' };
  }
  return { ok: false, msg: `连接失败：HTTP ${res.status} ${res.statusText}` };
}
