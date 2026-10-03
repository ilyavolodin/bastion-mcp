import { afterEach, describe, expect, it } from 'vitest';
import {
  CLIENT_ID,
  CredentialError,
  discoverEndpoints,
  isBastionRequest,
  isTerminalRefreshError,
  MemoryTokenStore,
  normalizeServerUrl,
  parseCredentialRequest,
  pollForToken,
  REQUESTED_SCOPE,
  refreshAccessToken,
  requestDeviceAuthorization,
  resolveServerUrl,
  runCli,
  TokenManager,
  verificationMessage,
} from '../src/index';
import { startFakeAuthServer } from './helpers/fake-auth-server';

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

const realFetch = (input: string | URL, init?: RequestInit) => fetch(input, init);

const harness = async (token: Parameters<typeof startFakeAuthServer>[0]['token'], extra = {}) => {
  const server = await startFakeAuthServer({ token, ...extra });
  closers.push(server.close);
  const sleeps: number[] = [];
  let clock = 1_000_000;
  const store = new MemoryTokenStore();
  const prompts: string[] = [];
  const manager = new TokenManager({
    server: server.url,
    store,
    fetch: realFetch,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    now: () => clock,
    prompt: async (a) => {
      prompts.push(verificationMessage(a));
    },
  });
  return { server, sleeps, store, prompts, manager, advance: (ms: number) => (clock += ms) };
};

const ok = (access: string, refresh?: string, expiresIn = 3600) => ({
  status: 200,
  body: {
    access_token: access,
    token_type: 'Bearer',
    expires_in: expiresIn,
    ...(refresh ? { refresh_token: refresh } : {}),
    scope: 'plugins:read offline_access',
  },
});
const err = (error: string, status = 400) => ({ status, body: { error } });

describe('25.6 server URL', () => {
  const home = '/home/u';
  it('25.6 BASTION_URL wins over the config file', () => {
    const url = resolveServerUrl({
      env: { BASTION_URL: 'https://mcp.example.com/some/path' },
      readFile: () => '{"url":"https://other"}',
      home,
    });
    expect(url.href).toBe('https://mcp.example.com/');
  });

  it('25.6 falls back to ~/.config/bastion/credential.json with { "url": ... }', () => {
    const paths: string[] = [];
    const url = resolveServerUrl({
      env: {},
      readFile: (p) => {
        paths.push(p);
        return '{"url": "https://mcp.example.com"}';
      },
      home,
    });
    expect(url.origin).toBe('https://mcp.example.com');
    expect(paths[0]?.replaceAll('\\', '/')).toBe('/home/u/.config/bastion/credential.json');
  });

  it('25.6 explains how to configure when nothing is set, and rejects bad files', () => {
    expect(() =>
      resolveServerUrl({
        env: {},
        readFile: () => {
          throw new Error('ENOENT');
        },
        home,
      }),
    ).toThrow(/BASTION_URL/);
    expect(() => resolveServerUrl({ env: {}, readFile: () => '{bad', home })).toThrow(/valid JSON/);
    expect(() => resolveServerUrl({ env: {}, readFile: () => '{"nope":1}', home })).toThrow(/url/);
  });

  it('25.6 requires https (http only on loopback for development)', () => {
    expect(() => normalizeServerUrl('http://mcp.example.com')).toThrow(/https/);
    expect(() => normalizeServerUrl('not a url')).toThrow(CredentialError);
    expect(normalizeServerUrl('http://localhost:3000').host).toBe('localhost:3000');
  });
});

