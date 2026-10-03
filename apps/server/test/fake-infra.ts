import type { Clock } from '@bastion-mcp/core';
import type { Infra } from '../src/infra';

/** A clock the test moves by hand. */
export const manualClock = (start = 1_700_000_000_000): Clock & { advance(ms: number): void } => {
  let t = start;
  return {
    now: () => t,
    advance(ms) {
      t += ms;
    },
  };
};

export type LogCall = { fields: unknown; message: string | undefined };

/** A pino-shaped logger that records its calls. */
export const recordingLogger = () => {
  const calls: Record<'debug' | 'info' | 'warn' | 'error', LogCall[]> = {
    debug: [],
    info: [],
    warn: [],
    error: [],
  };
  const at =
    (level: keyof typeof calls) =>
    (fields: unknown, message?: string): void => {
      calls[level].push({ fields, message });
    };
  return {
    calls,
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
  };
};

/**
 * An `Infra` made of whatever the code under test touches. Everything else is absent, so an unexpected access
 * fails loudly instead of silently doing nothing.
 */
export const fakeInfra = (parts: object): Infra => parts as Infra;
