import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COMPARE_AND_DELETE, COMPARE_AND_PEXPIRE, DECR_FLOOR } from '../src/ownership/lua';

const file = (name: string): string =>
  readFileSync(new URL(`../lua/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('21.2 lease Lua scripts', () => {
  it('21.2 the TS constants equal the files under lua/', () => {
    expect(COMPARE_AND_DELETE).toBe(file('compare-and-delete.lua'));
    expect(COMPARE_AND_PEXPIRE).toBe(file('compare-and-pexpire.lua'));
    expect(DECR_FLOOR).toBe(file('decr-floor.lua'));
  });

  it('21.2 renewal is a compare-and-PEXPIRE, deletion a compare-and-delete', () => {
    expect(COMPARE_AND_PEXPIRE).toContain("redis.call('pexpire'");
    expect(COMPARE_AND_PEXPIRE).toContain("redis.call('get', KEYS[1]) == ARGV[1]");
    expect(COMPARE_AND_DELETE).toContain("redis.call('del'");
  });
});
