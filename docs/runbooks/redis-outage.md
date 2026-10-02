# Runbook: Redis (Valkey) outage

## Symptoms

- `/readyz` reports a degraded or failed Redis check; the metric `bastion.limits.degraded` is 1 and the UI shows a
  health warning.
- New sandbox starts and legacy-era client sessions fail with retryable errors.
- Users may see rate limits behave differently (stricter or looser than usual).

## Impact (21.3, 14.2)

Redis holds sessions, leases, limits, caches and pub/sub for config invalidation.

| Area | Behavior while Redis is down |
| --- | --- |
| Modern-era remote calls | Keep working. |
| Instances already connected on a worker | Keep serving. |
| New sandbox starts, legacy sessions | Fail with retryable errors. |
| Limits | **Fail open to a per-worker in-memory limiter** at `1/BASTION_EXPECTED_WORKERS` of each rule. With uneven load across workers some users are limited harder, others can exceed the org-wide intent. Quotas are not enforced exactly. |
| Config changes | Workers do not get `bastion:config` messages; the 60 s cache TTL bounds staleness. |
| Browser sessions (`uisess:*`) | Users in the UI may be signed out. |
| Egress proxy validation | New instances cannot register their egress tokens (`egress:{instanceId}`); running sandboxes may fail proxy auth on workers that cannot read Redis. |

## Diagnose

```sh
kubectl -n bastion exec deploy/bastion-worker -- node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>r.text()).then(console.log)"
kubectl -n bastion get secret bastion-secrets -o jsonpath='{.data.REDIS_URL}' | base64 -d | sed 's#//[^@]*@#//***@#'
# From a debug pod in the namespace:
kubectl -n bastion run redis-check --rm -it --image=valkey/valkey:8 --restart=Never -- valkey-cli -u "$REDIS_URL" ping
```

Check: the managed service status page, Sentinel or Cluster state (a failover in progress is expected to recover in
seconds), memory pressure and evictions (`maxmemory-policy` must not evict keys such as leases: use `noeviction` or
`volatile-*`), a NetworkPolicy or security-group change, an expired TLS certificate or password.

## Act

1. Restore Redis (failover, restart, scale up memory, fix credentials). Workers reconnect on their own; you do **not**
   need to restart them.
2. If the outage will last more than a few minutes and you need hard limits, scale **down** workers or lower the
   relevant rules so the local `1/BASTION_EXPECTED_WORKERS` split matches reality. Keeping `BASTION_EXPECTED_WORKERS`
   near the real worker count (the chart derives it from your replica settings) matters here.
3. If the data was lost (a restart without persistence): expect everyone to sign in again to the UI; sandboxes
   re-attach on the next request; legacy-era clients re-initialize; quota counters restart from zero for the period.
4. Avoid `FLUSHALL`. If you must clear Redis, do it during low traffic and expect the same effects as data loss.

## Verify

- `/readyz` is green and `bastion.limits.degraded` is back to 0.
- A new sandbox start succeeds; a legacy-era client can initialize; a config change in the UI reaches a worker within
  seconds (pub/sub restored).
- No sustained growth of `bastion.limits.rejections` from the fallback limiter.

## Afterwards

Consider Sentinel or Cluster if this was a single node (the sizing guide recommends HA Redis above 200 users). Review
`deploy/chaos/redis-failover.sh`, which exercises this outage.
