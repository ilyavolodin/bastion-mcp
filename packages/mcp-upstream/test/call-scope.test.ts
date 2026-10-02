import { ProtocolError, type SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LegacyCallScope } from '../src/input-required/call-scope';

const FULL = { elicitation: { form: {}, url: {} }, sampling: {}, roots: {} };

const newScope = (overrides: Partial<ConstructorParameters<typeof LegacyCallScope>[0]> = {}) =>
  new LegacyCallScope({ id: 'c1', clientCapabilities: FULL, roots: [], ...overrides });

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('6.5 legacy-upstream call scope (continuations)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('6.5 debounces 25 ms so parallel server requests of one call are batched', async () => {
    const scope = newScope();
    scope.attach(new Promise(() => undefined));
    const a = scope.handleServerRequest('elicitation', { message: 'a' });
    const b = scope.handleServerRequest('elicitation', { message: 'b' });
    let settled = false;
    const next = scope.next().then((e) => {
      settled = true;
      return e;
    });
    await vi.advanceTimersByTimeAsync(24);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const event = await next;
    expect(event.type).toBe('requests');
    if (event.type !== 'requests') return;
    expect(Object.keys(event.inputRequests)).toEqual(['b0', 'b1']);
    expect(scope.pendingKeys).toEqual(['b0', 'b1']);
    scope.resume({ b0: { action: 'accept' }, b1: { action: 'decline' } });
    await expect(a).resolves.toEqual({ action: 'accept' });
    await expect(b).resolves.toEqual({ action: 'decline' });
  });

  it('6.5 the upstream call continues after resume and completes on the same scope', async () => {
    const call = deferred<unknown>();
    const scope = newScope();
    scope.attach(call.promise);
    const answer = scope.handleServerRequest('elicitation', {});
    await vi.advanceTimersByTimeAsync(30);
    expect((await scope.next()).type).toBe('requests');
    scope.resume({ b0: { action: 'accept', content: { x: 1 } } });
    await answer;
    const done = scope.next();
    call.resolve({ content: 'ok' });
    await expect(done).resolves.toEqual({ type: 'done', result: { content: 'ok' } });
    expect(scope.done).toBe(true);
  });

  it('6.5 a second round on the same continuation restarts keys at b0', async () => {
    const call = deferred<unknown>();
    const scope = newScope();
    scope.attach(call.promise);
    void scope.handleServerRequest('elicitation', { n: 1 });
    await vi.advanceTimersByTimeAsync(30);
    await scope.next();
    scope.resume({ b0: { action: 'accept' } });
    void scope.handleServerRequest('sampling', { n: 2 });
    await vi.advanceTimersByTimeAsync(30);
    const second = await scope.next();
    expect(second.type).toBe('requests');
    if (second.type === 'requests') expect(Object.keys(second.inputRequests)).toEqual(['b0']);
    expect(scope.rounds).toBe(2);
  });

  it('6.5 a request that arrives while a batch is out waits for the next round', async () => {
    const scope = newScope();
    scope.attach(new Promise(() => undefined));
    void scope.handleServerRequest('elicitation', { n: 1 });
    await vi.advanceTimersByTimeAsync(30);
    await scope.next();
    const late = scope.handleServerRequest('elicitation', { n: 2 });
    scope.resume({ b0: { action: 'accept' } });
    await vi.advanceTimersByTimeAsync(30);
    const next = await scope.next();
    expect(next.type).toBe('requests');
    scope.resume({ b0: { action: 'cancel' } });
    await expect(late).resolves.toEqual({ action: 'cancel' });
  });

  it('6.5 answers a missing downstream capability directly without a round trip', async () => {
    const scope = newScope({ clientCapabilities: {}, roots: ['file:///workspace'] });
    scope.attach(new Promise(() => undefined));
    await expect(scope.handleServerRequest('elicitation', {})).resolves.toEqual({
      action: 'decline',
    });
    await expect(scope.handleServerRequest('roots', {})).resolves.toEqual({
      roots: [{ uri: 'file:///workspace' }],
    });
    await expect(scope.handleServerRequest('sampling', {})).rejects.toBeInstanceOf(ProtocolError);
    expect(scope.hasPending).toBe(false);
  });

  it('6.5 on TTL expiry pending elicitations are cancelled and sampling and roots fail with -32603', async () => {
    const scope = newScope();
    scope.attach(new Promise(() => undefined));
    const e = scope.handleServerRequest('elicitation', {});
    const s = scope.handleServerRequest('sampling', {});
    const r = scope.handleServerRequest('roots', {});
    await vi.advanceTimersByTimeAsync(30);
    await scope.next();
    scope.expire();
    await expect(e).resolves.toEqual({ action: 'cancel' });
    await expect(s).rejects.toMatchObject({ code: -32603 });
    await expect(r).rejects.toMatchObject({ code: -32603 });
  });

  it('6.5 caps the rounds per original request at 10', async () => {
    const scope = newScope({ maxRounds: 2 });
    scope.attach(new Promise(() => undefined));
    for (let round = 0; round < 2; round += 1) {
      void scope.handleServerRequest('elicitation', {});
      await vi.advanceTimersByTimeAsync(30);
      expect((await scope.next()).type).toBe('requests');
      scope.resume({ b0: { action: 'accept' } });
    }
    const third = scope.handleServerRequest('elicitation', {});
    const next = scope.next();
    await vi.advanceTimersByTimeAsync(30);
    await expect(third).resolves.toEqual({ action: 'cancel' });
    let delivered = false;
    void next.then(() => {
      delivered = true;
    });
    await vi.advanceTimersByTimeAsync(100);
    expect(delivered).toBe(false);
  });

  it('6.5 an error response in inputResponses becomes a JSON-RPC error for the upstream', async () => {
    const scope = newScope();
    scope.attach(new Promise(() => undefined));
    const p = scope.handleServerRequest('sampling', {});
    await vi.advanceTimersByTimeAsync(30);
    await scope.next();
    scope.resume({ b0: { error: { code: -32000, message: 'denied' } } });
    await expect(p).rejects.toMatchObject({ code: -32000 });
  });

  it('6.5 a missing answer is treated as an expired request', async () => {
    const scope = newScope();
    scope.attach(new Promise(() => undefined));
    const p = scope.handleServerRequest('elicitation', {});
    await vi.advanceTimersByTimeAsync(30);
    await scope.next();
    scope.resume({});
    await expect(p).resolves.toEqual({ action: 'cancel' });
  });

  it('6.5 next() rejects with the error of a failed upstream call', async () => {
    const call = deferred<unknown>();
    const scope = newScope();
    scope.attach(call.promise);
    const next = scope.next();
    call.reject(new Error('upstream exploded'));
    await expect(next).rejects.toThrow('upstream exploded');
  });

  it('6.4 the call timeout pauses while the user is asked and resumes after the answer', async () => {
    const scope = newScope();
    scope.attach(new Promise(() => undefined));
    scope.armTimeout(1000);
    await vi.advanceTimersByTimeAsync(500);
    const p = scope.handleServerRequest('elicitation', {});
    await vi.advanceTimersByTimeAsync(30);
    await scope.next();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(scope.abort.signal.aborted).toBe(false);
    scope.resume({ b0: { action: 'accept' } });
    await p;
    await vi.advanceTimersByTimeAsync(600);
    expect(scope.abort.signal.aborted).toBe(true);
    const reason = scope.abort.signal.reason as SdkError;
    expect(reason.code).toBe(SdkErrorCode.RequestTimeout);
  });

  it('6.4 progress resets the call timeout', async () => {
    const scope = newScope();
    scope.attach(new Promise(() => undefined));
    scope.armTimeout(1000);
    await vi.advanceTimersByTimeAsync(800);
    scope.touch();
    await vi.advanceTimersByTimeAsync(800);
    expect(scope.abort.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(300);
    expect(scope.abort.signal.aborted).toBe(true);
  });

  it('6.5 the downstream signal aborts the upstream call only while it is bound', () => {
    const scope = newScope();
    const downstream = new AbortController();
    scope.bind(downstream.signal);
    scope.unbind();
    downstream.abort(new Error('stream closed'));
    expect(scope.abort.signal.aborted).toBe(false);
    const second = new AbortController();
    scope.bind(second.signal);
    second.abort(new Error('client cancelled'));
    expect(scope.abort.signal.aborted).toBe(true);
    const third = newScope();
    const already = new AbortController();
    already.abort(new Error('pre-aborted'));
    third.bind(already.signal);
    expect(third.abort.signal.aborted).toBe(true);
    third.bind(undefined);
  });

  it('6.5 dispose cancels everything and aborts the call', async () => {
    const scope = newScope();
    scope.attach(new Promise(() => undefined));
    const p = scope.handleServerRequest('elicitation', {});
    await vi.advanceTimersByTimeAsync(30);
    scope.dispose();
    await expect(p).resolves.toEqual({ action: 'cancel' });
    expect(scope.abort.signal.aborted).toBe(true);
  });

  it('6.5 after expiry new server requests are answered immediately', async () => {
    const scope = newScope();
    scope.attach(new Promise(() => undefined));
    scope.expire();
    await expect(scope.handleServerRequest('elicitation', {})).resolves.toEqual({
      action: 'cancel',
    });
    await expect(scope.handleServerRequest('roots', {})).rejects.toMatchObject({ code: -32603 });
  });

  it('6.5 onSettled hooks run once the call settles, immediately when it already has', async () => {
    const scope = newScope();
    const call = deferred<unknown>();
    scope.attach(call.promise);
    const seen: string[] = [];
    scope.onSettled(() => seen.push('first'));
    call.resolve(1);
    await vi.advanceTimersByTimeAsync(1);
    scope.onSettled(() => seen.push('late'));
    expect(seen).toEqual(['first', 'late']);
  });
});
