// 兆基clipper —— 全局类型定义

/** content script 提取并回传给 popup 的页面数据 */
export interface ExtractedPage {
  /** 文章标题 */
  title: string;
  /** 作者（可能为空） */
  author: string;
  /** 发布日期 ISO 字符串（可能为空） */
  published: string;
  /** 最后修改日期 ISO 字符串（可能为空） */
  modified?: string;
  /** 页面描述/摘要 */
  description: string;
  /** 站点名 */
  site: string;
  /** 域名 */
  domain: string;
  /** 当前页面 URL */
  url: string;
  /** 社交分享图 URL */
  image: string;
  /** 正文（Obsidian Markdown） */
  contentMarkdown: string;
  /** 选区内容（Markdown），无选区则为空 */
  selectionMarkdown: string;
  /** 字数 */
  wordCount: number;
  /** 本页已保存的高亮文本（按顺序） */
  highlights: string[];
  /** 页面自带的标签（B站视频标签/小红书话题/meta keywords 等，纯提取非AI），注入弹窗 tags */
  tags?: string[];
  /** 已就地解析为 base64 的图片（blob: 等后台无法下载的图，由内容脚本在页面上下文解析） */
  inlineImages?: Array<{ url: string; base64: string; mime: string }>;
  /** 互动数据（归一化数字字段，写入 frontmatter 便于排序/检索） */
  stats?: ClipStats;
}

/** 互动数据（归一化）：各平台把自己的指标映射到这些通用数字字段 */
export interface ClipStats {
  views?: number; // 播放/浏览
  likes?: number; // 点赞/赞/喜欢
  coins?: number; // 投币（B站）
  collects?: number; // 收藏
  comments?: number; // 评论/回复
  shares?: number; // 分享/转发/转推
  bookmarks?: number; // 书签（X）
  danmaku?: number; // 弹幕（B站）
}

/** 用户在弹窗里可编辑的属性（写入 frontmatter） */
export interface ClipProperties {
  title: string;
  source: string;
  author: string;
  published: string;
  modified: string;
  description: string;
  clipped: string;
  /** 学习状态：独立字段（已学习/未学习），与 tags 分开，避免被下游 Agent 重写关键词时冲掉 */
  learningStatus: string;
  tags: string[];
  /** 互动数据（来自页面，非用户编辑），写入 frontmatter */
  stats?: ClipStats;
}

/** 插件设置 */
/** 保存方式：obsidian:// URI / Local REST API / 飞书知识库 */
export type SaveMethod = 'uri' | 'rest' | 'feishu';

/** 飞书数据中心：国内版 feishu.cn / 国际版 larksuite.com（决定 API 与打开链接域名） */
export type FeishuDomain = 'feishu.cn' | 'larksuite.com';

/**
 * 仓库配置档：一份完整的"保存目标"。可存多套，在使用界面一键切换。
 * vaultName 同时用于保存后"打开"的跳转链接（两种方式都需要，避免打开时"未找到"）。
 * 飞书档复用 vaultName 作为下拉显示名（建议填知识库名），飞书专属字段见下。
 */
export interface VaultProfile {
  id: string;
  /** Obsidian 仓库名：既是下拉显示名，又用于 uri 保存与两种方式的"打开"跳转；飞书档仅作显示名 */
  vaultName: string;
  saveMethod: SaveMethod;
  /** Local REST API 地址（rest 方式用） */
  restBaseUrl: string;
  /** Local REST API 的 API Key（仅存本地，不同步） */
  restApiKey: string;
  /** 默认保存文件夹（每个仓库各自的归档位置，如 "剪藏/"） */
  defaultFolder: string;
  // ===== 飞书知识库（saveMethod==='feishu' 时用，整档只存 local，故凭证不进 sync）=====
  /** 自建应用 App ID */
  feishuAppId?: string;
  /** 自建应用 App Secret（仅存本地，不同步） */
  feishuAppSecret?: string;
  /** 数据中心域名 */
  feishuDomain?: FeishuDomain;
  /** 目标知识库 space_id */
  feishuSpaceId?: string;
  /** 目标知识库名（仅作显示） */
  feishuSpaceName?: string;
  /** 目标父节点 node_token（空=知识库根） */
  feishuParentToken?: string;
  /** 目标父节点标题（仅作显示） */
  feishuParentTitle?: string;
  /** 租户站点域名（如 https://xxx.feishu.cn，来自粘贴的链接），用于拼"打开"链接 */
  feishuHost?: string;
  /** 用户 OAuth access token（仅存本地，用于以用户身份列知识库/写文档） */
  feishuUserAccessToken?: string;
  /** 用户 OAuth refresh token（仅存本地） */
  feishuUserRefreshToken?: string;
  /** 用户 access token 过期时间戳（ms） */
  feishuUserTokenExpireAt?: number;
}

/** 界面主题：跟随系统 / 浅色 / 深色 */
export type ThemeMode = 'auto' | 'light' | 'dark';

/** 用户自定义 frontmatter 字段（固定写入每篇笔记，如 状态: 未读） */
export interface CustomField {
  key: string;
  value: string;
}

/** 按网站自动添加标签；domain 支持主域名及其全部子域名 */
export interface SiteTagRule {
  domain: string;
  tag: string;
}

