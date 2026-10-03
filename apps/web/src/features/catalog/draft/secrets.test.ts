import { describe, expect, it } from 'vitest';
import {
  addHeaderPreset,
  addSecretArg,
  addSecretEnv,
  BEARER_PREFIX,
  defaultSecretValue,
  headerPreset,
  needsClientSecret,
  oauthClientSecretName,
  oauthTokenTemplate,
  secretNamesOf,
  secretTemplate,
  setRowSecret,
} from './secrets';
import { defaultSpec, type SpecDraft } from './types';

const remote = (patch: Partial<SpecDraft> = {}): SpecDraft => ({
  ...defaultSpec(),
  type: 'remote',
  ...patch,
});
const pkg = (patch: Partial<SpecDraft> = {}): SpecDraft => ({
  ...defaultSpec(),
  type: 'package',
  ...patch,
});

describe('value templates (8.1, 9.5)', () => {
  it('names a secret and the upstream access token', () => {
    expect(secretTemplate('TOKEN')).toBe('{{secret.TOKEN}}');
    expect(oauthTokenTemplate()).toBe('{{oauth.accessToken}}');
    expect(BEARER_PREFIX).toBe('Bearer ');
  });

  it('Authorization carries a bearer token, any other header an API key; names stay unique', () => {
    expect(defaultSecretValue('Authorization')).toBe('Bearer {{secret.TOKEN}}');
    expect(defaultSecretValue('  authorization ')).toBe('Bearer {{secret.TOKEN}}');
    expect(defaultSecretValue('X-API-Key')).toBe('{{secret.API_KEY}}');
    expect(defaultSecretValue('Authorization', ['TOKEN'])).toBe('Bearer {{secret.TOKEN_2}}');
    expect(defaultSecretValue('X-Key', ['API_KEY', 'API_KEY_2'])).toBe('{{secret.API_KEY_3}}');
  });
});

describe('secretNamesOf', () => {
  it('lists the secrets of the rows marked secret, first appearance first, once each', () => {
    const s = remote({
      headers: [
        { name: 'Authorization', value: 'Bearer {{secret.TOKEN}}', secret: true },
        { name: 'X', value: '{{secret.TOKEN}}-{{secret.OTHER}}', secret: true },
        { name: 'Y', value: '{{secret.IGNORED}}', secret: false },
      ],
    });
    expect(secretNamesOf(s)).toEqual(['TOKEN', 'OTHER']);
  });

  it('reads the environment variables and the arguments of a package, not its headers', () => {
    const s = pkg({
      envVars: [{ name: 'A', value: '{{secret.ENV_TOKEN}}', secret: true }],
      args: [{ kind: 'named', name: '--t', value: '{{secret.ARG_TOKEN}}', secret: true }],
      headers: [{ name: 'H', value: '{{secret.HEADER}}', secret: true }],
    });
    expect(secretNamesOf(s)).toEqual(['ENV_TOKEN', 'ARG_TOKEN']);
  });
});

describe('header presets (9.5)', () => {
  it('builds a Bearer row and an API key row with unused secret names', () => {
    expect(headerPreset('bearer', remote())).toEqual({
      name: 'Authorization',
      value: 'Bearer {{secret.TOKEN}}',
      secret: true,
    });
    expect(headerPreset('apiKey', remote())).toEqual({
      name: 'X-API-Key',
      value: '{{secret.API_KEY}}',
      secret: true,
    });
    expect(headerPreset('custom', remote())).toEqual({ name: '', value: '', secret: false });
  });

  it('addHeaderPreset adds the row, and makes the auth mode a shared secret when it was not a secret mode', () => {
    const next = addHeaderPreset(remote({ authMode: 'none' }), 'bearer');
    expect(next.headers).toHaveLength(1);
    expect(next.authMode).toBe('orgSecret');
  });

  it('addHeaderPreset keeps a secret mode that was already chosen', () => {
    expect(addHeaderPreset(remote({ authMode: 'userSecret' }), 'apiKey').authMode).toBe(
      'userSecret',
    );
    expect(addHeaderPreset(remote({ authMode: 'orgSecret' }), 'apiKey').authMode).toBe('orgSecret');
  });

  it('addHeaderPreset leaves the mode alone for a row that carries no secret', () => {
    expect(addHeaderPreset(remote({ authMode: 'none' }), 'custom').authMode).toBe('none');
    expect(addHeaderPreset(remote({ authMode: 'oauth' }), 'custom').authMode).toBe('oauth');
  });

  it('addHeaderPreset does not touch the spec it was given', () => {
    const s = remote({ authMode: 'none' });
    addHeaderPreset(s, 'bearer');
    expect(s.headers).toEqual([]);
    expect(s.authMode).toBe('none');
  });

  it('a second Bearer header gets a new secret name', () => {
    const once = addHeaderPreset(remote(), 'bearer');
    const twice = addHeaderPreset(once, 'bearer');
    expect(twice.headers.map((h) => h.value)).toEqual([
      'Bearer {{secret.TOKEN}}',
      'Bearer {{secret.TOKEN_2}}',
    ]);
  });
});

