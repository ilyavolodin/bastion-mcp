import dns from 'node:dns';
import { chmod, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { type Span, SpanStatusCode, trace } from '@opentelemetry/api';
import { type Clock, systemClock } from '../types';
import { type EgressAuditEvent, type EgressAuditSink, shouldAudit } from './audit';
import {
  canonicalHost,
  decideResolved,
  type DenyReason,
  type EgressPolicy,
  type EgressPolicyStore,
  type EgressProtocol,
  mirrorRules as buildMirrorRules,
  parseHostPort,
  parseProxyAuthorization,
  verifyEgressToken,
} from './policy';

/** Resolves a name to addresses. Called exactly once per connection (8.8). */
export type Resolver = (host: string) => Promise<string[]>;

export const systemResolver: Resolver = async (host) => {
  const records = await dns.promises.lookup(host, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

export type EgressProxyOptions = {
  policies: EgressPolicyStore;
  audit: EgressAuditSink;
  resolver?: Resolver;
  /** `BASTION_CLUSTER_CIDRS`: always denied. */
  clusterCidrs?: readonly string[];
  /** `BASTION_NPM_REGISTRY` and `BASTION_PYPI_INDEX_URL`; allowed only in phase `installing`. */
  mirrorUrls?: readonly (string | undefined)[];
  allowedSampleRate?: number;
  random?: () => number;
  clock?: Clock;
  connectTimeoutMs?: number;
  resolveTimeoutMs?: number;
  idleTimeoutMs?: number;
  /** Test seam for CONNECT tunnels: connect to an exact address. Defaults to `net.connect`. */
  connect?: (target: { host: string; port: number }) => net.Socket;
};

type Identity = { instanceId: string; policy: EgressPolicy };

const HOP_BY_HOP = [
  'connection',
  'keep-alive',
  'proxy-authorization',
  'proxy-authenticate',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
];

const tracer = () => trace.getTracer('bastion.sandbox');

type Counters = { up: number; down: number };

export type EgressProxy = {
  /** TCP listener for Kubernetes: authenticated with `Proxy-Authorization` (8.8). */
  listenTcp(port: number, host?: string): Promise<{ port: number; close(): Promise<void> }>;
  /** Per-instance Unix socket for bubblewrap: the socket identifies the sandbox (8.5, 8.8). */
  listenUnix(socketPath: string, instanceId: string): Promise<{ close(): Promise<void> }>;
  close(): Promise<void>;
};

export const createEgressProxy = (options: EgressProxyOptions): EgressProxy => {
  const resolver = options.resolver ?? systemResolver;
  const clock = options.clock ?? systemClock;
  const mirrors = buildMirrorRules(options.mirrorUrls ?? []);
  const connectTimeout = options.connectTimeoutMs ?? 10_000;
  const resolveTimeout = options.resolveTimeoutMs ?? 5_000;
  const idleTimeout = options.idleTimeoutMs ?? 5 * 60_000;
  const openServers = new Set<http.Server>();
  const openSockets = new Set<net.Socket>();

  const connectTo = (address: string, port: number): net.Socket =>
    options.connect
      ? options.connect({ host: address, port })
      : net.connect({ host: address, port, timeout: connectTimeout });

  const track = (socket: net.Socket): void => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  };

  const resolveOnce = async (host: string): Promise<string[]> => {
    if (net.isIP(host)) return [host];
    return await Promise.race([
      resolver(host),
      new Promise<string[]>((_, reject) =>
        setTimeout(() => reject(new Error('DNS timeout')), resolveTimeout).unref(),
      ),
    ]);
  };

  const emitAudit = (event: EgressAuditEvent): void => {
    const sampled = shouldAudit(event.decision, {
      ...(options.allowedSampleRate === undefined ? {} : { allowedRate: options.allowedSampleRate }),
      ...(options.random ? { random: options.random } : {}),
    });
    if (!sampled) return;
    try {
      const result = options.audit.record(event);
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      // Auditing must never break the data path.
    }
  };

  type Outcome =
    | { allowed: true; address: string; via: string }
    | { allowed: false; reason: DenyReason };

  const authorize = async (
    identify: () => Promise<Identity | 'bad-credentials' | 'unknown-instance'>,
  ): Promise<Identity | { denied: DenyReason }> => {
    const result = await identify();
    return typeof result === 'string' ? { denied: result } : result;
  };

  const evaluate = async (
    identity: Identity,
    target: { host: string; port: number },
    protocol: EgressProtocol,
  ): Promise<Outcome & { resolvedIp: string | null }> => {
    const host = canonicalHost(target.host);
    let addresses: string[];
    try {
      addresses = await resolveOnce(host);
    } catch {
      return { allowed: false, reason: 'unresolvable', resolvedIp: null };
    }
    const decision = decideResolved({
      host,
      port: target.port,
      protocol,
      policy: identity.policy,
      mirrorRules: mirrors,
      addresses,
      ...(options.clusterCidrs ? { clusterCidrs: options.clusterCidrs } : {}),
    });
    const resolvedIp = addresses[0] ?? null;
    return decision.allowed
      ? { allowed: true, address: decision.address, via: decision.via, resolvedIp }
      : { allowed: false, reason: decision.reason, resolvedIp };
  };

  const startSpan = (protocol: EgressProtocol, host: string, port: number, instanceId: string): Span =>
    tracer().startSpan(`egress ${protocol === 'connect' ? 'CONNECT' : 'HTTP'} ${host}`, {
      attributes: {
        'bastion.instance.id': instanceId,
        'net.peer.name': host,
        'net.peer.port': port,
      },
    });

  const finish = (input: {
    span: Span;
    startedAt: number;
    identity: Identity;
    protocol: EgressProtocol;
    host: string;
    port: number;
    resolvedIp: string | null;
    decision: 'allow' | 'deny';
    reason: EgressAuditEvent['reason'];
    counters: Counters;
  }): void => {
    const durationMs = clock.now() - input.startedAt;
    input.span.setAttributes({
      'bastion.egress.decision': input.decision,
      'bastion.egress.reason': input.reason ?? '',
      'bastion.egress.resolved_ip': input.resolvedIp ?? '',
      'bastion.egress.bytes_up': input.counters.up,
      'bastion.egress.bytes_down': input.counters.down,
    });
    if (input.decision === 'deny') input.span.setStatus({ code: SpanStatusCode.ERROR });
    input.span.end();
    emitAudit({
      instanceId: input.identity.instanceId,
      protocol: input.protocol,
      host: input.host,
      port: input.port,
      resolvedIp: input.resolvedIp,
      decision: input.decision,
      ...(input.reason ? { reason: input.reason } : {}),
      bytesUp: input.counters.up,
      bytesDown: input.counters.down,
      durationMs,
      ts: input.startedAt,
    });
  };

  const identifyByHeader =
    (header: string | undefined) => async (): Promise<Identity | 'bad-credentials' | 'unknown-instance'> => {
      const creds = parseProxyAuthorization(header);
      if (!creds) return 'bad-credentials';
      const policy = await options.policies.get(creds.instanceId);
      if (!policy) return 'unknown-instance';
      return verifyEgressToken(creds.token, policy.tokenSha256)
        ? { instanceId: creds.instanceId, policy }
        : 'bad-credentials';
    };

  const identifyFixed = (instanceId: string) => async (): Promise<Identity | 'unknown-instance'> => {
    const policy = await options.policies.get(instanceId);
    return policy ? { instanceId, policy } : 'unknown-instance';
  };

  const deny = (
    socket: net.Socket | http.ServerResponse,
    reason: DenyReason,
  ): void => {
    const status =
      reason === 'bad-credentials' || reason === 'unknown-instance'
        ? '407 Proxy Authentication Required'
        : reason === 'bad-request'
          ? '400 Bad Request'
          : reason === 'unresolvable' || reason === 'connect-failed'
            ? '502 Bad Gateway'
            : '403 Forbidden';
    const body = `bastion egress: ${reason}\n`;
    const headers = [
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Content-Type: text/plain',
      `X-Bastion-Egress-Reason: ${reason}`,
      'Connection: close',
      ...(status.startsWith('407') ? ['Proxy-Authenticate: Basic realm="bastion-egress"'] : []),
    ];
    if (socket instanceof http.ServerResponse) {
      const code = Number(status.slice(0, 3));
      socket.writeHead(code, Object.fromEntries(headers.map((h) => h.split(': ') as [string, string])));
      socket.end(body);
    } else {
      socket.end(`HTTP/1.1 ${status}\r\n${headers.join('\r\n')}\r\n\r\n${body}`);
    }
  };

  const handleConnect = async (
    identify: () => Promise<Identity | 'bad-credentials' | 'unknown-instance'>,
    req: http.IncomingMessage,
    client: net.Socket,
    head: Buffer,
  ): Promise<void> => {
    client.on('error', () => client.destroy());
    const parsed = parseHostPort(req.url ?? '', 443);
    const auth = await authorize(identify);
    if ('denied' in auth) return deny(client, auth.denied);
    if (!parsed) return deny(client, 'bad-request');
    const startedAt = clock.now();
    const span = startSpan('connect', parsed.host, parsed.port, auth.instanceId);
    const counters: Counters = { up: 0, down: 0 };
    const base = { span, startedAt, identity: auth, protocol: 'connect' as const, ...parsed, counters };
    const outcome = await evaluate(auth, parsed, 'connect');
    if (!outcome.allowed) {
      finish({ ...base, resolvedIp: outcome.resolvedIp, decision: 'deny', reason: outcome.reason });
      return deny(client, outcome.reason);
    }
    const upstream = connectTo(outcome.address, parsed.port);
    track(client);
    track(upstream);
    let settled = false;
    let connected = false;
    const done = (decision: 'allow' | 'deny', reason: EgressAuditEvent['reason']): void => {
      if (settled) return;
      settled = true;
      finish({ ...base, resolvedIp: outcome.resolvedIp, decision, reason });
    };
    upstream.setTimeout(idleTimeout, () => upstream.destroy());
    upstream.once('error', () => {
      if (!connected) {
        done('deny', 'connect-failed');
        deny(client, 'connect-failed');
      }
      client.destroy();
    });
    upstream.once('connect', () => {
      connected = true;
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length > 0) {
        counters.up += head.length;
        upstream.write(head);
      }
      client.on('data', (chunk: Buffer) => {
        counters.up += chunk.length;
      });
      upstream.on('data', (chunk: Buffer) => {
        counters.down += chunk.length;
      });
      client.pipe(upstream);
      upstream.pipe(client);
    });
    // The audit record and span are written when the tunnel closes, so byte counts are final.
    const teardown = (): void => {
      client.destroy();
      upstream.destroy();
      if (connected) done('allow', outcome.via as EgressAuditEvent['reason']);
    };
    client.once('close', teardown);
    upstream.once('close', teardown);
  };

  const handleRequest = async (
    identify: () => Promise<Identity | 'bad-credentials' | 'unknown-instance'>,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const auth = await authorize(identify);
    if ('denied' in auth) {
      req.resume();
      return deny(res, auth.denied);
    }
    let url: URL;
    try {
      url = new URL(req.url ?? '');
    } catch {
      req.resume();
      return deny(res, 'bad-request');
    }
    if (url.protocol !== 'http:' || url.username || url.password) {
      req.resume();
      return deny(res, 'bad-request');
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const port = url.port ? Number(url.port) : 80;
    const startedAt = clock.now();
    const span = startSpan('http', host, port, auth.instanceId);
    const counters: Counters = { up: 0, down: 0 };
    const base = { span, startedAt, identity: auth, protocol: 'http' as const, host, port, counters };
    const outcome = await evaluate(auth, { host, port }, 'http');
    if (!outcome.allowed) {
      req.resume();
      finish({ ...base, resolvedIp: outcome.resolvedIp, decision: 'deny', reason: outcome.reason });
      return deny(res, outcome.reason);
    }
    const headers: http.OutgoingHttpHeaders = {};
    const connectionTokens = String(req.headers.connection ?? '')
      .split(',')
      .map((t) => t.trim().toLowerCase());
    for (const [name, value] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.includes(name) || connectionTokens.includes(name)) continue;
      headers[name] = value;
    }
    headers.host = url.host;
    const upstream = http.request({
      host: outcome.address, // the address resolved once above: DNS rebinding cannot redirect it
      port,
      method: req.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers,
      setHost: false,
      timeout: connectTimeout,
      agent: false,
    });
    req.on('data', (chunk: Buffer) => {
      counters.up += chunk.length;
    });
    let settled = false;
    const done = (decision: 'allow' | 'deny', reason: EgressAuditEvent['reason']): void => {
      if (settled) return;
      settled = true;
      finish({ ...base, resolvedIp: outcome.resolvedIp, decision, reason });
    };
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (!settled) {
        done('deny', 'connect-failed');
        if (!res.headersSent) deny(res, 'connect-failed');
        else res.destroy();
      }
    });
    upstream.on('response', (up) => {
      const out: http.OutgoingHttpHeaders = {};
      const upTokens = String(up.headers.connection ?? '')
        .split(',')
        .map((t) => t.trim().toLowerCase());
      for (const [name, value] of Object.entries(up.headers)) {
        if (HOP_BY_HOP.includes(name) || upTokens.includes(name)) continue;
        out[name] = value;
      }
      res.writeHead(up.statusCode ?? 502, out);
      up.on('data', (chunk: Buffer) => {
        counters.down += chunk.length;
      });
      up.on('end', () => done('allow', outcome.via as EgressAuditEvent['reason']));
      up.on('error', () => res.destroy());
      up.pipe(res);
    });
    res.on('close', () => {
      upstream.destroy();
      done('allow', outcome.via as EgressAuditEvent['reason']);
    });
    req.pipe(upstream);
  };

  const makeServer = (
    identifyFor: (req: http.IncomingMessage) => () => Promise<Identity | 'bad-credentials' | 'unknown-instance'>,
  ): http.Server => {
    const server = http.createServer((req, res) => {
      handleRequest(identifyFor(req), req, res).catch(() => {
        if (!res.headersSent) deny(res, 'connect-failed');
        else res.destroy();
      });
    });
    server.on('connect', (req, socket: net.Socket, head) => {
      handleConnect(identifyFor(req), req, socket, head).catch(() => socket.destroy());
    });
    server.on('clientError', (_err, socket) => socket.destroy());
    server.on('connection', (socket) => track(socket));
    openServers.add(server);
    return server;
  };

  const closeServer = (server: http.Server): Promise<void> =>
    new Promise((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
      openServers.delete(server);
    });

  return {
    async listenTcp(port, host = '0.0.0.0') {
      const server = makeServer((req) => identifyByHeader(req.headers['proxy-authorization']));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve());
      });
      const addr = server.address();
      return {
        port: typeof addr === 'object' && addr ? addr.port : port,
        close: () => closeServer(server),
      };
    },
    async listenUnix(socketPath, instanceId) {
      await rm(socketPath, { force: true });
      const server = makeServer(() => identifyFixed(instanceId));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve());
      });
      await chmod(socketPath, 0o600).catch(() => {});
      return { close: () => closeServer(server) };
    },
    async close() {
      for (const socket of openSockets) socket.destroy();
      await Promise.all([...openServers].map(closeServer));
    },
  };
};
