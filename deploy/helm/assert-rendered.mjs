// Structural assertions on `helm template` output against tdd 8.4, 20.2 and 21.2.
//   helm template ... | node assert-rendered.mjs <scenario>
// Scenarios: split | all | httproute | no-sandbox | otel-gke
// Exits non-zero and prints every failed assertion. `yaml` comes from packages/core (pnpm does not hoist it).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../packages/core/package.json', import.meta.url));
const { parseAllDocuments } = require('yaml');

const scenario = process.argv[2] ?? 'split';
const docs = parseAllDocuments(readFileSync(0, 'utf8'))
  .map((d) => d.toJS())
  .filter(Boolean);
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};
const find = (kind, namePart) =>
  docs.filter((d) => d.kind === kind && (!namePart || d.metadata.name.includes(namePart)));
const one = (kind, namePart) => {
  const hits = find(kind, namePart);
  check(hits.length === 1, `expected exactly one ${kind} ${namePart ?? ''}, found ${hits.length}`);
  return hits[0];
};
const envOf = (deployment) =>
  Object.fromEntries(
    deployment.spec.template.spec.containers[0].env.map((e) => [e.name, e.value ?? e.valueFrom]),
  );

const sandboxEnabled = scenario !== 'no-sandbox';
const all = scenario === 'all';

// ---- workloads ----------------------------------------------------------------------------------------------
if (all) {
  const d = one('Deployment', 'all');
  check(envOf(d).BASTION_ROLE === 'all', 'all-in-one Deployment must run BASTION_ROLE=all');
  check(find('Deployment', 'ui').length === 0, 'all-in-one must not render a ui Deployment');
  check(find('HorizontalPodAutoscaler').length === 0, 'all-in-one must not render an HPA');
} else {
  const worker = one('Deployment', 'worker');
  const ui = one('Deployment', 'ui');
  check(envOf(worker).BASTION_ROLE === 'worker', 'worker role');
  check(envOf(ui).BASTION_ROLE === 'ui', 'ui role');
  const ports = worker.spec.template.spec.containers[0].ports.map((p) => p.containerPort);
  check(JSON.stringify(ports) === '[8080,7443,3128]', `worker ports ${ports}`);
  check(ui.spec.template.spec.containers[0].ports.length === 1, 'ui exposes only 8080');
  check(
    ui.spec.template.spec.volumes.some(
      (v) => v.name === 'git-cache' && v.emptyDir.sizeLimit === '10Gi',
    ),
    'ui git cache emptyDir 10Gi',
  );
  check(
    envOf(ui).BASTION_GIT_CACHE_DIR === '/var/cache/bastion/git',
    'BASTION_GIT_CACHE_DIR on ui',
  );
  check(!('BASTION_GIT_CACHE_DIR' in envOf(worker)), 'worker has no git cache');
  const hpa = one('HorizontalPodAutoscaler');
  if (hpa) {
    check(hpa.spec.minReplicas === 3 && hpa.spec.maxReplicas === 20, 'HPA 3 to 20');
    check(hpa.spec.metrics[0].resource.target.averageUtilization === 70, 'HPA 70% CPU');
    check(worker.spec.replicas === undefined, 'HPA-managed Deployment must not set replicas');
  }
  check(ui.spec.replicas === 2, 'ui replicas 2');
  const pdbs = find('PodDisruptionBudget');
  check(
    pdbs.length === 2 && pdbs.every((p) => p.spec.minAvailable === 1),
    'one PDB per role with minAvailable 1',
  );
}
for (const d of find('Deployment').filter((x) => !x.metadata.name.includes('otel'))) {
  const spec = d.spec.template.spec;
  check(
    spec.terminationGracePeriodSeconds === 30,
    `${d.metadata.name}: terminationGracePeriodSeconds 30`,
  );
  const c = spec.containers[0];
  check(
    c.readinessProbe.httpGet.path === '/readyz' && c.livenessProbe.httpGet.path === '/healthz',
    `${d.metadata.name}: probes`,
  );
  check(spec.topologySpreadConstraints?.length === 2, `${d.metadata.name}: zone and node spread`);
  const keys = (spec.topologySpreadConstraints ?? []).map((t) => t.topologyKey).join(',');
  check(
    keys === 'topology.kubernetes.io/zone,kubernetes.io/hostname',
    `${d.metadata.name}: topology keys ${keys}`,
  );
  const env = envOf(d);
  check(env.BASTION_DATABASE_URL?.secretKeyRef?.key === 'DATABASE_URL', 'DATABASE_URL from secret');
  check(env.BASTION_REDIS_URL?.secretKeyRef?.key === 'REDIS_URL', 'REDIS_URL from secret');
  check(
    env.BASTION_INTERNAL_SECRET?.secretKeyRef?.key === 'INTERNAL_SECRET',
    'INTERNAL_SECRET from secret',
  );
  check(
    c.securityContext.readOnlyRootFilesystem === true,
    `${d.metadata.name}: read-only root filesystem`,
  );
}

