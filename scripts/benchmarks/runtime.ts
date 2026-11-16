import { performance } from 'node:perf_hooks';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import {
  appendRequestTrace,
  type ModelRequestTrace,
} from '../../packages/agent-runtime/src/persistence/request-trace';
import { SkillLoader } from '../../packages/skills/src/index';

let append = appendRequestTrace;
const reference = process.argv.find((arg) => arg.startsWith('--ref='))?.slice(6);
if (reference) {
  if (!/^[\w/.-]+$/.test(reference)) throw new Error('Invalid git reference');
  const candidates = [
    'packages/agent-runtime/src/persistence/request-trace.ts',
    'packages/agent-runtime/src/request-trace.ts',
  ];
  // Historical comparisons must also work with revisions before the directory migration.
  const available = execFileSync(
    'git',
    ['ls-tree', '--name-only', reference, '--', ...candidates],
    { encoding: 'utf8' },
  )
    .trim()
    .split('\n');
  const filename = candidates.find((candidate) => available.includes(candidate));
  if (!filename) throw new Error(`No request trace implementation at ${reference}`);
  const source = execFileSync('git', ['show', `${reference}:${filename}`], { encoding: 'utf8' });
  const bundle = await build({
    stdin: {
      contents: source,
      loader: 'ts',
      resolveDir: path.resolve(path.dirname(filename)),
    },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm',
  });
  const module: { appendRequestTrace: typeof appendRequestTrace } = await import(
    'data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0]!.text).toString('base64')
  );
  append = module.appendRequestTrace;
}
function record(step: number, chars: number): ModelRequestTrace {
  return {
    version: 1,
    id: `00000000-0000-4000-8000-${String(step).padStart(12, '0')}`,
    step,
    createdAt: '2026-01-01T00:00:00Z',
    messages: [{ role: 'user', content: 'x'.repeat(chars) }],
    tools: [],
    inputBudget: 200000,
    estimatedInputTokens: 100000,
    maxOutputTokens: 4096,
    compaction: {
      sourceMessages: 1,
      admittedMessages: 2,
      truncatedResults: 0,
      summarizedExchanges: 0,
      removedTurns: 0,
      omittedImages: 0,
    },
  };
}
function stats(samples: number[]) {
  samples.sort((a, b) => a - b);
  return {
    p50Ms: samples[Math.ceil(samples.length * 0.5) - 1],
    p95Ms: samples[Math.ceil(samples.length * 0.95) - 1],
  };
}
const traces = [];
for (const chars of [20000, 400000]) {
  let retained = Array.from({ length: 16 }, (_, index) => record(index, chars));
  const samples: number[] = [];
  for (let i = 0; i < 35; i++) {
    const next = record(i + 16, chars);
    const start = performance.now();
    retained = append(retained, next);
    if (i >= 5) samples.push(performance.now() - start);
  }
  traces.push({
    charsPerTrace: chars,
    retained: retained.length,
    bytes: Buffer.byteLength(JSON.stringify(retained)),
    ...stats(samples),
  });
}
const root = await mkdtemp(path.join(tmpdir(), 'hikari-skills-bench-'));
const skills = [];
try {
  for (let i = 0; i < 100; i++) {
    const directory = path.join(root, '.agent/skills', String(i));
    await mkdir(directory, { recursive: true });
    await writeFile(
      path.join(directory, 'SKILL.md'),
      `---\nname: skill-${i}\ndescription: Fictional benchmark\n---\n${'x'.repeat(60000)}`,
    );
  }
  const loader = new SkillLoader(root);
  for (const mode of ['discover', 'list', 'load'] as const) {
    const samples = [];
    for (let i = 0; i < 15; i++) {
      const start = performance.now();
      if (mode === 'load') await loader.load('skill-1');
      else await loader[mode]();
      if (i >= 5) samples.push(performance.now() - start);
    }
    skills.push({ mode, count: 100, bodyChars: 60000, ...stats(samples) });
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      traceReference: reference ?? 'working-tree',
      skillReference: 'working-tree',
      warmup: 5,
      traceSamples: 30,
      skillSamples: 10,
      traces,
      skills,
    },
    null,
    2,
  ),
);
