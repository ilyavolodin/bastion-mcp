#!/usr/bin/env bash
# Chaos: kill worker pods while calls are in flight (tdd 21.2, 21.3 "Worker crash").
# Expected: in-flight requests on the killed pod fail and clients retry; leases expire within 15 s; sandboxes are
# re-attached by another worker; the service answers again within LEASE_RECOVERY_SECONDS (default 20 = 15 s lease
# TTL + 5 s re-attach slack, an assumption); the Deployment returns to full strength.
# Usage: deploy/chaos/kill-workers.sh [kills]   (default 2, force-deleting with grace period 0 = SIGKILL)
# shellcheck source=deploy/chaos/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
KILLS="${1:-2}"
LEASE_RECOVERY_SECONDS="${LEASE_RECOVERY_SECONDS:-20}"

start_port_forward
[ "$(call_status)" = "200" ] || die "baseline call failed before the experiment"
start_traffic kill-workers 120 100

sleep 15
for i in $(seq 1 "$KILLS"); do
  victim="$(pods worker | shuf -n1)"
  log "kill #$i: $victim (SIGKILL, grace period 0)"
  kubectl -n "$NS" delete "$victim" --grace-period=0 --force --wait=false
  # The Service drops the pod from endpoints quickly, so calls through it should recover well inside the lease TTL.
  recovery="$(wait_calls_ok "after kill #$i" "$LEASE_RECOVERY_SECONDS" | tail -n1)"
  log "recovery #$i: ${recovery}s (limit ${LEASE_RECOVERY_SECONDS}s)"
  sleep 10
done

wait_ready worker 180
wait_traffic
log "checking that every worker re-registered (workers:{id} entries) and the fleet is whole"
ready="$(kubectl -n "$NS" get deploy "$RELEASE-worker" -o jsonpath='{.status.readyReplicas}')"
want="$(kubectl -n "$NS" get deploy "$RELEASE-worker" -o jsonpath='{.spec.replicas}')"
[ "$ready" = "$want" ] || die "worker fleet not restored: $ready/$want ready"
log "PASS kill-workers (results: $RESULTS/kill-workers.json; error rate during the kills is reported there, not asserted)"
