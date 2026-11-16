import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import type { ToolCall, ToolResult } from '@hikari/agent-core';

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    entry && typeof entry === 'object' && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b)))
      : entry,
  );
}
function normalized(text: string) {
  return stripVTControlCharacters(text)
    .replace(/\b\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z\b/g, '<time>')
    .replace(/\b[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}\b/gi, '<id>')
    .replace(/\/(?:private\/)?(?:tmp|var\/folders)\/[^\s"'<>]+/g, '<temp>')
    .replace(/[a-z]:\\[^\s"'<>]*\\Temp\\[^\s"'<>]+/gi, '<temp>')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|milliseconds|seconds)\b/g, '<duration>');
}

/** Detect recurring failures across unproductive repeated reads, without replaying actions. */
export class FailureTracker {
  private revision = -1;
  private failures: string[] = [];
  private observations = new Set<string>();
  record(call: ToolCall, result: ToolResult, revision: number) {
    if (revision !== this.revision) {
      this.revision = revision;
      this.failures = [];
      this.observations.clear();
    }
    const fingerprint = createHash('sha256')
      .update(
        stable([call.name, call.input, result.metadata?.errorCode, normalized(result.content)]),
      )
      .digest('hex');
    if (!result.error) {
      if (!this.observations.has(fingerprint)) {
        this.failures = [];
        this.observations.add(fingerprint);
        if (this.observations.size > 64)
          this.observations.delete(this.observations.values().next().value!);
      }
      return 0;
    }
    this.failures.push(fingerprint);
    if (this.failures.length > 8) this.failures.shift();
    return this.failures.filter((entry) => entry === fingerprint).length;
  }
}
