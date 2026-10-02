import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  buildProxyUrl,
  canonicalHost,
  decideResolved,
  type EgressPolicy,
  matchName,
  mirrorRules,
  parseHostPort,
  parseProxyAuthorization,
  verifyEgressToken,
} from '../src/egress';
import { shouldAudit } from '../src/egress/audit';
import { assertSafeRemoteUrl, pinnedLookup, UnsafeRemoteUrlError } from '../src/egress/remote-url';
import { sha256Hex } from '../src/supply-chain';

const policy = (over: Partial<EgressPolicy> = {}): EgressPolicy => ({
  tokenSha256: sha256Hex('tok'),
  allow: ['api.github.com', '*.atlassian.net:443', '10.20.0.0/16', 'plain.example.com:80'],
  phase: 'running',
  ...over,
});
const decide = (
  host: string,
  addresses: string[],
  over: Partial<EgressPolicy> = {},
  port = 443,
  protocol: 'connect' | 'http' = 'connect',
  clusterCidrs?: string[],
) =>
  decideResolved({
    host,
    port,
    protocol,
    policy: policy(over),
    mirrorRules: mirrorRules(['https://registry.npmjs.org', 'https://pypi.org/simple']),
    addresses,
    ...(clusterCidrs ? { clusterCidrs } : {}),
  });

describe('8.8 proxy credentials', () => {
  it('8.8 parses Proxy-Authorization Basic base64(instanceId:token)', () => {
    const header = `Basic ${Buffer.from('inst-1:s3cret:with:colons').toString('base64')}`;
    expect(parseProxyAuthorization(header)).toEqual({
      instanceId: 'inst-1',
      token: 's3cret:with:colons',
    });
    expect(parseProxyAuthorization(undefined)).toBeNull();
    expect(parseProxyAuthorization('Bearer x')).toBeNull();
    expect(
      parseProxyAuthorization(`Basic ${Buffer.from('nocolon').toString('base64')}`),
    ).toBeNull();
  });
  it('8.8 validates the token against tokenSha256 in constant time', () => {
    expect(verifyEgressToken('tok', sha256Hex('tok'))).toBe(true);
    expect(verifyEgressToken('tok2', sha256Hex('tok'))).toBe(false);
    expect(verifyEgressToken('tok', 'zz')).toBe(false);
  });
  it('8.8 builds the HTTPS_PROXY URL the runner receives', () => {
    expect(buildProxyUrl('i1', 'a/b', '10.0.0.5:3128')).toBe('http://i1:a%2Fb@10.0.0.5:3128');
  });
});

describe('8.8 host:port parsing', () => {
  it.each([
    ['example.com', 443, { host: 'example.com', port: 443 }],
    ['Example.COM:8443', 443, { host: 'example.com', port: 8443 }],
    ['[::1]:443', 443, { host: '::1', port: 443 }],
    ['[2001:db8::1]', 80, { host: '2001:db8::1', port: 80 }],
    ['example.com.', 80, { host: 'example.com', port: 80 }],
  ])('parses %s', (input, def, expected) => {
    expect(parseHostPort(input, def)).toEqual(expected);
  });
  it.each([
    '',
    ':443',
    'a:b',
    'a:0',
    'a:70000',
    '::1',
    '[::1',
    '[::1]x',
    'a b:80',
    'u@host:80',
    'a:12x',
  ])('8.8 rejects %s', (input) => {
    expect(parseHostPort(input, 443)).toBeNull();
  });
});

