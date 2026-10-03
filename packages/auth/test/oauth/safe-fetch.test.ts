import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { assertOutboundUrl, createSafeFetch } from '../../src/oauth/safe-fetch';

const lookup = async (host: string): Promise<string[]> =>
  host === 'rebind.test' ? ['10.0.0.5'] : ['93.184.216.34'];

describe('SSRF guard for OAuth endpoints (9.6, 23.3)', () => {
  it.each([
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://169.254.169.254/latest',
    'https://10.0.0.1/x',
    'https://2130706433/x',
    'https://0x7f.1/x',
    'https://rebind.test/x',
    'https://[::ffff:127.0.0.1]/x',
  ])('23.3 denies %s', async (url) => {
    await expect(assertOutboundUrl(url, { lookup })).rejects.toThrow(/resolves to|invalid/);
  });

  it('9.1 the refusal says which name resolved to which address and how an administrator allows it', async () => {
    const error = await assertOutboundUrl('https://sso.home.test/x', {
      lookup: async () => ['192.168.1.2'],
    }).catch((e: Error) => e);
    expect((error as Error).message).toBe(
      'sso.home.test resolves to 192.168.1.2, a private network address. Bastion only reaches private networks that an administrator allows: add 192.168.1.2/32 (or the network it belongs to) to BASTION_PRIVATE_UPSTREAM_CIDRS and restart Bastion',
    );
    // ...and that is the whole fix: with the address allowed the same URL passes.
    await expect(
      assertOutboundUrl('https://sso.home.test/x', {
        lookup: async () => ['192.168.1.2'],
        addressPolicy: { allowCidrs: ['192.168.1.2/32'] },
      }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('9.6 requires https for public hosts', async () => {
    await expect(assertOutboundUrl('http://idp.example/x', { lookup })).rejects.toThrow(/https/);
  });

  it('9.6 rejects non-http schemes, credentials and unresolvable hosts', async () => {
    await expect(assertOutboundUrl('file:///etc/passwd', { lookup })).rejects.toThrow(/http/);
    await expect(assertOutboundUrl('https://a:b@idp.example/', { lookup })).rejects.toThrow(
      /credentials/,
    );
    await expect(assertOutboundUrl('not a url')).rejects.toThrow(/invalid/);
    await expect(assertOutboundUrl('https://x.test/', { lookup: async () => [] })).rejects.toThrow(
      /resolve/,
    );
  });

  it('9.6 admin CIDR entries may allow private targets, and http only when opted in', async () => {
    const policy = { addressPolicy: { allowCidrs: ['10.0.0.0/8'] }, lookup };
    await expect(assertOutboundUrl('https://rebind.test/x', policy)).resolves.toBeInstanceOf(URL);
    await expect(assertOutboundUrl('http://rebind.test/x', policy)).rejects.toThrow(/https/);
    await expect(
      assertOutboundUrl('http://rebind.test/x', { ...policy, allowHttpToAllowedCidrs: true }),
    ).resolves.toBeInstanceOf(URL);
  });

  it('9.6 safe fetch checks before calling and never follows redirects', async () => {
    const inner = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response('ok'));
    const safe = createSafeFetch(inner as unknown as typeof fetch, { lookup });
    await safe('https://idp.example/.well-known/openid-configuration');
    expect(inner).toHaveBeenCalledOnce();
    expect(inner.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual' });
    await expect(safe(new URL('https://127.0.0.1/'))).rejects.toThrow();
    await expect(safe(new Request('https://127.0.0.1/'))).rejects.toThrow();
    expect(inner).toHaveBeenCalledOnce();
  });
});

describe('DNS pinning (8.8, 8.9)', () => {
  it('8.9 connects to the address that was checked, not to a second resolution', async () => {
    const server = createServer((_req, res) => res.end('pinned'));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    // Rebinding stub: the first answer is the (admin-allowed) loopback address, every later answer is public.
    let calls = 0;
    const rebinding = async (): Promise<string[]> => {
      calls += 1;
      return calls === 1 ? ['127.0.0.1'] : ['93.184.216.34'];
    };
    try {
      const safe = createSafeFetch(fetch, {
        lookup: rebinding,
        addressPolicy: { allowCidrs: ['127.0.0.0/8'] },
        allowHttpToAllowedCidrs: true,
        timeoutMs: 3000,
      });
      // `rebind.test` does not resolve on the system resolver: only the pinned lookup can connect.
      const response = await safe(`http://rebind.test:${port}/x`);
      expect(await response.text()).toBe('pinned');
      expect(calls).toBe(1);
    } finally {
      server.close();
    }
  });

  it('8.9 hands the inner fetch a dispatcher pinned to the validated address', async () => {
    const inner = vi.fn(async (_input: unknown, _init?: RequestInit) => new Response('ok'));
    const safe = createSafeFetch(inner as unknown as typeof fetch, { lookup });
    await safe('https://idp.example/x');
    expect(inner.mock.calls[0]?.[1]).toHaveProperty('dispatcher');
  });
});
