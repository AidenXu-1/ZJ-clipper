import { FeishuConfig, feishuJson } from './client';

/** 知识库列表项 */
export interface FeishuSpace {
  spaceId: string;
  name: string;
}

/** 知识库节点列表项 */
export interface FeishuNode {
  nodeToken: string;
  title: string;
  hasChild: boolean;
}

export async function listSpaces(cfg: FeishuConfig): Promise<FeishuSpace[]> {
  const out: FeishuSpace[] = [];
  let pageToken = '';
  do {
    const data = await feishuJson(cfg, '/open-apis/wiki/v2/spaces', {
      query: { page_size: '50', page_token: pageToken },
    });
    for (const it of data?.items || []) {
      out.push({ spaceId: it.space_id, name: it.name || '(未命名知识库)' });
    }
    pageToken = data?.has_more ? data?.page_token || '' : '';
  } while (pageToken);
  return out;
}

export async function listNodes(
  cfg: FeishuConfig,
  spaceId: string,
  parentToken = '',
): Promise<FeishuNode[]> {
  const out: FeishuNode[] = [];
  let pageToken = '';
  do {
    const data = await feishuJson(cfg, `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}/nodes`, {
      query: { page_size: '50', page_token: pageToken, parent_node_token: parentToken },
    });
    for (const it of data?.items || []) {
      out.push({ nodeToken: it.node_token, title: it.title || '(无标题)', hasChild: !!it.has_child });
    }
    pageToken = data?.has_more ? data?.page_token || '' : '';
  } while (pageToken);
  return out;
}

export async function getSpaceInfo(cfg: FeishuConfig, spaceId: string): Promise<FeishuSpace> {
  const data = await feishuJson(cfg, `/open-apis/wiki/v2/spaces/${encodeURIComponent(spaceId)}`);
  const sp = data?.space || {};
  return { spaceId: sp.space_id || spaceId, name: sp.name || '(知识库)' };
}

export async function getNodeInfo(
  cfg: FeishuConfig,
  token: string,
): Promise<{ spaceId: string; nodeToken: string; title: string }> {
  const data = await feishuJson(cfg, '/open-apis/wiki/v2/spaces/get_node', {
    query: { token, obj_type: 'wiki' },
  });
  const n = data?.node || {};
  if (!n.space_id) {
    throw new Error('未解析到知识库节点：请确认链接是飞书知识库（wiki）页面，且应用对它有访问权');
  }
  return { spaceId: n.space_id, nodeToken: n.node_token || token, title: n.title || '(无标题)' };
}

export function wikiWebUrl(cfg: FeishuConfig, nodeToken: string): string {
  if (!nodeToken || !cfg.host) return '';
  return `${cfg.host.replace(/\/+$/, '')}/wiki/${nodeToken}`;
}

export async function testFeishu(cfg: FeishuConfig): Promise<{ ok: boolean; msg: string }> {
  if (!cfg.appId.trim() || !cfg.appSecret.trim()) {
    return { ok: false, msg: '请先填写 App ID 与 App Secret' };
  }
  try {
    if (cfg.spaceId) {
      const sp = await getSpaceInfo(cfg, cfg.spaceId);
      if (cfg.parentToken) {
        const n = await getNodeInfo(cfg, cfg.parentToken);
        return { ok: true, msg: `连接成功：可访问「${sp.name} / ${n.title}」；实际写入权限会在保存时验证` };
      }
      return { ok: true, msg: `连接成功：可访问「${sp.name}」；实际写入权限会在保存时验证` };
    }
    const spaces = await listSpaces(cfg);
    if (!spaces.length) {
      return {
        ok: false,
        msg: '鉴权成功，但没有枚举到知识库。请直接粘贴目标知识库/页面链接定位；若仍失败，再检查应用是否已加入该知识库并发布上线。',
      };
    }
    return { ok: true, msg: `连接成功，可见 ${spaces.length} 个知识库 ✓` };
  } catch (e) {
    return { ok: false, msg: e instanceof Error ? e.message : String(e) };
  }
}
