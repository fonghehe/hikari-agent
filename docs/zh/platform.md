# 自动化、子 Agent 与开发集成

这些能力接入现有桌面端、CLI 和任务运行时。远程执行使用你注册的电脑或服务器，模型、语言服务器和托管环境由你配置。安装 Hikari 不会自动开通托管云服务。

## 1. 动态子 Agent

真实项目任务提供 `spawn_agent`、`wait_agent`、`send_agent_message` 和 `cancel_agent`。可以要求主 Agent 将独立调查交给不同人员，再汇总文件证据。每名人员使用独立上下文，并继承主任务的工具限制。每轮运行最多同时执行三个子 Agent，总共委派十二次，不支持嵌套委派。

默认人员只读。`writable: true` 会创建包含当前未提交文件的独立 Git 工作树；修改留在该工作树中，不会自动回写主工作区。审阅返回的路径和差异后，使用已有工作树交付流程或 Git 处理。依赖和被忽略文件不会复制。

主任务为人员预留部分剩余 Token 和费用额度，并计入实际用量。接受完成前会等待人员结束；取消或中断主任务会中断人员。中断的操作不会自动重放。规划模式不提供委派入口，也不允许伪造写工具调用。

插件可提供具名角色，例如示例插件的 `project-review-reviewer`。角色说明能约束工作范围，但不能保证模型审查一定准确。

## 2. 生命周期 Hooks

在 **项目聊天 → 记忆与扩展 → 自动化与集成 → 生命周期 Hooks** 添加，或手动配置 `.agent/hooks.json`：

```json
[
  {
    "id": "format-source",
    "event": "PostToolUse",
    "tool": "apply_patch",
    "command": "node",
    "args": ["scripts/format.mjs"],
    "timeoutMs": 30000
  }
]
```

支持 `SessionStart`、`PreToolUse`、`PostToolUse` 和 `Stop`。`tool` 可选，按工具名称精确匹配。命令通过标准输入接收有长度限制的 JSON，包含事件、任务、调用和结果；不会自动进行 shell 插值。

Hook 使用任务原有的命令审批与沙箱。拒绝授权、非零退出码或超时会阻止对应操作；工具已经执行后发生的 Hook 失败不能撤销已有副作用。Hook 修改会记入改动历史，并使先前测试证据失效。`Stop` 在最终验收前执行。

规划模式及开发工作流的只读阶段不运行命令 Hook；进入可写实施阶段才执行会话 Hook。配置修改对新任务生效。无人值守执行也需要合适的授权，不能通过 Hook 绕过审批。

## 3. 定时任务与监控

在 **自动化与集成 → 定时任务** 创建重复任务，或指定一次性执行时间。桌面端为明确登记的项目保留调度，并绑定创建时的模型配置。电脑和应用必须保持运行。通知可选“有变化或失败”“每次执行”或“仅失败”。监控要求应明确什么变化需要处理，没有变化时使用稳定的答复。

CLI 使用相同的持久化配置，例如 `schedule.json`：

```json
{
  "name": "检查项目变化",
  "prompt": "检查当前项目，只报告需要处理的变化；没有需要处理的变化时固定回答：暂无变化。",
  "cadence": { "kind": "interval", "minutes": 60 },
  "isolated": false,
  "notify": "changes",
  "options": { "mode": "plan", "maxTokens": 40000, "maxDurationMs": 300000 }
}
```

```sh
pnpm agent schedule add schedule.json
pnpm agent schedule list
pnpm agent schedule run
# 其他操作：schedule pause ID / resume ID / remove ID
```

单次执行使用 `{"kind":"once","at":"2026-12-01T01:00:00Z"}`。Cron 示例：`{"kind":"cron","expression":"0 9 * * 1-5","timezone":"Asia/Shanghai"}`。Cron 为五字段，支持列表、范围和步长，星期使用 0–6。按所选时区计算，含夏令时变化；未来一年没有可用执行时间的表达式会被拒绝。

一个项目只允许一个调度进程持有。同一计划不会重叠执行，错过的重复执行合并处理。崩溃时正在执行的计划会在恢复后停用，需先检查保存的任务再重新启用，不能直接重放未知结果。不要同时用桌面和 CLI 调度同一项目。CLI 通知输出为 JSON 事件。

无人值守 CLI 默认拒绝命令。`HIKARI_ALLOWED_COMMANDS='["node"]'` 显式允许该程序在所选沙箱内运行，包括传给它的脚本；应按实际需要配置。

## 4. LSP 代码语义能力

