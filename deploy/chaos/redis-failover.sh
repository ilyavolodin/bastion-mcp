#!/usr/bin/env bash
# Chaos: Redis loss and recovery (tdd 21.3 "Redis down").
# Expected while Redis is down: modern remote calls and already-connected instances keep working; limits fall back to
# the per-worker local limiter; /readyz reports degraded; new sandbox starts and legacy sessions fail with retryable
# errors. After Redis returns, everything recovers without restarting workers.
#
# `deps.yaml` runs a single Valkey, so this script kills it (a restart, with no replica to promote). A real Sentinel or
# Cluster failover needs a Sentinel topology (for example the Bitnami valkey chart with sentinel.enabled=true): set
# REDIS_KILL_SELECTOR to its primary's pod selector and point REDIS_URL at the Sentinel URL form
# (redis-sentinel://...) before running this to exercise a promotion.
# Usage: deploy/chaos/redis-failover.sh
# shellcheck source=deploy/chaos/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
REDIS_KILL_SELECTOR="${REDIS_KILL_SELECTOR:-app=valkey}"
REDIS_NS="${REDIS_NS:-bastion}"
DOWN_SECONDS="${DOWN_SECONDS:-45}"

start_port_forward
[ "$(call_status)" = "200" ] || die "baseline call failed before the experiment"
start_traffic redis-failover 150 100
sleep 15

log "scaling Redis to zero for ${DOWN_SECONDS}s"
kubectl -n "$REDIS_NS" scale deploy -l "$REDIS_KILL_SELECTOR" --replicas=0
sleep 10
fails="$(failure_count 15)"
log "calls failed $fails of 15 probes while Redis was down (modern remote calls should keep working)"
[ "$fails" -le 2 ] || die "modern remote calls should survive a Redis outage but $fails of 15 probes failed"

pod="$(pods worker | head -n1)"
if readyz_field "$pod" | grep -qi 'degraded'; then log "/readyz reports degraded as expected"; else log "WARNING: /readyz did not mention degraded (check the readyz contract, tdd 15.7)"; fi
sleep $((DOWN_SECONDS - 25 > 0 ? DOWN_SECONDS - 25 : 1))

log "restoring Redis"
kubectl -n "$REDIS_NS" scale deploy -l "$REDIS_KILL_SELECTOR" --replicas=1
kubectl -n "$REDIS_NS" rollout status deploy -l "$REDIS_KILL_SELECTOR" --timeout=120s 2>/dev/null || sleep 20
wait_calls_ok "after Redis returned" 60 >/dev/null
sleep 10
if readyz_field "$pod" | grep -qi 'degraded'; then die "/readyz still degraded 10 s after Redis returned"; fi
wait_traffic
log "PASS redis-failover (results: $RESULTS/redis-failover.json)"
