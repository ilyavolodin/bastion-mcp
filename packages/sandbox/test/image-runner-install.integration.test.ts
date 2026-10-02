import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildBwrapArgs, generateSeccompBpf, hostSeccompArch, sandboxDirs } from '../src';

/**
 * The runner inside the REAL Bastion image, in a real bubblewrap jail, installing a real npm package through an
 * egress proxy on the per-jail Unix socket (8.3, 8.5, 8.7, 8.8). This is the regression test for "Testing the server
 * resulted in could not list the server (sandbox_start_failed)": the image shipped no `npm` on the sandbox PATH, and
 * the lockfile was never captured.
 *
 * Needs Docker and an image built from `deploy/docker/Dockerfile`:
 *   docker build -f deploy/docker/Dockerfile -t bastion-local:dev .
 *   BASTION_TEST_IMAGE=bastion-local:dev pnpm --filter @bastion-mcp/sandbox test image-runner-install
 * Skipped without Docker or without `BASTION_TEST_IMAGE`. Resolving the package needs registry.npmjs.org: the test is
 * a `network` test and skips itself when the registry cannot be reached.
 */

const IMAGE = process.env.BASTION_TEST_IMAGE ?? '';
const PROFILE = path.resolve(__dirname, '../../../deploy/docker/sandbox-seccomp.json');

