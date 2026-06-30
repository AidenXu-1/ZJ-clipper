import { defineConfig } from 'wxt';

// WXT 配置：自动生成 MV3 manifest、多入口打包、热更新
// 文档：https://wxt.dev
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // 把所有非 ASCII（中文等）转义成 \uXXXX，输出纯 ASCII，
  // 避免 Chrome 对含中文的大体积内容脚本误判编码而拒绝加载。
  vite: () => ({
    esbuild: { charset: 'ascii' },
  }),
  manifest: {
    name: '兆基clipper',
    description: '把网页内容简存到你的 Obsidian 仓库',
    default_locale: undefined,
    permissions: ['activeTab', 'scripting', 'storage', 'contextMenus', 'identity'],
    // 本机 Obsidian Local REST API + 跨域下载图片（本地图片保存功能）
    host_permissions: [
      'http://127.0.0.1/*',
      'https://127.0.0.1/*',
      'http://localhost/*',
      'https://localhost/*',
      '<all_urls>',
    ],
    action: {
      default_title: '兆基clipper：剪藏此页',
    },
    commands: {
      _execute_action: {
        suggested_key: {
          default: 'Ctrl+Shift+S',
          mac: 'Command+Shift+S',
        },
        description: '打开兆基clipper剪藏当前页面',
      },
      'highlight-selection': {
        // 注意：mac 的 Cmd+Shift+H 被系统占用，改用不冲突的组合；
        // 主入口是划词浮动按钮与右键菜单，快捷键可在 chrome://extensions/shortcuts 自定义
        suggested_key: {
          default: 'Ctrl+Shift+Y',
          mac: 'Command+Shift+Y',
        },
        description: '高亮选中的文字',
      },
    },
  },
});
