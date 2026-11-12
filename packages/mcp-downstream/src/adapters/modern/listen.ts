/**
 * Bastion's own `subscriptions/listen` handler (6.6, 6.2): the modern adapter routes these POSTs here BEFORE the SDK,
 * because SDK bus events carry no audience and would reach every user's stream. The wire behavior mirrors the SDK's
 * own listen router: acknowledged-first, subscription-id stamping, SSE keepalive comments, graceful `complete`.
 */
import { JSONRPC_CODES } from '@bastion-mcp/core';
import type { CallPrincipal } from '@bastion-mcp/mcp-upstream';
import type { BastionMetrics } from '@bastion-mcp/telemetry';
import { z } from 'zod';
import type { BastionRequestContext } from '../../context';
import { notificationFor } from '../../notify-hub';
import { type Logger, noopLogger, type UpstreamPort } from '../../ports';
import type { Exchange, ListenAdapter, NotifyEvent, NotifyHubPort } from '../contracts';
import {
  classifyExchange,
  first,
  KEEPALIVE_MS,
  SERVER_INFO_KEY,
  sendResponse,
  sseCommentFrame,
  sseMessageFrame,
} from '../shared';

const SUBSCRIPTION_ID_KEY = 'io.modelcontextprotocol/subscriptionId';
const DEFAULT_MAX_LISTEN_STREAMS = 1024;

export type ListenAdapterDeps = {
  hub: NotifyHubPort;
  upstream: Pick<
    UpstreamPort,
    'subscribeResource' | 'unsubscribeResource' | 'joinListen' | 'leaveListen'
  >;
  /** Resolves a URI through the URI index and Cedar `readResource`; `ok: false` for anything the principal cannot read. */
  canReadUri: (
    rc: BastionRequestContext,
    uri: string,
  ) => Promise<{ ok: true; installationId: string } | { ok: false }>;
  metrics?: Pick<BastionMetrics, 'streamsActive'> | undefined;
  logger?: Logger | undefined;
  keepAliveMs?: number | undefined;
  maxStreams?: number | undefined;
};

const filterSchema = z.object({
  toolsListChanged: z.boolean().optional(),
  promptsListChanged: z.boolean().optional(),
  resourcesListChanged: z.boolean().optional(),
  resourceSubscriptions: z.array(z.string()).optional(),
});
type Filter = z.infer<typeof filterSchema>;

const bodySchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]),
  method: z.literal('subscriptions/listen'),
  params: z.looseObject({ notifications: z.unknown().optional() }).optional(),
});

const writeJson = sendResponse;

const rpcError = (id: unknown, code: number, message: string, data?: unknown) => ({
  jsonrpc: '2.0',
  error: { code, message, ...(data === undefined ? {} : { data }) },
  id: typeof id === 'string' || typeof id === 'number' ? id : null,
});

const callPrincipal = (rc: BastionRequestContext): CallPrincipal => ({
  userId: rc.principal.id,
  type: rc.principal.type,
  teams: rc.principal.teams.map((t) => t.teamId),
});

type Stream = { close: (graceful: boolean) => void };

type ListenRequest = {
  method: string | undefined;
  headers: Exchange['req']['headers'];
  body: unknown;
};

type ListenDecision =
  | { ok: true; subscriptionId: string | number; filter: Filter }
  | { ok: false; status: number; error: unknown; limitReached?: true };

