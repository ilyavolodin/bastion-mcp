import { afterEach, describe, expect, it } from 'vitest';
import { startUpstreamHarness, type UpstreamHarness, USER } from './upstream-harness';

let h: UpstreamHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

type Interceptor = (
  url: string,
  body: string,
) => Response | undefined | Promise<Response | undefined>;

/** A fetch that lets a test answer chosen upstream calls and passes the rest through. */
const intercepting = (intercept: Interceptor): typeof fetch =>
  (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
    return (await intercept(url, body)) ?? fetch(input, init);
  }) as typeof fetch;

const start = async (intercept: Interceptor) => {
  h = await startUpstreamHarness({}, {}, { fetch: intercepting(intercept) });
  return h;
};

const refreshWith =
  (status: number, error = 'invalid_grant'): Interceptor =>
  (url, body) =>
    url.endsWith('/token') && body.includes('grant_type=refresh_token')
      ? Response.json({ error }, { status })
      : undefined;

const nearExpiry = (x: UpstreamHarness) => {
  x.clock.t += (3600 - 4 * 60) * 1000;
};

describe('9.6 refresh failures: only 400/401 are permanent', () => {
  it.each([408, 429, 500, 503])('%i is transient: the row stays valid', async (status) => {
    let failing = false;
    const x = await start((url, body) => (failing ? refreshWith(status)(url, body) : undefined));
    await x.connect();
    failing = true;
    nearExpiry(x);
    const token = await x.broker.accessToken(USER, x.installation);
    expect(token?.accessToken).toBe('up-at-2');
    expect(x.tokens.rows.get('user-1:inst-1')?.status).toBe('valid');
    expect(x.outcomes).toEqual(['failure']);
  });

  it.each([
    [400, 'invalid_grant'],
    [401, 'invalid_client'],
  ])('%i %s needs a reconnect', async (status, error) => {
    let failing = false;
    const x = await start((url, body) =>
      failing ? refreshWith(status, error)(url, body) : undefined,
    );
    await x.connect();
    failing = true;
    nearExpiry(x);
    expect(await x.broker.accessToken(USER, x.installation)).toBeNull();
    expect(x.tokens.rows.get('user-1:inst-1')?.status).toBe('reconnect_required');
  });

  it('a 403 is not a permanent refresh failure either', async () => {
    let failing = false;
    const x = await start((url, body) => (failing ? refreshWith(403)(url, body) : undefined));
    await x.connect();
    failing = true;
    nearExpiry(x);
    expect((await x.broker.accessToken(USER, x.installation))?.accessToken).toBe('up-at-2');
    expect(x.tokens.rows.get('user-1:inst-1')?.status).toBe('valid');
  });
});

describe('9.6 cross-replica refresh race', () => {
  it('re-reads the row on a 4xx and uses the tokens another replica just stored', async () => {
    let race: (() => Promise<void>) | undefined;
    const x = await start(async (url, body) => {
      if (url.endsWith('/token') && body.includes('grant_type=refresh_token') && race) {
        await race();
        race = undefined;
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return undefined;
    });
    await x.connect();
    nearExpiry(x);
    race = async () => {
      const row = x.tokens.rows.get('user-1:inst-1');
      if (!row) throw new Error('missing row');
      x.secrets.byId.set(
        row.secretId,
        JSON.stringify({ accessToken: 'other-replica-at', refreshToken: 'other-replica-rt' }),
      );
      x.tokens.rows.set('user-1:inst-1', {
        ...row,
        expiresAt: new Date(x.clock.t + 3_600_000),
        updatedAt: new Date(x.clock.t + 1),
      });
    };
    const token = await x.broker.accessToken(USER, x.installation);
    expect(token?.accessToken).toBe('other-replica-at');
    expect(x.tokens.rows.get('user-1:inst-1')?.status).toBe('valid');
    expect(x.outcomes).not.toContain('reconnect_required');
  });
});

describe('9.6 stored values are parsed safely', () => {
  it('a corrupt token bundle means reconnect, not a crash', async () => {
    const x = await start(() => undefined);
    await x.connect();
    const secretId = x.tokens.rows.get('user-1:inst-1')?.secretId ?? '';
    x.secrets.byId.set(secretId, 'not json');
    expect(await x.broker.accessToken(USER, x.installation)).toBeNull();
  });

  it('a corrupt step-up record is ignored', async () => {
    const x = await start(() => undefined);
    x.redis.data.set('ups:stepup:user-1:inst-1', '{oops');
    const { authorizationUrl } = await x.broker.startAuthorization(USER, x.installation);
    expect(new URL(authorizationUrl).searchParams.get('scope')).toBe('read');
  });
});

describe('9.1 disconnect revokes the access token even when the refresh revocation fails', () => {
  it('keeps going after the refresh-token revoke fails', async () => {
    const x = await start((url, body) =>
      url.endsWith('/revoke') && body.includes('token_type_hint=refresh_token')
        ? new Response('boom', { status: 500 })
        : undefined,
    );
    await x.connect();
    await x.broker.disconnect(USER, x.installation, 'inst-1');
    expect(x.upstream.revoked).toEqual(['up-at-2']);
    expect(x.tokens.rows.size).toBe(0);
  });
});

describe('purity: ids come from the injected generator', () => {
  it('uses deps.newId for the state nonce', async () => {
    const ids: string[] = [];
    h = await startUpstreamHarness(
      {},
      {},
      {
        newId: () => {
          ids.push('n');
          return 'fixed';
        },
      },
    );
    await h.broker.startAuthorization(USER, h.installation);
    expect(ids).toHaveLength(1);
  });
});
