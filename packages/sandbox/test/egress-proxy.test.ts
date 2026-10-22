import { mkdtemp } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createEgressProxy,
  type EgressAuditEvent,
  type EgressPolicy,
  type EgressProxy,
} from '../src/egress';
import { sha256Hex } from '../src/supply-chain';

const TOKEN = 'egress-token-1';
const auth = (instance = 'inst-1', token = TOKEN) =>
  `Basic ${Buffer.from(`${instance}:${token}`).toString('base64')}`;

type Raw = { head: string; body: string };
const rawRequest = (port: number, request: string): Promise<Raw> =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (d) => {
      data += d.toString();
    });
    socket.on('close', () => {
      const [head = '', ...rest] = data.split('\r\n\r\n');
      resolve({ head, body: rest.join('\r\n\r\n') });
    });
    socket.on('error', () => socket.destroy());
  });

/** Sends a CONNECT and returns the response head, then closes the tunnel. */
const connectHead = (port: number, request: string): Promise<Raw> =>
  new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(request));
    let data = '';
    socket.on('data', (d) => {
      data += d.toString();
      if (data.includes('\r\n\r\n')) {
        const [head = '', ...rest] = data.split('\r\n\r\n');
        resolve({ head, body: rest.join('\r\n\r\n') });
        socket.destroy();
      }
    });
    socket.on('error', () => socket.destroy());
  });

