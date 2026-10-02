# Runbook: worker crash

## Symptoms

- Worker pods restarting (`CrashLoopBackOff`, `OOMKilled`), a node lost, or a burst of `-32014` errors and client retries.
- `kubectl -n bastion get pods -l app.kubernetes.io/component=worker` shows fewer ready pods than desired.

## Impact (21.3)

- Requests in flight on the dead worker fail; clients retry.
- Instance leases (`lease:{instanceId}`, 15 s TTL) expire within 15 s; another worker takes over on the next request and
  re-attaches to the still-running sandbox (new runner WebSocket replaces the old one).
- Legacy client sessions continue (their state is in Redis). Continuations for legacy-upstream calls owned by the
  crashed worker are lost: retries get `-32014`.
- Forwarded calls that targeted the dead worker retry once after 250 ms, re-reading the lease (the takeover path).
- Graceful shutdown (SIGTERM, rollouts, drains) is different and loses nothing: the worker marks itself draining, finishes
  in-flight work for up to 25 s (the grace period is 30 s), closes streams cleanly, deletes its leases.

## Diagnose

```sh
kubectl -n bastion describe pod <pod> | sed -n '/State:/,/Ready:/p;/Events:/,$p'
kubectl -n bastion logs <pod> --previous --tail=300
kubectl top pod -n bastion -l app.kubernetes.io/component=worker
kubectl get hpa -n bastion
```

Common causes: `OOMKilled` (memory limit 8 GiB; many owned instances or 1,000+ streams per worker, 21.1); a bad config
the loader rejects at start (it prints every error: `bastion check-config`); Redis or Postgres unreachable at start
(readiness fails, liveness does not); a node failure; a bad rollout.

## Act

1. **One pod crashing, others healthy**: nothing to do for availability. Collect `--previous` logs, then delete the pod if
   it is wedged: `kubectl -n bastion delete pod <pod>`.
2. **OOM**: raise `worker.resources.limits.memory`, or add workers (`worker.autoscaling.maxReplicas`) so streams and
   instances spread out. Check `BASTION_MAX_RUNNING_SANDBOXES` and per-user caps.
3. **Crash on start after a change**: `helm rollback bastion <revision> -n bastion` (safe to the previous release, see
   upgrades in the admin guide), then fix the values. Run `bastion check-config` with the new environment first.
4. **Node lost**: pods reschedule; topology spread keeps them across zones. `minAvailable: 1` protects against voluntary
   disruption only.

## Verify

- `kubectl -n bastion rollout status deploy/bastion-worker`; `/readyz` is green on every worker.
- Error rate returns to baseline in **Observability**; `-32014` stops.
- Sandboxes came back: **System status** leases held, a test call to a sandbox-backed installation succeeds.

## Afterwards

If clients saw `-32014` for longer than about 20 s, check Redis latency and that `workers:{id}` registrations
(5 s refresh, 15 s TTL) were not delayed. Review the chaos suite (`deploy/chaos/kill-workers.sh`) thresholds.
