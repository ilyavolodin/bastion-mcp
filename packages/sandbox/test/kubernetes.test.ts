import { describe, expect, it } from 'vitest';
import {
  buildClaim,
  type CoreApiLike,
  type CustomApiLike,
  claimReadyCondition,
  createKubeApi,
  decideClaimGc,
  type GcKnownState,
  instanceClaimName,
  isPersistentClaimName,
  type KubeApi,
  KubeApiError,
  type KubeKind,
  type KubeObject,
  KubernetesDriver,
  LABELS,
  needsShutdownRefresh,
  parseClaimStatus,
  persistentClaimName,
  type RunnerClient,
  refreshShutdownPatch,
  runnerAddressOf,
  type SandboxSpec,
  selectClaimsToDelete,
  userHash,
  warmPoolName,
} from '../src';

const IID = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const INSTALL = '0198ffff-1111-7e5f-8a9b-0c1d2e3f4a5b';
const NOW = Date.parse('2026-10-01T12:00:00Z');
const SPEC: SandboxSpec = {
  instanceId: IID,
  installationId: INSTALL,
  userId: 'user-1',
  size: 'medium',
  workspace: { persistent: false, sizeMiB: 512 },
};

describe('8.4 claim builders', () => {
  it('8.4 names claims bst-<last 12 hex of instanceId> and bsp-<last 12 hex of installationId>', () => {
    expect(instanceClaimName(IID)).toBe('bst-0c1d2e3f4a5b');
    expect(persistentClaimName(INSTALL)).toBe('bsp-0c1d2e3f4a5b');
    expect(isPersistentClaimName('bsp-x')).toBe(true);
    expect(() => instanceClaimName('zz')).toThrow(TypeError);
  });
  it('8.4 UUIDv7 ids from the same millisecond get different claim names', () => {
    const a = '0198a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
    const b = '0198a1b2-c3d4-7111-9222-aaaabbbbcccc';
    expect(instanceClaimName(a)).not.toBe(instanceClaimName(b));
    expect(persistentClaimName(a)).not.toBe(persistentClaimName(b));
  });
  it('8.4 user-hash label is SHA-256 of the user id, first 16 hex', () => {
    expect(userHash('user-1')).toMatch(/^[0-9a-f]{16}$/);
    expect(userHash('user-1')).not.toBe(userHash('user-2'));
  });
  it('8.4 builds an ephemeral claim with warmPoolRef, labels and Delete lifecycle with shutdownTime now+24h', () => {
    const claim = buildClaim({ spec: SPEC, namespace: 'bastion-sandboxes', nowMs: NOW });
    expect(claim.apiVersion).toBe('extensions.agents.x-k8s.io/v1beta1');
    expect(claim.kind).toBe('SandboxClaim');
    expect(claim.metadata.name).toBe('bst-0c1d2e3f4a5b');
    expect(claim.metadata.labels).toEqual({
      [LABELS.instance]: IID,
      [LABELS.installation]: INSTALL,
      [LABELS.userHash]: userHash('user-1'),
    });
    expect(claim.spec).toEqual({
      warmPoolRef: { name: 'bastion-runtime-medium' },
      lifecycle: { shutdownPolicy: 'Delete', shutdownTime: '2026-10-02T12:00:00.000Z' },
    });
  });
  it('8.4 persistent claims use the -pvc pool, volumeClaimTemplates sized in MiB and no shutdownTime', () => {
    const claim = buildClaim({
      spec: { ...SPEC, size: 'small', workspace: { persistent: true, sizeMiB: 2048 } },
      namespace: 'ns',
      nowMs: NOW,
      storageClassName: 'fast',
    });
    expect(claim.metadata.name).toBe('bsp-0c1d2e3f4a5b');
    expect(claim.spec?.warmPoolRef).toEqual({ name: 'bastion-runtime-small-pvc' });
    expect(claim.spec?.lifecycle).toBeUndefined();
    const vct = claim.spec?.volumeClaimTemplates as {
      spec: { resources: { requests: { storage: string } }; storageClassName: string };
    }[];
    expect(vct[0]?.spec.resources.requests.storage).toBe('2048Mi');
    expect(vct[0]?.spec.storageClassName).toBe('fast');
    expect(claim.metadata.labels?.[LABELS.persistent]).toBe('true');
    expect(() =>
      buildClaim({
        spec: { ...SPEC, installationId: null, workspace: { persistent: true, sizeMiB: 1 } },
        namespace: 'n',
        nowMs: 0,
      }),
    ).toThrow();
  });
  it('8.4 shared instances (no user or installation) omit those labels; pool name is overridable', () => {
    const claim = buildClaim({
      spec: { ...SPEC, installationId: null, userId: null },
      namespace: 'n',
      nowMs: NOW,
      poolName: 'custom',
    });
    expect(claim.metadata.labels).toEqual({ [LABELS.instance]: IID });
    expect(claim.spec?.warmPoolRef).toEqual({ name: 'custom' });
    expect(warmPoolName('large', false)).toBe('bastion-runtime-large');
  });
  it('8.4 shutdownTime is refreshed hourly', () => {
    expect(needsShutdownRefresh(0, 59 * 60_000)).toBe(false);
    expect(needsShutdownRefresh(0, 60 * 60_000)).toBe(true);
    expect(refreshShutdownPatch(NOW)).toEqual({
      spec: { lifecycle: { shutdownPolicy: 'Delete', shutdownTime: '2026-10-02T12:00:00.000Z' } },
    });
  });
  it('8.4 the runner address comes from podIPs, else serviceFQDN, else is pending', () => {
    const obj = (status: Record<string, unknown>): KubeObject => ({
      metadata: { name: 'c' },
      status,
    });
    expect(runnerAddressOf(obj({ sandbox: { podIPs: ['10.1.2.3'] } }))).toBe('10.1.2.3:8080');
    expect(runnerAddressOf(obj({ sandbox: { podIPs: ['fd00::5'] } }))).toBe('[fd00::5]:8080');
    expect(runnerAddressOf(obj({ sandbox: { serviceFQDN: 'x.ns.svc' } }))).toBe('x.ns.svc:8080');
    expect(runnerAddressOf(obj({ sandbox: {} }))).toBeNull();
    expect(runnerAddressOf({ metadata: { name: 'c' } })).toBeNull();
    expect(parseClaimStatus(obj({ conditions: 'bad' }))).toEqual({});
    expect(
      claimReadyCondition(obj({ conditions: [{ type: 'Ready', status: 'True' }] }))?.status,
    ).toBe('True');
  });
});

