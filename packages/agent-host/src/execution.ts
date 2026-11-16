import { readFile, stat } from 'node:fs/promises';
import type { AcceptanceCheck } from '@hikari/agent-core';
import { ResourceScope } from '@hikari/agent-runtime';
import { registerFileTools, registerGitTools, registerBrowserTools } from '@hikari/tools';
import { registerMCPTools } from '@hikari/mcp';
import { registerSkillTools } from '@hikari/skills';
import {
  LogicalSandboxProvider,
  NativeSandboxProvider,
  type SandboxProvider,
} from '@hikari/sandbox';
import { prepareCapabilities, pluginMCP } from './capabilities';
import type { BrowserFactory } from '@hikari/tools';

type ExecutionOptions = Omit<Parameters<typeof prepareCapabilities>[0], 'changes' | 'sandbox'> & {
  changes?: Parameters<typeof prepareCapabilities>[0]['changes'];
  resources: ResourceScope;
  supportsVision?: boolean;
  searchUrl?: string;
  mcpHeaders?(name: string): Record<string, string> | undefined;
  publishDiff?: boolean;
  browserFactory?: BrowserFactory;
};

/** Common capability composition for desktop, CLI and execution workers. */
export async function prepareExecution(options: ExecutionOptions) {
  const resources = new ResourceScope();
  options.resources.defer(() => resources.close());
  const tools = options.tools.scope(resources);
  const root = options.task.worktree ?? options.task.workspace;
  const configRoot = options.configRoot ?? options.task.workspace;
  const sandbox =
    options.task.runOptions?.execution === 'host'
      ? new LogicalSandboxProvider()
      : new NativeSandboxProvider(root, options.task.runOptions?.allowNetwork);
  try {
    if (options.changes) {
      registerFileTools(tools, sandbox, options.changes);
      registerGitTools(tools, options.changes, { publishDiff: options.publishDiff });
      registerSkillTools(tools, configRoot);
      const mcp = registerMCPTools(
        tools,
        root,
        options.events,
        sandbox,
        options.mcpHeaders,
        configRoot,
        () => pluginMCP(configRoot),
      );
      resources.defer(() => mcp.close());
    }
    const browser = registerBrowserTools(
      tools,
      options.events,
      options.supportsVision ?? false,
      options.searchUrl,
      options.browserFactory,
    );
    resources.defer(() => browser.close());
    const runtime = options.changes
      ? await prepareCapabilities({
          ...options,
          tools,
          changes: options.changes,
          sandbox,
        })
      : undefined;
    if (runtime) resources.defer(() => runtime.close());
    return { browser, sandbox, runtime };
  } catch (error) {
    await resources.close().catch(() => {});
    throw error;
  }
}

/** Cleanup failures are reported without replacing the original execution failure. */
export async function runExecution(
  runner: { run(): Promise<void> },
  resources: ResourceScope,
  flush: () => void = () => {},
) {
  let failed = false;
  let failure: unknown;
  const capture = (error: unknown) => {
    if (!failed) {
      failed = true;
      failure = error;
    }
  };
  try {
    await runner.run();
  } catch (error) {
    capture(error);
  }
  try {
    await resources.close();
  } catch (error) {
    capture(error);
  }
  try {
    flush();
  } catch (error) {
    capture(error);
  }
  if (failed) throw failure;
}

export async function verifyFileChecks(
  checks: AcceptanceCheck[],
  root: string | undefined,
  sandbox: SandboxProvider,
  signal: AbortSignal,
) {
  const results = [];
  for (const check of checks) {
    if (check.kind !== 'file') continue;
    signal.throwIfAborted();
    let passed = false;
    let detail = '';
    try {
      if (!root) throw new Error('File acceptance requires a workspace');
      const filename = await sandbox.resolve(root, check.path);
      const info = await stat(filename).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      });
      passed = !!info === check.exists;
      if (passed && check.contains !== undefined)
        passed =
          !!info?.isFile() &&
          info.size <= 2000000 &&
          (await readFile(filename, 'utf8')).includes(check.contains);
      detail = passed ? 'Verified current file' : 'File acceptance failed';
    } catch (error) {
      detail = String(error);
    }
    results.push({ id: check.id, label: check.label, passed, detail });
  }
  return { passed: results.every((check) => check.passed), checks: results };
}
