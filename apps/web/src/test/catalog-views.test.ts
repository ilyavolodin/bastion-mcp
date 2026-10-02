import { describe, expect, it } from 'vitest';
import {
  type AutoInstallTarget,
  bumpLabel,
  type CatalogEntry,
  type CatalogVersion,
  type CatalogVersionDetail,
  chipsToTarget,
  editableVersion,
  isPassing,
  stepLabel,
  targetChips,
  toApprovalView,
  toEntryView,
} from '@/api/views/catalog';
import {
  type Draft,
  draftToSpec,
  EXACT_VERSION,
  emptyDraft,
  emptyVariable,
  headerPreset,
  installFormOf,
  isEgressRule,
  normalizeOverrides,
  secretNamesOf,
  secretRefsOf,
  setRowSecret,
  specToDraft,
  templateError,
  type VariableDraft,
  validateDraft,
  varRefsOf,
} from '@/features/catalog/draft';
import { failureReason, testNeeds } from '@/features/catalog/test-panel';
import { fromBase64, toBase64 } from '@/lib/base64';
import { buildCatalogData } from '@/mocks/domains/catalog';

const now = Date.UTC(2026, 5, 1);
const { entries, versions } = buildCatalogData(now);
const entry = (id: string): CatalogEntry => {
  const e = entries.find((x) => x.id === id);
  if (!e) throw new Error(id);
  return e;
};