describe('8.4 garbage collection policy', () => {
  const claim = (name: string, labels: Record<string, string>): KubeObject => ({
    metadata: { name, labels },
  });
  const known: GcKnownState = {
    instances: new Map([
      ['live', { leaseExpiredAt: null }],
      ['recent', { leaseExpiredAt: NOW - 9 * 60_000 }],
      ['stale', { leaseExpiredAt: NOW - 11 * 60_000 }],
    ]),
    installations: new Set(['inst-ok']),
  };
  it('8.4 deletes claims whose instance is not known', () => {
    expect(decideClaimGc(claim('a', { [LABELS.instance]: 'ghost' }), known, NOW)).toMatchObject({
      delete: true,
      reason: 'unknown-instance',
    });
    expect(decideClaimGc(claim('a', {}), known, NOW)).toMatchObject({ delete: true });
  });
  it('8.4 deletes claims whose lease expired more than 10 minutes ago, keeps the rest', () => {
    expect(decideClaimGc(claim('a', { [LABELS.instance]: 'stale' }), known, NOW)).toMatchObject({
      delete: true,
      reason: 'lease-expired',
    });
    expect(decideClaimGc(claim('a', { [LABELS.instance]: 'recent' }), known, NOW).delete).toBe(
      false,
    );
    expect(decideClaimGc(claim('a', { [LABELS.instance]: 'live' }), known, NOW).delete).toBe(false);
  });
  it('8.4 persistent claims are judged by their installation', () => {
    const p = (inst: string) =>
      claim('bsp-1', {
        [LABELS.persistent]: 'true',
        [LABELS.installation]: inst,
        [LABELS.instance]: 'ghost',
      });
    expect(decideClaimGc(p('inst-ok'), known, NOW).delete).toBe(false);
    expect(decideClaimGc(p('gone'), known, NOW)).toMatchObject({
      delete: true,
      reason: 'unknown-installation',
    });
    expect(decideClaimGc(claim('bsp-2', { [LABELS.persistent]: 'true' }), known, NOW).delete).toBe(
      true,
    );
  });
  it('8.4 selectClaimsToDelete returns only deletions', () => {
    const out = selectClaimsToDelete(
      [claim('k', { [LABELS.instance]: 'live' }), claim('d', { [LABELS.instance]: 'ghost' })],
      known,
      NOW,
    );
    expect(out.map((d) => d.name)).toEqual(['d']);
  });
});