describe('25.6 device authorization grant (RFC 8628) against a fake server', () => {
  it('25.6 runs the grant as the public client bastion-credential with scopes plugins:read offline_access', async () => {
    const h = await harness(() => ok('AT1', 'RT1'));
    expect(await h.manager.getAccessToken()).toBe('AT1');
    const deviceRequest = h.server.requests.find((r) => r.path === '/oauth/device/auth');
    expect(deviceRequest?.form.get('client_id')).toBe(CLIENT_ID);
    expect(CLIENT_ID).toBe('bastion-credential');
    expect(deviceRequest?.form.get('scope')).toBe('plugins:read offline_access');
    expect(REQUESTED_SCOPE).toBe('plugins:read offline_access');
    const tokenRequest = h.server.requests.find((r) => r.path === '/oauth/token');
    expect(tokenRequest?.form.get('grant_type')).toBe(
      'urn:ietf:params:oauth:grant-type:device_code',
    );
    expect(tokenRequest?.form.get('device_code')).toBe('DEVICE-CODE');
    expect(tokenRequest?.form.get('client_id')).toBe('bastion-credential');
    expect(tokenRequest?.form.has('client_secret')).toBe(false);
    expect(h.prompts[0]).toContain('/oauth/device?user_code=ABCD-EFGH');
  });

  it('25.6 polls with the server interval, continues on authorization_pending and backs off 5s on slow_down', async () => {
    const script = [
      err('authorization_pending'),
      err('slow_down'),
      err('authorization_pending'),
      ok('AT', 'RT'),
    ];
    const h = await harness((_f, call) => script[call - 1] ?? err('server_error', 500), {
      interval: 2,
    });
    expect(await h.manager.getAccessToken()).toBe('AT');
    expect(h.sleeps).toEqual([2000, 2000, 7000, 7000]);
  });

  it('25.6 fails on expired_token and access_denied, and when the device code lifetime passes', async () => {
    const expired = await harness(() => err('expired_token'));
    await expect(expired.manager.getAccessToken()).rejects.toThrow(/expired/);
    const denied = await harness(() => err('access_denied'));
    await expect(denied.manager.getAccessToken()).rejects.toThrow(/denied/);
    const slow = await harness(() => err('authorization_pending'), {
      interval: 100,
      expiresIn: 250,
    });
    await expect(slow.manager.getAccessToken()).rejects.toThrow(/expired/);
    const odd = await harness(() => err('weird'));
    await expect(odd.manager.getAccessToken()).rejects.toThrow(/weird/);
    const junk = await harness(() => ({ status: 200, body: 'not json object' }));
    await expect(junk.manager.getAccessToken()).rejects.toThrow(/unexpected/);
  });

  it('25.6 reports a refused device authorization request', async () => {
    const h = await harness(() => ok('x'), { deviceStatus: 401 });
    await expect(h.manager.getAccessToken()).rejects.toThrow(/refused/);
  });

  it('25.6 falls back to the default endpoints when discovery is unavailable', async () => {
    const h = await harness(() => ok('AT', 'RT'), { discovery: false });
    expect(await h.manager.getAccessToken()).toBe('AT');
    const endpoints = await discoverEndpoints(new URL('http://127.0.0.1:1'), realFetch);
    expect(endpoints).toEqual({
      deviceAuthorization: 'http://127.0.0.1:1/oauth/device/auth',
      token: 'http://127.0.0.1:1/oauth/token',
    });
  });

  it('25.6 keeps the refresh token in the TokenStore and the access token in memory only', async () => {
    const h = await harness(() => ok('AT', 'RT-secret'));
    await h.manager.getAccessToken();
    expect([...h.store.tokens.values()]).toEqual(['RT-secret']);
    expect(JSON.stringify([...h.store.tokens.entries()])).not.toContain('AT"');
    const before = h.server.requests.length;
    expect(await h.manager.getAccessToken()).toBe('AT'); // cached: no network
    expect(h.server.requests.length).toBe(before);
  });

  it('25.6 uses the stored refresh token (and stores the rotated one) instead of a new device grant', async () => {
    const h = await harness((form) =>
      form.get('grant_type') === 'refresh_token' ? ok('AT2', 'RT2') : err('server_error', 500),
    );
    await h.store.set(h.server.url.origin, 'RT1');
    expect(await h.manager.getAccessToken()).toBe('AT2');
    const refresh = h.server.requests.find((r) => r.form.get('grant_type') === 'refresh_token');
    expect(refresh?.form.get('refresh_token')).toBe('RT1');
    expect(h.server.requests.some((r) => r.path === '/oauth/device/auth')).toBe(false);
    expect(await h.store.get(h.server.url.origin)).toBe('RT2');
  });

  it('25.6 runs the device grant again when the refresh token has expired', async () => {
    const h = await harness((form) =>
      form.get('grant_type') === 'refresh_token' ? err('invalid_grant') : ok('AT3', 'RT3'),
    );
    await h.store.set(h.server.url.origin, 'stale');
    expect(await h.manager.getAccessToken()).toBe('AT3');
    expect(await h.store.get(h.server.url.origin)).toBe('RT3');
  });

  it('25.6 refreshes the cached access token when it is about to expire', async () => {
    let n = 0;
    const h = await harness((form) =>
      form.get('grant_type') === 'refresh_token'
        ? ok(`AT-r${++n}`, 'RT-n', 60)
        : ok('AT-first', 'RT-1', 60),
    );
    expect(await h.manager.getAccessToken()).toBe('AT-first');
    h.advance(40_000); // within the 30 s skew of the 60 s lifetime
    expect(await h.manager.getAccessToken()).toBe('AT-r1');
  });

  it('25.6 surfaces unexpected refresh failures and handles invalid_request', async () => {
    const endpoints = { deviceAuthorization: 'x', token: 'x' };
    const respond = (status: number, body: unknown) => async () =>
      new Response(JSON.stringify(body), { status });
    await expect(
      refreshAccessToken(endpoints, 'r', respond(500, { error: 'server_error' })),
    ).rejects.toThrow(/refresh/);
    expect(
      await refreshAccessToken(endpoints, 'r', respond(400, { error: 'invalid_grant' })),
    ).toBeUndefined();
    await expect(
      refreshAccessToken(endpoints, 'r', respond(400, { error: 'invalid_request' })),
    ).rejects.toThrow(/refresh/);
    await expect(
      refreshAccessToken(endpoints, 'r', respond(401, { error: 'invalid_client' })),
    ).rejects.toThrow(/refresh/);
    await expect(requestDeviceAuthorization(endpoints, respond(200, { nope: 1 }))).rejects.toThrow(
      /refused/,
    );
    await expect(
      pollForToken(
        endpoints,
        { device_code: 'd', user_code: 'u', verification_uri: 'v', expires_in: 10 },
        {
          fetch: respond(200, { access_token: 'T', token_type: 'Bearer' }),
          sleep: async () => undefined,
          now: () => 0,
        },
      ),
    ).resolves.toMatchObject({ access_token: 'T' });
    expect(
      verificationMessage({
        device_code: 'd',
        user_code: 'U-1',
        verification_uri: 'https://v',
        expires_in: 1,
      }),
    ).toBe('To sign in to Bastion, open https://v and enter the code U-1\n');
  });
});

