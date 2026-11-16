import { expect, it } from 'vitest';
import { mkdtemp, mkdir, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { gradeCase } from '../../scripts/evals/grader';

// This host-path canary covers native macOS/Linux isolation; Docker uses container paths.
it.skipIf(process.platform === 'win32')(
  'keeps candidate code sandboxed while the independent grader imports it',
  async () => {
    const base = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-grader-isolation-')));
    const root = path.join(base, 'candidate'),
      outside = path.join(base, 'outside.txt');
    await mkdir(root);
    await writeFile(outside, 'preserve host data');
    try {
      const source = `import fs from 'node:fs';let reads=false,writes=false;try{fs.readFileSync(${JSON.stringify(outside)})}catch{reads=true}try{fs.writeFileSync(${JSON.stringify(outside)},'overwritten')}catch{writes=true}export const isolated=reads&&writes;`;
      await writeFile(path.join(root, 'candidate.mjs'), source);
      const result = await gradeCase(root, {
        name: 'host-isolation',
        prompt: 'fixture',
        files: { 'candidate.mjs': source },
        solution: {},
        grader:
          "import('./candidate.mjs').then(m=>require('node:assert/strict').equal(m.isolated,true)).catch(e=>{console.error(e);process.exit(1)})",
      });
      expect(result.exitCode, result.output).toBe(0);
      expect(await readFile(outside, 'utf8')).toBe('preserve host data');
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  },
);
