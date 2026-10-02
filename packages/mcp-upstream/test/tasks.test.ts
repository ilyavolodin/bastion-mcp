import { type Keyring, sealJson } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import {
  extensionAllowed,
  filterExtensions,
  TASKS_EXTENSION,
  UI_EXTENSION,
} from '../src/tasks/extensions';
import {
  InvalidTaskIdError,
  isTaskMethod,
  rewriteTaskId,
  unwrapTaskId,
  wrapTaskId,
  wrapTaskResult,
} from '../src/tasks/wrap';

const ring: Keyring = { activeKid: 'k1', keys: new Map([['k1', Buffer.alloc(32, 7)]]) };

describe('6.8 Tasks wrapping', () => {
  it('6.8 wraps a task id as btk1. plus an AEAD payload {p, i, upstreamTaskId, exp}', () => {
    const id = wrapTaskId(ring, {
      principalId: 'p1',
      installationId: 'i1',
      upstreamTaskId: 'up-9',
      nowSeconds: 1000,
    });
    expect(id.startsWith('btk1.')).toBe(true);
    expect(unwrapTaskId(ring, id, 'p1', 1001)).toEqual({
      p: 'p1',
      i: 'i1',
      upstreamTaskId: 'up-9',
      exp: 1000 + 86_400,
    });
  });

  it('6.8 rejects a task id of another principal, an expired one and a forged one with -32602', () => {
    const id = wrapTaskId(ring, {
      principalId: 'p1',
      installationId: 'i1',
      upstreamTaskId: 'u',
      nowSeconds: 1000,
      ttlSeconds: 60,
    });
    expect(() => unwrapTaskId(ring, id, 'p2', 1001)).toThrow(InvalidTaskIdError);
    expect(() => unwrapTaskId(ring, id, 'p1', 2000)).toThrow(InvalidTaskIdError);
    expect(() => unwrapTaskId(ring, 'btk1.nonsense', 'p1', 1)).toThrow(InvalidTaskIdError);
    expect(() => unwrapTaskId(ring, 'bst1.x', 'p1', 1)).toThrow(InvalidTaskIdError);
    const wrongShape = sealJson({ p: 'p1' }, ring, { prefix: 'btk1.' });
    expect(() => unwrapTaskId(ring, wrongShape, 'p1', 1)).toThrow(InvalidTaskIdError);
    try {
      unwrapTaskId(ring, id, 'p2', 1001);
    } catch (error) {
      expect((error as InvalidTaskIdError).mcpCode).toBe(-32602);
    }
  });

  it('6.8 a CreateTaskResult gets its taskId wrapped and everything else unchanged', () => {
    const result = {
      resultType: 'task',
      task: { taskId: 'up-1', status: 'working', ttl: 120_000 },
    };
    const wrapped = wrapTaskResult(ring, result, {
      principalId: 'p1',
      installationId: 'i1',
      nowSeconds: 10,
    }) as typeof result;
    expect(wrapped.resultType).toBe('task');
    expect(wrapped.task.status).toBe('working');
    expect(wrapped.task.taskId.startsWith('btk1.')).toBe(true);
    const payload = unwrapTaskId(ring, wrapped.task.taskId, 'p1', 11);
    expect(payload.upstreamTaskId).toBe('up-1');
    expect(payload.exp).toBe(10 + 120);
  });

  it('6.8 leaves results without a task id alone and rewrites ids on tasks/get results', () => {
    const input = { principalId: 'p', installationId: 'i', nowSeconds: 1 };
    expect(wrapTaskResult(ring, { ok: true }, input)).toEqual({ ok: true });
    expect(wrapTaskResult(ring, 'str', input)).toBe('str');
    expect(rewriteTaskId({ taskId: 'up', status: 'x' }, 'btk1.w')).toEqual({
      taskId: 'btk1.w',
      status: 'x',
    });
    expect(rewriteTaskId({ task: { taskId: 'up' } }, 'btk1.w')).toEqual({
      task: { taskId: 'btk1.w' },
    });
    expect(isTaskMethod('tasks/get')).toBe(true);
    expect(isTaskMethod('tools/call')).toBe(false);
  });
});

describe('6.8 extension allow and block lists', () => {
  const single = { singleInstallationEndpoint: true };
  const aggregate = { singleInstallationEndpoint: false };

  it('6.8 known extensions pass unless blocked or outside a non-empty allow list', () => {
    expect(extensionAllowed(TASKS_EXTENSION, {}, aggregate)).toBe(true);
    expect(extensionAllowed(UI_EXTENSION, { block: [UI_EXTENSION] }, aggregate)).toBe(false);
    expect(extensionAllowed(TASKS_EXTENSION, { allow: [UI_EXTENSION] }, aggregate)).toBe(false);
    expect(extensionAllowed(UI_EXTENSION, { allow: [UI_EXTENSION] }, aggregate)).toBe(true);
  });

  it('6.8 unknown extensions are forwarded only on single-installation endpoints', () => {
    expect(extensionAllowed('com.acme/x', {}, aggregate)).toBe(false);
    expect(extensionAllowed('com.acme/x', {}, single)).toBe(true);
    expect(extensionAllowed('com.acme/x', { block: ['com.acme/x'] }, single)).toBe(false);
  });

  it('6.8 filters a declared extension map', () => {
    const declared = { [TASKS_EXTENSION]: {}, 'com.acme/x': { v: 1 }, [UI_EXTENSION]: {} };
    expect(Object.keys(filterExtensions(declared, { block: [UI_EXTENSION] }, aggregate))).toEqual([
      TASKS_EXTENSION,
    ]);
    expect(Object.keys(filterExtensions(declared, {}, single)).sort()).toEqual(
      ['com.acme/x', TASKS_EXTENSION, UI_EXTENSION].sort(),
    );
    expect(filterExtensions(undefined, {}, single)).toEqual({});
  });
});
