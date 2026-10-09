# 安装

## 打开桌面发行版

选择与你的操作系统和处理器匹配的发行版。本地生成的发行文件位于 `apps/desktop/release/`。

macOS 上打开 Hikari DMG，将 **Hikari** 拖入 **Applications（应用程序）**，再从应用程序启动。也可解压 ZIP，将 Hikari.app 移入应用程序。

桌面应用自带离线模拟，无需项目仓库、开发服务器或 API Key。当前发行版已在 macOS arm64 验证；Windows 和 Linux 发行版需在对应系统测试后使用。

如果 macOS 阻止应用启动，请先确认获取来源，并遵循组织的安装要求。本地发行包尚未进行 Apple 公证。

## 从源码运行

安装 **Node 24 LTS** 和 **pnpm 11**，在 Hikari 项目目录执行：

```sh
pnpm install
pnpm dev
```

真实项目任务需要电脑上可用的 **Git** 与 **ripgrep**。浏览器工具还需 Chromium：

```sh
pnpm exec playwright install chromium
```

打包桌面应用中的离线模拟不需要这些真实项目工具。

## 首次使用

先体验[离线问答](getting-started.md)，选择[主题与语言](appearance.md)，或[连接模型](configuration.md)处理自己的项目。
