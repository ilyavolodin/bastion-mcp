import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { OpRunner } from '../src/adapters/contracts';
import { defaultRun, type Harness, startHarness } from './legacy-harness';

let h: Harness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

describe('6.5 legacy fan-out with the real TS SDK v2 legacy client', () => {
  it('6.5 initialize, list, and a call whose input_required reaches the client elicitation handler and completes on retry', async () => {
    const run: OpRunner = async (method, params, ctx) => {
      if (method === 'tools/call') {
        const answers = params.inputResponses as { q?: { content?: { n?: string } } } | undefined;
        if (!answers) {
          return {
            kind: 'input_required',
            inputRequests: {
              q: {
                method: 'elicitation/create',
                params: {
                  message: 'name?',
                  requestedSchema: { type: 'object', properties: { n: { type: 'string' } } },
                },
              },
            },
            requestState: 'bst1.x',
            installationId: 'inst-a',
          };
        }
        return {
          kind: 'complete',
          result: { content: [{ type: 'text', text: `hello ${answers.q?.content?.n}` }] },
        };
      }
      if (method === 'tools/list') {
        return {
          kind: 'complete',
          result: { tools: [{ name: 't', inputSchema: { type: 'object' } }] },
        };
      }
      return defaultRun(method, params, ctx);
    };
    h = await startHarness({ run });
    const client = new Client(
      { name: 'sdk', version: '1' },
      {
        capabilities: { elicitation: { form: {} } },
        versionNegotiation: { mode: 'legacy' },
      },
    );
    const asked: string[] = [];
    client.setRequestHandler('elicitation/create', async (request) => {
      asked.push(String((request.params as { message?: string }).message));
      return { action: 'accept', content: { n: 'Ada' } };
    });
    await client.connect(new StreamableHTTPClientTransport(new URL(h.url)));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toEqual(['t']);
    const result = await client.callTool({ name: 't', arguments: {} });
    expect(asked).toEqual(['name?']);
    expect(result.content).toEqual([{ type: 'text', text: 'hello Ada' }]);
    await client.close();
  });
});