const dockerAvailable = (): boolean => {
  if (process.env.BASTION_SKIP_DOCKER === '1' || IMAGE === '') return false;
  const r = spawnSync('docker', ['image', 'inspect', IMAGE, '--format', '{{.Id}}'], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  return r.status === 0;
};

const registryReachable = async (): Promise<boolean> =>
  fetch('https://registry.npmjs.org/is-odd', { signal: AbortSignal.timeout(10_000) })
    .then((r) => r.ok)
    .catch(() => false);

const ready = dockerAvailable() && (await registryReachable());

const ID = 'inst-0123456789';

/** Node script run in the container, outside the jail: the egress proxy, then the driver of the runner API. */
const DRIVER = `
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const RUN = '/var/lib/bastion/sandboxes/${ID}/run';

// Egress proxy on the per-jail socket: CONNECT tunnels only, a stand-in for the worker's EgressProxy.
const proxy = http.createServer((req, res) => { res.writeHead(405).end(); });
proxy.on('connect', (req, client, head) => {
  const [host, port] = req.url.split(':');
  const upstream = net.connect(Number(port), host, () => {
    client.write('HTTP/1.1 200 Connection Established\\r\\n\\r\\n');
    if (head.length) upstream.write(head);
    upstream.pipe(client); client.pipe(upstream);
  });
  upstream.on('error', () => client.destroy());
  client.on('error', () => upstream.destroy());
});
proxy.listen(RUN + '/egress.sock');

const call = (method, p, body) => new Promise((resolve, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = http.request({ socketPath: RUN + '/runner.sock', method, path: p, headers: {
    ...(token ? { authorization: 'Bearer ' + token } : {}),
    ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
  } }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
  req.on('error', reject); req.end(payload);
});
let token = '';
const events = (text) => text.split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const out = (name, value) => console.log('RESULT|' + name + '|' + JSON.stringify(value));

(async () => {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await call('GET', '/healthz')).status === 200) break; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  token = crypto.randomBytes(32).toString('hex');
  out('bind', (await call('POST', '/v1/bind', { token })).status);
  const base = { runtime: 'npm', identifier: '@modelcontextprotocol/server-memory', version: '2025.9.25',
    egress: { proxyUrl: 'http://127.0.0.1:3128' } };
  // 1. one-off lockfile capture (8.7)
  const cap = events((await call('POST', '/v1/start', { ...base, captureLockfile: true })).body);
  out('capture', cap.map((e) => e.phase));
  const ready = cap.find((e) => e.phase === 'ready');
  const failed = cap.find((e) => e.phase === 'failed');
  if (failed) out('capture-failed', failed.detail);
  if (!ready || !ready.lockfile) { process.exit(0); }
  const lockfile = { kind: ready.lockfile.kind, content: ready.lockfile.content,
    sha256: crypto.createHash('sha256').update(ready.lockfile.content).digest('hex') };
  out('lockfile', { kind: lockfile.kind, packages: Object.keys(JSON.parse(lockfile.content).packages).length });
  // 2. install from that lockfile (npm ci) and start the server
  const start = events((await call('POST', '/v1/start', { ...base, lockfile })).body);
  out('start', start.map((e) => e.phase));
  const bad = start.find((e) => e.phase === 'failed');
  if (bad) out('start-failed', bad.detail);
  await call('POST', '/v1/stop', {});
  process.exit(0);
})().catch((e) => { out('error', String(e)); process.exit(0); });
`;

describe.skipIf(!ready)(
  '8.3/8.5/8.7 runner in the real image: lockfile capture and npm ci in a jail',
  () => {
    const results = new Map<string, unknown>();
    let output = '';

    beforeAll(() => {
      const work = mkdtempSync(path.join(tmpdir(), 'bastion-image-'));
      const arch = hostSeccompArch();
      const profile = JSON.parse(readFileSync(PROFILE, 'utf8')) as unknown;
      writeFileSync(path.join(work, 'seccomp.bpf'), generateSeccompBpf(profile, arch));
      const dirs = sandboxDirs('/var/lib/bastion', ID);
      const argv = buildBwrapArgs({ dirs, bindRunnerDir: true, lib64: arch === 'x86_64' });
      mkdirSync(path.join(work, 'x'));
      writeFileSync(path.join(work, 'driver.js'), DRIVER);
      writeFileSync(
        path.join(work, 'run.sh'),
        `set -u
mkdir -p ${dirs.workspace} ${dirs.home} ${dirs.mcp} ${dirs.run}
node /work/driver.js >/tmp/driver.log 2>&1 &
DP=$!
sleep 1
bwrap ${argv.join(' ')} 3< /work/seccomp.bpf >/tmp/runner.log 2>&1 &
wait $DP
echo "--- runner log"; head -c 2000 /tmp/runner.log
echo "--- driver log"; cat /tmp/driver.log
`,
      );
      const r = spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--security-opt',
          'seccomp=unconfined',
          '--security-opt',
          'apparmor=unconfined',
          '--security-opt',
          'systempaths=unconfined',
          '-v',
          `${work}:/work:ro`,
          '--entrypoint',
          'sh',
          IMAGE,
          '/work/run.sh',
        ],
        { encoding: 'utf8', timeout: 280_000 },
      );
      output = `${r.stdout}\n${r.stderr}`;
      for (const line of output.split('\n')) {
        const m = /^RESULT\|([^|]+)\|(.*)$/.exec(line.trim());
        if (m) results.set(m[1] as string, JSON.parse(m[2] as string));
      }
    }, 300_000);

    it('8.5 the runner binds inside the jail', () => {
      expect(results.get('bind'), output).toBe(204);
    });

    it('8.7 captures an npm shrinkwrap with the pinned dependency tree (npm is on the sandbox PATH)', () => {
      expect(results.get('capture-failed'), output).toBeUndefined();
      expect(results.get('capture'), output).toEqual(['installing', 'installing', 'ready']);
      const lock = results.get('lockfile') as { kind: string; packages: number };
      expect(lock.kind).toBe('npm-shrinkwrap');
      expect(lock.packages).toBeGreaterThan(5);
    });

    it('8.3/8.7 installs from the lockfile with npm ci through the egress socket and spawns the server', () => {
      expect(results.get('start-failed'), output).toBeUndefined();
      expect(results.get('start'), output).toEqual([
        'installing',
        'installing',
        'starting',
        'ready',
      ]);
    });
  },
);
