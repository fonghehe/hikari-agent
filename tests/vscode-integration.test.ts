import { expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { createRequire } from 'node:module';
import path from 'node:path';
import { realpathSync } from 'node:fs';

it('registers the extension commands and sends trusted editor context using secret storage', async () => {
  const root = realpathSync(process.cwd());
  const source = await readFile('integrations/vscode/extension.cjs', 'utf8');
  const commands = new Map<string, (...args: unknown[]) => Promise<unknown>>();
  const values = new Map<string, unknown>();
  const secrets = new Map<string, string>();
  const answers = ['http://127.0.0.1:4319', 'private-fixture-token', 'Inspect this selection'];
  const requests: { url: string; options: { headers: Record<string, string>; body?: string } }[] =
    [];
  const requireModule = createRequire(import.meta.url);
  const vscode = {
    EventEmitter: class {
      event = () => {};
      fire() {}
      dispose() {}
    },
    commands: {
      registerCommand: (name: string, action: (...args: unknown[]) => Promise<unknown>) => {
        commands.set(name, action);
        return { dispose() {} };
      },
    },
    window: {
      activeTextEditor: {
        document: {
          uri: { scheme: 'file', fsPath: path.join(root, 'README.md') },
          getText: () => 'selected content',
          isDirty: true,
        },
        selection: { start: { line: 2 } },
      },
      createOutputChannel: () => ({ appendLine() {}, show() {}, clear() {}, dispose() {} }),
      registerTreeDataProvider: () => ({ dispose() {} }),
      showInputBox: async () => answers.shift(),
      showErrorMessage: vi.fn(),
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: root } }],
      getWorkspaceFolder: () => ({ uri: { fsPath: root } }),
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
    },
    languages: {
      getDiagnostics: () => [
        { range: { start: { line: 3 } }, message: 'fixture diagnostic', severity: 1 },
      ],
    },
  };
  const exported = { exports: {} as { activate(context: unknown): void } };
  new Script(source).runInNewContext({
    require: (name: string) => (name === 'vscode' ? vscode : requireModule(name)),
    module: exported,
    URL,
    AbortSignal,
    setInterval: () => 1,
    clearInterval() {},
    fetch: async (url: string, options: { headers: Record<string, string>; body?: string }) => {
      requests.push({ url, options });
      return {
        ok: true,
        json: async () => (options.body ? { id: 'fixture-task' } : { root, tasks: [] }),
      };
    },
  });
  const context = {
    subscriptions: [],
    globalState: {
      get: (key: string) => values.get(key),
      update: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    },
    secrets: {
      get: async (key: string) => secrets.get(key),
      store: async (key: string, value: string) => {
        secrets.set(key, value);
      },
    },
  };
  exported.exports.activate(context);
  await commands.get('hikari.connect')!();
  await commands.get('hikari.start')!();
  expect(commands.size).toBe(8);
  const sent = requests.find((request) => request.options.body);
  const body = JSON.parse(sent!.options.body!);
  expect(body.prompt).toBe('Inspect this selection');
  expect(JSON.parse(body.context)).toMatchObject({
    file: 'README.md',
    selection: 'selected content',
    unsaved: true,
    selectionStartLine: 3,
  });
  expect(sent!.options.headers.Authorization).toBe('Bearer private-fixture-token');
  expect(values.has('hikari.token')).toBe(false);
  expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
});
