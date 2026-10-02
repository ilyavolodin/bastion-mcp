import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { AuthenticationError, buildPrincipal, InsufficientScopeError } from '@bastion-mcp/auth';
import { loadConfig } from '@bastion-mcp/core';
import { guardProfileSchema, ORG_DEFAULT_PROFILE } from '@bastion-mcp/guards';
import { exportZip, saveVersionFiles, textFile } from '@bastion-mcp/plugins';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGuardApiPorts } from '../src/adapters/api/guards';
import { createPluginApiPorts } from '../src/adapters/api/plugins';
import { createRegistryApiPorts } from '../src/adapters/api/registry';
import { createCatalogInstallPort } from '../src/adapters/downstream/catalog-install';
import { createSkillsProvider } from '../src/adapters/downstream/skills';
import { createGuardService } from '../src/adapters/guards';
import { createPluginImportPort } from '../src/adapters/plugin-import';
import type { AuthServices } from '../src/contracts';
import { registerPluginRoutes } from '../src/http/ui/plugins';
import { registerSubregistryRoutes } from '../src/http/ui/registry';
import { createInfra, type Infra } from '../src/infra';
import { createTestEnv, haveDocker, type TestEnv } from './helpers/env';
import { type FakeRegistry, startFakeRegistry } from './helpers/fake-registry';
import { freePort } from './helpers/worker-harness';

const SKILL_MD = `---
name: code-review
description: Reviews a pull request for correctness.
---
# Code review

Read the diff and report problems.
`;

const pluginZip = (version: string) =>
  exportZip([
    textFile(
      '.claude-plugin/plugin.json',
      JSON.stringify({
        name: 'acme-tools',
        version,
        description: 'Acme engineering tools',
        displayName: 'Acme tools',
      }),
    ),
    textFile('skills/review/SKILL.md', SKILL_MD),
    textFile(
      '.mcp.json',
      JSON.stringify({ mcpServers: { docs: { url: 'https://docs.example.com/mcp' } } }),
    ),
  ]);

/** Stand-in for F1's verifier: `pat-<userId>` has plugins:read and api:read, `ro-<userId>` only `mcp`. */
const stubAuth = (infra: Infra): AuthServices =>
  ({
    verifier: {
      async verify(authorization: string | undefined, url: string) {
        const token = /^Bearer\s+(.+)$/i.exec(authorization ?? '')?.[1] ?? '';
        const [kind, id] = [
          token.slice(0, token.indexOf('-')),
          token.slice(token.indexOf('-') + 1),
        ];
        const user = id ? await infra.repos.users.get(id) : null;
        const challenge =
          'Bearer resource_metadata="https://bastion.test/.well-known/oauth-protected-resource/api"';
        if (!user || (kind !== 'pat' && kind !== 'ro')) {
          throw new AuthenticationError('INVALID_TOKEN', 'invalid token', challenge);
        }
        const scopes = kind === 'pat' ? ['plugins:read', 'api:read'] : ['mcp'];
        const surface = new URL(url).pathname.startsWith('/plugins') ? 'plugins:read' : 'api:read';
        if (!scopes.includes(surface)) {
          throw new InsufficientScopeError('scope required', challenge, surface);
        }
        return buildPrincipal(
          { id: user.id, type: 'user', orgRole: user.orgRole, teams: [], active: true },
          { authMethod: 'pat', scopes, credentialId: 'x' },
        );
      },
    },
  }) as unknown as AuthServices;

