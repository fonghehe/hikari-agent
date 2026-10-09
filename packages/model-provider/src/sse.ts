import { AgentError } from '@hikari/agent-core';
export async function* sse(response: Response): AsyncIterable<unknown> {
  if (!response.body) throw new AgentError('EMPTY_STREAM', 'Model returned no response body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        break;
      }
      total += value.length;
      if (total > 8 * 1024 * 1024)
        throw new AgentError('MODEL_OUTPUT_LIMIT', 'Model response exceeded 8 MB');
      buffer += decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const data = frame
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data === '[DONE]') return;
        if (data) yield JSON.parse(data) as unknown;
      }
    }
    if (buffer.trim())
      throw new AgentError('TRUNCATED_STREAM', 'Model stream ended in an incomplete event');
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
