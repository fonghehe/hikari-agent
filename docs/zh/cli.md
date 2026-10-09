# 命令行使用

在 Hikari 源码目录中使用 CLI，先[安装项目依赖](installation.md#从源码运行)。

## 离线问答

未配置模型时默认使用模拟模式，也可显式选择：

```sh
AGENT_PROVIDER=demo pnpm agent run "你好"
AGENT_PROVIDER=demo AGENT_MODE=plan pnpm agent run "分析示例项目"
```

模拟输出来自预设示例，不代表修改了真实项目或执行了真实测试。

## 使用真实模型

填写自己的模型服务与工作区，然后发送请求：

```sh
export AGENT_MODEL='your-model-id'
export AGENT_API_KEY='your-key'
export AGENT_BASE_URL='https://your-provider.example/v1'
export AGENT_WORKSPACE='/absolute/path/to/repository'
pnpm agent run "找到失败的测试并修复"
```

使用 Anthropic 时设置 `AGENT_PROVIDER=anthropic`，并填写其 API 地址。使用本地兼容服务时填写其提供的地址；服务允许时可不填写密钥。

## 选项与控制

| 设置                  | 用途                           |
| --------------------- | ------------------------------ |
| `AGENT_PROVIDER=demo` | 选择离线模拟。                 |
| `AGENT_MODE=plan`     | 只分析，不修改文件或运行命令。 |
| `AGENT_MODE=execute`  | 执行实施任务，也是默认模式。   |
| `AGENT_MAX_STEPS=30`  | 设置模型轮次上限，范围 1–100。 |
| `AGENT_VISION=true`   | 为支持图片的模型启用截图输入。 |

CLI 输出任务事件。交互终端会在需审批的操作前询问；非交互输入默认拒绝这些操作。按 **Ctrl+C** 中断并保存真实任务，或取消模拟任务。

## 恢复与预算

真实任务会输出任务 ID。按 Ctrl+C 中断并保存状态，然后在相同工作区、已连接真实模型的环境运行 `pnpm agent resume TASK_ID`。等待回答的问题需要交互式终端，已完成或取消的任务不能恢复。

通过 `AGENT_MAX_TOKENS`、`AGENT_MAX_COST_USD`、`AGENT_MAX_MINUTES` 设置预算，通过 `AGENT_INPUT_PRICE`、`AGENT_OUTPUT_PRICE` 设置每百万 Token 的单价。默认 `AGENT_EXECUTION=restricted`；`AGENT_EXECUTION=host` 明确使用需审批的主机命令。`AGENT_NETWORK=true` 允许沙箱联网。

`pnpm eval:agent` 使用真实模型在临时工作区执行任务，并运行独立的行为验收。需要真实模型配置，会消耗 Token。`EVAL_SAMPLES=1..10` 控制每个任务的尝试次数，`.agent/evals/` 中的结果记录成功率、实际验收、时长和实际或估算用量。模拟模式和固定接口数据不能充当真实评测。

## 模型预设与开发工作流

`AGENT_PROVIDER` 可填写 [模型配置](configuration.md) 中的服务 ID，例如 `deepseek`、`qwen`、`kimi`、`glm`、`gemini`、`doubao`、`minimax`、`siliconflow`、`groq`、`grok`、`mistral`、`openrouter`、`ollama` 和 `lmstudio`。预设提供默认地址，`AGENT_BASE_URL` 可指定区域或私有接口。Azure 和 `compatible` 需要填写地址。

`AGENT_WORKFLOW=development` 启用调查、规划、实施和独立只读审查。通过 `AGENT_CONTEXT_WINDOW`、`AGENT_MAX_OUTPUT_TOKENS` 设置模型限制；`AGENT_STREAMING=false` 关闭流式输出。`AGENT_REASONING_EFFORT=low|medium|high` 为支持的模型指定推理强度。恢复任务需使用原来的服务、模型和地址。

评测覆盖金额计算、稳定去重、跨模块修改、取消操作和不可信仓库内容。`pnpm eval:agent --validate` 不连接模型，只确认固定验收会拒绝错误示例、接受参考答案，不代表 Agent 效果。真实评测记录成功率、延迟分位、工具失败、验收及 Token/费用用量。对比工作流时应使用相同模型与样本数。
