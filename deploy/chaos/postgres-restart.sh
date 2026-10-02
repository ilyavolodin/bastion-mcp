#!/usr/bin/env bash
# Chaos: Postgres restart (tdd 21.3 "Postgres down").
# Expected: no new logins and no config changes while it is down, but workers keep serving the stale effective
# configs and principal checks for up to 5 minutes after their last successful build, so MCP calls keep working; if
# the outage is shorter than that, nothing fails closed. With PAST_STALE=1 the script keeps Postgres down for 6
# minutes and asserts that calls then fail closed with 503, and recover once it is back.
# Usage: deploy/chaos/postgres-restart.sh            (60 s outage, calls must keep working)
#        PAST_STALE=1 deploy/chaos/postgres-restart.sh   (6 min outage, 503 after the stale window)
# shellcheck source=deploy/chaos/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PG_SELECTOR="${PG_SELECTOR:-app=postgres}"
PG_NS="${PG_NS:-bastion}"
PAST_STALE="${PAST_STALE:-0}"

start_port_forward
[ "$(call_status)" = "200" ] || die "baseline call failed before the experiment"
start_traffic postgres-restart "$([ "$PAST_STALE" = 1 ] && echo 600 || echo 150)" 100
sleep 15

log "stopping Postgres"
kubectl -n "$PG_NS" scale deploy -l "$PG_SELECTOR" --replicas=0

if [ "$PAST_STALE" = 1 ]; then
  log "waiting past the 5 minute stale window (cache TTL 60 s, then up to 5 minutes of stale serving)"
  sleep 120
  [ "$(call_status)" = "200" ] || die "calls failed inside the stale window (should still be served)"
  sleep 270
  status="$(call_status)"
  [ "$status" = "503" ] || die "after the stale window calls must fail closed with 503, got $status"
  log "fail-closed 503 observed as specified"
else
  fails="$(failure_count 45)"
  [ "$fails" -le 2 ] || die "calls failed $fails of 45 probes during a short Postgres outage (stale config should be served)"
fi

log "starting Postgres"
kubectl -n "$PG_NS" scale deploy -l "$PG_SELECTOR" --replicas=1
kubectl -n "$PG_NS" rollout status deploy -l "$PG_SELECTOR" --timeout=180s
wait_calls_ok "after Postgres returned" 120 >/dev/null
wait_traffic
log "PASS postgres-restart (results: $RESULTS/postgres-restart.json)"
log "note: deps.yaml Postgres has no persistent volume, so a restart loses data; point the chart at a PVC-backed Postgres to check data survival too"