describe('8.8 egress proxy (real sockets on loopback)', () => {
  let target: net.Server;
  let targetPort: number;
  let httpTarget: http.Server;
  let httpPort: number;
  let proxy: EgressProxy;
  let proxyPort: number;
  let audit: EgressAuditEvent[];
  let policy: EgressPolicy | null;
  let resolved: Record<string, string[]>;
  let resolveCalls: string[];
  let connectedTo: { host: string; port: number }[];

  beforeEach(async () => {
    const events: EgressAuditEvent[] = [];
    audit = events;
    resolveCalls = [];
    connectedTo = [];
    resolved = {};
    target = net.createServer((c) => c.on('data', (d) => c.write(`echo:${d.toString()}`)));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    targetPort = (target.address() as net.AddressInfo).port;
    httpTarget = http.createServer((req, res) => {
      res.setHeader('x-seen-host', String(req.headers.host));
      res.setHeader('x-seen-proxy-auth', String(req.headers['proxy-authorization'] ?? 'none'));
      res.end(`hello ${req.method} ${req.url}`);
    });
    await new Promise<void>((r) => httpTarget.listen(0, '127.0.0.1', r));
    httpPort = (httpTarget.address() as net.AddressInfo).port;
    policy = {
      tokenSha256: sha256Hex(TOKEN),
      allow: [`ok.test:${targetPort}`, `web.test:${httpPort}`, '127.0.0.0/8'],
      phase: 'running',
    };
    proxy = createEgressProxy({
      policies: { get: async (id) => (id === 'inst-1' ? policy : null) },
      audit: { record: (e) => void events.push(e) },
      allowedSampleRate: 1,
      resolver: async (host) => {
        resolveCalls.push(host);
        const r = resolved[host];
        if (!r) throw new Error('ENOTFOUND');
        return r;
      },
      connect: (t) => {
        connectedTo.push(t);
        return net.connect({ host: '127.0.0.1', port: t.port });
      },
      clock: { now: () => Date.now() },
    });
    resolved['ok.test'] = ['93.184.216.34'];
    resolved['web.test'] = ['127.0.0.1'];
    proxyPort = (await proxy.listenTcp(0, '127.0.0.1')).port;
  });

  afterEach(async () => {
    await proxy.close();
    await new Promise<void>((r) => target.close(() => r()));
    httpTarget.closeAllConnections();
    await new Promise<void>((r) => httpTarget.close(() => r()));
  });

  const connect = (host: string, port: number, header = auth()) =>
    connectHead(
      proxyPort,
      `CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\nProxy-Authorization: ${header}\r\n\r\n`,
    );

  it('8.8 CONNECT to an allowlisted host tunnels bytes without interception and audits bytes each way', async () => {
    const result = await new Promise<string>((resolve) => {
      const s = net.connect(proxyPort, '127.0.0.1', () =>
        s.write(`CONNECT ok.test:${targetPort} HTTP/1.1\r\nProxy-Authorization: ${auth()}\r\n\r\n`),
      );
      let buf = '';
      s.on('data', (d) => {
        buf += d.toString();
        if (buf.includes('200 Connection Established') && !buf.includes('echo:')) s.write('ping');
        if (buf.includes('echo:ping')) {
          resolve(buf);
          s.destroy();
        }
      });
    });
    expect(result).toContain('HTTP/1.1 200 Connection Established');
    await new Promise((r) => setTimeout(r, 100));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      instanceId: 'inst-1',
      protocol: 'connect',
      host: 'ok.test',
      port: targetPort,
      resolvedIp: '93.184.216.34',
      decision: 'allow',
    });
    expect(audit[0]?.bytesUp).toBe(4);
    expect(audit[0]?.bytesDown).toBeGreaterThanOrEqual(9);
  });

  it('8.8 DNS rebinding safe: resolves once and connects to exactly the resolved address', async () => {
    expect((await connect('ok.test', targetPort)).head).toContain('200');
    expect(resolveCalls).toEqual(['ok.test']);
    expect(connectedTo).toEqual([{ host: '93.184.216.34', port: targetPort }]);
  });

  it('8.8 denies a non-allowlisted host with 403 and audits the denial (100%)', async () => {
    resolved['evil.test'] = ['93.184.216.36'];
    const r = await connect('evil.test', 443);
    // The reason phrase is what HTTP clients print (`ProxyError: 403 ...`): it names what to change.
    expect(r.head).toContain(
      `HTTP/1.1 403 Blocked by Bastion: evil.test:443 is not in this server's Network allowlist; add the host there`,
    );
    expect(r.head).toContain('X-Bastion-Egress-Reason: not-allowlisted');
    expect(audit[0]).toMatchObject({
      decision: 'deny',
      reason: 'not-allowlisted',
      host: 'evil.test',
      bytesUp: 0,
    });
    expect(connectedTo).toEqual([]);
  });

  it('8.8 denies an allowlisted name that resolves to a private address (SSRF) without connecting', async () => {
    for (const ip of ['127.0.0.1', '169.254.169.254', '10.0.0.7']) {
      resolved['ok.test'] = [ip];
      policy = { ...(policy as EgressPolicy), allow: [`ok.test:${targetPort}`] };
      const r = await connect('ok.test', targetPort);
      expect(r.head).toMatch(/^HTTP\/1\.1 403 Blocked by Bastion: /);
      expect(r.head).toContain('ssrf-blocked');
      if (ip === '10.0.0.7') {
        // The one way out is named: the address range goes into the server's own allowlist.
        expect(r.head).toContain(
          `ok.test resolves to 10.0.0.7, a private network address; add 10.0.0.7/32 to this server's Network allowlist`,
        );
      } else if (ip === '169.254.169.254') {
        // The cloud metadata address is never allowed, so no way out is offered.
        expect(r.head).toContain('never allowed');
        expect(r.head).not.toContain('add ');
      }
    }
    expect(connectedTo).toEqual([]);
    expect(audit.every((e) => e.decision === 'deny' && e.reason === 'ssrf-blocked')).toBe(true);
  });

  it('8.8 requires valid Proxy-Authorization: missing, wrong token, unknown instance', async () => {
    const none = await connectHead(proxyPort, `CONNECT ok.test:${targetPort} HTTP/1.1\r\n\r\n`);
    expect(none.head).toContain('407');
    expect(none.head).toContain('Proxy-Authenticate');
    expect((await connect('ok.test', targetPort, auth('inst-1', 'wrong'))).head).toContain('407');
    expect((await connect('ok.test', targetPort, auth('ghost'))).head).toContain('407');
    expect(connectedTo).toEqual([]);
  });

  it('8.8 mirror hosts pass only while the phase is installing', async () => {
    resolved['registry.npmjs.org'] = ['104.16.1.1'];
    // Own sink: the tunnel's audit record is written when it closes, which can be after this test has ended and the
    // next one has replaced `audit`.
    const mirrorAudit: EgressAuditEvent[] = [];
    const rebuilt = createEgressProxy({
      policies: { get: async () => policy },
      audit: { record: (e) => void mirrorAudit.push(e) },
      mirrorUrls: ['https://registry.npmjs.org'],
      resolver: async () => ['104.16.1.1'],
      connect: () => net.connect({ host: '127.0.0.1', port: targetPort }),
    });
    const { port } = await rebuilt.listenTcp(0, '127.0.0.1');
    const ask = () =>
      connectHead(
        port,
        `CONNECT registry.npmjs.org:443 HTTP/1.1\r\nProxy-Authorization: ${auth()}\r\n\r\n`,
      );
    policy = { ...(policy as EgressPolicy), phase: 'installing' };
    expect((await ask()).head).toContain('200');
    policy = { ...(policy as EgressPolicy), phase: 'running' };
    expect((await ask()).head).toContain('403');
    await rebuilt.close();
  });

  it('8.8 unresolvable names answer 502 and are audited as denials', async () => {
    policy = { ...(policy as EgressPolicy), allow: ['gone.test'] };
    const r = await connect('gone.test', 443);
    expect(r.head).toContain('502');
    expect(audit[0]).toMatchObject({ decision: 'deny', reason: 'unresolvable' });
  });

  it('8.8 a failing upstream connect answers 502', async () => {
    const failing = createEgressProxy({
      policies: { get: async () => policy },
      audit: { record: (e) => void audit.push(e) },
      resolver: async () => ['93.184.216.34'],
      connect: () => net.connect({ host: '127.0.0.1', port: 1 }),
    });
    const { port } = await failing.listenTcp(0, '127.0.0.1');
    const r = await connectHead(
      port,
      `CONNECT ok.test:${targetPort} HTTP/1.1\r\nProxy-Authorization: ${auth()}\r\n\r\n`,
    );
    expect(r.head).toContain('502');
    expect(audit[0]).toMatchObject({ decision: 'deny', reason: 'connect-failed' });
    await failing.close();
  });

  it('8.8 rejects malformed CONNECT targets', async () => {
    const r = await connectHead(
      proxyPort,
      `CONNECT /x/y HTTP/1.1\r\nProxy-Authorization: ${auth()}\r\n\r\n`,
    );
    expect(r.head).toContain('400');
    const r2 = await connectHead(
      proxyPort,
      `CONNECT a:99999 HTTP/1.1\r\nProxy-Authorization: ${auth()}\r\n\r\n`,
    );
    expect(r2.head).toContain('400');
  });

  it('8.8 forwards absolute-form HTTP requests, strips proxy headers and pins the address', async () => {
    const r = await rawRequest(
      proxyPort,
      `GET http://web.test:${httpPort}/path?q=1 HTTP/1.1\r\nHost: web.test:${httpPort}\r\nProxy-Authorization: ${auth()}\r\nConnection: close\r\n\r\n`,
    );
    expect(r.head).toContain('200 OK');
    expect(r.head.toLowerCase()).toContain(`x-seen-host: web.test:${httpPort}`);
    expect(r.head.toLowerCase()).toContain('x-seen-proxy-auth: none');
    expect(r.body).toBe('hello GET /path?q=1');
    expect(resolveCalls).toEqual(['web.test']);
    expect(audit[0]).toMatchObject({
      protocol: 'http',
      host: 'web.test',
      decision: 'allow',
      resolvedIp: '127.0.0.1',
    });
  });

  it('8.8 forwards request bodies for absolute-form POST', async () => {
    httpTarget.removeAllListeners('request');
    httpTarget.on('request', (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => res.end(`got ${Buffer.concat(chunks).toString()}`));
    });
    const r = await rawRequest(
      proxyPort,
      `POST http://web.test:${httpPort}/p HTTP/1.1\r\nHost: web.test:${httpPort}\r\nProxy-Authorization: ${auth()}\r\nContent-Length: 5\r\nConnection: close\r\n\r\nhello`,
    );
    expect(r.body).toBe('got hello');
    await new Promise((r2) => setTimeout(r2, 50));
    expect(audit[0]?.bytesUp).toBe(5);
  });

  it('8.8 plain HTTP is denied for non-allowlisted hosts, private resolutions and bad forms', async () => {
    resolved['evil.test'] = ['93.184.216.40'];
    const denied = await rawRequest(
      proxyPort,
      `GET http://evil.test/ HTTP/1.1\r\nHost: evil.test\r\nProxy-Authorization: ${auth()}\r\nConnection: close\r\n\r\n`,
    );
    expect(denied.head).toContain('403');
    policy = { ...(policy as EgressPolicy), allow: [`web.test:${httpPort}`] };
    resolved['web.test'] = ['10.1.1.1'];
    const ssrf = await rawRequest(
      proxyPort,
      `GET http://web.test:${httpPort}/ HTTP/1.1\r\nHost: web.test\r\nProxy-Authorization: ${auth()}\r\nConnection: close\r\n\r\n`,
    );
    expect(ssrf.head).toContain('403');
    const origin = await rawRequest(
      proxyPort,
      `GET /relative HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${auth()}\r\nConnection: close\r\n\r\n`,
    );
    expect(origin.head).toContain('400');
    const https = await rawRequest(
      proxyPort,
      `GET https://web.test/ HTTP/1.1\r\nHost: x\r\nProxy-Authorization: ${auth()}\r\nConnection: close\r\n\r\n`,
    );
    expect(https.head).toContain('400');
    const noauth = await rawRequest(
      proxyPort,
      `GET http://web.test/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`,
    );
    expect(noauth.head).toContain('407');
  });

  it('8.5 a per-instance Unix socket identifies the sandbox without credentials', async () => {
    if (process.platform === 'win32') return; // AF_UNIX path semantics; covered by the Linux suite
    const dir = await mkdtemp(path.join(tmpdir(), 'egress-'));
    const sock = path.join(dir, 'egress.sock');
    const listener = await proxy.listenUnix(sock, 'inst-1');
    const reply = await new Promise<string>((resolve) => {
      const s = net.connect(sock, () => s.write(`CONNECT ok.test:${targetPort} HTTP/1.1\r\n\r\n`));
      let buf = '';
      s.on('data', (d) => {
        buf += d.toString();
        s.destroy();
        resolve(buf);
      });
    });
    expect(reply).toContain('200 Connection Established');
    const unknown = await proxy.listenUnix(path.join(dir, 'ghost.sock'), 'ghost');
    const denied = await new Promise<string>((resolve) => {
      const s = net.connect(path.join(dir, 'ghost.sock'), () =>
        s.write(`CONNECT ok.test:${targetPort} HTTP/1.1\r\n\r\n`),
      );
      s.on('data', (d) => {
        resolve(d.toString());
        s.destroy();
      });
    });
    expect(denied).toContain('407');
    await listener.close();
    await unknown.close();
  });

  it('8.8 audit failures never break the data path', async () => {
    const flaky = createEgressProxy({
      policies: { get: async () => policy },
      audit: {
        record: () => {
          throw new Error('db down');
        },
      },
      resolver: async () => ['93.184.216.34'],
      connect: () => net.connect({ host: '127.0.0.1', port: targetPort }),
      allowedSampleRate: 1,
    });
    const { port } = await flaky.listenTcp(0, '127.0.0.1');
    const r = await connectHead(
      port,
      `CONNECT ok.test:${targetPort} HTTP/1.1\r\nProxy-Authorization: ${auth()}\r\n\r\n`,
    );
    expect(r.head).toContain('200');
    await flaky.close();
    const asyncFail = createEgressProxy({
      policies: { get: async () => policy },
      audit: {
        record: async () => {
          throw new Error('db down');
        },
      },
      resolver: async () => ['93.184.216.99'],
      connect: () => net.connect({ host: '127.0.0.1', port: targetPort }),
    });
    const second = await asyncFail.listenTcp(0, '127.0.0.1');
    const denied = await connectHead(
      second.port,
      `CONNECT other.test:443 HTTP/1.1\r\nProxy-Authorization: ${auth()}\r\n\r\n`,
    );
    expect(denied.head).toContain('403');
    await asyncFail.close();
  });
});

