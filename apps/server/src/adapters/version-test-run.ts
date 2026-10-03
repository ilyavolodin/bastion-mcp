import type { VersionTestRun, VersionTestStep } from '@bastion-mcp/api';
import { z } from 'zod';
import { VERSION_TEST_STALE_AFTER_MS } from '../timing';
import type { StepOutcome } from './version-test-types';

const stepSchema = z.object({
  id: z.string(),
  status: z.enum(['pending', 'running', 'passed', 'failed', 'skipped']),
  detail: z.string().optional(),
  connectUrl: z.string().optional(),
});

const runSchema = z.object({
  id: z.string(),
  versionId: z.string(),
  status: z.enum(['running', 'passed', 'failed']),
  steps: z.array(stepSchema),
  startedAt: z.string(),
  finishedAt: z.string().nullable().default(null),
});

const toStep = (s: z.infer<typeof stepSchema>): VersionTestStep => ({
  id: s.id,
  status: s.status,
  ...(s.detail === undefined ? {} : { detail: s.detail }),
  ...(s.connectUrl === undefined ? {} : { connectUrl: s.connectUrl }),
});

/** Reads a `catalog_versions.test_result` value; null when it is not a run record. */
export const parseRun = (raw: unknown): VersionTestRun | null => {
  const parsed = runSchema.safeParse(raw);
  if (!parsed.success) return null;
  return { ...parsed.data, steps: parsed.data.steps.map(toStep) };
};

/** A `running` record whose process died never finishes; after this long it counts as interrupted. */
export const isStale = (
  run: VersionTestRun,
  now: number,
  staleAfterMs: number = VERSION_TEST_STALE_AFTER_MS,
): boolean => run.status === 'running' && now - Date.parse(run.startedAt) >= staleAfterMs;

export const startRun = (id: string, versionId: string, at: string): VersionTestRun => ({
  id,
  versionId,
  status: 'running',
  steps: [],
  startedAt: at,
  finishedAt: null,
});

export type RunAction =
  | { type: 'step-start'; id: string }
  | { type: 'step-end'; index: number; outcome: StepOutcome }
  | { type: 'step-error'; index: number; message: string }
  | { type: 'run-error'; message: string }
  | { type: 'finish'; at: string }
  | { type: 'interrupt'; at: string };

const setStep = (
  run: VersionTestRun,
  index: number,
  update: (step: VersionTestStep) => VersionTestStep,
): VersionTestRun => ({
  ...run,
  steps: run.steps.map((s, i) => (i === index ? update(s) : s)),
});

const failedStep = (id: string, detail: string): VersionTestStep => ({
  id,
  status: 'failed',
  detail,
});

/** The step state machine of a run: every transition returns a new record. */
export const reduceRun = (run: VersionTestRun, action: RunAction): VersionTestRun => {
  switch (action.type) {
    case 'step-start':
      return { ...run, steps: [...run.steps, { id: action.id, status: 'running' }] };
    case 'step-end':
      return setStep(run, action.index, (s) => ({
        ...s,
        status: action.outcome.status,
        ...(action.outcome.detail === undefined ? {} : { detail: action.outcome.detail }),
        ...(action.outcome.connectUrl === undefined
          ? {}
          : { connectUrl: action.outcome.connectUrl }),
      }));
    case 'step-error':
      return setStep(run, action.index, (s) => ({
        ...s,
        status: 'failed',
        detail: action.message,
      }));
    case 'run-error':
      return { ...run, steps: [...run.steps, failedStep('run', action.message)] };
    case 'finish':
      return {
        ...run,
        status: run.steps.some((s) => s.status === 'failed') ? 'failed' : 'passed',
        finishedAt: action.at,
      };
    case 'interrupt':
      return {
        ...run,
        status: 'failed',
        finishedAt: action.at,
        steps: [...run.steps, failedStep('run', 'the run was interrupted')],
      };
  }
};
