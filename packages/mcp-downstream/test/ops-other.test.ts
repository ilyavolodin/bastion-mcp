import type { ProfileLayers } from '@bastion-mcp/guards';
import { wrapTaskId } from '@bastion-mcp/mcp-upstream';
import { parseOverrides } from '@bastion-mcp/overrides';
import type { EndpointPolicy } from '@bastion-mcp/router';
import { describe, expect, it } from 'vitest';
import type { SkillsProvider } from '../src/ports';
import type { JsonObject, OpContext } from '../src/types';
import {
  allowAllPolicy,
  buildEndpoint,
  installation,
  items,
  opContext,
  principal,
  uuidFor,
} from './helpers/fixtures';
import { keyring, makeOps, wrappedState } from './helpers/ops';

const setup = async (
  options: {
    policy?: EndpointPolicy;
    overrides?: unknown;
    guardLayers?: ProfileLayers;
    skills?: SkillsProvider;
    single?: boolean;
    uriPrefix?: boolean;
  } = {},
) => {
  const parsed = options.overrides === undefined ? undefined : parseOverrides(options.overrides);
  const inst = installation('github', { layers: parsed?.ok ? { installation: parsed.doc } : {} });
  const resolved = await buildEndpoint({
    installations: [inst],
    items: { [inst.id]: items() },
    ...(options.policy ? { policy: options.policy } : {}),
    ...(options.single
      ? {
          endpoint: {
            id: `i:${inst.id}`,
            kind: 'installation' as const,
            installationIds: [inst.id],
            prefixMode: 'onCollision' as const,
          },
        }
      : {}),
  });
  const ops = makeOps({
    policy: options.policy,
    guardLayers: options.guardLayers,
    skills: options.skills,
    installations: {
      get: async (id) =>
        id === inst.id ? ({ installationId: id, roots: [], variables: {} } as never) : null,
    },
  });
  const ctx = (o: Partial<OpContext> = {}) => opContext(resolved, o);
  return { inst, resolved, ops, ctx };
};

const complete = (out: unknown): JsonObject => {
  const o = out as { kind: string; result?: JsonObject };
  if (o.kind !== 'complete') throw new Error(`expected complete, got ${o.kind}`);
  return o.result as JsonObject;
};

const deny = (action: string): EndpointPolicy => ({
  ...allowAllPolicy,
  authorize: (req) => ({
    decision: req.action === action ? 'deny' : 'allow',
    reasons: ['p1'],
    errors: [],
  }),
});

