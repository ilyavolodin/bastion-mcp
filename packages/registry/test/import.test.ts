import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createNpmVersionResolver,
  createPypiVersionResolver,
  createVersionResolver,
  importFromClientConfig,
  importFromServerJson,
  RegistryMappingError,
  RegistryUnavailableError,
  type VersionResolver,
} from '../src';
import * as fx from './fixtures/server-json';

const resolver = (versions: Record<string, string> = {}): VersionResolver & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    latest: async (runtime, id) => {
      calls.push(`${runtime}:${id}`);
      const v = versions[id];
      if (!v) throw new RegistryMappingError(`unknown ${id}`);
      return v;
    },
  };
};

describe('11.3 importFromClientConfig', () => {
  it('11.3 npx maps to npm and resolves the exact current version', async () => {
    const r = resolver({ '@modelcontextprotocol/server-everything': '2026.1.2' });
    const out = await importFromClientConfig(
      { command: 'npx', args: ['-y', '@modelcontextprotocol/server-everything'] },
      { resolver: r },
    );
    expect(out.spec).toMatchObject({
      type: 'package',
      runtime: 'npm',
      identifier: '@modelcontextprotocol/server-everything',
      version: '2026.1.2',
    });
    expect(out.warnings.join(' ')).toMatch(/resolved to 2026\.1\.2/);
    expect(out.name).toBe('@modelcontextprotocol/server-everything');
  });

  it('11.3 uvx maps to PyPI', async () => {
    const out = await importFromClientConfig(
      { command: 'uvx', args: ['mcp-server-git'] },
      { resolver: resolver({ 'mcp-server-git': '0.6.2' }) },
    );
    expect(out.spec).toMatchObject({
      runtime: 'pypi',
      identifier: 'mcp-server-git',
      version: '0.6.2',
    });
  });

  it('8.7 an exact version in the snippet is kept without a lookup', async () => {
    const r = resolver();
    const out = await importFromClientConfig(
      { command: 'npx', args: ['-y', 'left-pad@1.3.0'] },
      { resolver: r },
    );
    expect(out.spec).toMatchObject({ identifier: 'left-pad', version: '1.3.0' });
    expect(r.calls).toEqual([]);
    const py = await importFromClientConfig(
      { command: 'uvx', args: ['pkg==2.0.1'] },
      { resolver: r },
    );
    expect(py.spec).toMatchObject({ identifier: 'pkg', version: '2.0.1' });
    const at = await importFromClientConfig({ command: 'uvx', args: ['pkg@3.1'] }, { resolver: r });
    expect(at.spec).toMatchObject({ version: '3.1' });
  });

  it('8.7 @latest is resolved, other tags and ranges are rejected', async () => {
    const r = resolver({ pkg: '1.0.0' });
    const latest = await importFromClientConfig(
      { command: 'npx', args: ['pkg@latest'] },
      { resolver: r },
    );
    expect(latest.spec).toMatchObject({ version: '1.0.0' });
    await expect(
      importFromClientConfig({ command: 'npx', args: ['pkg@^1.0.0'] }, { resolver: r }),
    ).rejects.toThrow(/exact/);
    await expect(
      importFromClientConfig({ command: 'npx', args: ['pkg@beta'] }, { resolver: r }),
    ).rejects.toThrow(/exact/);
    await expect(
      importFromClientConfig({ command: 'uvx', args: ['pkg>=1.0'] }, { resolver: r }),
    ).rejects.toThrow(/range/);
  });

  it.each([
    [{ command: 'pnpm', args: ['dlx', 'pkg'] }, /pnpm dlx is not supported/],
    [{ command: 'bunx', args: ['pkg'] }, /bunx is not supported/],
    [{ command: 'yarn', args: ['dlx', 'pkg'] }, /yarn dlx/],
    [{ command: 'docker', args: ['run', 'x'] }, /not supported/],
    [{ command: 'node', args: ['server.js'] }, /not supported/],
  ])('11.3 rejects %j with a clear message', async (snippet, message) => {
    await expect(importFromClientConfig(snippet, { resolver: resolver() })).rejects.toThrow(
      message,
    );
  });

  it('11.3 handles .cmd runners, a command line in one string and uvx --from', async () => {
    const r = resolver({ real: '1.0.0', other: '2.0.0' });
    const win = await importFromClientConfig(
      { command: 'C:\\Program Files\\nodejs\\npx.cmd', args: ['-y', 'real'] },
      { resolver: r },
    );
    expect(win.spec).toMatchObject({ identifier: 'real' });
    const line = await importFromClientConfig({ command: 'npx -y other' }, { resolver: r });
    expect(line.spec).toMatchObject({ identifier: 'other' });
    const from = await importFromClientConfig(
      { command: 'uvx', args: ['--from', 'real', 'run-real', '--flag'] },
      { resolver: r },
    );
    expect(from.spec).toMatchObject({
      identifier: 'real',
      packageArguments: [{ type: 'positional', value: '--flag' }],
    });
    const eqFrom = await importFromClientConfig(
      { command: 'uvx', args: ['--from=real', 'cmd'] },
      { resolver: r },
    );
    expect(eqFrom.spec).toMatchObject({ identifier: 'real' });
    const npmP = await importFromClientConfig(
      { command: 'npx', args: ['-p', 'real', 'cmd'] },
      { resolver: r },
    );
    expect(npmP.spec).toMatchObject({ identifier: 'real' });
  });

  it('11.3 keeps extra arguments and never keeps secret env values', async () => {
    const r = resolver({ pkg: '1.0.0' });
    const out = await importFromClientConfig(
      {
        command: 'npx',
        args: ['-y', 'pkg', '--port=8080', 'serve'],
        env: { API_KEY: 'sk-live-123', REGION: 'eu' },
      },
      { resolver: r },
    );
    if (out.spec.type !== 'package') throw new Error('expected package');
    expect(out.spec.packageArguments).toMatchObject([
      { type: 'named', name: '--port', value: '8080' },
      { type: 'positional', value: 'serve' },
    ]);
    expect(out.spec.environmentVariables).toEqual([{ name: 'REGION', value: 'eu' }]);
    expect(out.spec.auth).toMatchObject({
      mode: 'userSecret',
      inject: [{ to: 'env', name: 'API_KEY', value: '{{secret.API_KEY}}' }],
    });
    expect(JSON.stringify(out)).not.toContain('sk-live-123');
  });

  it('11.3 accepts a JSON string and an mcpServers wrapper and uses the entry name', async () => {
    const r = resolver({ pkg: '1.0.0' });
    const out = await importFromClientConfig(
      JSON.stringify({ mcpServers: { notes: { command: 'npx', args: ['pkg'] } } }),
      { resolver: r },
    );
    expect(out.name).toBe('notes');
    const bare = await importFromClientConfig(
      { notes2: { command: 'npx', args: ['pkg'] } },
      { resolver: r },
    );
    expect(bare.name).toBe('notes2');
  });

  it('11.3 rejects several servers, bad JSON and bad shapes', async () => {
    const r = resolver({ pkg: '1.0.0' });
    await expect(
      importFromClientConfig(
        {
          mcpServers: {
            a: { command: 'npx', args: ['pkg'] },
            b: { command: 'npx', args: ['pkg'] },
          },
        },
        { resolver: r },
      ),
    ).rejects.toThrow(/several/);
    await expect(importFromClientConfig('{nope', { resolver: r })).rejects.toThrow(/valid JSON/);
    await expect(importFromClientConfig(42, { resolver: r })).rejects.toThrow(/object/);
    await expect(importFromClientConfig({ args: [] }, { resolver: r })).rejects.toThrow(
      RegistryMappingError,
    );
    await expect(
      importFromClientConfig({ command: 'npx', args: [1] }, { resolver: r }),
    ).rejects.toThrow(/array of strings/);
    await expect(
      importFromClientConfig({ command: 'npx', args: [] }, { resolver: r }),
    ).rejects.toThrow(/no package/);
    await expect(
      importFromClientConfig({ command: 'npx', args: ['pkg'], env: { A: 1 } }, { resolver: r }),
    ).rejects.toThrow(/string/);
    await expect(
      importFromClientConfig({ command: 'npx', args: ['pkg'], env: [] }, { resolver: r }),
    ).rejects.toThrow(/object/);
    await expect(
      importFromClientConfig(
        { command: 'npx', args: ['pkg'] },
        { resolver: resolver({ pkg: 'latest-ish' }) },
      ),
    ).rejects.toThrow(/non-exact/);
  });

  it('11.3 imports a remote snippet and turns auth headers into per-user secrets', async () => {
    const out = await importFromClientConfig(
      {
        url: 'https://mcp.example.com/mcp',
        headers: { Authorization: 'Bearer abc', 'X-Team': 'core', 'X-Api-Key': 'k' },
      },
      { resolver: resolver() },
    );
    expect(out.name).toBe('mcp.example.com');
    expect(out.spec).toMatchObject({
      type: 'remote',
      transport: 'streamable-http',
      headers: [{ name: 'X-Team', value: 'core' }],
      auth: {
        mode: 'userSecret',
        inject: [
          { to: 'header', name: 'Authorization', value: 'Bearer {{secret.Authorization}}' },
          { to: 'header', name: 'X-Api-Key', value: '{{secret.X_Api_Key}}' },
        ],
      },
    });
    expect(JSON.stringify(out)).not.toContain('Bearer abc');
    const sse = await importFromClientConfig(
      { type: 'sse', url: 'https://a.example/sse' },
      { resolver: resolver() },
    );
    expect(sse.spec).toMatchObject({ transport: 'sse', auth: { mode: 'none' } });
    await expect(importFromClientConfig({ url: 'nope' }, { resolver: resolver() })).rejects.toThrow(
      /valid URL/,
    );
    await expect(importFromClientConfig({ url: '' }, { resolver: resolver() })).rejects.toThrow(
      /string/,
    );
  });
});

