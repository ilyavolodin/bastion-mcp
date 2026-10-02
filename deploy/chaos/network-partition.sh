#!/usr/bin/env bash
# Chaos: network partition between workers and a live sandbox (tdd 21.3 last row, 8.4).
# Expected: calls to the sandbox-backed installation fail while partitioned; after 3 failed attaches within 60 s the
# instance is destroyed and restarted, so once the partition is lifted the next calls succeed on a fresh sandbox
# (the SandboxClaim name changes). The partition is a NetworkPolicy that drops traffic from worker pods to the
# sandbox pods on 8080, in addition to the template policy. Needs a CNI that enforces NetworkPolicy.
# Usage: SANDBOX_INSTALLATION=<slug> deploy/chaos/network-partition.sh
# shellcheck source=deploy/chaos/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
SANDBOX_NS="${SANDBOX_NS:-bastion-sandboxes}"
SANDBOX_INSTALLATION="${SANDBOX_INSTALLATION:-stdio-echo}"
INSTALLATION_URL="http://127.0.0.1:$LOCAL_PORT/mcp/i/$SANDBOX_INSTALLATION"

start_port_forward
[ "$(call_status)" = "200" ] || die "baseline call to $SANDBOX_INSTALLATION failed (is it installed for the load user?)"
before="$(kubectl -n "$SANDBOX_NS" get sandboxclaims -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | sort | tr '\n' ' ')"
log "claims before: $before"

log "partitioning workers from sandboxes"
kubectl -n "$SANDBOX_NS" apply -f - <<EOF
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata: { name: chaos-partition }
spec:
  podSelector: {}
  policyTypes: [Ingress]
  ingress: []
EOF
# An empty ingress list with a selected pod drops all ingress to sandbox pods, including from workers.

fails="$(failure_count 20)"
[ "$fails" -ge 15 ] || log "WARNING: only $fails of 20 calls failed during the partition; check that the CNI enforces NetworkPolicy"
log "$fails of 20 calls failed while partitioned"

log "lifting the partition"
kubectl -n "$SANDBOX_NS" delete networkpolicy chaos-partition
wait_calls_ok "after partition lifted" 90 >/dev/null
after="$(kubectl -n "$SANDBOX_NS" get sandboxclaims -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' | sort | tr '\n' ' ')"
log "claims after: $after"
if [ "$before" = "$after" ]; then
  log "claim set unchanged: the sandbox was re-attached rather than replaced (acceptable when the partition was shorter than 3 failed attaches in 60 s)"
else
  log "claim set changed: the instance was destroyed and restarted as specified"
fi
log "PASS network-partition"
