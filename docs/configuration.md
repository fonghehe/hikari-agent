# Model settings

## Connect a service

Open **Model settings** at the bottom of the sidebar. Choose a provider, enter a model ID available to your account and an API key if required, then click **Connect model**. A project is optional for conversation and attachment analysis. Open a workspace for development tools.

Hikari includes presets for OpenAI, Azure OpenAI / Foundry, Anthropic, Google Gemini, DeepSeek, Qwen, Kimi, GLM, Doubao, MiniMax, SiliconFlow, Groq, Grok, Mistral, OpenRouter, Ollama and LM Studio. **OpenAI compatible** accepts other Chat Completions services. Provider selection supplies a starting address; you can change it for your region or private gateway.

| Service                | Base URL                                            |
| ---------------------- | --------------------------------------------------- |
| OpenAI                 | `https://api.openai.com/v1`                         |
| Azure OpenAI / Foundry | Your resource URL ending in `/openai/v1`            |
| Anthropic              | `https://api.anthropic.com/v1`                      |
| Google Gemini          | `https://generativelanguage.googleapis.com`         |
| DeepSeek               | `https://api.deepseek.com/v1`                       |
| Qwen                   | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Kimi                   | `https://api.moonshot.ai/v1`                        |
| GLM                    | `https://open.bigmodel.cn/api/paas/v4`              |
| Doubao                 | `https://ark.cn-beijing.volces.com/api/v3`          |
| MiniMax                | `https://api.minimax.io/v1`                         |
| SiliconFlow            | `https://api.siliconflow.cn/v1`                     |
| Groq                   | `https://api.groq.com/openai/v1`                    |
| Grok                   | `https://api.x.ai/v1`                               |
| Mistral                | `https://api.mistral.ai/v1`                         |
| OpenRouter             | `https://openrouter.ai/api/v1`                      |
| Ollama                 | `http://127.0.0.1:11434/v1`                         |
| LM Studio              | `http://127.0.0.1:1234/v1`                          |

Use the endpoint supplied by your account. Qwen supports workspace and region-specific endpoints; replace the preset when required. Kimi keys differ between regional platforms. Doubao may require a deployment ID. Azure uses the v1 API with an API key and a deployment name in **Model**; older versioned endpoints and Entra sign-in are not supported by this preset. Anthropic and Gemini use their native protocols; other presets use Chat Completions. Services requiring AWS request signing, Vertex OAuth or a different API need a compatible gateway.

Choose **Load available models** to fetch the service's model list, then select an ID from the **Model** field suggestions. A failed or unavailable list does not prevent manual entry. Hikari does not assume that every listed model supports tools or images.

## Set model capabilities

- Enable **This model supports tool calls** for project tasks. Disable it for conversation-only models; Hikari will not send tool schemas to them.
- Enable **This model accepts images** only for a model that supports image input. Text-only models can use local OCR text when available.
- Turn off **Stream responses** if your endpoint only supports ordinary responses.
- Set **Context window (tokens)** and **Maximum output tokens** to the limits of the selected model. Output space is reserved from the context window.
- Leave **Reasoning effort** at **Provider default**, or select a supported value. Unsupported settings may be rejected by the provider.

**Test connection** uses a small, billable request and checks whether a tool call is returned. It cannot prove the model's overall development quality. A service error stays an error; real tasks never switch to sample answers.

## Save and switch profiles

Use **New model profile**, optionally give it a name, and connect. The **Saved model profiles** list lets you select and activate a saved configuration with **Connect model**. Changes apply to new tasks. A resumed task retains its original profile; restore that profile's model and endpoint if they changed, or use **Retry** to start with another model.

Credentials use OS secure storage when available. Otherwise they stay in memory for the current session. Keys are not returned to the settings page, exported with conversations, or synced. Removing a profile requires its unfinished tasks to be cancelled or completed first.

## Optional semantic search

Open **Semantic retrieval**, enable it and enter an **Embedding model**, **Embedding endpoint** and separate **Embedding API key**. The endpoint must provide OpenAI-compatible embeddings; a localhost service may allow an empty key. Chat and embedding models may come from different services.

Search combines keyword and semantic matches in attached documents and saved project memory. Results include their source labels. Embedding searches require approval before text is sent to the endpoint. Vectors are cached locally and refreshed when source text, endpoint or model changes. Keep an endpoint's vector dimensions stable; use a different model ID when its dimensions change.

This option sends the searched document collection and project memories to your embedding service, not your entire code repository. Collections are limited to 2,000 chunks and 3 million characters; split large collections or disable embeddings for keyword search. Embedding charges are separate from the chat token/cost budget. Keyword retrieval works locally when this option is off; an enabled service failure is reported explicitly.

## Offline use

Choose **Use offline demo** to try sample Q&A without a model or workspace. Existing demo conversations remain simulated when continued or retried. Connect Ollama or LM Studio to use a real local model offline, subject to its tool and image capabilities.
