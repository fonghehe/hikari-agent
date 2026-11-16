// Instruments an in-memory bundle of the real renderer; no production hooks or model calls.
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
const desktopRequire = createRequire(path.resolve('apps/desktop/package.json'));
const taskCount = Number(process.argv[2] ?? 100);
const frames = Number(process.argv[3] ?? 30);
if (![taskCount, frames].every((n) => Number.isInteger(n) && n > 0 && n <= 1000))
  throw new Error('Use task count and frame count between 1 and 1000');
const bundle = await build({
  entryPoints: ['apps/desktop/src/renderer/main.tsx'],
  bundle: true,
  write: false,
  format: 'iife',
  platform: 'browser',
  outfile: 'renderer.js',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { 'react-dom/client': desktopRequire.resolve('react-dom/profiling') },
  loader: { '.css': 'empty', '.otf': 'dataurl', '.svg': 'dataurl' },
  plugins: [
    {
      name: 'measure-real-renderer',
      setup(builder) {
        builder.onResolve({ filter: /\?worker$/ }, () => ({
          path: 'unused-editor-worker',
          namespace: 'benchmark-worker',
        }));
        builder.onLoad({ filter: /.*/, namespace: 'benchmark-worker' }, () => ({
          contents: 'export default class UnusedEditorWorker {}',
        }));
        builder.onLoad(
          {
            filter:
              /renderer[\\/](?:main\.tsx|app[\\/](?:app\.tsx|store\.ts)|features[\\/]conversations[\\/]timeline\.tsx)$/,
          },
          async ({ path: filename }) => {
            let contents = await readFile(filename, 'utf8');
            const location = filename.replaceAll('\\', '/');
            const instrument = (needle, replacement) => {
              if (!contents.includes(needle))
                throw new Error(`Benchmark instrumentation missing in ${filename}: ${needle}`);
              contents = contents.replace(needle, replacement);
            };
            if (location.endsWith('/app/app.tsx'))
              instrument('function App() {', 'function App() { window.__bench.appRenders++;');
            if (location.endsWith('/features/conversations/timeline.tsx'))
              instrument(
                'function Timeline({ events }: { events: AgentEvent[] }) {',
                'function Timeline({ events }: { events: AgentEvent[] }) { window.__bench.timelineRenders++;',
              );
            if (location.endsWith('/main.tsx'))
              instrument(
                '<App />',
                '<React.Profiler id="App" onRender={(_id, _phase, duration) => window.__bench.commits.push(duration)}><App /></React.Profiler>',
              );
            if (location.endsWith('/app/store.ts'))
              contents += '\nwindow.__bench.store = useStore;';
            return {
              contents,
              loader: filename.endsWith('.tsx') ? 'tsx' : 'ts',
              resolveDir: path.dirname(filename),
            };
          },
        );
      },
    },
  ],
});
const browser = await chromium.launch({
  headless: true,
  channel: process.env.HIKARI_TEST_BROWSER_CHANNEL || 'chrome',
});
try {
  const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' }),
  );
  await page.goto('http://hikari-benchmark.invalid');
  await page.evaluate(
    ({ taskCount }) => {
      const bench = (window.__bench = {
        appRenders: 0,
        timelineRenders: 0,
        commits: [],
        ipc: 0,
        bytes: 0,
      });
      const tasks = Array.from({ length: taskCount }, (_, i) => ({
        id: 'task-' + i,
        agentId: 'agent-' + i,
        title: 'Fictional task ' + i,
        prompt: 'Fixture',
        workspace: '/fixture',
        status: i < 2 ? 'thinking' : 'completed',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
        events: [],
      }));
      tasks[0].events = Array.from({ length: 2000 }, (_, i) => ({
        id: 'history-' + i,
        agentId: 'agent-0',
        taskId: 'task-0',
        type: 'tool.stdout',
        timestamp: '2026-01-01T00:00:00Z',
        data: { chunk: 'historical output' },
      }));
      const workspace = { root: '/fixture', name: 'Fixture', files: [] };
      window.hikari = {
        preferences: { get: async () => ({ language: 'en', theme: 'dark' }) },
        workspace: { snapshot: async () => workspace, recent: async () => [workspace] },
        sections: { list: async () => [] },
        agent: {
          configured: async () => true,
          subscribe: () => () => {},
          list: async () => {
            bench.ipc++;
            const value = JSON.stringify(tasks);
            bench.bytes += value.length;
            await new Promise((resolve) => setTimeout(resolve, 8));
            return JSON.parse(value);
          },
        },
      };
    },
    { taskCount },
  );
  await page.addScriptTag({ content: bundle.outputFiles[0].text });
  await page.waitForFunction(() => window.__bench.store?.getState().tasks.length > 0);
  await page.evaluate(() => window.__bench.store.setState({ activeId: 'task-0' }));
  await page.waitForTimeout(100);
  const measurements = [];
  for (const target of ['background', 'foreground', 'state-burst']) {
    measurements.push(
      await page.evaluate(
        async ({ target, frames }) => {
          const b = window.__bench;
          b.appRenders = 0;
          b.timelineRenders = 0;
          b.commits = [];
          b.ipc = 0;
          b.bytes = 0;
          let notices = 0;
          const off = b.store.subscribe(() => notices++);
          const started = performance.now();
          for (let frame = 0; frame < frames; frame++) {
            if (target !== 'state-burst') await new Promise(requestAnimationFrame);
            for (let i = 0; i < 8; i++)
              b.store.getState().receive({
                id: `${target}-${frame}-${i}`,
                taskId: target === 'foreground' ? 'task-0' : 'task-1',
                agentId: 'fixture',
                timestamp: '2026-01-01T00:00:00Z',
                type: target === 'state-burst' ? 'agent.state' : 'agent.message.delta',
                data: target === 'state-burst' ? { state: 'thinking' } : { text: 'x'.repeat(80) },
              });
          }
          await new Promise((resolve) => setTimeout(resolve, 150));
          off();
          const durations = b.commits.slice().sort((a, z) => a - z);
          return {
            target,
            events: frames * 8,
            appRenders: b.appRenders,
            timelineRenders: b.timelineRenders,
            commits: durations.length,
            commitP95Ms: durations[Math.max(0, Math.ceil(durations.length * 0.95) - 1)] ?? 0,
            storeNotifications: notices,
            listIPC: b.ipc,
            snapshotBytes: b.bytes,
            elapsedMs: performance.now() - started,
          };
        },
        { target, frames },
      ),
    );
  }
  if (errors.length) throw new Error(errors.join('\n'));
  console.log(
    JSON.stringify(
      {
        node: process.version,
        platform: process.platform,
        arch: process.arch,
        browser: browser.version(),
        taskCount,
        frames,
        historyEvents: 2000,
        measurements,
      },
      null,
      2,
    ),
  );
} finally {
  await browser.close();
}