/** Whether a `subscriptions/listen` POST is acceptable, in the order the wire contract checks it. No I/O. */
const parseListenRequest = (input: ListenRequest, atCapacity: boolean): ListenDecision => {
  const { headers, body } = input;
  const bodyId = (body as { id?: unknown } | null)?.id;
  const classified = classifyExchange({ method: input.method ?? 'POST', headers, body });
  if (classified.kind === 'reject') {
    return {
      ok: false,
      status: classified.httpStatus,
      error: rpcError(bodyId, classified.code, classified.message, classified.data),
    };
  }
  const parsed = bodySchema.safeParse(body);
  if (
    classified.kind !== 'modern' ||
    classified.messageKind !== 'request' ||
    !parsed.success ||
    first(headers['mcp-method']) !== 'subscriptions/listen'
  ) {
    return {
      ok: false,
      status: 400,
      error: rpcError(
        bodyId,
        JSONRPC_CODES.INVALID_REQUEST,
        'Invalid subscriptions/listen request',
      ),
    };
  }
  const subscriptionId = parsed.data.id;
  if (atCapacity) {
    return {
      ok: false,
      status: 200,
      error: rpcError(subscriptionId, JSONRPC_CODES.INTERNAL_ERROR, 'Subscription limit reached'),
      limitReached: true,
    };
  }
  const filter = filterSchema.safeParse(parsed.data.params?.notifications);
  if (!filter.success || parsed.data.params?.notifications === undefined) {
    return {
      ok: false,
      status: 200,
      error: rpcError(
        subscriptionId,
        JSONRPC_CODES.INVALID_PARAMS,
        "Invalid params: 'notifications' is required and must be a valid SubscriptionFilter",
      ),
    };
  }
  return { ok: true, subscriptionId, filter: filter.data };
};

