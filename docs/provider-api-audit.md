# Provider API audit

Reviewed against official documentation on **2026-11-14**. Every named backend currently listed in Hikari has an official API or documented local API. No evidence was found that any listed provider has stopped API access altogether, so none was removed on that basis. An account, subscription, region or old model can be unavailable without the provider's API being discontinued.

| Backend                | Official API evidence                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| OpenAI                 | [Developer quickstart](https://developers.openai.com/api/docs/quickstart)                                                 |
| Azure OpenAI / Foundry | [Endpoint and authentication guide](https://learn.microsoft.com/en-us/azure/ai-foundry/openai/how-to/switching-endpoints) |
| Anthropic              | [Claude API overview](https://platform.claude.com/docs/en/api/overview)                                                   |
| Gemini                 | [Gemini API quickstart](https://ai.google.dev/gemini-api/docs/quickstart)                                                 |
| DeepSeek               | [First API call](https://api-docs.deepseek.com/)                                                                          |
| Qwen / Model Studio    | [Model API overview](https://help.aliyun.com/zh/model-studio/first-api-call-to-qwen)                                      |
| Kimi / Moonshot        | [API quickstart](https://platform.kimi.ai/docs/get-your-api-key)                                                          |
| GLM / Zhipu            | [API platform introduction](https://docs.bigmodel.cn/cn/guide/start/introduction)                                         |
| Doubao / Volcano Ark   | [OpenAI compatibility](https://www.volcengine.com/docs/82379/1330626)                                                     |
| MiniMax                | [API overview](https://platform.minimax.io/docs/api-reference/api-overview)                                               |
| SiliconFlow            | [Chat completions API](https://docs.siliconflow.cn/docs/api/chat-completions-post)                                        |
| Groq                   | [API overview](https://console.groq.com/docs/overview)                                                                    |
| Grok / xAI             | [API documentation](https://docs.x.ai/overview)                                                                           |
| Mistral                | [Chat API reference](https://docs.mistral.ai/api)                                                                         |
| OpenRouter             | [API quickstart](https://openrouter.ai/docs/quickstart)                                                                   |
| Ollama                 | [Local and cloud API compatibility](https://docs.ollama.com/api/openai-compatibility)                                     |
| LM Studio              | [Local compatibility endpoints](https://lmstudio.ai/docs/developer/openai-compat)                                         |

The model-settings page links to each provider's official API documentation. **Custom compatible** is a manually configured endpoint, not a vendor claim. **Demo** is explicitly simulated and is excluded from the connected-provider selector.

Chat products and their subscription credentials are not interchangeable with developer API keys. Hikari's connection test validates a real tool-call response for the configured model; the model list comes from the endpoint rather than a hardcoded list of old model names. Documentation verification does not prove that a particular user's credentials, region, credits or selected model work. No paid-provider calls were made for this audit.