describe('secret bindings of a package (9.5, 9.6)', () => {
  it('addSecretEnv adds a nameless secret variable that refers to the next SECRET_n', () => {
    const one = addSecretEnv(pkg({ authMode: 'orgSecret' }));
    expect(one.envVars).toEqual([{ name: '', secret: true, value: '{{secret.SECRET_1}}' }]);
    // The row has no name yet, but its secret counts as taken.
    const two = addSecretEnv(one);
    expect(two.envVars.at(-1)?.value).toBe('{{secret.SECRET_2}}');
  });

  it('addSecretEnv never reuses a SECRET_n that is already referenced', () => {
    const s = pkg({ envVars: [{ name: 'A', secret: true, value: '{{secret.SECRET_2}}' }] });
    expect(addSecretEnv(s).envVars.at(-1)?.value).toBe('{{secret.SECRET_3}}');
  });

  it('with OAuth the binding carries the access token, not a secret', () => {
    expect(addSecretEnv(pkg({ authMode: 'oauth' })).envVars[0]?.value).toBe(
      '{{oauth.accessToken}}',
    );
    expect(addSecretArg(pkg({ authMode: 'oauth' })).args[0]?.value).toBe('{{oauth.accessToken}}');
  });

  it('addSecretArg adds a named --token argument that refers to TOKEN', () => {
    expect(addSecretArg(pkg({ authMode: 'userSecret' })).args).toEqual([
      { kind: 'named', name: '--token', secret: true, value: '{{secret.TOKEN}}' },
    ]);
  });

  it('both keep the rows that were there and do not change the spec they were given', () => {
    const s = pkg({ envVars: [{ name: 'PLAIN', value: 'x', secret: false }] });
    const next = addSecretEnv(s);
    expect(next.envVars).toHaveLength(2);
    expect(next.envVars[0]).toBe(s.envVars[0]);
    expect(s.envVars).toHaveLength(1);
  });
});

describe('setRowSecret', () => {
  const row = { name: 'Authorization', value: '', secret: false };

  it('switching on fills in a secret template named for the header', () => {
    expect(setRowSecret(row, true, [])).toEqual({
      name: 'Authorization',
      value: 'Bearer {{secret.TOKEN}}',
      secret: true,
    });
    expect(setRowSecret({ ...row, name: 'X-Key' }, true, ['API_KEY']).value).toBe(
      '{{secret.API_KEY_2}}',
    );
  });

  it('switching on keeps a reference the value already has', () => {
    const r = { name: 'X', value: 'k={{secret.MINE}}', secret: false };
    expect(setRowSecret(r, true, [])).toEqual({ ...r, secret: true });
  });

  it('with OAuth it uses the access token, and keeps an oauth reference already there', () => {
    expect(setRowSecret(row, true, [], 'oauth').value).toBe('{{oauth.accessToken}}');
    const r = { ...row, value: 'Bearer {{oauth.accessToken}}' };
    expect(setRowSecret(r, true, [], 'oauth').value).toBe('Bearer {{oauth.accessToken}}');
    // Outside OAuth an oauth reference is not a credential the resolver can supply.
    expect(setRowSecret(r, true, [], 'userSecret').value).toBe('Bearer {{secret.TOKEN}}');
  });

  it('switching off clears a credential reference and keeps a plain value', () => {
    expect(setRowSecret({ ...row, value: 'Bearer {{secret.T}}', secret: true }, false, [])).toEqual(
      { name: 'Authorization', value: '', secret: false },
    );
    expect(
      setRowSecret({ ...row, value: '{{oauth.accessToken}}', secret: true }, false, []).value,
    ).toBe('');
    expect(setRowSecret({ ...row, value: 'plain', secret: true }, false, [])).toMatchObject({
      value: 'plain',
      secret: false,
    });
  });
});

describe('OAuth client secret (9.6)', () => {
  it('is named for the client id, one per id', () => {
    expect(
      oauthClientSecretName({
        registration: 'preRegistered',
        clientId: ' Iv1.abc-123 ',
        authMethod: 'client_secret_basic',
      }),
    ).toBe('OAUTH_CLIENT_SECRET_IV1_ABC_123');
  });

  it('is kept only for a pre-registered app that sends a secret', () => {
    const client = (
      registration: 'auto' | 'preRegistered',
      authMethod: 'client_secret_basic' | 'none',
    ) =>
      pkg({
        authMode: 'oauth',
        oauthClient: { registration, clientId: 'c', authMethod },
      });
    expect(needsClientSecret(client('preRegistered', 'client_secret_basic'))).toBe(true);
    expect(needsClientSecret(client('preRegistered', 'none'))).toBe(false);
    expect(needsClientSecret(client('auto', 'client_secret_basic'))).toBe(false);
    expect(
      needsClientSecret({
        ...client('preRegistered', 'client_secret_basic'),
        authMode: 'orgSecret',
      }),
    ).toBe(false);
  });
});