describe.skipIf(!haveDocker())(
  '11.6, 11.8, 13, 25 registry, plugins, skills and the guard tester',
  () => {
    let env: TestEnv;
    let infra: Infra;
    let app: FastifyInstance;
    let base: string;
    let gitDir: string;
    let registry: FakeRegistry;
    let adminId: string;
    let memberId: string;
    let outsiderId: string;

    beforeAll(async () => {
      env = await createTestEnv();
      gitDir = mkdtempSync(join(tmpdir(), 'bastion-f5-'));
      registry = await startFakeRegistry();
      const port = await freePort();
      infra = createInfra(
        loadConfig(
          env.env({
            BASTION_ROLE: 'ui',
            BASTION_HTTP_PORT: String(port),
            BASTION_GIT_CACHE_DIR: join(gitDir, 'cache'),
          }),
        ),
        { allowInsecureHttp: true },
      );
      adminId = (
        await infra.repos.users.create({
          email: 'admin@acme.example',
          displayName: 'Admin',
          orgRole: 'admin',
        })
      ).id;
      memberId = (
        await infra.repos.users.create({ email: 'member@acme.example', displayName: 'Member' })
      ).id;
      outsiderId = (
        await infra.repos.users.create({ email: 'out@acme.example', displayName: 'Outsider' })
      ).id;
      app = Fastify({ logger: false, trustProxy: true, forceCloseConnections: true });
      const auth = stubAuth(infra);
      await registerSubregistryRoutes(app, { infra, auth });
      await registerPluginRoutes(app, { infra, auth });
      await app.listen({ port, host: '127.0.0.1' });
      base = `http://127.0.0.1:${port}`;
    });

    afterAll(async () => {
      await app?.close();
      await infra?.close();
      await registry?.close();
      await env?.cleanup();
      rmSync(gitDir, { recursive: true, force: true });
    });

    // --- 13 guard tester --------------------------------------------------------------------------------------------

    describe('13.1 guard tester', () => {
      it('runs the shipped org default profile on a tool output and redacts a secret', async () => {
        const guards = createGuardService(infra);
        await guards.ready();
        const ports = createGuardApiPorts(infra, guards);
        const out = await ports.tester.test({
          profile: ORG_DEFAULT_PROFILE,
          text: 'the key is AKIAIOSFODNN7EXAMPLE, keep it safe',
          phase: 'tool_output',
        });
        expect(out.blocked).toBe(false);
        expect(out.findings.some((f) => f.type === 'regex' && f.action === 'redact')).toBe(true);
        expect(out.durationMs).toBeGreaterThanOrEqual(0);
      });

      it('reports a block when the profile says so', async () => {
        const guards = createGuardService(infra);
        const ports = createGuardApiPorts(infra, guards);
        const profile = guardProfileSchema.parse({
          profileId: 'strict',
          guards: [
            {
              instanceId: 'strict:secrets',
              type: 'regex',
              config: { presets: { secrets: { actions: { request: 'block' } } } },
            },
          ],
        });
        const blocked = await ports.tester.test({
          profile,
          text: 'AKIAIOSFODNN7EXAMPLE',
          phase: 'tool_input',
        });
        expect(blocked.blocked).toBe(true);
        const clean = await ports.tester.test({
          profile,
          text: 'hello world',
          phase: 'tool_input',
        });
        expect(clean.blocked).toBe(false);
        expect(clean.findings).toEqual([]);
      });
    });

    // --- 11.6 registry sync ------------------------------------------------------------------------------------------

    describe('11.6 registry sources and sync', () => {
      const entry = (name: string, description: string, status = 'active') => ({
        server: {
          name,
          description,
          version: '1.0.0',
          remotes: [
            { type: 'streamable-http', url: `https://${name.split('/')[1]}.example.com/mcp` },
          ],
        },
        status,
        isLatest: true,
      });

      it('syncs a source page by page into registry_servers, searchable by text', async () => {
        registry.setEntries([
          entry('com.acme/jira', 'Search and update Jira issues'),
          entry('com.acme/slack', 'Post messages to Slack'),
          entry('com.acme/old', 'A retired server', 'deprecated'),
        ]);
        const ports = createRegistryApiPorts(infra);
        await ports.sources.save({
          id: '0198a000-0000-7000-8000-000000000001',
          name: 'Fake registry',
          baseUrl: registry.baseUrl,
          trust: 'internal',
          enabled: true,
          syncIntervalS: 3600,
          lastUpdatedSince: null,
          lastSync: null,
        });
        const source = await ports.sources.get('0198a000-0000-7000-8000-000000000001');
        expect(source).not.toBeNull();
        const result = await ports.sync(source as NonNullable<typeof source>, { full: true });
        expect(result.ok).toBe(true);
        expect(result.stats.upserted).toBe(3);
        expect(result.stats.deprecated).toBe(1);

        const rows = await ports.servers.list('0198a000-0000-7000-8000-000000000001');
        expect(rows.map((r) => r.name).sort()).toEqual([
          'com.acme/jira',
          'com.acme/old',
          'com.acme/slack',
        ]);
        const found = await ports.servers.search({ q: 'jira', limit: 10 });
        expect(found.items.map((r) => r.name)).toEqual(['com.acme/jira']);

        const stored = await ports.sources.get('0198a000-0000-7000-8000-000000000001');
        expect(stored?.lastSync?.ok).toBe(true);
        expect(stored?.lastUpdatedSince).toBeInstanceOf(Date);
      });

      it('records a failed sync without losing the mirrored data', async () => {
        const ports = createRegistryApiPorts(infra);
        const source = await ports.sources.get('0198a000-0000-7000-8000-000000000001');
        await ports.sources.save({
          ...(source as NonNullable<typeof source>),
          baseUrl: 'http://127.0.0.1:9',
        });
        const broken = await ports.sources.get('0198a000-0000-7000-8000-000000000001');
        const result = await ports.sync(broken as NonNullable<typeof broken>, { full: true });
        expect(result.ok).toBe(false);
        expect(result.error).toBeTruthy();
        expect((await ports.servers.list('0198a000-0000-7000-8000-000000000001')).length).toBe(3);
      });
    });

    // --- 11.8 subregistry ------------------------------------------------------------------------------------------

    describe('11.8 Bastion as a subregistry', () => {
      it('lists the default endpoint and the caller installations in the MCP Registry shape', async () => {
        const entryRow = await infra.repos.catalogEntries.create({
          slug: 'github',
          displayName: 'GitHub',
          description: 'GitHub tools',
          createdBy: adminId,
          visibility: { org: true },
        });
        const version = await infra.repos.catalogVersions.create({
          entryId: entryRow.id,
          label: '1',
          serverSpec: {
            type: 'remote',
            transport: 'streamable-http',
            url: 'https://gh.example.com/mcp',
            auth: { mode: 'none' },
          },
          installForm: {},
          createdBy: adminId,
        });
        await infra.repos.catalogVersions.publish(version.id);
        await infra.repos.installations.create({
          ownerType: 'user',
          ownerId: memberId,
          catalogEntryId: entryRow.id,
          catalogVersionId: version.id,
          slug: 'github',
          displayName: 'GitHub',
        });

        const unauth = await fetch(`${base}/registry/v0.1/servers`);
        expect(unauth.status).toBe(401);
        expect(unauth.headers.get('www-authenticate')).toMatch(/^Bearer/);
        const noScope = await fetch(`${base}/registry/v0.1/servers`, {
          headers: { authorization: `Bearer ro-${memberId}` },
        });
        expect(noScope.status).toBe(403);

        const res = await fetch(`${base}/registry/v0.1/servers`, {
          headers: { authorization: `Bearer pat-${memberId}` },
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          servers: { server: { name: string; remotes: { type: string; url: string }[] } }[];
        };
        const names = body.servers.map((s) => s.server.name);
        expect(names).toEqual(['test.bastion/_default', 'test.bastion/github']);
        expect(body.servers[1]?.server.remotes[0]).toEqual({
          type: 'streamable-http',
          url: 'https://bastion.test/mcp/i/github',
        });

        const outsider = await fetch(`${base}/registry/v0.1/servers`, {
          headers: { authorization: `Bearer pat-${outsiderId}` },
        });
        const outsiderNames = (
          (await outsider.json()) as { servers: { server: { name: string } }[] }
        ).servers.map((s) => s.server.name);
        expect(outsiderNames).toEqual(['test.bastion/_default']);

        const versions = await fetch(
          `${base}/registry/v0.1/servers/${encodeURIComponent('test.bastion/github')}/versions/latest`,
          { headers: { authorization: `Bearer pat-${memberId}` } },
        );
        expect(versions.status).toBe(200);
        const missing = await fetch(
          `${base}/registry/v0.1/servers/${encodeURIComponent('test.bastion/nope')}/versions`,
          { headers: { authorization: `Bearer pat-${memberId}` } },
        );
        expect(missing.status).toBe(404);
      });
    });

    // --- 25 plugins -------------------------------------------------------------------------------------------------

    describe('25 plugin import, releases, channels and skills over MCP', () => {
      let marketplaceId: string;
      let entryId: string;

      it('25.3 imports a plugin zip as a draft with its authored manifest and skills', async () => {
        const draft = await createPluginImportPort(infra).fromZip(pluginZip('1.2.0'));
        expect(draft.kind).toBe('plugin');
        expect(draft.name).toBe('Acme tools');
        const paths = (draft.files ?? []).map((f) => f.path).sort();
        expect(paths).toEqual(['bastion-plugin.json', 'skills/review/SKILL.md']);
        expect(draft.warnings).toEqual([]);

        const entry = await infra.repos.catalogEntries.create({
          slug: 'acme-tools',
          kind: 'plugin',
          displayName: draft.name,
          description: draft.description ?? '',
          createdBy: adminId,
          visibility: { org: true },
        });
        entryId = entry.id;
        const version = await infra.repos.catalogVersions.create({
          entryId: entry.id,
          label: '1.2.0',
          serverSpec: {},
          installForm: { variables: [], secrets: [] },
          createdBy: adminId,
        });
        await saveVersionFiles(
          { blobs: infra.repos.blobs, files: infra.repos.catalogFiles },
          version.id,
          (draft.files ?? []).map((f) => ({
            path: f.path,
            content: new Uint8Array(Buffer.from(f.contentBase64, 'base64')),
            mode: 'file' as const,
          })),
        );
        await infra.repos.catalogVersions.publish(version.id);
      });

      it('25.3 rejects an archive that holds neither a skill nor a plugin', async () => {
        await expect(
          createPluginImportPort(infra).fromZip(exportZip([textFile('notes.txt', 'hello')])),
        ).rejects.toThrow(/neither a SKILL.md nor a plugin manifest/);
      });

      it('25.4 publishes and promotes a release of a marketplace', async () => {
        const marketplace = await infra.repos.marketplaces.create({
          slug: 'engineering',
          displayName: 'Engineering',
          audience: { org: false, teamIds: [], userIds: [memberId] },
          createdBy: adminId,
        });
        marketplaceId = marketplace.id;
        await infra.repos.marketplaces.replaceItems(marketplaceId, [
          { catalogEntryId: entryId, policy: 'available' },
        ]);
        const ports = createPluginApiPorts(infra);
        const first = await ports.releaseService.publish(marketplaceId, adminId);
        expect(first.created).toBe(true);
        expect(first.record.seq).toBe(1);
        const again = await ports.releaseService.publish(marketplaceId, adminId);
        expect(again.created).toBe(false);
        const promoted = await ports.releaseService.promote(marketplaceId, 1);
        expect(promoted.seq).toBe(1);
        expect((await ports.marketplaces.getBySlug('engineering'))?.promotedRelease).toBe(1);
      });

      it('25.5 serves the manifest and the archive over HTTPS to an audience member only', async () => {
        const auth = (token: string) => ({
          authorization: `Basic ${Buffer.from(`x:${token}`).toString('base64')}`,
        });
        const anon = await fetch(`${base}/plugins/engineering/marketplace.json`);
        expect(anon.status).toBe(401);
        expect(anon.headers.get('www-authenticate')).toMatch(/^Basic realm=/);
        const noScope = await fetch(`${base}/plugins/engineering/marketplace.json`, {
          headers: auth(`ro-${memberId}`),
        });
        expect(noScope.status).toBe(403);
        const hidden = await fetch(`${base}/plugins/engineering/marketplace.json`, {
          headers: auth(`pat-${outsiderId}`),
        });
        expect(hidden.status).toBe(404);

        const manifest = await fetch(`${base}/plugins/engineering/marketplace.json`, {
          headers: auth(`pat-${memberId}`),
        });
        expect(manifest.status).toBe(200);
        const json = (await manifest.json()) as { plugins: { name: string }[] };
        expect(json.plugins.map((p) => p.name)).toEqual(['acme-tools']);

        const archive = await fetch(`${base}/plugins/engineering/archives/acme-tools-1.2.0.zip`, {
          headers: auth(`pat-${memberId}`),
        });
        expect(archive.status).toBe(200);
        expect(archive.headers.get('content-type')).toBe('application/zip');
        expect((await archive.arrayBuffer()).byteLength).toBeGreaterThan(100);
      });

      it('25.5 serves the release as a git repository that `git clone` can fetch', async () => {
        const target = join(gitDir, 'clone');
        const url = `http://x:pat-${memberId}@${base.slice('http://'.length)}/plugins/engineering.git`;
        // Async: the server under test runs in this process, so a blocking spawn would deadlock it.
        await promisify(execFile)('git', ['clone', '--quiet', url, target], {
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
          timeout: 60_000,
        });
        const skill = readFileSync(
          join(target, 'plugins', 'acme-tools', 'skills', 'review', 'SKILL.md'),
          'utf8',
        );
        expect(skill).toContain('Reviews a pull request');
        const claude = JSON.parse(
          readFileSync(
            join(target, 'plugins', 'acme-tools', '.claude-plugin', 'plugin.json'),
            'utf8',
          ),
        ) as { name: string; version: string };
        expect(claude).toMatchObject({ name: 'acme-tools', version: '1.2.0' });
        const mcp = JSON.parse(
          readFileSync(join(target, 'plugins', 'acme-tools', '.mcp.json'), 'utf8'),
        ) as {
          mcpServers: Record<string, unknown>;
        };
        expect(Object.keys(mcp.mcpServers)).toEqual(['docs']);
      });

      it('25.9 distribution events feed the usage report', async () => {
        const ports = createPluginApiPorts(infra);
        const usage = await ports.usage(marketplaceId, {});
        const actions = new Set(usage.buckets.map((b) => `${b.channel}:${b.action}`));
        expect(actions.has('https:manifest_fetch')).toBe(true);
        expect(actions.has('git:git_fetch')).toBe(true);
        expect(actions.has('https:archive_download')).toBe(true);
      });

      it('25.8 skills over MCP: the caller sees the skills of the marketplaces they can see', async () => {
        const skills = createSkillsProvider(infra);
        const principalOf = async (id: string) => {
          const user = await infra.repos.users.get(id);
          return buildPrincipal(
            { id, type: 'user', orgRole: user?.orgRole ?? 'member', teams: [], active: true },
            { authMethod: 'oauth', scopes: ['mcp'] },
          );
        };
        const member = await principalOf(memberId);
        const listed = (await skills.list(member)) as { skills: { name: string; uri: string }[] };
        expect(listed.skills.map((s) => s.name)).toEqual(['code-review']);
        expect(listed.skills[0]?.uri).toBe('skill://acme-tools/review/SKILL.md');
        const got = (await skills.get(member, { uri: 'skill://acme-tools/review/SKILL.md' })) as {
          files: { text?: string }[];
        };
        expect(got.files[0]?.text).toContain('Code review');
        const read = (await skills.readResource(member, 'skill://acme-tools/review')) as {
          contents: { uri: string }[];
        };
        expect(read.contents.map((c) => c.uri)).toContain('skill://acme-tools/review/SKILL.md');

        const outsider = await principalOf(outsiderId);
        expect(((await skills.list(outsider)) as { skills: unknown[] }).skills).toEqual([]);
        expect(
          await skills.get(outsider, { uri: 'skill://acme-tools/review/SKILL.md' }),
        ).toBeUndefined();
      });

      it('25.2 a plugin source syncs a git repository into draft entries and then draft versions', async () => {
        const repo = join(gitDir, 'source-repo');
        mkdirSync(join(repo, 'skills', 'lint'), { recursive: true });
        writeFileSync(
          join(repo, 'skills', 'lint', 'SKILL.md'),
          `---\nname: lint-helper\ndescription: Runs the linter.\n---\nRun it.\n`,
        );
        writeFileSync(
          join(repo, 'SKILL.md'),
          `---\nname: lint-helper\ndescription: Runs the linter.\n---\nRun it.\n`,
        );
        const git = (...args: string[]) =>
          execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
            cwd: repo,
            stdio: 'pipe',
          });
        git('init', '-q', '-b', 'main');
        git('add', '.');
        git('commit', '-q', '-m', 'one');

        const source = await infra.repos.pluginSources.create({
          name: 'local',
          gitUrl: repo,
          ref: 'main',
        });
        const ports = createPluginApiPorts(infra);
        const first = await ports.syncSource(source.id);
        expect(first.errors).toEqual([]);
        expect(first.imported).toBe(1);

        const none = await ports.syncSource(source.id);
        expect(none).toEqual({ imported: 0, updated: 0, errors: [] });

        writeFileSync(
          join(repo, 'SKILL.md'),
          `---\nname: lint-helper\ndescription: Runs the linter fast.\n---\nRun it.\n`,
        );
        git('commit', '-qam', 'two');
        const changed = await ports.syncSource(source.id);
        expect(changed).toEqual({ imported: 0, updated: 1, errors: [] });

        const entries = await infra.db.prisma.catalogEntry.findMany({
          where: { source: { path: ['kind'], equals: 'plugin_source' } },
        });
        expect(entries).toHaveLength(1);
        const versions = await infra.repos.catalogVersions.list(entries[0]?.id as string);
        expect(versions).toHaveLength(2);
        expect(versions.every((v) => v.status === 'draft')).toBe(true);
      });
    });

    // --- 7.1 / 25.8 catalog route ------------------------------------------------------------------------------------

    describe('7.1 /mcp/c/{catalogSlug}: ensure the caller has an installation', () => {
      const publish = async (slug: string, form: Record<string, unknown>, visible: boolean) => {
        const entry = await infra.repos.catalogEntries.create({
          slug,
          displayName: slug,
          description: slug,
          createdBy: adminId,
          visibility: visible ? { org: true } : {},
        });
        const version = await infra.repos.catalogVersions.create({
          entryId: entry.id,
          label: '1',
          serverSpec: {
            type: 'remote',
            transport: 'streamable-http',
            url: `https://${slug}.example.com/mcp`,
            auth: { mode: 'none' },
          },
          installForm: form,
          createdBy: adminId,
        });
        await infra.repos.catalogVersions.publish(version.id);
        return entry;
      };
      const principal = (id: string) =>
        buildPrincipal(
          { id, type: 'user', orgRole: 'member', teams: [], active: true },
          { authMethod: 'oauth', scopes: ['mcp'] },
        );

      it('creates a plugin-origin installation once, then reuses it', async () => {
        await publish('ready-server', { variables: [], secrets: [] }, true);
        const port = createCatalogInstallPort(infra);
        expect(await port.ensure(principal(outsiderId), 'ready-server')).toEqual({
          status: 'ok',
          created: true,
        });
        expect(await port.ensure(principal(outsiderId), 'ready-server')).toEqual({
          status: 'ok',
          created: false,
        });
        const row = await infra.db.prisma.installation.findFirst({
          where: { ownerId: outsiderId, catalogEntry: { slug: 'ready-server' } },
        });
        expect(row?.origin).toBe('plugin');
        expect(row?.status).toBe('ready');
      });

      it('starts in needs_setup when the entry needs input', async () => {
        await publish(
          'needs-key',
          { variables: [{ name: 'tenant', label: 'Tenant', required: true }], secrets: [] },
          true,
        );
        const port = createCatalogInstallPort(infra);
        expect(await port.ensure(principal(outsiderId), 'needs-key')).toEqual({
          status: 'ok',
          created: true,
        });
        const row = await infra.db.prisma.installation.findFirst({
          where: { ownerId: outsiderId, catalogEntry: { slug: 'needs-key' } },
        });
        expect(row?.status).toBe('needs_setup');
      });

      it('answers not_found for an unknown slug and for an entry the caller cannot see', async () => {
        await publish('private-server', { variables: [], secrets: [] }, false);
        const port = createCatalogInstallPort(infra);
        expect(await port.ensure(principal(outsiderId), 'nope')).toEqual({ status: 'not_found' });
        expect(await port.ensure(principal(outsiderId), 'private-server')).toEqual({
          status: 'not_found',
        });
      });
    });
  },
);
