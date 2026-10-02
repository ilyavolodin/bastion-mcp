import { META_KEYS, PROTOCOL_VERSIONS } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { buildEndpoint, installation, items, opContext } from './helpers/fixtures';
import { makeOps } from './helpers/ops';

const world = async (many = 1) => {
  const installs = Array.from({ length: many }, (_, i) => installation(`srv-${i}`));
  const itemMap = Object.fromEntries(
    installs.map((inst, i) => [
      inst.id,
      items({
        tools: [
          { name: `tool${i}`, description: 'd', inputSchema: { type: 'object' } },
          { name: 'alpha', description: 'd', inputSchema: { type: 'object' } },
        ],
        ttlMs: i === 0 ? 30_000 : 90_000,
        instructions: `instructions of srv-${i}`,
      }),
    ]),
  );
  const resolved = await buildEndpoint({ installations: installs, items: itemMap });
  return { resolved, installs, ops: makeOps() };
};

describe('6.3 operations answered by Bastion', () => {
  it('6.3 initialize answers with the endpoint capabilities, serverInfo and merged instructions', async () => {
    const { resolved, ops } = await world();
    const out = await ops.run(
      'initialize',
      { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
      opContext(resolved, { era: 'legacy', protocolVersion: '2025-06-18' }),
    );
    expect(out.kind).toBe('complete');
    const result = (out as { result: Record<string, unknown> }).result;
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities).toMatchObject({
      tools: { listChanged: true },
      prompts: { listChanged: true },
      resources: { listChanged: true },
      logging: {},
    });
    expect(result.serverInfo).toMatchObject({ name: 'bastion', version: '1.2.3' });
    expect(String(result.instructions)).toContain('## srv-0');
  });

  it('6.1 initialize negotiates an unsupported version down to the latest legacy revision', async () => {
    const { resolved, ops } = await world();
    const out = await ops.run(
      'initialize',
      { protocolVersion: '2099-01-01', capabilities: {}, clientInfo: { name: 'c', version: '1' } },
      opContext(resolved, { era: 'legacy' }),
    );
    expect((out as { result: { protocolVersion: string } }).result.protocolVersion).toBe(
      PROTOCOL_VERSIONS.legacy[0],
    );
  });

  it('6.3 initialize rejects missing fields with -32602', async () => {
    const { resolved, ops } = await world();
    await expect(
      ops.run('initialize', { capabilities: {} }, opContext(resolved, { era: 'legacy' })),
    ).rejects.toMatchObject({ mcpCode: -32602 });
  });

  it('6.3 server/discover lists only the modern revision with capabilities and instructions', async () => {
    const { resolved, ops } = await world();
    const out = await ops.run('server/discover', {}, opContext(resolved));
    const result = (out as { result: Record<string, unknown> }).result;
    expect(result.supportedVersions).toEqual(['2026-07-28']);
    expect(result.ttlMs).toBe(resolved.endpoint.ttlMs);
    expect(result.cacheScope).toBe('private');
    expect(result.capabilities).toMatchObject({ tools: { listChanged: true } });
    expect(result.capabilities).not.toHaveProperty('logging');
  });

  it('6.8 server/discover declares the Tasks extension only when the request declares it', async () => {
    const { resolved, ops } = await world();
    const without = await ops.run('server/discover', {}, opContext(resolved));
    expect(
      (without as { result: { capabilities: object } }).result.capabilities,
    ).not.toHaveProperty('extensions');
    const withTasks = await ops.run(
      'server/discover',
      {},
      opContext(resolved, {
        clientCapabilities: { extensions: { 'io.modelcontextprotocol/tasks': {} } },
      }),
    );
    expect(
      (withTasks as { result: { capabilities: { extensions: object } } }).result.capabilities
        .extensions,
    ).toHaveProperty('io.modelcontextprotocol/tasks');
  });

  it('6.3 ping is answered locally and never forwarded', async () => {
    const { resolved, ops } = await world();
    const out = await ops.run('ping', {}, opContext(resolved, { era: 'legacy' }));
    expect(out).toEqual({ kind: 'complete', result: {} });
    expect(ops.upstream.calls).toHaveLength(0);
  });

  it('6.3 notifications/initialized is accepted', async () => {
    const { resolved, ops } = await world();
    expect(
      await ops.run('notifications/initialized', {}, opContext(resolved, { era: 'legacy' })),
    ).toEqual({
      kind: 'complete',
      result: {},
    });
  });
});