describe('8.8 allowlist', () => {
  it('8.8 matches host, suffix and port defaults (443 for CONNECT, 80 for HTTP)', () => {
    expect(decide('api.github.com', ['140.82.1.1']).allowed).toBe(true);
    expect(decide('api.github.com', ['140.82.1.1'], {}, 8443)).toMatchObject({
      allowed: false,
      reason: 'not-allowlisted',
    });
    expect(decide('acme.atlassian.net', ['104.192.1.1']).allowed).toBe(true);
    expect(decide('atlassian.net', ['104.192.1.1']).allowed).toBe(false);
    expect(decide('plain.example.com', ['93.184.216.34'], {}, 80, 'http').allowed).toBe(true);
    expect(decide('plain.example.com', ['93.184.216.34'], {}, 443, 'connect').allowed).toBe(false);
    expect(decide('evil.com', ['93.184.216.34'])).toMatchObject({
      allowed: false,
      reason: 'not-allowlisted',
    });
  });
  it('8.8 an empty resolution is denied', () => {
    expect(decide('api.github.com', []).allowed).toBe(false);
  });
  it('8.8 mirror hosts are allowed during installing only', () => {
    expect(decide('registry.npmjs.org', ['104.16.1.1'], { phase: 'installing' })).toMatchObject({
      allowed: true,
      via: 'mirror',
    });
    expect(decide('files.pythonhosted.org', ['151.101.1.1'], { phase: 'installing' }).allowed).toBe(
      true,
    );
    expect(decide('registry.npmjs.org', ['104.16.1.1'], { phase: 'running' }).allowed).toBe(false);
    expect(
      matchName({
        host: 'registry.npmjs.org',
        port: 443,
        protocol: 'connect',
        policy: policy({ phase: 'installing' }),
        mirrorRules: [],
      }).allowed,
    ).toBe(false);
  });
  it('8.8 mirrorRules derives host:port, defaults ports and ignores junk', () => {
    expect(
      mirrorRules([
        'http://nexus.corp:8081/repository/npm/',
        'https://pypi.org/simple',
        undefined,
        'not a url',
      ]),
    ).toEqual(['nexus.corp:8081', 'pypi.org:443', 'files.pythonhosted.org:443']);
    expect(mirrorRules(['http://m.corp/'])).toEqual(['m.corp:80']);
  });
  it('8.8 an in-network mirror (private address) is reachable during installing, never the metadata address', () => {
    const rules = mirrorRules(['https://nexus.corp']);
    const run = (ip: string) =>
      decideResolved({
        host: 'nexus.corp',
        port: 443,
        protocol: 'connect',
        policy: policy({ phase: 'installing', allow: [] }),
        mirrorRules: rules,
        addresses: [ip],
        clusterCidrs: ['10.0.0.0/8'],
      });
    expect(run('10.9.9.9').allowed).toBe(true);
    expect(run('169.254.169.254').allowed).toBe(false);
  });
});

