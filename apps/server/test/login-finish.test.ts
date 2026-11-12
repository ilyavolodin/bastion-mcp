import {
  IdpClaimError,
  IdpLoginError,
  OAuthProtocolError,
  type ProvisioningEvent,
} from '@bastion-mcp/auth';
import { BastionError } from '@bastion-mcp/core';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { registerLoginRoutes } from '../src/http/ui/login';
import type { UiDeps } from '../src/http/ui/util';
import { fakeInfra, recordingLogger } from './fake-infra';

type Existing = {
  id: string;
  email: string;
  displayName: string;
  orgRole: 'admin' | 'member';
  status: 'active' | 'deactivated';
  idpConnectionId: string | null;
  externalSubject: string | null;
  isLocal: boolean;
  memberships: never[];
};

type Setup = {
  existing?: Existing;
  storeRefreshToken?: boolean;
  refreshToken?: string | null;
  returnTo?: string | null;
  scim?: boolean;
  hook?: 'ok' | 'throws' | 'none';
  completeError?: Error;
  applyError?: Error;
  saveError?: Error;
  enabled?: boolean;
};

const ISSUER = 'https://idp.example';

const build = async (setup: Setup = {}) => {
  const calls: string[] = [];
  const logger = recordingLogger();
  const hookEvents: (readonly ProvisioningEvent[])[] = [];
  const applied: unknown[] = [];
  const saved: unknown[] = [];
  const completed: unknown[][] = [];
  const connection = {
    id: 'conn1',
    issuer: ISSUER,
    claimMap: {},
    emailDomains: [],
    enabled: setup.enabled ?? true,
    storeRefreshToken: setup.storeRefreshToken ?? false,
  };
  const scim =
    setup.scim === false
      ? undefined
      : {
          findUserIdByEmail: async (email: string) => {
            calls.push(`findUserIdByEmail:${email}`);
            return setup.existing?.id ?? null;
          },
          getUserState: async (id: string) => {
            calls.push(`getUserState:${id}`);
            return setup.existing ?? null;
          },
          listRules: async (id: string) => {
            calls.push(`listRules:${id}`);
            return [];
          },
          listTeamRefs: async () => {
            calls.push('listTeamRefs');
            return [];
          },
        };
  const infra = fakeInfra({
    config: { publicUrl: 'http://localhost:3000' },
    logger,
    repos: {
      scim,
      provisioning: {
        applyPlan: async (plan: unknown, actor: unknown) => {
          calls.push('applyPlan');
          applied.push({ plan, actor });
          if (setup.applyError) throw setup.applyError;
        },
      },
      users: {
        recordLogin: async (id: string) => {
          calls.push(`recordLogin:${id}`);
        },
      },
    },
  });
  const auth = {
    idpLogin: {
      completeLogin: async (...args: unknown[]) => {
        calls.push('completeLogin');
        completed.push(args);
        if (setup.completeError) throw setup.completeError;
        return {
          connection,
          profile: {
            sub: 'sub-1',
            email: 'ann@example.com',
            name: 'Ann',
            groups: [],
            issuer: ISSUER,
            connectionId: 'conn1',
          },
          tokens: {
            accessToken: 'at',
            idToken: null,
            refreshToken: setup.refreshToken ?? null,
            expiresAt: null,
            scope: null,
          },
          returnTo: setup.returnTo === undefined ? '/app/x' : setup.returnTo,
        };
      },
    },
    idpTokens: {
      save: async (...args: unknown[]) => {
        calls.push('tokens.save');
        saved.push(args);
        if (setup.saveError) throw setup.saveError;
      },
    },
    sessions: {
      create: async (input: { principalId: string }) => {
        calls.push(`session:${input.principalId}`);
        return { id: 'sid1', ttlSeconds: 60, csrfToken: 'csrf1' };
      },
    },
  };
  const app = Fastify();
  const hook = setup.hook ?? 'none';
  await registerLoginRoutes(app, { infra, auth } as unknown as UiDeps, {
    ...(hook === 'none'
      ? {}
      : {
          onProvisioned: async (events: readonly ProvisioningEvent[]) => {
            calls.push('hook');
            hookEvents.push(events);
            if (hook === 'throws') throw new Error('hook boom');
          },
        }),
  });
  return { app, calls, logger, hookEvents, applied, saved, completed };
};

const callback = (app: Awaited<ReturnType<typeof build>>['app'], cookie?: string) =>
  app.inject({
    method: 'GET',
    url: '/auth/callback/conn1?code=c1&state=s1',
    ...(cookie ? { headers: { cookie } } : {}),
  });

