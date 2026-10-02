import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  createMcpHandler,
  fromJsonSchema,
  inputRequired,
  McpServer,
  ResourceTemplate,
} from '@modelcontextprotocol/server';
import { z } from 'zod';

/**
 * A modern (2026-07-28) remote MCP server that implements what the official conformance suite
 * (`@modelcontextprotocol/conformance`, server scenarios) expects of an "everything" server: tool, resource, prompt and
 * completion names and shapes, with sampling and elicitation expressed as multi round trip `input_required` results.
 */

export type FakeEverythingServer = {
  url: string;
  port: number;
  toolsChanged: () => void;
  resourceUpdated: (uri: string) => void;
  close: () => Promise<void>;
};

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const WAV = 'UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=';

const text = (value: string) => ({ content: [{ type: 'text' as const, text: value }] });

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const build = (): McpServer => {
  const server = new McpServer({ name: 'everything', version: '1.0.0' });

  server.registerTool('test_simple_text', { description: 'Simple text' }, () =>
    text('This is a simple text response for testing.'),
  );
  server.registerTool('test_image_content', { description: 'Image content' }, () => ({
    content: [{ type: 'image' as const, data: PNG, mimeType: 'image/png' }],
  }));
  server.registerTool('test_audio_content', { description: 'Audio content' }, () => ({
    content: [{ type: 'audio' as const, data: WAV, mimeType: 'audio/wav' }],
  }));
  server.registerTool('test_embedded_resource', { description: 'Embedded resource' }, () => ({
    content: [
      {
        type: 'resource' as const,
        resource: {
          uri: 'test://embedded-resource',
          mimeType: 'text/plain',
          text: 'This is an embedded resource content.',
        },
      },
    ],
  }));
  server.registerTool('test_multiple_content_types', { description: 'Mixed content' }, () => ({
    content: [
      { type: 'text' as const, text: 'Multiple content types test:' },
      { type: 'image' as const, data: PNG, mimeType: 'image/png' },
      {
        type: 'resource' as const,
        resource: {
          uri: 'test://mixed-content-resource',
          mimeType: 'application/json',
          text: JSON.stringify({ test: 'data', value: 123 }),
        },
      },
    ],
  }));
  server.registerTool('test_error_handling', { description: 'Always fails' }, () => ({
    isError: true,
    content: [{ type: 'text' as const, text: 'This tool intentionally returns an error for testing' }],
  }));
  server.registerTool('test_tool_with_logging', { description: 'Logs while running' }, async (ctx) => {
    await ctx.mcpReq.log('info', 'Tool execution started');
    await sleep(50);
    await ctx.mcpReq.log('info', 'Tool processing data');
    await sleep(50);
    await ctx.mcpReq.log('info', 'Tool execution completed');
    return text('Tool execution completed with logging');
  });
  server.registerTool('test_tool_with_progress', { description: 'Reports progress' }, async (ctx) => {
    const token = ctx.mcpReq._meta?.progressToken;
    for (const progress of [0, 50, 100]) {
      if (token !== undefined) {
        await ctx.mcpReq.notify({
          method: 'notifications/progress',
          params: { progressToken: token, progress, total: 100 },
        });
      }
      await sleep(50);
    }
    return text('Tool execution completed with progress');
  });
  server.registerTool(
    'test_sampling',
    { description: 'Requests sampling', inputSchema: z.object({ prompt: z.string() }) },
    ({ prompt }, ctx) => {
      const answer = ctx.mcpReq.inputResponses?.sample as { content?: { text?: string } } | undefined;
      if (answer) return text(`LLM response: ${answer.content?.text ?? ''}`);
      return inputRequired({
        inputRequests: {
          sample: inputRequired.createMessage({
            messages: [{ role: 'user', content: { type: 'text', text: prompt } }],
            maxTokens: 100,
          }),
        },
        requestState: 'sampling',
      });
    },
  );
  const elicit = (
    name: string,
    message: string,
    requestedSchema: Record<string, unknown>,
    prefix: string,
  ): void => {
    server.registerTool(
      name,
      { description: `Elicits: ${name}`, inputSchema: z.object({ message: z.string().optional() }) },
      (args, ctx) => {
        const answer = ctx.mcpReq.inputResponses?.e as
          | { action?: string; content?: unknown }
          | undefined;
        if (answer) {
          return text(`${prefix}action=${String(answer.action)}, content=${JSON.stringify(answer.content)}`);
        }
        return inputRequired({
          inputRequests: {
            e: {
              method: 'elicitation/create',
              params: { message: args.message ?? message, mode: 'form', requestedSchema },
            },
          },
          requestState: 'elicit',
        } as never);
      },
    );
  };
  elicit(
    'test_elicitation',
    'Please provide your information',
    {
      type: 'object',
      properties: {
        username: { type: 'string', description: "User's response" },
        email: { type: 'string', description: "User's email address" },
      },
      required: ['username', 'email'],
    },
    'User response: ',
  );
  elicit(
    'test_elicitation_sep1034_defaults',
    'Provide values',
    {
      type: 'object',
      properties: {
        name: { type: 'string', default: 'John Doe' },
        age: { type: 'integer', default: 30 },
        score: { type: 'number', default: 95.5 },
        status: { type: 'string', enum: ['active', 'inactive', 'pending'], default: 'active' },
        verified: { type: 'boolean', default: true },
      },
    },
    'Elicitation completed: ',
  );
  elicit(
    'test_elicitation_sep1330_enums',
    'Choose options',
    {
      type: 'object',
      properties: {
        untitledSingle: { type: 'string', enum: ['option1', 'option2', 'option3'] },
        titledSingle: {
          type: 'string',
          oneOf: [
            { const: 'value1', title: 'First Option' },
            { const: 'value2', title: 'Second Option' },
          ],
        },
        legacyEnum: {
          type: 'string',
          enum: ['opt1', 'opt2', 'opt3'],
          enumNames: ['Option One', 'Option Two', 'Option Three'],
        },
        untitledMulti: { type: 'array', items: { type: 'string', enum: ['option1', 'option2', 'option3'] } },
        titledMulti: {
          type: 'array',
          items: {
            anyOf: [
              { const: 'value1', title: 'First Choice' },
              { const: 'value2', title: 'Second Choice' },
            ],
          },
        },
      },
    },
    'Elicitation completed: ',
  );
  server.registerTool(
    'test_slow',
    { description: 'Waits for ms or abort', inputSchema: z.object({ ms: z.number() }) },
    async ({ ms }, ctx) => {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        ctx.mcpReq.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return text('done');
    },
  );
  server.registerTool(
    'json_schema_2020_12_tool',
    {
      description: 'Tool with JSON Schema 2020-12 features',
      inputSchema: fromJsonSchema({
        $schema: 'https://json-schema.org/draft/2020-12/schema',
        type: 'object',
        $defs: {
          address: {
            type: 'object',
            properties: { street: { type: 'string' }, city: { type: 'string' } },
          },
        },
        properties: { name: { type: 'string' }, address: { $ref: '#/$defs/address' } },
        additionalProperties: false,
      }),
    },
    () => text('ok'),
  );

  server.registerResource(
    'static-text',
    'test://static-text',
    { description: 'Static text resource', mimeType: 'text/plain' },
    (uri) => ({
      contents: [
        { uri: uri.href, mimeType: 'text/plain', text: 'This is the content of the static text resource.' },
      ],
    }),
  );
  server.registerResource(
    'static-binary',
    'test://static-binary',
    { description: 'Static binary resource', mimeType: 'image/png' },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'image/png', blob: PNG }] }),
  );
  server.registerResource(
    'watched-resource',
    'test://watched-resource',
    { description: 'A resource that can be subscribed to', mimeType: 'text/plain' },
    (uri) => ({ contents: [{ uri: uri.href, mimeType: 'text/plain', text: 'watched' }] }),
  );
  server.registerResource(
    'template',
    new ResourceTemplate('test://template/{id}/data', { list: undefined }),
    { description: 'Template resource', mimeType: 'application/json' },
    (uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify({
            id: String(variables.id),
            templateTest: true,
            data: `Data for ID: ${String(variables.id)}`,
          }),
        },
      ],
    }),
  );

  server.registerPrompt('test_simple_prompt', { description: 'Simple prompt' }, () => ({
    messages: [{ role: 'user', content: { type: 'text', text: 'This is a simple prompt for testing.' } }],
  }));
  server.registerPrompt(
    'test_prompt_with_arguments',
    {
      description: 'Prompt with arguments',
      argsSchema: z.object({ arg1: z.string(), arg2: z.string() }),
    },
    ({ arg1, arg2 }) => ({
      messages: [
        { role: 'user', content: { type: 'text', text: `Prompt with arguments: arg1='${arg1}', arg2='${arg2}'` } },
      ],
    }),
  );
  server.registerPrompt(
    'test_prompt_with_embedded_resource',
    { description: 'Prompt with a resource', argsSchema: z.object({ resourceUri: z.string() }) },
    ({ resourceUri }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'resource',
            resource: { uri: resourceUri, mimeType: 'text/plain', text: 'Embedded resource content for testing.' },
          },
        },
        { role: 'user', content: { type: 'text', text: 'Please process the embedded resource above.' } },
      ],
    }),
  );
  server.registerPrompt('test_prompt_with_image', { description: 'Prompt with an image' }, () => ({
    messages: [
      { role: 'user', content: { type: 'image', data: PNG, mimeType: 'image/png' } },
      { role: 'user', content: { type: 'text', text: 'Please analyze the image above.' } },
    ],
  }));

  server.server.registerCapabilities({ logging: {}, completions: {}, resources: { subscribe: true, listChanged: true } });
  server.server.setRequestHandler('completion/complete', () => ({
    completion: { values: ['paris', 'park', 'party'], total: 3, hasMore: false },
  }));
  return server;
};

export const startConformanceEverythingServer = async (): Promise<FakeEverythingServer> => {
  const handler = createMcpHandler(() => build(), { legacy: 'reject' });
  const node = toNodeHandler(handler);
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks);
      let body: unknown;
      try {
        body = raw.length > 0 ? JSON.parse(raw.toString('utf8')) : undefined;
      } catch {
        body = undefined;
      }
      await node(req as never, res, body);
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    port,
    toolsChanged: () => handler.notify.toolsChanged(),
    resourceUpdated: (uri) => handler.notify.resourceUpdated(uri),
    close: async () => {
      await handler.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
};
