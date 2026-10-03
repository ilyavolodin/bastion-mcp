import type { KoaContextWithOIDC, Provider } from 'oidc-provider';
import { describe, expect, it } from 'vitest';
import { registerJwtBearerGrant } from '../../src/oauth/as/id-jag-grant';
import { JWT_BEARER_GRANT } from '../../src/oauth/constants';

type Handler = (ctx: KoaContextWithOIDC) => Promise<void>;

const HOST = 'bastion.test';
const ISSUER = `https://${HOST}/oauth`;

type Saved = { props: Record<string, unknown>; scope: string };

const setup = (options: { active?: boolean; verify?: () => Promise<{ userId: string }> } = {}) => {
  let handler: Handler | undefined;
  let registered: { name: string; params: string[] } | undefined;
  const saved: Saved[] = [];
  class AccessToken {
    scope = '';
    expiration = 900;
    tokenType = 'Bearer';
    resourceServer: unknown;
    constructor(readonly props: Record<string, unknown>) {
      this.scope = String(props.scope ?? '');
    }
    async save() {
      saved.push({ props: this.props, scope: this.scope });
      return 'signed-access-token';
    }
  }
  const provider = {
    registerGrantType: (name: string, h: Handler, params: string[]) => {
      registered = { name, params };
      handler = h;
    },
    AccessToken,
    ResourceServer: class {
      constructor(
        readonly id: string,
        readonly info: unknown,
      ) {}
    },
  } as unknown as Provider;
  const verifyCalls: { assertion: string; resource: string; clientId: string }[] = [];
  registerJwtBearerGrant(provider, {
    host: HOST,
    issuer: ISSUER,
    verifier: {
      verify: async (assertion, expected) => {
        verifyCalls.push({
          assertion,
          resource: expected.resource,
          clientId: expected.clientId,
        });
        return (options.verify ?? (async () => ({ userId: 'user-1' })))();
      },
    },
    principals: {
      isUserActive: async () => options.active ?? true,
      serviceAccountForClient: async () => null,
    },
  });
  const run = async (
    params: Record<string, unknown>,
    client: { clientId: string; scope?: string } | null = { clientId: 'c1' },
  ) => {
    const body: { value?: Record<string, unknown> } = {};
    const ctx = {
      oidc: { params, client, entity: () => undefined },
      set body(value: Record<string, unknown>) {
        body.value = value;
      },
    } as unknown as KoaContextWithOIDC;
    await handler?.(ctx);
    return body.value;
  };
  return { registered: () => registered, run, saved, verifyCalls };
};

describe('9.4 jwt-bearer grant for ID-JAG', () => {
  it('9.4 registers the RFC 7523 grant with its parameters', () => {
    expect(setup().registered()).toEqual({
      name: JWT_BEARER_GRANT,
      params: ['assertion', 'scope', 'resource'],
    });
  });

  it('9.4 issues an access token for the verified user, defaulting to the mcp resource and scope', async () => {
    const x = setup();
    const body = await x.run({ assertion: 'jag' });
    expect(body).toMatchObject({
      access_token: 'signed-access-token',
      token_type: 'Bearer',
      expires_in: 900,
      scope: 'mcp',
    });
    expect(x.verifyCalls).toEqual([
      { assertion: 'jag', resource: `https://${HOST}/mcp`, clientId: 'c1' },
    ]);
    expect(x.saved[0]?.props).toMatchObject({ accountId: 'user-1', gty: JWT_BEARER_GRANT });
  });

  it('9.4 a missing assertion is invalid_request', async () => {
    await expect(setup().run({})).rejects.toMatchObject({ error: 'invalid_request' });
    await expect(setup().run({ assertion: '' })).rejects.toMatchObject({
      error: 'invalid_request',
    });
  });

  it('9.4 a resource outside this deployment is invalid_target', async () => {
    await expect(
      setup().run({ assertion: 'jag', resource: 'https://evil.example/mcp' }),
    ).rejects.toMatchObject({ error: 'invalid_target' });
  });

  it('9.4 a request without client authentication is invalid_client', async () => {
    await expect(setup().run({ assertion: 'jag' }, null)).rejects.toMatchObject({
      error: 'invalid_client',
    });
  });

  it('9.4 a failing verifier (any reason) is invalid_grant and leaks nothing', async () => {
    const x = setup({
      verify: async () => {
        throw new Error('jti replayed: secret detail');
      },
    });
    const error = await x.run({ assertion: 'jag' }).catch((e: Error) => e);
    expect(error).toMatchObject({ error: 'invalid_grant' });
    expect(JSON.stringify(error)).not.toContain('secret detail');
    expect(String((error as Error).message)).not.toContain('secret detail');
    expect(x.saved).toHaveLength(0);
  });

  it('9.4 an inactive user is invalid_grant', async () => {
    const x = setup({ active: false });
    await expect(x.run({ assertion: 'jag' })).rejects.toMatchObject({ error: 'invalid_grant' });
    expect(x.saved).toHaveLength(0);
  });

  it('9.4 scopes are narrowed to the resource and to the client scope', async () => {
    const x = setup();
    const body = await x.run(
      { assertion: 'jag', scope: 'mcp plugins:read api:write' },
      { clientId: 'c1', scope: 'mcp' },
    );
    expect(body?.scope).toBe('mcp');
  });

  it('9.4 asking for nothing the resource offers is invalid_scope', async () => {
    await expect(setup().run({ assertion: 'jag', scope: 'api:write' })).rejects.toMatchObject({
      error: 'invalid_scope',
    });
  });
});
