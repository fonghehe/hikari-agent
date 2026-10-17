import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  PluginManager,
  inspectPlugin,
  installedManifests,
  TimelineService,
  FileChangeService,
  registerLSPTools,
  packPlugin,
} from '../packages/tools/src';
import { createServer } from 'node:http';
import {
  StateStore,
  TaskManager,
  EventBus,
  ToolRegistry,
  type RunnerCheckpoint,
} from '../packages/agent-runtime/src';
import { SkillLoader } from '../packages/skills/src';
import { LogicalSandboxProvider } from '../packages/sandbox/src';

const roots: string[] = [];
async function temp() {
  const root = await mkdtemp(path.join(tmpdir(), 'hikari-platform-tools-'));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function plugin() {
  const source = await temp();
  await mkdir(path.join(source, 'skills/review'), { recursive: true });
  await writeFile(
    path.join(source, 'hikari-plugin.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      description: 'Fixture extension',
      skills: ['skills/review'],
      hooks: [],
      mcp: {},
      agents: [
        { name: 'reader', description: 'Read files', instructions: 'Inspect the assigned source.' },
      ],
    }),
  );
  await writeFile(
    path.join(source, 'skills/review/SKILL.md'),
    '---\nname: review\ndescription: Review fixture\n---\nInspect before proposing changes.',
  );
  return source;
}
it('installs digest-pinned plugins and exposes namespaced skills without running scripts', async () => {
  const root = await temp();
  const source = await plugin();
  const manager = new PluginManager(root);
  const inspected = await inspectPlugin(source);
  await expect(manager.install(source, '0'.repeat(64))).rejects.toThrow('digest');
  const installed = await manager.install(source, inspected.sha256);
  expect(installed).toMatchObject({ name: 'fixture', version: '1.0.0' });
  expect((await new SkillLoader(root).list())[0]?.name).toBe('fixture:review');
  expect((await installedManifests(root))[0]?.manifest.agents[0]?.name).toBe('reader');
  await expect(manager.install(source)).rejects.toThrow('already installed');
  await manager.remove('fixture');
  expect(manager.list()).toEqual([]);
});
it('updates plugins and rejects modified installed packages and symlinked imports', async () => {
  const root = await temp(),
    source = await plugin();
  const manager = new PluginManager(root);
  await manager.install(source);
  const manifest = JSON.parse(await readFile(path.join(source, 'hikari-plugin.json'), 'utf8'));
  manifest.version = '1.1.0';
  await writeFile(path.join(source, 'hikari-plugin.json'), JSON.stringify(manifest));
  await manager.install(source, undefined, true);
  expect(manager.list()[0]?.version).toBe('1.1.0');
  await writeFile(path.join(root, '.agent/plugins/fixture/skills/review/SKILL.md'), 'tampered');
  await expect(installedManifests(root)).rejects.toThrow('changed');
  await symlink(path.join(source, 'hikari-plugin.json'), path.join(source, 'linked'));
  await expect(inspectPlugin(source)).rejects.toThrow('symbolic');
});
it('discovers a registry without installing entries and verifies their pinned hashes', async () => {
  const root = await temp(),
    source = await plugin();
  const filename = path.join(root, 'registry.json');
  const inspected = await inspectPlugin(source);
  await writeFile(
    filename,
    JSON.stringify({
      plugins: [
        {
          name: 'fixture',
          version: '1.0.0',
          description: 'Fixture',
          path: source,
          sha256: inspected.sha256,
        },
      ],
    }),
  );
  const manager = new PluginManager(root);
  expect((await manager.registry(filename))[0]?.sha256).toBe(inspected.sha256);
  expect(manager.list()).toHaveLength(0);
});
it('browses a remote registry and installs only a matching pinned bundle', async () => {
  const root = await temp(),
    source = await plugin(),
    output = path.join(root, 'fixture.bundle.json');
  const packed = await packPlugin(source, output);
  const bundle = await readFile(output, 'utf8');
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/registry.json')
      response.end(
        JSON.stringify({
          plugins: [
            {
              name: 'fixture',
              version: '1.0.0',
              description: 'Fixture',
              path: './fixture.bundle.json',
              sha256: packed.sha256,
            },
          ],
        }),
      );
    else if (request.url === '/malicious.json')
      response.end(
        JSON.stringify({
          format: 'hikari-plugin-bundle',
          version: 1,
          files: [{ path: '../outside', base64: 'eA==' }],
        }),
      );
    else response.end(bundle);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing registry port');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const manager = new PluginManager(root);
    const [entry] = await manager.registry(base + '/registry.json');
    expect(entry?.path).toBe(base + '/fixture.bundle.json');
    await expect(manager.install(entry!.path)).rejects.toThrow('pinned SHA-256');
    await expect(
      manager.install(entry!.path, entry!.sha256, false, { name: 'wrong', version: '1.0.0' }),
    ).rejects.toThrow('identity');
    await manager.install(entry!.path, entry!.sha256, false, entry);
    expect(manager.list()[0]?.source).toBe(entry!.path);
    await expect(manager.install(base + '/malicious.json', entry!.sha256)).rejects.toThrow('path');
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
const checkpoint = (): RunnerCheckpoint => ({
  version: 1,
  messages: [{ role: 'user', content: 'Original request' }],
  memory: [],
  summary: {
    modelSteps: 1,
    toolCalls: 0,
    toolFailures: 0,
    durationMs: 10,
    filesChanged: [],
    tests: [],
  },
  revision: 0,
  testedRevision: {},
  pending: [],
  queued: [],
  done: false,
  updatedAt: new Date().toISOString(),
});
it('rewinds code transactionally, preserving the conversation when only code is selected', async () => {
  const root = await temp();
  const task = new TaskManager().create('Edit', root);
  const timeline = new TimelineService(root);
  await writeFile(path.join(root, 'file.txt'), 'before');
  const before = await timeline.capture(task, checkpoint(), 'before');
  await writeFile(path.join(root, 'file.txt'), 'after');
  await writeFile(path.join(root, 'created.txt'), 'created');
  await timeline.capture(task, checkpoint(), 'after');
  expect((await timeline.preview(before)).applicable).toBe(true);
  const changes = new FileChangeService(root, new EventBus(task));
  expect(await timeline.restore(before, 'code', changes)).toBeUndefined();
  expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('before');
  await expect(readFile(path.join(root, 'created.txt'))).rejects.toThrow();
  expect(changes.history).toHaveLength(2);
});
it('refuses conflicting code rewinds but permits a conversation-only fork with fresh validation', async () => {
  const root = await temp();
  const task = new TaskManager().create('Edit', root);
  const timeline = new TimelineService(root);
  await writeFile(path.join(root, 'file.txt'), 'before');
  const before = await timeline.capture(task, checkpoint(), 'before');
  await writeFile(path.join(root, 'file.txt'), 'agent');
  await timeline.capture(task, checkpoint(), 'after');
  await writeFile(path.join(root, 'file.txt'), 'user edit');
  const changes = new FileChangeService(root, new EventBus(task));
  await expect(timeline.restore(before, 'both', changes)).rejects.toThrow('conflicts');
  const fork = await timeline.restore(before, 'conversation', changes);
  expect(fork?.checkpoint).toMatchObject({
    done: false,
    needsVerification: true,
    testedRevision: {},
    pending: [],
    summary: { modelSteps: 0 },
  });
  expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('user edit');
});
it('runs a stdio LSP server, updates documents, filters outside locations, and reads diagnostics', async () => {
  const root = await temp();
  new StateStore(root);
  await writeFile(path.join(root, 'test.ts'), 'const answer = 42;');
  await writeFile(
    path.join(root, '.agent/lsp.json'),
    JSON.stringify([
      {
        name: 'fixture',
        command: process.execPath,
        args: [path.resolve('tests/fixtures/lsp-server.mjs')],
        extensions: ['.ts'],
        languageId: 'typescript',
      },
    ]),
  );
  const tools = new ToolRegistry();
  const services = await registerLSPTools(tools, root, new LogicalSandboxProvider());
  const context = {
    taskId: randomUUID(),
    workspace: root,
    events: { emit() {} },
    signal: new AbortController().signal,
  };
  try {
    const definition = tools.get('lsp_definition');
    const response = JSON.parse(
      (
        await definition.execute(
          definition.parse({ path: 'test.ts', line: 0, character: 7 }),
          context,
        )
      ).content,
    );
    expect(response).toHaveLength(1);
    expect(response[0].uri).toContain('test.ts');
    await writeFile(path.join(root, 'test.ts'), 'const error = true;');
    const hover = tools.get('lsp_hover');
    expect((await hover.execute(hover.parse({ path: 'test.ts' }), context)).content).toContain(
      'error = true',
    );
    const diagnostics = tools.get('lsp_diagnostics');
    expect(
      (await diagnostics.execute(diagnostics.parse({ path: 'test.ts' }), context)).content,
    ).toContain('Fixture type error');
    await writeFile(path.join(root, 'test.ts'), 'transport-error');
    await expect(
      diagnostics.execute(diagnostics.parse({ path: 'test.ts' }), context),
    ).rejects.toThrow('Fixture transport failed');
    await expect(hover.execute(hover.parse({ path: '../outside.ts' }), context)).rejects.toThrow(
      'outside workspace',
    );
  } finally {
    await services.close();
  }
});
