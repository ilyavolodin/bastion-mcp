import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertRegistryBaseUrl,
  createClientForSource,
  createRegistryClient,
  encodeRegistryName,
  RegistryInvalidResponseError,
  RegistryNotFoundError,
  RegistryUnavailableError,
  RegistryUrlDeniedError,
} from '../src';
import { type FakeRegistry, startFakeRegistry } from './fake-registry';
import * as fx from './fixtures/server-json';

let fake: FakeRegistry;
beforeAll(async () => {
  fake = await startFakeRegistry();
});
afterAll(async () => {
  await fake.close();
});

const many = (n: number) =>
  Array.from({ length: n }, (_, i) =>
    fx.entryOf({ ...fx.deprecatedServer, name: `io.github.bulk/server-${i}`, version: '1.0.0' }),
  );

beforeEach(() => {
  fake.requests.length = 0;
  fake.setDelay(0);
  fake.setEntries([]);
});

describe('11.6 registry client', () => {
  it('11.6 lists with limit=100 and updated_since, following metadata.nextCursor', async () => {
    fake.setEntries(many(250));
    const client = createRegistryClient({ baseUrl: fake.baseUrl });
    const pages: number[] = [];
    for await (const page of client.listServers({
      limit: 100,
      updatedSince: new Date('2026-01-01T00:00:00Z'),
    })) {
      pages.push(page.entries.length);
    }
    expect(pages).toEqual([100, 100, 50]);
    expect(fake.requests).toHaveLength(3);
    const first = new URL(fake.requests[0]?.url ?? '', 'http://x');
    expect(first.pathname).toBe('/v0.1/servers');
    expect(first.searchParams.get('limit')).toBe('100');
    expect(first.searchParams.get('updated_since')).toBe('2026-01-01T00:00:00.000Z');
    expect(new URL(fake.requests[1]?.url ?? '', 'http://x').searchParams.get('cursor')).toBe('100');
  });

  it('11.6 flattens status, publishedAt and isLatest from _meta', async () => {
    fake.setEntries([fx.entryOf(fx.deprecatedServer, 'deprecated', { isLatest: false })]);
    const client = createRegistryClient({ baseUrl: fake.baseUrl });
    const page = await client.listServersPage();
    expect(page.entries[0]).toMatchObject({
      name: 'io.github.legacy/old-notes',
      status: 'deprecated',
      isLatest: false,
    });
    expect(page.entries[0]?.publishedAt?.toISOString()).toBe('2025-12-20T10:00:00.000Z');
  });

  it('11.6 skips list elements that fail validation and counts them', async () => {
    fake.setEntries([fx.entryOf(fx.deprecatedServer), { server: { nope: true } }]);
    const page = await createRegistryClient({ baseUrl: fake.baseUrl }).listServersPage();
    expect(page.entries).toHaveLength(1);
    expect(page.invalid).toBe(1);
  });

  it('11.6 URL-encodes the server name in path parameters', async () => {
    fake.setEntries([fx.entryOf(fx.npmStdioSecrets)]);
    const client = createRegistryClient({ baseUrl: fake.baseUrl });
    const versions = await client.getVersions('io.github.acme/github-tools');
    expect(fake.requests[0]?.url).toBe('/v0.1/servers/io.github.acme%2Fgithub-tools/versions');
    expect(versions).toHaveLength(1);
    const one = await client.getVersion('io.github.acme/github-tools', '2.4.1');
    expect(fake.requests[1]?.url).toBe(
      '/v0.1/servers/io.github.acme%2Fgithub-tools/versions/2.4.1',
    );
    expect(one.version).toBe('2.4.1');
    expect(encodeRegistryName('io.github.acme/server')).toBe('io.github.acme%2Fserver');
  });

  it('11.6 maps 404 to RegistryNotFoundError', async () => {
    const client = createRegistryClient({ baseUrl: fake.baseUrl });
    await expect(client.getVersion('io.github.none/x', '1.0.0')).rejects.toBeInstanceOf(
      RegistryNotFoundError,
    );
  });

  it('11.6 sends the optional auth header', async () => {
    const client = createRegistryClient({
      baseUrl: fake.baseUrl,
      authHeader: { name: 'Authorization', value: 'Bearer s3cret' },
    });
    await client.listServersPage();
    expect(fake.requests[0]?.headers.authorization).toBe('Bearer s3cret');
  });

  it('11.6 resolves the auth secret of a source and adds a Bearer scheme to a bare token', async () => {
    const secrets = { resolve: async () => 'tok' };
    const client = await createClientForSource(
      { baseUrl: fake.baseUrl, authSecretId: 's1' },
      { secrets },
    );
    await client.listServersPage();
    expect(fake.requests[0]?.headers.authorization).toBe('Bearer tok');

    const custom = await createClientForSource(
      { baseUrl: fake.baseUrl, authSecretId: 's1', authHeaderName: 'X-Api-Key' },
      { secrets },
    );
    await custom.listServersPage();
    expect(fake.requests[1]?.headers['x-api-key']).toBe('tok');
  });

  it('11.6 a missing auth secret is reported as registry unavailable', async () => {
    await expect(
      createClientForSource(
        { baseUrl: fake.baseUrl, authSecretId: 'gone' },
        { secrets: { resolve: async () => undefined } },
      ),
    ).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it('21.3 an HTTP error status is RegistryUnavailableError with the status', async () => {
    fake.failNext(503);
    await expect(
      createRegistryClient({ baseUrl: fake.baseUrl }).listServersPage(),
    ).rejects.toMatchObject({
      code: 'registry_unavailable',
      data: { status: 503 },
    });
  });

  it('5.4 every call has a timeout', async () => {
    fake.setDelay(300);
    const client = createRegistryClient({ baseUrl: fake.baseUrl, timeoutMs: 50 });
    await expect(client.listServersPage()).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it('5.4 the caller can abort a call with an AbortSignal', async () => {
    fake.setDelay(300);
    const controller = new AbortController();
    const client = createRegistryClient({ baseUrl: fake.baseUrl });
    const call = client.listServersPage({ signal: controller.signal });
    controller.abort();
    await expect(call).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it('11.6 invalid JSON and wrong envelopes are RegistryInvalidResponseError', async () => {
    const client = createRegistryClient({ baseUrl: fake.baseUrl });
    fake.rawNext('not json');
    await expect(client.listServersPage()).rejects.toBeInstanceOf(RegistryInvalidResponseError);
    fake.rawNext('{"servers": "no"}');
    await expect(client.listServersPage()).rejects.toBeInstanceOf(RegistryInvalidResponseError);
    fake.rawNext('{"unexpected": true}');
    await expect(client.getVersion('io.github.a/b', '1.0.0')).rejects.toBeInstanceOf(
      RegistryInvalidResponseError,
    );
  });

  it('11.6 a repeating cursor stops the walk', async () => {
    const client = createRegistryClient({ baseUrl: fake.baseUrl });
    const loop = JSON.stringify({ servers: [], metadata: { nextCursor: 'same' } });
    fake.rawNext(loop);
    fake.rawNext(loop);
    fake.rawNext(loop);
    const walk = async () => {
      for await (const _page of client.listServers()) {
        // drain
      }
    };
    await expect(walk()).rejects.toBeInstanceOf(RegistryInvalidResponseError);
  });

  it('8.8 redirects are not followed', async () => {
    const redirecting = createRegistryClient({
      baseUrl: fake.baseUrl,
      fetch: async (_url, init) => {
        expect(init?.redirect).toBe('error');
        throw new TypeError('redirect mode is set to error');
      },
    });
    await expect(redirecting.listServersPage()).rejects.toBeInstanceOf(RegistryUnavailableError);
  });
});

describe('8.8 registry base URL guard', () => {
  const resolveTo = (...addresses: string[]) => ({ resolveHost: async () => addresses });

  it('8.8 accepts a public https host and strips a trailing slash', async () => {
    await expect(
      assertRegistryBaseUrl('https://registry.modelcontextprotocol.io/', resolveTo('34.120.1.1')),
    ).resolves.toBe('https://registry.modelcontextprotocol.io');
  });

  it.each([
    ['not a url', 'not a url'],
    ['ftp scheme', 'ftp://example.com'],
    ['credentials', 'https://user:pw@example.com'],
    ['query string', 'https://example.com/?a=1'],
    ['loopback literal', 'https://127.0.0.1/'],
    ['metadata literal', 'https://169.254.169.254/'],
    ['decimal-encoded loopback', 'https://2130706433/'],
    ['IPv6 loopback', 'https://[::1]/'],
    ['plain http to a public host', 'http://93.184.216.34/'],
  ])('8.8 refuses %s', async (_label, url) => {
    await expect(assertRegistryBaseUrl(url, resolveTo('93.184.216.34'))).rejects.toBeInstanceOf(
      RegistryUrlDeniedError,
    );
  });

  it('8.8 refuses a hostname that resolves to a private address', async () => {
    await expect(
      assertRegistryBaseUrl('https://registry.corp.example', resolveTo('10.1.2.3')),
    ).rejects.toBeInstanceOf(RegistryUrlDeniedError);
  });

  it('8.8 refuses when any resolved address is private (rebinding mix)', async () => {
    await expect(
      assertRegistryBaseUrl('https://x.example', resolveTo('93.184.216.34', '10.0.0.1')),
    ).rejects.toBeInstanceOf(RegistryUrlDeniedError);
  });

  it('8.8 refuses a host that does not resolve', async () => {
    await expect(assertRegistryBaseUrl('https://x.example', resolveTo())).rejects.toBeInstanceOf(
      RegistryUrlDeniedError,
    );
  });

  it('8.8 admin-authored sources may be private only when allowCidrs permits it', async () => {
    await expect(
      assertRegistryBaseUrl('http://10.1.2.3:8080/registry', {
        ...resolveTo('10.1.2.3'),
        allowCidrs: ['10.1.0.0/16'],
      }),
    ).resolves.toBe('http://10.1.2.3:8080/registry');
    await expect(
      assertRegistryBaseUrl('https://10.9.9.9', {
        ...resolveTo('10.9.9.9'),
        allowCidrs: ['10.1.0.0/16'],
      }),
    ).rejects.toBeInstanceOf(RegistryUrlDeniedError);
  });

  it('8.8 cluster CIDRs stay denied even when allowed', async () => {
    await expect(
      assertRegistryBaseUrl('https://10.1.2.3', {
        ...resolveTo('10.1.2.3'),
        allowCidrs: ['10.0.0.0/8'],
        clusterCidrs: ['10.1.0.0/16'],
      }),
    ).rejects.toBeInstanceOf(RegistryUrlDeniedError);
  });

  it('8.8 uses DNS by default for hostnames', async () => {
    await expect(assertRegistryBaseUrl('https://localhost/')).rejects.toBeInstanceOf(
      RegistryUrlDeniedError,
    );
  });
});
