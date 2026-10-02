import { decodeListCursor, encodeListCursor } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import {
  capList,
  chooseListSource,
  computeConfigHash,
  diffSnapshots,
  listMeta,
  listResult,
  mergedTtlMs,
  paginateList,
} from '../src/listing';
import type { EffectiveEndpoint } from '../src/types';
import { items, tool } from './helpers';

describe('7.5 pagination', () => {
  const all = Array.from({ length: 25 }, (_, i) => i);

  it('7.5 serves pages with bcur1 cursors and stops at the end', () => {
    const p1 = paginateList(all, { pageSize: 10, endpointHash: 'h' });
    expect(p1.items).toHaveLength(10);
    expect(p1.nextCursor?.startsWith('bcur1.')).toBe(true);
    const p2 = paginateList(all, { pageSize: 10, endpointHash: 'h', cursor: p1.nextCursor });
    expect(p2.items[0]).toBe(10);
    const p3 = paginateList(all, { pageSize: 10, endpointHash: 'h', cursor: p2.nextCursor });
    expect(p3.items).toHaveLength(5);
    expect(p3.nextCursor).toBeUndefined();
  });

  it('7.5 a cursor from an older endpoint hash restarts at offset 0', () => {
    const stale = encodeListCursor({ offset: 10, endpointHash: 'old' });
    expect(paginateList(all, { pageSize: 10, endpointHash: 'new', cursor: stale }).items[0]).toBe(
      0,
    );
    expect(decodeListCursor(stale, 'old')).toBe(10);
  });

  it('7.5 the default page size is 1,000', () => {
    const big = Array.from({ length: 1500 }, (_, i) => i);
    expect(paginateList(big, { endpointHash: 'h' }).items).toHaveLength(1000);
  });

  it('7.5 caps one installation at 10,000 items', () => {
    const r = capList(Array.from({ length: 10_050 }, (_, i) => i));
    expect(r.items).toHaveLength(10_000);
    expect(r.truncated).toBe(true);
    expect(capList([1]).truncated).toBe(false);
  });
});

describe('6.7 list results', () => {
  it('6.7 ttlMs is the minimum upstream ttlMs (default 60,000) and the scope is private', () => {
    expect(mergedTtlMs([])).toBe(60_000);
    expect(mergedTtlMs([undefined, 5000, 9000])).toBe(5000);
    const endpoint = {
      tools: [tool('a')],
      prompts: [],
      resources: [],
      resourceTemplates: [],
      hash: 'h',
      ttlMs: 5000,
      cacheScope: 'private',
      degraded: [{ installation: 'x', code: 'timeout' }],
      needsAuth: [{ installation: 'y' }],
    } as unknown as EffectiveEndpoint;
    const r = listResult(endpoint, 'tool');
    expect(r).toMatchObject({ ttlMs: 5000, cacheScope: 'private' });
    expect(r.tools).toHaveLength(1);
    expect(r._meta).toEqual({
      'io.github.bastion-mcp/degraded': [{ installation: 'x', code: 'timeout' }],
      'io.github.bastion-mcp/needsAuth': [{ installation: 'y' }],
    });
    expect(listMeta({ degraded: [], needsAuth: [] })).toEqual({});
    expect(
      listResult({ ...endpoint, degraded: [], needsAuth: [] }, 'prompt')._meta,
    ).toBeUndefined();
  });

  it('6.7 pages carry nextCursor', () => {
    const endpoint = {
      tools: [tool('a'), tool('b')],
      hash: 'h',
      ttlMs: 1,
      cacheScope: 'private',
      degraded: [],
      needsAuth: [],
    } as unknown as EffectiveEndpoint;
    expect(listResult(endpoint, 'tool', { pageSize: 1 }).nextCursor).toBeDefined();
  });
});

describe('7.5 snapshots', () => {
  const none = { cache: false, instanceRunning: false, snapshot: false, referenceSnapshot: false };

  it('7.5 prefers cache, then the live instance, then a snapshot', () => {
    expect(chooseListSource({ ...none, cache: true, snapshot: true })).toEqual({ source: 'cache' });
    expect(chooseListSource({ ...none, instanceRunning: true, snapshot: true })).toEqual({
      source: 'live',
    });
    expect(chooseListSource({ ...none, snapshot: true })).toEqual({ source: 'snapshot' });
  });

  it('7.5 listing never starts a sandbox when a snapshot exists; the reference snapshot seeds new installations', () => {
    expect(chooseListSource({ ...none, snapshot: true }).source).not.toBe('start');
    expect(chooseListSource({ ...none, referenceSnapshot: true })).toEqual({ source: 'reference' });
  });

  it('7.5 with no snapshot at all it starts the instance and waits up to 20 s, then degrades', () => {
    expect(chooseListSource(none)).toEqual({
      source: 'start',
      waitMs: 20_000,
      onTimeout: 'degraded',
    });
  });

  it('7.5 configHash covers catalog version, arguments and non-secret variables', () => {
    const a = computeConfigHash({
      catalogVersionId: 'v1',
      arguments: ['-x'],
      variables: { a: 1, b: 2 },
    });
    expect(a).toBe(
      computeConfigHash({ catalogVersionId: 'v1', arguments: ['-x'], variables: { b: 2, a: 1 } }),
    );
    expect(a).not.toBe(
      computeConfigHash({ catalogVersionId: 'v2', arguments: ['-x'], variables: { a: 1, b: 2 } }),
    );
    expect(a).not.toBe(computeConfigHash({ catalogVersionId: 'v1', variables: { a: 1, b: 2 } }));
    expect(computeConfigHash({ catalogVersionId: 'v1' })).toHaveLength(64);
  });

  it('7.5 emits list_changed only when a list differs, ignoring order', () => {
    const prev = items({ tools: [tool('a'), tool('b')] });
    expect(diffSnapshots(prev, items({ tools: [tool('b'), tool('a')] })).changed).toBe(false);
    const d = diffSnapshots(prev, items({ tools: [tool('a'), tool('b', { description: 'new' })] }));
    expect(d).toMatchObject({ changed: true, tool: true, prompt: false });
  });

  it('7.5 a first list after a degraded start counts as changed', () => {
    expect(diffSnapshots(undefined, items({ tools: [tool('a')] })).changed).toBe(true);
    expect(diffSnapshots(undefined, items()).changed).toBe(false);
  });
});
