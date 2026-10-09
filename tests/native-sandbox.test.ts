import { it, expect } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { NativeSandboxProvider, runProcess } from '../packages/sandbox/src';
it.skipIf(process.platform !== 'darwin' && process.platform !== 'linux')(
  'permits workspace output but blocks outside reads, writes and network',
  async () => {
    const base = await mkdtemp(path.join(tmpdir(), 'hikari-native-test-'));
    const root = path.join(base, 'workspace');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(root);
    await mkdir(path.join(root, '.git'));
    await writeFile(path.join(root, '.git', 'config'), 'protected');
    const secret = path.join(base, 'secret');
    await writeFile(secret, 'private-value');
    const sandbox = new NativeSandboxProvider(root);
    const script = `const fs=require('fs');fs.writeFileSync('allowed','ok');let denied=0;for(const f of [()=>fs.readFileSync(${JSON.stringify(secret)}),()=>fs.writeFileSync(${JSON.stringify(secret)},'overwritten'),()=>fs.writeFileSync('.git/config','broken')]){try{f()}catch{denied++}};if(denied!==3)process.exit(7);const net=require('net');const sock=net.connect(443,'1.1.1.1');sock.on('connect',()=>process.exit(8));sock.on('error',()=>process.exit(0));setTimeout(()=>process.exit(9),2000);`;
    const launch = await sandbox.launch(process.execPath, ['-e', script], root);
    try {
      const result = await runProcess(launch.command, launch.args, {
        cwd: root,
        env: launch.env,
        signal: new AbortController().signal,
      });
      expect(result.output).not.toContain('private-value');
      expect(result.exitCode, result.output).toBe(0);
      expect(await readFile(path.join(root, 'allowed'), 'utf8')).toBe('ok');
      expect(await readFile(secret, 'utf8')).toBe('private-value');
    } finally {
      await launch.cleanup();
      await rm(base, { recursive: true, force: true });
    }
  },
);
