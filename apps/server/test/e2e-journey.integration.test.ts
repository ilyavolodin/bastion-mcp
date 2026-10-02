/**
 * The full user journey through the real all-in-one server (4, 9, 10, 11, 13, 14, 15): an admin signs in through OIDC,
 * creates, tests and publishes a catalog entry for a remote upstream; a second user installs it; an SDK v2 client
 * authenticates with OAuth 2.1 and calls the tool; the call shows up in the call log and the audit log. Then policy,
 * guards, limits, the legacy era, PATs, SCIM and revocation, each against the same running system.
 */
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FakeModernServer, startFakeModernServer } from '@bastion-mcp/testkit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import { type FakeIdp, startFakeIdp } from './helpers/fake-idp';
import {
  api,
  connectWithOAuth,
  connectWithToken,
  eventually,
  loginAs,
  PUBLIC_ORIGIN,
  seedIdp,
  textOf,
  withEtag,
} from './helpers/journey';
import { bootStack, type Stack } from './helpers/stack';
import type { Browser } from './helpers/ui-harness';

const WEB_DIST = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');
const ADA = {
  sub: 'idp-ada',
  email: 'ada@acme.example',
  name: 'Ada Admin',
  groups: ['bastion-admins'],
};
const BOB = { sub: 'idp-bob', email: 'bob@acme.example', name: 'Bob Member', groups: ['eng'] };

type Item = Record<string, unknown>;
const items = (body: unknown): Item[] => (body as { items: Item[] }).items;