// --- fake KubeApi --------------------------------------------------------------------------------------------------
class FakeKube implements KubeApi {
  objects = new Map<string, KubeObject>();
  log: string[] = [];
  bindIp: string | null = '10.0.0.7';
  createError: Error | undefined;
  private key = (k: KubeKind, n: string) => `${k}/${n}`;
  async get(kind: KubeKind, name: string) {
    return this.objects.get(this.key(kind, name)) ?? null;
  }
  async create(_k: 'claim', body: KubeObject) {
    if (this.createError) throw this.createError;
    const stored: KubeObject = {
      ...body,
      status: { sandbox: { name: `sbx-${body.metadata.name}` } },
    };
    this.objects.set(this.key('claim', body.metadata.name), stored);
    this.log.push(`create ${body.metadata.name}`);
    return stored;
  }
  async patch(kind: 'claim' | 'sandbox', name: string, body: Record<string, unknown>) {
    this.log.push(`patch ${kind}/${name} ${JSON.stringify(body)}`);
  }
  async delete(kind: KubeKind, name: string) {
    this.objects.delete(this.key(kind, name));
    this.log.push(`delete ${kind}/${name}`);
  }
  async list(kind: KubeKind, selector: string) {
    this.log.push(`list ${kind} ${selector}`);
    return [...this.objects.entries()].filter(([k]) => k.startsWith(`${kind}/`)).map(([, v]) => v);
  }
  async deleteMatching(_k: 'pvc', selector: string) {
    this.log.push(`deleteMatching ${selector}`);
  }
  async *watchClaim(name: string, signal: AbortSignal) {
    const claim = this.objects.get(this.key('claim', name));
    if (!claim) return;
    // first snapshot is still pending, then the pod is bound
    yield claim;
    if (signal.aborted) return;
    if (this.bindIp) {
      yield { ...claim, status: { sandbox: { name: `sbx-${name}`, podIPs: [this.bindIp] } } };
    } else {
      await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
    }
  }
}

const fakeRunner = (state: 'unbound' | 'bound' | 'running' = 'unbound') => {
  const calls: string[] = [];
  const runner: RunnerClient = {
    health: async () => ({ state }),
    bind: async (t) => void calls.push(`bind:${t}`),
    useToken: (t) => void calls.push(`useToken:${t}`),
    start: async function* () {},
    stop: async () => {},
    openStdio: async () => {
      throw new Error('n/a');
    },
  };
  return { runner, calls };
};

