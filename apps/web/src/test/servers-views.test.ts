import { describe, expect, it } from 'vitest';
import type { Schemas } from '@/api/schema';
import {
  defaultEndpointUrl,
  endpointUrl,
  groupEgress,
  installationUrl,
  revertChanges,
  secretStatus,
  specInfo,
  toCapabilities,
  toDefinitionPairs,
  toEndpointBody,
  toEndpointPatch,
  toInstallationView,
  toInstallBody,
  toStoreEntryDetailView,
  toStoreEntryView,
} from '@/api/views/servers';
import { parseLogLine } from '@/features/servers/tabs/logs-tab';

const remote = {
  type: 'remote',
  transport: 'streamable-http',
  url: 'https://mcp.jira.example.com/mcp',
  auth: { mode: 'oauth', client: { registration: 'auto' }, scopes: ['read', 'write'] },
};
const pkg = {
  type: 'package',
  runtime: 'npm',
  identifier: '@acme/pg-mcp',
  version: '3.2.0',
  egress: { allow: ['warehouse.acme.internal'] },
  auth: { mode: 'orgSecret', inject: [] },
};

const row = (over: Partial<Schemas['Installation']> = {}): Schemas['Installation'] => ({
  id: 'i-1',
  ownerType: 'user',
  ownerId: 'u-1',
  catalogEntryId: 'c-1',
  catalogVersionId: 'v-1',
  pinnedVersion: false,
  personalSpec: null,
  slug: 'jira',
  toolPrefix: 'jira',
  displayName: 'Jira',
  enabled: true,
  variables: {},
  secretRefs: {},
  overrides: {},
  origin: 'catalog',
  status: 'ready',
  statusDetail: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

describe('server spec (8.1)', () => {
  it('8.1 reads the runtime, sign-in mode and reach of a remote spec', () => {
    expect(specInfo(remote)).toMatchObject({
      runtime: 'remote',
      authMode: 'oauth',
      hosts: ['mcp.jira.example.com'],
      scopes: ['read', 'write'],
      sandboxed: false,
      version: null,
    });
  });

  it('8.1 reads a package spec: runtime, identifier, exact version and egress allowlist', () => {
    expect(specInfo(pkg)).toMatchObject({
      runtime: 'npm',
      target: '@acme/pg-mcp',
      version: '3.2.0',
      hosts: ['warehouse.acme.internal'],
      sandboxed: true,
      authMode: 'orgSecret',
    });
  });

  it('8.1 has nothing to say about skills and plugins, which have no spec', () => {
    expect(specInfo(null)).toBeNull();
    expect(specInfo({ nonsense: true })).toBeNull();
  });

  it('11.4 lists the fields of a userSecret sign-in', () => {
    const info = specInfo({
      ...remote,
      auth: { mode: 'userSecret', fields: [{ name: 'TOKEN', label: 'Token' }], inject: [] },
    });
    expect(info?.secretFields).toEqual([{ name: 'TOKEN', label: 'Token' }]);
  });
});

describe('installation view', () => {
  const lookups = {
    names: new Map([['t-1', 'Platform team']]),
    meId: 'u-1',
    versionLabels: new Map([['v-1', '1.8.2']]),
    specs: new Map([['v-1', specInfo(remote)]]),
  };

  it('7.1 joins the owner name, the version label and what the spec says', () => {
    const v = toInstallationView(row(), lookups);
    expect(v).toMatchObject({
      ownerName: 'You',
      versionLabel: '1.8.2',
      runtime: 'remote',
      authMode: 'oauth',
      letter: 'J',
      sandboxed: false,
    });
    expect(toInstallationView(row({ ownerType: 'team', ownerId: 't-1' }), lookups).ownerName).toBe(
      'Platform team',
    );
  });

  it('11.4 a personal install reads its own spec and shows the package version', () => {
    const v = toInstallationView(
      row({ catalogEntryId: null, catalogVersionId: null, personalSpec: pkg }),
      lookups,
    );
    expect(v).toMatchObject({ runtime: 'npm', package: '@acme/pg-mcp', versionLabel: '3.2.0' });
  });

  it('7.1 the URLs follow the router forms on the org host', () => {
    expect(defaultEndpointUrl('b.acme.dev')).toBe('https://b.acme.dev/mcp');
    expect(endpointUrl('b.acme.dev', 'eng')).toBe('https://b.acme.dev/mcp/e/eng');
    expect(installationUrl('b.acme.dev', 'jira')).toBe('https://b.acme.dev/mcp/i/jira');
  });

  it('11.4 a secret is set when the installation has a reference to it', () => {
    const r = row({ secretRefs: { A: { version: 1 } } });
    expect(secretStatus(r, { secretFields: [{ name: 'B', label: 'B' }] }, [{ name: 'A' }])).toEqual(
      [
        { name: 'A', set: true },
        { name: 'B', set: false },
      ],
    );
  });
});

describe('capabilities and overrides (7.3, 12.5)', () => {
  it('7.3 marks overridden, renamed and colliding items from the engine decisions', () => {
    const caps = toCapabilities('tool', {
      items: [
        { name: 'search', description: 'Find' },
        { name: 'jira_get', description: 'Get' },
      ],
      meta: [
        {
          kind: 'tool',
          installationId: 'i-1',
          upstreamKey: 'search',
          finalKey: 'search',
          overridden: true,
          renamed: false,
          collided: false,
          issues: [],
        },
        {
          kind: 'tool',
          installationId: 'i-1',
          upstreamKey: 'get',
          finalKey: 'jira_get',
          overridden: false,
          renamed: true,
          collided: true,
          issues: [],
        },
      ],
      degraded: [],
      needsAuth: [],
      warnings: [],
    });
    expect(caps.map((c) => [c.name, c.overridden, c.collided])).toEqual([
      ['search', true, false],
      ['jira_get', true, true],
    ]);
  });

  it('12.5 reverts the reported changes to get the upstream definition back', () => {
    const final = {
      name: 'q',
      description: 'New',
      annotations: { readOnlyHint: true, title: 'T' },
      extra: 1,
    };
    const upstream = revertChanges(final, [
      { path: '/description', op: 'replace', before: 'Old', after: 'New' },
      { path: '/annotations/title', op: 'add', after: 'T' },
      { path: '/extra', op: 'add', after: 1 },
      { path: '/annotations/idempotentHint', op: 'remove', before: false },
    ]);
    expect(upstream).toEqual({
      name: 'q',
      description: 'Old',
      annotations: { readOnlyHint: true, idempotentHint: false },
    });
    expect(final.description).toBe('New');
  });

  it('12.5 pairs every upstream item with its final definition, and keeps hidden ones', () => {
    const pairs = toDefinitionPairs({
      final: {
        tools: [{ upstreamName: 'a', tool: { name: 'a', description: 'New' } }],
        prompts: [],
        resources: [],
        resourceTemplates: [],
        hidden: [{ kind: 'tool', key: 'b' }],
        invalid: [],
      },
      diff: [
        {
          kind: 'tool',
          key: 'a',
          status: 'modified',
          issues: [],
          changes: [{ path: '/description', op: 'replace', before: 'Old', after: 'New' }],
        },
        { kind: 'tool', key: 'b', status: 'hidden', issues: [], changes: [] },
      ],
      rejected: [],
    });
    expect(pairs[0]).toMatchObject({
      name: 'a',
      kind: 'tool',
      upstream: { name: 'a', description: 'Old' },
      final: { name: 'a', description: 'New' },
      hidden: false,
    });
    expect(pairs[1]).toMatchObject({ name: 'b', final: null, upstream: null, hidden: true });
  });
});

describe('egress, logs and the store', () => {
  it('8.8 groups decisions per host: the latest wins and the reason counts connections', () => {
    const hosts = groupEgress([
      { ts: '2026-01-01T10:00:00Z', host: 'a.example', port: 443, decision: 'allowed' },
      { ts: '2026-01-01T11:00:00Z', host: 'a.example', port: 443, decision: 'denied' },
      { ts: '2026-01-01T09:00:00Z', host: 'b.example', port: 80, decision: 'allowed' },
    ]);
    expect(hosts).toEqual([
      {
        host: 'a.example',
        status: 'denied',
        reason: '2 recent connections on port 443',
        lastSeenAt: '2026-01-01T11:00:00Z',
      },
      {
        host: 'b.example',
        status: 'allowed',
        reason: '1 recent connection on port 80',
        lastSeenAt: '2026-01-01T09:00:00Z',
      },
    ]);
  });

  it('18.3 a log event carries JSON with the line; anything else is shown as it is', () => {
    expect(parseLogLine('{"line":"boom"}')).toBe('boom');
    expect(parseLogLine('plain text')).toBe('plain text');
  });

  const entry: Schemas['StoreEntryDetail'] = {
    id: 'c-1',
    slug: 'jira',
    kind: 'mcp_server',
    displayName: 'Jira',
    description: 'Issues',
    tags: [],
    risk: 'low',
    ownerTeamId: null,
    currentVersionId: 'v-1',
    updatedAt: '2026-01-01T00:00:00.000Z',
    version: {
      id: 'v-1',
      label: '1.8.2',
      changelog: null,
      publishedAt: null,
      installForm: {
        variables: [
          {
            name: 'SITE_URL',
            label: 'Site',
            description: 'Your site',
            required: true,
            default: 'https://x',
          },
        ],
        secrets: [{ name: 'KEY', label: 'API key' }],
      },
    },
  };

  it('11.1 the store row knows whether the caller installed it', () => {
    expect(toStoreEntryView(entry, new Set(['c-1'])).installed).toBe(true);
    expect(toStoreEntryView(entry, new Set()).installed).toBe(false);
    expect(toStoreEntryView(entry, new Set()).category).toBe('Servers');
  });

  it('11.4 the install form lists variables, then secrets, as fields', () => {
    const d = toStoreEntryDetailView(entry, new Set(), specInfo(remote));
    expect(d.variables).toEqual([
      {
        name: 'SITE_URL',
        label: 'Site',
        help: 'Your site',
        required: true,
        secret: false,
        default: 'https://x',
      },
    ]);
    expect(d.secrets).toEqual([{ name: 'KEY', label: 'API key', required: true, secret: true }]);
  });

  it('11.4 builds the install body: catalog version, owner, URL name and only the filled variables', () => {
    const d = toStoreEntryDetailView(entry, new Set(), null);
    expect(
      toInstallBody(d, {
        owner: 'user',
        slug: 'jira',
        pinnedVersion: false,
        fields: { SITE_URL: 'https://y', KEY: 'x' },
      }),
    ).toEqual({
      catalogEntryId: 'c-1',
      catalogVersionId: 'v-1',
      ownerType: 'user',
      slug: 'jira',
      variables: { SITE_URL: 'https://y' },
      pinnedVersion: false,
    });
    expect(
      toInstallBody(d, { owner: 't-1', slug: 'jira', pinnedVersion: true, fields: {} }),
    ).toMatchObject({ ownerType: 'team', teamId: 't-1', variables: {}, pinnedVersion: true });
  });
});

describe('endpoint bodies (7.1)', () => {
  const values = {
    displayName: ' Eng ',
    slug: 'eng',
    installationIds: ['i-1'],
    prefixMode: 'always' as const,
    instructions: '  ',
  };

  it('7.1 a create body omits empty instructions and trims the name', () => {
    expect(toEndpointBody(values)).toEqual({
      slug: 'eng',
      displayName: 'Eng',
      installationIds: ['i-1'],
      prefixMode: 'always',
    });
  });

  it('7.1 a patch clears instructions with null', () => {
    expect(toEndpointPatch(values).instructions).toBeNull();
    expect(toEndpointPatch({ ...values, instructions: ' Use me ' }).instructions).toBe('Use me');
  });
});
