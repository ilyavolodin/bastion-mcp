# Runbook: Postgres outage

## Symptoms

- `/readyz` fails the Postgres check; UI logins and configuration changes fail.
- Inside five minutes of the outage, MCP calls still work. **After five minutes, workers fail closed and return `503`.**
- Logs show connection errors from the database pool; `bastion.calllog.dropped` may rise once the buffer fills.

## Impact (21.3, 4.3)

- No new logins, no configuration changes, no registry sync, no scheduled jobs (the scheduler lock needs Postgres).
- Workers do not read Postgres on the hot path. When a rebuild of the effective configuration (after the 60 s cache TTL)
  fails because Postgres is unreachable, workers keep serving the **stale** effective configs and principal checks for up
  to **5 minutes after their last successful build**, then fail closed with `503`.
- The call log buffers up to 50,000 rows in memory and drops the oldest when full (`bastion.calllog.dropped`). A worker
  restart loses its buffer.
- Existing Bastion access tokens keep verifying against cached keys until the stale window closes.

## Diagnose

```sh
kubectl -n bastion logs deploy/bastion-ui --tail=100 | grep -i -E 'postgres|database|ECONN|timeout'
# From a debug pod:
kubectl -n bastion run pg-check --rm -it --image=postgres:17 --restart=Never -- psql "$DATABASE_URL" -c 'select 1'
```

Check: primary failover in progress (managed Postgres), disk full or WAL pressure, `max_connections` exhausted (each
process opens up to `BASTION_DATABASE_POOL_MAX`, 20, so 20 times the pod count: lower the pool or add a pooler),
credentials or certificate expiry, a migration holding a lock.

## Act

1. Restore the database. **The clock is five minutes**; tell stakeholders MCP calls will start failing with 503 after
   that, and that already-signed-in tools will recover once Postgres is back, without re-authentication.
2. Do **not** restart workers or the ui during the outage: a restart discards the stale configuration and the call-log
   buffer, so the worker cannot serve at all until Postgres returns.
3. Connection exhaustion: reduce `BASTION_DATABASE_POOL_MAX` or scale down temporarily, then scale up gradually.
4. If you restored from backup, confirm the KMS key is the same one that wrapped the data keys
   ([kms-unreachable](kms-unreachable.md)) and that the schema version matches the deployed chart (`bastion migrate`
   runs on `helm upgrade`; the migration Job fails closed).

## Verify

- `/readyz` green on ui and workers; a login works; a configuration change publishes and reaches workers.
- The call log shows rows again; `bastion.calllog.dropped` stops increasing. If rows were dropped, note the gap for
  auditors (audit events are written by the ui in Postgres and were unavailable during the outage).
- `GET /api/v1/audit/verify` passes (hash chain intact).

## Afterwards

A read replica (`DATABASE_REPLICA_URL`) only serves dashboards; it does not remove this dependency. Consider a managed
HA Postgres with automatic failover well under five minutes. `deploy/chaos/postgres-restart.sh` (with `PAST_STALE=1`)
exercises the fail-closed behavior.
