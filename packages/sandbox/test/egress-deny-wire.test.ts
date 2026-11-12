import net from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEgressProxy, type EgressAuditEvent, type EgressProxy } from '../src/egress';
import { sha256Hex } from '../src/supply-chain';

const TOKEN = 'egress-token-1';
const auth = (instance = 'inst-1', token = TOKEN) =>
  `Basic ${Buffer.from(`${instance}:${token}`).toString('base64')}`;

const exchange = (port: number, request: string): Promise<string> =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (d) => {
      data += d.toString('latin1');
    });
    socket.on('close', () => resolve(data));
    socket.on('error', () => socket.destroy());
  });

/** The refusal exactly as clients receive it: status line, headers in order, blank line, body. */
const refusal = (
  status: string,
  reason: string,
  detail: string,
  proxyAuthenticate = false,
): string => {
  const body = `bastion egress: ${reason}: ${detail}\n`;
  return [
    `HTTP/1.1 ${status}`,
    `Content-Length: ${Buffer.byteLength(body)}`,
    'Content-Type: text/plain',
    `X-Bastion-Egress-Reason: ${reason}`,
    `X-Bastion-Egress-Detail: ${detail}`,
    'Connection: close',
    ...(proxyAuthenticate ? ['Proxy-Authenticate: Basic realm="bastion-egress"'] : []),
    '',
    body,
  ].join('\r\n');
};
const noDate = (raw: string): string => raw.replace(/Date: [^\r]*\r\n/, '');

const CREDENTIALS = 'Bastion proxy credentials are missing or wrong';
const BAD_REQUEST = 'Bastion could not read the proxy request';
const PRIVATE =
  "Blocked by Bastion: priv.test resolves to 10.0.0.7, a private network address; add 10.0.0.7/32 to this server's Network allowlist to allow it";
const METADATA =
  'Blocked by Bastion: meta.test resolves to 169.254.169.254, which is never allowed';
const IPV6 =
  "Blocked by Bastion: v6.test resolves to fd00::1, a private network address; add fd00::1/128 to this server's Network allowlist to allow it";
const notAllowlisted = (where: string) =>
  `Blocked by Bastion: ${where} is not in this server's Network allowlist; add the host there`;
const unauthorized = (reason: string) =>
  refusal('407 Proxy Authentication Required', reason, CREDENTIALS, true);

