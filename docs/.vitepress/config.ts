import { defineConfig, type DefaultTheme } from 'vitepress';

const base = process.env.DOCS_BASE_PATH || '/';

type Labels = {
  guide: string;
  pages: string[];
  language: string;
  outline: string;
  previous: string;
  next: string;
  navigation: string;
  theme: string;
  light: string;
  dark: string;
  top: string;
  footer: string;
};
const routes = [
  'getting-started',
  'installation',
  'usage',
  'attachments',
  'configuration',
  'appearance',
  'extensions',
  'cli',
  'troubleshooting',
  'run-controls',
];
function guide(prefix: string, labels: Labels): DefaultTheme.Config {
  return {
    nav: [
      { text: labels.pages[0]!, link: `${prefix}/getting-started` },
      { text: labels.pages[2]!, link: `${prefix}/usage` },
      { text: labels.pages[8]!, link: `${prefix}/troubleshooting` },
    ],
    sidebar: [
      {
        text: labels.guide,
        items: routes.map((route, index) => ({
          text: labels.pages[index]!,
          link: `${prefix}/${route}`,
        })),
      },
    ],
    langMenuLabel: labels.language,
    outline: { label: labels.outline, level: [2, 3] },
    docFooter: { prev: labels.previous, next: labels.next },
    sidebarMenuLabel: labels.navigation,
    darkModeSwitchLabel: labels.theme,
    lightModeSwitchTitle: labels.light,
    darkModeSwitchTitle: labels.dark,
    returnToTopLabel: labels.top,
    footer: { message: labels.footer, copyright: 'Hikari contributors' },
  };
}

export default defineConfig({
  base,
  title: 'Hikari',
  description: 'The Hikari user guide: conversations, project tasks and changes you can review.',
  head: [['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}hikari-icon.svg` }]],
  lastUpdated: false,
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      link: '/',
      themeConfig: guide('', {
        guide: 'User guide',
        pages: [
          'Getting started',
          'Installation',
          'Tasks and workspace',
          'Files and images',
          'Model settings',
          'Appearance and language',
          'MCP and Skills',
          'Command-line usage',
          'Troubleshooting',
          'Run, verify and resume',
        ],
        language: 'Change language',
        outline: 'On this page',
        previous: 'Previous page',
        next: 'Next page',
        navigation: 'Menu',
        theme: 'Appearance',
        light: 'Switch to light theme',
        dark: 'Switch to dark theme',
        top: 'Return to top',
        footer: 'Your ideas. Your workspace.',
      }),
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      description: 'Hikari 操作手册：对话、项目任务与修改审阅。',
      themeConfig: guide('/zh', {
        guide: '操作手册',
        pages: [
          '快速开始',
          '安装',
          '任务与工作区',
          '文件与图片',
          '模型设置',
          '外观与语言',
          'MCP 与 Skills',
          '命令行使用',
          '常见问题',
          '执行、验收与恢复',
        ],
        language: '切换语言',
        outline: '本页目录',
        previous: '上一篇',
        next: '下一篇',
        navigation: '文档导航',
        theme: '切换主题',
        light: '切换为亮色',
        dark: '切换为暗色',
        top: '返回顶部',
        footer: '你的想法，你的工作区。',
      }),
    },
    ja: {
      label: '日本語',
      lang: 'ja',
      link: '/ja/',
      description: 'Hikari の操作ガイド：会話、プロジェクトのタスク、変更のレビュー。',
      themeConfig: guide('/ja', {
        guide: '操作ガイド',
        pages: [
          'はじめに',
          'インストール',
          'タスクとワークスペース',
          'ファイルと画像',
          'モデル設定',
          '外観と言語',
          'MCP と Skills',
          'コマンドラインの使い方',
          '困ったとき',
          '実行・検証・再開',
        ],
        language: '言語を変更',
        outline: 'このページの内容',
        previous: '前のページ',
        next: '次のページ',
        navigation: 'メニュー',
        theme: 'テーマ',
        light: 'ライトテーマに切り替える',
        dark: 'ダークテーマに切り替える',
        top: 'トップに戻る',
        footer: 'あなたのアイデア、あなたのワークスペース。',
      }),
    },
  },
  themeConfig: {
    logo: '/hikari-icon.svg',
    socialLinks: [{ icon: 'github', link: 'https://github.com/fonghehe/hikari-agent' }],
    search: {
      provider: 'local',
      options: {
        translations: { button: { buttonText: 'Search docs', buttonAriaLabel: 'Search docs' } },
        locales: {
          zh: {
            translations: {
              button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
              modal: {
                noResultsText: '没有相关结果',
                resetButtonTitle: '清除搜索',
                backButtonTitle: '返回',
                displayDetails: '显示详细结果',
                footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
              },
            },
          },
          ja: {
            translations: {
              button: { buttonText: '検索', buttonAriaLabel: 'ドキュメントを検索' },
              modal: {
                noResultsText: '結果が見つかりません',
                resetButtonTitle: '検索をクリア',
                backButtonTitle: '戻る',
                displayDetails: '詳細を表示',
                footer: { selectText: '選択', navigateText: '移動', closeText: '閉じる' },
              },
            },
          },
        },
      },
    },
  },
});
