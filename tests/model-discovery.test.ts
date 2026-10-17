import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseModelList } from '../packages/model-provider/src/discovery';
import { listModels } from '../packages/model-provider/src/factory';

afterEach(() => vi.unstubAllGlobals());

describe('model discovery boundary', () => {
  it.each(['openai', 'anthropic'] as const)('normalizes valid %s model lists', (protocol) => {
    const ids = ['zeta', 'alpha', 'alpha', '', '   ', 'x'.repeat(121), 'y'.repeat(120)];
    expect(
      parseModelList(JSON.stringify({ data: ids.map((id) => ({ id, extra: true })) }), protocol),
    ).toEqual(['alpha', 'y'.repeat(120), 'zeta']);
    expect(parseModelList('{"data":[]}', protocol)).toEqual([]);
  });

  it('selects Gemini generation models before removing the resource prefix', () => {
    expect(
      parseModelList(
        JSON.stringify({
          models: [
            { name: 'models/b', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
            { name: 'models/no-methods' },
            { name: 'models/a', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/a', supportedGenerationMethods: ['generateContent'] },
          ],
        }),
        'gemini',
      ),
    ).toEqual(['a', 'b']);
    expect(parseModelList('{"models":[]}', 'gemini')).toEqual([]);
    expect(parseModelList('{}', 'gemini')).toEqual([]);
  });

  it.each([
    'null',
    '[]',
    '{}',
    '"private response"',
    '<html>private response</html>',
    '{"data":',
    '{"data":null}',
    '{"data":{}}',
    '{"data":[null]}',
    '{"data":[{"id":42}]}',
    '{"data":[{"id":"valid"},{}]}',
  ])('classifies malformed model lists without exposing their content: %s', (text) => {
    expect(() => parseModelList(text, 'openai')).toThrow(
      expect.objectContaining({ code: 'MODEL_DISCOVERY' }),
    );
    expect(() => parseModelList(text, 'openai')).toThrow(
      'Model endpoint returned an invalid model list; enter a model ID manually.',
    );
  });

  it.each([
    { models: [null] },
    { models: [{ supportedGenerationMethods: ['generateContent'] }] },
    { models: [{ name: 42, supportedGenerationMethods: ['generateContent'] }] },
    { models: [{ name: 'models/a', supportedGenerationMethods: 'generateContent' }] },
  ])('rejects malformed Gemini model entries: %j', (payload) => {
    expect(() => parseModelList(JSON.stringify(payload), 'gemini')).toThrow(
      expect.objectContaining({ code: 'MODEL_DISCOVERY' }),
    );
  });

  it('keeps the existing sorted 2,000-model response bound', () => {
    const data = Array.from({ length: 2005 }, (_, index) => ({
      id: `model-${String(index).padStart(4, '0')}`,
    })).reverse();
    const ids = parseModelList(JSON.stringify({ data }), 'openai');
    expect(ids).toHaveLength(2000);
    expect(ids[0]).toBe('model-0000');
    expect(ids.at(-1)).toBe('model-1999');
  });

  it('validates successful HTTP responses before returning a model list', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{"data":[null]}')),
    );
    await expect(
      listModels({ provider: 'ollama', model: 'fixture', apiKey: '' }),
    ).rejects.toMatchObject({ code: 'MODEL_DISCOVERY' });
  });
});
