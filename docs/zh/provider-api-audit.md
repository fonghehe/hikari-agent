# 厂商 API 核实

核实日期：**2026-11-14**。当前列表中的 17 个具名后端均有官方开发者 API 或本地 API 文档，未发现已整体停止 API 服务的证据，因此没有据此任意删除。地区、账号、订阅或旧模型不可用，不等于厂商停止提供 API。

完整官方证据表见[英文审核记录](../provider-api-audit.md)：OpenAI、Azure、Anthropic、Gemini、DeepSeek、Qwen、Kimi、GLM、Doubao、MiniMax、SiliconFlow、Groq、Grok、Mistral、OpenRouter，以及本地 Ollama、LM Studio。

模型设置页现在提供对应厂商的官方 API 文档入口。**Custom compatible** 是用户自行配置的端点，不是厂商背书；**Demo** 明确为模拟，连接厂商列表不显示它。

聊天产品的订阅凭证不能当作开发者 API Key。连接检查会实际验证所选模型的工具调用响应，模型列表从端点读取，不维护陈旧的预设模型名。文档可访问只代表有官方接入说明，不证明某个用户的地区、额度、Key 或模型能够调用。本次核实没有调用付费厂商模型。