先安装对应语言服务器，再在 **语言服务器** 中填写命令、参数和扩展名，或配置 `.agent/lsp.json`：

```json
[
  {
    "name": "typescript",
    "command": "typescript-language-server",
    "args": ["--stdio"],
    "extensions": [".ts", ".tsx", ".js", ".jsx"],
    "languageId": "typescript"
  }
]
```

批准启动后，Agent 可使用 `lsp_definition`、`lsp_references`、`lsp_hover` 和 `lsp_diagnostics`；行列从 0 开始。每次查询前会同步当前文件，任务结束后关闭服务器。语言服务器不能要求客户端直接写文件，工作区外的定位结果不会返回给模型。

LSP 需要命令权限，规划模式不提供。诊断能力取决于服务器和项目配置；不支持拉取诊断时使用服务器推送结果，此时可能尚未收到最新结果。仍需运行项目编译器和测试。在 Windows 沙箱中，语言服务器和工具链需要安装在对应 Linux 镜像中，宿主机程序不会自动复制进去。

## 5. VS Code 集成

扩展源码位于 `integrations/vscode`。执行 `pnpm vscode:pack`，然后在 VS Code 的 **扩展 → 从 VSIX 安装** 中选择 `release/hikari-workspace-0.1.0.vsix`。

为同一工作区开启桌面远程控制，或执行 `pnpm agent serve 4319`。在编辑器运行 **Hikari: Connect to Local Host**，填写地址与令牌。令牌使用 VS Code SecretStorage 保存。

**Hikari Tasks** 视图支持新建任务、查看结果、暂停、继续、取消、补充要求、回答问题、审批操作和打开差异。新建时可携带当前文件的选区、路径和编辑器诊断；未保存的文本会明确标识，不会覆盖磁盘内容。编辑器与执行端必须对应同一个项目，未受信任工作区不能启动任务。

当前包含 VS Code 扩展；JetBrains 可通过外部工具调用 CLI，但没有专用插件。

## 6. 手机或浏览器远程接管

在 **自动化与集成 → 远程控制** 开启服务。默认仅监听 `127.0.0.1:4319`，复制令牌后打开面板连接。面板直接控制当前运行中的任务，可补充要求、处理审批和回答问题，与“上传/下载任务快照”分别使用。

从其他设备连接时，使用 HTTPS 反向代理或 SSH 隧道。“允许局域网连接”会监听 `0.0.0.0`，访问时应替换为电脑实际的局域网 IP 或主机名。CLI 对应 `HIKARI_REMOTE_HOST=0.0.0.0 pnpm agent serve 4319`。

令牌拥有所选项目的控制权，请妥善保管。停止服务后自动生成的令牌失效。CLI 可通过至少 32 字符的 `HIKARI_REMOTE_TOKEN` 固定令牌。接口采用 `Authorization: Bearer TOKEN`，不接受 URL 中的令牌，并检查浏览器来源。

执行电脑仍需保持运行。断线后可以重新连接，重启中断的任务需先检查当前状态再继续。该接口也供 VS Code 使用，提供任务列表、创建、控制、补充输入、审批、回答、差异、计划和历史恢复。

## 7. 自托管云端执行

在服务器安装 Node 24 和项目依赖，运行 `pnpm server`，为外部访问配置 HTTPS。数据使用 `SQLITE_PATH` 或 `DATABASE_URL`，Redis 可选。打开 `/execution` 进入适配手机的任务控制台，使用已有账户登录；可通过桌面账户同步流程或 `/auth/register` 创建账户。

另准备执行机器，安装 Git、ripgrep、模型配置和系统沙箱，将公开的项目别名映射到预先准备好的本地代码目录：

```sh
export HIKARI_SERVER_URL='https://hikari.example.com'
export HIKARI_WORKER_PROJECTS='{"my-project":"/srv/projects/my-project"}'
export HIKARI_ACCOUNT_TOKEN='登录 /auth/login 返回的 token'
pnpm agent worker register build-machine
```

把返回的 `workerToken` 保存为执行端环境变量 `HIKARI_WORKER_TOKEN`，然后运行 `pnpm agent worker run`。`--once` 最多领取一次任务，便于排查。模型沿用 CLI 的 `AGENT_*` 配置，浏览器另需 Chromium。未被 `HIKARI_ALLOWED_COMMANDS` 覆盖的命令会等待远程审批。

控制台选择执行节点和项目即可提交任务、查看进度并处理请求。服务端不接受任务提交者指定任意主机路径或模型密钥。执行节点只服务所属账户及已注册的项目别名；可通过认证后的 `DELETE /execution/workers/ID` 撤销凭据。