describe('6.3 prompts/get', () => {
  it('6.3 routes to the installation and the upstream prompt name and returns the messages', async () => {
    const { ops, ctx, inst } = await setup();
    ops.upstream.script = () => ({
      kind: 'complete',
      result: { messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }] },
    });
    const r = complete(
      await ops.run('prompts/get', { name: 'github__greet', arguments: { who: 'ada' } }, ctx()),
    );
    expect((r.messages as unknown[]).length).toBe(1);
    expect(ops.upstream.calls[0]).toMatchObject({
      installationId: inst.id,
      method: 'prompts/get',
      params: { name: 'greet', arguments: { who: 'ada' } },
    });
    expect(ops.rows[0]).toMatchObject({
      method: 'prompts/get',
      itemName: 'github__greet',
      upstreamName: 'greet',
    });
  });

  it('6.9 an unknown prompt is -32602', async () => {
    const { ops, ctx } = await setup();
    await expect(ops.run('prompts/get', { name: 'nope' }, ctx())).rejects.toMatchObject({
      mcpCode: -32602,
    });
  });

  it('6.9 policy denial on prompts/get is a JSON-RPC error with -32010, not a tool result', async () => {
    const { ops, ctx } = await setup({ policy: deny('getPrompt') });
    await expect(
      ops.run('prompts/get', { name: 'github__greet', arguments: { who: 'a' } }, ctx()),
    ).rejects.toMatchObject({
      mcpCode: -32010,
      data: { policyIds: ['p1'] },
    });
    expect(ops.rows[0]?.outcome).toBe('denied');
  });

  it('12.4 pinned prompt arguments win and messagesTransform prepends and appends', async () => {
    const { ops, ctx } = await setup({
      overrides: {
        version: 1,
        prompts: {
          greet: {
            arguments: { who: { pinned: 'pinned-user' } },
            messagesTransform: {
              prepend: [{ role: 'user', content: { type: 'text', text: 'first' } }],
              append: [{ role: 'assistant', content: { type: 'text', text: 'last' } }],
            },
          },
        },
      },
    });
    ops.upstream.script = () => ({
      kind: 'complete',
      result: { messages: [{ role: 'user', content: { type: 'text', text: 'mid' } }] },
    });
    const r = complete(
      await ops.run('prompts/get', { name: 'github__greet', arguments: { who: 'x' } }, ctx()),
    );
    expect(ops.upstream.calls[0]?.params.arguments).toEqual({ who: 'pinned-user' });
    expect((r.messages as { content: { text: string } }[]).map((m) => m.content.text)).toEqual([
      'first',
      'mid',
      'last',
    ]);
  });

  it('13.2 response guards redact prompt messages', async () => {
    const { ops, ctx } = await setup({
      guardLayers: {
        org: {
          guards: [
            {
              instanceId: 'g',
              type: 'regex',
              config: {
                rules: [
                  {
                    id: 'r',
                    label: 'k',
                    pattern: 'sk-[0-9]+',
                    phases: ['response'],
                    action: 'redact',
                  },
                ],
              },
            },
          ],
        },
      },
    });
    ops.upstream.script = () => ({
      kind: 'complete',
      result: { messages: [{ role: 'user', content: { type: 'text', text: 'key sk-123 end' } }] },
    });
    const r = complete(
      await ops.run('prompts/get', { name: 'github__greet', arguments: { who: 'a' } }, ctx()),
    );
    expect(JSON.stringify(r.messages)).toContain('[REDACTED:k]');
  });

  it('6.5 prompts/get supports input_required with a wrapped state', async () => {
    const { ops, ctx, inst } = await setup();
    ops.upstream.script = () => ({
      kind: 'input_required',
      inputRequests: {
        a: {
          method: 'elicitation/create',
          params: {
            message: 'm',
            mode: 'form',
            requestedSchema: { type: 'object', properties: {} },
          },
        },
      },
      requestState: wrappedState(ctx(), inst.id, 'prompts/get', 'github__greet', { who: 'a' }),
    });
    const out = await ops.run(
      'prompts/get',
      { name: 'github__greet', arguments: { who: 'a' } },
      ctx({ clientCapabilities: { elicitation: { form: {} } } }),
    );
    expect(out.kind).toBe('input_required');
  });
});

