# Superagent 任务协调

Hikari 本地服务可以接收获授权的工作、分配隔离执行器、跨执行轮次保留任务，并优先展示需要人工处理的事项。通过 `pnpm agent serve` 启动；普通桌面、CLI 和 Worker 现已共用执行会话与工作授权。参见[整项目架构](architecture-upgrade.md)。

## 设计依据

本实现参考 2026-11-13 阅读的 [DeepSeek Superagent 公开研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype)，尤其是[原则](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/000-philosophy.md)、[领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/001-domain.md)、[授权](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/002-authorization.md)、[执行](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/003-execution.md)与[面板](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/main/docs/005-panel.md)。DeepSeek 将其标记为研究代码，并说明公开版本与内部实现、文章设计并不完全相同。

核心原则是尽量减少人的注意力开销，并交付有用成果。协调器只判断工作是否获授权；执行器负责调查、实现和验证。消息、文档和检索结果提供上下文，不能授予权限。

```text
来源 Source → 不可变事件 Trigger → 准入 / 规则研判 → 决定 Decision
                                                  ↓ 接单
                                    工单 Ticket + 授权 Mandate
                                                  ↓ 派工 Assignment
                                      Hikari 执行器 + worktree
                                                  ↓ 结构化报告
                                         等待事件 / 就绪 / 待人工处理
```

| 概念               | 本项目中的实现                                                         |
| ------------------ | ---------------------------------------------------------------------- |
| Source / Thread    | 本地操作者及配置的事件流；身份仅在各自来源内有效                       |
| Trigger / Decision | 事件 ID 在同一来源内唯一，内容不可变，准入结果持久化                   |
| Policy / Mandate   | 带版本的名单与文字规则；接单记录原请求者、范围、策略版本及匹配规则原文 |
| Ticket             | 获授权的工作，独立保存状态、订阅、输入与报告                           |
| Assignment         | 一轮执行，对应单独保存的运行时 Task；后续轮次保留工单与隔离目录        |
| Subscription       | 上下文扇出；所属线程的人类跟进由执行器处理，仅上下文订阅不授予工作权限 |
| Channel            | 带原始来源与线程地址的本地确认、结果和人工待办记录                     |

## 启动与处理待办

按 [CLI 文档](cli.md) 配置模型后运行：

```sh
AGENT_WORKSPACE=/absolute/path/to/project pnpm agent serve 4319
```

打开终端打印的本地地址，输入访问令牌。网页仅在当前标签页的 session storage 中保存令牌。**Start** 代表已认证操作者的明确请求。Execute 默认使用隔离 worktree；Plan 保持只读，不创建 worktree。创建 worktree 需要仓库至少有一次提交，忽略的依赖不会复制。

**Needs your attention** 优先列出输入投递失败、待回答、工具审批、暂停、阻塞、失败和待审阅成果。正常执行或等待事件的工单保留在 **Work**。**Needs evaluation** 可以重试未完成的研判。准入历史记录忽略事件和 observe 结果，不为它们生成额外通知。

通过 **View diff** 检查成果，再用 **Mark reviewed** 结束待审阅工单。此操作只记录审阅，不会应用补丁、合并分支或发布。执行轮次完成后，工单仍可等待人工审阅；有文件变更时始终要求审阅。

追加指令在原授权范围内继续同一工单。**stop** 撤回授权，后续工作需要新请求。人工暂停会跨消息、轮次和重启保留，只有操作者恢复才能解除。

## 明确请求与主动规则

初始策略只有 `local` 来源，允许 `operator`，默认模式为 **observe**。名单中的人明确向智能体提出请求时，所有模式均可接单。名单中的机器人只能产生推断候选；未知机器人和名单外的人不能发起新工作。已有工单接收订阅线程的上下文，不因此扩大原授权。

| 模式              | 推断工作                                                           |
| ----------------- | ------------------------------------------------------------------ |
| `off`             | 忽略                                                               |
| `observe`（默认） | 每条启用规则研判一次；匹配时记录“会接单”，不启动执行器，不发送确认 |
| `auto`            | 有效研判至少匹配一条启用的文字规则才接单                           |

没有启用规则时直接忽略推断工作，不调用研判模型。研判器没有工具。无效、失败或基于旧策略的研判不能启动工作，并记录 `unavailable`。研判使用配置的模型，其费用独立于执行器的任务预算；对公开事件流应在供应商账户设置用量限制。

保存策略必须提交当前 `baseVersion`，并保留旧版本。策略变更作为上下文交给运行中的工单，不改写原 Mandate。已结束工单恢复前，重新验证来源是否仍监听、原请求者是否仍获授权；推断授权还要求处于 `auto`，且原匹配规则仍启用、原文未变。

## 事件接入 API

以下接口沿用 Bearer 令牌与同源检查：

| 接口                                     | 用途                                                       |
| ---------------------------------------- | ---------------------------------------------------------- |
| `GET /api/superagent`                    | 策略历史、事件、决定、工单、派工、通知与人工待办           |
| `POST /api/superagent/request`           | `{prompt, options?, isolated?}`，本地明确请求              |
| `POST /api/superagent/policy`            | `{baseVersion, policy}`，操作者更新策略                    |
| `POST /api/superagent/triggers`          | 可信 Source 适配器提交事件                                 |
| `POST /api/superagent/reevaluate`        | `{source, triggerId}`，重试未被工单占有的失败或忽略事件    |
| `POST /api/superagent/tickets/:id`       | `{action}`：`pause`、`resume`、`stop`、`retry`、`reviewed` |
| `POST /api/superagent/tickets/:id/input` | `{text}`，原授权范围内的操作者跟进                         |

