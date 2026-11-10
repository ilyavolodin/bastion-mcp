import { type OverridesInput, overridesSchema } from '@bastion-mcp/overrides';
import { describe, expect, it } from 'vitest';
import {
  type CompileInput,
  compileEndpoint,
  type EndpointPolicy,
  serializeEndpoint,
  type UpstreamItemSource,
  type UpstreamItems,
  type UpstreamListResult,
} from '../src';
import { engineFor, installation, items, principal, requestContext, tool } from './helpers';

const doc = (o: Partial<OverridesInput>) => overridesSchema.parse({ version: 1, ...o });

const sourceOf = (map: Record<string, UpstreamItems | UpstreamListResult>): UpstreamItemSource => ({
  async listItems(inst) {
    const v = map[inst.id];
    if (!v) return { status: 'degraded', code: 'unavailable' };
    if ('status' in v) return v;
    return { status: 'ok', items: v, origin: 'cache' };
  },
});

/** One endpoint that touches every step of 7.2: overrides, hosted items, collisions, URI prefix, conflicts, degraded. */
const mixed = () => {
  const alpha = installation({
    id: 'a',
    slug: 'alpha',
    displayName: 'Alpha',
    capabilities: { tools: true, prompts: true, resources: true, subscribe: true },
    layers: {
      catalog: doc({
        tools: { secret: { hidden: true }, send: { pinnedArguments: { channel: 'C1' } } },
        added: {
          prompts: { review: { messages: [{ role: 'user', text: 'Review {{repo}}' }] } },
          resources: { 'notes://welcome': { name: 'welcome', text: 'Hello' } },
          resourceTemplates: { 'notes://page/{id}': { name: 'page', text: 'Page {{id}}' } },
        },
      }),
      installation: doc({
        tools: { send: { description: 'Send it' }, search: { name: 'find' } },
        prompts: { noisy: { hidden: true } },
      }),
    },
  });
  const beta = installation({
    id: 'b',
    slug: 'beta',
    displayName: 'Beta',
    capabilities: { tools: true, resources: true },
    layers: { installation: doc({ uriPrefix: true }) },
  });
  const gamma = installation({ id: 'c', slug: 'gamma', displayName: 'Gamma' });
  const delta = installation({ id: 'd', slug: 'delta', displayName: 'Delta', needsAuth: true });
  const epsilon = installation({
    id: 'e',
    slug: 'epsilon',
    displayName: 'Epsilon',
    capabilities: { resources: true },
  });
  const installations = [alpha, beta, gamma, delta, epsilon];
  const map = {
    a: items({
      tools: [
        tool('secret'),
        tool('send', {
          inputSchema: { type: 'object', properties: { channel: { type: 'string' } } },
        }),
        tool('search'),
        tool('widget', { _meta: { ui: { resourceUri: 'ui://widget' } } }),
      ],
      prompts: [{ name: 'noisy' }, { name: 'plain', description: 'upstream' }],
      resources: [
        { uri: 'file:///shared', name: 'shared' },
        { uri: 'file:///only-a', name: 'only-a' },
      ],
      resourceTemplates: [{ uriTemplate: 'repo://{o}/{r}', name: 'repo' }],
    }),
    b: items({
      tools: [tool('search'), tool('send')],
      prompts: [{ name: 'plain' }],
      resources: [
        { uri: 'file:///shared', name: 'shared-b' },
        { uri: 'file:///only-b', name: 'only-b' },
      ],
      resourceTemplates: [{ uriTemplate: 'file:///{p}', name: 'files' }],
    }),
    e: items({ resources: [{ uri: 'file:///only-a', name: 'dup' }] }),
  };
  return { installations, map };
};

const compile = (policy?: EndpointPolicy) => {
  const { installations, map } = mixed();
  const input: CompileInput = {
    principal,
    endpoint: { id: 'default', kind: 'default', prefixMode: 'onCollision' },
    installations,
    source: sourceOf(map),
    policy: policy ?? engineFor(installations),
    requestContext,
    org: { displayName: 'Acme' },
    serverVersion: '1.2.3',
    configVersion: '9',
  };
  return compileEndpoint(input);
};

describe('7.2 compiled endpoint over a mixed fixture (golden)', () => {
  it('7.2 serializeEndpoint of the whole endpoint stays byte-identical', async () => {
    const endpoint = await compile();
    expect(JSON.parse(serializeEndpoint(endpoint))).toMatchSnapshot();
  });

  it('7.2 the fixture really exercises collisions, conflicts, hosted items and degradation', async () => {
    const endpoint = await compile();
    expect(endpoint.collisions.length).toBeGreaterThan(0);
    expect(endpoint.warnings.some((w) => w.code === 'uri_conflict')).toBe(true);
    expect(endpoint.items.some((i) => i.added)).toBe(true);
    expect(endpoint.items.some((i) => i.overridden)).toBe(true);
    expect(endpoint.degraded.length + endpoint.needsAuth.length).toBeGreaterThan(0);
    expect(endpoint.resources.some((r) => r.uri.startsWith('bastion+beta:'))).toBe(true);
  });

  it('7.2 the policy is asked three times, in order: tools, prompts, then resources and templates together', async () => {
    const { installations } = mixed();
    const inner = engineFor(installations);
    const calls: Array<{ action: string; types: string[] }> = [];
    const seen: string[][] = [];
    const policy: EndpointPolicy = {
      authorize: (request) => inner.authorize(request),
      filterVisible: (request, resources) => {
        calls.push({
          action: request.action,
          types: resources.map((r) => (r as { type: string }).type),
        });
        seen.push(
          resources.map(
            (r) =>
              (r as { uri?: string; name?: string }).uri ?? (r as { name?: string }).name ?? '',
          ),
        );
        return inner.filterVisible(request, resources);
      },
    };
    await compile(policy);
    expect(calls.map((c) => c.action)).toEqual(['seeTool', 'seePrompt', 'seeResource']);
    expect(calls.map((c) => c.types.length)).toEqual([5, 3, 9]);
    expect(calls[2]?.types.every((t) => t === 'Resource')).toBe(true);
    expect(seen[2]).toEqual([
      'file:///shared',
      'file:///only-a',
      'notes://welcome',
      'file:///shared',
      'file:///only-b',
      'file:///only-a',
      'repo://{o}/{r}',
      'notes://page/{id}',
      'file:///{p}',
    ]);
  });
});
