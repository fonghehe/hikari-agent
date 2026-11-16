import { AgentError } from '@hikari/agent-core';

export function validateVector(value: number[], dimensions?: number) {
  if (
    !Array.isArray(value) ||
    !value.length ||
    value.length > 65536 ||
    (dimensions !== undefined && value.length !== dimensions) ||
    !value.every(Number.isFinite)
  )
    throw new AgentError(
      'EMBEDDING_DIMENSION',
      'Embedding dimensions are invalid or changed; use a different model/cache identity',
    );
}
export function cosine(a: number[], b: number[]) {
  validateVector(a);
  validateVector(b, a.length);
  let dot = 0,
    x = 0,
    y = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    x += a[i]! ** 2;
    y += b[i]! ** 2;
  }
  return x && y ? dot / Math.sqrt(x * y) : 0;
}
