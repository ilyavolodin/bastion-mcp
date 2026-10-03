import { describe, expect, it } from 'vitest';
import { parseConfigMessage, watchConfig } from '../src/adapters/config-watch';
import { fakeInfra, recordingLogger } from './fake-infra';

describe('4.3 parseConfigMessage', () => {
  it('reads a topic-only message from API writes', () => {
    expect(parseConfigMessage('{"topic":"signing_keys"}')).toEqual({ topic: 'signing_keys' });
  });

  it('reads a repository message and stringifies a numeric version', () => {
    expect(parseConfigMessage('{"scope":"org","id":"x","version":7}')).toEqual({
      scope: 'org',
      id: 'x',
      version: '7',
    });
    expect(parseConfigMessage('{"scope":"org","version":"9"}')).toEqual({
      scope: 'org',
      version: '9',
    });
  });

  it('returns undefined for garbage and wrongly typed fields', () => {
    expect(parseConfigMessage('not json')).toBeUndefined();
    expect(parseConfigMessage('{"topic":5}')).toBeUndefined();
    expect(parseConfigMessage('[]')).toBeUndefined();
  });
});

describe('4.3 watchConfig', () => {
  const harness = () => {
    let listener: ((raw: string) => void) | undefined;
    let channel: string | undefined;
    let unsubscribed = false;
    const logger = recordingLogger();
    const infra = fakeInfra({
      logger,
      pubsub: {
        subscribe: (c: string, l: (raw: string) => void) => {
          channel = c;
          listener = l;
          return () => {
            unsubscribed = true;
          };
        },
      },
    });
    return {
      infra,
      logger,
      emit: (raw: string) => listener?.(raw),
      channel: () => channel,
      unsubscribed: () => unsubscribed,
    };
  };

  it('delivers parsed events and ignores unreadable ones', () => {
    const h = harness();
    const seen: unknown[] = [];
    watchConfig(h.infra, (e) => seen.push(e));
    h.emit('{"topic":"keys"}');
    h.emit('garbage');
    expect(h.channel()).toBe('bastion:config');
    expect(seen).toEqual([{ topic: 'keys' }]);
  });

  it('logs and swallows a throwing handler', () => {
    const h = harness();
    watchConfig(h.infra, () => {
      throw new Error('handler broke');
    });
    expect(() => h.emit('{"topic":"keys"}')).not.toThrow();
    expect(h.logger.calls.warn).toEqual([
      { fields: { err: 'handler broke' }, message: 'config handler failed' },
    ]);
  });

  it('returns the unsubscribe function', () => {
    const h = harness();
    watchConfig(h.infra, () => undefined)();
    expect(h.unsubscribed()).toBe(true);
  });
});