// ---- services ------------------------------------------------------------------------------------------------
const workerSvc = one('Service', all ? 'all' : 'worker');
check(
  workerSvc.spec.type === 'ClusterIP' && workerSvc.spec.clusterIP === undefined,
  'worker Service is a plain ClusterIP (not headless)',
);
check(workerSvc.spec.ports.map((p) => p.port).join() === '8080,7443,3128', 'worker Service ports');

// ---- routing -------------------------------------------------------------------------------------------------
if (scenario === 'httproute') {
  check(find('Ingress').length === 0, 'httproute scenario renders no Ingress');
  const r = one('HTTPRoute');
  const mcp = r.spec.rules[0];
  check(mcp.timeouts.request === '0s', 'MCP route timeouts.request 0s');
  const paths = mcp.matches.map((m) => m.path.value);
  check(
    paths.includes('/mcp') && paths.includes('/.well-known/oauth-protected-resource'),
    'MCP route paths',
  );
  check(mcp.backendRefs[0].name.endsWith('worker'), 'MCP route goes to the worker Service');
  check(r.spec.rules[1].backendRefs[0].name.endsWith('ui'), 'other paths go to ui');
} else {
  check(find('HTTPRoute').length === 0, 'no HTTPRoute with ingress');
  const ing = one('Ingress');
  const a = ing.metadata.annotations;
  check(a['nginx.ingress.kubernetes.io/proxy-read-timeout'] === '3600', 'proxy-read-timeout 3600');
  check(a['nginx.ingress.kubernetes.io/proxy-send-timeout'] === '3600', 'proxy-send-timeout 3600');
  check(a['nginx.ingress.kubernetes.io/proxy-buffering'] === 'off', 'proxy-buffering off');
  const byPath = Object.fromEntries(
    ing.spec.rules[0].http.paths.map((p) => [p.path, p.backend.service.name]),
  );
  const wanted = all ? 'all' : 'worker';
  for (const p of ['/mcp', '/.well-known/oauth-protected-resource'])
    check(byPath[p]?.endsWith(wanted), `${p} -> ${wanted}`);
  for (const p of ['/plugins', '/registry', '/oauth', '/'])
    check(byPath[p]?.endsWith(all ? 'all' : 'ui'), `${p} -> ui`);
}