describe('8.4 kubernetes driver', () => {
  const make = (
    api: FakeKube,
    runnerState: 'unbound' | 'bound' | 'running' = 'unbound',
    extra: Record<string, unknown> = {},
  ) => {
    const r = fakeRunner(runnerState);
    const addresses: string[] = [];
    const driver = new KubernetesDriver({
      api,
      clock: { now: () => NOW },
      tokenFactory: () => 'runner-token',
      runnerFactory: (a) => {
        addresses.push(a);
        return r.runner;
      },
      claimTimeoutMs: 400,
      runnerReadyTimeoutMs: 400,
      ...extra,
    });
    return { driver, ...r, addresses };
  };
  const signal = () => new AbortController().signal;

  it('8.4 creates the claim, waits for the pod address, binds the runner on port 8080 and returns the ref', async () => {
    const api = new FakeKube();
    const t = make(api);
    const handle = await t.driver.create(SPEC, signal());
    expect(api.log[0]).toBe('create bst-0c1d2e3f4a5b');
    expect(t.addresses).toEqual(['10.0.0.7:8080']);
    expect(t.calls).toEqual(['bind:runner-token']);
    expect(handle.ref).toEqual({
      driver: 'kubernetes',
      id: 'bst-0c1d2e3f4a5b',
      address: '10.0.0.7:8080',
      runnerToken: 'runner-token',
    });
    expect(t.driver.name).toBe('kubernetes');
    expect(t.driver.isolation).toBe('gvisor');
  });
  it('8.4 a claim that never binds times out, is deleted and fails with SANDBOX_START_FAILED', async () => {
    const api = new FakeKube();
    api.bindIp = null;
    const t = make(api);
    await expect(t.driver.create(SPEC, signal())).rejects.toMatchObject({
      code: 'SANDBOX_START_FAILED',
    });
    expect(api.log).toContain('delete claim/bst-0c1d2e3f4a5b');
  });
  it('8.4 an already existing ephemeral claim name is an error and is not deleted', async () => {
    const api = new FakeKube();
    const t = make(api);
    await t.driver.create(SPEC, signal());
    api.log.length = 0;
    await expect(t.driver.create(SPEC, signal())).rejects.toThrow(/already exists/);
    expect(api.log).toEqual([]);
    api.objects.clear();
    api.createError = new KubeApiError(409, 'conflict');
    await expect(t.driver.create(SPEC, signal())).rejects.toThrow(/already exists/);
    api.createError = new Error('boom');
    await expect(t.driver.create(SPEC, signal())).rejects.toThrow(/boom/);
  });
  it('8.4 fails when the runner is already bound (use attach)', async () => {
    const api = new FakeKube();
    const t = make(api, 'bound');
    await expect(t.driver.create(SPEC, signal())).rejects.toThrow(/already bound/);
    expect(api.log).toContain('delete claim/bst-0c1d2e3f4a5b');
  });
  it('8.5 kata-only entries are blocked on a gvisor driver, allowed on a kata one', async () => {
    const api = new FakeKube();
    await expect(
      make(api).driver.create({ ...SPEC, minIsolation: 'kata' }, signal()),
    ).rejects.toThrow(/kata/);
    const kata = make(api, 'unbound', { isolation: 'kata' });
    await expect(
      kata.driver.create({ ...SPEC, minIsolation: 'kata' }, signal()),
    ).resolves.toBeDefined();
    expect(kata.driver.isolation).toBe('kata');
  });
  it('8.4 persistent: first create makes the bsp claim, suspend patches Suspended, a later create resumes to Running', async () => {
    const api = new FakeKube();
    const t = make(api);
    const persistent = { ...SPEC, workspace: { persistent: true, sizeMiB: 1024 } };
    const { ref } = await t.driver.create(persistent, signal());
    expect(ref.id).toBe('bsp-0c1d2e3f4a5b');
    await t.driver.suspend(ref);
    expect(api.log).toContain(
      'patch sandbox/sbx-bsp-0c1d2e3f4a5b {"spec":{"operatingMode":"Suspended"}}',
    );
    await t.driver.create(persistent, signal());
    expect(api.log).toContain(
      'patch sandbox/sbx-bsp-0c1d2e3f4a5b {"spec":{"operatingMode":"Running"}}',
    );
    expect(api.log.filter((l) => l.startsWith('create')).length).toBe(1);
    await expect(t.driver.suspend({ ...ref, id: 'bst-x' })).rejects.toThrow(/persistent/);
    await t.driver.suspend({ ...ref, id: 'bsp-nonexistent' });
  });
  it('8.4 uninstall deletes the claim, its Sandbox and the PVCs; ephemeral destroy deletes claim and Sandbox only', async () => {
    const api = new FakeKube();
    const t = make(api);
    const persistent = { ...SPEC, workspace: { persistent: true, sizeMiB: 1024 } };
    const { ref } = await t.driver.create(persistent, signal());
    api.log.length = 0;
    await t.driver.destroy(ref);
    expect(api.log).toEqual([
      'delete claim/bsp-0c1d2e3f4a5b',
      'delete sandbox/sbx-bsp-0c1d2e3f4a5b',
      `deleteMatching ${LABELS.installation}=${INSTALL}`,
    ]);
    const eph = await t.driver.create(SPEC, signal());
    api.log.length = 0;
    await t.driver.destroy(eph.ref);
    expect(api.log).toEqual([
      'delete claim/bst-0c1d2e3f4a5b',
      'delete sandbox/sbx-bst-0c1d2e3f4a5b',
    ]);
  });
  it('21.2 attach re-uses the stored token against the claim address and fails when the claim is gone', async () => {
    const api = new FakeKube();
    const t = make(api, 'running');
    const ref = {
      driver: 'kubernetes' as const,
      id: 'bst-0c1d2e3f4a5b',
      address: '10.0.0.1:8080',
      runnerToken: 'stored',
    };
    await expect(t.driver.attach(ref, signal())).rejects.toThrow(/no longer exists/);
    api.objects.set('claim/bst-0c1d2e3f4a5b', {
      metadata: { name: 'bst-0c1d2e3f4a5b' },
      status: { sandbox: { podIPs: ['10.0.0.9'] } },
    });
    const handle = await t.driver.attach(ref, signal());
    expect(handle.ref.address).toBe('10.0.0.9:8080');
    expect(t.calls).toEqual(['useToken:stored']);
    const dead = make(api);
    (dead.runner as { health: unknown }).health = async () => {
      throw new Error('ECONNREFUSED');
    };
    await expect(dead.driver.attach(ref, signal())).rejects.toThrow(/unreachable/);
  });
  it('8.4 refreshShutdownTime patches ephemeral claims only; keepAlive can be stopped', async () => {
    const api = new FakeKube();
    const t = make(api);
    await t.driver.refreshShutdownTime({
      driver: 'kubernetes',
      id: 'bst-1',
      address: '',
      runnerToken: '',
    });
    await t.driver.refreshShutdownTime({
      driver: 'kubernetes',
      id: 'bsp-1',
      address: '',
      runnerToken: '',
    });
    expect(api.log.filter((l) => l.startsWith('patch')).length).toBe(1);
    t.driver.keepAlive({ driver: 'kubernetes', id: 'bst-1', address: '', runnerToken: '' }).stop();
  });
  it('8.4 list yields Bastion-labelled claims and collectGarbage deletes unknown or expired ones', async () => {
    const api = new FakeKube();
    api.objects.set('claim/keep', {
      metadata: { name: 'keep', labels: { [LABELS.instance]: 'live' } },
    });
    api.objects.set('claim/drop', {
      metadata: { name: 'drop', labels: { [LABELS.instance]: 'ghost' } },
      status: { sandbox: { name: 'sbx-drop' } },
    });
    api.objects.set('sandbox/orphan', {
      metadata: { name: 'orphan', labels: { [LABELS.instance]: 'ghost' } },
    });
    const t = make(api);
    const ids: string[] = [];
    for await (const r of t.driver.list()) ids.push(r.id);
    expect(ids.sort()).toEqual(['drop', 'keep']);
    const decisions = await t.driver.collectGarbage({
      instances: new Map([['live', { leaseExpiredAt: null }]]),
      installations: new Set(),
    });
    expect(decisions.map((d) => d.name).sort()).toEqual(['drop', 'orphan']);
    expect(api.log).toContain('delete claim/drop');
    expect(api.log).toContain('delete sandbox/sbx-drop');
    expect(api.log).toContain('delete sandbox/orphan');
    expect(api.objects.has('claim/keep')).toBe(true);
  });
});

