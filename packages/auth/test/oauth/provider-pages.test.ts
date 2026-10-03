import { describe, expect, it } from 'vitest';
import { type ProviderPages, providerPageSources } from '../../src/oauth/as/provider-pages';

const pages: ProviderPages = {
  deviceCode: (i) => `code:${i.form}:${i.error ?? ''}`,
  deviceConfirm: (i) => `confirm:${i.clientName}:${i.logoUri ?? 'none'}:${i.userCode}:${i.form}`,
  deviceSuccess: (name) => `success:${name ?? 'none'}`,
  logoutConfirm: (form) => `logout:${form}`,
  logoutDone: () => 'logged-out',
  error: (i) => `error:${i.error}:${i.description ?? ''}:${JSON.stringify(i.details)}`,
};
const sources = providerPageSources(pages);

type Ctx = {
  body?: unknown;
  type?: string;
  oidc: { client?: { clientName?: string; clientId?: string; logoUri?: unknown } };
};
const ctx = (client?: { clientName?: string; clientId?: string; logoUri?: unknown }): Ctx =>
  client ? { oidc: { client } } : { oidc: {} };

describe('9.3 provider page sources', () => {
  it('device code input maps oidc-provider errors to page errors', async () => {
    const cases: [unknown, string][] = [
      [undefined, 'code:<f>:'],
      [{ name: 'NoCodeError' }, 'code:<f>:wrong'],
      [{ userCode: 'ABCD' }, 'code:<f>:wrong'],
      [{ name: 'AbortedError' }, 'code:<f>:aborted'],
      [new Error('boom'), 'code:<f>:other'],
    ];
    for (const [err, expected] of cases) {
      const c = ctx();
      await sources.deviceFlow.userCodeInputSource(c, '<f>', undefined, err);
      expect(c.body).toBe(expected);
    }
  });

  it('device confirm names the client and only shows an https logo', async () => {
    const c = ctx({ clientName: 'My CLI', clientId: 'id1' });
    await sources.deviceFlow.userCodeConfirmSource(
      c,
      '<f>',
      { logoUri: 'https://a.example/l.png' },
      undefined,
      'WXYZ',
    );
    expect(c.body).toBe('confirm:My CLI:https://a.example/l.png:WXYZ:<f>');
    for (const logoUri of ['http://a.example/l.png', 'javascript:alert(1)', 'nope', 42]) {
      const d = ctx({ clientId: 'id1' });
      await sources.deviceFlow.userCodeConfirmSource(d, '<f>', { logoUri }, undefined, 'W');
      expect(d.body).toBe('confirm:id1:none:W:<f>');
    }
    const anon = ctx();
    await sources.deviceFlow.userCodeConfirmSource(anon, '<f>', {}, undefined, 'W');
    expect(anon.body).toBe('confirm:this app:none:W:<f>');
  });

  it('device success and logout pages', async () => {
    const a = ctx({ clientName: 'My CLI' });
    await sources.deviceFlow.successSource(a);
    expect(a.body).toBe('success:My CLI');
    const b = ctx();
    await sources.deviceFlow.successSource(b);
    expect(b.body).toBe('success:none');
    const c = ctx();
    await sources.rpInitiatedLogout.logoutSource(c, '<f>');
    expect(c.body).toBe('logout:<f>');
    const d = ctx();
    await sources.rpInitiatedLogout.postLogoutSuccessSource(d);
    expect(d.body).toBe('logged-out');
  });

  it('renderError sets html and stringifies the details', async () => {
    const c = ctx();
    await sources.renderError(c, {
      error: 'invalid_request',
      error_description: 'bad',
      state: 'abc',
      extra: { n: 1 },
    });
    expect(c.type).toBe('html');
    expect(c.body).toBe(
      `error:invalid_request:bad:${JSON.stringify({ state: 'abc', extra: '{"n":1}' })}`,
    );
    const d = ctx();
    await sources.renderError(d, {});
    expect(d.body).toBe('error:error::{}');
  });
});

describe('9.3 pre-registered clients use injected randomness', () => {
  it('takes the client id and secret from the generators', async () => {
    const { prepareClient } = await import('../../src/oauth/as/clients');
    const prepared = prepareClient(
      { kind: 'service', name: 'ci', authMethod: 'client_secret_basic' },
      { clientId: () => 'fixed-id', clientSecret: () => 'fixed-secret' },
    );
    expect(prepared).toMatchObject({ clientId: 'fixed-id', clientSecret: 'fixed-secret' });
  });
});