const setCookies = (res: { headers: Record<string, unknown> }): string[] => {
  const v = res.headers['set-cookie'];
  return Array.isArray(v) ? (v as string[]) : typeof v === 'string' ? [v] : [];
};

const existingUser = (over: Partial<Existing> = {}): Existing => ({
  id: 'u-existing',
  email: 'ann@example.com',
  displayName: 'Ann',
  orgRole: 'member',
  status: 'active',
  idpConnectionId: 'conn1',
  externalSubject: `${ISSUER}#sub-1`,
  isLocal: false,
  memberships: [],
  ...over,
});

describe('9.1 IdP sign-in completion', () => {
  it('first login: runs lookups, plan, recordLogin, hook and session in that order, then redirects', async () => {
    const t = await build({ hook: 'ok' });
    const res = await callback(t.app, 'bastion_login=s1');
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/app/x');
    expect(res.headers['cache-control']).toBe('no-store');
    const userId = (t.applied[0] as { plan: { user: { id: string } } }).plan.user.id;
    expect(t.calls).toEqual([
      'completeLogin',
      'findUserIdByEmail:ann@example.com',
      'listRules:conn1',
      'listTeamRefs',
      'applyPlan',
      `recordLogin:${userId}`,
      'hook',
      `session:${userId}`,
    ]);
    expect((t.applied[0] as { actor: unknown }).actor).toEqual({ actorType: 'system' });
    expect(t.completed[0]).toEqual(['conn1', 'code=c1&state=s1', 's1']);
    expect(t.hookEvents[0]?.map((e) => e.type)).toEqual(['user.created']);
  });

  it('the state cookie is cleared first and every cookie is sent exactly once, in order', async () => {
    const t = await build();
    const res = await callback(t.app, 'bastion_login=s1');
    const clear = 'bastion_login=; Path=/auth/callback; Max-Age=0; HttpOnly; SameSite=Lax';
    const sid = 'bastion_sid=sid1; Path=/; Max-Age=60; HttpOnly; SameSite=Lax';
    expect(setCookies(res)).toEqual([
      clear,
      sid,
      'bastion_csrf=csrf1; Path=/; Max-Age=60; SameSite=Lax',
    ]);
  });

  it('an existing user is not recorded as a login by the server (only a created user is) and keeps their id', async () => {
    const t = await build({ existing: existingUser(), hook: 'ok' });
    const res = await callback(t.app, 'bastion_login=s1');
    expect(res.statusCode).toBe(302);
    expect(t.calls).toEqual([
      'completeLogin',
      'findUserIdByEmail:ann@example.com',
      'getUserState:u-existing',
      'listRules:conn1',
      'listTeamRefs',
      'applyPlan',
      'session:u-existing',
    ]);
  });

  it('calls the hook only when the plan has events', async () => {
    const t = await build({ existing: existingUser(), hook: 'ok' });
    await callback(t.app, 'bastion_login=s1');
    expect(t.hookEvents).toEqual([]);
  });

  it('a failing hook is only logged and the session still starts', async () => {
    const t = await build({ hook: 'throws' });
    const res = await callback(t.app, 'bastion_login=s1');
    expect(res.statusCode).toBe(302);
    expect(t.logger.calls.warn).toEqual([
      { fields: { err: 'hook boom' }, message: 'provisioning hook failed' },
    ]);
    expect(t.calls.at(-1)).toMatch(/^session:/);
  });

  it('saves IdP tokens before the hook when the connection stores refresh tokens', async () => {
    const t = await build({ storeRefreshToken: true, hook: 'ok' });
    await callback(t.app, 'bastion_login=s1');
    const userId = (t.applied[0] as { plan: { user: { id: string } } }).plan.user.id;
    expect(t.calls).toEqual([
      'completeLogin',
      'findUserIdByEmail:ann@example.com',
      'listRules:conn1',
      'listTeamRefs',
      'applyPlan',
      `recordLogin:${userId}`,
      'tokens.save',
      'hook',
      `session:${userId}`,
    ]);
    expect(t.saved[0]).toEqual([
      userId,
      'conn1',
      { accessToken: 'at', idToken: null, refreshToken: null, expiresAt: null, scope: null },
    ]);
  });

  it('saves IdP tokens when the IdP returned a refresh token even if the connection does not store them', async () => {
    const t = await build({ refreshToken: 'rt' });
    await callback(t.app, 'bastion_login=s1');
    expect(t.calls).toContain('tokens.save');
  });

  it('does not save tokens without a refresh token on a connection that does not store them', async () => {
    const t = await build();
    await callback(t.app, 'bastion_login=s1');
    expect(t.calls).not.toContain('tokens.save');
  });

  it('works without the SCIM repository: no existing user, no rules, no teams', async () => {
    const t = await build({ scim: false });
    const res = await callback(t.app, 'bastion_login=s1');
    expect(res.statusCode).toBe(302);
    expect(t.calls.slice(0, 2)).toEqual(['completeLogin', 'applyPlan']);
  });

  it('a return target the IdP did not set, or an unsafe one, falls back to /', async () => {
    const none = await build({ returnTo: null });
    expect((await callback(none.app, 'bastion_login=s1')).headers.location).toBe('/');
    const unsafe = await build({ returnTo: '//evil.example' });
    expect((await callback(unsafe.app, 'bastion_login=s1')).headers.location).toBe('/');
  });

  it('without a state cookie: 400 page, state cookie cleared, nothing else runs', async () => {
    const t = await build();
    const res = await callback(t.app);
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('The sign-in session expired. Try again.');
    expect(res.body).toContain('/auth/login');
    expect(t.calls).toEqual([]);
    expect(setCookies(res)).toEqual([
      'bastion_login=; Path=/auth/callback; Max-Age=0; HttpOnly; SameSite=Lax',
    ]);
  });

  it('a refused provisioning (deactivated user) is a 403 page and nothing is applied or started', async () => {
    const t = await build({ existing: existingUser({ status: 'deactivated' }) });
    const res = await callback(t.app, 'bastion_login=s1');
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Sign-in was refused: user is deactivated.');
    expect(t.calls).not.toContain('applyPlan');
    expect(t.calls.some((c) => c.startsWith('session:'))).toBe(false);
    expect(setCookies(res)).toHaveLength(1);
  });

  it('a disabled identity provider is refused with the plan message', async () => {
    const t = await build({ enabled: false });
    const res = await callback(t.app, 'bastion_login=s1');
    expect(res.statusCode).toBe(403);
    expect(res.body).toContain('Sign-in was refused: identity provider is disabled.');
  });

  it.each([
    ['IdpLoginError', new IdpLoginError('bad state', 'state')],
    ['IdpClaimError', new IdpClaimError('no email')],
    ['OAuthProtocolError', new OAuthProtocolError('invalid_grant')],
    ['BastionError', new BastionError('CONFLICT', 'dup', { httpStatus: 409 })],
  ])('%s from the IdP exchange is a 400 page and a warning', async (_name, error) => {
    const t = await build({ completeError: error });
    const res = await callback(t.app, 'bastion_login=s1');
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Sign-in failed. Try again or contact your administrator.');
    expect(t.logger.calls.warn).toEqual([
      { fields: { err: error.message }, message: 'idp login failed' },
    ]);
    expect(t.calls).toEqual(['completeLogin']);
  });

  it('a BastionError after the plan was applied is still a 400 and no session starts', async () => {
    const t = await build({
      storeRefreshToken: true,
      saveError: new BastionError('CONFLICT', 'x', { httpStatus: 409 }),
    });
    const res = await callback(t.app, 'bastion_login=s1');
    expect(res.statusCode).toBe(400);
    expect(t.calls).toContain('applyPlan');
    expect(t.calls.some((c) => c.startsWith('session:'))).toBe(false);
  });

  it('an unexpected error is rethrown to the framework (500)', async () => {
    const t = await build({ applyError: new Error('db down') });
    const res = await callback(t.app, 'bastion_login=s1');
    expect(res.statusCode).toBe(500);
    expect(t.calls).not.toContain('recordLogin:');
  });

  describe('root-redirect connection', () => {
    it('finishes from `/` using the connection id and state in the cookie, clearing it on `/`', async () => {
      const t = await build();
      const res = await t.app.inject({
        method: 'GET',
        url: '/?code=c1&state=s1',
        headers: { cookie: 'bastion_login=conn1~s1' },
      });
      expect(res.statusCode).toBe(302);
      expect(t.completed[0]).toEqual(['conn1', 'code=c1&state=s1', 's1']);
      expect(setCookies(res)[0]).toBe('bastion_login=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
    });

    it('without the cookie it answers the expired-session page and clears nothing', async () => {
      const t = await build();
      const res = await t.app.inject({ method: 'GET', url: '/?code=c1&state=s1' });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('The sign-in session expired. Try again.');
      expect(setCookies(res)).toEqual([]);
      expect(t.calls).toEqual([]);
    });
  });
});
