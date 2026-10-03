import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  inputRequired,
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import { z } from 'zod';
import { readJsonBody, startHttp } from '../http';

/**
 * A modern (2026-07-28) remote MCP server for tests (6.4, 6.5, 6.6): tools, resources, prompts, an
 * `input_required` tool, progress, a slow tool, and a list_changed / resources/updated trigger.
 */

export type RecordedRequest = {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

export type FakeModernServer = {
  url: string;
  port: number;
  /** HTTP requests received, in order. */
  requests: RecordedRequest[];
  /** Number of slow-tool calls that observed an abort. */
  aborted: string[];
  /** Number of `server/discover` probes seen. */
  discoverCount: () => number;
  toolsChanged: () => void;
  resourceUpdated: (uri: string) => void;
  /** Require this bearer token; other requests get 401. */
  setRequiredToken: (token: string | undefined) => void;
  close: () => Promise<void>;
};

export const startFakeModernServer = async (
  options: { hugeResultBytes?: number } = {},
): Promise<FakeModernServer> => {
  const requests: RecordedRequest[] = [];
  const aborted: string[] = [];
  let discover = 0;
  let requiredToken: string | undefined;

  const build = (): McpServer => {
    const server = new McpServer(
      { name: 'fake-modern', version: '1.0.0' },
      {
        capabilities: {
          tools: { listChanged: true },
          resources: { subscribe: true, listChanged: true },
        },
      },
    );
    server.registerTool(
      'echo',
      { description: 'Echo text', inputSchema: z.object({ text: z.string() }) },
      ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    server.registerTool('whoami', { description: 'Returns the request _meta' }, (ctx) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            ...(ctx.mcpReq._meta ?? {}),
            envelope: ctx.mcpReq.envelope ?? {},
          }),
        },
      ],
    }));
    server.registerTool(
      'ask',
      { description: 'Asks the user a question (MRTR)', inputSchema: z.object({ q: z.string() }) },
      ({ q }, ctx) => {
        const answer = ctx.mcpReq.inputResponses?.name as
          | { action?: string; content?: { name?: string } }
          | undefined;
        if (answer?.action === 'accept') {
          return {
            content: [
              {
                type: 'text',
                text: `hello ${answer.content?.name ?? '?'} state=${String(ctx.mcpReq.requestState())}`,
              },
            ],
          };
        }
        return inputRequired({
          inputRequests: {
            name: inputRequired.elicit({
              message: q,
              requestedSchema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
            }),
          },
          requestState: 'upstream-state-1',
        });
      },
    );
    server.registerTool(
      'slow',
      { description: 'Waits for ms or abort', inputSchema: z.object({ ms: z.number() }) },
      async ({ ms }, ctx) => {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          ctx.mcpReq.signal.addEventListener('abort', () => {
            aborted.push('slow');
            clearTimeout(timer);
            resolve();
          });
        });
        return { content: [{ type: 'text', text: 'done' }] };
      },
    );
    server.registerTool(
      'progress',
      { description: 'Emits progress', inputSchema: z.object({ steps: z.number() }) },
      async ({ steps }, ctx) => {
        const token = ctx.mcpReq._meta?.progressToken;
        for (let i = 1; i <= steps; i += 1) {
          if (token !== undefined) {
            await ctx.mcpReq.notify({
              method: 'notifications/progress',
              params: { progressToken: token, progress: i, total: steps },
            });
          }
        }
        return { content: [{ type: 'text', text: `progress ${steps}` }] };
      },
    );
    server.registerTool(
      'widget',
      {
        description: 'A tool with an MCP Apps UI',
        _meta: {
          ui: {
            resourceUri: 'ui://widget/main',
            csp: { connectDomains: ['https://api.example.com'] },
          },
        },
      },
      () => ({ content: [{ type: 'text', text: 'widget' }] }),
    );
    server.registerResource(
      'widget-ui',
      'ui://widget/main',
      {
        description: 'The widget',
        mimeType: 'text/html;profile=mcp-app',
        _meta: { ui: { csp: { frameDomains: [] } } },
      },
      (uri) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/html;profile=mcp-app',
            text: '<html><body>widget</body></html>',
          },
        ],
      }),
    );
    server.registerTool('huge', { description: 'Returns a huge text' }, () => ({
      content: [{ type: 'text', text: 'x'.repeat(options.hugeResultBytes ?? 1024) }],
    }));
    server.registerResource(
      'static',
      'test://static',
      { description: 'A static resource', mimeType: 'text/plain' },
      (uri) => ({ contents: [{ uri: uri.href, text: 'static body' }] }),
    );
    server.registerResource(
      'item',
      new ResourceTemplate('test://items/{id}', { list: undefined }),
      { description: 'Item template' },
      (uri) => ({ contents: [{ uri: uri.href, text: `item ${uri.pathname}` }] }),
    );
    server.registerPrompt(
      'greet',
      { description: 'Greets', argsSchema: z.object({ who: z.string() }) },
      ({ who }) => ({ messages: [{ role: 'user', content: { type: 'text', text: `hi ${who}` } }] }),
    );
    return server;
  };

  const handler = createMcpHandler(() => build(), { legacy: 'reject' });
  const node = toNodeHandler(handler);

  const server = await startHttp(async (req, res) => {
    const body = await readJsonBody(req);
    requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
    if (
      typeof body === 'object' &&
      body !== null &&
      (body as { method?: string }).method === 'server/discover'
    ) {
      discover += 1;
    }
    if (requiredToken !== undefined && req.headers.authorization !== `Bearer ${requiredToken}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    await node(req as never, res, body);
  });

  return {
    url: `${server.url}/mcp`,
    port: server.port,
    requests,
    aborted,
    discoverCount: () => discover,
    toolsChanged: () => handler.notify.toolsChanged(),
    resourceUpdated: (uri) => handler.notify.resourceUpdated(uri),
    setRequiredToken: (token) => {
      requiredToken = token;
    },
    close: async () => {
      await handler.close();
      await server.close();
    },
  };
};
