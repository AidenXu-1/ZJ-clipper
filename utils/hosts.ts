// 兆基clipper —— 需登录鉴权才能访问图片的站点（轻量模块，后台与图片管线共用）
//
// 这些域名下的图片有两层含义：
// 1) Obsidian 无登录态，无法按链接预览，引用模式下需「下载到本地」；
// 2) 后台下载这些图时需带上该域名的 Cookie（credentials:'include'）才能取到。
// 公开站点（推特、博客等）不在此列：既能被 Obsidian 直接引用，下载时也无需带 Cookie。
export const AUTH_GATED_HOSTS = [
  'feishu.cn',
  'feishucdn.com',
  'feishu.net',
  'larksuite.com',
  'larkoffice.com',
  'larkcdn.com',
];

/** 该图片地址是否属于需登录鉴权的站点（命中即下载时带 Cookie、引用时改下载） */
export function isAuthGatedHost(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return AUTH_GATED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}
