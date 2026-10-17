import path from 'node:path';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  repositorySuiteSchema,
  type EvaluationCommand,
} from '../../packages/agent-host/src/evaluation';
import { redact, runOptionsSchema } from '../../packages/agent-core/src';
import { SessionHost } from '../../packages/agent-host/src';
import { GitService } from '../../packages/git/src';
import { NativeSandboxProvider, runProcess } from '../../packages/sandbox/src';
import { createModelProvider } from '../../packages/model-provider/src';
import { evaluationHelp, evaluationSettings, loadEvaluationEnv } from './config';

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      evaluationHelp('repository', []) +
        '\nEach case runs in a temporary clone. --validate checks checkout, setup and a failing baseline only.',
    );
    return;
  }
  loadEvaluationEnv();
  if (!process.env.EVAL_REPOSITORY_SUITE)
    throw new Error(
      'Set EVAL_REPOSITORY_SUITE to a local JSON suite. See examples/evals/repository-suite.json.',
    );
  const filename = path.resolve(process.env.EVAL_REPOSITORY_SUITE);
  const suite = repositorySuiteSchema.parse(JSON.parse(await readFile(filename, 'utf8')));
  const settings = evaluationSettings(
    'repository',
    suite.cases.map((item) => item.name),
    args,
    process.env,
  );
  if (settings.mode === 'list') {
    console.log(suite.cases.map((item) => item.name).join('\n'));
    return;
  }
  if (settings.mode === 'help') return;
  const directory = path.join(process.cwd(), '.agent', 'evals', `${Date.now()}-repository`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const results = [];
  const selected = suite.cases.filter((item) => settings.selected.includes(item.name));
  for (const test of selected) {
    for (let sample = 0; sample < (settings.mode === 'run' ? settings.samples : 1); sample++) {
      const temporary = await realpath(
        await mkdtemp(path.join(tmpdir(), 'hikari-repository-eval-')),
      );
      const root = path.join(temporary, 'checkout');
      let host: SessionHost | undefined;
      const started = Date.now();
      try {
        // Only local repositories and exact commits are accepted; the source checkout is never edited.
        const source = await realpath(path.resolve(path.dirname(filename), test.repository));
        await new GitService(temporary).run([
          'clone',
          '--no-local',
          '--no-hardlinks',
          '--no-checkout',
          '--',
          source,
          root,
        ]);
        const git = new GitService(root);
        await git.run(['checkout', '--detach', test.commit]);
        if ((await git.run(['rev-parse', 'HEAD'])).trim() !== test.commit)
          throw new Error('Checkout commit mismatch');
        const sandbox = new NativeSandboxProvider(root, false);
        const execute = async (spec: EvaluationCommand, executionSandbox = sandbox) => {
          const launch = await executionSandbox.launch(spec.command, spec.args, root);
          try {
            return await runProcess(launch.command, launch.args, {
              cwd: root,
              env: launch.env,
              timeoutMs: spec.timeoutMs,
              signal: AbortSignal.timeout(spec.timeoutMs),
              maxOutput: 64000,
            });
          } finally {
            await launch.cleanup();
          }
        };
        for (const setup of test.setup) {
          const result = await execute(setup, new NativeSandboxProvider(root, test.setupNetwork));
          if (result.exitCode !== 0) throw new Error('Setup failed: ' + result.output);
        }
        const preserved = await Promise.all(
          test.preservePaths.map(async (name) => {
            const resolved = await sandbox.resolve(root, name);
            return [name, await readFile(resolved)] as const;
          }),
        );
        const baseline = await execute(test.grader);
        if (baseline.exitCode === 0)
          throw new Error('Baseline passed; this case does not reproduce the requested defect');
        if (settings.mode === 'validate') {
          results.push({
            case: test.name,
            commit: test.commit,
            sample,
            passed: true,
            baselineExit: baseline.exitCode,
            evidence: 'baseline-only',
            durationMs: Date.now() - started,
          });
          console.log(`Baseline validated: ${test.name}`);
          continue;
        }
        host = new SessionHost({
          root,
          provider: createModelProvider(settings.config),
          pricing: settings.config,
          contextWindow: settings.config.contextWindow,
          modelIdentity: {
            provider: settings.config.provider,
            model: settings.config.model,
            baseUrl: settings.config.baseUrl,
          },
          approve: async () => 'once',
        });
        const task = await host.start(
          test.prompt,
          runOptionsSchema.parse({
            execution: 'restricted',
            allowNetwork: false,
            workflow: settings.workflow,
            maxTokens: settings.maxTokens,
            maxDurationMs: 180000,
            maxSteps: 50,
            requireTests: true,
          }),
        );
        await host.wait(task.id);
        const modified = new Set(
          [
            ...(await git.run(['diff', '--name-only', '-z', 'HEAD', '--'])).split('\0'),
            ...(await git.run(['ls-files', '--others', '--exclude-standard', '-z'])).split('\0'),
          ].filter((name) => name && !name.startsWith('.agent/')),
        );
        const outsideAllowed = [...modified].filter((name) => !test.allowedPaths.includes(name));
        let preservedPassed = true;
        for (const [name, before] of preserved) {
          const current = await sandbox
            .resolve(root, name)
            .then((file) => readFile(file))
            .catch(() => undefined);
          if (!current?.equals(before)) preservedPassed = false;
        }
        const graded = await execute(test.grader);
        const passed =
          task.status === 'completed' &&
          modified.size > 0 &&
          outsideAllowed.length === 0 &&
          preservedPassed &&
          graded.exitCode === 0;
        const stem = `${test.name}-${sample}`;
        await writeFile(
          path.join(directory, stem + '.task.json'),
          JSON.stringify(redact(task), null, 2),
          { mode: 0o600 },
        );
        await writeFile(path.join(directory, stem + '.diff'), String(redact(await git.diff())), {
          mode: 0o600,
        });
        results.push({
          case: test.name,
          commit: test.commit,
          sample,
          passed,
          evidence: 'model-run',
          status: task.status,
          baselineExit: baseline.exitCode,
          graderExit: graded.exitCode,
          graderOutput: String(redact(graded.output)),
          modified: [...modified],
          outsideAllowed,
          preservedPassed,
          summary: task.runSummary,
          durationMs: Date.now() - started,
        });
        console.log(`${test.name} ${sample + 1}: ${passed ? 'PASS' : 'FAIL'}`);
      } catch (error) {
        results.push({
          case: test.name,
          commit: test.commit,
          sample,
          passed: false,
          error: String(redact(String(error))),
          durationMs: Date.now() - started,
        });
      } finally {
        await host?.close();
        await rm(temporary, { recursive: true, force: true });
      }
    }
  }
  const report = {
    suite: 'repository',
    workflow: settings.mode === 'run' ? (settings.workflow ?? 'standard') : undefined,
    evidence: settings.mode === 'validate' ? 'baseline-only' : 'model-run',
    provider: settings.mode === 'run' ? settings.config.provider : undefined,
    model: settings.mode === 'run' ? settings.config.model : undefined,
    runtime: process.version,
    createdAt: new Date().toISOString(),
    limits:
      settings.mode === 'run'
        ? { maxTokens: settings.maxTokens, maxDurationMs: 180000 }
        : undefined,
    successRate: results.filter((item) => item.passed).length / results.length,
    results,
  };
  await writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2), {
    mode: 0o600,
  });
  console.log(`Repository report: ${directory}`);
  if (settings.mode === 'validate')
    console.log('No model ran. Only baseline reproduction was validated.');
  if (report.successRate !== 1) process.exitCode = 1;
}
// Keep imports side-effect free for tooling.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(
      String(redact(String(error))) + '\nRun pnpm eval:repository --help for setup instructions.',
    );
    process.exitCode = 2;
  });
}
