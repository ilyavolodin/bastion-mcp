import type { VersionTestRun } from '@bastion-mcp/api';
import { describe, expect, it } from 'vitest';
import { isStale, parseRun, reduceRun, startRun } from '../src/adapters/version-test-run';
import { VERSION_TEST_STALE_AFTER_MS } from '../src/timing';

const T0 = '2026-01-01T00:00:00.000Z';
const base = (over: Partial<VersionTestRun> = {}): VersionTestRun => ({
  ...startRun('run-1', 'ver-1', T0),
  ...over,
});

describe('11.3 parseRun', () => {
  it('reads a stored run and fills a missing finishedAt', () => {
    const run = parseRun({
      id: 'r',
      versionId: 'v',
      status: 'running',
      steps: [{ id: 'prepare', status: 'passed', detail: 'ok' }],
      startedAt: T0,
    });
    expect(run).toEqual({
      id: 'r',
      versionId: 'v',
      status: 'running',
      steps: [{ id: 'prepare', status: 'passed', detail: 'ok' }],
      startedAt: T0,
      finishedAt: null,
    });
  });

  it('rejects values that are not run records', () => {
    expect(parseRun(null)).toBeNull();
    expect(parseRun('x')).toBeNull();
    expect(parseRun({ id: 'r', steps: 'nope' })).toBeNull();
    expect(
      parseRun({ id: 'r', versionId: 'v', status: 'weird', steps: [], startedAt: T0 }),
    ).toBeNull();
  });
});

describe('11.3 isStale', () => {
  const started = Date.parse(T0);
  it('only a running record can be stale', () => {
    expect(isStale(base({ status: 'passed' }), started + 10 * VERSION_TEST_STALE_AFTER_MS)).toBe(
      false,
    );
  });
  it('is stale once the run is older than the limit', () => {
    expect(isStale(base(), started + VERSION_TEST_STALE_AFTER_MS - 1)).toBe(false);
    expect(isStale(base(), started + VERSION_TEST_STALE_AFTER_MS)).toBe(true);
  });
  it('takes the limit as a parameter', () => {
    expect(isStale(base(), started + 1_000, 1_000)).toBe(true);
  });
});

describe('11.3 reduceRun state machine', () => {
  it('starts a step as running', () => {
    const run = reduceRun(base(), { type: 'step-start', id: 'prepare' });
    expect(run.steps).toEqual([{ id: 'prepare', status: 'running' }]);
  });

  it('records the outcome of a step with its detail and connect URL', () => {
    let run = reduceRun(base(), { type: 'step-start', id: 'connect' });
    run = reduceRun(run, {
      type: 'step-end',
      index: 0,
      outcome: { status: 'failed', detail: 'sign in first', connectUrl: 'https://x/connect/1' },
    });
    expect(run.steps[0]).toEqual({
      id: 'connect',
      status: 'failed',
      detail: 'sign in first',
      connectUrl: 'https://x/connect/1',
    });
  });

  it('turns a thrown error into a failed step', () => {
    let run = reduceRun(base(), { type: 'step-start', id: 'scan' });
    run = reduceRun(run, { type: 'step-error', index: 0, message: 'kaboom' });
    expect(run.steps[0]).toEqual({ id: 'scan', status: 'failed', detail: 'kaboom' });
  });

  it('never mutates the previous record', () => {
    const before = base();
    reduceRun(before, { type: 'step-start', id: 'prepare' });
    expect(before.steps).toEqual([]);
  });

  it('finishes passed when no step failed, skipped steps included', () => {
    let run = reduceRun(base(), { type: 'step-start', id: 'a' });
    run = reduceRun(run, { type: 'step-end', index: 0, outcome: { status: 'skipped' } });
    run = reduceRun(run, { type: 'finish', at: '2026-01-01T00:01:00.000Z' });
    expect(run.status).toBe('passed');
    expect(run.finishedAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('finishes failed when any step failed', () => {
    let run = reduceRun(base(), { type: 'step-start', id: 'a' });
    run = reduceRun(run, { type: 'step-end', index: 0, outcome: { status: 'failed' } });
    expect(reduceRun(run, { type: 'finish', at: T0 }).status).toBe('failed');
  });

  it('records an escaped error as a failed "run" step', () => {
    const run = reduceRun(base(), { type: 'run-error', message: 'db down' });
    expect(run.steps).toEqual([{ id: 'run', status: 'failed', detail: 'db down' }]);
  });

  it('marks an interrupted run failed with a final step', () => {
    const run = reduceRun(base(), { type: 'interrupt', at: '2026-01-01T01:00:00.000Z' });
    expect(run.status).toBe('failed');
    expect(run.finishedAt).toBe('2026-01-01T01:00:00.000Z');
    expect(run.steps.at(-1)).toEqual({
      id: 'run',
      status: 'failed',
      detail: 'the run was interrupted',
    });
  });
});
