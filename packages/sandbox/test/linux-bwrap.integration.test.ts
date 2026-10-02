import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  buildBwrapArgs,
  generateSeccompBpf,
  hostSeccompArch,
  sandboxDirs,
  syscallNumber,
} from '../src';

/**
 * Linux bubblewrap integration and sandbox-escape smoke tests (tdd 22.1, 23.3).
 *
 * Runs ONE `node:24-bookworm-slim` container (apt installs bubblewrap), builds the jail with the exact argv from
 * `buildBwrapArgs` plus the seccomp BPF generated from deploy/docker/sandbox-seccomp.json, and runs probes
 * inside the jail. Needs Docker; the container runs with seccomp, AppArmor and systempaths unconfined because
 * bwrap needs unprivileged user namespaces and a fresh /proc (8.5). Skipped when Docker is unavailable.
 * CI: runs on Linux runners in the "Sandbox" layer (23.1); set BASTION_SKIP_DOCKER=1 to skip locally.
 */

const dockerAvailable = (): boolean => {
  if (process.env.BASTION_SKIP_DOCKER === '1') return false;
  const r = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  return r.status === 0;
};
const RUNNER_BUNDLE = path.resolve(__dirname, '../../../apps/runner/dist/runner.mjs');
const PROFILE = path.resolve(__dirname, '../../../deploy/docker/sandbox-seccomp.json');
const hasDocker = dockerAvailable() && existsSync(RUNNER_BUNDLE);

type Probe = { code: number; output: string };