describe('6.3 7.4 resources/read', () => {
  it('7.4 routes an exact URI from resources/list and strips nothing', async () => {
    const { ops, ctx, inst } = await setup();
    ops.upstream.script = () => ({
      kind: 'complete',
      result: { contents: [{ uri: 'test://static', text: 'body' }] },
    });
    const r = complete(await ops.run('resources/read', { uri: 'test://static' }, ctx()));
    expect(ops.upstream.calls[0]).toMatchObject({
      installationId: inst.id,
      method: 'resources/read',
      params: { uri: 'test://static' },
    });
    expect(r.ttlMs).toBe(60_000);
    expect(r.cacheScope).toBe('private');
  });

  it('7.4 routes a template match and a seen URI', async () => {
    const { ops, ctx, inst } = await setup();
    await ops.run('resources/read', { uri: 'test://items/42' }, ctx());
    expect(ops.upstream.calls[0]?.installationId).toBe(inst.id);
    await ops.seen.record(principal().id, 'default', [
      { uri: 'file:///seen.txt', installationId: inst.id },
    ]);
    await ops.run('resources/read', { uri: 'file:///seen.txt' }, ctx());
    expect(ops.upstream.calls[1]?.params.uri).toBe('file:///seen.txt');
  });

  it('7.4 6.9 a URI that matches nothing is -32602', async () => {
    const { ops, ctx } = await setup();
    await expect(ops.run('resources/read', { uri: 'nope://x' }, ctx())).rejects.toMatchObject({
      mcpCode: -32602,
    });
    expect(ops.upstream.calls).toHaveLength(0);
  });

  it('7.4 strips the bastion+slug: prefix of a rewritten URI before the upstream sees it', async () => {
    const { ops, ctx } = await setup({ overrides: { version: 1, uriPrefix: true } });
    ops.upstream.script = () => ({
      kind: 'complete',
      result: { contents: [{ uri: 'test://static', text: 'x' }] },
    });
    await ops.run('resources/read', { uri: 'bastion+github:test://static' }, ctx());
    expect(ops.upstream.calls[0]?.params.uri).toBe('test://static');
  });

  it('6.9 policy denial on resources/read is a JSON-RPC error', async () => {
    const { ops, ctx } = await setup({ policy: deny('readResource') });
    await expect(ops.run('resources/read', { uri: 'test://static' }, ctx())).rejects.toMatchObject({
      mcpCode: -32010,
    });
  });

  it('6.8 MCP Apps: ui:// resources and _meta.ui pass through unchanged and html bodies skip the guards', async () => {
    const { ops, ctx } = await setup({
      guardLayers: {
        org: {
          guards: [
            {
              instanceId: 'g',
              type: 'regex',
              config: {
                rules: [
                  {
                    id: 'r',
                    pattern: '<script',
                    phases: ['response'],
                    action: 'block',
                    verdict: 'malicious',
                  },
                ],
              },
            },
          ],
        },
      },
    });
    await ops.seen.record(principal().id, 'default', [
      { uri: 'ui://widget/main', installationId: installation('github').id },
    ]);
    const body = {
      contents: [
        {
          uri: 'ui://widget/main',
          mimeType: 'text/html;profile=mcp-app',
          text: '<script>1</script>',
          _meta: { ui: { csp: { connectDomains: ['https://a'] } } },
        },
      ],
    };
    ops.upstream.script = () => ({ kind: 'complete', result: body });
    const r = complete(await ops.run('resources/read', { uri: 'ui://widget/main' }, ctx()));
    expect((r.contents as JsonObject[])[0]).toEqual(body.contents[0]);
  });

  it('6.7 serves a cached public read without calling the upstream, still guarded', async () => {
    const reads = new Map<string, unknown>();
    const inst = installation('github');
    const resolved = await buildEndpoint({ installations: [inst], items: { [inst.id]: items() } });
    const ops = makeOps({
      reads: {
        get: async (i, u) => reads.get(`${i}:${u}`),
        put: async (i, u, r) => {
          reads.set(`${i}:${u}`, r);
          return true;
        },
      },
      guardLayers: {
        org: {
          guards: [
            {
              instanceId: 'g',
              type: 'regex',
              config: {
                rules: [
                  {
                    id: 'r',
                    label: 'k',
                    pattern: 'sk-[0-9]+',
                    phases: ['response'],
                    action: 'redact',
                  },
                ],
              },
            },
          ],
        },
      },
    });
    ops.upstream.script = () => ({
      kind: 'complete',
      result: {
        contents: [{ uri: 'test://static', text: 'sk-123' }],
        ttlMs: 5000,
        cacheScope: 'public',
      },
    });
    await ops.run('resources/read', { uri: 'test://static' }, opContext(resolved));
    const second = complete(
      await ops.run('resources/read', { uri: 'test://static' }, opContext(resolved)),
    );
    expect(ops.upstream.calls).toHaveLength(1);
    expect(JSON.stringify(second)).toContain('[REDACTED:k]');
    expect(second.cacheScope).toBe('private');
  });

  it('6.3 skill:// URIs are served by the SkillsProvider and unknown ones are -32602', async () => {
    const skills: SkillsProvider = {
      list: async () => ({ skills: [] }),
      get: async () => undefined,
      readResource: async (_p, uri) =>
        uri === 'skill://p/s/SKILL.md' ? { contents: [{ uri, text: '# s' }] } : undefined,
    };
    const { ops, ctx } = await setup({ skills });
    const r = complete(await ops.run('resources/read', { uri: 'skill://p/s/SKILL.md' }, ctx()));
    expect((r.contents as JsonObject[])[0]?.text).toBe('# s');
    await expect(
      ops.run('resources/read', { uri: 'skill://p/other/SKILL.md' }, ctx()),
    ).rejects.toMatchObject({ mcpCode: -32602 });
    expect(ops.upstream.calls).toHaveLength(0);
  });
});

