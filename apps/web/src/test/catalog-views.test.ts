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
  installFormOf,
  isEgressRule,
  specToDraft,
  validateDraft,
} from '@/features/catalog/draft';
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
        d.spec.variables = [
          { name: 'bad name', label: '', required: true, secret: true, default: '' },
        ];
        d.spec.authMode = 'orgSecret';
        d.spec.egress = ['not a host'];
      }),
    ).map((i) => i.step);
    expect(steps).toEqual([
      'source',
      'configuration',
      'authentication',
      'authentication',
      'network',
    ]);
    expect(
      validateDraft(valid((d) => (d.spec.authMode = 'userSecret'))).map((i) => i.message),
    ).toEqual(['A personal API key needs at least one secret variable']);
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
      auth: {
        mode: 'orgSecret',
        inject: [{ to: 'env', name: 'DB', value: '{{secret.DB}}' }],
      },
    };
    const draft = specToDraft(stored);
    expect(draft).toMatchObject({
      type: 'package',
      runtime: 'pypi',
      identifier: 'mcp-server-fetch',
      authMode: 'orgSecret',
      orgSecretName: 'DB',
      variables: [{ name: 'REGION', label: 'Region', required: true, secret: false }],
    });
    expect(draftToSpec(draft)).toEqual({
      ...stored,
      environmentVariables: [
        { name: 'DB', value: '{{secret.DB}}' },
        { name: 'REGION', value: '{{var.REGION}}', isRequired: true, description: 'Region' },
      ],
    });
  });

  it('11.4 derives the install form: plain variables, and secrets only for a personal API key', () => {
    const d = valid((x) => {
      x.spec.variables = [
        { name: 'REGION', label: 'Region', required: false, secret: false, default: 'eu' },
        { name: 'TOKEN', label: '', required: true, secret: true, default: '' },
      ];
      x.spec.authMode = 'userSecret';
    });
    expect(installFormOf(d.spec)).toEqual({
      variables: [{ name: 'REGION', label: 'Region', required: false, default: 'eu' }],
      secrets: [{ name: 'TOKEN', label: 'TOKEN' }],
    });
    expect(draftToSpec(d.spec)).toMatchObject({
      auth: { mode: 'userSecret', fields: [{ name: 'TOKEN', label: 'TOKEN' }] },
    });
  });

  it('11.1 a remote spec declares its variables as a record and injects OAuth as a bearer header', () => {
    const d = valid((x) => {
      x.spec.type = 'remote';
      x.spec.url = 'https://mcp.example.com/{{var.TENANT}}';
      x.spec.variables = [
        { name: 'TENANT', label: 'Tenant', required: true, secret: false, default: '' },
      ];
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
