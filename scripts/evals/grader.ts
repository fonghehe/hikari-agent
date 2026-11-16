import { NativeSandboxProvider, runProcess } from '../../packages/sandbox/src/index';
import { verifyAnswer, type EvaluationCase } from './tasks';

/** Candidate modules execute during grading too: they must not gain host access. */
export async function gradeCase(root: string, test: EvaluationCase, answer = '') {
  if (test.answer) {
    const passed = verifyAnswer(test, answer);
    return {
      exitCode: passed ? 0 : 1,
      output: 'HIKARI_EVAL_RESULT ' + JSON.stringify({ status: passed ? 'pass' : 'fail' }),
    };
  }
  const sandbox = new NativeSandboxProvider(root, false);
  const launch = await sandbox.launch(process.execPath, ['-e', test.grader], root);
  try {
    return await runProcess(launch.command, launch.args, {
      cwd: root,
      env: launch.env,
      signal: AbortSignal.timeout(10000),
      maxOutput: 64000,
    });
  } finally {
    await launch.cleanup();
  }
}
