import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRegistryClient, parseRegistryEntry, serverJsonToSpec } from '../src';
import { type FakeRegistry, startFakeRegistry } from './fake-registry';

/** A trimmed copy of a REAL `GET https://registry.modelcontextprotocol.io/v0.1/servers?limit=100` response. */
const real = JSON.parse(
  readFileSync(new URL('./fixtures/real-v0.1-servers.json', import.meta.url), 'utf8'),
) as { servers: unknown[] };

let fake: FakeRegistry;
beforeAll(async () => {
  fake = await startFakeRegistry();
});
afterAll(async () => {
  await fake.close();
});

describe('11.6 the real registry v0.1 payload', () => {
  it('accepts every element of the recorded real response (empty repository, packages without version, deprecated)', () => {
    for (const raw of real.servers) expect(() => parseRegistryEntry(raw)).not.toThrow();
    const entries = real.servers.map((raw) => parseRegistryEntry(raw));
    expect(entries.some((e) => e.status === 'deprecated')).toBe(true);
    expect(entries.some((e) => e.serverJson.repository && !e.serverJson.repository.url)).toBe(true);
    expect(entries.some((e) => e.serverJson.packages?.some((p) => p.version === undefined))).toBe(
      true,
    );
    expect(entries.every((e) => e.serverJson.$schema?.includes('server.schema.json'))).toBe(true);
  });

  it('accepts the quirks seen in the full real registry (unknown registry types, argument kinds, empty names)', () => {
    const quirky = {
      server: {
        name: 'io.example/quirky',
        description: 'x',
        version: '1.0.0',
        remotes: [
          { type: 'streamable-http', url: 'https://x.example/mcp', headers: [{ name: '' }] },
        ],
        packages: [
          {
            registryType: 'maven',
            identifier: 'io.example:x',
            version: '1',
            transport: { type: 'stdio' },
            runtimeArguments: [{ type: 'flag', value: '-jar' }],
          },
        ],
      },
    };
    const entry = parseRegistryEntry(quirky);
    expect(entry.serverJson.packages?.[0]?.registryType).toBe('maven');
    expect(serverJsonToSpec(entry.serverJson)).toMatchObject({ installable: true });
  });

  it('retries a stalled or failing page when retries are configured', async () => {
    fake.setEntries(real.servers);
    fake.failNext(503);
    const client = createRegistryClient({
      baseUrl: fake.baseUrl,
      retries: 2,
      retryDelayMs: 1,
    });
    const page = await client.listServersPage();
    expect(page.invalid).toBe(0);
    expect(page.entries).toHaveLength(real.servers.length);
  });
});

/** Live network check against the official registry; skipped offline. */
const probe = (): Promise<boolean> =>
  fetch('https://registry.modelcontextprotocol.io/v0.1/servers?limit=1', {
    signal: AbortSignal.timeout(15_000),
  })
    .then((r) => r.ok)
    .catch(() => false);
const online = (await probe()) || (await probe());

describe.skipIf(!online)('network: registry.modelcontextprotocol.io', () => {
  it('network: the first live pages parse without invalid entries', async () => {
    const client = createRegistryClient({
      baseUrl: 'https://registry.modelcontextprotocol.io',
      retries: 3,
      timeoutMs: 20_000,
    });
    let pages = 0;
    let fetched = 0;
    for await (const page of client.listServers({ limit: 100 })) {
      expect(page.invalid).toBe(0);
      fetched += page.entries.length;
      pages += 1;
      if (pages >= 3) break;
    }
    expect(fetched).toBeGreaterThan(100);
  }, 90_000);
});
