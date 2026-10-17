# Electron 架构

Hikari 在同一个应用实例中运行主窗口及可选的对话窗口。React 界面通过受限 preload 调用主进程，任务执行、SQLite、文件系统、终端和外部连接由主进程的服务管理。当前 AgentRunner 运行在主进程中；附件解析使用 Worker，尚未把整个 Agent 放入独立进程。

## 进程与依赖边界

```text
React / Zustand（renderer）
        ↓ window.hikari，类型来自 @hikari/shared
contextBridge（preload）
        ↓ ipcRenderer.invoke / 事件订阅
IPC Router → 按领域注册的处理器（main）
        ↓
TaskHost / LocalPersistence / TerminalSessions
        ↓
AgentRunner / 模型适配器 / 工具 / Git / SQLite
```

| 层         | 入口                                             | 职责                                                 |
| ---------- | ------------------------------------------------ | ---------------------------------------------------- |
| 启动与退出 | `apps/desktop/src/main/index.ts`                 | 数据目录、单实例锁、数据库迁移、服务装配、退出清理   |
| 窗口       | `apps/desktop/src/main/window.ts`                | 窗口配置、图标、导航和权限策略、开发与打包页面加载   |
| IPC 边界   | `apps/desktop/src/main/ipc/router.ts`            | 只接收所属窗口主 frame 的请求，退出时注销处理器      |
| IPC 领域   | `apps/desktop/src/main/ipc/`                     | 工作区与附件、模型配置、任务与改动、扩展与同步等服务 |
| 跨进程桥   | `apps/desktop/src/preload/index.ts`              | 明确列出的 API、事件转发和订阅清理                   |
| 界面       | `apps/desktop/src/renderer/main.tsx`、`store.ts` | 草稿、任务选择、事件展示、面板与交互状态             |
| 公共契约   | `packages/shared/src/index.ts`                   | `DesktopAPI`、DTO 和输入 schema                      |

不要在 renderer 中直接导入主进程服务、Node 文件 API 或数据库连接。业务规则留在服务或共享包中，IPC 只负责来源检查、参数校验和转交。

## 启动与关闭

1. 就绪前确定数据目录，设置应用名并取得单实例锁；第二次启动唤起已有窗口。
2. 就绪后迁移旧 SQLite 数据库，创建 `LocalPersistence` 并恢复任务记录。未完成任务变为中断状态，等待明确恢复。
3. 读取主题与语言，创建窗口和 IPC Router；模型处理器恢复系统安全存储可解密的配置。
4. 注册领域处理器后加载界面。开发模式仅接受固定的 `http://127.0.0.1:5173`；其余情况加载构建后的本地页面。
5. 退出前注销 IPC、停止任务宿主和终端。窗口全部关闭时退出应用，包括 macOS；当前不采用关闭窗口后驻留 Dock 的模式。

## 一次任务如何执行

发送提示词后，`agent:start` 校验提示词、任务选项和附件 ID，并将当前工作区交给 `TaskHost.start`。任务宿主判断演示、普通问答或项目任务，选定模型、上下文、审批器、工具与工作树，再创建 `AgentRunner`。

工具和模型事件通过 `agent:event` 回传，renderer 的 store 更新任务与时间线。任务宿主同时写入事件、改动和检查点。`agent:control`、`agent:approve`、`agent:answer` 和 `agent:input` 分别处理运行控制、权限、待回答问题与执行中补充要求。

追问是带 `parentTaskId` 的新一轮，保留关联历史与工作树；Resume 使用原任务检查点。这两条路径不能混用。详见 [执行与恢复](run-controls.md)。

## IPC 如何扩展

处理器按职责拆分：

- `workspace.ts`：目录选择、最近项目、任务文件快照与附件导入读取。
- `models.ts`：模型配置恢复、密钥保护、配置切换、模型列表和连接测试。
- `tasks.ts`：任务生命周期、导入导出、记忆与授权、Git 审阅和工作树交付。
- `services.ts`：MCP、Skills、更新、账户同步、浏览器预览与终端。
- `index.ts`：装配上述模块，并注册主题、剪贴板和外部链接操作。

新增能力时，先修改 `DesktopAPI` 和必要的 schema，再添加 preload 的明确方法与领域处理器。所有请求都经过 Router；通道名、参数元组与返回类型均由 `DesktopAPI` 推导，`RegisterHandler` 检查处理器的同步或异步返回值是否符合契约。处理器输入保持为 `unknown`，必须经过运行时校验；任务状态和权限检查也须保留。TypeScript 类型不能验证跨进程传入的数据。修改这些类型时，在 `tests/types/desktop-ipc.ts` 中补充纯编译期回归断言。

事件订阅必须返回清理函数，并在组件卸载时调用。不要暴露通用的 `invoke(channel, args)` 或直接向 renderer 传递 Electron 事件对象。`window.forge` 仅作为旧集成的兼容别名保留，新代码使用 `window.hikari`。

## 窗口隔离与命令沙箱

每个窗口启用 `contextIsolation` 和 renderer `sandbox`，关闭 `nodeIntegration`；拒绝页面自行打开窗口、主动导航和默认会话的权限请求。对话窗口由主进程创建并注册。IPC Router 只接受已注册窗口的主 frame，通过 `AsyncLocalStorage` 在异步处理期间保留请求来源，并在窗口关闭后移除其注册。各窗口独立保存当前工作区，系统对话框归属于发起请求的窗口；任务和终端事件广播到已注册窗口。

这些设置保护 renderer 边界，不等于 Agent 命令的 OS 沙箱。命令限制由 `packages/sandbox` 决定，交互终端在宿主账户下运行。MCP、浏览器和联网操作仍遵循各自审批规则。

## 原生交互与当前限制

所有应用内弹窗使用 `renderer/dialog.tsx`，统一 ×、Escape、遮罩点击、焦点恢复和滚动区域。弹窗打开时必须停用背景标题栏的 `-webkit-app-region: drag`，否则长弹窗的 × 虽能被 DOM 测试点击，实际鼠标事件却可能被窗口拖拽拦截。

SQLite 使用同步接口；展示事件会短暂合并写入，执行边界与检查点立即落盘。OCR 和文档解析放到附件 Worker，但任务编排、部分索引、向量排序和数据库事务仍占用主进程。大集合限制、输出分页和批量写入降低成本，并不代表已实现全量后台计算或大型向量索引。排查卡顿时先测量这些路径，再决定是否迁到 Worker 或 utility process。

[开发与验证](development.md) 说明构建与测试入口；[数据、记忆与检索](memory-and-storage.md) 说明持久化和召回的实际边界。

## 共享执行宿主

`packages/agent-host` 将现有运行时、工具、权限、MCP 和 Skills 组合为 CLI 与执行节点宿主。桌面端继续负责附件及界面持久化，通过 `prepareCapabilities` 共用委派、Hooks、LSP 和历史能力。`ipc/platform.ts` 验证计划、插件、配置与恢复请求。远程 HTTP 适配器只暴露明确选择的项目；API 服务负责节点注册与持久执行租约，不接管本地模型密钥。
