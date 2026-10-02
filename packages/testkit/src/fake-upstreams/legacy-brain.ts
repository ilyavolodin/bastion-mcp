/**
 * Transport-independent behavior of the legacy (2025-era and 2024-11-05) fake upstream servers: a small
 * JSON-RPC MCP server with tools, resources, prompts, subscriptions and server-to-client requests.
 */

export type JsonRpcId = string | number;
export type JsonObject = { [key: string]: unknown };

export type LegacyConnection = {
  /** Sends a server-to-client request and resolves with the client's `result` (rejects on `error`). */
  sendRequest: (method: string, params: JsonObject) => Promise<unknown>;
  /** Sends a notification related to the current request (progress, log). */
  notifyRelated: (method: string, params: JsonObject) => void;
};

export type LegacySessionState = {
  clientInfo?: unknown;
  clientCapabilities?: unknown;
  protocolVersion?: string;
  subscriptions: Set<string>;
};

export type LegacyReply = { result: unknown } | { error: { code: number; message: string } };

export const LEGACY_TOOLS = [
  {
    name: 'echo',
    description: 'Echo text',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
  },
  { name: 'whoami', description: 'Returns client identity', inputSchema: { type: 'object' } },
  {
    name: 'ask',
    description: 'Elicits a name from the user',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
  {
    name: 'ask2',
    description: 'Elicits twice in parallel',
    inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
  },
  { name: 'sample', description: 'Requests sampling', inputSchema: { type: 'object' } },
  { name: 'roots', description: 'Lists client roots', inputSchema: { type: 'object' } },
  {
    name: 'slow',
    description: 'Waits for ms',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } } },
  },
  {
    name: 'progress',
    description: 'Emits progress',
    inputSchema: { type: 'object', properties: { steps: { type: 'number' } } },
  },
] as const;

export const brainMeta = (params: unknown): JsonObject => {
  const meta = (params as { _meta?: unknown } | undefined)?._meta;
  return typeof meta === 'object' && meta !== null ? (meta as JsonObject) : {};
};

const text = (value: string): unknown => ({ content: [{ type: 'text', text: value }] });

export type LegacyBrainOptions = {
  /** Called when a client subscribes or unsubscribes. */
  onSubscribe?: (uri: string, subscribed: boolean) => void;
  /** Extra server version string, reported in `serverInfo`. */
  version?: string;
  listTtlMs?: number;
};