describe('8.8 SSRF protection', () => {
  const blocked = [
    ['loopback v4', '127.0.0.1'],
    ['loopback v6', '::1'],
    ['metadata', '169.254.169.254'],
    ['link-local', '169.254.10.10'],
    ['rfc1918 10/8', '10.1.2.3'],
    ['rfc1918 172.16/12', '172.16.0.9'],
    ['rfc1918 192.168/16', '192.168.1.1'],
    ['cgnat', '100.64.0.1'],
    ['ula', 'fd12:3456::1'],
    ['v4-mapped loopback', '::ffff:127.0.0.1'],
    ['unspecified', '0.0.0.0'],
  ];
  it.each(blocked)('8.8 rejects an allowlisted name resolving to %s', (_label, ip) => {
    expect(decide('api.github.com', [ip])).toMatchObject({
      allowed: false,
      reason: 'ssrf-blocked',
    });
  });
  it('8.8 any blocked address among several records denies the connection', () => {
    expect(decide('api.github.com', ['140.82.1.1', '10.0.0.1']).allowed).toBe(false);
  });
  it('8.8 a CIDR rule allows private addresses inside it, by name or by literal', () => {
    expect(decide('db.internal', ['10.20.5.5'])).toMatchObject({ allowed: true, via: 'cidr' });
    expect(decide('10.20.5.5', ['10.20.5.5'], {}, 5432)).toMatchObject({ allowed: true });
    expect(decide('db.internal', ['10.21.5.5']).allowed).toBe(false);
  });
  it('8.8 cluster CIDRs stay denied even when a CIDR rule covers them', () => {
    expect(decide('db.internal', ['10.20.5.5'], {}, 443, 'connect', ['10.20.0.0/16']).allowed).toBe(
      false,
    );
  });
  it('8.8 the cloud metadata address is denied even if a rule allows 169.254/16', () => {
    expect(decide('x.test', ['169.254.169.254'], { allow: ['169.254.0.0/16'] }).allowed).toBe(
      false,
    );
  });
  it('23.3 decimal, octal and hex encodings are normalized and denied', () => {
    expect(canonicalHost('2130706433')).toBe('127.0.0.1');
    expect(canonicalHost('0177.0.0.1')).toBe('127.0.0.1');
    expect(canonicalHost('0x7f.1')).toBe('127.0.0.1');
    expect(canonicalHost('example.com')).toBe('example.com');
    for (const encoded of ['2130706433', '0177.0.0.1', '0x7f000001', '017700000001']) {
      const ip = canonicalHost(encoded);
      expect(decide(encoded, [ip], { allow: [encoded, ip] }).allowed).toBe(false);
    }
  });
  it('23.3 property: any private literal is denied unless a CIDR allows it', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 0, max: 255 }),
        fc.integer({ min: 1, max: 254 }),
        (b, c, d) => {
          const ip = `10.${b}.${c}.${d}`;
          const allowed = decide('api.github.com', [ip], { allow: ['api.github.com'] }).allowed;
          expect(allowed).toBe(false);
        },
      ),
    );
  });
});

describe('8.8 audit sampling', () => {
  it('8.8 audits 100% of denials and 10% of allowed connections by default', () => {
    expect(shouldAudit('deny', { allowedRate: 0, random: () => 0.99 })).toBe(true);
    expect(shouldAudit('allow', { random: () => 0.05 })).toBe(true);
    expect(shouldAudit('allow', { random: () => 0.5 })).toBe(false);
    expect(shouldAudit('allow', { allowedRate: 1 })).toBe(true);
    expect(shouldAudit('allow', { allowedRate: 0 })).toBe(false);
  });
});

