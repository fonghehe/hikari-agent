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

验证与发布 CI 将 Linux 固定为 `ubuntu-24.04`：Ubuntu 26.04 新增的 AppArmor bubblewrap 策略需要单独适配。Linux 首先预检网络命名空间能否创建。受限评估器和仓库评估集成测试在 macOS/Linux 运行；托管 Windows 没有 Linux Docker 引擎和 `hikari-sandbox:local` 镜像。Windows 仍运行评估帮助与配置、schema、宿主机执行和桌面检查。单测报告保存到 `.artifacts/test-results/unit.xml`，CI 失败时上传。桌面生命周期 E2E 将原生错误弹窗记录为测试失败，避免弹窗悄悄阻塞退出。

CI 将单测并发限制为两个 worker；Windows 为原生文件系统集成测试保留每条 30 秒的时限，其他平台保持 10 秒。打包后，Ubuntu 通过 `scripts/ci/allow-desktop-userns.sh` 仅允许打包的 `hikari` 可执行文件创建用户命名空间，保留 Chromium 沙箱。打包工具的观测结果保存到 `.artifacts/test-results/packaged-tool-observations.json`，便于定位失败原因。

项目打开或任务启动期间，发送和任务切换会暂时禁用，操作完成后恢复，避免延迟返回的项目结果清掉新选择的会话或让发送被忽略。

关闭弹窗时，仅在焦点尚未移动到其他控件的情况下恢复到触发按钮，避免延迟动画帧打断正在进行的键盘导航。

## TypeScript 契约

`pnpm typecheck` 使用项目已安装的 TypeScript，启用严格检查和 `noUncheckedIndexedAccess`。`isolatedModules` 与 `verbatimModuleSyntax` 检查代码是否适用于 esbuild/Vite 的单文件编译流程，并要求显式区分类型导入。增量缓存保存在已忽略的 `.cache/typecheck.tsbuildinfo`；执行 `pnpm exec tsc --noEmit --incremental false` 可进行无缓存检查。

`tests/types/desktop-ipc.ts` 是由 `pnpm typecheck` 检查的纯编译期断言，覆盖错误通道、返回类型和未经校验的输入假设；运行时测试由 Vitest 单独执行。模型发现会先校验远程 JSON，再访问模型字段；异常响应统一报告为 `MODEL_DISCOVERY`，错误信息不包含响应正文。

## 原生窗口验证

DOM 点击不能覆盖 Electron 的原生命中与系统输入。涉及标题栏、弹窗、终端或缩放的改动，除 E2E 外还需实际鼠标与键盘核对：长弹窗靠近窗口顶部时的 ×、Escape 与焦点恢复，文件树默认折叠与逐层展开，以及终端的中文输入、输出和重启。

重点回归文件包括 `desktop-ipc.test.ts`、`data-path.test.ts`、`persistence-batching.test.ts`、`context-budget.test.ts`，以及 E2E 中的 `desktop.spec.ts`、`interaction-consistency.spec.ts`、`terminal.spec.ts`、`workspace-context.spec.ts`。

## 构建与打包

```sh
pnpm desktop:pack
pnpm test:package
pnpm desktop:dist
```

`desktop:pack` 生成可运行目录；`desktop:dist` 生成安装包，输出在 `.artifacts/releases/desktop/`。两者先构建代码、检查原生模块并准备浏览器资源，不会发布安装包。main 与附件 Worker 由 esbuild 构建为 CommonJS，preload 单独构建，renderer 由 Vite 输出。

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

## 运行时组装与并发

`packages/agent-host/src/execution.ts` 为桌面、CLI 和 Worker 共享能力组装、文件验收及 Runner 清理。桌面对话、附件和调度仍由各自适配层处理。`ResourceScope` 在结束或初始化失败时按相反顺序撤销注册、释放资源；一个清理操作失败不会阻止其余清理。

