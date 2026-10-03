import { TIMEOUTS_MS } from '@bastion-mcp/core';
import { describe, expect, it } from 'vitest';
import { createPrincipalProfiles } from '../src/adapters/downstream/endpoint-data';
import { createPluginServices } from '../src/adapters/plugin-services';
import {
  DEFAULT_SERVER_VERSION,
  defaultWorkerId,
  isProduction,
  readServerEnv,
  serverVersion,
} from '../src/config';
import { resourceDefaults } from '../src/resource-env';
import { DRAIN_GRACE_MS, HARD_KILL_MS } from '../src/timing';
import { fakeInfra, manualClock } from './fake-infra';

describe('19.1 process settings come from the env argument, not import-time globals', () => {
  it('isProduction reads the env it is given', () => {
    expect(isProduction({ NODE_ENV: 'production' })).toBe(true);
    expect(isProduction({ NODE_ENV: 'test' })).toBe(false);
    expect(isProduction({})).toBe(false);
  });

  it('serverVersion falls back to the default', () => {
    expect(serverVersion({ version: undefined })).toBe(DEFAULT_SERVER_VERSION);
    expect(serverVersion({ version: '2.3.4' })).toBe('2.3.4');
  });

  it('readServerEnv reads sandbox paths and the egress host, with defaults', () => {
    expect(readServerEnv({})).toEqual({
      egressHost: undefined,
      runnerPath: '/opt/bastion/runner.mjs',
      runtimeDir: '/opt/runtime',
      publicDir: undefined,
    });
    expect(
      readServerEnv({
        BASTION_EGRESS_HOST: '10.1.2.3',
        BASTION_RUNNER_PATH: '/r.mjs',
        BASTION_RUNTIME_DIR: '/rt',
        BASTION_PUBLIC_DIR: '/pub',
      }),
    ).toEqual({
      egressHost: '10.1.2.3',
      runnerPath: '/r.mjs',
      runtimeDir: '/rt',
      publicDir: '/pub',
    });
  });

  it('resourceDefaults fills the OpenTelemetry resource attributes without overriding the env', () => {
    expect(resourceDefaults({ NODE_ENV: 'staging', BASTION_WORKER_ID: 'w1' })).toEqual({
      BASTION_VERSION: DEFAULT_SERVER_VERSION,
      BASTION_ENVIRONMENT: 'staging',
      BASTION_WORKER_ID: 'w1',
    });
    expect(
      resourceDefaults({
        BASTION_VERSION: '9',
        BASTION_ENVIRONMENT: 'prod',
        BASTION_WORKER_ID: 'x',
      }),
    ).toEqual({ BASTION_VERSION: '9', BASTION_ENVIRONMENT: 'prod', BASTION_WORKER_ID: 'x' });
    expect(resourceDefaults({}).BASTION_ENVIRONMENT).toBe('production');
  });

  it('defaultWorkerId uses hostname and pid when unset', () => {
    expect(defaultWorkerId({ BASTION_WORKER_ID: 'abc' })).toBe('abc');
    expect(defaultWorkerId({})).toMatch(new RegExp(`-${process.pid}$`));
  });
});

describe('21.2 shutdown budget', () => {
  it('drains for the graceful timeout and hard-kills after it with slack', () => {
    expect(DRAIN_GRACE_MS).toBe(TIMEOUTS_MS.graceful);
    expect(HARD_KILL_MS).toBeGreaterThan(DRAIN_GRACE_MS);
  });
});

describe('7.1 principal profile cache (TtlCache with the infra clock)', () => {
  const harness = () => {
    const clock = manualClock();
    const loads: string[] = [];
    const infra = fakeInfra({
      clock,
      repos: {
        users: {
          get: async (id: string) => {
            loads.push(id);
            return { email: 'Ada@Example.COM' };
          },
        },
      },
    });
    return { clock, loads, profiles: createPrincipalProfiles(infra) };
  };
  const user = { id: 'u1', type: 'user' } as never;

  it('derives the lowercase e-mail domain and caches for a minute', async () => {
    const h = harness();
    expect(await h.profiles.profile(user)).toEqual({
      email: 'Ada@Example.COM',
      emailDomain: 'example.com',
    });
    await h.profiles.profile(user);
    expect(h.loads).toEqual(['u1']);
    h.clock.advance(60_001);
    await h.profiles.profile(user);
    expect(h.loads).toEqual(['u1', 'u1']);
  });

  it('has no profile for service principals and never queries', async () => {
    const h = harness();
    expect(await h.profiles.profile({ id: 's1', type: 'service' } as never)).toEqual({});
    expect(h.loads).toEqual([]);
  });
});

describe('25.4 plugin services', () => {
  it('are built once per infra', () => {
    const infra = fakeInfra({
      config: { publicUrl: 'https://bastion.test', gitCacheDir: '/tmp/git' },
      db: { prisma: {} },
      repos: { releases: {}, orgSettings: {}, distributionEvents: {} },
      secretStore: {},
    });
    expect(createPluginServices(infra)).toBe(createPluginServices(infra));
    expect(createPluginServices(infra).baseUrl).toBe('https://bastion.test');
  });
});
