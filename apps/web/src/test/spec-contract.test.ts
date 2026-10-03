import { serverSpecSchema } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import {
  type Draft,
  draftToSpec,
  emptyDraft,
  emptyVariable,
  headerPreset,
  oauthClientSecretName,
  specToDraft,
  validateDraft,
} from '@/features/catalog/draft';

/**
 * The editor builds a `ServerSpec`; the real `serverSpecSchema` of `@bastion-mcp/core` (the one the API validates the
 * request body with, 8.1, 9.5) must accept every spec it produces. Only this test imports core's Node-only barrel.
 */

const base = (patch: (d: Draft) => void): Draft => {
  const d = emptyDraft();
  d.displayName = 'Server';
  d.slug = 'server';
  patch(d);
  return d;
};

const remote = (patch: (d: Draft) => void) =>
  base((d) => {
    d.spec.type = 'remote';
    d.spec.url = 'https://mcp.example.com/{{var.TENANT}}/mcp';
    d.spec.variables = [{ ...emptyVariable(), name: 'TENANT' }];
    patch(d);
  });

const pkg = (patch: (d: Draft) => void) =>
  base((d) => {
    d.spec.identifier = '@acme/mcp';
    d.spec.version = '1.2.3';
    patch(d);
  });

const CASES: [string, Draft][] = [
  ['remote, no auth', remote(() => {})],
  [
    'remote, shared bearer secret',
    remote((d) => {
      d.spec.authMode = 'orgSecret';
      d.spec.headers = [headerPreset('bearer', d.spec)];
    }),
  ],
  [
    'remote, personal API key header and a plain header',
    remote((d) => {
      d.spec.authMode = 'userSecret';
      d.spec.secretLabels = { API_KEY: 'Your key' };
      d.spec.headers = [
        headerPreset('apiKey', d.spec),
        { name: 'X-Tenant', value: '{{var.TENANT}}', secret: false },
      ];
    }),
  ],
  [
    'remote, OAuth',
    remote((d) => {
      d.spec.authMode = 'oauth';
      d.spec.oauthScopes = ['read', 'write'];
    }),
  ],
  [
    'remote, OAuth with an app registered by hand',
    remote((d) => {
      d.spec.authMode = 'oauth';
      d.spec.oauthClient = {
        registration: 'preRegistered',
        clientId: 'Iv1.abc123',
        authMethod: 'client_secret_basic',
      };
    }),
  ],
  [
    'remote, OAuth with a public client',
    remote((d) => {
      d.spec.authMode = 'oauth';
      d.spec.oauthClient = { registration: 'preRegistered', clientId: 'pub', authMethod: 'none' };
    }),
  ],
  [
    'package with variables, env vars and arguments',
    pkg((d) => {
      d.spec.variables = [
        { ...emptyVariable(), name: 'DB_URL', label: 'Database', required: true },
        { ...emptyVariable(), name: 'REGION', default: 'eu', choices: 'eu, us', required: false },
      ];
      d.spec.envVars = [
        { name: 'DATABASE_URL', value: '{{var.DB_URL}}', secret: false },
        { name: 'MODE', value: 'readonly', secret: false },
      ];
      d.spec.args = [
        { kind: 'positional', name: '', value: 'serve', secret: false },
        { kind: 'named', name: '--region', value: '{{var.REGION}}', secret: false },
      ];
    }),
  ],
  [
    'package with a shared secret as env var and argument',
    pkg((d) => {
      d.spec.authMode = 'orgSecret';
      d.spec.envVars = [{ name: 'TOKEN', value: '{{secret.TOKEN}}', secret: true }];
      d.spec.args = [{ kind: 'named', name: '--key', value: '{{secret.TOKEN}}', secret: true }];
    }),
  ],
  [
    'package with a personal secret',
    pkg((d) => {
      d.spec.authMode = 'userSecret';
      d.spec.envVars = [{ name: 'GITHUB_TOKEN', value: '{{secret.PAT}}', secret: true }];
    }),
  ],
  [
    'package with an OAuth token in the environment',
    pkg((d) => {
      d.spec.authMode = 'oauth';
      d.spec.envVars = [{ name: 'TOKEN', value: '{{oauth.accessToken}}', secret: true }];
    }),
  ],
];

describe('the editor builds specs that serverSpecSchema accepts (8.1, 9.5)', () => {
  for (const [name, draft] of CASES) {
    it(`${name}`, () => {
      expect(validateDraft(draft)).toEqual([]);
      const spec = draftToSpec(draft.spec);
      const parsed = serverSpecSchema.safeParse(spec);
      expect(parsed.error?.issues ?? []).toEqual([]);
      // Reading it back and saving again changes nothing.
      expect(draftToSpec(specToDraft(spec))).toEqual(spec);
    });
  }
});

describe('OAuth client of the editor (9.6)', () => {
  it('names the client secret after the client id and leaves it out for a public client', () => {
    const d = remote((x) => {
      x.spec.authMode = 'oauth';
      x.spec.oauthClient = {
        registration: 'preRegistered',
        clientId: 'Iv1.abc123',
        authMethod: 'client_secret_post',
      };
    });
    expect(oauthClientSecretName(d.spec.oauthClient)).toBe('OAUTH_CLIENT_SECRET_IV1_ABC123');
    expect(draftToSpec(d.spec).auth).toMatchObject({
      mode: 'oauth',
      client: {
        registration: 'preRegistered',
        clientId: 'Iv1.abc123',
        clientSecretRef: 'OAUTH_CLIENT_SECRET_IV1_ABC123',
        authMethod: 'client_secret_post',
      },
    });
    d.spec.oauthClient.authMethod = 'none';
    expect(draftToSpec(d.spec).auth).toMatchObject({ client: { authMethod: 'none' } });
    expect(JSON.stringify(draftToSpec(d.spec).auth)).not.toContain('clientSecretRef');
  });

  it('asks for the client id when the app is registered by hand', () => {
    const d = remote((x) => {
      x.spec.authMode = 'oauth';
      x.spec.oauthClient = { registration: 'preRegistered', clientId: ' ', authMethod: 'none' };
    });
    expect(validateDraft(d).map((i) => i.message)).toContain(
      'Enter the client ID of the OAuth app you registered',
    );
  });

  it('keeps a fixed cimd or dcr choice of an imported spec', () => {
    const spec = {
      type: 'remote',
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      auth: { mode: 'oauth', client: { registration: 'dcr' } },
    };
    const parsed = serverSpecSchema.parse(spec);
    expect(draftToSpec(specToDraft(parsed)).auth).toMatchObject({
      client: { registration: 'dcr' },
    });
  });
});
