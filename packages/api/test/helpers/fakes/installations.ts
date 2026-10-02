import type { ApiDeps, EgressEntry, TryRequest } from '../../../src/ports';
import type { FakeCtx } from '../harness';

/** Recording fakes of the installation ports (11.4, 11.5). */
export const makeFakeInstallations = () => {
  const calls = {
    restart: [] as string[],
    connect: [] as Array<{ installationId: string; principalId: string; returnTo?: string }>,
    disconnect: [] as Array<{ installationId: string; principalId: string }>,
    tried: [] as Array<{ installationId: string; principalId: string; request: TryRequest }>,
    listed: [] as Array<{ installationId: string; principalId: string }>,
  };
  let logLines = ['starting', 'listening on stdio'];
  const egress: EgressEntry[] = [
    { ts: '2026-06-01T12:00:00.000Z', host: 'api.example.com', port: 443, decision: 'allowed' },
  ];
  let degraded: string | null = null;
  const deps: ApiDeps['installations'] = {
    definitions: {
      async listItems(installationId, principalId) {
        calls.listed.push({ installationId, principalId });
        if (degraded) return { status: 'degraded', code: degraded };
        return {
          status: 'ok',
          items: {
            tools: [
              {
                name: 'search',
                description: 'Search the index',
                inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
              },
              { name: 'delete', description: 'Delete a thing', inputSchema: { type: 'object' } },
            ],
            prompts: [{ name: 'summarize', description: 'Summarize' }],
            resources: [{ uri: 'file:///a.txt', name: 'a' }],
            resourceTemplates: [{ uriTemplate: 'file:///{path}', name: 'files' }],
            instructions: 'Use the search tool first.',
          },
        };
      },
    },
    connect: {
      async begin(input) {
        calls.connect.push(input);
        return {
          authorizationUrl: `https://auth.example.com/authorize?state=${input.installationId}`,
        };
      },
      async disconnect(input) {
        calls.disconnect.push(input);
      },
    },
    tryCall: {
      async run(input) {
        calls.tried.push({
          installationId: input.installationId,
          principalId: input.principalId,
          request: input.request,
        });
        return {
          result: { content: [{ type: 'text', text: 'ok' }] },
          isError: false,
          durationMs: 3,
          callId: 'call-1',
        };
      },
    },
    runtime: {
      async restart(id) {
        calls.restart.push(id);
      },
      async logTail(_id, tail) {
        return logLines.slice(-tail);
      },
      async egress(_id, limit) {
        return egress.slice(0, limit);
      },
    },
  };
  return {
    deps,
    calls,
    setLogLines: (lines: string[]) => {
      logLines = lines;
    },
    setDegraded: (code: string | null) => {
      degraded = code;
    },
  };
};

export const fakeInstallationsDeps = (_ctx: FakeCtx): Partial<ApiDeps> => ({
  installations: makeFakeInstallations().deps,
});
