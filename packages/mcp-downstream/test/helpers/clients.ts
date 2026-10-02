import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type { Stack, TestUser } from './stack';

export type ElicitHandler = (params: Record<string, unknown>) => Record<string, unknown>;
export type SamplingHandler = (params: Record<string, unknown>) => Record<string, unknown>;

export type ClientOptions = {
  path?: string;
  elicit?: ElicitHandler;
  sampling?: SamplingHandler;
  roots?: string[];
  era: 'modern' | 'legacy';
  name?: string;
  extensions?: Record<string, unknown>;
};

/** A TS SDK v2 client: `auto` negotiation lands on the modern era, `legacy` speaks the 2025 handshake. */
export const connectClient = async (
  stack: Pick<Stack, 'url'>,
  user: TestUser | { token: string },
  options: ClientOptions,
): Promise<Client> => {
  const capabilities: Record<string, unknown> = {
    ...(options.elicit ? { elicitation: { form: {}, url: {} } } : {}),
    ...(options.sampling ? { sampling: {} } : {}),
    ...(options.roots ? { roots: {} } : {}),
    ...(options.extensions ? { extensions: options.extensions } : {}),
  };
  const client = new Client(
    { name: options.name ?? `test-${options.era}`, version: '1.0.0' },
    {
      capabilities: capabilities as never,
      versionNegotiation: options.era === 'modern' ? { mode: 'auto' } : { mode: 'legacy' },
    },
  );
  if (options.elicit) {
    const handler = options.elicit;
    client.setRequestHandler('elicitation/create', (async (request: { params: Record<string, unknown> }) =>
      handler(request.params)) as never);
  }
  if (options.sampling) {
    const handler = options.sampling;
    client.setRequestHandler('sampling/createMessage', (async (request: { params: Record<string, unknown> }) =>
      handler(request.params)) as never);
  }
  if (options.roots) {
    const roots = options.roots;
    client.setRequestHandler('roots/list', (async () => ({ roots: roots.map((uri) => ({ uri })) })) as never);
  }
  const transport = new StreamableHTTPClientTransport(new URL(stack.url(options.path ?? '/mcp')), {
    requestInit: { headers: { Authorization: `Bearer ${user.token}` } },
  });
  await client.connect(transport);
  return client;
};

export const textOf = (result: unknown): string => {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? '').join('');
};
