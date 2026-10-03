import { type ApiDeps, registerApi, UnavailableApiError } from '@bastion-mcp/api';
import {
  AuthenticationError,
  buildPrincipal,
  PatService,
  type Principal,
  type RevocationEvent,
  type RevocationStore,
} from '@bastion-mcp/auth';
import { newId } from '@bastion-mcp/core';
import { PolicyEngine } from '@bastion-mcp/policy';
import Fastify, { type FastifyInstance } from 'fastify';
import { createEventBus, type RedisEventBus } from '../../src/adapters/api/events';
import { createIdentityPorts } from '../../src/adapters/api/identity';
import { createAuditReader, createCallReader } from '../../src/adapters/api/observability';
import { createSecretsPort } from '../../src/adapters/api/secrets';
import { createSystemStatus } from '../../src/adapters/api/system';
import { createApiPersistence } from '../../src/adapters/api/unit-of-work';
import { authRedis } from '../../src/adapters/redis';
import type { Infra } from '../../src/infra';

/** A port the test does not exercise: any call fails loudly. */
export const notConfigured = <T extends object>(name: string): T =>
  new Proxy({} as T, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      return () => {
        throw new UnavailableApiError(`${name}.${String(prop)}`);
      };
    },
  });

class MemoryRevocations implements RevocationStore {
  readonly events: RevocationEvent[] = [];
  private readonly marks = new Map<string, number>();
  async getWatermark(id: string) {
    return this.marks.get(id) ?? null;
  }
  async setWatermark(id: string, at: number) {
    this.marks.set(id, at);
  }
  async publish(event: RevocationEvent) {
    this.events.push(event);
  }
}

export type ApiHarness = {
  app: FastifyInstance;
  deps: ApiDeps;
  events: RedisEventBus;
  adminId: string;
  /** `Authorization` header value of the admin. */
  admin: string;
  call(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    url: string,
    options?: {
      body?: unknown;
      query?: Record<string, string>;
      headers?: Record<string, string>;
      token?: string;
    },
  ): Promise<{
    status: number;
    // biome-ignore lint/suspicious/noExplicitAny: tests index into JSON bodies freely
    body: any;
    headers: Record<string, string | string[] | number | undefined>;
  }>;
  close(): Promise<void>;
};

const CHALLENGE =
  'Bearer resource_metadata="https://bastion.test/.well-known/oauth-protected-resource/api", scope="api:read"';

/**
 * The API over the REAL persistence adapters (store, unit of work, readers, secrets, events, system) with a stubbed
 * authentication: `Bearer <userId>` authenticates that database user as an API principal. Ports that belong to other
 * parts of the server (catalog tests, plugins, registry sync, guards, installation runtime) are `notConfigured`.
 */
export const buildApiHarness = async (
  infra: Infra,
  overrides: Partial<ApiDeps> = {},
): Promise<ApiHarness> => {
  const persistence = await createApiPersistence(infra);
  const events = createEventBus({ redis: infra.redis, duplicate: infra.duplicateRedis });
  await events.start();
  const principals = infra.repos.principals;
  const admin = await infra.repos.users.create({
    email: 'root@example.com',
    displayName: 'Root',
    orgRole: 'admin',
  });
  const clock = { now: () => new Date() };
  const principalOf = async (id: string, scopes: readonly string[]): Promise<Principal> => {
    const record = await principals.getPrincipal(id);
    if (!record?.active)
      throw new AuthenticationError('INVALID_TOKEN', 'invalid access token', CHALLENGE);
    return buildPrincipal(record, { authMethod: 'pat', scopes, credentialId: 'test' });
  };
  const policyData = infra.repos.policyData;
  const deps: ApiDeps = {
    config: { baseUrl: 'https://bastion.test', sseHeartbeatMs: 60_000 },
    auth: {
      tokens: {
        async verify(authorization) {
          const token = authorization?.replace(/^Bearer /i, '');
          if (!token)
            throw new AuthenticationError('UNAUTHENTICATED', 'authentication required', CHALLENGE);
          return principalOf(token, ['api:read', 'api:write']);
        },
      },
      sessions: { authenticate: async () => null, checkCsrf: async () => false },
    },
    principals,
    policy: {
      engine: () => PolicyEngine.fromDataSource(policyData),
      data: policyData,
    },
    store: persistence.store,
    uow: persistence.uow,
    redis: authRedis(infra.redis),
    publisher: persistence.publisher,
    events,
    pats: new PatService({
      pats: infra.repos.pats,
      revocations: new MemoryRevocations(),
      policy: infra.repos.orgSettings,
    }),
    deactivation: { execute: async () => {} },
    secrets: createSecretsPort(infra.vault),
    identity: createIdentityPorts(infra),
    account: { changePassword: async () => ({ ok: false, reason: 'invalid_current' }) },
    system: createSystemStatus(infra, {
      driverState: async () => ({ name: 'none', healthy: true }),
    }),
    catalog: notConfigured('catalog'),
    installations: notConfigured('installations'),
    registry: notConfigured('registry'),
    guards: notConfigured('guards'),
    plugins: notConfigured('plugins'),
    observability: {
      calls: createCallReader({ prisma: infra.db.prisma, repos: infra.repos }),
      audit: createAuditReader({ prisma: infra.db.prisma, repos: infra.repos }),
    },
    limits: { readUsage: async () => [] } as never,
    clock,
    newId,
    ...overrides,
  };
  const app = Fastify({ logger: process.env.API_TEST_LOG ? { level: 'error' } : false });
  await registerApi(app, deps);
  await app.ready();
  return {
    app,
    deps,
    events,
    adminId: admin.id,
    admin: `Bearer ${admin.id}`,
    async call(method, url, options = {}) {
      const headers: Record<string, string> = {
        authorization: options.token ?? `Bearer ${admin.id}`,
        ...options.headers,
      };
      if (options.body !== undefined) headers['content-type'] = 'application/json';
      const res = await app.inject({
        method,
        url: `/api/v1${url}`,
        headers,
        ...(options.query ? { query: options.query } : {}),
        ...(options.body === undefined ? {} : { payload: JSON.stringify(options.body) }),
      });
      let body: unknown = res.body;
      try {
        body = res.body.length > 0 ? JSON.parse(res.body) : null;
      } catch {
        // not JSON
      }
      return { status: res.statusCode, body, headers: res.headers };
    },
    async close() {
      await app.close();
      await events.close();
    },
  };
};