describe('25.6 commands', () => {
  const server = new URL('https://mcp.example.com');
  const run = async (
    argv: string[],
    stdin: string,
    getAccessToken = async () => 'TOKEN-123',
    url = server,
  ) => {
    const out: string[] = [];
    const errs: string[] = [];
    const code = await runCli(argv, {
      io: { readStdin: async () => stdin, stdout: (t) => out.push(t), stderr: (t) => errs.push(t) },
      server: () => url,
      getAccessToken,
    });
    return { code, out: out.join(''), err: errs.join('') };
  };

  it("25.6 get: prints username=x-access-token and password=<token> for Bastion's host", async () => {
    const result = await run(
      ['get'],
      'protocol=https\nhost=mcp.example.com\npath=plugins/acme.git\n\n',
    );
    expect(result).toEqual({
      code: 0,
      out: 'username=x-access-token\npassword=TOKEN-123\n',
      err: '',
    });
  });

  it('25.6 get: prints nothing for other hosts, protocols and missing fields', async () => {
    for (const stdin of [
      'protocol=https\nhost=github.com\n\n',
      'protocol=http\nhost=mcp.example.com\n\n',
      'host=mcp.example.com\n\n',
      '',
    ]) {
      expect(await run(['get'], stdin)).toEqual({ code: 0, out: '', err: '' });
    }
    expect(isBastionRequest({ protocol: 'https', host: 'MCP.example.com' }, server)).toBe(true);
    expect(isBastionRequest({ protocol: 'https', host: 'mcp.example.com:8443' }, server)).toBe(
      false,
    );
    expect(
      isBastionRequest({ protocol: 'http', host: '127.0.0.1:5' }, new URL('http://127.0.0.1:5')),
    ).toBe(true);
    expect(parseCredentialRequest('a=b\nc=d=e\n\nignored=1\n')).toEqual({ a: 'b', c: 'd=e' });
  });

  it('25.6 token: prints a bare token on stdout', async () => {
    expect(await run(['token'], '')).toEqual({ code: 0, out: 'TOKEN-123', err: '' });
  });

  it('25.6 store and erase are no-ops; unknown commands fail with usage', async () => {
    expect(
      await run(['store'], 'protocol=https\nhost=mcp.example.com\nusername=x\npassword=y\n\n'),
    ).toEqual({ code: 0, out: '', err: '' });
    expect(await run(['erase'], '')).toEqual({ code: 0, out: '', err: '' });
    const unknown = await run(['nope'], '');
    expect(unknown.code).toBe(2);
    expect(unknown.err).toMatch(/usage/);
    expect((await run([], '')).code).toBe(2);
  });

  it('25.6 errors go to stderr without leaking tokens or internals', async () => {
    const denied = await run(['token'], '', async () => {
      throw new CredentialError('the sign-in was denied');
    });
    expect(denied).toEqual({
      code: 1,
      out: '',
      err: 'bastion-credential: the sign-in was denied\n',
    });
    const crash = await run(['get'], 'protocol=https\nhost=mcp.example.com\n\n', async () => {
      throw new Error('secret TOKEN-999 in stack');
    });
    expect(crash.code).toBe(1);
    expect(crash.err).not.toContain('TOKEN-999');
  });
});

describe('25.6 isTerminalRefreshError', () => {
  it('25.6 only invalid_grant means the stored refresh token is dead', () => {
    expect(isTerminalRefreshError('invalid_grant')).toBe(true);
    for (const error of ['invalid_request', 'invalid_client', 'server_error', '', undefined]) {
      expect(isTerminalRefreshError(error)).toBe(false);
    }
  });

  it('25.6 a configuration error keeps the stored refresh token', async () => {
    const h = await harness((form) =>
      form.get('grant_type') === 'refresh_token' ? err('invalid_client', 401) : ok('AT'),
    );
    await h.store.set(h.server.url.origin, 'RT-keep');
    await expect(h.manager.getAccessToken()).rejects.toThrow(/refresh/);
    expect(await h.store.get(h.server.url.origin)).toBe('RT-keep');
  });
});
