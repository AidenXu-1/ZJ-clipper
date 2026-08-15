import { apiBase, FeishuConfig } from './client';

export interface FeishuOAuthTokens {
  accessToken: string;
  refreshToken: string;
  expireAt: number;
}

function normalizeOAuthResponse(data: any, fallbackRefreshToken = ''): FeishuOAuthTokens {
  const d = data?.data && typeof data.data === 'object' ? data.data : data;
  const accessToken = d?.access_token || d?.user_access_token;
  if (!accessToken) {
    const err = data?.error_description || data?.msg || data?.error || JSON.stringify(data).slice(0, 300);
    throw new Error(`飞书授权成功，但未返回 access_token：${err}`);
  }
  const expiresIn = typeof d.expires_in === 'number' ? d.expires_in : 7200;
  return {
    accessToken,
    refreshToken: d.refresh_token || fallbackRefreshToken,
    expireAt: Date.now() + expiresIn * 1000,
  };
}

export function feishuRedirectUri(): string {
  return chrome.identity.getRedirectURL('feishu');
}

export async function authorizeFeishuUser(cfg: FeishuConfig): Promise<FeishuOAuthTokens> {
  if (!cfg.appId.trim() || !cfg.appSecret.trim()) throw new Error('请先填写 App ID 与 App Secret');

  const redirectUri = feishuRedirectUri();
  const state = Math.random().toString(36).slice(2);
  const scope = [
    'offline_access',
    'drive:file:upload',
    'drive:drive',
    'docs:document:import',
    'docs:document.media:upload',
    'docx:document.block:convert',
    'docx:document:create',
    'docx:document:write_only',
    'wiki:wiki',
  ].join(' ');
  const url =
    `${apiBase(cfg.domain)}/open-apis/authen/v1/index` +
    `?client_id=${encodeURIComponent(cfg.appId.trim())}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&scope=${encodeURIComponent(scope)}` +
    `&state=${encodeURIComponent(state)}`;

  const redirected = await chrome.identity.launchWebAuthFlow({ url, interactive: true });
  if (!redirected) throw new Error('飞书授权未返回结果');

  const ret = new URL(redirected);
  const err = ret.searchParams.get('error');
  if (err) throw new Error(`飞书授权失败：${err}`);
  if (ret.searchParams.get('state') !== state) throw new Error('飞书授权状态校验失败，请重试');
  const code = ret.searchParams.get('code');
  if (!code) throw new Error('飞书授权失败：未取得 code');

  const res = await fetch(`${apiBase(cfg.domain)}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: cfg.appId.trim(),
      client_secret: cfg.appSecret.trim(),
      code,
      redirect_uri: redirectUri,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data?.code != null && data?.code !== 0) {
    throw new Error(`飞书授权换 token 失败 ${data?.code}：${data?.msg || `HTTP ${res.status}`}`);
  }
  return normalizeOAuthResponse(data);
}

export async function refreshFeishuUserToken(
  cfg: FeishuConfig,
  refreshToken: string,
): Promise<FeishuOAuthTokens> {
  if (!refreshToken) throw new Error('缺少飞书 refresh_token，请重新登录授权');
  const res = await fetch(`${apiBase(cfg.domain)}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      grant_type: 'refresh_token',
      client_id: cfg.appId.trim(),
      client_secret: cfg.appSecret.trim(),
      refresh_token: refreshToken,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (data?.code != null && data?.code !== 0) {
    throw new Error(`飞书授权刷新失败 ${data?.code}：${data?.msg || `HTTP ${res.status}`}`);
  }
  return normalizeOAuthResponse(data, refreshToken);
}
