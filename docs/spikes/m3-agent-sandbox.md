# Spike: agent-sandbox v1.0.2 surfaces for M3 (tdd.md 24.2 d)

Source: the v1.0.2 CRD manifests (`k8s/crds/*.yaml`), `docs/api.md` and `docs/api-migration-guide.md` of
`kubernetes-sigs/agent-sandbox`, read on 2026-10-01. **Runtime confirmation against a live cluster (kind with
the controller, runc, then gVisor) is pending**: nothing below was executed against a cluster, and the Kubernetes
driver is unit tested only through the injected `KubeApi` port.

## Confirmed from the CRDs

- Only `v1beta1` exists since v1.0.0 (`v1alpha1` was removed). Groups: `agents.x-k8s.io` (`Sandbox`) and
  `extensions.agents.x-k8s.io` (`SandboxClaim`, `SandboxTemplate`, `SandboxWarmPool`). Matches 8.4.
- `SandboxClaim.spec`: `warmPoolRef.name` (the only required field), `lifecycle.{shutdownPolicy (Delete |
  DeleteForeground | Retain, default Retain), shutdownTime, ttlSecondsAfterFinished}`, `volumeClaimTemplates[]`
  (`metadata`, `spec` with `accessModes`, `resources.requests`, `storageClassName`, ...), `env`,
  `additionalPodMetadata`.
- `SandboxClaim.status`: `conditions[]` (the `Ready` condition), `sandbox.{name, podIPs[], serviceFQDN}`. So the
  driver watches the claim until `status.sandbox.podIPs[0]` or `serviceFQDN` is set (`runnerAddressOf`).
- `Sandbox.spec.operatingMode` is `Running` (default) or `Suspended`; suspension deletes the pod and keeps the
  Sandbox and its volumes; `status.podIPs` is cleared while suspended, which is why a resume waits for the claim
  status to repopulate and then binds the (new) runner again.
- `volumeClaimTemplates` on a claim "forces a cold start because warm pool pods will not have these volumes"
  (docs/api.md), consistent with the `-pvc` pools at `replicas: 0`.

## Assumptions to verify at runtime (pending)

1. **Warm pool names.** The driver uses `bastion-runtime-<size>` and `bastion-runtime-<size>-pvc` as
   `warmPoolRef.name` (`warmPoolName`, overridable through the `poolName` option). The Helm chart must create pools
   with those names.
2. **PVC naming and labels.** The names of PVCs created from `volumeClaimTemplates` are not documented. The driver
   puts the Bastion labels on `volumeClaimTemplates[].metadata.labels` and deletes PVCs by the installation label
   selector. Needs confirmation that the controller copies template labels to the PVC.
3. **Label propagation to `Sandbox`.** GC lists claims and sandboxes by the `bastion-mcp.github.io/instance` label;
   claim labels may not propagate to the `Sandbox` (see KEP 174, metadata propagation). Deleting the claim with
   `shutdownPolicy: Delete` is expected to remove the Sandbox; the driver also deletes the bound Sandbox by name.
4. **Persistent claims and `shutdownPolicy`.** Persistent claims omit `lifecycle`, so the default `Retain` applies;
   uninstall deletes claim, Sandbox and PVCs explicitly.
5. **Claim name uniqueness.** The specified `bst-<first 12 hex of instanceId>` collides for UUIDv7 ids created in the
   same millisecond (the first 12 hex digits are the timestamp). Resolved: names use the LAST 12 hex digits (the
   random tail); see ADR 0001, section 6.
6. **Warm-pool claims and NetworkPolicy.** That the template NetworkPolicy applies to claimed pods (and to
   resumed pods of persistent claims) is taken from the design, not verified.
7. **gVisor.** The runner needs `0.0.0.0:8080` reachable from worker pods under `runsc`; to be checked in the
   nightly gVisor run.

## Driver behavior implemented against these surfaces

Create claim (labels, `shutdownPolicy: Delete`, `shutdownTime` now + 24 h, refreshed hourly with a merge patch) ->
watch for address -> poll `/healthz` -> `POST /v1/bind` with a random token -> manager calls `/v1/start`.
Suspend/resume patch `Sandbox.spec.operatingMode` with `application/merge-patch+json`. GC is the pure function
`decideClaimGc`: delete when the instance is unknown or its lease expired more than 10 minutes ago.
