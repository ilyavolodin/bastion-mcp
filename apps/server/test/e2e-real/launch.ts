/**
 * Boots the REAL Bastion server in-process (Testcontainers Postgres and Redis, the built SPA from `apps/web/dist`, a
 * `LocalProcessDriver` for packages) for the browser specs of `apps/web/e2e/real`. `serve.e2e.ts` runs it under Vitest (the workspace packages need Vite's module interop); Playwright's `webServer`
 * starts that.
 *
 * Besides the app on `E2E_PORT` (default 18080), a control server on `E2E_PORT + 1` lets specs ask what the fake
 * upstreams saw (the Authorization header of the remote server, the environment of the stdio package) and create
 * a local member signs in (`/make-user`).
 */

import { mkdtempSync } from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '@bastion-mcp/secrets';
import {
  type FakeModernServer,
  startFakeModernServer,
  startPostgres,
  startRedis,
} from '@bastion-mcp/testkit';
import pg from 'pg';
import { migrate } from '../../src/boot/migrate';
import { startServer } from '../../src/server';
import { startFakeRegistry } from '../helpers/fake-registry';
import { LocalProcessDriver } from '../helpers/local-process-driver';

const here = dirname(fileURLToPath(import.meta.url));
const WEB_DIST = join(here, '..', '..', '..', 'web', 'dist');
const PORT = Number(process.env.E2E_PORT ?? 18080);
const ADMIN_EMAIL = 'admin@e2e.test';

export const launch = async (): Promise<{ stop: () => Promise<void> }> => {
  const [pgc, redisc] = await Promise.all([startPostgres(), startRedis()]);
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  await admin.query('CREATE DATABASE e2e');
  await admin.end();
  const dbUrl = new URL(pgc.url);
  dbUrl.pathname = '/e2e';
  await migrate(dbUrl.toString());

  const dataDir = mkdtempSync(join(tmpdir(), 'bastion-e2e-'));
  const upstream: FakeModernServer = await startFakeModernServer();
  const driver = new LocalProcessDriver();
  // The preconfigured official registry is answered by a local fake: the browser spec enables the source, syncs it
  // and installs from it without leaving the machine.
  const registry = await startFakeRegistry();
  registry.setEntries(
    Array.from({ length: 60 }, (_, i) => {
      const name = i === 7 ? 'io.e2e/payments' : `io.e2e/remote-${String(i).padStart(3, '0')}`;
      return {
        server: {
          $schema: 'https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json',
          name,
          description:
            i === 7 ? 'Payments, customers and invoices' : `Remote e2e server number ${i}`,
          version: '1.0.0',
          remotes: [{ type: 'streamable-http', url: `https://e2e-${i}.example.com/mcp` }],
        },
        _meta: {
          'io.modelcontextprotocol.registry/official': {
            status: 'active',
            publishedAt: '2026-01-01T00:00:00Z',
            updatedAt: '2026-01-01T00:00:00Z',
            isLatest: true,
          },
        },
      };
    }),
  );
  const OFFICIAL = 'https://registry.modelcontextprotocol.io';
  const routedFetch: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    return fetch(
      url.startsWith(OFFICIAL) ? registry.baseUrl + url.slice(OFFICIAL.length) : input,
      init,
    );
  };
  let adminPassword = '';
  const server = await startServer(
    {
      BASTION_ROLE: 'all',
      BASTION_HTTP_PORT: String(PORT),
      BASTION_INTERNAL_PORT: String(PORT + 2),
      BASTION_EGRESS_PORT: String(PORT + 3),
      BASTION_PUBLIC_URL: `http://localhost:${PORT}`,
      BASTION_INTERNAL_SECRET: 'x'.repeat(48),
      BASTION_DATABASE_URL: dbUrl.toString(),
      BASTION_REDIS_URL: redisc.url,
      BASTION_DATA_DIR: dataDir,
      BASTION_KMS_KEY: join(dataDir, 'kek.key'),
      BASTION_LOG_LEVEL: 'warn',
      BASTION_OSV_CHECK: 'false',
      BASTION_SANDBOX_DRIVER: 'bubblewrap',
      BASTION_INSECURE_UPSTREAM_HOSTS: '127.0.0.1,localhost',
      BASTION_PRIVATE_UPSTREAM_CIDRS: '127.0.0.0/8',
      BASTION_BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
    },
    {
      listenHost: '127.0.0.1',
      advertiseHost: '127.0.0.1',
      allowInsecureHttp: true,
      fetch: routedFetch,
      scheduler: false,
      publicDir: WEB_DIST,
      sandboxDriver: driver,
      printBootstrapPassword: (_email, password) => {
        adminPassword = password;
      },
    },
  );

  const json = (res: import('node:http').ServerResponse, body: unknown, status = 200) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readJson = async (
    req: import('node:http').IncomingMessage,
  ): Promise<Record<string, unknown>> => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return chunks.length
      ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      : {};
  };
  const control = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname === '/state') {
        return json(res, {
          baseUrl: `http://localhost:${PORT}`,
          adminEmail: ADMIN_EMAIL,
          adminPassword,
          upstreamUrl: upstream.url,
        });
      }
      if (url.pathname === '/make-user' && req.method === 'POST') {
        const body = await readJson(req);
        const email = String(body.email).toLowerCase();
        const user =
          (await server.infra.repos.users.findByEmail(email)) ??
          (await server.infra.repos.users.create({
            email,
            displayName: String(body.name ?? email),
          }));
        await server.infra.repos.localAdmins.setPasswordHash({
          userId: user.id,
          passwordHash: await hashPassword(String(body.password)),
          audit: { action: 'user.password.set', actorType: 'system' },
        });
        return json(res, { id: user.id, email });
      }
      if (url.pathname === '/upstream/token' && req.method === 'POST') {
        const body = await readJson(req);
        upstream.setRequiredToken(typeof body.token === 'string' ? body.token : undefined);
        return json(res, { ok: true });
      }
      if (url.pathname === '/upstream/requests') {
        return json(
          res,
          upstream.requests.map((r) => ({
            method: r.method,
            authorization: r.headers.authorization ?? null,
            apiKey: r.headers['x-api-key'] ?? null,
            rpc: (r.body as { method?: string } | undefined)?.method ?? null,
          })),
        );
      }
      if (url.pathname === '/upstream/reset' && req.method === 'POST') {
        upstream.requests.length = 0;
        return json(res, { ok: true });
      }
      json(res, { error: 'not found' }, 404);
    })().catch((error) => json(res, { error: String(error) }, 500));
  });
  await new Promise<void>((resolve) => control.listen(PORT + 1, '127.0.0.1', resolve));
  process.stdout.write(`E2E READY http://localhost:${PORT}\n`);

  const stop = async () => {
    await server.stop().catch(() => undefined);
    await driver.runners.closeAll().catch(() => undefined);
    await upstream.close().catch(() => undefined);
    await registry.close().catch(() => undefined);
    control.close();
    await Promise.all([pgc.stop(), redisc.stop()]).catch(() => undefined);
  };
  return { stop };
};
