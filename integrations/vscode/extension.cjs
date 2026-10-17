/* oxlint-disable typescript/no-require-imports -- VS Code loads this CommonJS entry point. */
const vscode = require('vscode');
const path = require('node:path');
const fs = require('node:fs');

function editorContext() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') return '';
  const folder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  if (!folder) return '';
  const relative = path.relative(folder.uri.fsPath, editor.document.uri.fsPath);
  const selection = editor.document.getText(editor.selection).slice(0, 12000);
  const diagnostics = vscode.languages
    .getDiagnostics(editor.document.uri)
    .slice(0, 30)
    .map((d) => ({ line: d.range.start.line + 1, message: d.message, severity: d.severity }));
  return JSON.stringify({
    file: relative,
    selection,
    selectionStartLine: editor.selection.start.line + 1,
    unsaved: editor.document.isDirty,
    diagnostics,
  });
}

function activate(context) {
  let tasks = [];
  let root;
  const changed = new vscode.EventEmitter();
  const output = vscode.window.createOutputChannel('Hikari');
  const documents = new Map();
  const tree = {
    onDidChangeTreeData: changed.event,
    getChildren: () => tasks,
    getTreeItem: (task) => ({
      label: task.title,
      description: task.status,
      tooltip: task.prompt,
      contextValue: 'hikari-task',
      command: { command: 'hikari.show', title: 'Show task', arguments: [task] },
    }),
  };
  async function request(route, data) {
    const url = context.globalState.get('hikari.url');
    const token = await context.secrets.get('hikari.token');
    if (!url || !token) throw new Error('Run Hikari: Connect to Local Host first.');
    const response = await fetch(url + '/api/' + route, {
      method: data ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: data ? JSON.stringify(data) : undefined,
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || 'Hikari request failed');
    return value;
  }
  async function refresh() {
    const value = await request('tasks');
    tasks = value.tasks;
    root = value.root;
    changed.fire();
  }
  async function start(review) {
    if (!vscode.workspace.isTrusted)
      throw new Error('Trust this workspace before starting Hikari.');
    await refresh();
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || fs.realpathSync(folder.uri.fsPath) !== fs.realpathSync(root))
      throw new Error('The Hikari host must use this editor workspace.');
    const prompt = review
      ? 'Review the current Git diff. Report actionable regressions with exact file evidence. Do not modify files or run project code.'
      : await vscode.window.showInputBox({ prompt: 'What should Hikari do?' });
    if (!prompt?.trim()) return;
    const task = await request('tasks', {
      prompt,
      context: editorContext(),
      options: { mode: review ? 'plan' : 'execute' },
      isolated: false,
    });
    output.appendLine('Started ' + task.id);
    output.show(true);
    await refresh();
  }
  const register = (name, action) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(name, async (...args) => {
        try {
          await action(...args);
        } catch (error) {
          vscode.window.showErrorMessage(error.message || String(error));
        }
      }),
    );
  register('hikari.connect', async () => {
    const value = await vscode.window.showInputBox({
      prompt: 'Hikari host URL',
      value: context.globalState.get('hikari.url') || 'http://127.0.0.1:4319',
    });
    if (!value) return;
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== '/' && url.pathname !== '')
    )
      throw new Error('Enter an origin URL without credentials or a path.');
    if (
      url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
      throw new Error('Use HTTPS for a remote host, or forward it to localhost through SSH.');
    const token = await vscode.window.showInputBox({
      prompt: 'Access token from Hikari',
      password: true,
      ignoreFocusOut: true,
    });
    if (!token) return;
    await context.globalState.update('hikari.url', url.origin);
    await context.secrets.store('hikari.token', token);
    await refresh();
  });
  register('hikari.start', () => start(false));
  register('hikari.review', () => start(true));
  register('hikari.refresh', refresh);
  register('hikari.show', async (task) => {
    await refresh();
    const selected = tasks.find((t) => t.id === task.id);
    output.clear();
    output.appendLine(JSON.stringify(selected, null, 2));
    output.show(true);
  });
  register('hikari.control', async (task) => {
    const action = await vscode.window.showQuickPick([
      'pause',
      'resume',
      'cancel',
      'send instructions',
    ]);
    if (!action) return;
    if (action === 'send instructions') {
      const text = await vscode.window.showInputBox({ prompt: 'Additional instructions' });
      if (text) await request('tasks/' + task.id + '/input', { text });
    } else await request('tasks/' + task.id + '/control', { action });
    await refresh();
  });
  register('hikari.approve', async (selected) => {
    await refresh();
    const task = tasks.find((t) => t.id === selected.id);
    if (!task) throw new Error('Task unavailable');
    if (task.pendingQuestion) {
      const answer = await vscode.window.showInputBox({ prompt: task.pendingQuestion.question });
      if (answer)
        await request('tasks/' + task.id + '/answer', {
          questionId: task.pendingQuestion.id,
          answer,
        });
      return;
    }
    const resolved = new Set(
      task.events
        .filter((e) => ['permission.approved', 'permission.denied'].includes(e.type))
        .map((e) => e.data.id),
    );
    const pending = task.events.filter(
      (e) => e.type === 'permission.requested' && !resolved.has(e.data.request.id),
    );
    const item = await vscode.window.showQuickPick(
      pending.map((e) => ({
        label: e.data.request.tool,
        description: JSON.stringify(e.data.request.input),
        request: e.data.request,
      })),
    );
    if (!item) return;
    const decision = await vscode.window.showQuickPick(['deny', 'once']);
    if (decision)
      await request('tasks/' + task.id + '/approve', { requestId: item.request.id, decision });
  });
  register('hikari.diff', async (task) => {
    const result = await request('tasks/' + task.id + '/diff');
    const uri = vscode.Uri.parse('hikari-diff:' + task.id + '.diff');
    documents.set(uri.toString(), result.diff);
    const document = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(document, { preview: true });
  });
  context.subscriptions.push(
    changed,
    output,
    vscode.window.registerTreeDataProvider('hikari.tasks', tree),
    vscode.workspace.registerTextDocumentContentProvider('hikari-diff', {
      provideTextDocumentContent: (uri) => documents.get(uri.toString()) || '',
    }),
  );
  const timer = setInterval(() => refresh().catch(() => {}), 3000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });
  refresh().catch(() => {});
}
module.exports = { activate, editorContext };