describe('8.8 egress proxy timeouts and unix socket', () => {
  const policy: EgressPolicy = {
    tokenSha256: sha256Hex(TOKEN),
    allow: ['ok.test:443'],
    phase: 'running',
  };

  it('8.8 destroys an upstream socket that never connects and answers 502', async () => {
    const hanging = new net.Socket();
    const proxy = createEgressProxy({
      policies: { get: async () => policy },
      audit: { record: () => {} },
      resolver: async () => ['93.184.216.34'],
      connect: () => hanging,
      connectTimeoutMs: 50,
    });
    const { port } = await proxy.listenTcp(0, '127.0.0.1');
    const r = await rawRequest(
      port,
      `CONNECT ok.test:443 HTTP/1.1\r\nProxy-Authorization: ${auth()}\r\n\r\n`,
    );
    expect(r.head).toContain('502');
    expect(hanging.destroyed).toBe(true);
    await proxy.close();
  });

  it.skipIf(process.platform === 'win32')(
    '8.8 puts the unix socket in a private directory and removes it on close',
    async () => {
      const { stat } = await import('node:fs/promises');
      const base = await mkdtemp(path.join(tmpdir(), 'bastion-egress-'));
      const socketPath = path.join(base, 'egress.sock');
      const proxy = createEgressProxy({
        policies: { get: async () => policy },
        audit: { record: () => {} },
      });
      const listener = await proxy.listenUnix(socketPath, 'inst-1');
      if (process.platform !== 'win32') {
        expect((await stat(path.dirname(socketPath))).mode & 0o777).toBe(0o700);
      }
      await listener.close();
      await proxy.close();
    },
  );
});