describe('8.9 remote connector URL validation', () => {
  const resolver = (map: Record<string, string[]>) => async (host: string) => {
    const r = map[host];
    if (!r) throw new Error('ENOTFOUND');
    return r;
  };
  const opts = (over: Partial<Parameters<typeof assertSafeRemoteUrl>[1]> = {}) => ({
    privateCidrsAllowed: [] as string[],
    insecureHosts: [] as string[],
    resolver: resolver({
      'api.example.com': ['93.184.216.34'],
      'internal.corp': ['10.5.5.5'],
      'meta.test': ['169.254.169.254'],
      'rebind.test': ['127.0.0.1'],
    }),
    ...over,
  });

  it('8.9 accepts an HTTPS URL on a public address and pins it', async () => {
    const result = await assertSafeRemoteUrl('https://api.example.com/mcp', opts());
    expect(result).toMatchObject({ address: '93.184.216.34', family: 4, port: 443 });
  });
  it('8.9 requires HTTPS except for BASTION_INSECURE_UPSTREAM_HOSTS', async () => {
    await expect(assertSafeRemoteUrl('http://api.example.com/mcp', opts())).rejects.toMatchObject({
      code: 'UNSAFE_REMOTE_URL',
      data: { reason: 'insecure' },
    });
    await expect(
      assertSafeRemoteUrl(
        'http://api.example.com/mcp',
        opts({ insecureHosts: ['api.example.com'] }),
      ),
    ).resolves.toMatchObject({ port: 80 });
    await expect(
      assertSafeRemoteUrl(
        'http://api.example.com:8080/mcp',
        opts({ insecureHosts: ['api.example.com:8080'] }),
      ),
    ).resolves.toMatchObject({ port: 8080 });
  });
  it.each([
    'ftp://api.example.com/x',
    'file:///etc/passwd',
    'not a url',
    'https://u:p@api.example.com/',
  ])('8.9 rejects %s', async (url) => {
    await expect(assertSafeRemoteUrl(url, opts())).rejects.toBeInstanceOf(UnsafeRemoteUrlError);
  });
  it.each([
    'https://127.0.0.1/mcp',
    'https://[::1]/mcp',
    'https://169.254.169.254/latest',
    'https://10.0.0.1/',
    'https://2130706433/',
    'https://0177.0.0.1/',
    'https://0x7f000001/',
    'https://meta.test/',
    'https://rebind.test/',
    'https://internal.corp/',
  ])('23.3 denies %s for personal installations', async (url) => {
    await expect(assertSafeRemoteUrl(url, opts())).rejects.toMatchObject({
      data: { reason: 'blocked-address' },
    });
  });
  it('8.9 a blocked private address names the address and the setting that allows it', async () => {
    const error = await assertSafeRemoteUrl('https://internal.corp/', opts()).catch((e) => e);
    const text = String(error.message);
    for (const part of [
      'internal.corp resolves to 10.5.5.5',
      'private network',
      '10.5.5.5/32',
      'BASTION_PRIVATE_UPSTREAM_CIDRS',
    ]) {
      expect(text).toContain(part);
    }
  });
  it('8.9 the metadata address is never allowable, and the message does not suggest it', async () => {
    const error = await assertSafeRemoteUrl('https://meta.test/', opts()).catch((e) => e);
    expect(String(error.message)).toMatch(/cloud metadata/);
    expect(String(error.message)).not.toMatch(/BASTION_PRIVATE_UPSTREAM_CIDRS/);
  });
  it('8.9 plain HTTP names the host and BASTION_INSECURE_UPSTREAM_HOSTS', async () => {
    const error = await assertSafeRemoteUrl('http://plain.test/mcp', opts()).catch((e) => e);
    const text = String(error.message);
    for (const part of ['HTTPS', 'plain.test', 'BASTION_INSECURE_UPSTREAM_HOSTS']) {
      expect(text).toContain(part);
    }
  });
  it('8.9 admin entries may reach BASTION_PRIVATE_UPSTREAM_CIDRS but never the metadata address', async () => {
    await expect(
      assertSafeRemoteUrl('https://internal.corp/', opts({ privateCidrsAllowed: ['10.0.0.0/8'] })),
    ).resolves.toMatchObject({ address: '10.5.5.5' });
    await expect(
      assertSafeRemoteUrl('https://meta.test/', opts({ privateCidrsAllowed: ['169.254.0.0/16'] })),
    ).rejects.toBeInstanceOf(UnsafeRemoteUrlError);
  });
  it('8.9 an unresolvable host is rejected', async () => {
    await expect(assertSafeRemoteUrl('https://nope.example/', opts())).rejects.toMatchObject({
      data: { reason: 'unresolvable' },
    });
    await expect(
      assertSafeRemoteUrl('https://empty.test/', opts({ resolver: async () => [] })),
    ).rejects.toMatchObject({ data: { reason: 'unresolvable' } });
  });
  it('8.9 resolves exactly once and the pinned lookup answers only that address', async () => {
    let calls = 0;
    const result = await assertSafeRemoteUrl(
      'https://api.example.com/',
      opts({
        resolver: async () => {
          calls += 1;
          return ['93.184.216.34'];
        },
      }),
    );
    expect(calls).toBe(1);
    const lookup = pinnedLookup(result);
    const single = await new Promise((resolve) =>
      lookup('anything', {}, (_e, a, f) => resolve([a, f])),
    );
    expect(single).toEqual(['93.184.216.34', 4]);
    const all = await new Promise((resolve) =>
      (lookup as (h: string, o: object, cb: (e: null, a: unknown) => void) => void)(
        'x',
        { all: true },
        (_e, a) => resolve(a),
      ),
    );
    expect(all).toEqual([{ address: '93.184.216.34', family: 4 }]);
  });
});
