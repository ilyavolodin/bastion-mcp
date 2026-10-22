import { describe, expect, it, vi } from 'vitest';
import type { UpstreamDiscovery } from '../../src/oauth/upstream/discovery';
import { resolveClientIdentity } from '../../src/oauth/upstream/client-identity';

const discovery = (over: Partial<UpstreamDiscovery> = {}): UpstreamDiscovery =>
  ({
    resource: 'http://192.168.1.150:8123',
    issuer: 'http://192.168.1.150:8123',
    authorizationEndpoint: 'http://192.168.1.150:8123/auth/authorize',
    tokenEndpoint: 'http://192.168.1.150:8123/auth/token',
    registrationEndpoint: null,
    revocationEndpoint: null,
    scopesSupported: [],
    grantTypesSupported: null,
    tokenEndpointAuthMethods: ['none'],
    issParameterSupported: false,
    cimdSupported: true,
    metadata: {},
    ...over,
  }) as UpstreamDiscovery;

const deps = (host: string) =>
  ({
    host,
    orgName: 'Home',
    clients: { get: vi.fn(async () => null), put: vi.fn(async () => undefined) },
    secrets: {},
    signingKeys: {},
    fetch: vi.fn(),
  }) as unknown as Parameters<typeof resolveClientIdentity>[0];

describe('upstream client identity (9.6)', () => {
  it('9.6 auto: a LAN deployment with no registration endpoint still offers its CIMD client ID (Home Assistant)', async () => {
    const resolved = await resolveClientIdentity(
      deps('http://localhost:8080'),
      { registration: 'auto' },
      discovery(),
    );
    expect(resolved.registration).toBe('cimd');
    expect(resolved.clientId).toBe('http://localhost:8080/oauth/upstream/client-metadata-public.json');
  });

  it('9.6 auto: an unreachable origin still prefers dynamic registration when the AS offers it', async () => {
    const d = deps('http://localhost:8080');
    (d.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      new Response(JSON.stringify({ client_id: 'dyn-1' }), { status: 201 }),
    );
    const resolved = await resolveClientIdentity(
      d,
      { registration: 'auto' },
      discovery({ registrationEndpoint: 'http://192.168.1.150:8123/register' }),
    );
    expect(resolved.registration).toBe('dcr');
  });

  it('9.6 explicit cimd stays strict about a public HTTPS origin', async () => {
    await expect(
      resolveClientIdentity(deps('http://localhost:8080'), { registration: 'cimd' }, discovery()),
    ).rejects.toThrow(/public HTTPS origin/);
  });

  it('9.6 auto: without CIMD support or registration it still fails with the registration error', async () => {
    await expect(
      resolveClientIdentity(
        deps('http://localhost:8080'),
        { registration: 'auto' },
        discovery({ cimdSupported: false }),
      ),
    ).rejects.toThrow(/no client registration/);
  });
});