// ---- sandbox -------------------------------------------------------------------------------------------------
if (!sandboxEnabled) {
  for (const kind of ['SandboxTemplate', 'SandboxWarmPool', 'Role', 'RoleBinding']) {
    check(find(kind).length === 0, `sandbox disabled but ${kind} rendered`);
  }
  check(find('Namespace').length === 0, 'sandbox disabled but Namespace rendered');
  const d = find('Deployment')[0];
  check(envOf(d).BASTION_SANDBOX_DRIVER === 'bubblewrap', 'driver falls back to bubblewrap');
} else {
  check(one('Namespace').metadata.name === 'bastion-sandboxes', 'sandbox namespace');
  const expected = {
    small: { req: ['250m', '512Mi'], lim: ['1', '512Mi'], pool: 5 },
    medium: { req: ['500m', '1Gi'], lim: ['2', '1Gi'], pool: 2 },
    large: { req: ['1', '4Gi'], lim: ['4', '4Gi'], pool: 0 },
  };
  for (const [size, e] of Object.entries(expected)) {
    const t = one('SandboxTemplate', `bastion-runtime-${size}`);
    if (!t) continue;
    const spec = t.spec.podTemplate.spec;
    const c = spec.containers[0];
    check(spec.runtimeClassName === 'gvisor', `${size}: runtimeClassName`);
    check(
      spec.automountServiceAccountToken === false,
      `${size}: automountServiceAccountToken false`,
    );
    check(
      spec.securityContext.runAsNonRoot === true && spec.securityContext.runAsUser === 1000,
      `${size}: uid 1000`,
    );
    check(
      spec.securityContext.seccompProfile.type === 'RuntimeDefault',
      `${size}: seccomp RuntimeDefault`,
    );
    check(c.securityContext.readOnlyRootFilesystem === true, `${size}: readOnlyRootFilesystem`);
    check(c.securityContext.allowPrivilegeEscalation === false, `${size}: no privilege escalation`);
    check(c.securityContext.capabilities.drop.join() === 'ALL', `${size}: drop ALL`);
    check(c.image.startsWith('ghcr.io/bastion-mcp/sandbox-runtime:'), `${size}: image`);
    check(
      c.resources.requests.cpu === e.req[0] && c.resources.requests.memory === e.req[1],
      `${size}: requests`,
    );
    check(
      c.resources.limits.cpu === e.lim[0] && c.resources.limits.memory === e.lim[1],
      `${size}: limits`,
    );
    const mounts = c.volumeMounts
      .map((m) => m.mountPath)
      .sort()
      .join();
    check(mounts === '/home/sandbox,/opt/mcp,/tmp,/workspace', `${size}: mounts ${mounts}`);
    const vols = Object.fromEntries(spec.volumes.map((v) => [v.name, v.emptyDir.sizeLimit]));
    check(vols.tmp === '256Mi' && vols.mcp === '2Gi', `${size}: emptyDir limits`);
    check(
      t.spec.volumeClaimTemplatesPolicy === 'Allowed',
      `${size}: volumeClaimTemplatesPolicy Allowed`,
    );
    const np = t.spec.networkPolicy;
    check(
      np.ingress.length === 1 &&
        np.ingress[0].ports.length === 1 &&
        np.ingress[0].ports[0].port === 8080,
      `${size}: ingress 8080 only`,
    );
    const from = np.ingress[0].from[0];
    check(
      from.podSelector.matchLabels['app.kubernetes.io/component'] === (all ? 'all' : 'worker'),
      `${size}: ingress from worker pods`,
    );
    check(
      from.namespaceSelector.matchLabels['kubernetes.io/metadata.name'] === 'default',
      `${size}: ingress namespaceSelector is the release namespace`,
    );
    check(
      np.egress.length === 1 && np.egress[0].ports[0].port === 3128,
      `${size}: egress 3128 only`,
    );
    check(
      !np.egress.some((r) => (r.ports ?? []).some((p) => p.port === 53)),
      `${size}: no DNS egress`,
    );
    const pools = find('SandboxWarmPool').filter((p) =>
      p.metadata.name.startsWith(`bastion-runtime-${size}`),
    );
    check(pools.length === 2, `${size}: two pools`);
    const main = pools.find((p) => !p.metadata.name.endsWith('-pvc'));
    const pvc = pools.find((p) => p.metadata.name.endsWith('-pvc'));
    check(main?.spec.replicas === e.pool, `${size}: warm pool replicas ${main?.spec.replicas}`);
    check(pvc?.spec.replicas === 0, `${size}: -pvc pool replicas 0`);
  }
  const role = one('Role');
  const rules = role.rules.map((r) => `${r.apiGroups}|${r.resources}|${r.verbs}`);
  check(
    rules.includes('extensions.agents.x-k8s.io|sandboxclaims|create,get,list,watch,patch,delete'),
    'role: sandboxclaims',
  );
  check(
    rules.includes('agents.x-k8s.io|sandboxes|create,get,list,watch,patch,delete'),
    'role: sandboxes',
  );
  check(
    rules.includes('extensions.agents.x-k8s.io|sandboxtemplates,sandboxwarmpools|get,list'),
    'role: templates and pools',
  );
  check(rules.includes('|pods,pods/log|get,list'), 'role: pods');
  check(rules.length === 4, 'role has exactly four rules (nothing cluster-wide)');
  check(
    find('ClusterRole').length === 0 && find('ClusterRoleBinding').length === 0,
    'no cluster-scoped RBAC',
  );
}

