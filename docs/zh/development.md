# 开发与验证

## 本地启动

使用 Node 24 LTS 和仓库 `packageManager` 指定的 pnpm 版本，在仓库根目录执行：

```sh
pnpm install
pnpm dev
```

`apps/desktop/scripts/dev.mjs` 先构建 main、preload 与 renderer，再在 `127.0.0.1:5173` 提供界面并启动 Electron。renderer 可由 Vite 更新；修改 main 或 preload 后需要重新启动开发进程。不要将已有桌面进程误当作最新主进程代码。

项目工具需要 Git 与 ripgrep；从源码使用浏览器工具前安装 Chromium：

```sh
pnpm exec playwright install chromium
```

数据库默认与日常桌面应用共用。做隔离测试时设置 `HIKARI_DATA_DIR`，避免修改个人任务历史与模型配置。

## 代码在哪里

| 目录                                                   | 内容                                                 |
| ------------------------------------------------------ | ---------------------------------------------------- |
| `apps/desktop`                                         | Electron 入口、preload、React UI、附件解析和桌面服务 |
| `apps/cli`、`apps/server`                              | 命令行入口与可选同步服务                             |
| `packages/agent-core`、`packages/shared`               | 任务、事件、工具及跨进程契约                         |
| `packages/agent-runtime`                               | 调度、上下文、记忆、审批、检查点和工作流             |
| `packages/model-provider`                              | 服务商协议适配与离线示例                             |
| `packages/tools`、`packages/git`、`packages/sandbox`   | 项目操作、改动交付和命令执行边界                     |
| `packages/database`、`packages/mcp`、`packages/skills` | 持久化与扩展协议                                     |
| `tests`、`tests/e2e`                                   | 单元测试、Electron 与文档浏览器测试                  |

## 验证命令

```sh
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
pnpm --filter @hikari/desktop build
pnpm docs:build
pnpm exec playwright test
```

Electron E2E 需要图形会话；Linux 无桌面环境时通过 Xvfb 运行。文档测试需要先构建文档，并使用 Playwright 对应版本的 Chromium。只修改文档时可执行 `pnpm docs:build` 和 `pnpm exec playwright test tests/e2e/docs.spec.ts`。

Electron 测试使用临时数据目录和可控模型响应。它们验证任务、审批、实际工具执行、恢复和 UI 连接，不能证明线上模型的任务成功率。`pnpm eval:agent --validate` 验证固定评估器；真实模型评估使用 [CLI 文档](cli.md) 中的凭据与评估命令，不要把两者混为一谈。

## TypeScript 契约

`pnpm typecheck` 使用项目已安装的 TypeScript，启用严格检查和 `noUncheckedIndexedAccess`。`isolatedModules` 与 `verbatimModuleSyntax` 检查代码是否适用于 esbuild/Vite 的单文件编译流程，并要求显式区分类型导入。增量缓存保存在已忽略的 `.cache/typecheck.tsbuildinfo`；执行 `pnpm exec tsc --noEmit --incremental false` 可进行无缓存检查。

`tests/types/desktop-ipc.ts` 是由 `pnpm typecheck` 检查的纯编译期断言，覆盖错误通道、返回类型和未经校验的输入假设；运行时测试由 Vitest 单独执行。模型发现会先校验远程 JSON，再访问模型字段；异常响应统一报告为 `MODEL_DISCOVERY`，错误信息不包含响应正文。

## 原生窗口验证

DOM 点击不能覆盖 Electron 的原生命中与系统输入。涉及标题栏、弹窗、终端或缩放的改动，除 E2E 外还需实际鼠标与键盘核对：长弹窗靠近窗口顶部时的 ×、Escape 与焦点恢复，文件树默认折叠与逐层展开，以及终端的中文输入、输出和重启。

重点回归文件包括 `desktop-ipc.test.ts`、`data-path.test.ts`、`persistence-batching.test.ts`、`context-budget.test.ts`，以及 E2E 中的 `desktop.spec.ts`、`interaction-consistency.spec.ts`、`terminal.spec.ts`、`workspace-context.spec.ts`。

## 构建与打包

```sh
pnpm --filter @hikari/desktop exec playwright install chromium
pnpm desktop:pack
pnpm test:package
pnpm desktop:dist
```

`desktop:pack` 生成可运行目录；`desktop:dist` 生成安装包，输出在 `apps/desktop/release/`。两者先构建代码、检查原生模块并准备浏览器资源，不会发布安装包。main 与附件 Worker 由 esbuild 构建为 CommonJS，preload 单独构建，renderer 由 Vite 输出。

