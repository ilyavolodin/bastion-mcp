/** Raw JSON-RPC over HTTP against the gateway, for tests that need exact control of headers and envelopes. */
export type RawResponse = {
  status: number;
  headers: Headers;
  json:
    | {
        result?: Record<string, unknown>;
        error?: { code: number; message: string; data?: Record<string, unknown> };
      }
    | undefined;
  text: string;
};

const MODERN = '2026-07-28';

export const modernEnvelope = (
  capabilities: Record<string, unknown> = {},
  extra: Record<string, unknown> = {},
): Record<string, unknown> => ({
  'io.modelcontextprotocol/protocolVersion': MODERN,
  'io.modelcontextprotocol/clientInfo': { name: 'raw-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': capabilities,
  ...extra,
});

export const parseBody = (text: string): RawResponse['json'] => {
  if (text.startsWith('event:') || text.includes('\ndata:') || text.startsWith('data:')) {
    // SSE: the last data frame is the response.
    const frames = text
      .split('\n\n')
      .map((f) =>
        f
          .split('\n')
          .find((l) => l.startsWith('data:'))
          ?.slice(5)
          .trim(),
      )
      .filter((d): d is string => d !== undefined && d !== '');
    const last = frames.at(-1);
    return last ? (JSON.parse(last) as RawResponse['json']) : undefined;
  }
  try {
    return JSON.parse(text) as RawResponse['json'];
  } catch {
    return undefined;
  }
};

export const rawModern = async (
  base: string,
  options: {
    token?: string;
    path?: string;
    method: string;
    params?: Record<string, unknown>;
    capabilities?: Record<string, unknown>;
    headers?: Record<string, string>;
    name?: string;
    id?: number;
    meta?: Record<string, unknown>;
  },
): Promise<RawResponse> => {
  const body = {
    jsonrpc: '2.0',
    id: options.id ?? 1,
    method: options.method,
    params: {
      ...(options.params ?? {}),
      _meta: modernEnvelope(options.capabilities ?? {}, options.meta),
    },
  };
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': MODERN,
    'mcp-method': options.method,
    ...(options.name === undefined ? {} : { 'mcp-name': options.name }),
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...(options.headers ?? {}),
  };
  const res = await fetch(`${base}${options.path ?? '/mcp'}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: parseBody(text), text };
};

export const rawLegacy = async (
  base: string,
  options: {
    token?: string;
    path?: string;
    body: unknown;
    sessionId?: string;
    protocolVersion?: string;
    headers?: Record<string, string>;
    method?: string;
  },
): Promise<RawResponse> => {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(options.protocolVersion === undefined
      ? {}
      : { 'mcp-protocol-version': options.protocolVersion }),
    ...(options.sessionId === undefined ? {} : { 'mcp-session-id': options.sessionId }),
    ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
    ...(options.headers ?? {}),
  };
  const res = await fetch(`${base}${options.path ?? '/mcp'}`, {
    method: options.method ?? 'POST',
    headers,
    ...(options.method === 'GET' || options.method === 'DELETE'
      ? {}
      : { body: JSON.stringify(options.body) }),
  });
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: parseBody(text), text };
};
