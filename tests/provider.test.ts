import { it, expect, vi, afterEach } from 'vitest';
import {
  OpenAICompatibleProvider,
  OpenAIProvider,
  AnthropicProvider,
} from '../packages/model-provider/src';
import { providerFetch } from '../packages/model-provider/src/http';
afterEach(() => vi.unstubAllGlobals());
it('retains final usage-only streaming chunks and bounds OpenAI output correctly', async () => {
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options: RequestInit) => {
      body = JSON.parse(String(options.body));
      return stream([
        { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
        { choices: [], usage: { prompt_tokens: 321, completion_tokens: 17 } },
      ]);
    }),
  );
  const provider = new OpenAIProvider({ apiKey: 'fixture', model: 'fixture' });
  const results = [];
  for await (const result of provider.stream({ ...request, maxOutputTokens: 100 }))
    results.push(result);
  expect(results.at(-1)?.usage).toEqual({ inputTokens: 321, outputTokens: 17 });
  expect(body.max_completion_tokens).toBe(100);
  expect(body.max_tokens).toBeUndefined();
});
it('retries transient rate limits but never retries rejected credentials', async () => {
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '0' } }))
    .mockResolvedValueOnce(new Response('ok'));
  vi.stubGlobal('fetch', fetcher);
  expect(await (await providerFetch('https://example.invalid', {}, 3)).text()).toBe('ok');
  expect(fetcher).toHaveBeenCalledTimes(2);
  fetcher.mockReset().mockResolvedValue(new Response('private error body', { status: 401 }));
  await expect(providerFetch('https://example.invalid', {}, 3)).rejects.toMatchObject({
    code: 'MODEL_AUTH',
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
const request = {
  messages: [{ role: 'user' as const, content: 'test' }],
  tools: [],
  signal: new AbortController().signal,
};
function stream(frames: unknown[]) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const frame of frames) {
          const bytes = encoder.encode(`data: ${JSON.stringify(frame)}\n\n`);
          controller.enqueue(bytes.slice(0, 7));
          controller.enqueue(bytes.slice(7));
        }
        controller.close();
      },
    }),
    { headers: { 'Content-Type': 'text/event-stream' } },
  );
}
it('assembles split OpenAI tool arguments and streams text before completion', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      stream([
        {
          choices: [
            {
              delta: {
                content: 'Inspect ',
                tool_calls: [
                  { index: 0, id: 'a', function: { name: 'read_file', arguments: '{"path":' } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                content: 'files',
                tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]),
    ),
  );
  const provider = new OpenAICompatibleProvider({ apiKey: 'fixture', model: 'fixture' });
  const results = [];
  for await (const result of provider.stream(request)) results.push(result);
  expect(results[0]?.text).toBe('Inspect ');
  expect(results.at(-1)?.toolCalls[0]?.input).toEqual({ path: 'a.ts' });
});
it('rejects truncated model streams without executing partial tools', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => stream([{ choices: [{ delta: { content: 'incomplete' } }] }])),
  );
  const provider = new OpenAICompatibleProvider({ apiKey: 'fixture', model: 'fixture' });
  await expect(
    (async () => {
      for await (const result of provider.stream(request)) void result;
    })(),
  ).rejects.toThrow('completion marker');
});
it('assembles Anthropic streaming tool blocks', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      stream([
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'a', name: 'read_file', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"path":"a.ts"}' },
        },
        { type: 'message_stop' },
      ]),
    ),
  );
  const provider = new AnthropicProvider({ apiKey: 'fixture', model: 'fixture' });
  const results = [];
  for await (const result of provider.stream(request)) results.push(result);
  expect(results.at(-1)?.toolCalls).toEqual([
    { id: 'a', name: 'read_file', input: { path: 'a.ts' } },
  ]);
});