describe('6.3 6.7 list operations', () => {
  it('6.7 tools/list is sorted by final name and carries ttlMs (minimum of the merged results) and private scope', async () => {
    const { resolved, ops } = await world(2);
    const out = await ops.run('tools/list', {}, opContext(resolved));
    const result = (
      out as { result: { tools: { name: string }[]; ttlMs: number; cacheScope: string } }
    ).result;
    const names = result.tools.map((t) => t.name);
    expect(names).toEqual([...names].sort());
    expect(names).toContain('srv_0__alpha');
    expect(result.ttlMs).toBe(30_000);
    expect(result.cacheScope).toBe('private');
  });

  it('7.5 paginates with bcur1. cursors and an older endpoint hash restarts at the first page', async () => {
    const { resolved } = await world(3);
    const ops = makeOps({ settings: { listPageSize: 2 } });
    const first = await ops.run('tools/list', {}, opContext(resolved));
    const r1 = (first as { result: { tools: unknown[]; nextCursor?: string } }).result;
    expect(r1.tools).toHaveLength(2);
    expect(r1.nextCursor?.startsWith('bcur1.')).toBe(true);
    const second = await ops.run('tools/list', { cursor: r1.nextCursor }, opContext(resolved));
    expect((second as { result: { tools: unknown[] } }).result.tools).toHaveLength(2);
    const stale = await ops.run(
      'tools/list',
      { cursor: `bcur1.${Buffer.from('{"offset":2,"endpointHash":"old"}').toString('base64url')}` },
      opContext(resolved),
    );
    expect((stale as { result: { tools: { name: string }[] } }).result.tools[0]?.name).toBe(
      (first as { result: { tools: { name: string }[] } }).result.tools[0]?.name,
    );
  });

  it('6.3 prompts/list, resources/list and resources/templates/list serve the merged items', async () => {
    const { resolved, ops } = await world();
    const prompts = await ops.run('prompts/list', {}, opContext(resolved));
    expect((prompts as { result: { prompts: { name: string }[] } }).result.prompts[0]?.name).toBe(
      'srv_0__greet',
    );
    const resources = await ops.run('resources/list', {}, opContext(resolved));
    expect(
      (resources as { result: { resources: { uri: string }[] } }).result.resources[0]?.uri,
    ).toBe('test://static');
    const templates = await ops.run('resources/templates/list', {}, opContext(resolved));
    expect(
      (templates as { result: { resourceTemplates: { uriTemplate: string }[] } }).result
        .resourceTemplates[0]?.uriTemplate,
    ).toBe('test://items/{id}');
  });

  it('7.5 a failing installation is skipped and reported in _meta degraded; the list does not fail', async () => {
    const good = installation('good');
    const bad = installation('bad');
    const resolved = await buildEndpoint({
      installations: [good, bad],
      items: { [good.id]: items(), [bad.id]: { status: 'degraded', code: 'upstream_timeout' } },
    });
    const ops = makeOps();
    const out = await ops.run('tools/list', {}, opContext(resolved));
    const result = (out as { result: { tools: unknown[]; _meta: Record<string, unknown> } }).result;
    expect(result.tools.length).toBeGreaterThan(0);
    expect(result._meta[META_KEYS.degraded]).toEqual([
      { installation: bad.slug, code: 'upstream_timeout' },
    ]);
  });

  it('6.3 a cursor that is not a string is -32602', async () => {
    const { resolved, ops } = await world();
    await expect(ops.run('tools/list', { cursor: 5 }, opContext(resolved))).rejects.toMatchObject({
      mcpCode: -32602,
    });
  });
});

describe('6.3 unknown methods', () => {
  it('6.3 aggregate endpoints answer -32601 for an unknown method', async () => {
    const { resolved, ops } = await world();
    await expect(ops.run('acme/frobnicate', {}, opContext(resolved))).rejects.toMatchObject({
      mcpCode: -32601,
    });
  });

  it('6.3 6.8 single-installation endpoints forward an unknown method verbatim', async () => {
    const inst = installation('solo');
    const resolved = await buildEndpoint({
      installations: [inst],
      items: { [inst.id]: items() },
      endpoint: {
        id: `i:${inst.id}`,
        kind: 'installation',
        installationIds: [inst.id],
        prefixMode: 'onCollision',
      },
    });
    const ops = makeOps();
    ops.upstream.script = () => ({ kind: 'complete', result: { hello: 'world' } });
    const out = await ops.run('acme/frobnicate', { a: 1 }, opContext(resolved));
    expect(out).toEqual({ kind: 'complete', result: { hello: 'world' } });
    expect(ops.upstream.calls[0]).toMatchObject({
      installationId: inst.id,
      method: 'acme/frobnicate',
      params: { a: 1 },
    });
  });

  it('6.3 unknown notifications are never forwarded', async () => {
    const inst = installation('solo');
    const resolved = await buildEndpoint({
      installations: [inst],
      items: { [inst.id]: items() },
      endpoint: {
        id: `i:${inst.id}`,
        kind: 'installation',
        installationIds: [inst.id],
        prefixMode: 'onCollision',
      },
    });
    const ops = makeOps();
    await expect(ops.run('notifications/acme', {}, opContext(resolved))).rejects.toMatchObject({
      mcpCode: -32601,
    });
  });
});