`test:package` 启动上一步生成的应用，用独立临时数据目录验证原生模块、离线 OCR、内置浏览器、终端和沙箱执行。验证与发布 CI 均运行此检查；Linux 使用 `xvfb-run -a pnpm test:package`。它不验证正式签名、公证或真实外部模型质量。

在目标操作系统与架构上打包并验证。配置位于 `apps/desktop/electron-builder.yml`；原生模块、OCR 语言数据、浏览器资源和系统签名均需单独核对。macOS 当前配置采用本地 ad-hoc 签名，不能据此声称已公证；自动更新还需要正式发布源。

## 文档构建与部署

默认英文，`docs/zh` 和 `docs/ja` 保存对应页面。新增页面时同步 `docs/.vitepress/config.ts` 的导航与三种语言，避免语言切换落到缺失页面。

```sh
pnpm docs:dev --port 5174
DOCS_BASE_PATH=/hikari-agent/ pnpm docs:build
DOCS_BASE_PATH=/hikari-agent/ pnpm docs:preview --port 5174
```

GitHub Pages 工作流读取部署 base；本地子路径验证时，构建、预览及文档 E2E 使用同一个 `DOCS_BASE_PATH`。文档更新与桌面安装包发布是独立流程。

## 平台能力回归

`platform-runtime.test.ts` 覆盖目标、Hooks、委派和持久计划；`platform-tools.test.ts` 覆盖固定摘要的插件分发包、LSP 通信和历史恢复冲突。`platform-control.test.ts`、`platform-worker.test.ts`、`github-integration.test.ts` 使用测试服务检查账户及租约边界、独立执行节点进程和显式开启的结果回传。`vscode-integration.test.ts` 通过扩展宿主 API 测试替身检查选区、诊断和 SecretStorage。

`tests/e2e/platform.spec.ts` 使用真实 Electron 界面和手机尺寸浏览器操作本地执行宿主。需要使用已安装的 Chrome 时，运行 `HIKARI_TEST_BROWSER_CHANNEL=chrome pnpm test:e2e`；它只改变测试浏览器，产品默认设置不变。通过这些检查不代表真实模型质量、实际 IDE 宿主验收、生产部署或 GitHub 平台验收。

`workspace-ownership.test.ts` 启动独立进程并模拟崩溃，检查跨宿主互斥、历史保护和初始化失败后的释放。Worker 集成测试会在服务端已处理领取、心跳及完成上报后丢弃响应，验证重连与幂等；`worker-transport.test.ts` 检查取消、超时和不可重试的认证/租约错误。`repository-eval.test.ts` 验证固定提交副本、失败基线、独立验收，以及测试被篡改时拒绝通过。实际项目评测见 [CLI](./cli#固定提交的真实仓库评测)。

## 发行前验证

仓库已有正式签名发布脚本 `scripts/release-desktop.mjs`，与本地 ad-hoc 打包不同。它校验真实仓库、语义版本标签、Windows/macOS 签名凭据和 macOS 公证凭据；`node scripts/release-desktop.mjs --check` 仅检查环境，不构建、不上传。发布工作流在签名打包前运行格式检查、单元测试、桌面与文档 E2E。没有证书或平台实机验收时，不应将本地打包成功表述为正式发行成功。

真实模型报告可通过 `pnpm eval:report REPORT.json [REPORT.json ...]` 设置验收门禁。默认至少 5 类任务，每类 3 次，整体与逐类成功率至少 90%，P95 不超过 180 秒。通过 `EVAL_MIN_CASES`、`EVAL_MIN_SAMPLES`、`EVAL_MIN_SUCCESS_RATE`、`EVAL_MAX_P95_MS` 调整；这些是可配置的项目门槛，不是行业质量保证。只接受同一服务、模型与工作流的 `model-run` 报告，拒绝 `--validate` 的基线报告及 demo，重复文件不会增加样本。报告字段本身不能证明真实请求，仍需保留原始运行证据。当前未配置真实模型时只能验证门禁逻辑，不能发布模型成功率。

先面向自带模型密钥的本地开发者试用，独立记录失败任务、人工接管、费用和耗时。发行前仍需由维护者确定项目许可证、依赖许可与通知、隐私说明、收费与支持条款；代码不会替作者选择商业许可或承诺 SLA。
