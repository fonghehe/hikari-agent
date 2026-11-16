# 整项目架构与能力边界

生产环境的统一组装入口是 `packages/agent-host/src/prepare-session.ts`。桌面 `TaskHost`、普通 CLI、远程会话和执行 Worker 向它提供存储、UI 与审批适配器，不再各自实现一套 Agent 组装逻辑。离线 Demo 仍是模拟；事件驱动服务在同一执行路径上增加主动准入。

```text
桌面 / CLI / Worker / 来源事件
       ↓ 明确请求或版本化规则研判
Policy → Mandate → Ticket → Assignment
       ↓ prepareAgentSession
意图 + 分层记忆 + 当前来源检索 + 工具能力
       ↓ AgentRunner
模型工具调用 → 参数校验 → 权限审批 → 实际工具使用 → 观察结果
       ↓ 验收与结构化报告
可用答案 / 待审阅变更 / 等待事件 / 待人工处理
```

普通桌面和 CLI 请求也会产生明确授权与工作身份。桌面控制状态按项目/会话隔离，保存于私有 SQLite `sessions`；CLI 使用 `.agent/state/superagent.json`。原检查点保留。导入会话不恢复执行权限。明确发起的新轮次按新请求授权，旧历史只作参考；Resume 恢复原工作和检查点，不靠历史文本扩大授权。

## 功能盘点

| 能力            | 实际实现                                                                                          | 边界                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Tool calling    | OpenAI 兼容函数调用、Anthropic `tool_use`、Gemini 工具调用；流式参数收齐才执行                    | 模型/后端需要支持工具；聊天成功不代表工具调用成功                                         |
| Tool use        | 运行时参数校验、审批、钩子、取消、有界观察和测试证据                                              | 模型不能授予权限；结果不确定的修改不盲目重放                                              |
| MCP             | 已配置 stdio/HTTP 接入、工具/资源/提示发现与清理                                                  | 连接需要审批；进程在所选沙箱执行                                                          |
| Agent           | 共享执行宿主、明确授权、持久工作、委派与可选开发阶段                                              | 多 Agent 不等于评审质量保证；子任务受父预算与权限约束                                     |
| 意图识别        | 根据明确模式和有无工作区初始路由，`route_intent` 进一步细化                                       | 调研/规划/评审可收窄工具；不能因此开启工作区执行或撤销限制                                |
| 短期/工作记忆   | 有界上下文、观察归档、任务摘要、`update_working_memory`、检查点                                   | 不自动提升成长期事实                                                                      |
| 会话记忆        | 独立会话命名空间，显式保存条目默认七天过期                                                        | 不读取其他会话；历史携带有界                                                              |
| 项目记忆        | 兼容旧记录的事实/决定，显式保存、更新、删除与检索                                                 | worktree 沿用原项目范围；更新不能偷偷迁移层级                                             |
| 用户长期记忆    | `remember` 的 `kind: user` 与项目、会话层分离                                                     | 桌面 SQLite 跨项目共享；文件 CLI 存储仍是项目本地，不擅自写入全局主目录                   |
| RAG             | 结构分块、SQLite 关键词/向量快照、向量复用、融合、重排与当前引用回读                              | 精确向量检索而非 ANN；远程嵌入/重排需要配置与审批                                         |
| 项目源码 RAG    | `search_project`、`index_project`、`read_project_source`；远程配置下仍提供 `search_project_local` | 每次语料最多 200 文件、2 MB、1,000 块；明确报告覆盖不足，排除敏感文件、路径逃逸与失效引用 |
| 本地/浏览器工具 | PTY、文件/Git、受限执行和可销毁 Electron 浏览器进程                                               | 浏览器子进程无应用 IPC/数据库，网页没有 Node 权限                                         |

## 授权、暂停与交付

交互执行以明确用户请求授权；来源中的推断工作必须匹配文字规则，默认 observe。两者都记录工作与派工。执行轮次完成不等于成果审阅完成。桌面产生修改后显示待审阅，在 Diff 中接受或撤销所有变更后结束工单。交互问题沿用输入适配器，无人值守执行使用结构化报告交接。

意图识别不是身份认证。外部文档、MCP 内容、来源消息和记忆都是参考数据，不能修改 Policy、授权发布或扩大 Mandate。意图细化和修改不能放在同一批工具调用中。人工暂停会持久化；关闭时为退出等待而唤醒执行器，不会记录成人工恢复。

