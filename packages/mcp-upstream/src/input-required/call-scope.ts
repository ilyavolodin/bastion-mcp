import { MAX_INPUT_ROUNDS, TIMEOUTS_MS } from '@bastion-mcp/core';
import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/client';
import type { ClientCapabilitiesLike, InputRequestMap, UpstreamNotification } from '../types';
import {
  answerExpired,
  answerMissingCapability,
  asErrorResponse,
  type BatchEntry,
  clientSupports,
  type ServerRequestKind,
  toInputRequests,
} from './helpers';

/**
 * One in-flight call to a LEGACY upstream that may raise server-to-client requests (6.5). The SDK `Client` handlers
 * (`elicitation/create`, `sampling/createMessage`, `roots/list`) call `handleServerRequest`; the scope batches
 * the requests of a 25 ms window, ends the operation with `input_required` (`next()` resolves with `requests`)
 * and resolves the handler promises when `resume()` brings the answers, so the upstream call continues.
 */

export type ScopeEvent =
  | { type: 'done'; result: unknown }
  | { type: 'requests'; inputRequests: InputRequestMap };

type Pending = {
  kind: ServerRequestKind;
  params: unknown;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
};

export type CallScopeOptions = {
  id: string;
  /** Capabilities of the downstream client that issued the call; replaced on every resume. */
  clientCapabilities: ClientCapabilitiesLike;
  roots: readonly string[];
  debounceMs?: number;
  maxRounds?: number;
};

export class LegacyCallScope {
  readonly id: string;
  /** Aborts the upstream call; linked to the downstream signal only while a downstream request is attached. */
  readonly abort = new AbortController();
  rounds = 0;
  /** Where progress notifications of the CURRENT downstream request go; replaced on every resume. */
  emit: ((notification: UpstreamNotification) => void) | undefined;
  clientCapabilities: ClientCapabilitiesLike;
  private readonly roots: readonly string[];
  private readonly debounceMs: number;
  private readonly maxRounds: number;
  /** Requests received since the last freeze. */
  private waiting: Pending[] = [];
  /** The batch that was handed out as `inputRequests`, keyed `b0`... */
  private frozen: Pending[] = [];
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private batchReady = false;
  private settled: { ok: true; value: unknown } | { ok: false; error: unknown } | undefined;
  private wake: (() => void) | undefined;
  private unbindSignal: (() => void) | undefined;
  private callTimer: ReturnType<typeof setTimeout> | undefined;
  private timeoutMs = 0;
  private timeoutDeadline = 0;
  private pausedRemaining: number | undefined;
  private expired = false;
  private settledHooks: (() => void)[] = [];

  constructor(options: CallScopeOptions) {
    this.id = options.id;
    this.clientCapabilities = options.clientCapabilities;
    this.roots = options.roots;
    this.debounceMs = options.debounceMs ?? TIMEOUTS_MS.continuationDebounce;
    this.maxRounds = options.maxRounds ?? MAX_INPUT_ROUNDS;
  }

  // --- the upstream call -----------------------------------------------------------------------------------------

  /** Attaches the SDK request promise; the scope follows its settlement. */
  attach(call: Promise<unknown>): this {
    call.then(
      (value) => this.settle({ ok: true, value }),
      (error: unknown) => this.settle({ ok: false, error }),
    );
    return this;
  }

  private settle(outcome: { ok: true; value: unknown } | { ok: false; error: unknown }): void {
    this.settled = outcome;
    this.clearCallTimer();
    this.clearDebounce();
    this.unbind();
    for (const hook of this.settledHooks.splice(0)) hook();
    this.wake?.();
  }

  /** Runs once when the upstream call settles. */
  onSettled(hook: () => void): void {
    if (this.settled) hook();
    else this.settledHooks.push(hook);
  }

  get done(): boolean {
    return this.settled !== undefined;
  }

  /** Links the downstream request's signal for as long as that request is waiting (it is released at `input_required`). */
  bind(signal: AbortSignal | undefined): void {
    this.unbind();
    if (!signal) return;
    const onAbort = (): void => this.abort.abort(signal.reason);
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    this.unbindSignal = () => signal.removeEventListener('abort', onAbort);
  }

  unbind(): void {
    this.unbindSignal?.();
    this.unbindSignal = undefined;
  }

  // --- timeout that pauses while the user is being asked ---------------------------------------------------------

  /** The upstream timeout; paused while server requests are outstanding, reset by progress (6.4). */
  armTimeout(ms: number): void {
    this.timeoutMs = ms;
    this.pausedRemaining = undefined;
    this.startCallTimer(ms);
  }

  /** Progress arrived: reset the timeout (`resetTimeoutOnProgress`). */
  touch(): void {
    if (this.timeoutMs === 0 || this.pausedRemaining !== undefined || this.settled) return;
    this.startCallTimer(this.timeoutMs);
  }

  private startCallTimer(ms: number): void {
    this.clearCallTimer();
    this.timeoutDeadline = Date.now() + ms;
    this.callTimer = setTimeout(() => {
      this.abort.abort(
        new SdkError(SdkErrorCode.RequestTimeout, `Request timed out after ${this.timeoutMs} ms`),
      );
    }, ms);
    this.callTimer.unref?.();
  }