describe('6.3 completion/complete', () => {
  it('6.3 routes by the prompt name in ref and maps it to the upstream name', async () => {
    const { ops, ctx, inst } = await setup();
    ops.upstream.script = () => ({ kind: 'complete', result: { completion: { values: ['a'] } } });
    const r = complete(
      await ops.run(
        'completion/complete',
        {
          ref: { type: 'ref/prompt', name: 'github__greet' },
          argument: { name: 'who', value: 'a' },
        },
        ctx(),
      ),
    );
    expect(r).toEqual({ completion: { values: ['a'] } });
    expect(ops.upstream.calls[0]).toMatchObject({
      installationId: inst.id,
      params: { ref: { type: 'ref/prompt', name: 'greet' } },
    });
    expect(ops.rows[0]?.method).toBe('completion/complete');
  });

  it('6.3 routes by the template URI in ref', async () => {
    const { ops, ctx, inst } = await setup();
    await ops.run(
      'completion/complete',
      {
        ref: { type: 'ref/resource', uri: 'test://items/{id}' },
        argument: { name: 'id', value: '1' },
      },
      ctx(),
    );
    expect(ops.upstream.calls[0]?.installationId).toBe(inst.id);
  });

  it('6.9 an unknown ref is -32602 and a denied one -32010', async () => {
    const { ops, ctx } = await setup();
    await expect(
      ops.run(
        'completion/complete',
        { ref: { type: 'ref/prompt', name: 'nope' }, argument: { name: 'x', value: '' } },
        ctx(),
      ),
    ).rejects.toMatchObject({ mcpCode: -32602 });
    const denied = await setup({ policy: deny('complete') });
    await expect(
      denied.ops.run(
        'completion/complete',
        {
          ref: { type: 'ref/prompt', name: 'github__greet' },
          argument: { name: 'who', value: '' },
        },
        denied.ctx(),
      ),
    ).rejects.toMatchObject({ mcpCode: -32010 });
  });
});

describe('6.6 resources/subscribe, unsubscribe and logging/setLevel', () => {
  it('6.6 subscribe registers the subscription with the owner for the routed installation', async () => {
    const { ops, ctx, inst } = await setup();
    const out = await ops.run(
      'resources/subscribe',
      { uri: 'test://static' },
      ctx({ era: 'legacy' }),
    );
    expect(out).toEqual({ kind: 'complete', result: {} });
    expect(ops.upstream.subscriptions).toHaveLength(1);
    expect(ops.upstream.subscriptions[0]).toMatchObject({
      action: 'add',
      args: {
        installationId: inst.id,
        downstreamUri: 'test://static',
        endpointId: 'default',
        principal: { userId: principal().id },
      },
    });
    await ops.run('resources/unsubscribe', { uri: 'test://static' }, ctx({ era: 'legacy' }));
    expect(ops.upstream.subscriptions[1]?.action).toBe('remove');
  });

  it('6.6 subscribing to an unreadable URI is -32602 and a denied subscription -32010', async () => {
    const { ops, ctx } = await setup();
    await expect(ops.run('resources/subscribe', { uri: 'nope://x' }, ctx())).rejects.toMatchObject({
      mcpCode: -32602,
    });
    const denied = await setup({ policy: deny('subscribeResource') });
    await expect(
      denied.ops.run('resources/subscribe', { uri: 'test://static' }, denied.ctx()),
    ).rejects.toMatchObject({ mcpCode: -32010 });
  });

  it('6.3 logging/setLevel validates the level', async () => {
    const { ops, ctx } = await setup();
    expect(await ops.run('logging/setLevel', { level: 'warning' }, ctx({ era: 'legacy' }))).toEqual(
      { kind: 'complete', result: {} },
    );
    await expect(
      ops.run('logging/setLevel', { level: 'loud' }, ctx({ era: 'legacy' })),
    ).rejects.toMatchObject({ mcpCode: -32602 });
  });
});