策略示例（作为 `policy`，连同当前 `baseVersion` 提交）：

```json
{
  "mode": "observe",
  "sources": [
    { "id": "local", "allowedActors": ["operator"], "threads": ["*"] },
    {
      "id": "github:team/project",
      "allowedActors": ["maintainer"],
      "bots": ["ci[bot]"],
      "threads": ["*"],
      "receiveAll": true
    }
  ],
  "rules": [
    {
      "id": "failed-ci",
      "instruction": "调查 team/project 失败的 CI，在本地修复并验证，交给人审阅；不要推送或合并。"
    }
  ]
}
```

事件示例：

```json
{
  "id": "stable-provider-delivery-id",
  "source": "github:team/project",
  "thread": "pull:42",
  "actor": "ci[bot]",
  "actorKind": "bot",
  "addressed": false,
  "text": "CI failed: parser regression in tests/parser.test.ts"
}
```

这是操作者接口，不是公开 webhook。接入适配器必须验证上游签名，从供应商元数据确定身份、消息类型与是否向智能体发问，丢弃自身机器人消息，限制仓库，保存读取位置并复用稳定事件 ID。不要把操作者令牌交给外部消息作者。同一 ID 换内容会被拒绝，相同事件重投返回已有决定。

## 执行与恢复

执行器沿用沙箱审批、Token/时间预算、生命周期钩子、MCP、检索和确定性验收。获准启动工作不等于获得文件、命令、网络或发布权限。`report_work` 提交 `progress`、`waiting`、`ready`、`blocked`、`failed` 或 `dropped`；`blocked` 可带一个 `humanAction.question`。等待、受阻、失败、无需处理会结束当前执行轮次并释放资源；`ready` 仍必须通过已有验收。报告和变更工具不能混在同一批调用中。

`read_source_event` 可读取实时卡片中被截断的完整事件文本。`hand_back` 将超出原范围的所属跟进交回研判；`follow_thread` 只订阅上下文。人类跟进在交回或工单结束时释放未读输入前，归执行器所有。机器人不能恢复已结束工单，自动输入也不能唤醒受阻或失败执行器。

领域状态和启动、投递、停止意图一起原子保存到 `.agent/state/superagent.json`，项目进程租约防止两个 Superagent 服务同时持有。运行时 Task 和检查点仍在 `.agent/runs/`。输入“已投递”与“执行器已读取”分别记录，未读输入会保留给后续派工。策略历史、通知和审计记录包含来源文本，应作为项目私有状态备份，不要提交。

默认最多三个实时执行器，已有工作的后续执行可使用一个额外名额。结构化报告交接会释放名额；实时暂停和工具审批等待会保留资源、名额与期限。协调服务的执行器通过报告交接提出决策问题，不使用 `ask_user`；委派工作者不会继承父工单的协调工具。投递失败从两秒开始退避，重复失败会显示待办。启动失败、重启时执行中的任务和结果不确定的投递会停下来等待检查，不会盲目重放外部操作。**Retry** 创建新派工，沿用目录并提供之前结果和有界对话上下文，不恢复旧模型完整会话；每轮独立计预算，不是整个工单累计预算。重试前应检查当前文件及外部状态。

## 架构取舍与边界

`agent-core/src/superagent.ts` 定义契约，`agent-runtime` 的 `SuperagentEngine` 是领域唯一写入者，`agent-host` 的 `SuperagentSession` 将其接到原 `SessionHost` 执行器。CLI 与 `RemoteControlServer` 负责适配，无需新增编排依赖。

保留 Hikari 执行器而非替换为 DeepSeek Harness，可以继续使用现有模型配置、附件/RAG、检查点和验收。独立工单层避免把“模型一轮结束”当作“成果已审阅”。本地原子状态适合单项目服务，单文件上限为 16 MB，不是多节点队列；接近上限前备份和归档历史，不要删除运行中记录腾空间。

这是对公开设计的适配，并非完整移植。新协调服务尚未实现飞书/GitHub 原生轮询与外发、PR 关闭/合并跟踪、重启自动续跑、通用准入表、跨工单 attach 路由、提示词编辑及版本 UI。Channel 通过已认证 API/面板本地交付通知，不主动联系外部账户。已有自托管 GitHub/CI Worker 和定时任务仍是独立、明确配置的执行入口。桌面对话和 `/api/tasks` 也通过共享会话把明确用户请求接入同一工作领域，原生 UI 和存储作为适配器保留；CLI 服务页面和 `/api/superagent/*` 额外提供事件准入、历史与监管。

回归测试位于 `tests/runtime/superagent.test.ts`、`tests/integration/superagent-host.test.ts` 和 `tests/e2e/superagent.spec.ts`，按[开发与验证](development.md)运行。夹具测试不代表真实模型的规则研判质量或生产连接可靠性。
