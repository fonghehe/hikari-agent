import { useState } from 'react';
import type { RunOptions, Task } from '@hikari/agent-core';
import { Dialog } from './dialog';
import { Button } from '@hikari/ui';
import { api, perform } from './store';
import { useI18n } from './i18n';

export function TaskOptions({
  close,
  mode,
  setMode,
  maxSteps,
  setMaxSteps,
  isolated,
  setIsolated,
  canIsolate,
  followUp,
  value,
  onChange,
}: {
  close(): void;
  mode: 'plan' | 'execute';
  setMode(value: 'plan' | 'execute'): void;
  maxSteps: number;
  setMaxSteps(value: number): void;
  isolated: boolean;
  setIsolated(value: boolean): void;
  canIsolate: boolean;
  followUp: boolean;
  value: Partial<RunOptions>;
  onChange(value: Partial<RunOptions>): void;
}) {
  const { t } = useI18n();
  return (
    <Dialog title={t('Task options')} close={close} className="task-options-modal">
      <label>
        {t('Mode')}
        <select
          aria-label={t('Agent mode')}
          value={mode}
          onChange={(event) => setMode(event.target.value as 'plan' | 'execute')}
        >
          <option value="execute">{t('Execute')}</option>
          <option value="plan">{t('Plan · read only')}</option>
        </select>
      </label>
      <label>
        {t('Max turns')}
        <input
          aria-label={t('Maximum model turns')}
          type="number"
          min={1}
          max={100}
          value={maxSteps}
          onChange={(event) =>
            setMaxSteps(Math.max(1, Math.min(100, Number(event.target.value) || 1)))
          }
        />
      </label>
      {!followUp && (
        <label className="checkbox-label">
          <input
            type="checkbox"
            disabled={!canIsolate}
            checked={isolated}
            onChange={(event) => setIsolated(event.target.checked)}
          />
          {t('Isolate in a Git worktree')}
        </label>
      )}
      <RunSettings value={value} onChange={onChange} />
    </Dialog>
  );
}

