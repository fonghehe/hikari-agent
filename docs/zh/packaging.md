# 桌面打包

标准桌面包不再附带第二套 Chromium，也不会因为依赖出现在工作区清单中，就把已打入前端产物的依赖再复制一份。

```sh
pnpm desktop:pack
pnpm test:package
pnpm desktop:dist
```

`build.mjs` 根据 esbuild 实际外部导入生成 `dist/runtime-dependencies.json`。`stage-package.mjs` 仅把生产依赖闭包实体化到忽略的 `.artifacts/package/desktop` 目录：保留许可证、OCR/原生资产，排除源码映射、测试、示例、调试符号和其他平台的 PTY 预编译文件。原生可选包按当前平台解析。

`package.mjs` 从独立生产目录调用已安装的 electron-builder，防止 pnpm 工作区探测重新带入无用依赖。应用使用 asar；原生模块和 OCR Worker 的完整依赖闭包按实际运行要求解包，语言数据只复制一次。

`dist/package-report.json` 记录平台、架构、依赖、暂存字节数与 Worker 依赖。这是暂存测量，不等于安装器大小。改造前本机 macOS arm64 ZIP 为 **434,708,395 字节**，解压内容为 **965,958,738 字节**，其中额外浏览器占 **327,140,136 字节**。最终应比较实际 ZIP/DMG；Electron 本身仍有固定体积。

## 浏览器与功能保留

桌面网页工具用同一个 Electron 可执行文件启动隐藏、可销毁的独立进程，通过 loopback CDP 控制。`browser-worker.ts` 在应用启动逻辑前运行，不打开任务数据库、不安装应用 IPC。网页启用沙箱和上下文隔离、禁用 Node 集成、拒绝权限与新窗口。结束会话时关闭进程并删除临时配置。

因此桌面包无需下载 Playwright Chromium，也不依赖单独安装的 Chrome。CLI/服务器的浏览器环境要求仍由其运行环境提供。已移除旧 `browser-assets.mjs` 流程，标签发布也走同一生产暂存路径。

## 验证边界

`test:package` 启动实际打包的可执行文件，并提供空浏览器缓存，验证安全 IPC、离线会话、PDF/DOCX/图片、离线 OCR、原生 PTY、受限执行、文件验收、浏览器和主题。烟测只使用无凭证的本机模型夹具，不应触发系统钥匙串授权。

本机体积与原生运行结果仅代表 macOS arm64。Windows/Linux 需在对应平台构建并运行 CI 验证。本地 macOS 使用临时签名，未完成面向公开发行的公证；打包不会自动发布。

## 本机产物实测

2026-11-14，同一 macOS arm64 发布路径生成的 ZIP 为 **171,693,641 字节**，DMG 为 **171,500,419 字节**。相较原 ZIP 的 434,708,395 字节，压缩包减少 **60.5%**；ZIP 解压内容合计从 965,958,738 降到 429,857,576 字节。新包保留离线 OCR，未包含额外浏览器和重复的 `node_modules/monaco-editor`。这些是本地临时签名产物，未公开发布或公证。
