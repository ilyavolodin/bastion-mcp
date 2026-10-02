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
    await expect(assertOutboundUrl(url, { lookup })).rejects.toThrow(/not allowed|invalid/);
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
