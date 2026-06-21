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
/** 保存方式：obsidian:// URI 或 Local REST API */
export type SaveMethod = 'uri' | 'rest';

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
  /** 保存方式 */
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
