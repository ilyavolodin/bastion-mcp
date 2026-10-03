import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  HttpRunnerClient,
  parseRunnerAddress,
  type SandboxDriver,
  type SandboxHandle,
  type SandboxRef,
  type SandboxSpec,
} from '@bastion-mcp/sandbox';
import { fakeStdioServerPath } from '@bastion-mcp/testkit';
import { createRunner, type Installer, type Runner } from 'bastion-runner';
import { TEST_SANDBOX_DRIVER } from './constants';

type Entry = { id: string; runner: Runner; address: string; token: string; dir: string };

/** The runners of every `LocalProcessDriver` of a test: workers share it, as workers share Kubernetes pods (21.2). */
export class LocalRunnerPool {
  readonly entries = new Map<string, Entry>();
  /** Start requests the real runner received, for assertions about what the worker asked for. */
  readonly installs: Array<{ identifier: string; version: string; proxyUrl: string }> = [];

  async closeAll(): Promise<void> {
    for (const entry of [...this.entries.values()]) {
      await entry.runner.close().catch(() => undefined);
      rmSync(entry.dir, { recursive: true, force: true });
    }
    this.entries.clear();
  }
}

/**
 * TEST ONLY: a sandbox driver whose sandboxes are real `apps/runner` instances (`createRunner`: the real HTTP API,
 * bearer binding, NDJSON start events, WebSocket stdio framing and the real `ServerProcess` child process) listening on
 * loopback TCP instead of inside a bubblewrap jail, which does not exist on Windows. Only the package installer is
 * replaced: it resolves to `node <testkit stdio fake server>` instead of running `npm install`. The sandbox lifecycle
 * (claim, bind, start, call, idle stop, crash restart, re-attach by another worker) therefore runs through the real
 * runner and the real `SandboxConnector`.
 */
export class LocalProcessDriver implements SandboxDriver {
  readonly name = TEST_SANDBOX_DRIVER;
  readonly isolation = 'namespaces' as const;
  createCount = 0;
  attachCount = 0;
  readonly destroyed: string[] = [];
  readonly suspended: string[] = [];

  constructor(private readonly pool: LocalRunnerPool = new LocalRunnerPool()) {}

  /** A second worker's driver shares the same runners. */
  sibling(): LocalProcessDriver {
    return new LocalProcessDriver(this.pool);
  }

  get runners(): LocalRunnerPool {
    return this.pool;
  }

  async create(spec: SandboxSpec): Promise<SandboxHandle> {
    this.createCount += 1;
    const dir = mkdtempSync(join(tmpdir(), 'bastion-runner-'));
    const installer: Installer = {
      install: async (req) => {
        this.pool.installs.push({
          identifier: req.identifier,
          version: req.version,
          proxyUrl: req.egress.proxyUrl,
        });
        return { command: process.execPath, args: [fakeStdioServerPath, ...req.args] };
      },
      // The throwaway-sandbox capture of the catalog test (8.7): a one-package npm lockfile for the requested version.
      capture: async (req) => ({
        kind: 'npm-shrinkwrap',
        content: JSON.stringify({
          name: 'bastion-capture',
          lockfileVersion: 3,
          packages: {
            '': { name: 'bastion-capture', dependencies: { [req.identifier]: req.version } },
            [`node_modules/${req.identifier}`]: {
              version: req.version,
              resolved: `https://registry.npmjs.org/${req.identifier}/-/${req.identifier}-${req.version}.tgz`,
              integrity: `sha512-${'A'.repeat(86)}==`,
            },
          },
        }),
      }),
    };
    const runner = createRunner({ installer, workspaceDir: dir, home: dir, killGraceMs: 500 });
    const { address } = await runner.listen({ kind: 'tcp', host: '127.0.0.1', port: 0 });
    const token = randomBytes(24).toString('hex');
    const client = new HttpRunnerClient(parseRunnerAddress(address));
    await client.bind(token);
    this.pool.entries.set(spec.instanceId, { id: spec.instanceId, runner, address, token, dir });
    return {
      ref: { driver: TEST_SANDBOX_DRIVER, id: spec.instanceId, address, runnerToken: token },
      runner: client,
    };
  }

  async attach(ref: SandboxRef): Promise<SandboxHandle> {
    this.attachCount += 1;
    const entry = this.pool.entries.get(ref.id);
    if (!entry) throw new Error('no such sandbox');
    const client = new HttpRunnerClient(parseRunnerAddress(entry.address));
    client.useToken(ref.runnerToken);
    return { ref, runner: client };
  }

  async suspend(ref: SandboxRef): Promise<void> {
    this.suspended.push(ref.id);
    await this.pool.entries.get(ref.id)?.runner.close();
    this.pool.entries.delete(ref.id);
  }

  async destroy(ref: SandboxRef): Promise<void> {
    this.destroyed.push(ref.id);
    const entry = this.pool.entries.get(ref.id);
    if (!entry) return;
    await entry.runner.close().catch(() => undefined);
    rmSync(entry.dir, { recursive: true, force: true });
    this.pool.entries.delete(ref.id);
  }

  async *list(): AsyncIterable<SandboxRef> {
    for (const entry of this.pool.entries.values()) {
      yield { driver: TEST_SANDBOX_DRIVER, id: entry.id, address: entry.address, runnerToken: '' };
    }
  }
}
