import dns from 'node:dns';
import { chmod, mkdir, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { type Clock, systemClock } from '@bastion-mcp/core';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import { SANDBOX_TIMEOUTS_MS } from '../timeouts';
import { type EgressAuditEvent, type EgressAuditSink, shouldAudit } from './audit';
import {
  mirrorRules as buildMirrorRules,
  canonicalHost,
  cidrRules,
  type DenyReason,
  decideResolved,
  denyDetail,
  type EgressPolicy,
  type EgressPolicyStore,
  type EgressProtocol,
  matchName,
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
type IdentifyResult = Identity | 'bad-credentials' | 'unknown-instance';
type Identify = () => Promise<IdentifyResult>;

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

/** Copies headers minus hop-by-hop ones and those named by `Connection`. */
const withoutHopByHop = (headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders => {
  const named = String(headers.connection ?? '')
    .split(',')
    .map((t) => t.trim().toLowerCase());
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.includes(name) && !named.includes(name)) out[name] = value;
  }
  return out;
};

const tracer = () => trace.getTracer('bastion.sandbox');

type Counters = { up: number; down: number };

export type EgressProxy = {
  /** TCP listener for Kubernetes: authenticated with `Proxy-Authorization` (8.8). */
  listenTcp(port: number, host?: string): Promise<{ port: number; close(): Promise<void> }>;
  /** Per-instance Unix socket for bubblewrap: the socket identifies the sandbox (8.5, 8.8). */
  listenUnix(socketPath: string, instanceId: string): Promise<{ close(): Promise<void> }>;
  close(): Promise<void>;
};

type DenyTarget = { host: string; port: number; ip?: string | null | undefined };

/**
 * What a refusal says. A 403 or 502 carries what was blocked and how to change it as the reason phrase of the status
 * line, because that is the one thing HTTP clients print (`ProxyError: 403 <phrase>`), and again in the body and in
 * `X-Bastion-Egress-Detail`.
 */
const denyResponse = (
  reason: DenyReason,
  target?: DenyTarget,
): { code: number; phrase: string; headers: Array<[string, string]>; body: string } => {
  const detail = denyDetail(reason, target ?? { host: 'the host', port: 0 }).replace(
    /[^\x20-\x7e]/g,
    '?',
  );
  const informative = reason === 'not-allowlisted' || reason === 'ssrf-blocked';
  const [code, phrase]: [number, string] =
    reason === 'bad-credentials' || reason === 'unknown-instance'
      ? [407, 'Proxy Authentication Required']
      : reason === 'bad-request'
        ? [400, 'Bad Request']
        : reason === 'unresolvable' || reason === 'connect-failed'
          ? [502, target ? detail : 'Bad Gateway']
          : [403, informative && target ? detail : 'Forbidden'];
  const body = `bastion egress: ${reason}: ${detail}\n`;
  return {
    code,
    phrase,
    headers: [
      ['Content-Length', String(Buffer.byteLength(body))],
      ['Content-Type', 'text/plain'],
      ['X-Bastion-Egress-Reason', reason],
      ['X-Bastion-Egress-Detail', detail],
      ['Connection', 'close'],
      ...(code === 407
        ? [['Proxy-Authenticate', 'Basic realm="bastion-egress"'] satisfies [string, string]]
        : []),
    ],
    body,
  };
};

export const createEgressProxy = (options: EgressProxyOptions): EgressProxy => {
  const resolver = options.resolver ?? systemResolver;
  const clock = options.clock ?? systemClock;
  const mirrors = buildMirrorRules(options.mirrorUrls ?? []);
  const connectTimeout = options.connectTimeoutMs ?? SANDBOX_TIMEOUTS_MS.egressConnect;
  const resolveTimeout = options.resolveTimeoutMs ?? SANDBOX_TIMEOUTS_MS.egressResolve;
  const idleTimeout = options.idleTimeoutMs ?? SANDBOX_TIMEOUTS_MS.egressIdle;
  const openServers = new Set<http.Server>();
  const openSockets = new Set<net.Socket>();

  const connectTo = (address: string, port: number): net.Socket =>
    options.connect
      ? options.connect({ host: address, port })
      : net.connect({ host: address, port });

  const track = (socket: net.Socket): void => {
    openSockets.add(socket);
    socket.once('close', () => openSockets.delete(socket));
  };

  const resolveOnce = async (host: string): Promise<string[]> => {
    if (net.isIP(host)) return [host];
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        resolver(host),
        new Promise<string[]>((_, reject) => {
          timer = setTimeout(() => reject(new Error('DNS timeout')), resolveTimeout);
          timer.unref();
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const emitAudit = (event: EgressAuditEvent): void => {
    const sampled = shouldAudit(event.decision, {
      ...(options.allowedSampleRate === undefined
        ? {}
        : { allowedRate: options.allowedSampleRate }),
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
    | { allowed: true; address: string; via: 'allowlist' | 'mirror' | 'cidr' }
    | { allowed: false; reason: DenyReason };

  const evaluate = async (
    identity: Identity,
    target: { host: string; port: number },
    protocol: EgressProtocol,
  ): Promise<Outcome & { resolvedIp: string | null }> => {
    const host = canonicalHost(target.host);
    // A name no rule allows is refused before any DNS lookup, unless a CIDR rule could still allow its address.
    if (
      !matchName({
        host,
        port: target.port,
        protocol,
        policy: identity.policy,
        mirrorRules: mirrors,
      }).allowed &&
      cidrRules(identity.policy.allow).length === 0
    ) {
      return { allowed: false, reason: 'not-allowlisted', resolvedIp: null };
    }
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

  const identifyByHeader = (header: string | undefined) => async (): Promise<IdentifyResult> => {
    const creds = parseProxyAuthorization(header);
    if (!creds) return 'bad-credentials';
    const policy = await options.policies.get(creds.instanceId);
    if (!policy) return 'unknown-instance';
    return verifyEgressToken(creds.token, policy.tokenSha256)
      ? { instanceId: creds.instanceId, policy }
      : 'bad-credentials';
  };

  const identifyFixed =
    (instanceId: string) => async (): Promise<Identity | 'unknown-instance'> => {
      const policy = await options.policies.get(instanceId);
      return policy ? { instanceId, policy } : 'unknown-instance';
    };

  /** Writes a refusal as a status line, headers and body: to a raw socket (CONNECT) or to a response (plain HTTP). */
  const deny = (
    socket: net.Socket | http.ServerResponse,
    reason: DenyReason,
    target?: { host: string; port: number; ip?: string | null | undefined },
  ): void => {
    const { code, phrase, headers, body } = denyResponse(reason, target);
    if (socket instanceof http.ServerResponse) {
      socket.statusMessage = phrase;
      socket.writeHead(code, Object.fromEntries(headers));
      socket.end(body);
    } else {
      const lines = headers.map(([name, value]) => `${name}: ${value}`).join('\r\n');
      socket.end(`HTTP/1.1 ${code} ${phrase}\r\n${lines}\r\n\r\n${body}`);
    }
  };

  /** One audit record and span per connection; settles at most once. */
  const beginAudit = (
    identity: Identity,
    protocol: EgressProtocol,
    host: string,
    port: number,
  ): {
    counters: Counters;
    settle(
      resolvedIp: string | null,
      decision: 'allow' | 'deny',
      reason: EgressAuditEvent['reason'],
    ): boolean;
  } => {
    const counters: Counters = { up: 0, down: 0 };
    const span = tracer().startSpan(
      `egress ${protocol === 'connect' ? 'CONNECT' : 'HTTP'} ${host}`,
      {
        attributes: {
          'bastion.instance.id': identity.instanceId,
          'net.peer.name': host,
          'net.peer.port': port,
        },
      },
    );
    const startedAt = clock.now();
    let settled = false;
    return {
      counters,
      settle(resolvedIp, decision, reason) {
        if (settled) return false;
        settled = true;
        const durationMs = clock.now() - startedAt;
        span.setAttributes({
          'bastion.egress.decision': decision,
          'bastion.egress.reason': reason ?? '',
          'bastion.egress.resolved_ip': resolvedIp ?? '',
          'bastion.egress.bytes_up': counters.up,
          'bastion.egress.bytes_down': counters.down,
        });
        if (decision === 'deny') span.setStatus({ code: SpanStatusCode.ERROR });
        span.end();
        emitAudit({
          instanceId: identity.instanceId,
          protocol,
          host,
          port,
          resolvedIp,
          decision,
          ...(reason ? { reason } : {}),
          bytesUp: counters.up,
          bytesDown: counters.down,
          durationMs,
          ts: startedAt,
        });
        return true;
      },
    };
  };

  const handleConnect = async (
    identify: Identify,
    req: http.IncomingMessage,
    client: net.Socket,
    head: Buffer,
  ): Promise<void> => {
    client.on('error', () => client.destroy());
    const parsed = parseHostPort(req.url ?? '', 443);
    const identity = await identify();
    if (typeof identity === 'string') return deny(client, identity);
    if (!parsed) return deny(client, 'bad-request');
    const audit = beginAudit(identity, 'connect', parsed.host, parsed.port);
    const { counters } = audit;
    const outcome = await evaluate(identity, parsed, 'connect');
    if (!outcome.allowed) {
      audit.settle(outcome.resolvedIp, 'deny', outcome.reason);
      return deny(client, outcome.reason, { ...parsed, ip: outcome.resolvedIp });
    }
    const upstream = connectTo(outcome.address, parsed.port);
    track(client);
    track(upstream);
    let connected = false;
    // A connect that never completes must be torn down; the idle timeout starts only once connected.
    const connectTimer = setTimeout(
      () => upstream.destroy(new Error('connect timeout')),
      connectTimeout,
    );
    connectTimer.unref();
    upstream.once('error', () => {
      if (!connected) {
        audit.settle(outcome.resolvedIp, 'deny', 'connect-failed');
        deny(client, 'connect-failed', { ...parsed, ip: outcome.resolvedIp });
      }
      client.destroy();
    });
    upstream.once('connect', () => {
      connected = true;
      clearTimeout(connectTimer);
      upstream.setTimeout(idleTimeout, () => upstream.destroy());
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
      clearTimeout(connectTimer);
      client.destroy();
      upstream.destroy();
      if (connected) audit.settle(outcome.resolvedIp, 'allow', outcome.via);
    };
    client.once('close', teardown);
    upstream.once('close', teardown);
  };

  const handleRequest = async (
    identify: Identify,
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> => {
    const identity = await identify();
    if (typeof identity === 'string') {
      req.resume();
      return deny(res, identity);
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
    const audit = beginAudit(identity, 'http', host, port);
    const { counters } = audit;
    const outcome = await evaluate(identity, { host, port }, 'http');
    if (!outcome.allowed) {
      req.resume();
      audit.settle(outcome.resolvedIp, 'deny', outcome.reason);
      return deny(res, outcome.reason, { host, port, ip: outcome.resolvedIp });
    }
    const upstream = http.request({
      host: outcome.address, // the address resolved once above: DNS rebinding cannot redirect it
      port,
      method: req.method ?? 'GET',
      path: `${url.pathname}${url.search}`,
      headers: { ...withoutHopByHop(req.headers), host: url.host },
      setHost: false,
      timeout: connectTimeout,
      agent: false,
    });
    req.on('data', (chunk: Buffer) => {
      counters.up += chunk.length;
    });
    upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
    upstream.on('error', () => {
      if (!audit.settle(outcome.resolvedIp, 'deny', 'connect-failed')) return;
      if (!res.headersSent) deny(res, 'connect-failed', { host, port, ip: outcome.resolvedIp });
      else res.destroy();
    });
    upstream.on('response', (up) => {
      res.writeHead(up.statusCode ?? 502, withoutHopByHop(up.headers));
      up.on('data', (chunk: Buffer) => {
        counters.down += chunk.length;
      });
      up.on('end', () => audit.settle(outcome.resolvedIp, 'allow', outcome.via));
      up.on('error', () => res.destroy());
      up.pipe(res);
    });
    res.on('close', () => {
      upstream.destroy();
      audit.settle(outcome.resolvedIp, 'allow', outcome.via);
    });
    req.pipe(upstream);
  };

  const makeServer = (identifyFor: (req: http.IncomingMessage) => Identify): http.Server => {
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
      // The socket lives in a directory only this user can enter, so there is no window between listen and chmod.
      const dir = path.dirname(socketPath);
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await chmod(dir, 0o700).catch(() => {});
      await rm(socketPath, { force: true });
      const server = makeServer(() => identifyFixed(instanceId));
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, () => resolve());
      });
      return { close: () => closeServer(server) };
    },
    async close() {
      for (const socket of openSockets) socket.destroy();
      await Promise.all([...openServers].map(closeServer));
    },
  };
};