describe.skipIf(!haveDocker())(
  'E2E journey: admin -> catalog -> user -> OAuth -> MCP (4, 9, 11, 15)',
  () => {
    let env: TestEnv;
    let stack: Stack;
    let idp: FakeIdp;
    let upstream: FakeModernServer;
    let admin: Browser;
    let bob: Browser;
    let entryId = '';
    let versionId = '';
    let installationId = '';
    let bobId = '';
    let bobToken = '';

    const base = (): string => `http://127.0.0.1:${stack.port}`;

    beforeAll(async () => {
      env = await createTestEnv();
      idp = await startFakeIdp();
      upstream = await startFakeModernServer();
      stack = await bootStack({ env, options: { publicDir: WEB_DIST } });
      await seedIdp(stack.server.infra, idp);
    });
    afterAll(async () => {
      await stack?.stop();
      await upstream?.close();
      await idp?.close();
      await env?.cleanup();
    });

    it('9.1 the admin signs in through OIDC and gets a session whose /me says admin', async () => {
      admin = await loginAs(base(), idp, ADA);
      const me = await api(admin, 'GET', '/me');
      expect(me.status).toBe(200);
      expect(JSON.stringify(me.body)).toContain('admin');
    });

    it('11.1 the admin creates a catalog entry and a version for a remote upstream', async () => {
      const entry = await api(admin, 'POST', '/catalog', {
        slug: 'fake',
        displayName: 'Fake upstream',
        description: 'e2e',
        visibility: { org: true, teamIds: [], userIds: [] },
        risk: 'low',
      });
      expect(entry.status).toBe(201);
      entryId = String((entry.body as Item).id);
      const version = await api(admin, 'POST', `/catalog/${entryId}/versions`, {
        label: '1',
        serverSpec: {
          type: 'remote',
          transport: 'streamable-http',
          url: upstream.url,
          auth: { mode: 'none' },
        },
      });
      expect(version.status).toBe(201);
      versionId = String((version.body as Item).id);
    });

    it('11.2 the automatic test runs the definition scan and snapshot; publishing needs it to pass', async () => {
      const early = await api(admin, 'POST', `/catalog/${entryId}/versions/${versionId}/publish`);
      expect(early.status).toBeGreaterThanOrEqual(400);
      const started = await api(admin, 'POST', `/catalog/${entryId}/versions/${versionId}/test`);
      expect([200, 201, 202]).toContain(started.status);
      const run = await eventually(async () => {
        const res = await admin.request(
          `${PUBLIC_ORIGIN}/api/v1/catalog/${entryId}/versions/${versionId}/test`,
          {
            headers: { accept: 'text/event-stream' },
          },
        );
        const text = await res.text();
        const datas = text
          .split(String.fromCharCode(10))
          .filter((l) => l.startsWith('data:'))
          .map((l) => JSON.parse(l.slice(5).trim()) as { status?: string });
        const last = datas.at(-1);
        return last && last.status && last.status !== 'running' ? last : undefined;
      });
      expect(run.status).toBe('passed');
    });

    it('11.1 the admin publishes the version', async () => {
      const res = await api(admin, 'POST', `/catalog/${entryId}/versions/${versionId}/publish`);
      expect(res.status).toBe(200);
      expect((res.body as Item).status).toBe('published');
    });

    it('11.4 a second user signs in as a member and installs the server from the store', async () => {
      bob = await loginAs(base(), idp, BOB);
      const store = await api(bob, 'GET', '/store');
      expect(store.status).toBe(200);
      expect(items(store.body).map((e) => e.slug)).toContain('fake');
      const created = await api(bob, 'POST', '/installations', { catalogEntryId: entryId });
      expect(created.status).toBe(201);
      installationId = String((created.body as Item).id);
      bobId = String((created.body as Item).ownerId);
    });

    it('9.3, 6, 4.4 an SDK v2 client runs the OAuth 2.1 flow (DCR, PKCE, consent) and calls tools through /mcp', async () => {
      const session = await connectWithOAuth(base(), idp, BOB);
      bobToken = session.accessToken;
      try {
        expect(session.consentHtml).toContain('E2E SDK client');
        const tools = await session.client.listTools();
        const names = tools.tools.map((t) => t.name);
        expect(names).toContain('fake__echo');
        const result = await session.client.callTool({
          name: 'fake__echo',
          arguments: { text: 'hello bastion' },
        });
        expect(textOf(result)).toBe('hello bastion');
      } finally {
        await session.client.close();
      }
    });

    it('15.5, 15.6 the call is in GET /api/v1/calls and the publish is in the audit log', async () => {
      const call = await eventually(async () => {
        const res = await api(admin, 'GET', '/calls?limit=50');
        return items(res.body).find(
          (c) => c.itemName === 'fake__echo' || c.upstreamName === 'echo',
        );
      });
      expect(call.outcome).toBe('ok');
      expect(call.installationId).toBe(installationId);
      const audit = await api(admin, 'GET', '/audit?limit=200');
      const actions = items(audit.body).map((a) => a.action);
      expect(actions).toEqual(
        expect.arrayContaining(['catalog.version.publish', 'catalog.entry.create']),
      );
      const verify = await api(admin, 'GET', '/audit/verify');
      expect((verify.body as { ok: boolean }).ok).toBe(true);
    });

    it('13.1, 13.2 a secret in a tool response is redacted by the response guards', async () => {
      const token = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
      const client = await connectWithToken(base(), bobToken);
      try {
        const result = await client.callTool({
          name: 'fake__echo',
          arguments: { text: `key=${token}` },
        });
        expect(textOf(result)).not.toContain(token);
      } finally {
        await client.close();
      }
    });

    it('10.3 a forbid rule hides the tool and blocks the call', async () => {
      const rule = await api(admin, 'POST', '/policy-rules', {
        name: 'No echo for members',
        effect: 'forbid',
        who: { role: 'member' },
        what: { toolName: 'echo' },
      });
      expect(rule.status).toBe(201);
      const ruleId = String((rule.body as Item).id);
      try {
        const client = await connectWithToken(base(), bobToken);
        try {
          await eventually(async () => {
            const tools = await client.listTools();
            return tools.tools.every((t) => t.name !== 'fake__echo') ? true : undefined;
          });
          const blocked = await client
            .callTool({ name: 'fake__echo', arguments: { text: 'x' } })
            .then(
              (r) => r,
              (e: unknown) => e,
            );
          const denied =
            blocked instanceof Error || (blocked as { isError?: boolean }).isError === true;
          expect(denied).toBe(true);
        } finally {
          await client.close();
        }
      } finally {
        await withEtag(admin, 'DELETE', `/policy-rules/${ruleId}`);
      }
      const client = await connectWithToken(base(), bobToken);
      try {
        await eventually(async () => {
          const tools = await client.listTools();
          return tools.tools.some((t) => t.name === 'fake__echo') ? true : undefined;
        });
      } finally {
        await client.close();
      }
    });

    it('14.1 a low rate rule rejects calls over the limit', async () => {
      const rule = await api(admin, 'POST', '/limit-rules', {
        name: 'tiny',
        subject: 'user',
        kind: 'rate',
        params: { points: 2, perSeconds: 60, burst: 0 },
      });
      expect(rule.status).toBe(201);
      const ruleId = String((rule.body as Item).id);
      try {
        const client = await connectWithToken(base(), bobToken);
        try {
          const outcomes: boolean[] = [];
          await new Promise((r) => setTimeout(r, 1500));
          for (let i = 0; i < 6; i++) {
            const r = await client
              .callTool({ name: 'fake__echo', arguments: { text: String(i) } })
              .then(
                (x) => (x as { isError?: boolean }).isError !== true,
                () => false,
              );
            outcomes.push(r);
          }
          expect(outcomes.some((ok) => !ok)).toBe(true);
        } finally {
          await client.close();
        }
      } finally {
        await withEtag(admin, 'DELETE', `/limit-rules/${ruleId}`);
      }
    });

    it('6.2 a legacy-era client (2025 handshake) works against the same gateway', async () => {
      await new Promise((r) => setTimeout(r, 1500));
      const client = await connectWithToken(base(), bobToken, { era: 'legacy' });
      try {
        const tools = await client.listTools();
        expect(tools.tools.map((t) => t.name)).toContain('fake__echo');
        const result = await client.callTool({ name: 'fake__echo', arguments: { text: 'legacy' } });
        expect(textOf(result)).toBe('legacy');
      } finally {
        await client.close();
      }
    });

    it('9.3 a personal access token authenticates /mcp', async () => {
      const created = await api(bob, 'POST', '/tokens', { name: 'e2e', scopes: ['mcp'] });
      expect(created.status).toBe(201);
      const pat = String((created.body as Item).token);
      expect(pat.startsWith('bst_') || pat.length > 20).toBe(true);
      const client = await connectWithToken(base(), pat);
      try {
        const result = await client.callTool({ name: 'fake__echo', arguments: { text: 'pat' } });
        expect(textOf(result)).toBe('pat');
      } finally {
        await client.close();
      }
    });

    it('9.1 SCIM provisioning creates a user', async () => {
      const created = await api(admin, 'POST', '/scim-tokens', { name: 'e2e-scim' });
      expect(created.status).toBe(201);
      const token = String((created.body as Item).token);
      const res = await stack.fetch(`${PUBLIC_ORIGIN}/scim/v2/Users`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
        body: JSON.stringify({
          schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
          userName: 'scim.user@acme.example',
          displayName: 'Scim User',
          active: true,
        }),
      });
      expect(res.status).toBe(201);
      const user = await stack.server.infra.repos.users.findByEmail('scim.user@acme.example');
      expect(user?.status).toBe('active');
    });

    it("9.1 a deactivated user's token is rejected within the cache window", async () => {
      const ok = await connectWithToken(base(), bobToken);
      await ok.close();
      const res = await api(admin, 'POST', `/users/${bobId}/deactivate`);
      expect(res.status).toBe(200);
      await eventually(
        async () => {
          const response = await stack.fetch(`${PUBLIC_ORIGIN}/mcp`, {
            method: 'POST',
            headers: {
              authorization: `Bearer ${bobToken}`,
              'content-type': 'application/json',
              accept: 'application/json, text/event-stream',
            },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
          });
          return response.status === 401 || response.status === 403 ? true : undefined;
        },
        { timeoutMs: 70_000, intervalMs: 500 },
      );
    });
  },
);
