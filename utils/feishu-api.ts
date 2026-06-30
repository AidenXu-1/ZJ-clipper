// 兼容旧引用的飞书入口。内部已拆分为 client / wiki / renderer / save-service。
export type { FeishuConfig } from './feishu/client';
export type { FeishuNode, FeishuSpace } from './feishu/wiki';
export type { FeishuImage, FeishuSaveResult } from './feishu/save-service';

export {
  getNodeInfo,
  getSpaceInfo,
  listNodes,
  listSpaces,
  testFeishu,
} from './feishu/wiki';
export { saveToFeishu } from './feishu/save-service';