describe('catalog views (11, 25.2)', () => {
  it('11.1 joins the owner team and the current version label onto an entry row', () => {
    const view = toEntryView(entry('c-zendesk'), {
      teamNames: new Map([['t-support', 'Support']]),
      versions,
    });
    expect(view).toMatchObject({
      ownerTeamName: 'Support',
      currentVersion: '1.1.0',
      letter: 'Z',
    });
    expect(view.color).toMatch(/^var\(--/);
    expect(toEntryView(entry('c-jira'), { teamNames: new Map() }).currentVersion).toBeNull();
  });

  it('11.3 edits the newest draft, else the newest version, and bumps labels for a new draft', () => {
    const v = (id: string, status: CatalogVersion['status'], createdAt: string) =>
      ({ id, status, createdAt }) as CatalogVersion;
    const list = [
      v('old', 'published', '2026-01-01T00:00:00Z'),
      v('draft', 'draft', '2026-02-01T00:00:00Z'),
      v('newer', 'published', '2026-03-01T00:00:00Z'),
    ];
    expect(editableVersion(list)?.id).toBe('draft');
    expect(editableVersion(list.filter((x) => x.status === 'published'))?.id).toBe('newer');
    expect(editableVersion([])).toBeUndefined();
    expect(bumpLabel('1.4.0')).toBe('1.4.1');
    expect(bumpLabel('2025.4')).toBe('2025.5');
    expect(bumpLabel('stable')).toBe('stable-next');
  });

  it('11.2 a passing run enables publishing and every step id of the test has a label', () => {
    expect(isPassing(null)).toBe(false);
    expect(isPassing({ status: 'failed' } as never)).toBe(false);
    expect(isPassing({ status: 'passed' } as never)).toBe(true);
    expect(stepLabel('snapshot')).toBe('Capture tools, prompts and resources');
    expect(stepLabel('something-new')).toBe('something-new');
  });

  it('11.5 turns a policy target into one chip per audience and back', () => {
    const target: AutoInstallTarget = {
      all: true,
      teamIds: ['t-data', 't-gone'],
      roles: ['manager', 'auditor'],
      idpGroups: ['eng'],
    };
    const chips = targetChips(target, new Map([['t-data', 'Data platform']]));
    expect(chips.map((c) => c.label)).toEqual([
      'Everyone',
      'Team · Data platform',
      'Team · t-gone',
      'Role · Manager',
      'Role · Auditor',
      'Group · eng',
    ]);
    expect(chipsToTarget(chips)).toEqual(target);
    expect(chipsToTarget([])).toEqual({});
  });

  it('25.2 lists the executable files of a pending approval as a reviewable diff with the author name', () => {
    const detail = {
      id: 'v1',
      label: '2.1.0',
      createdBy: 'u-raj',
      approval: {
        status: 'pending',
        reviewedDiffSha256: 'a'.repeat(64),
        executables: [],
        diff: [
          { path: 'hooks/post-tool.sh', change: 'added', after: 'curl -s $PAGER_URL\nexit 0' },
          { path: 'old.sh', change: 'removed', after: null },
        ],
      },
    } as unknown as CatalogVersionDetail;
    const view = toApprovalView(entry('c-incident-kit'), detail, 'Raj Mehta');
    expect(view).toMatchObject({
      name: 'Incident kit 2.1.0',
      author: 'Raj Mehta',
      summary: '2 executable files to review',
    });
    expect(view.diff).toEqual([
      '+ hooks/post-tool.sh',
      '+   curl -s $PAGER_URL',
      '+   exit 0',
      '- old.sh',
    ]);
    expect(toApprovalView(entry('c-incident-kit'), detail, undefined).author).toBe('u-raj');
  });
});

describe('catalog draft (11.3, 11.4)', () => {
  const valid = (patch: (d: Draft) => void = () => {}): Draft => {
    const d = emptyDraft();
    d.displayName = 'Billing';
    d.slug = 'billing';
    d.spec.identifier = 'billing-mcp';
    patch(d);
    return d;
  };
  const remote = (patch: (d: Draft) => void = () => {}): Draft =>
    valid((d) => {
      d.spec.type = 'remote';
      d.spec.url = 'https://mcp.example.com/mcp';
      patch(d);
    });
  const variable = (name: string, patch: Partial<VariableDraft> = {}): VariableDraft => ({
    ...emptyVariable(),
    name,
    ...patch,
  });
  /** Issues the real `serverSpecSchema` of `packages/core` finds (it is not browser-safe, so the check is by shape). */
  const injectsOf = (spec: unknown): unknown[] =>
    ((spec as { auth?: { inject?: unknown[] } }).auth?.inject ?? []) as unknown[];

  it('mirrors the API constraints: exact versions, egress rules and names', () => {
    expect(['3.2.0', '2025.4.1', '1.0.0-rc.1'].every((v) => EXACT_VERSION.test(v))).toBe(true);
    expect(['^1.2.0', 'latest', '1.x', '~2'].some((v) => EXACT_VERSION.test(v))).toBe(false);
    expect(
      ['api.example.com', '*.example.com:443', '10.0.0.0/8', '1.2.3.4'].every(isEgressRule),
    ).toBe(true);
    expect(['https://x.com', 'a b', '*.', 'host:99999', '10.0.0.0/40'].some(isEgressRule)).toBe(
      false,
    );
  });

  it('reports what is missing and the step that fixes it', () => {
    expect(validateDraft(valid())).toEqual([]);
    expect(validateDraft(emptyDraft()).map((i) => i.message)).toEqual([
      'Give the entry a name',
      'The URL name needs 1 to 63 characters',
      'Name the package',
    ]);
    const steps = validateDraft(
      valid((d) => {
        d.spec.version = '^1.0.0';
        d.spec.variables = [variable('bad name')];
        d.spec.envVars = [{ name: 'TOKEN', value: '{{secret.TOKEN}}', secret: true }];
        d.spec.egress = ['not a host'];
      }),
    ).map((i) => i.step);
    expect(steps).toEqual(['source', 'configuration', 'authentication', 'network']);
  });

  it('11.3 an override document that does not parse blocks saving and names the step', () => {
    const d = valid((x) => {
      x.overridesError = 'version: must be 1';
    });
    expect(validateDraft(d)).toEqual([
      { step: 'overrides', message: 'The override document is not valid: version: must be 1' },
    ]);
  });

  it('12.2 a version stored with {} overrides opens as the empty document', () => {
    expect(normalizeOverrides({})).toEqual({ version: 1 });
    expect(normalizeOverrides(undefined)).toEqual({ version: 1 });
    expect(normalizeOverrides(null)).toEqual({ version: 1 });
    const doc = { version: 1, tools: { x: { hidden: true } } };
    expect(normalizeOverrides(doc)).toBe(doc);
  });

  it('11.4 round-trips a stored spec through the editor without losing fields it does not own', () => {
    const stored = {
      type: 'package',
      runtime: 'pypi',
      identifier: 'mcp-server-fetch',
      version: '1.2.3',
      size: 'medium',
      egress: { allow: ['*.example.com'] },
      workspace: { persistent: true, sizeMiB: 256 },
      idleTimeoutMinutes: 30,
      environmentVariables: [
        { name: 'REGION', value: '{{var.REGION}}', isRequired: true, description: 'Region' },
        { name: 'DB', value: '{{secret.DB}}' },
      ],
      packageArguments: [{ type: 'named', name: '--mode', value: 'ro', description: 'Mode' }],
      auth: {
        mode: 'orgSecret',
        inject: [{ to: 'env', name: 'DB', value: '{{secret.DB}}' }],
      },
    };
    const draft = specToDraft(stored, {
      variables: [{ name: 'REGION', label: 'Region', required: true }],
      secrets: [],
    });
    expect(draft).toMatchObject({
      type: 'package',
      runtime: 'pypi',
      identifier: 'mcp-server-fetch',
      authMode: 'orgSecret',
      variables: [{ name: 'REGION', label: 'Region', required: true }],
      envVars: [
        { name: 'REGION', value: '{{var.REGION}}', secret: false },
        { name: 'DB', value: '{{secret.DB}}', secret: true },
      ],
      args: [{ kind: 'named', name: '--mode', value: 'ro', secret: false }],
    });
    expect(secretNamesOf(draft)).toEqual(['DB']);
    expect(draftToSpec(draft)).toEqual({
      ...stored,
      environmentVariables: [
        { name: 'REGION', value: '{{var.REGION}}', isRequired: true, description: 'Region' },
      ],
      auth: { mode: 'orgSecret', inject: [{ to: 'env', name: 'DB', value: '{{secret.DB}}' }] },
    });
  });

  it('9.5 a version stored with an identity-provider mode keeps its auth block untouched', () => {
    const auth = {
      mode: 'enterpriseManaged',
      idpConnectionId: '0198a1c2-0000-7000-8000-000000000001',
    };
    const draft = specToDraft({
      type: 'remote',
      transport: 'streamable-http',
      url: 'https://x.example.com/mcp',
      auth,
    });
    expect(draft.authMode).toBe('other');
    expect(draftToSpec(draft)).toMatchObject({ auth });
    expect(validateDraft({ ...remote(), spec: { ...draft } })).toEqual([]);
  });

  it('11.4 derives the install form: variables with choices, and secrets only for a personal secret', () => {
    const d = valid((x) => {
      x.spec.variables = [
        variable('REGION', {
          label: 'Region',
          required: false,
          default: 'eu',
          choices: 'eu, us',
          description: 'Where it runs',
        }),
      ];
      x.spec.envVars = [
        { name: 'REGION', value: '{{var.REGION}}', secret: false },
        { name: 'MY_TOKEN', value: '{{secret.TOKEN}}', secret: true },
      ];
      x.spec.authMode = 'userSecret';
      x.spec.secretLabels = { TOKEN: 'API token' };
    });
    expect(installFormOf(d.spec)).toEqual({
      variables: [
        {
          name: 'REGION',
          label: 'Region',
          description: 'Where it runs',
          required: false,
          default: 'eu',
          choices: ['eu', 'us'],
        },
      ],
      secrets: [{ name: 'TOKEN', label: 'API token' }],
    });
    expect(draftToSpec(d.spec)).toMatchObject({
      type: 'package',
      environmentVariables: [{ name: 'REGION', value: '{{var.REGION}}' }],
      auth: {
        mode: 'userSecret',
        fields: [{ name: 'TOKEN', label: 'API token' }],
        inject: [{ to: 'env', name: 'MY_TOKEN', value: '{{secret.TOKEN}}' }],
      },
    });
    expect(validateDraft(d)).toEqual([]);
  });

  it('9.5 a shared secret is an org secret injected as an environment variable and an argument', () => {
    const d = valid((x) => {
      x.spec.authMode = 'orgSecret';
      x.spec.envVars = [
        { name: 'API_KEY', value: '{{secret.KEY}}', secret: true },
        { name: 'MODE', value: 'readonly', secret: false },
      ];
      x.spec.args = [
        { kind: 'positional', name: '', value: 'serve', secret: false },
        { kind: 'named', name: '--token', value: '{{secret.KEY}}', secret: true },
      ];
    });
    const spec = draftToSpec(d.spec);
    expect(spec).toMatchObject({
      environmentVariables: [{ name: 'MODE', value: 'readonly' }],
      packageArguments: [{ type: 'positional', value: 'serve' }],
    });
    expect(injectsOf(spec)).toEqual([
      { to: 'env', name: 'API_KEY', value: '{{secret.KEY}}' },
      { to: 'arg', flag: '--token', value: '{{secret.KEY}}' },
    ]);
    expect(installFormOf(d.spec).secrets).toEqual([]);
    expect(validateDraft(d)).toEqual([]);
  });

  it('9.5 a Bearer token header of a remote server is a shared secret injected as Authorization', () => {
    const d = remote((x) => {
      x.spec.authMode = 'orgSecret';
      x.spec.headers = [headerPreset('bearer', x.spec)];
    });
    expect(d.spec.headers).toEqual([
      { name: 'Authorization', value: 'Bearer {{secret.TOKEN}}', secret: true },
    ]);
    expect(draftToSpec(d.spec)).toEqual({
      type: 'remote',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      variables: {},
      auth: {
        mode: 'orgSecret',
        inject: [{ to: 'header', name: 'Authorization', value: 'Bearer {{secret.TOKEN}}' }],
      },
    });
    expect(validateDraft(d)).toEqual([]);
    expect(secretNamesOf(d.spec)).toEqual(['TOKEN']);
  });

  it('9.5 a personal API key header asks each installer for the secret and keeps plain headers apart', () => {
    const d = remote((x) => {
      x.spec.authMode = 'userSecret';
      x.spec.secretLabels = { API_KEY: 'Your key' };
      x.spec.headers = [
        headerPreset('apiKey', x.spec),
        { name: 'X-Tenant', value: '{{var.TENANT}}', secret: false },
      ];
      x.spec.variables = [variable('TENANT')];
    });
    expect(draftToSpec(d.spec)).toMatchObject({
      headers: [{ name: 'X-Tenant', value: '{{var.TENANT}}' }],
      auth: {
        mode: 'userSecret',
        fields: [{ name: 'API_KEY', label: 'Your key' }],
        inject: [{ to: 'header', name: 'X-API-Key', value: '{{secret.API_KEY}}' }],
      },
    });
    expect(installFormOf(d.spec).secrets).toEqual([{ name: 'API_KEY', label: 'Your key' }]);
    expect(validateDraft(d)).toEqual([]);
    // Loading it back gives the same rows.
    const back = specToDraft(draftToSpec(d.spec), installFormOf(d.spec));
    expect(back.headers).toEqual([
      { name: 'X-Tenant', value: '{{var.TENANT}}', secret: false, raw: {} },
      { name: 'X-API-Key', value: '{{secret.API_KEY}}', secret: true },
    ]);
    expect(back.secretLabels).toEqual({ API_KEY: 'Your key' });
  });

  it('9.5 header presets keep secret names unique and the Secret switch fills or clears the template', () => {
    const d = remote((x) => {
      x.spec.authMode = 'orgSecret';
      x.spec.headers = [headerPreset('bearer', x.spec)];
    });
    expect(headerPreset('bearer', d.spec).value).toBe('Bearer {{secret.TOKEN_2}}');
    expect(headerPreset('custom', d.spec)).toEqual({ name: '', value: '', secret: false });
    const row = { name: 'X-Auth', value: '', secret: false };
    const on = setRowSecret(row, true, []);
    expect(on).toEqual({ name: 'X-Auth', value: '{{secret.API_KEY}}', secret: true });
    expect(setRowSecret(on, false, [])).toEqual({ ...row, value: '' });
    expect(setRowSecret({ ...row, value: 'plain' }, false, [])).toMatchObject({ value: 'plain' });
  });

  it('9.5 reports credential mistakes on the Authentication step', () => {
    const msgs = (patch: (d: Draft) => void) => validateDraft(remote(patch)).map((i) => i.message);
    expect(
      msgs((d) => {
        d.spec.headers = [{ name: 'Authorization', value: 'Bearer {{secret.T}}', secret: true }];
      }),
    ).toEqual([
      'Secrets need an author-set or per-person source: choose Shared secret or Personal secret',
    ]);
    expect(msgs((d) => (d.spec.authMode = 'orgSecret'))).toEqual([
      'Add a header that carries the secret, for example a Bearer token',
    ]);
    expect(
      msgs((d) => {
        d.spec.authMode = 'orgSecret';
        d.spec.headers = [{ name: 'Authorization', value: 'Bearer {{secret.T}}', secret: false }];
      }),
    ).toContain('"Authorization" uses a secret: switch Secret on for it');
    expect(
      msgs((d) => {
        d.spec.authMode = 'orgSecret';
        d.spec.headers = [{ name: 'Authorization', value: 'Bearer abc', secret: true }];
      }),
    ).toContain('"Authorization" is marked secret: its value needs {{secret.NAME}}');
    expect(
      msgs((d) => {
        d.spec.headers = [
          { name: 'bad name', value: 'x', secret: false },
          { name: 'X-A', value: '', secret: false },
          { name: 'x-a', value: '{{var.NOPE}}', secret: false },
        ];
      }),
    ).toEqual([
      '"bad name" is not a valid header name',
      'Header X-A needs a value',
      'Header x-a is declared twice',
      'Header x-a uses {{var.NOPE}}, which is not a variable',
    ]);
    expect(
      validateDraft(
        valid((d) => {
          d.spec.args = [{ kind: 'named', name: '', value: '', secret: false }];
        }),
      ).map((i) => i.message),
    ).toEqual(['A named argument needs a flag', 'An argument needs a value']);
    expect(
      validateDraft(
        valid((d) => {
          d.spec.envVars = [{ name: '1BAD', value: '{{nope.X}}', secret: false }];
        }),
      ).map((i) => i.message),
    ).toEqual([
      '"1BAD" is not a valid environment variable name',
      'Environment variable 1BAD: unknown template namespace "nope" in {{nope.X}}',
    ]);
  });

  it('11.1 a remote spec declares its variables as a record and injects OAuth as a bearer header', () => {
    const d = valid((x) => {
      x.spec.type = 'remote';
      x.spec.url = 'https://mcp.example.com/{{var.TENANT}}';
      x.spec.variables = [variable('TENANT', { label: 'Tenant' })];
      x.spec.authMode = 'oauth';
      x.spec.oauthScopes = ['read'];
    });
    expect(draftToSpec(d.spec)).toEqual({
      type: 'remote',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/{{var.TENANT}}',
      variables: { TENANT: { name: 'TENANT', isRequired: true, description: 'Tenant' } },
      auth: {
        mode: 'oauth',
        client: { registration: 'auto' },
        scopes: ['read'],
        inject: [{ to: 'header', name: 'Authorization', value: 'Bearer {{oauth.accessToken}}' }],
      },
    });
    expect(validateDraft(d)).toEqual([]);
    // The implied header is not a row when the spec is loaded again.
    expect(specToDraft(draftToSpec(d.spec)).headers).toEqual([]);
  });

  it('11.1 an OAuth package says where the token goes', () => {
    const d = valid((x) => {
      x.spec.authMode = 'oauth';
    });
    expect(validateDraft(d).map((i) => i.message)).toEqual([
      'Say where the access token goes: add a secret environment variable',
    ]);
    d.spec.envVars = [{ name: 'TOKEN', value: '{{oauth.accessToken}}', secret: true }];
    expect(validateDraft(d)).toEqual([]);
    expect(injectsOf(draftToSpec(d.spec))).toEqual([
      { to: 'env', name: 'TOKEN', value: '{{oauth.accessToken}}' },
    ]);
  });

  it('8.1 value templates are checked like the server does and variables must be declared', () => {
    expect(templateError('Bearer {{secret.TOKEN}}')).toBeUndefined();
    expect(templateError('{{var.A}}-{{user.email}}')).toBeUndefined();
    expect(templateError('{{secret.1x}}')).toMatch(/invalid reference/);
    expect(secretRefsOf('{{secret.A}} {{secret.B}} {{var.C}}')).toEqual(['A', 'B']);
    expect(varRefsOf('{{secret.A}} {{var.C}}')).toEqual(['C']);
  });
});

describe('test panel logic (11.3)', () => {
  const run = (steps: { id: string; status: string; detail?: string }[]) =>
    ({
      id: 'r',
      versionId: 'v',
      status: 'failed',
      steps,
      startedAt: '',
      finishedAt: null,
    }) as never;

  it('names the first failed step and its first line as the reason', () => {
    expect(failureReason(undefined)).toBeUndefined();
    expect(failureReason(run([{ id: 'prepare', status: 'passed' }]))).toBeUndefined();
    expect(
      failureReason(
        run([
          { id: 'prepare', status: 'passed' },
          {
            id: 'connect',
            status: 'failed',
            detail: 'could not list the server (x)\nstderr:\nboom',
          },
        ]),
      ),
    ).toBe('Connect to the server: could not list the server (x)');
  });

  it('asks the author for what a test cannot guess: required variables without default and own secrets', () => {
    const d = emptyDraft();
    d.spec.variables = [
      { ...emptyVariable(), name: 'DB', label: 'Database' },
      { ...emptyVariable(), name: 'REGION', default: 'eu' },
      { ...emptyVariable(), name: 'OPT', required: false },
    ];
    d.spec.envVars = [{ name: 'T', value: '{{secret.KEY}}', secret: true }];
    d.spec.authMode = 'userSecret';
    d.spec.secretLabels = { KEY: 'Your key' };
    expect(testNeeds(d.spec)).toEqual({
      variables: [{ name: 'DB', label: 'Database' }],
      mySecrets: [{ name: 'KEY', label: 'Your key' }],
      orgSecrets: [],
    });
    d.spec.authMode = 'orgSecret';
    expect(testNeeds(d.spec).orgSecrets).toEqual(['KEY']);
    expect(testNeeds(undefined)).toEqual({ variables: [], mySecrets: [], orgSecrets: [] });
  });
});

describe('file content encoding (25.2)', () => {
  it('round-trips UTF-8 text through base64', () => {
    for (const text of ['plain', '# Réunion — notes ✓\n', '']) {
      expect(fromBase64(toBase64(text))).toBe(text);
    }
    expect(toBase64('hi')).toBe('aGk=');
  });
});