describe.skipIf(!hasDocker)('8.5 / 23.3 bubblewrap jail in Docker (Linux)', () => {
  const probes = new Map<string, Probe>();
  let setupError: string | undefined;
  const ID = 'inst-0123456789';

  beforeAll(() => {
    const work = mkdtempSync(path.join(tmpdir(), 'bastion-bwrap-'));
    const arch = hostSeccompArch();
    const profile = JSON.parse(readFileSync(PROFILE, 'utf8')) as unknown;
    writeFileSync(path.join(work, 'seccomp.bpf'), generateSeccompBpf(profile, arch));
    copyFileSync(RUNNER_BUNDLE, path.join(work, 'runner.mjs'));
    const dirs = sandboxDirs('/data', ID);
    const full = buildBwrapArgs({ dirs, bindRunnerDir: true, lib64: true });
    const seccompAt = full.indexOf('--seccomp');
    const prefix = full.slice(0, seccompAt + 2).join(' ');
    const probeDir = path.join(work, 'probes');
    mkdirSync(probeDir);
    const file = (name: string, content: string) =>
      writeFileSync(path.join(probeDir, name), content);
    file(
      'connect.js',
      `const [host, port] = process.argv.slice(2);
const s = require('net').connect({ host, port: Number(port), timeout: 2000 });
s.on('connect', () => { console.log('CONNECTED'); process.exit(0); });
s.on('error', (e) => { console.log('ERR ' + e.code); process.exit(1); });
s.on('timeout', () => { console.log('TIMEOUT'); process.exit(1); });
`,
    );
    file(
      'raw.pl',
      `use Socket; socket(my $s, PF_INET, SOCK_RAW, 1) or do { print "ERR $!"; exit 1 }; print "OPENED"; exit 0;\n`,
    );
    file(
      'ptrace.pl',
      `my $r = syscall(${syscallNumber('ptrace', arch)}, 0, 0, 0, 0); print "ret=$r err=$!"; exit($r == 0 ? 0 : 1);\n`,
    );
    file(
      'health.js',
      `require('http').get({ socketPath: '/data/sandboxes/${ID}/run/runner.sock', path: '/healthz' }, (r) => { let b=''; r.on('data', d => b += d); r.on('end', () => { console.log(b); process.exit(0); }); }).on('error', e => { console.log('ERR ' + e.message); process.exit(1); });\n`,
    );
    const script = `set -u
export DEBIAN_FRONTEND=noninteractive
(apt-get update -qq && apt-get install -y -qq --no-install-recommends bubblewrap ca-certificates) >/tmp/apt.log 2>&1 || { echo "SETUP|apt failed: $(tail -c 300 /tmp/apt.log | tr '\\n' ' ')"; exit 0; }
mkdir -p /opt/runtime/bin /opt/runtime/probes /opt/bastion /data/sandboxes/${ID}/workspace /data/sandboxes/${ID}/home /data/sandboxes/${ID}/mcp /data/sandboxes/${ID}/run /var/run/secrets/kubernetes.io/serviceaccount
echo secret-token > /var/run/secrets/kubernetes.io/serviceaccount/token
cp /usr/local/bin/node /opt/runtime/bin/node
cp /work/probes/* /opt/runtime/probes/
cp /work/runner.mjs /opt/bastion/runner.mjs
chmod -R a+rwX /data
jail() { bwrap ${prefix} "$@" 3< /work/seccomp.bpf; }
probe() { name=$1; shift; out=$(timeout 20 bwrap ${prefix} "$@" 3< /work/seccomp.bpf 2>&1); code=$?; echo "PROBE|$name|$code|$(echo "$out" | tr '\\n' ' ' | head -c 500)"; }
probe baseline /bin/sh -c 'echo jail-ok; id -u'
probe secrets /bin/sh -c 'cat /var/run/secrets/kubernetes.io/serviceaccount/token'
probe k8s-api /opt/runtime/bin/node /opt/runtime/probes/connect.js 10.96.0.1 443
probe direct-connect /opt/runtime/bin/node /opt/runtime/probes/connect.js 1.1.1.1 443
probe loopback-only /bin/sh -c "tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\\n' ','"
probe raw-socket /usr/bin/perl /opt/runtime/probes/raw.pl
probe ptrace /usr/bin/perl /opt/runtime/probes/ptrace.pl
probe mount /usr/bin/mount -t tmpfs none /tmp
probe unshare /usr/bin/unshare -U /bin/true
probe env /usr/bin/env
probe clone-thread /opt/runtime/bin/node -e "new Worker(1)"
probe node-threads /opt/runtime/bin/node -e "const {Worker}=require('worker_threads'); new Worker('process.exit(0)',{eval:true}).on('exit',c=>{console.log('worker-exit',c)})"
# the real runner inside the jail, with the exact argv of 8.5
bwrap ${full.join(' ')} 3< /work/seccomp.bpf >/tmp/runner.log 2>&1 &
RP=$!
sleep 3
out=$(timeout 10 node /work/probes/health.js 2>&1); echo "PROBE|runner-healthz|$?|$out"
echo "PROBE|runner-log|0|$(head -c 300 /tmp/runner.log | tr '\\n' ' ')"
kill $RP 2>/dev/null
echo DONE
`;
    writeFileSync(path.join(work, 'run.sh'), script);
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
        'node:24-bookworm-slim',
        'bash',
        '/work/run.sh',
      ],
      { encoding: 'utf8', timeout: 280_000 },
    );
    const out = `${r.stdout}\n${r.stderr}`;
    for (const line of out.split('\n')) {
      const m = /^PROBE\|([^|]+)\|(\d+)\|(.*)$/.exec(line.trim());
      if (m) probes.set(m[1] as string, { code: Number(m[2]), output: m[3] as string });
      const s = /^SETUP\|(.*)$/.exec(line.trim());
      if (s) setupError = s[1];
    }
    if (!probes.has('baseline')) setupError ??= `no probe output: ${out.slice(-500)}`;
  }, 300_000);

  const get = (name: string): Probe => {
    const p = probes.get(name);
    if (!p) throw new Error(`probe ${name} missing; setup: ${setupError ?? 'unknown'}`);
    // A negative probe only counts when the jail itself started: bwrap setup errors are not a pass.
    if (/^bwrap: /.test(p.output))
      throw new Error(`jail did not start for probe ${name}: ${p.output}`);
    return p;
  };

  it('8.5 setup: bubblewrap starts a jail with the documented argv under the generated seccomp filter', () => {
    expect(setupError, setupError).toBeUndefined();
    const baseline = get('baseline');
    expect(baseline.code, baseline.output).toBe(0);
    expect(baseline.output).toContain('jail-ok');
  });
  it('23.3 reading /var/run/secrets (service account token) fails', () => {
    const p = get('secrets');
    expect(p.code).not.toBe(0);
    expect(p.output).not.toContain('secret-token');
  });
  it('23.3 reaching the Kubernetes API fails (no network but loopback)', () => {
    const p = get('k8s-api');
    expect(p.code).not.toBe(0);
    expect(p.output).not.toContain('CONNECTED');
  });
  it('23.3 connecting directly, bypassing the proxy, fails', () => {
    const p = get('direct-connect');
    expect(p.code).not.toBe(0);
    expect(p.output).not.toContain('CONNECTED');
  });
  it('8.5 --unshare-net leaves only loopback', () => {
    expect(get('loopback-only').output.replace(/,$/, '').split(',').filter(Boolean)).toEqual([
      'lo',
    ]);
  });
  it('23.3 opening a raw socket fails', () => {
    const p = get('raw-socket');
    expect(p.code).not.toBe(0);
    expect(p.output).not.toContain('OPENED');
  });
  it('23.3 ptrace is denied by the seccomp filter', () => {
    const p = get('ptrace');
    expect(p.code).not.toBe(0);
    expect(p.output).toMatch(/Operation not permitted|ret=-1/);
  });
  it('23.3 mount fails', () => {
    expect(get('mount').code).not.toBe(0);
  });
  it('23.3 creating a user namespace inside the jail fails', () => {
    expect(get('unshare').code).not.toBe(0);
  });
  it('8.5 the jail environment is clean (only HOME, PATH)', () => {
    const names = get('env')
      .output.split(' ')
      .map((kv) => kv.split('=')[0])
      .filter(Boolean);
    expect(
      names.filter((n) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(n as string)).sort(),
    ).toEqual(['HOME', 'PATH']);
  });
  it('8.5 the seccomp filter still lets Node create worker threads (clone3 falls back to clone)', () => {
    expect(get('node-threads').output).toContain('worker-exit 0');
  });
  it('8.3 the real runner starts inside the jail on /run/bastion/runner.sock and answers /healthz', () => {
    const p = get('runner-healthz');
    expect(p.output, `${p.output} / ${probes.get('runner-log')?.output}`).toContain(
      '"state":"unbound"',
    );
  });
});
