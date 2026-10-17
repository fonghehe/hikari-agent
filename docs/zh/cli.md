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

## 模型预设与开发工作流

`AGENT_PROVIDER` 可填写 [模型配置](configuration.md) 中的服务 ID，例如 `deepseek`、`qwen`、`kimi`、`glm`、`gemini`、`doubao`、`minimax`、`siliconflow`、`groq`、`grok`、`mistral`、`openrouter`、`ollama` 和 `lmstudio`。预设提供默认地址，`AGENT_BASE_URL` 可指定区域或私有接口。Azure 和 `compatible` 需要填写地址。

`AGENT_WORKFLOW=development` 启用调查、规划、实施和独立只读审查。通过 `AGENT_CONTEXT_WINDOW`、`AGENT_MAX_OUTPUT_TOKENS` 设置模型限制；`AGENT_STREAMING=false` 关闭流式输出。`AGENT_REASONING_EFFORT=low|medium|high` 为支持的模型指定推理强度。恢复任务需使用原来的服务、模型和地址。

## 运行评测

两个评测命令会自动读取仓库根目录的 `.env`，已导出的环境变量优先。桌面端保存的模型配置不会自动传给命令行。先执行 `cp .env.example .env`，再填写自己的服务、模型 ID 和密钥。预设服务可将 `AGENT_BASE_URL` 留空以使用默认地址；`compatible` 与 Azure 必须填写地址。本地服务是否需要密钥取决于服务配置。

查看帮助与用例不需要密钥，也不会请求模型：

```sh
pnpm eval:agent --help
pnpm eval:agent --list
pnpm eval:capabilities --help
pnpm eval:capabilities --list
```

配置后先选择较小范围运行，再按需运行全部用例：

```sh
EVAL_CASES=cart-rounding EVAL_SAMPLES=1 pnpm eval:agent
CAPABILITY_CASES=plan-is-read-only pnpm eval:capabilities
# 全部用例：pnpm eval:agent / pnpm eval:capabilities
```

真实运行会消耗 Token，并在临时工作区自动允许评测工具操作。浏览器用例需要已安装的 Chromium；四项能力检查包括只读计划、流式取消、不重复副作用的中断恢复、浏览器观察与交互。`cancel-live-model-stream` 要求开启流式输出；不支持流式的服务需从 `CAPABILITY_CASES` 中排除它。

`AGENT_MAX_TOKENS`、`AGENT_CONTEXT_WINDOW`、`AGENT_MAX_OUTPUT_TOKENS`、`AGENT_STREAMING` 和价格配置对两个入口一致生效。缺少必需配置或参数无效时，命令给出具体提示并退出，不会创建空的成功报告；配置错误退出码为 2，评测未通过为 1，通过为 0。逐例运行进度会显示在终端，完整结果保存在 `.agent/evals/`。

不连接模型时，可运行 `pnpm eval:agent --validate` 检查六个固定验收器。它只证明错误示例被拒绝、参考答案被接受，不代表 Agent 质量；能力评测没有离线验证模式。评测通过只覆盖对应用例，不能代替实际项目验收。

Agent 评测覆盖金额计算、稳定去重、跨模块修改、取消、不可信仓库内容和测试驱动修复；修复用例必须先复现测试失败，并保留原测试。报告记录成功率、延迟分位、工具失败、验收、用量和私有任务事件。`EVAL_SAMPLES=1..10` 控制每个用例的尝试次数；比较工作流时使用相同模型和样本数，并保留失败记录。每个任务默认最多 100,000 Token。

浏览器用例前运行 `pnpm exec playwright install chromium` 安装依赖。

## 自动化与开发集成

运行 `pnpm agent platform-help` 查看定时任务、插件、历史恢复、远程控制、执行节点和 CI 命令。配置、审批与部署见[完整指南](platform.md)。

## 固定提交的真实仓库评测

使用 `examples/evals/repository-suite.json` 编写本地评测清单。每个用例指定本地仓库、完整提交 SHA、任务、固定验收命令、允许修改的文件和必须保持原样的测试或配置。示例中的路径和全零 SHA 都必须替换为自己的值。

```sh
EVAL_REPOSITORY_SUITE=/absolute/path/to/suite.json pnpm eval:repository --validate
EVAL_REPOSITORY_SUITE=/absolute/path/to/suite.json EVAL_SAMPLES=3 pnpm eval:repository
```

仓库相对路径以清单所在目录为基准。每次评测克隆指定提交到临时目录，不复制源工作区的未提交内容，也不修改原仓库。`setup` 可配置最多五条依赖准备命令；默认禁止联网，需要下载依赖时显式设置该用例的 `setupNetwork: true`。准备命令和验收命令由你审阅，Agent 执行与最终验收仍禁止联网。

`--validate` 只确认提交可检出、准备步骤成功且验收能复现失败，不调用模型，也不验证修复质量。实际运行沿用 `AGENT_*`、`EVAL_CASES` 和 `EVAL_SAMPLES`；单任务最多 50 轮、3 分钟及所设 Token 预算。只有任务完成、Git 可见的文件改动非空且均位于允许路径内、保留文件未变且独立验收通过才记成功。即便模型修改测试后命令返回成功，也不能通过此评测。

`.agent/evals/*-repository/` 保存报告、脱敏任务记录和补丁。报告包含基线与最终验收退出码、提交、使用量、耗时、越界改动及保留文件检查。缺少模型配置时会明确失败；受控模型的入口测试不能作为真实模型成功率。

允许路径检查覆盖 Git 跟踪文件和未被忽略的新文件，跳过平台私有目录 `.agent`；它不会对依赖目录及其他忽略文件做完整性扫描。将验收所依赖的测试与配置显式列入 `preservePaths`，并审阅最终补丁。