export function RunSettings({
  value,
  onChange,
}: {
  value: Partial<RunOptions>;
  onChange(value: Partial<RunOptions>): void;
}) {
  const { t } = useI18n();
  const update = (next: Partial<RunOptions>) => onChange({ ...value, ...next });
  return (
    <details className="run-settings">
      <summary>{t('Acceptance and budgets')}</summary>
      <div className="settings-grid">
        <label>
          {t('Persistent goal (optional)')}
          <textarea
            aria-label={t('Persistent goal (optional)')}
            maxLength={4000}
            value={value.goal?.objective ?? ''}
            onChange={(event) =>
              update({
                goal: event.target.value
                  ? {
                      objective: event.target.value,
                      maxContinuations: value.goal?.maxContinuations ?? 5,
                    }
                  : undefined,
              })
            }
          />
        </label>
        {value.goal && (
          <label>
            {t('Maximum goal continuations')}
            <input
              type="number"
              min={1}
              max={20}
              value={value.goal.maxContinuations}
              onChange={(event) =>
                update({ goal: { ...value.goal!, maxContinuations: Number(event.target.value) } })
              }
            />
          </label>
        )}
        <label>
          {t('Workflow')}
          <select
            aria-label={t('Workflow')}
            value={value.workflow ?? 'standard'}
            onChange={(e) => update({ workflow: e.target.value as RunOptions['workflow'] })}
          >
            <option value="standard">{t('Standard agent')}</option>
            <option value="development">{t('Investigate → Plan → Implement → Review')}</option>
          </select>
        </label>
        <label>
          {t('Worktree starting point')}
          <select
            aria-label={t('Worktree starting point')}
            value={value.worktreeSource ?? 'head'}
            onChange={(e) =>
              update({ worktreeSource: e.target.value as RunOptions['worktreeSource'] })
            }
          >
            <option value="head">HEAD</option>
            <option value="working-tree">{t('Include current uncommitted files')}</option>
          </select>
        </label>
        <label>
          {t('Token limit')}
          <input
            type="number"
            min={1000}
            max={10000000}
            value={value.maxTokens ?? ''}
            placeholder={t('No limit')}
            onChange={(e) =>
              update({ maxTokens: e.target.value ? Number(e.target.value) : undefined })
            }
          />
        </label>
        <label>
          {t('Cost limit (USD)')}
          <input
            type="number"
            min={0.01}
            step={0.01}
            max={10000}
            value={value.maxCostUsd ?? ''}
            placeholder={t('No limit')}
            onChange={(e) =>
              update({ maxCostUsd: e.target.value ? Number(e.target.value) : undefined })
            }
          />
        </label>
        <label>
          {t('Time limit (minutes)')}
          <input
            type="number"
            min={1}
            max={1440}
            value={value.maxDurationMs ? value.maxDurationMs / 60000 : ''}
            placeholder={t('No limit')}
            onChange={(e) =>
              update({ maxDurationMs: e.target.value ? Number(e.target.value) * 60000 : undefined })
            }
          />
        </label>
        <label>
          {t('Test requirement')}
          <select
            aria-label={t('Test requirement')}
            value={value.requireTests === undefined ? 'auto' : String(value.requireTests)}
            onChange={(e) =>
              update({
                requireTests: e.target.value === 'auto' ? undefined : e.target.value === 'true',
              })
            }
          >
            <option value="auto">{t('Required after file changes')}</option>
            <option value="true">{t('Always required')}</option>
            <option value="false">{t('Use acceptance checks only')}</option>
          </select>
        </label>
        <label>
          {t('Command execution')}
          <select
            aria-label={t('Command execution')}
            value={value.execution ?? 'restricted'}
            onChange={(e) => update({ execution: e.target.value as 'restricted' | 'host' })}
          >
            <option value="restricted">{t('OS sandbox')}</option>
            <option value="host">{t('Host access · approved commands')}</option>
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={value.allowNetwork ?? false}
            onChange={(e) => update({ allowNetwork: e.target.checked })}
          />
          {t('Allow network in sandbox')}
        </label>
      </div>
      {(value.checks ?? []).map((check, index) => (
        <fieldset key={check.id}>
          <legend>
            {t('Acceptance check')} {index + 1}
          </legend>
          <label>
            {t('Check description')}
            <input
              aria-label={t('Check description')}
              value={check.label}
              onChange={(e) =>
                update({
                  checks: value.checks?.map((item) =>
                    item.id === check.id ? { ...item, label: e.target.value } : item,
                  ),
                })
              }
            />
          </label>
          {check.kind === 'file' ? (
            <>
              <label className="field-wide">
                {t('File path')}
                <input
                  aria-label={t('File path')}
                  placeholder={t('File path')}
                  value={check.path}
                  onChange={(e) =>
                    update({
                      checks: value.checks?.map((item) =>
                        item.id === check.id ? { ...check, path: e.target.value } : item,
                      ),
                    })
                  }
                />
              </label>
              <label>
                {t('Required text')}
                <input
                  aria-label={t('Required text')}
                  placeholder={t('Required text')}
                  value={check.contains ?? ''}
                  onChange={(e) =>
                    update({
                      checks: value.checks?.map((item) =>
                        item.id === check.id
                          ? { ...check, contains: e.target.value || undefined }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={check.exists}
                  onChange={(e) =>
                    update({
                      checks: value.checks?.map((item) =>
                        item.id === check.id ? { ...check, exists: e.target.checked } : item,
                      ),
                    })
                  }
                />
                {t('File must exist')}
              </label>
            </>
          ) : (
            <>
              <label className="field-wide">
                {t('Executable')}
                <input
                  aria-label={t('Executable')}
                  placeholder="pnpm"
                  value={check.command}
                  onChange={(e) =>
                    update({
                      checks: value.checks?.map((item) =>
                        item.id === check.id ? { ...check, command: e.target.value } : item,
                      ),
                    })
                  }
                />
              </label>
              <label>
                {t('Arguments (one per line)')}
                <textarea
                  aria-label={t('Arguments (one per line)')}
                  placeholder={t('Arguments (one per line)')}
                  value={check.args.join('\n')}
                  onChange={(e) =>
                    update({
                      checks: value.checks?.map((item) =>
                        item.id === check.id
                          ? { ...check, args: e.target.value.split('\n').filter(Boolean) }
                          : item,
                      ),
                    })
                  }
                />
              </label>
              <label className="field-wide">
                {t('Working directory')}
                <input
                  aria-label={t('Working directory')}
                  value={check.cwd}
                  onChange={(e) =>
                    update({
                      checks: value.checks?.map((item) =>
                        item.id === check.id ? { ...check, cwd: e.target.value } : item,
                      ),
                    })
                  }
                />
              </label>
            </>
          )}
          <Button
            variant="ghost"
            onClick={() => update({ checks: value.checks?.filter((item) => item.id !== check.id) })}
          >
            {t('Remove')}
          </Button>
        </fieldset>
      ))}
      <div className="actions">
        <Button
          variant="outline"
          disabled={(value.checks?.length ?? 0) >= 12}
          onClick={() =>
            update({
              checks: [
                ...(value.checks ?? []),
                {
                  id: crypto.randomUUID(),
                  label: t('File condition'),
                  kind: 'file',
                  path: '',
                  exists: true,
                },
              ],
            })
          }
        >
          {t('Add file check')}
        </Button>
        <Button
          variant="outline"
          disabled={(value.checks?.length ?? 0) >= 12}
          onClick={() =>
            update({
              checks: [
                ...(value.checks ?? []),
                {
                  id: crypto.randomUUID(),
                  label: t('Test command'),
                  kind: 'test',
                  command: 'pnpm',
                  args: ['test'],
                  cwd: '.',
                },
              ],
            })
          }
        >
          {t('Add test command')}
        </Button>
      </div>
    </details>
  );
}
export function UserInput({ task }: { task: Task }) {
  const { t } = useI18n();
  const [answer, setAnswer] = useState('');
  const [busy, setBusy] = useState(false);
  const question = task.pendingQuestion;
  if (!question || task.status !== 'waiting_input') return null;
  const submit = (text: string) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    void perform(async () => {
      await api().agent.answer(task.id, question.id, text);
      setAnswer('');
    }).finally(() => setBusy(false));
  };
  return (
    <section className="user-question" aria-label={t('Agent question')}>
      <strong>{t('Your input is needed')}</strong>
      <p>{question.question}</p>
      <div className="actions">
        {question.choices?.map((choice) => (
          <Button key={choice} disabled={busy} onClick={() => submit(choice)}>
            {choice}
          </Button>
        ))}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit(answer);
        }}
      >
        <input
          aria-label={t('Answer')}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          maxLength={12000}
        />
        <Button type="submit" disabled={busy || !answer.trim()}>
          {t('Send answer')}
        </Button>
      </form>
    </section>
  );
}