describe('8.8 refusal wire forms', () => {
  let proxy: EgressProxy;
  let port: number;
  let audit: EgressAuditEvent[];

  beforeEach(async () => {
    audit = [];
    proxy = createEgressProxy({
      policies: {
        get: async (id) =>
          id === 'inst-1'
            ? {
                tokenSha256: sha256Hex(TOKEN),
                allow: ['ok.test', 'gone.test', 'priv.test', 'meta.test', 'v6.test'],
                phase: 'running',
              }
            : null,
      },
      audit: { record: (e) => void audit.push(e) },
      allowedSampleRate: 1,
      resolver: async (host) => {
        const table: Record<string, string[]> = {
          'ok.test': ['93.184.216.34'],
          'evil.test': ['93.184.216.36'],
          'priv.test': ['10.0.0.7'],
          'meta.test': ['169.254.169.254'],
          'v6.test': ['fd00::1'],
        };
        const r = table[host];
        if (!r) throw new Error('ENOTFOUND');
        return r;
      },
      connect: () => net.connect({ host: '127.0.0.1', port: 1 }),
      clock: { now: () => 1_700_000_000_000 },
    });
    port = (await proxy.listenTcp(0, '127.0.0.1')).port;
  });
  afterEach(async () => {
    await proxy.close();
  });

  const viaConnect = (target: string, header: string | null = auth()) =>
    exchange(
      port,
      `CONNECT ${target} HTTP/1.1\r\n${header ? `Proxy-Authorization: ${header}\r\n` : ''}\r\n`,
    );
  const viaHttp = (url: string, header: string | null = auth()) =>
    exchange(
      port,
      `GET ${url} HTTP/1.1\r\nHost: x\r\n${header ? `Proxy-Authorization: ${header}\r\n` : ''}Connection: close\r\n\r\n`,
    );

  const cases: [string, () => Promise<string>, string][] = [
    [
      'connect bad credentials',
      () => viaConnect('ok.test:443', auth('inst-1', 'wrong')),
      unauthorized('bad-credentials'),
    ],
    [
      'connect no credentials',
      () => viaConnect('ok.test:443', null),
      unauthorized('bad-credentials'),
    ],
    [
      'connect unknown instance',
      () => viaConnect('ok.test:443', auth('ghost')),
      unauthorized('unknown-instance'),
    ],
    [
      'connect bad request',
      () => viaConnect('/x/y'),
      refusal('400 Bad Request', 'bad-request', BAD_REQUEST),
    ],
    [
      'connect not allowlisted',
      () => viaConnect('evil.test:8443'),
      refusal(
        `403 ${notAllowlisted('evil.test:8443')}`,
        'not-allowlisted',
        notAllowlisted('evil.test:8443'),
      ),
    ],
    [
      'connect ssrf private',
      () => viaConnect('priv.test:443'),
      refusal(`403 ${PRIVATE}`, 'ssrf-blocked', PRIVATE),
    ],
    [
      'connect ssrf metadata',
      () => viaConnect('meta.test:443'),
      refusal(`403 ${METADATA}`, 'ssrf-blocked', METADATA),
    ],
    [
      'connect ssrf ipv6',
      () => viaConnect('v6.test:443'),
      refusal(`403 ${IPV6}`, 'ssrf-blocked', IPV6),
    ],
    [
      'connect unresolvable',
      () => viaConnect('gone.test:443'),
      refusal(
        '502 Bastion could not resolve gone.test',
        'unresolvable',
        'Bastion could not resolve gone.test',
      ),
    ],
    [
      'connect connect-failed',
      () => viaConnect('ok.test:443'),
      refusal(
        '502 Bastion could not connect to ok.test:443',
        'connect-failed',
        'Bastion could not connect to ok.test:443',
      ),
    ],
    [
      'http bad credentials',
      () => viaHttp('http://ok.test/', auth('inst-1', 'wrong')),
      unauthorized('bad-credentials'),
    ],
    [
      'http unknown instance',
      () => viaHttp('http://ok.test/', auth('ghost')),
      unauthorized('unknown-instance'),
    ],
    [
      'http bad request, origin form',
      () => viaHttp('/relative'),
      refusal('400 Bad Request', 'bad-request', BAD_REQUEST),
    ],
    [
      'http bad request, https scheme',
      () => viaHttp('https://ok.test/'),
      refusal('400 Bad Request', 'bad-request', BAD_REQUEST),
    ],
    [
      'http not allowlisted',
      () => viaHttp('http://evil.test:8080/'),
      refusal(
        `403 ${notAllowlisted('evil.test:8080')}`,
        'not-allowlisted',
        notAllowlisted('evil.test:8080'),
      ),
    ],
    [
      'http ssrf private',
      () => viaHttp('http://priv.test/'),
      refusal(`403 ${PRIVATE}`, 'ssrf-blocked', PRIVATE),
    ],
    [
      'http ssrf metadata',
      () => viaHttp('http://meta.test/'),
      refusal(`403 ${METADATA}`, 'ssrf-blocked', METADATA),
    ],
    [
      'http unresolvable',
      () => viaHttp('http://gone.test/'),
      refusal(
        '502 Bastion could not resolve gone.test',
        'unresolvable',
        'Bastion could not resolve gone.test',
      ),
    ],
    [
      'http connect-failed',
      () => viaHttp('http://ok.test/'),
      refusal(
        '502 Bastion could not connect to ok.test:80',
        'connect-failed',
        'Bastion could not connect to ok.test:80',
      ),
    ],
  ];

  it.each(cases)('%s: raw bytes', async (_name, run, expected) => {
    expect(noDate(await run())).toBe(expected);
  });

  it('every refusal is audited as a deny with its reason', async () => {
    await viaConnect('evil.test:8443');
    await viaConnect('priv.test:443');
    await viaConnect('gone.test:443');
    await viaConnect('ok.test:443');
    await viaHttp('http://meta.test/');
    expect(audit.map((e) => [e.protocol, e.host, e.decision, e.reason, e.resolvedIp])).toEqual([
      ['connect', 'evil.test', 'deny', 'not-allowlisted', null],
      ['connect', 'priv.test', 'deny', 'ssrf-blocked', '10.0.0.7'],
      ['connect', 'gone.test', 'deny', 'unresolvable', null],
      ['connect', 'ok.test', 'deny', 'connect-failed', '93.184.216.34'],
      ['http', 'meta.test', 'deny', 'ssrf-blocked', '169.254.169.254'],
    ]);
    expect(audit.every((e) => e.ts === 1_700_000_000_000 && e.durationMs === 0)).toBe(true);
  });

  it('the HTTP form carries a Date header the socket form does not', async () => {
    expect(await viaHttp('/relative')).toMatch(/\r\nDate: /);
    expect(await viaConnect('/x/y')).not.toMatch(/\r\nDate: /);
  });
});