export const createListenAdapter = (deps: ListenAdapterDeps): ListenAdapter => {
  const logger = deps.logger ?? noopLogger;
  const keepAliveMs = deps.keepAliveMs ?? KEEPALIVE_MS;
  const maxStreams = deps.maxStreams ?? DEFAULT_MAX_LISTEN_STREAMS;
  const open = new Set<Stream>();

  const gauge = (): void => {
    deps.metrics?.streamsActive.record(open.size, { era: 'modern', type: 'listen' });
  };

  const honoredFilter = async (
    rc: BastionRequestContext,
    filter: Filter,
  ): Promise<{ honored: Filter; installationByUri: Map<string, string> }> => {
    const caps = rc.resolved.endpoint.capabilities;
    const honored: Filter = {};
    if (filter.toolsListChanged === true && caps.tools?.listChanged === true) {
      honored.toolsListChanged = true;
    }
    if (filter.promptsListChanged === true && caps.prompts?.listChanged === true) {
      honored.promptsListChanged = true;
    }
    if (filter.resourcesListChanged === true && caps.resources?.listChanged === true) {
      honored.resourcesListChanged = true;
    }
    const installationByUri = new Map<string, string>();
    if (caps.resources?.subscribe === true && (filter.resourceSubscriptions?.length ?? 0) > 0) {
      for (const uri of new Set(filter.resourceSubscriptions)) {
        try {
          const verdict = await deps.canReadUri(rc, uri);
          if (verdict.ok) installationByUri.set(uri, verdict.installationId);
        } catch (error) {
          logger.warn('listen: could not check a resource subscription', { error: String(error) });
        }
      }
      if (installationByUri.size > 0) honored.resourceSubscriptions = [...installationByUri.keys()];
    }
    return { honored, installationByUri };
  };

  const accepts = (honored: Filter, event: NotifyEvent): boolean => {
    switch (event.kind) {
      case 'tools_list_changed':
        return honored.toolsListChanged === true;
      case 'prompts_list_changed':
        return honored.promptsListChanged === true;
      case 'resources_list_changed':
        return honored.resourcesListChanged === true;
      case 'resource_updated':
        return (
          event.uri !== undefined && (honored.resourceSubscriptions?.includes(event.uri) ?? false)
        );
    }
  };

  const handle = async ({ req, res, body, rc }: Exchange): Promise<void> => {
    const decision = parseListenRequest(
      { method: req.method, headers: req.headers, body },
      open.size >= maxStreams,
    );
    if (!decision.ok) {
      if (decision.limitReached) {
        logger.warn('subscriptions/listen refused: subscription limit reached');
      }
      writeJson(res, decision.status, decision.error);
      return;
    }
    const { subscriptionId } = decision;
    const { honored, installationByUri } = await honoredFilter(rc, decision.filter);
    const endpoint = rc.resolved.endpoint;
    const principal = callPrincipal(rc);
    const subscriptionArgs = (uri: string, installationId: string) => ({
      installationId,
      principal,
      downstreamUri: uri,
      endpointId: endpoint.endpointId,
    });

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    let closed = false;
    const writeFrame = (frame: string): void => {
      if (closed || res.writableEnded || res.destroyed) return;
      try {
        res.write(frame);
      } catch (error) {
        logger.warn('listen: write failed', { error: String(error) });
      }
    };
    const stamped = (method: string, params: Record<string, unknown> | undefined) => ({
      jsonrpc: '2.0',
      method,
      params: { ...params, _meta: { [SUBSCRIPTION_ID_KEY]: subscriptionId } },
    });
    const writeMessage = (message: unknown): void => {
      writeFrame(sseMessageFrame(message));
    };

    let unregister: (() => void) | undefined;
    let timer: ReturnType<typeof setInterval> | undefined;
    const joined: string[] = [];
    const subscribed = new Map<string, string>();
    const stream: Stream = {
      close: (graceful) => {
        if (closed) return;
        if (graceful) {
          writeMessage({
            jsonrpc: '2.0',
            id: subscriptionId,
            result: {
              resultType: 'complete',
              _meta: {
                [SUBSCRIPTION_ID_KEY]: subscriptionId,
                [SERVER_INFO_KEY]: endpoint.serverInfo,
              },
            },
          });
        }
        closed = true;
        unregister?.();
        if (timer) clearInterval(timer);
        open.delete(stream);
        gauge();
        for (const installationId of joined) {
          deps.upstream.leaveListen({ installationId, principal }).catch((error: unknown) => {
            logger.warn('listen: leave failed', { error: String(error) });
          });
        }
        for (const [uri, installationId] of subscribed) {
          deps.upstream
            .unsubscribeResource(subscriptionArgs(uri, installationId))
            .catch((error: unknown) => {
              logger.warn('listen: unsubscribe failed', { error: String(error) });
            });
        }
        if (!res.writableEnded) res.end();
      },
    };

    writeMessage(stamped('notifications/subscriptions/acknowledged', { notifications: honored }));
    if (Object.keys(honored).length === 0) {
      stream.close(true);
      return;
    }
    open.add(stream);
    gauge();
    unregister = deps.hub.register(
      {
        principalId: rc.principal.id,
        teamIds: rc.principal.teams.map((t) => t.teamId),
        endpointId: endpoint.endpointId,
      },
      (event) => {
        if (closed || !accepts(honored, event)) return;
        const note = notificationFor(event);
        writeMessage(stamped(note.method, note.params));
      },
    );
    timer = setInterval(() => writeFrame(sseCommentFrame('keepalive')), keepAliveMs);
    timer.unref();
    const onGone = (): void => stream.close(false);
    req.on('close', onGone);
    res.on('close', onGone);

    // Upstream interest (reference counts, 6.6): best effort, after the ack.
    if (honored.toolsListChanged || honored.promptsListChanged || honored.resourcesListChanged) {
      for (const installationId of rc.resolved.installations.keys()) {
        try {
          await deps.upstream.joinListen({ installationId, principal });
          if (closed) {
            await deps.upstream.leaveListen({ installationId, principal });
          } else joined.push(installationId);
        } catch (error) {
          logger.warn('listen: join failed', { installationId, error: String(error) });
        }
      }
    }
    for (const [uri, installationId] of installationByUri) {
      try {
        await deps.upstream.subscribeResource(subscriptionArgs(uri, installationId));
        if (closed) {
          await deps.upstream.unsubscribeResource(subscriptionArgs(uri, installationId));
        } else subscribed.set(uri, installationId);
      } catch (error) {
        logger.warn('listen: subscribe failed', { uri, error: String(error) });
      }
    }
  };

  return {
    handle,
    async shutdown() {
      for (const stream of [...open]) stream.close(true);
    },
    activeStreams: () => open.size,
  };
};