## 架构取舍

保留已有执行器、附件/RAG 和沙箱，避免替换框架丢失验证过的能力；移除生产入口的重复组装，把 DeepSeek 公开设计中的授权、工作/派工分离、注意力与结构化交付应用于整个 App。SQLite 和原子文件存储实现同一个控制端口，桌面不需要另启一套可选服务才能获得这些机制。

单项目控制文档有 16 MB 上限，需要归档；多节点路由、飞书原生接入和外部通知发送仍是部署适配工作。真实模型的意图/检索质量、供应商账号可用性不能由本地夹具测试代替。

打包变化见[桌面打包](packaging.md)，厂商核实见 [API 审核](provider-api-audit.md)。新增 `tests/integration/session-architecture.test.ts` 验证普通桌面/本地入口、分层记忆、当前引用和意图限制；已有 MCP、工具协议、权限、委派、恢复与检索测试继续要求通过。[开发验证](development.md)包含执行命令。

恢复、独立记忆审批、任务基准、交付与计费的新机制见 [Agent 可靠性与评测](agent-readiness.md)。

## 仓库目录与依赖规则

此页是当前架构和目录边界的入口；流程细节见 [Electron 架构](electron-architecture.md)、[Superagent](superagent.md)和[可靠性评测](agent-readiness.md)。

```text
apps/
  desktop/src/
    main/           # ipc, tasks, storage, attachments, browser, terminal
    preload/        # typed IPC bridge
    renderer/
      app/          # application composition and store
      features/     # conversations, workspace, settings, tools
      shared/       # components, preferences, i18n, ordered styles
  cli/              # interactive and service entry points
  server/           # remote control and worker transport
packages/
  agent-host/src/   # prepare-session, session-host, delivery, evaluation
  agent-runtime/src/
    runner/         # execution lifecycle and tool operations
    context/        # working context, saved memory, observations
    knowledge/      # indexing, retrieval, reranking, vector storage
    persistence/    # checkpoints, state, traces, workspace ownership
    orchestration/  # superagent control, delegation, workflows, scheduling
  shared/src/       # models, attachments, workspace, preferences, changes, desktop-api
  ...               # core, providers, tools, sandbox, MCP, storage, skills, UI
integrations/       # external adapters
scripts/            # build, release, checks, evals, benchmarks, shared helpers
tests/             # domain suites, integration, e2e, fixtures, type assertions
docs/              # current English, Chinese and Japanese guides
.artifacts/         # ignored reports, package staging and releases
```

`index.ts` 只维护公共导出，运行实现放在所属领域。包内直接导入实现文件，避免反向依赖入口形成循环；跨包使用 `@hikari/*` 声明的导出，公共入口保持兼容。模型配置可使用 `@hikari/shared/models`，无需依赖桌面 API 契约。renderer 只通过 preload 契约访问主进程能力，不导入 Node 或 main。样式由 `shared/styles/index.css` 按原有级联顺序加载，调整文件位置时保持该顺序。

测试按 `runtime`、`knowledge`、`desktop`、`providers`、`tools`、`platform`、`storage`、`security`、`evals` 和 `integration` 分组；端到端、共享夹具和类型断言分别在 `e2e`、`fixtures`、`types`。测试直接使用的第三方库在根开发依赖声明，禁止借用其他包的 `node_modules` 路径。

`pnpm typecheck` 分别检查 renderer、main/preload、Node 服务和工具/测试四个环境。共享严格选项在 `tsconfig.base.json`；renderer 不注入 Node 全局类型。根 `tsconfig.json` 保留编辑器和原有直接检查入口。

## 产物与清理

报告位于 `.artifacts/test-results`，桌面暂存位于 `.artifacts/package/desktop`，桌面发行文件位于 `.artifacts/releases/desktop`，VSIX 位于 `.artifacts/releases/vscode`。编译输出仍在应用 `dist`，工具缓存仍由 `.turbo`、`.cache` 管理。既有历史发行包和报告可迁入对应目录；不会自动清理运行数据。

`pnpm clean:build`、`pnpm clean:reports`、`pnpm clean:cache` 默认只预览，确认路径后追加 `--apply` 执行。脚本仅允许固定生成目录，拒绝符号链接路径，始终保留发行包、依赖、`.agent`、共享 Agent 指令和本地技能/历史记录。`.claude` 等技能适配目录中的链接继续指向 `.agents/skills`，不复制或合并技能内容。