任务采用独占执行租约，状态更新续期，指令在确认处理前保留。租约过期后标记中断，不自动转交其他节点执行。私有运行断点留在执行机器，服务端只保存有长度限制、经过脱敏的展示快照；工作树也留在执行机器，需在那里审阅和交付。个人电脑关闭后，服务器及其执行节点仍运行，任务才能继续。

默认使用系统沙箱。专用 Docker 节点可设置 `HIKARI_WORKER_EXECUTION=container`，仅检测到 `/.dockerenv` 时允许在容器内使用主机命令权限，此时独立容器就是执行边界，不能挂载无关主机目录和密钥。联网还需同时启用任务联网选项和 `HIKARI_WORKER_ALLOW_NETWORK=true`。

当前不会替你开通机器、克隆任意仓库、安装项目依赖或提供公共多租户托管。

## 8. 插件与目录

插件在 **自动化与集成 → 插件** 安装、更新或移除。文件夹内放置 `hikari-plugin.json`，声明名称、语义版本、说明，以及可选的 `skills`、`hooks`、`agents`、`lsp`、`mcp`。参考 `examples/plugin/hikari-plugin.json`。Skill 指向含 `SKILL.md` 的目录，对外名称为 `插件名:技能名`；角色和 MCP 名称使用 `插件名-` 前缀。命令参数可用 `${plugin}` 表示安装目录。

```sh
pnpm agent plugin inspect examples/plugin
pnpm agent plugin install examples/plugin
pnpm agent plugin list
pnpm agent plugin update /path/to/new-version
pnpm agent plugin remove project-review
```

安装不执行脚本，拒绝符号链接及特殊文件，限制为 200 个文件、每个 2 MB、总计 20 MB。安装内容有 SHA-256 锁定，修改后需重新安装。桌面端要求结束活动项目任务后才能更新；CLI 操作者也应先停止相关任务。

插件目录可以是本地文件或 HTTPS JSON，`plugins` 中每条包含 `name`、`version`、`description`、`path`、`sha256`。相对路径从目录文件所在位置解析。`pnpm agent plugin registry registry.json` 只发现条目；选择后用 `plugin install PATH SHA256` 校验安装。目录可通过现有代码库或文件服务分发；Hikari 当前不托管在线市场，也不自动升级插件。

### 分发插件包

运行 `pnpm agent plugin pack examples/plugin /tmp/project-review.bundle.json` 生成分发包和内容摘要，将它与目录 JSON 放到自己的 HTTPS 文件服务。目录路径可使用相对 URL。桌面端可填写目录网址，浏览并按显示的 SHA-256 安装或更新。远程安装强制校验摘要、名称及版本，拒绝路径穿越，不跟随重定向。CLI 先用 `plugin registry https://example.com/registry.json` 浏览，再用 `plugin install https://example.com/project-review.bundle.json SHA256` 安装。

## 9. GitHub 与 CI

`integrations/github-action/action.yml` 提供复合 Action，可运行有预算限制的只读审查并输出 JSON 报告路径。填写模型、接口和密钥；只有显式启用 `post-comment: 'true'` 并提供权限适当的 `github-token` 时才回传评论。模型凭据放在 GitHub Secrets 中，按需要准备 checkout 和差异基线，不要向不可信 Fork 工作流暴露密钥。

服务端自动触发需设置 `HIKARI_GITHUB_WEBHOOK_SECRET` 和 `HIKARI_GITHUB_ROUTES`。每条路由包含 `repository`、账户 ID `owner`、`workerId`、项目别名 `project`、`allowedActors` 和可选 `postResults`。将 GitHub JSON Webhook 指向 `/integrations/github/webhook`，设置相同的签名密钥。

支持新建/重开的 Issue，以及新建、重开、同步更新的 PR。未列出的仓库和操作者会被拒绝；投递 ID 用于去重，持久化中断后的重试也使用同一个任务 ID。

执行端从 GitHub API 获取 PR 差异或 Issue，按只读模式审查，不 checkout 或执行 PR 代码。私有仓库需在执行端配置 `GITHUB_TOKEN`。路由的 `postResults: true` 明确开启结果评论的发布或更新。模型报告应核对引用代码，不能因为流程成功就认定结论正确。

## 10. 对话与代码历史

在 **管理任务 → 对话与代码历史** 选择检查点，预览后恢复对话、代码或二者。恢复对话会新建可继续的中断任务，不恢复旧授权，也不沿用旧测试结果。只恢复代码时保留对话。

