import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { coldStartUrl, type RunConfig } from './args';
import { pace } from './pacing';
import { fromSummary, type ResultFile } from './results';
import { summarize } from './stats';

/**
 * The generator. It talks to Bastion with the official TypeScript SDK client (`@modelcontextprotocol/client`
 * 2.2.0, pinned in package.json), era `auto`, with a PAT as bearer token. Not executed in the authoring
 * environment: no Bastion server existed to point it at (see docs/admin-guide.md, "Validation status").
 */

const connect = async (url: string, token: string): Promise<Client> => {
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    authProvider: { token: async () => token },
  });
  const client = new Client(
    { name: 'bastion-load', version: '0.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );
  await client.connect(transport);
  return client;
};

const connectPool = (url: string, token: string, size: number): Promise<Client[]> =>
  Promise.all(Array.from({ length: size }, () => connect(url, token)));

const closeAll = async (clients: readonly Client[]): Promise<void> => {
  await Promise.allSettled(clients.map((c) => c.close()));
};

const timed = async (fn: () => Promise<unknown>): Promise<number> => {
  const start = performance.now();
  await fn();
  return performance.now() - start;
};

const pickClient = (pool: readonly Client[], index: number): Client => {
  const client = pool[index % pool.length];
  if (!client) throw new Error('empty connection pool');
  return client;
};

type Series = ReturnType<typeof summarize>;

const runPaced = async (
  url: string,
  cfg: RunConfig,
  op: (client: Client) => Promise<unknown>,
  durationSec: number,
): Promise<{ summary: Series; achievedRate: number; skipped: number }> => {
  const pool = await connectPool(url, cfg.token, cfg.connections);
  try {
    const result = await pace({
      rate: cfg.rate,
      durationSec,
      maxInflight: cfg.maxInflight,
      fire: (i) => timed(() => op(pickClient(pool, i))),
    });
    const completed = result.latenciesMs.length + result.errors;
    return {
      summary: summarize(result.latenciesMs, result.errors),
      achievedRate: result.wallSec > 0 ? completed / result.wallSec : 0,
      skipped: result.skipped,
    };
  } finally {
    await closeAll(pool);
  }
};

const callOp = (cfg: RunConfig) => (client: Client) =>
  client.callTool({ name: cfg.tool, arguments: cfg.toolArguments });

const base = (cfg: RunConfig): Omit<ResultFile, 'series'> => ({
  schema: 1,
  scenario: cfg.scenario.id,
  startedAt: new Date().toISOString(),
  durationSec: cfg.durationSec,
  config: {
    url: cfg.url,
    directUrl: cfg.directUrl,
    tool: cfg.tool,
    connections: cfg.connections,
    maxInflight: cfg.maxInflight,
  },
});

/** call-guards-off and call-guards-default: via Bastion and direct to the upstream, same rate and payload. */
const runCalls = async (cfg: RunConfig): Promise<ResultFile> => {
  if (cfg.skipBaseline) {
    // Traffic-only run for chaos and upgrade tests: no baseline, so `check` will (correctly) not certify it.
    const via = await runPaced(cfg.url, cfg, callOp(cfg), cfg.durationSec);
    return {
      ...base(cfg),
      offeredRate: cfg.rate,
      achievedRate: via.achievedRate,
      series: { via: fromSummary(via.summary) },
    };
  }
  if (!cfg.directUrl) throw new Error('direct-url is required');
  // Baseline first (shorter: only the percentiles matter), then the measured run.
  const directDuration = Math.min(cfg.durationSec, 60);
  await runPaced(cfg.url, cfg, callOp(cfg), 5); // warm-up, discarded
  const direct = await runPaced(cfg.directUrl, cfg, callOp(cfg), directDuration);
  const via = await runPaced(cfg.url, cfg, callOp(cfg), cfg.durationSec);
  return {
    ...base(cfg),
    offeredRate: cfg.rate,
    achievedRate: via.achievedRate,
    series: { via: fromSummary(via.summary), direct: fromSummary(direct.summary) },
  };
};

const runList = async (cfg: RunConfig): Promise<ResultFile> => {
  const listOp = (client: Client) => client.listTools();
  await runPaced(cfg.url, cfg, listOp, 10); // warm the list cache
  const via = await runPaced(cfg.url, cfg, listOp, cfg.durationSec);
  return {
    ...base(cfg),
    offeredRate: cfg.rate,
    achievedRate: via.achievedRate,
    series: { via: fromSummary(via.summary) },
  };
};

/** One fresh installation (and therefore one cold sandbox start) per iteration; first call latency is the sample. */
const runColdStart = async (cfg: RunConfig): Promise<ResultFile> => {
  const latencies: number[] = [];
  let errors = 0;
  const started = Date.now();
  for (let i = 0; i < cfg.iterations; i += 1) {
    const url = coldStartUrl(cfg.url, cfg.coldSlugTemplate, i);
    try {
      const client = await connect(url, cfg.token);
      try {
        latencies.push(
          await timed(() => client.callTool({ name: cfg.tool, arguments: cfg.toolArguments })),
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    } catch {
      errors += 1;
    }
  }
  return {
    ...base(cfg),
    durationSec: (Date.now() - started) / 1000,
    series: { via: fromSummary(summarize(latencies, errors)) },
  };
};

/** Opens `streams` subscriptions/listen streams, holds them, and counts every stream that ended without our close. */
const runListen = async (cfg: RunConfig): Promise<ResultFile> => {
  const urls = cfg.streamUrls.length > 0 ? cfg.streamUrls : [cfg.url];
  const clients: Client[] = [];
  let dropped = 0;
  let failedToOpen = 0;
  const watchers: Promise<void>[] = [];
  const openRate = 200; // streams per second, so the ramp does not look like a connection flood
  const started = Date.now();
  for (let i = 0; i < cfg.streams; i += 1) {
    const url = urls[i % urls.length];
    if (!url) throw new Error('no stream url');
    try {
      const client = await connect(url, cfg.token);
      const subscription = await client.listen({ toolsListChanged: true });
      clients.push(client);
      watchers.push(
        subscription.closed.then((reason) => {
          if (reason !== 'local') dropped += 1;
        }),
      );
    } catch {
      failedToOpen += 1;
    }
    if (i % openRate === openRate - 1) await new Promise((r) => setTimeout(r, 1000));
  }
  const opened = clients.length;
  const holdMs = Math.max(0, cfg.durationSec * 1000 - (Date.now() - started));
  await new Promise((r) => setTimeout(r, holdMs));
  const elapsed = (Date.now() - started) / 1000;
  await closeAll(clients); // closes the streams ('local'), which is not counted as a drop
  await Promise.allSettled(watchers);
  return {
    ...base(cfg),
    durationSec: elapsed,
    series: {},
    streams: { opened, dropped, failedToOpen },
  };
};

/** The same call to the instance owner pod and to a non-owner pod (forwarded over internal RPC, 21.2). */
const runForwarded = async (cfg: RunConfig): Promise<ResultFile> => {
  if (!cfg.ownerUrl || !cfg.nonOwnerUrl)
    throw new Error('owner-url and non-owner-url are required');
  const half = Math.max(30, Math.floor(cfg.durationSec / 2));
  await runPaced(cfg.ownerUrl, cfg, callOp(cfg), 5);
  const ownerLocal = await runPaced(cfg.ownerUrl, cfg, callOp(cfg), half);
  const forwarded = await runPaced(cfg.nonOwnerUrl, cfg, callOp(cfg), half);
  return {
    ...base(cfg),
    durationSec: half * 2,
    offeredRate: cfg.rate,
    achievedRate: Math.min(ownerLocal.achievedRate, forwarded.achievedRate),
    series: {
      ownerLocal: fromSummary(ownerLocal.summary),
      forwarded: fromSummary(forwarded.summary),
    },
  };
};

export const runScenario = (cfg: RunConfig): Promise<ResultFile> => {
  switch (cfg.scenario.id) {
    case 'call-guards-off':
    case 'call-guards-default':
      return runCalls(cfg);
    case 'list-30':
      return runList(cfg);
    case 'cold-start':
      return runColdStart(cfg);
    case 'listen-streams':
      return runListen(cfg);
    case 'forwarded-calls':
      return runForwarded(cfg);
  }
};
