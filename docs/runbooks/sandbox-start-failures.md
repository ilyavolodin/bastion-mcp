# Runbook: sandbox start failures and backoff

## Symptoms

- Users get `-32016` (`SANDBOX_START_FAILED`, `data.phase` tells where) or fast-failing `-32016` calls.
- An installation shows status `error` with the last phase and a stderr tail.
- Cold starts are slow; `bastion.sandbox.starts{outcome="failed"}` rises; `-32011` for a single user who has too many
  running sandboxes (cap 10, `BASTION_MAX_RUNNING_INSTANCES_PER_USER`).

## How starts work and fail (8.6, 8.4)

Phases: `claiming`, `binding`, `installing`, `spawning`, `connecting`. After a failed start the next attempt is allowed
after **5 s, 30 s, 2 min, then 10 min**. **Three failures within 30 minutes mark the installation `error`**; calls then
fail fast with `-32016` until the backoff passes or the user clicks **Restart**. A runner crash fails in-flight requests
with `-32014` and the next call restarts it (counted as a failure when it exited within 30 s of starting). If a worker
cannot reach a live sandbox, after 3 failed attaches in 60 s the instance is destroyed and restarted.

## Diagnose by phase

| Phase | Typical causes | Look at |
| --- | --- | --- |
| `claiming` | Controller not running or CRDs missing, RBAC, warm pool empty and no capacity, no node supports the RuntimeClass, claim name collision (409) | `kubectl -n bastion-sandboxes get sandboxclaims,sandboxwarmpools,sandboxes,pods`; `kubectl -n agent-sandbox-system logs deploy/agent-sandbox-controller` (namespace depends on how you installed it); `kubectl get runtimeclass`; node capacity |
| `binding` | Runner not reachable on 8080: NetworkPolicy, wrong pod IP, runtime incompatibility (gVisor) | pod `Ready`; `kubectl -n bastion-sandboxes describe pod`; the template NetworkPolicy; worker to sandbox connectivity |
| `installing` | Package or mirror unreachable (egress allowlist, mirror host), lockfile that no longer installs (version marked `broken`), install script policy, disk (`/opt/mcp` limit 2 GiB), OSV rejection | stderr tail on the installation page; `egress_events` denials; mirror health; `BASTION_NPM_REGISTRY`, `BASTION_PYPI_INDEX_URL` |
| `spawning` | The server process exits at once: bad arguments, missing env or secret (`userSecret` not set), wrong runtime | stderr tail; the installation's variables |
| `connecting` | The server does not speak MCP on stdio, prints to stdout, or is slow to start | stderr tail; try the catalog **Test** |

Checks that apply everywhere:

```sh
kubectl -n bastion-sandboxes get pods -o wide
kubectl -n bastion-sandboxes get sandboxclaims -o custom-columns=NAME:.metadata.name,READY:.status.conditions[0].status
kubectl -n bastion-sandboxes describe sandboxwarmpool bastion-runtime-small
kubectl -n bastion logs deploy/bastion-worker --tail=300 | grep -i -E 'sandbox|claim|attach'
```

Bubblewrap driver: the worker runs `bwrap --unshare-user --unshare-net true` at start; if it fails the driver is
`unavailable` with the error text in System status. Usual causes: container seccomp profile
(`deploy/docker/seccomp-bastion.json` missing), AppArmor on Ubuntu 24.04
(`kernel.apparmor_restrict_unprivileged_userns=0`), user namespaces disabled on the host.

Egress denials: a package that cannot reach a host is denied with a reason shown on the installation page; add the host
to the entry's `egress.allow` (exact, `*.suffix` or CIDR) rather than widening anything cluster-wide. Metadata service
and private ranges are always denied unless a CIDR entry allows them.

## Act

1. Fix the cause. For capacity, scale the node pool or raise `sandbox.warmPool.<size>`; a warm pool of 0 for `large`
   is the default and means large sandboxes always cold start.
2. After the fix, users click **Restart** (resets the backoff) or an admin restarts from the installation page.
3. Stuck claims: delete the `SandboxClaim` (`bst-...`) for that instance; the ui scheduler also garbage collects claims
   whose instance is gone every 5 minutes.
4. A version marked `broken` (lockfile no longer installs): re-test the catalog entry to capture a new lockfile.
5. Controller upgrade or CRD problems: Bastion needs agent-sandbox v1.0.2 or newer with extensions.

## Verify

A catalog **Test** of the entry passes; a fresh call succeeds; `bastion.sandbox.starts{outcome="ok"}` resumes.