describe('8.4 client-node adapter (fake clients)', () => {
  const setup = () => {
    const calls: string[] = [];
    const store = new Map<string, unknown>();
    const err = (code: number) => Object.assign(new Error(`HTTP ${code}`), { code });
    const custom: CustomApiLike = {
      getNamespacedCustomObject: async (p) => {
        const v = store.get(`${p.plural}/${p.name}`);
        if (!v) throw err(404);
        return v;
      },
      createNamespacedCustomObject: async (p) => {
        const body = p.body as KubeObject;
        if (store.has(`${p.plural}/${body.metadata.name}`)) throw err(409);
        store.set(`${p.plural}/${body.metadata.name}`, body);
        calls.push(`create ${p.group}/${p.version} ${p.plural}`);
        return body;
      },
      patchNamespacedCustomObject: async (p) =>
        void calls.push(`patch ${p.plural}/${p.name} ${JSON.stringify(p.body)}`),
      deleteNamespacedCustomObject: async (p) => {
        if (!store.delete(`${p.plural}/${p.name}`)) throw err(404);
        calls.push(`delete ${p.plural}/${p.name}`);
      },
      listNamespacedCustomObject: async (p) => ({
        items: [...store.entries()].filter(([k]) => k.startsWith(p.plural)).map(([, v]) => v),
      }),
    };
    const core: CoreApiLike = {
      readNamespacedPersistentVolumeClaim: async () => {
        throw err(404);
      },
      deleteNamespacedPersistentVolumeClaim: async () => {
        throw err(404);
      },
      listNamespacedPersistentVolumeClaim: async () => ({
        items: [{ metadata: { name: 'pvc-1' } }],
      }),
      deleteCollectionNamespacedPersistentVolumeClaim: async (p) =>
        void calls.push(`deleteCollection ${p.labelSelector}`),
    };
    let emit: ((phase: string, obj: unknown) => void) | undefined;
    let finish: ((e: unknown) => void) | undefined;
    let aborted = 0;
    const watcher = {
      watch: async (
        _path: string,
        q: Record<string, string>,
        cb: (p: string, o: unknown) => void,
        done: (e: unknown) => void,
      ) => {
        calls.push(`watch ${q.fieldSelector}`);
        emit = cb;
        finish = done;
        return {
          abort: () => {
            aborted += 1;
          },
        };
      },
    };
    return {
      api: createKubeApi({ namespace: 'ns', custom, core, watcher }),
      calls,
      store,
      emit: () => emit,
      finish: () => finish,
      aborted: () => aborted,
    };
  };

  it('8.4 uses agents.x-k8s.io and extensions.agents.x-k8s.io v1beta1 resources', async () => {
    const t = setup();
    await t.api.create('claim', { metadata: { name: 'c1' } });
    expect(t.calls[0]).toBe('create extensions.agents.x-k8s.io/v1beta1 sandboxclaims');
    expect((await t.api.get('claim', 'c1'))?.metadata.name).toBe('c1');
    expect(await t.api.get('claim', 'nope')).toBeNull();
    expect(await t.api.get('pvc', 'nope')).toBeNull();
    await expect(t.api.create('claim', { metadata: { name: 'c1' } })).rejects.toMatchObject({
      status: 409,
    });
  });
  it('8.4 patches, deletes idempotently and lists', async () => {
    const t = setup();
    await t.api.patch('sandbox', 's1', { spec: { operatingMode: 'Suspended' } });
    expect(t.calls[0]).toContain('patch sandboxes/s1');
    await t.api.create('claim', { metadata: { name: 'c1' } });
    await t.api.delete('claim', 'c1');
    await t.api.delete('claim', 'c1');
    await t.api.delete('pvc', 'x');
    expect(await t.api.list('claim', 'a')).toEqual([]);
    expect((await t.api.list('pvc', 'a')).map((o) => o.metadata.name)).toEqual(['pvc-1']);
    await t.api.deleteMatching('pvc', 'sel=1');
    expect(t.calls).toContain('deleteCollection sel=1');
  });
  it('8.4 non-HTTP errors propagate unchanged', async () => {
    const api = createKubeApi({
      namespace: 'n',
      custom: {
        getNamespacedCustomObject: async () => {
          throw new Error('socket hang up');
        },
      } as unknown as CustomApiLike,
      core: {} as CoreApiLike,
      watcher: { watch: async () => ({ abort() {} }) },
    });
    await expect(api.get('claim', 'x')).rejects.toThrow('socket hang up');
  });
  it('8.4 watchClaim yields the current object then watch events and stops on abort', async () => {
    const t = setup();
    await t.api.create('claim', { metadata: { name: 'c1' } });
    const ctl = new AbortController();
    const seen: string[] = [];
    const run = (async () => {
      for await (const o of t.api.watchClaim('c1', ctl.signal)) {
        seen.push(`${o.metadata.name}:${JSON.stringify(o.status ?? null)}`);
        if (seen.length === 2) ctl.abort();
      }
    })();
    await new Promise((r) => setTimeout(r, 20));
    t.emit()?.('DELETED', { metadata: { name: 'c1' } });
    t.emit()?.('MODIFIED', { bad: true });
    t.emit()?.('MODIFIED', {
      metadata: { name: 'c1' },
      status: { sandbox: { podIPs: ['1.2.3.4'] } },
    });
    await run;
    expect(seen).toEqual(['c1:null', 'c1:{"sandbox":{"podIPs":["1.2.3.4"]}}']);
    expect(t.calls).toContain('watch metadata.name=c1');
    expect(t.aborted()).toBeGreaterThan(0);
  });
  it('8.4 watchClaim ends when the server closes the stream', async () => {
    const t = setup();
    const out: unknown[] = [];
    const run = (async () => {
      for await (const o of t.api.watchClaim('missing', new AbortController().signal)) out.push(o);
    })();
    await new Promise((r) => setTimeout(r, 20));
    t.finish()?.(null);
    await run;
    expect(out).toEqual([]);
  });
});
