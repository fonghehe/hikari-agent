# 模型设置

## 连接服务

打开侧栏底部的 **模型设置**，选择服务商，填写账号可用的模型 ID 和所需密钥，再点击 **连接模型**。普通问答与附件分析无需工作区；开发任务需要打开工作区。

预设支持 OpenAI、Azure OpenAI / Foundry、Anthropic、Google Gemini、DeepSeek、Qwen、Kimi、GLM、豆包、MiniMax、SiliconFlow、Groq、Grok、Mistral、OpenRouter、Ollama 和 LM Studio。其他 Chat Completions 服务选择 **OpenAI compatible**。预设地址可按账号所在区域或自建网关修改。

| 服务                   | 基础地址                                            |
| ---------------------- | --------------------------------------------------- |
| OpenAI                 | `https://api.openai.com/v1`                         |
| Azure OpenAI / Foundry | 自己的资源地址，以 `/openai/v1` 结尾                |
| Anthropic              | `https://api.anthropic.com/v1`                      |
| Google Gemini          | `https://generativelanguage.googleapis.com`         |
| DeepSeek               | `https://api.deepseek.com/v1`                       |
| Qwen                   | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi                   | `https://api.moonshot.ai/v1`                        |
| GLM                    | `https://open.bigmodel.cn/api/paas/v4`              |
| 豆包                   | `https://ark.cn-beijing.volces.com/api/v3`          |
| MiniMax                | `https://api.minimax.io/v1`                         |
| SiliconFlow            | `https://api.siliconflow.cn/v1`                     |
| Groq                   | `https://api.groq.com/openai/v1`                    |
| Grok                   | `https://api.x.ai/v1`                               |
| Mistral                | `https://api.mistral.ai/v1`                         |
| OpenRouter             | `https://openrouter.ai/api/v1`                      |
| Ollama                 | `http://127.0.0.1:11434/v1`                         |
| LM Studio              | `http://127.0.0.1:1234/v1`                          |

以服务商提供的地址为准。Qwen 可使用工作空间与区域专用地址；Kimi 不同区域的密钥不可混用；豆包可能需要填部署 ID。Azure 使用 v1 API、API Key 和模型部署名，暂不支持旧的带版本接口或 Entra 登录。Anthropic 和 Gemini 使用原生协议，其余预设使用 Chat Completions。需要 AWS 签名、Vertex OAuth 或其他协议的服务可通过兼容网关连接。

点击 **获取可用模型**，在模型输入框建议中选择，也可手动填写。列表获取失败不影响手动设置。列表中的模型不一定支持工具或图片。

## 模型能力

- 开发任务开启 **此模型支持工具调用**。关闭后仅用于普通对话，不会发送工具定义。
- 仅对视觉模型开启 **此模型接受图片**。纯文本模型可利用本地 OCR 提取的文字。
- 接口不支持流式输出时，关闭 **流式输出**。
- **上下文窗口（Token）** 与 **最大输出 Token** 应按模型真实限制配置，输出空间会从上下文中预留。
- **推理强度** 默认采用服务商设置，只有模型支持时才选择具体强度。

**测试连接** 会发起小额计费请求并检查工具调用是否返回，不代表开发质量已经验证。真实服务失败会显示错误，不会切换到示例回答。

## 保存和切换配置

选择 **新增模型配置**，填写可选名称并连接。通过 **已保存的模型配置** 选择配置，再点击 **连接模型** 激活。新配置用于新任务；断点继续使用原配置。若原模型或地址变了，恢复它们后再继续，或 **重试** 创建采用新模型的任务。

密钥在系统安全存储可用时加密保存，否则仅在本次会话中保存。设置页面、对话导出和同步不会带回密钥。删除配置前，需要结束或取消使用它的未完成任务。

## 可选语义检索

打开 **语义检索**，开启后填写独立的 **向量模型**、**向量接口** 和 **向量 API 密钥**。接口需要兼容 OpenAI Embeddings，本地服务允许时可留空密钥。问答模型和向量模型可以来自不同服务。

附件和项目记忆会结合关键词及语义匹配，结果保留来源标签。首次发送文本前仍需批准联网请求。向量保存在本地，文本、模型或地址变化后重新计算。不要在同一个模型 ID 下改变向量维度。

启用后会向所选服务发送被检索的文档集合与项目记忆，不会自动发送整个代码仓库。集合最多 2,000 个片段、300 万字符，超出时拆分或关闭语义检索。向量费用不计入聊天预算。关闭时本地关键词检索仍可使用；启用后的服务故障会明确提示。

## 离线使用

**使用离线演示** 可在没有模型和工作区时体验示例问答，已有演示对话继续和重试仍是模拟。连接 Ollama 或 LM Studio 可离线使用真实本地模型，能力取决于所选模型。