export interface Settings {
  /** 界面主题（弹窗+设置页） */
  theme: ThemeMode;
  /** 选中文字后是否显示"高亮"浮动按钮 */
  highlightFloatingButton: boolean;
  /** 多套仓库配置档（保存目标），用于一键切换；空则按下面的单套字段迁移生成 */
  vaultProfiles: VaultProfile[];
  /** 当前生效的仓库档 id */
  activeProfileId: string;
  /** 保存方式（= 当前生效档的镜像，保存/打开逻辑直接读它） */
  saveMethod: SaveMethod;
  /** 目标 Obsidian 仓库名（uri 方式用） */
  vaultName: string;
  /** Local REST API 地址（rest 方式用，默认 HTTP 端口） */
  restBaseUrl: string;
  /** Local REST API 的 API Key */
  restApiKey: string;
  /** 默认保存文件夹（如 "剪藏/"） */
  defaultFolder: string;
  /** 为每篇剪藏创建独立子文件夹（文章+图片放一起） */
  folderPerClip: boolean;
  /** 子文件夹名模板，支持 {{date}} {{channel}} {{title}} */
  folderNameTemplate: string;
  /** 保存图片到本地附件（仅 REST 方式可用） */
  saveImagesLocal: boolean;
  /** 附件文件夹（图片落地位置） */
  attachmentsFolder: string;
  /** 文件名模板，目前支持 {{title}} {{date}} */
  filenameTemplate: string;
  /** 标签黑名单：抓到的页面标签若命中名单则丢弃（用户自定义，机械过滤，非 AI 判断） */
  tagBlocklist: string[];
  /** 「学习状态」字段：未勾选「本篇已学习」时写入的值（如 未学习） */
  unreadTag: string;
  /** 「学习状态」字段：勾选「本篇已学习」时写入的值（如 已学习） */
  learnedTag: string;
  /** 按网站域名自动添加标签 */
  siteTagRules: SiteTagRule[];
  /** 是否写入 frontmatter 属性 */
  includeFrontmatter: boolean;
  /** 用户自定义字段（固定写入每篇笔记的 frontmatter） */
  customFields: CustomField[];
  /** 各属性字段开关 */
  frontmatterFields: {
    source: boolean;
    author: boolean;
    published: boolean;
    modified: boolean;
    description: boolean;
    clipped: boolean;
    tags: boolean;
  };
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  highlightFloatingButton: true,
  vaultProfiles: [],
  activeProfileId: '',
  saveMethod: 'uri',
  vaultName: '',
  restBaseUrl: 'http://127.0.0.1:27123',
  restApiKey: '',
  defaultFolder: '剪藏/',
  folderPerClip: true,
  folderNameTemplate: '{{date}}-{{channel}}-{{title}}',
  saveImagesLocal: false,
  attachmentsFolder: 'attachments',
  filenameTemplate: '{{title}}',
  tagBlocklist: [],
  unreadTag: '未学习',
  learnedTag: '已学习',
  siteTagRules: [{ domain: 'woshipm.com', tag: 'PM' }],
  includeFrontmatter: true,
  customFields: [],
  frontmatterFields: {
    source: true,
    author: true,
    published: true,
    modified: true,
    description: true,
    clipped: true,
    tags: true,
  },
};

/** popup → content script 的消息 */
export interface ExtractRequest {
  type: 'ZHAOJI_CLIPPER_EXTRACT';
  /** 完整抓取模式：自动滚动加载全文（应对虚拟滚动页面） */
  fullCapture?: boolean;
}

/** content script → popup 的响应 */
export type ExtractResponse =
  | { ok: true; data: ExtractedPage }
  | { ok: false; error: string };

/** 后台跨域下载图片字节 */
export interface FetchImageRequest {
  type: 'ZHAOJI_CLIPPER_FETCH_IMAGE';
  url: string;
}
export type FetchImageResponse =
  | { ok: true; base64: string; mime: string }
  | { ok: false; error: string };

/** 截取当前活动标签页的可见区域（飞书画板等非 Markdown 内容用） */
export interface CaptureVisibleTabRequest {
  type: 'ZHAOJI_CLIPPER_CAPTURE_VISIBLE_TAB';
}
export type CaptureVisibleTabResponse =
  | { ok: true; dataUrl: string }
  | { ok: false; error: string };

/** 高亮相关消息 */
export interface HighlightSelectionRequest {
  type: 'ZHAOJI_CLIPPER_HIGHLIGHT';
}
export interface GetHighlightsRequest {
  type: 'ZHAOJI_CLIPPER_GET_HIGHLIGHTS';
}
export interface ClearHighlightsRequest {
  type: 'ZHAOJI_CLIPPER_CLEAR_HIGHLIGHTS';
}
export interface SetHighlightFloatingButtonRequest {
  type: 'ZHAOJI_CLIPPER_SET_HIGHLIGHT_FLOATING';
  enabled: boolean;
}

/** 诊断请求：导出页面结构供开发者分析 */
export interface DiagnoseRequest {
  type: 'ZHAOJI_CLIPPER_DIAGNOSE';
}

export type DiagnoseResponse =
  | { ok: true; dump: string }
  | { ok: false; error: string };

/** popup/background → background 的保存消息 */
export interface SaveRequest {
  type: 'ZHAOJI_CLIPPER_SAVE';
  url: string; // 已构造好的 obsidian:// URI
}