只有独立的文件系统检查工具可以声明 `parallelSafe`。运行时按调用顺序检查权限，最多并发三个相邻的已标记读取，再按原始顺序提交观察结果。写入、命令、未知工具和可能产生副作用的工具 Hook 保持串行。中断会等待活动读取结束，未完成调用沿用检查点恢复规则。

展示更新共用 100 毫秒持久化缓冲，每个任务最多暂存 2,000 条事件。工具边界、检查点、读取和关闭时立即落盘。进程突然退出可能丢失尚未刷新的展示尾部。持久化订阅属于关键订阅：写入失败会停止执行，生命周期副作用前会检查落盘状态，后续写入成功也不能掩盖此前失败。普通展示监听器的异常仍单独隔离。

相关回归覆盖：`file-persistence-batching`、`resource-scope`、`execution-lifecycle`、`request-traces`、`parallel-reads`、`context-budget` 和 `agent-control`。

## 可重复的离线基准

不调用模型、不下载依赖，使用已有环境运行：

```sh
node scripts/benchmarks/renderer.mjs 100 30
TSX_DISABLE_CACHE=1 node --import tsx scripts/benchmarks/runtime.ts
TSX_DISABLE_CACHE=1 node --import tsx scripts/benchmarks/runtime.ts --ref=a291620
```

renderer 基准在内存中为真实生产 UI 加入 profiling，使用虚构任务并拦截请求；默认使用已安装 Chrome，可用 `HIKARI_TEST_BROWSER_CHANNEL` 选择其他已安装渠道。本场景不使用编辑器 Worker。输出 App/Timeline 渲染次数、commit 次数及 p95、store 通知、模拟列表 IPC 次数与字节数。前后使用相同任务数和帧数，并分别测量 10、100、1,000 个任务。这不代表原生 Electron IPC 延迟或真实模型性能。

runtime 基准预热 5 次，测量 30 次追踪追加和 10 次技能查询，输出 p50/p95。`--ref` 只从指定 Git 版本读取追踪追加实现；技能始终使用当前工作区。100 份虚构 60 KB 技能分别测元数据发现、兼容 `list()` 与单项正文加载。追踪每条 20,000 或 400,000 字符、保留 16 条，不包含持久化 I/O。

本地 macOS arm64 样本（Node 24.14.1、Chrome 156）：100 个任务、2,000 条历史事件下，240 个背景 delta 使 App/Timeline 渲染和 commit 从各 30 次降为 0；同步 240 个状态事件的列表调用从 240 次降为 1 次，模拟快照从 78,229,920 字节降为 325,958 字节。前台 delta 的 commit p95 为 4.2→4.4 ms，不声称前台变快。保留约 6.4 MB 追踪时追加 p95 为 14.66→14.93 ms；移除了一次重复编码，但该样本不能证明速度提升。比较时固定系统、浏览器、运行时、输入、预算和预热。单元/fixture、真实模型和远端三系统 CI 分别报告。

## Superagent 验证

`pnpm exec vitest run tests/runtime/superagent.test.ts tests/integration/superagent-host.test.ts` 验证准入、观察规则、授权复核、订阅、未读输入、结构化交接、目录延续及重启。`pnpm exec playwright test tests/e2e/superagent.spec.ts` 使用本地脚本模型验证真实协调页面。测试启动 loopback 夹具服务并使用临时项目，不调用付费模型或发布成果。参见[设计边界](superagent.md)。

## 共享应用执行

普通桌面、CLI 与 Worker 请求现均通过 `prepareAgentSession` 接入授权、意图、分层记忆与当前源码检索。桌面保留原生交互和存储适配。参见[整项目能力盘点](architecture-upgrade.md)、[打包](packaging.md)及 [API 核实](provider-api-audit.md)。

恢复、独立记忆审批、任务基准、交付与计费的新机制见 [Agent 可靠性与评测](agent-readiness.md)。