it('encodes explicit screenshot observations for vision-compatible endpoints', async () => {
  let body: unknown;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options: RequestInit) => {
      body = JSON.parse(String(options.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: 'image received' } }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  const provider = new OpenAICompatibleProvider({ apiKey: 'fixture', model: 'vision-fixture' });
  await provider.chat({
    ...request,
    messages: [
      {
        role: 'user',
        content: 'Inspect screenshot',
        images: [{ mimeType: 'image/jpeg', data: 'fixture-base64' }],
      },
    ],
  });
  expect(JSON.stringify(body)).toContain('data:image/jpeg;base64,fixture-base64');
});

it('encodes text and multiple images as Anthropic content blocks in attachment order', async () => {
  let body: { messages: { content: unknown }[] } | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options: RequestInit) => {
      body = JSON.parse(String(options.body));
      return new Response(JSON.stringify({ content: [{ type: 'text', text: 'received' }] }), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  await new AnthropicProvider({ apiKey: 'fixture', model: 'vision-fixture' }).chat({
    ...request,
    messages: [
      {
        role: 'user',
        content: 'Compare these images',
        images: [
          { mimeType: 'image/png', data: 'first' },
          { mimeType: 'image/jpeg', data: 'second' },
        ],
      },
    ],
  });
  expect(body?.messages[0]?.content).toEqual([
    { type: 'text', text: 'Compare these images' },
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'first' } },
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'second' } },
  ]);
});
it('preserves reasoning protocol state across DeepSeek tool turns', async () => {
  const { createModelProvider } = await import('../packages/model-provider/src');
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options: RequestInit) => {
      bodies.push(JSON.parse(String(options.body)));
      return stream([
        {
          choices: [
            {
              delta: {
                reasoning_content: 'private reasoning',
                tool_calls: [
                  {
                    index: 0,
                    id: 'call-one',
                    function: { name: 'read_file', arguments: '{"path":"a"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
      ]);
    }),
  );
  const provider = createModelProvider({
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    apiKey: 'fixture',
  });
  let response;
  for await (const snapshot of provider.stream(request)) response = snapshot;
  expect(response?.providerData?.reasoningContent).toBe('private reasoning');
  await provider
    .chat({
      ...request,
      messages: [
        {
          role: 'assistant',
          content: response!.text,
          toolCalls: response!.toolCalls,
          providerData: response!.providerData,
        },
        { role: 'tool', content: 'file contents', toolCallId: 'call-one' },
      ],
    })
    .catch(() => {});
  expect((bodies[1]!.messages as { reasoning_content?: string }[])[0]?.reasoning_content).toBe(
    'private reasoning',
  );
});
it('uses Gemini native tool schemas and preserves thought signatures when replaying tool results', async () => {
  const { createModelProvider } = await import('../packages/model-provider/src');
  const bodies: Record<string, unknown>[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, options: RequestInit) => {
      bodies.push(JSON.parse(String(options.body)));
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                role: 'model',
                parts: [
                  {
                    functionCall: { name: 'read_file', args: { path: 'a.ts' } },
                    thoughtSignature: 'fixture-signature',
                  },
                ],
              },
              finishReason: 'STOP',
              index: 0,
            },
          ],
          usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7, totalTokenCount: 18 },
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  const provider = createModelProvider({
    provider: 'gemini',
    model: 'gemini-fixture',
    apiKey: 'fixture',
  });
  const response = await provider.chat({
    ...request,
    tools: [
      {
        name: 'read_file',
        description: 'read',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
      },
    ],
  });
  expect(response.toolCalls[0]?.name).toBe('read_file');
  expect(response.usage).toMatchObject({ inputTokens: 11, outputTokens: 7 });
  await provider.chat({
    ...request,
    messages: [
      {
        role: 'assistant',
        content: response.text,
        toolCalls: response.toolCalls,
        providerData: response.providerData,
      },
      { role: 'tool', toolCallId: response.toolCalls[0]!.id, content: 'contents' },
      { role: 'user', content: 'continue' },
    ],
  });
  expect(JSON.stringify(bodies[0]?.tools)).toContain('functionDeclarations');
  expect(JSON.stringify(bodies[1]?.contents)).toContain('fixture-signature');
});
it('supports chat-only nonstreaming models and authenticated model discovery', async () => {
  const { createModelProvider, listModels, resolvedModelConfig } =
    await import('../packages/model-provider/src');
  let body: Record<string, unknown> = {};
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, options: RequestInit) => {
      if (url.endsWith('/models'))
        return new Response(JSON.stringify({ data: [{ id: 'local-model' }] }));
      body = JSON.parse(String(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: 'answer' } }] }));
    }),
  );
  const config = {
    provider: 'ollama' as const,
    model: 'local-model',
    apiKey: '',
    supportsTools: false,
    streaming: false,
  };
  const snapshots = [];
  for await (const response of createModelProvider(config).stream({
    ...request,
    tools: [{ name: 'unsafe', description: 'test', parameters: {} }],
  }))
    snapshots.push(response);
  expect(snapshots[0]?.text).toBe('answer');
  expect(body.tools).toBeUndefined();
  expect(body.stream).toBeUndefined();
  expect(await listModels(config)).toEqual(['local-model']);
  expect(() => resolvedModelConfig({ ...config, baseUrl: 'http://remote.example/v1' })).toThrow(
    'HTTPS',
  );
  expect(() =>
    resolvedModelConfig({ ...config, maxOutputTokens: 9000, contextWindow: 8192 }),
  ).toThrow('smaller');
});
it('preserves MiniMax inline reasoning for tool continuation without exposing it as the answer', async () => {
  const { createModelProvider } = await import('../packages/model-provider/src');
  const raw = '<think>private protocol reasoning</think>Visible answer';
  let body: { messages: { content: string }[] } | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: raw }, finish_reason: 'stop' }] }),
        { headers: { 'content-type': 'application/json' } },
      );
    }),
  );
  const provider = createModelProvider({
    provider: 'minimax',
    model: 'fixture',
    apiKey: 'fixture',
  });
  const result = await provider.chat(request);
  expect(result.text).toBe('Visible answer');
  await provider.chat({
    ...request,
    messages: [
      ...request.messages,
      { role: 'assistant', content: result.text, providerData: result.providerData },
    ],
  });
  expect(body?.messages[1]?.content).toBe(raw);
});
it('routes every compatible preset to its own endpoint and uses Azure api-key authentication', async () => {
  const { createModelProvider } = await import('../packages/model-provider/src');
  const { providerCatalog, providerIds } = await import('../packages/shared/src');
  for (const provider of providerIds.filter((id) => providerCatalog[id].protocol === 'openai')) {
    let called = '',
      headers: Record<string, string> = {};
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url, init: RequestInit) => {
        called = String(url);
        headers = init.headers as Record<string, string>;
        return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
      }),
    );
    const baseUrl = providerCatalog[provider].baseUrl || 'https://fixture.example/openai/v1';
    expect(
      (
        await createModelProvider({ provider, model: 'fixture', apiKey: 'fixture', baseUrl }).chat(
          request,
        )
      ).text,
    ).toBe('ok');
    expect(called).toBe(baseUrl + '/chat/completions');
    if (provider === 'azure') {
      expect(headers['api-key']).toBe('fixture');
      expect(headers.Authorization).toBeUndefined();
    } else expect(headers.Authorization).toBe('Bearer fixture');
  }
});
it('rejects non-streaming length-limited replies instead of treating partial answers as completion', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: 'partial' }, finish_reason: 'length' }],
          }),
        ),
    ),
  );
  const provider = new OpenAICompatibleProvider({ model: 'fixture', apiKey: 'fixture' });
  await expect(provider.chat(request)).rejects.toMatchObject({ code: 'MODEL_LENGTH' });
});