export const createLegacyBrain = (options: LegacyBrainOptions = {}) => {
  const calls: { method: string; params: unknown }[] = [];

  const handle = async (
    state: LegacySessionState,
    method: string,
    params: JsonObject | undefined,
    connection: LegacyConnection,
  ): Promise<LegacyReply> => {
    calls.push({ method, params });
    switch (method) {
      case 'initialize': {
        const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '';
        state.protocolVersion = ['2025-06-18', '2025-03-26', '2024-11-05'].includes(requested)
          ? requested
          : '2025-06-18';
        state.clientInfo = params?.clientInfo;
        state.clientCapabilities = params?.capabilities;
        return {
          result: {
            protocolVersion: state.protocolVersion,
            capabilities: {
              tools: { listChanged: true },
              resources: { subscribe: true, listChanged: true },
              prompts: {},
              completions: {},
            },
            serverInfo: { name: 'fake-legacy', version: options.version ?? '1.0.0' },
            instructions: 'fake legacy instructions',
          },
        };
      }
      case 'ping':
        return { result: {} };
      case 'tools/list':
        return {
          result: {
            tools: LEGACY_TOOLS,
            ...(options.listTtlMs === undefined ? {} : { ttlMs: options.listTtlMs }),
          },
        };
      case 'resources/list':
        return {
          result: { resources: [{ uri: 'test://static', name: 'static', mimeType: 'text/plain' }] },
        };
      case 'resources/templates/list':
        return {
          result: { resourceTemplates: [{ uriTemplate: 'test://items/{id}', name: 'item' }] },
        };
      case 'prompts/list':
        return {
          result: {
            prompts: [{ name: 'greet', arguments: [{ name: 'who', required: true }] }],
          },
        };
      case 'prompts/get':
        return {
          result: {
            messages: [
              {
                role: 'user',
                content: {
                  type: 'text',
                  text: `hi ${String((params?.arguments as JsonObject | undefined)?.who)}`,
                },
              },
            ],
          },
        };
      case 'resources/read': {
        const uri = String(params?.uri);
        return { result: { contents: [{ uri, text: `legacy body of ${uri}` }] } };
      }
      case 'resources/subscribe':
        state.subscriptions.add(String(params?.uri));
        options.onSubscribe?.(String(params?.uri), true);
        return { result: {} };
      case 'resources/unsubscribe':
        state.subscriptions.delete(String(params?.uri));
        options.onSubscribe?.(String(params?.uri), false);
        return { result: {} };
      case 'completion/complete':
        return { result: { completion: { values: ['alpha', 'beta'] } } };
      case 'tools/call':
        return callTool(state, params ?? {}, connection);
      default:
        return { error: { code: -32601, message: `Method not found: ${method}` } };
    }
  };

  const callTool = async (
    state: LegacySessionState,
    params: JsonObject,
    connection: LegacyConnection,
  ): Promise<LegacyReply> => {
    const args = (params.arguments as JsonObject | undefined) ?? {};
    switch (params.name) {
      case 'echo':
        return { result: text(String(args.text ?? '')) };
      case 'whoami':
        return {
          result: text(
            JSON.stringify({
              clientInfo: state.clientInfo,
              capabilities: state.clientCapabilities,
              meta: brainMeta(params),
            }),
          ),
        };
      case 'ask': {
        const answer = (await connection.sendRequest('elicitation/create', {
          message: String(args.q ?? 'name?'),
          requestedSchema: { type: 'object', properties: { name: { type: 'string' } } },
        })) as { action?: string; content?: { name?: string } };
        return {
          result: text(
            answer.action === 'accept'
              ? `hello ${answer.content?.name ?? '?'}`
              : `action:${String(answer.action)}`,
          ),
        };
      }
      case 'ask2': {
        const make = (n: number) =>
          connection.sendRequest('elicitation/create', {
            message: `${String(args.q ?? 'q')} ${n}`,
            requestedSchema: { type: 'object', properties: { v: { type: 'string' } } },
          }) as Promise<{ action?: string; content?: { v?: string } }>;
        const [a, b] = await Promise.all([make(1), make(2)]);
        return { result: text(`${a.content?.v ?? a.action}+${b.content?.v ?? b.action}`) };
      }
      case 'sample': {
        try {
          const out = (await connection.sendRequest('sampling/createMessage', {
            messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
            maxTokens: 10,
          })) as { content?: { text?: string } };
          return { result: text(`sampled:${out.content?.text ?? ''}`) };
        } catch (error) {
          return { result: text(`sample-error:${(error as { code?: number }).code ?? 'x'}`) };
        }
      }
      case 'roots': {
        try {
          const out = (await connection.sendRequest('roots/list', {})) as {
            roots?: { uri: string }[];
          };
          return { result: text(`roots:${(out.roots ?? []).map((r) => r.uri).join(',')}`) };
        } catch (error) {
          return { result: text(`roots-error:${(error as { code?: number }).code ?? 'x'}`) };
        }
      }
      case 'slow':
        await new Promise((resolve) => setTimeout(resolve, Number(args.ms ?? 100)));
        return { result: text('done') };
      case 'progress': {
        const token = brainMeta(params).progressToken;
        const steps = Number(args.steps ?? 2);
        for (let i = 1; i <= steps; i += 1) {
          if (token !== undefined) {
            connection.notifyRelated('notifications/progress', {
              progressToken: token,
              progress: i,
              total: steps,
            });
          }
        }
        return { result: text(`progress ${steps}`) };
      }
      default:
        return { error: { code: -32602, message: `Unknown tool ${String(params.name)}` } };
    }
  };

  return { handle, calls };
};

export type LegacyBrain = ReturnType<typeof createLegacyBrain>;

/** Tools that need an open stream because they send server-to-client requests or notifications. */
export const STREAMING_TOOLS = new Set(['ask', 'ask2', 'sample', 'roots', 'progress']);
