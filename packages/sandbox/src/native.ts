import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { AgentError } from '@hikari/agent-core';
import { LogicalSandboxProvider, type SandboxProvider } from './logical';
export interface ProcessLaunch {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cleanup(): Promise<void>;
}
export class NativeSandboxProvider extends LogicalSandboxProvider implements SandboxProvider {
  constructor(
    readonly root: string,
    readonly network = false,
  ) {
    super();
  }
  async launch(command: string, args: string[], cwd: string): Promise<ProcessLaunch> {
    this.validateCommand(command, args);
    const root = await realpath(this.root);
    cwd = await realpath(cwd);
    await this.resolve(root, path.relative(root, cwd));
    const temporary = await realpath(await mkdtemp(path.join(tmpdir(), 'hikari-exec-')));
    const cleanup = () => rm(temporary, { recursive: true, force: true });
    const corepackHome =
      process.env.COREPACK_HOME ?? path.join(homedir(), '.cache', 'node', 'corepack');
    const runtimeRoot = path.dirname(path.dirname(await realpath(process.execPath)));
    // Electron's executable is not Node. Resolve the installed Node toolchain separately,
    // including version-manager symlinks, without exposing the user's home directory.
    const nodeCandidate = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((directory) => path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'))
      .find(existsSync);
    const nodeRoot = nodeCandidate
      ? path.dirname(path.dirname(await realpath(nodeCandidate)))
      : runtimeRoot;
    const env = {
      ...this.environment(),
      PATH: [
        path.join(root, 'node_modules', '.bin'),
        path.join(runtimeRoot, 'bin'),
        path.join(nodeRoot, 'bin'),
        this.environment().PATH,
      ]
        .filter(Boolean)
        .join(path.delimiter),
      COREPACK_HOME: corepackHome,
      HOME: temporary,
      TMPDIR: temporary,
      TMP: temporary,
      TEMP: temporary,
    };
    try {
      if (process.platform === 'darwin') {
        if (!existsSync('/usr/bin/sandbox-exec'))
          throw new Error('macOS sandbox-exec is unavailable');
        const sub = (p: string) => `(subpath ${JSON.stringify(p)})`;
        const readable = [
          root,
          temporary,
          runtimeRoot,
          nodeRoot,
          ...(existsSync(corepackHome) ? [corepackHome] : []),
          '/usr',
          '/bin',
          '/sbin',
          '/System',
          '/Library/Apple',
          '/private/var/db/dyld',
          '/opt/homebrew',
          '/dev',
        ];
        const profile = `(version 1)(deny default)(allow process*)(allow signal (target same-sandbox))(allow sysctl-read)(allow file-read-metadata)(allow file-read-data (vnode-type DIRECTORY))(allow file-read-data (literal "/private/etc/localtime") (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf"))(allow file-read* ${readable.map(sub).join(' ')})(allow file-write* ${sub(root)} ${sub(temporary)} (literal "/dev/null"))(deny file-write* ${sub(path.join(root, '.git'))} ${sub(path.join(root, '.agent'))})(deny file-read* ${sub(path.join(root, '.agent', 'runs'))} ${sub(path.join(root, '.agent', 'evals'))})(allow mach-lookup (global-name "com.apple.system.logger"))${this.network ? '(allow network*)' : ''}`;
        return {
          command: '/usr/bin/sandbox-exec',
          args: ['-p', profile, command, ...args],
          env,
          cleanup,
        };
      }
      if (process.platform === 'linux') {
        const executable = ['/usr/bin/bwrap', '/bin/bwrap'].find(existsSync);
        if (!executable) throw new Error('Install bubblewrap to use the OS sandbox');
        const flags = ['--die-with-parent', '--new-session', '--unshare-all'];
        if (this.network) flags.push('--share-net');
        for (const directory of [
          '/usr',
          '/bin',
          '/sbin',
          '/lib',
          '/lib64',
          '/etc/ssl',
          '/etc/resolv.conf',
          '/etc/hosts',
          '/etc/ld.so.cache',
        ])
          if (existsSync(directory)) flags.push('--ro-bind', directory, directory);
        for (const directory of [...new Set([runtimeRoot, nodeRoot, corepackHome])])
          if (existsSync(directory) && !directory.startsWith('/usr/'))
            flags.push('--ro-bind', directory, directory);
        flags.push(
          '--proc',
          '/proc',
          '--dev',
          '/dev',
          '--bind',
          temporary,
          temporary,
          '--bind',
          root,
          root,
        );
        if (existsSync(path.join(root, '.git')))
          flags.push('--ro-bind', path.join(root, '.git'), path.join(root, '.git'));
        if (existsSync(path.join(root, '.agent'))) {
          flags.push('--ro-bind', path.join(root, '.agent'), path.join(root, '.agent'));
          for (const folder of ['runs', 'evals'])
            if (existsSync(path.join(root, '.agent', folder)))
              flags.push('--tmpfs', path.join(root, '.agent', folder));
        }
        flags.push('--chdir', cwd, '--', command, ...args);
        return { command: executable, args: flags, env, cleanup };
      }
      // Docker Desktop provides a real Linux kernel boundary on Windows. No host fallback.
      if (process.platform === 'win32') {
        const relative = path.relative(root, cwd).split(path.sep).join('/');
        const containerCommand = path.isAbsolute(command)
          ? path.basename(command).replace(/\.exe$/i, '')
          : command;
        const flags = [
          'run',
          '--rm',
          '--init',
          '--read-only',
          '--cap-drop=ALL',
          '--security-opt=no-new-privileges',
          '--pids-limit=128',
          '--memory=1g',
          '--cpus=2',
          '--network',
          this.network ? 'bridge' : 'none',
          '--tmpfs',
          '/tmp:rw,noexec,nosuid,size=256m',
          '--mount',
          `type=bind,source=${root},target=/workspace`,
          '--workdir',
          `/workspace/${relative}`,
          '--env',
          'HOME=/tmp',
          '--env',
          'TMPDIR=/tmp',
        ];
        if (existsSync(path.join(root, '.git')))
          flags.push(
            '--mount',
            `type=bind,source=${path.join(root, '.git')},target=/workspace/.git,readonly`,
          );
        if (existsSync(path.join(root, '.agent'))) {
          for (const folder of ['runs', 'evals'])
            if (existsSync(path.join(root, '.agent', folder)))
              flags.push('--tmpfs', `/workspace/.agent/${folder}:ro,size=1m`);
          flags.push(
            '--mount',
            `type=bind,source=${path.join(root, '.agent')},target=/workspace/.agent,readonly`,
          );
        }
        flags.push('hikari-sandbox:local', containerCommand, ...args);
        return { command: 'docker', args: flags, env, cleanup };
      }
      throw new Error('This OS has no supported sandbox');
    } catch (error) {
      await cleanup();
      throw new AgentError('SANDBOX_UNAVAILABLE', String(error));
    }
  }
}