describe('6.8 tasks/get, tasks/update, tasks/cancel', () => {
  const taskFor = (ctx: OpContext, installationId: string, principalId = ctx.principal.id) =>
    wrapTaskId(keyring, {
      principalId,
      installationId,
      upstreamTaskId: 'up-1',
      nowSeconds: Math.floor(Date.now() / 1000),
    });

  it('6.8 routes by the wrapped id to the installation and returns the upstream answer', async () => {
    const { ops, ctx, inst } = await setup();
    const id = taskFor(ctx(), inst.id);
    ops.upstream.taskScript = () => ({
      kind: 'complete',
      result: { taskId: id, status: 'working' },
    });
    const r = complete(await ops.run('tasks/get', { taskId: id }, ctx()));
    expect(r.status).toBe('working');
    expect(ops.upstream.taskCalls[0]).toMatchObject({
      method: 'tasks/get',
      params: { taskId: id },
    });
  });

  it('6.8 22.1 a task id of another user, a forged id and an id of an installation outside the endpoint are -32602', async () => {
    const { ops, ctx, inst } = await setup();
    const other = taskFor(ctx(), inst.id, uuidFor('someone-else'));
    for (const id of [other, 'btk1.forged', taskFor(ctx(), uuidFor('not-in-endpoint'))]) {
      await expect(ops.run('tasks/get', { taskId: id }, ctx())).rejects.toMatchObject({
        mcpCode: -32602,
      });
    }
    expect(ops.upstream.taskCalls).toHaveLength(0);
  });

  it('6.8 response guards run on the terminal result of tasks/get', async () => {
    const { ops, ctx, inst } = await setup({
      guardLayers: {
        org: {
          guards: [
            {
              instanceId: 'g',
              type: 'regex',
              config: {
                rules: [
                  {
                    id: 'r',
                    label: 'k',
                    pattern: 'sk-[0-9]+',
                    phases: ['response'],
                    action: 'redact',
                  },
                ],
              },
            },
          ],
        },
      },
    });
    const id = taskFor(ctx(), inst.id);
    ops.upstream.taskScript = () => ({
      kind: 'complete',
      result: {
        taskId: id,
        status: 'completed',
        result: { content: [{ type: 'text', text: 'secret sk-999 x' }] },
      },
    });
    const r = complete(await ops.run('tasks/get', { taskId: id }, ctx()));
    expect(JSON.stringify(r)).toContain('[REDACTED:k]');
    expect(JSON.stringify(r)).not.toContain('sk-999');
  });

  it('6.8 inputRequests of a task pass the response guards and inputResponses of tasks/update pass the request guards', async () => {
    const { ops, ctx, inst } = await setup({
      guardLayers: {
        org: {
          guards: [
            {
              instanceId: 'g',
              type: 'regex',
              config: {
                rules: [
                  {
                    id: 'resp',
                    pattern: 'BADREQ',
                    phases: ['response'],
                    action: 'block',
                    verdict: 'malicious',
                  },
                  {
                    id: 'req',
                    pattern: 'BADRESP',
                    phases: ['request'],
                    action: 'block',
                    verdict: 'malicious',
                  },
                ],
              },
            },
          ],
        },
      },
    });
    const id = taskFor(ctx(), inst.id);
    ops.upstream.taskScript = () => ({
      kind: 'complete',
      result: {
        taskId: id,
        status: 'input_required',
        inputRequests: { a: { method: 'elicitation/create', params: { message: 'BADREQ' } } },
      },
    });
    await expect(ops.run('tasks/get', { taskId: id }, ctx())).rejects.toMatchObject({
      mcpCode: -32013,
    });
    await expect(
      ops.run(
        'tasks/update',
        { taskId: id, inputResponses: { a: { action: 'accept', content: { v: 'BADRESP' } } } },
        ctx(),
      ),
    ).rejects.toMatchObject({ mcpCode: -32013 });
    expect(ops.upstream.taskCalls.filter((c) => c.method === 'tasks/update')).toHaveLength(0);
  });

  it('6.8 15.5 a terminal task writes one call-log row with its status and a running poll writes none', async () => {
    const { ops, ctx, inst } = await setup();
    const id = taskFor(ctx(), inst.id);
    ops.upstream.taskScript = () => ({
      kind: 'complete',
      result: { taskId: id, status: 'working' },
    });
    await ops.run('tasks/get', { taskId: id }, ctx());
    expect(ops.rows).toHaveLength(0);
    ops.upstream.taskScript = () => ({
      kind: 'complete',
      result: { taskId: id, status: 'completed', result: { content: [] } },
    });
    await ops.run('tasks/get', { taskId: id }, ctx());
    expect(ops.rows).toHaveLength(1);
    expect(ops.rows[0]).toMatchObject({
      method: 'tasks/get',
      outcome: 'ok',
      installationId: inst.id,
    });
    expect(ops.rows[0]?.resultPreview).toEqual({ taskStatus: 'completed' });
  });

  it('6.8 tasks/cancel and tasks/update route the same way', async () => {
    const { ops, ctx, inst } = await setup();
    const id = taskFor(ctx(), inst.id);
    ops.upstream.taskScript = () => ({
      kind: 'complete',
      result: { taskId: id, status: 'cancelled' },
    });
    await ops.run('tasks/cancel', { taskId: id }, ctx());
    await ops.run('tasks/update', { taskId: id, inputResponses: {} }, ctx());
    expect(ops.upstream.taskCalls.map((c) => c.method)).toEqual(['tasks/cancel', 'tasks/update']);
  });
});

