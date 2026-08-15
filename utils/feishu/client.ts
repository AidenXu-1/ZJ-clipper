// 飞书开放平台基础客户端：鉴权、JSON 请求、multipart 上传、错误归一化。
import { FeishuDomain } from '@/utils/types';

/** 飞书保存所需配置（来自 VaultProfile 的飞书字段） */
export interface FeishuConfig {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  /** 目标知识库 space_id */
  spaceId: string;
  /** 目标父节点 token，空=知识库根 */
  parentToken: string;
  /** 租户站点域名（如 https://xxx.feishu.cn），用于拼"打开"链接 */
  host?: string;
  /** 用户 OAuth token：存在时优先以用户身份请求飞书 API */
  userAccessToken?: string;
  /** 用户 OAuth refresh token：access token 过期时自动续期 */
  userRefreshToken?: string;
  userTokenExpireAt?: number;
  /** token 自动续期后回写到调用方存储 */
  onUserTokenRefresh?: (tokens: { accessToken: string; refreshToken: string; expireAt: number }) => void | Promise<void>;
}

interface CachedToken {
  token: string;
  expireAt: number;
}

const tokenCache = new Map<string, CachedToken>();
const JSON_TIMEOUT_MS = 20_000;
const UPLOAD_TIMEOUT_MS = 60_000;

async function fetchJsonWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string,
): Promise<{ res: Response; data: any }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`${label}超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    throw new Error(`无法连接飞书开放平台，请检查网络（${label}）`);
  } finally {
    clearTimeout(timer);
  }
}

export function apiBase(domain: FeishuDomain): string {
  return domain === 'larksuite.com' ? 'https://open.larksuite.com' : 'https://open.feishu.cn';
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function tokenKey(cfg: FeishuConfig): string {
  return `${cfg.domain}:${cfg.appId.trim()}`;
}

function errorHint(code: unknown): string {
  const c = String(code || '');
  if (c.startsWith('99991')) return '（多为应用权限不足，或应用未加为知识库协作者）';
  if (c === '1061004') return '（多为应用没有目标空间/知识库写入权限）';
  return '';
}

async function refreshUserToken(cfg: FeishuConfig): Promise<string> {
  if (!cfg.userRefreshToken) throw new Error('飞书用户授权已过期，请在设置页重新点击「飞书登录授权」');
  const { res, data } = await fetchJsonWithTimeout(
    `${apiBase(cfg.domain)}/open-apis/authen/v2/oauth/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        client_id: cfg.appId.trim(),
        client_secret: cfg.appSecret.trim(),
        refresh_token: cfg.userRefreshToken,
      }),
    },
    JSON_TIMEOUT_MS,
    '刷新飞书授权',
  );
  if (data?.code != null && data?.code !== 0) {
    throw new Error(`飞书授权刷新失败 ${data?.code}：${data?.msg || `HTTP ${res.status}`}，请重新登录授权`);
  }
  const d = data?.data && typeof data.data === 'object' ? data.data : data;
  const accessToken = d?.access_token || d?.user_access_token;
  if (!accessToken) throw new Error('飞书授权刷新成功，但未返回 access_token，请重新登录授权');
  const expiresIn = typeof d.expires_in === 'number' ? d.expires_in : 7200;
  const next = {
    accessToken,
    refreshToken: d.refresh_token || cfg.userRefreshToken,
    expireAt: Date.now() + expiresIn * 1000,
  };
  cfg.userAccessToken = next.accessToken;
  cfg.userRefreshToken = next.refreshToken;
  cfg.userTokenExpireAt = next.expireAt;
  await cfg.onUserTokenRefresh?.(next);
  return next.accessToken;
}

async function authToken(cfg: FeishuConfig): Promise<string> {
  if (cfg.userAccessToken) {
    if ((cfg.userTokenExpireAt || 0) - 60_000 > Date.now()) return cfg.userAccessToken;
    return refreshUserToken(cfg);
  }
  return getTenantToken(cfg);
}

export async function getTenantToken(cfg: FeishuConfig): Promise<string> {
  const key = tokenKey(cfg);
  const cached = tokenCache.get(key);
  if (cached && cached.expireAt - 60_000 > Date.now()) return cached.token;

  const { res, data } = await fetchJsonWithTimeout(
    `${apiBase(cfg.domain)}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: cfg.appId.trim(), app_secret: cfg.appSecret.trim() }),
    },
    JSON_TIMEOUT_MS,
    '飞书鉴权',
  );
  if (data?.code !== 0 || !data?.tenant_access_token) {
    throw new Error(`飞书鉴权失败：${data?.msg || `HTTP ${res.status}`}（请检查 App ID / App Secret）`);
  }
  const ttl = (typeof data.expire === 'number' ? data.expire : 7200) * 1000;
  tokenCache.set(key, { token: data.tenant_access_token, expireAt: Date.now() + ttl });
  return data.tenant_access_token;
}

export async function feishuJson(
  cfg: FeishuConfig,
  path: string,
  init: { method?: string; query?: Record<string, string>; body?: unknown } = {},
): Promise<any> {
  const token = await authToken(cfg);
  let url = `${apiBase(cfg.domain)}${path}`;
  if (init.query) {
    const qs = Object.entries(init.query)
      .filter(([, v]) => v != null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
    if (qs) url += `?${qs}`;
  }

  const { res, data } = await fetchJsonWithTimeout(
    url,
    {
      method: init.method || 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: init.body == null ? undefined : JSON.stringify(init.body),
    },
    JSON_TIMEOUT_MS,
    '飞书接口请求',
  );
  if (data?.code !== 0) {
    throw new Error(`飞书接口错误 ${data?.code}：${data?.msg || `HTTP ${res.status}`}${errorHint(data?.code)}`);
  }
  return data.data;
}

export async function feishuUpload(
  cfg: FeishuConfig,
  path: string,
  form: FormData,
): Promise<any> {
  const token = await authToken(cfg);
  const { res, data } = await fetchJsonWithTimeout(
    `${apiBase(cfg.domain)}${path}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    },
    UPLOAD_TIMEOUT_MS,
    '飞书文件上传',
  );
  if (data?.code !== 0) {
    throw new Error(`飞书上传失败 ${data?.code}：${data?.msg || `HTTP ${res.status}`}${errorHint(data?.code)}`);
  }
  return data.data;
}