  private clearCallTimer(): void {
    if (this.callTimer) clearTimeout(this.callTimer);
    this.callTimer = undefined;
  }

  private get outstanding(): number {
    return this.waiting.length + this.frozen.length;
  }

  private pauseTimeout(): void {
    if (this.timeoutMs === 0 || this.pausedRemaining !== undefined || !this.callTimer) return;
    this.pausedRemaining = Math.max(1, this.timeoutDeadline - Date.now());
    this.clearCallTimer();
  }

  private resumeTimeout(): void {
    if (this.pausedRemaining === undefined || this.outstanding > 0 || this.settled) return;
    const remaining = this.pausedRemaining;
    this.pausedRemaining = undefined;
    this.startCallTimer(remaining);
  }

  // --- server-to-client requests ----------------------------------------------------------------------------------

  /** Called by the SDK handler for `elicitation/create`, `sampling/createMessage` and `roots/list`. */
  handleServerRequest(kind: ServerRequestKind, params: unknown): Promise<unknown> {
    if (!clientSupports(this.clientCapabilities, kind, params)) {
      try {
        return Promise.resolve(answerMissingCapability(kind, this.roots));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (this.expired) {
      try {
        return Promise.resolve(answerExpired(kind));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    return new Promise((resolve, reject) => {
      this.waiting.push({ kind, params, resolve, reject });
      this.pauseTimeout();
      if (this.frozen.length === 0) this.startDebounce();
    });
  }

  private startDebounce(): void {
    if (this.debounceTimer || this.batchReady) return;
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.batchReady = true;
      this.wake?.();
    }, this.debounceMs);
    this.debounceTimer.unref?.();
  }

  private clearDebounce(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
  }

  /**
   * Resolves with the call's result, or with the next batch of server requests once the 25 ms debounce
   * passed. Rejects with the call's error.
   */
  next(): Promise<ScopeEvent> {
    return new Promise((resolve, reject) => {
      const check = (): boolean => {
        if (this.settled) {
          if (this.settled.ok) resolve({ type: 'done', result: this.settled.value });
          else reject(this.settled.error);
          return true;
        }
        if (this.batchReady && this.waiting.length > 0 && this.frozen.length === 0) {
          this.rounds += 1;
          if (this.rounds > this.maxRounds) {
            // The cap of 6.5: nothing more reaches the client; the upstream gets cancellations.
            this.cancelWaiting();
            this.batchReady = false;
            return false;
          }
          this.frozen = this.waiting;
          this.waiting = [];
          this.batchReady = false;
          const batch: BatchEntry[] = this.frozen.map((p) => ({ kind: p.kind, params: p.params }));
          resolve({ type: 'requests', inputRequests: toInputRequests(batch) });
          return true;
        }
        return false;
      };
      if (check()) return;
      this.wake = () => {
        if (check()) this.wake = undefined;
      };
    });
  }

  private cancelWaiting(): void {
    const dropped = this.waiting;
    this.waiting = [];
    for (const p of dropped) this.answer(p, undefined, true);
    this.resumeTimeout();
  }

  private answer(pending: Pending, response: unknown, expire = false): void {
    try {
      if (expire) {
        pending.resolve(answerExpired(pending.kind));
        return;
      }
      const error = asErrorResponse(response);
      if (error) pending.reject(new ProtocolError(error.code, error.message));
      else if (response === undefined) pending.resolve(answerExpired(pending.kind));
      else pending.resolve(response);
    } catch (thrown) {
      pending.reject(thrown);
    }
  }

  /** The `inputResponses` of the retry: resolves the handler promises so the upstream call continues. */
  resume(responses: Record<string, unknown>, clientCapabilities?: ClientCapabilitiesLike): void {
    if (clientCapabilities) this.clientCapabilities = clientCapabilities;
    const batch = this.frozen;
    this.frozen = [];
    for (const [index, pending] of batch.entries()) this.answer(pending, responses[`b${index}`]);
    // Requests that arrived after the freeze start the next batch.
    if (this.waiting.length > 0) this.startDebounce();
    else this.resumeTimeout();
  }

  /** Keys of the batch that is waiting for answers. */
  get pendingKeys(): string[] {
    return this.frozen.map((_, index) => `b${index}`);
  }

  get hasPending(): boolean {
    return this.frozen.length > 0;
  }

  /** TTL expiry (6.5): pending elicitations get `cancel`, sampling and roots `-32603`; the call may finish or time out. */
  expire(): void {
    this.expired = true;
    const all = [...this.frozen, ...this.waiting];
    this.frozen = [];
    this.waiting = [];
    this.clearDebounce();
    for (const p of all) this.answer(p, undefined, true);
    this.resumeTimeout();
  }

  /** Drops everything (connection closed): outstanding handlers are cancelled. */
  dispose(): void {
    this.expire();
    this.clearCallTimer();
    this.unbind();
    if (!this.abort.signal.aborted) {
      this.abort.abort(
        new SdkError(SdkErrorCode.ConnectionClosed, 'the upstream connection closed'),
      );
    }
  }
}