describe('6.8 25.8 skills', () => {
  const skills: SkillsProvider = {
    list: async () => ({
      skills: [{ name: 'review', description: 'd', uri: 'skill://p/review/SKILL.md', plugin: 'p' }],
    }),
    get: async (_p, ref) =>
      'uri' in ref && ref.uri === 'skill://p/review/SKILL.md'
        ? { name: 'review', files: [] }
        : undefined,
    readResource: async () => undefined,
  };

  it('25.8 skills/list answers the Bastion-hosted skills on aggregate endpoints without forwarding', async () => {
    const { ops, ctx } = await setup({ skills });
    const r = complete(await ops.run('skills/list', {}, ctx()));
    expect((r.skills as unknown[]).length).toBe(1);
    expect(ops.upstream.calls).toHaveLength(0);
  });

  it('25.8 single-installation endpoints also merge the upstream skills', async () => {
    const { ops, ctx } = await setup({ skills, single: true });
    ops.upstream.script = () => ({
      kind: 'complete',
      result: { skills: [{ name: 'up', uri: 'skill://up/up/SKILL.md' }] },
    });
    const r = complete(await ops.run('skills/list', {}, ctx()));
    expect((r.skills as unknown[]).length).toBe(2);
  });

  it('6.8 skills/get serves hosted skills, forwards on single endpoints and is -32602 elsewhere', async () => {
    const { ops, ctx } = await setup({ skills });
    expect(
      complete(await ops.run('skills/get', { uri: 'skill://p/review/SKILL.md' }, ctx())),
    ).toMatchObject({ name: 'review' });
    await expect(
      ops.run('skills/get', { uri: 'skill://p/missing/SKILL.md' }, ctx()),
    ).rejects.toMatchObject({ mcpCode: -32602 });
    const single = await setup({ skills, single: true });
    single.ops.upstream.script = () => ({ kind: 'complete', result: { name: 'upstream-skill' } });
    expect(
      complete(await single.ops.run('skills/get', { uri: 'skill://up/x/SKILL.md' }, single.ctx())),
    ).toEqual({ name: 'upstream-skill' });
    await expect(ops.run('skills/get', {}, ctx())).rejects.toMatchObject({ mcpCode: -32602 });
  });
});