describe('11.3 importFromServerJson', () => {
  it('11.3 parses text or objects and maps with the preference', () => {
    const out = importFromServerJson(JSON.stringify(fx.bothRemoteAndPackage));
    expect(out.mapping.installable && out.mapping.spec.type).toBe('remote');
    const pkg = importFromServerJson(fx.bothRemoteAndPackage, { prefer: 'package' });
    expect(pkg.mapping.installable && pkg.mapping.spec.type).toBe('package');
  });

  it('11.3 accepts a registry response wrapper { server, _meta }', () => {
    const out = importFromServerJson(fx.entryOf(fx.pypiStdio));
    expect(out.serverJson.name).toBe('io.github.acme/postgres-inspector');
  });

  it('11.3 reports invalid documents and unsupported runtimes clearly', () => {
    expect(() => importFromServerJson('{nope')).toThrow(/valid JSON/);
    expect(() => importFromServerJson({ name: 'x' })).toThrow(/server\.json is invalid/);
    expect(importFromServerJson(fx.ociOnly).mapping).toMatchObject({
      installable: false,
      reason: 'unsupported runtime',
    });
    expect(() => importFromServerJson(fx.rangeVersion)).toThrow(/exact/);
  });
});

describe('11.3 version resolvers (local fake npm and PyPI)', () => {
  const seen: string[] = [];
  let base = '';
  let close = async () => {};
  beforeAll(async () => {
    const server = createServer((req, res) => {
      seen.push(`${req.url}|${req.headers.accept}`);
      const send = (status: number, body: string) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body);
      };
      if (req.url === '/@scope%2Fpkg') return send(200, '{"dist-tags":{"latest":"4.5.6"}}');
      if (req.url === '/plain') return send(200, '{"dist-tags":{"latest":"1.0.0"}}');
      if (req.url === '/notags') return send(200, '{}');
      if (req.url === '/broken') return send(200, 'not json');
      if (req.url === '/pypi/mcp-server-git/json') return send(200, '{"info":{"version":"0.6.2"}}');
      if (req.url === '/pypi/empty/json') return send(200, '{"info":{}}');
      if (req.url === '/pypi/boom/json') return send(500, '{}');
      send(404, '{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      });
  });
  afterAll(() => close());

  it('11.3 npm resolver reads dist-tags.latest of scoped and plain packages from the configured mirror', async () => {
    const npm = createNpmVersionResolver(`${base}/`);
    await expect(npm.latest('npm', '@scope/pkg')).resolves.toBe('4.5.6');
    await expect(npm.latest('npm', 'plain')).resolves.toBe('1.0.0');
    expect(seen[0]).toContain('application/vnd.npm.install-v1+json');
  });

  it('11.3 npm resolver reports missing, tagless and broken packages', async () => {
    const npm = createNpmVersionResolver(base);
    await expect(npm.latest('npm', 'missing')).rejects.toBeInstanceOf(RegistryMappingError);
    await expect(npm.latest('npm', 'notags')).rejects.toThrow(/no latest/);
    await expect(npm.latest('npm', 'broken')).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it('11.3 PyPI resolver derives the JSON API from the simple index URL', async () => {
    const pypi = createPypiVersionResolver(`${base}/simple`);
    await expect(pypi.latest('pypi', 'MCP-Server-Git')).resolves.toBe('0.6.2');
    await expect(pypi.latest('pypi', 'empty')).rejects.toThrow(/no version/);
    await expect(pypi.latest('pypi', 'boom')).rejects.toBeInstanceOf(RegistryUnavailableError);
  });

  it('11.3 the combined resolver routes by runtime and passes timeouts and fetch', async () => {
    const combined = createVersionResolver({
      npmRegistry: base,
      pypiIndexUrl: `${base}/simple`,
      timeoutMs: 2000,
    });
    await expect(combined.latest('npm', 'plain')).resolves.toBe('1.0.0');
    await expect(combined.latest('pypi', 'mcp-server-git')).resolves.toBe('0.6.2');
    const failing = createVersionResolver({
      npmRegistry: base,
      pypiIndexUrl: base,
      fetch: async () => {
        throw new Error('net');
      },
    });
    await expect(failing.latest('npm', 'x')).rejects.toBeInstanceOf(RegistryUnavailableError);
  });
});
