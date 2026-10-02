# Runbooks

Operational procedures for Bastion. Each runbook follows the same shape: **symptoms**, **impact** (what the design
guarantees, tdd 21.3), **diagnose**, **act**, **verify**, **afterwards**. Commands assume the Helm release `bastion` in
namespace `bastion`; adjust names for your install. Behavior is quoted from the design; the commands were not run
against a live Bastion deployment when these were written (see `docs/admin-guide.md`, section 0).

| Runbook | Use when |
| --- | --- |
| [worker-crash](worker-crash.md) | Worker pods restart, are OOM-killed, or a node is lost |
| [redis-outage](redis-outage.md) | Redis or Valkey is unreachable; `/readyz` reports degraded; limits are local |
| [postgres-outage](postgres-outage.md) | Postgres is down; logins fail; MCP calls start returning 503 after 5 minutes |
| [kms-unreachable](kms-unreachable.md) | Secrets cannot be decrypted or written; KMS errors in logs |
| [sandbox-start-failures](sandbox-start-failures.md) | Installations in `error`, `-32016`, sandboxes Pending or crash-looping |
| [drifted-tool-definitions](drifted-tool-definitions.md) | Tools hidden or an installation blocked by drift; review items waiting |
| [mirror-diverged](mirror-diverged.md) | A plugin marketplace mirror shows `diverged` or pushes keep failing |
| [rotating-keys](rotating-keys.md) | Scheduled or emergency rotation of `as`, `state`, `upstream-client`, the KEK or the internal secret |
| [idp-down](idp-down.md) | The identity provider is unavailable or misconfigured |

## First five minutes for any incident

```sh
kubectl -n bastion get pods -o wide
kubectl -n bastion get events --sort-by=.lastTimestamp | tail -30
kubectl -n bastion logs deploy/bastion-worker --all-containers --tail=200
kubectl -n bastion exec deploy/bastion-worker -- node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>r.text()).then(console.log)"
```

`/readyz` returns per-check JSON (Postgres, Redis, migrations; on workers also the sandbox driver and the internal RPC
listener). In the UI, **Settings, System status** shows replicas, queue depths, driver and KMS checks and registry sync
history; `GET /api/v1/system/status` returns the same for Admins.

Useful signals (15.3): `bastion.limits.degraded` (1 while Redis is down), `bastion.calllog.dropped` (call-log buffer
overflow), `bastion.sandbox.starts{outcome}`, `mcp.server.operation.duration`, `bastion.limits.rejections`. Call-log
outcomes: `ok`, `tool_error`, `error`, `blocked`, `denied`, `rate_limited`, `input_required`.

Error codes clients see (6.9): `-32010` policy denied, `-32011` rate limited, `-32012` quota exceeded, `-32013` guard
blocked, `-32014` upstream unavailable, `-32015` upstream auth required, `-32016` sandbox start failed, `-32017`
upstream timeout.