CLI 提供 `pnpm agent timeline list`、`timeline preview ID`、`timeline restore ID code|conversation|both`。对话恢复会输出新任务 ID，再使用 `pnpm agent resume ID`。

真实项目运行前后会记录快照，最多保留 100 条索引。文本捕获总量限制为 8 MB，二进制、大文件、权限变化需外部恢复，一次最多恢复 20 个文本文件。文件在最近记录后又发生变化时会报冲突，不覆盖用户的新改动；其他用户文件会保留。私有元数据、依赖与外部副作用不会回退。捕获失败会记录 `timeline.error`，说明该时间点不可用。仍需使用 Git 提交和备份保留长期历史。

## 11. 持续目标

在 **任务选项 → 验收与预算** 填写持续目标、续跑次数和资源上限。CLI 使用 `AGENT_GOAL` 以及可选的 `AGENT_GOAL_CONTINUATIONS`：

```sh
AGENT_GOAL='修复结算测试并通过验收' \
AGENT_MAX_TOKENS=100000 AGENT_MAX_MINUTES=30 \
pnpm agent run '调查结算测试失败原因'
```

目标随私有断点保存。模型需要调用 `update_goal` 提供完成证据，仍需通过任务原有的确定性验收。尚未完成的答复会触发继续处理，沿用原 Token、费用和时间预算。暂停、取消、外部阻塞、模型轮次和续跑次数限制仍会停止执行。

模型声称目标完成加上配置的验收，只能证明相应检查范围，不能保证任意正确性。被阻塞或耗尽预算的目标仍保留未完成状态。

## 执行占用与断线恢复

桌面端、CLI、执行节点、可写子 Agent 和历史恢复使用同一套工作区占用记录。同一目录同时只允许一个执行者；独立工作树可以分别运行。启动另一个实例读取历史时，不会把仍由存活进程持有的任务改成中断。任务结束或初始化失败后释放占用；进程崩溃后，下次启动任务可以回收已经死亡的进程占用，但不会自动重放任务。

占用记录位于 `.agent/state/execution-owner.json`，仅用于同一电脑上的本地文件系统。它不限制外部编辑器，也不能协调不同容器 PID 命名空间或共享网络盘。所有 Hikari 实例都需要使用支持该协议的版本。短事务使用 `.json.lock`；如果进程恰好在事务期间崩溃，会保守阻止后续写入，确认没有执行者后再由操作者清理遗留锁。

执行节点会对临时网络故障和 408、429、500、502、503、504 响应进行退避重试。领取使用持久化请求标识，状态更新也使用幂等标识，因此服务端已处理但响应丢失时不会领取第二个任务或重复完成上报。重连最长 90 秒，并在上次确认的 120 秒租约到期前至少 5 秒停止等待；凭据或租约被拒绝时立即停止。中断原因和本地任务 ID 保存在原执行节点的任务记录中，重新启动 Worker 不会重放已经开始的模型任务。

## 验证边界

修改这些能力时运行 `pnpm check`、`pnpm build`、`pnpm docs:build`、`platform-*.test.ts` 和相关桌面/浏览器测试。受控模型、LSP 和 GitHub 测试服务验证运行框架、进程通信、HTTP 边界及失败处理，不代表真实模型质量。具体语言服务器、公开 Webhook 投递、HTTPS 部署和真实 GitHub 回传，需各自在实际环境验收。

## 自托管资源限制与运维

执行服务默认每账户最多 10 个排队/执行中的任务、5 个执行节点，每任务最多 200,000 Token 和 30 分钟。分别用 `HIKARI_MAX_ACTIVE_JOBS`、`HIKARI_MAX_WORKERS`、`HIKARI_JOB_MAX_TOKENS`、`HIKARI_JOB_MAX_MS` 配置。未指定任务预算时补入服务端上限，超限请求拒绝；账户配额通过持久化版本预留协调并发，创建失败的预留最多保留 60 秒。已完成任务会释放执行容量，但历史记录仍需单独管理。

`/ready` 检查数据库与已配置 Redis，失败返回 503；`/health` 保留存活检查。设置至少 32 字符的独立 `HIKARI_OPS_TOKEN` 后，可用 Bearer 请求 `/operations/status` 查看响应状态数量、累计耗时与内存；未启用时返回 404。不要复用账户或 Worker 令牌。正式服务入口开启结构化请求日志，只记录方法、无查询参数的路径、状态和请求 ID，不记录正文及认证头。

这些是自托管基础限制，不提供统一计费、企业 SSO、托管容器调度、完整审计平台或容量 SLA。先在专用执行环境中验证负载、备份、告警和故障恢复，再考虑对外多租户托管。