// ---- network policies, migrations, otel -----------------------------------------------------------------------
const nps = find('NetworkPolicy');
check(nps.length === (all ? 1 : 2), `network policy count ${nps.length}`);
const workerNp = nps.find((n) => n.metadata.name.endsWith(all ? 'all' : 'worker'));
const portsOf = (rule) => rule.ports.map((p) => p.port).join();
check(
  workerNp.spec.ingress.some((r) => portsOf(r) === '8080' && r.from[0].namespaceSelector),
  'worker NP: 8080 from ingress controller',
);
check(
  workerNp.spec.ingress.some(
    (r) => portsOf(r) === '7443' && r.from[0].podSelector && !r.from[0].namespaceSelector,
  ),
  'worker NP: 7443 from worker pods',
);
if (sandboxEnabled)
  check(
    workerNp.spec.ingress.some((r) => portsOf(r) === '3128'),
    'worker NP: 3128 from sandboxes',
  );
if (!all) {
  const uiNp = nps.find((n) => n.metadata.name.endsWith('ui'));
  check(
    uiNp.spec.ingress.length === 1 && portsOf(uiNp.spec.ingress[0]) === '8080',
    'ui NP: 8080 from ingress controller only',
  );
}
const job = one('Job');
check(job.metadata.annotations['helm.sh/hook'] === 'pre-install,pre-upgrade', 'migration hook');
check(
  job.spec.template.spec.containers[0].command.join(' ') === 'bastion migrate',
  'migration command',
);
if (scenario === 'otel-gke') {
  const cm = one('ConfigMap');
  check(
    cm.data['config.yaml'].includes('tail_sampling') && cm.data['config.yaml'].includes('ERROR'),
    'collector keeps error traces',
  );
  check(find('Deployment', 'otel').length === 1, 'collector Deployment');
  check(one('BackendConfig').spec.timeoutSec === 3600, 'BackendConfig timeoutSec 3600');
  check(
    Boolean(workerSvc.metadata.annotations?.['cloud.google.com/backend-config']),
    'Service references BackendConfig',
  );
  check(
    envOf(find('Deployment', 'worker')[0]).OTEL_EXPORTER_OTLP_ENDPOINT?.includes(
      'otel-collector:4318',
    ),
    'OTLP endpoint points at the collector',
  );
  const sa = one('ServiceAccount');
  check(
    sa.metadata.annotations['iam.gke.io/gcp-service-account'],
    'ServiceAccount workload identity annotation',
  );
} else {
  check(
    find('BackendConfig').length === 0 && find('ConfigMap').length === 0,
    'optional resources are off by default',
  );
}

if (failures.length > 0) {
  console.error(`scenario ${scenario}: ${failures.length} assertion(s) failed`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`scenario ${scenario}: ${docs.length} documents, all assertions passed`);
