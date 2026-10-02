#!/usr/bin/env bash
# Upgrade test (tdd 23.1 "Upgrade", 20.2 "Upgrades"): helm upgrade from the previous release to the current chart
# with traffic running, on a kind cluster. Checks:
#   - the pre-upgrade migration Job succeeds (expand-then-contract migrations, safe with old and new pods together)
#   - the rolling update keeps serving: failed calls during the upgrade stay at or below MAX_FAILED_PERCENT
#   - mixed-version internal RPC: during the rollout old and new workers coexist (internal RPC /internal/v1 is
#     supported across one release); the script records the versions seen in `workers:{id}` via the pod image tags
#   - after the upgrade all pods run the new version and /readyz is green
#
# Usage: deploy/upgrade/test-upgrade.sh <previous-version> <new-version-or-"local">
#   previous-version  released chart/image version, installed from oci://ghcr.io/bastion-mcp/charts/bastion
#   new-version       released version, or "local" to build ./deploy/helm/bastion and the images from the checkout
#   BASTION_LOAD_TOKEN must be a PAT of the load user; the fake upstream installation "echo" must exist.
#
# STATUS: NOT RUN. It needs published release artifacts and a Bastion server image, which do not exist yet.
set -euo pipefail

PREV="${1:?previous version, for example 0.1.0}"
NEXT="${2:?new version or local}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export NS=bastion RELEASE=bastion
MAX_FAILED_PERCENT="${MAX_FAILED_PERCENT:-1}"
export BASTION_LOAD_TOKEN="${BASTION_LOAD_TOKEN:?set BASTION_LOAD_TOKEN}"
# shellcheck source=deploy/chaos/lib.sh
source "$ROOT/deploy/chaos/lib.sh"

log "installing previous release $PREV from the registry"
BASTION_IMAGE="ghcr.io/bastion-mcp/bastion:$PREV" SANDBOX_IMAGE="ghcr.io/bastion-mcp/sandbox-runtime:$PREV"   "$ROOT/deploy/kind/setup.sh" --chart-version "$PREV" --images-from-registry
wait_ready worker 300
wait_ready ui 300

start_port_forward
[ "$(call_status)" = "200" ] || die "baseline call failed on $PREV"

log "starting traffic (180 s, 100 calls/s)"
start_traffic upgrade 180 100
sleep 20

if [ "$NEXT" = "local" ]; then
  log "building images from the checkout and loading them into kind"
  docker build -f "$ROOT/deploy/docker/Dockerfile" -t bastion:upgrade "$ROOT"
  docker build -f "$ROOT/deploy/docker/Dockerfile.sandbox" -t sandbox-runtime:upgrade "$ROOT"
  kind load docker-image bastion:upgrade sandbox-runtime:upgrade --name "${CLUSTER:-bastion}"
  CHART="$ROOT/deploy/helm/bastion"; IMAGE_ARGS=(--set image.repository=bastion --set image.tag=upgrade --set sandbox.image.repository=sandbox-runtime --set sandbox.image.tag=upgrade)
else
  CHART="oci://ghcr.io/bastion-mcp/charts/bastion --version $NEXT"; IMAGE_ARGS=(--set image.tag="$NEXT" --set sandbox.image.tag="$NEXT")
fi

log "helm upgrade to $NEXT (pre-upgrade hook runs bastion migrate)"
# shellcheck disable=SC2086
helm upgrade bastion $CHART --namespace "$NS" --reuse-values "${IMAGE_ARGS[@]}" --wait --timeout 10m &
UPGRADE_PID=$!

seen_versions=""
while kill -0 "$UPGRADE_PID" 2>/dev/null; do
  seen_versions="$seen_versions
$(kubectl -n "$NS" get pods -l app.kubernetes.io/component=worker -o jsonpath='{range .items[*]}{.spec.containers[0].image}{"\n"}{end}')"
  sleep 3
done
wait "$UPGRADE_PID" || die "helm upgrade failed"

distinct="$(printf '%s\n' "$seen_versions" | sort -u | grep -c . || true)"
log "worker images observed during the rollout: $distinct distinct (2 or more means old and new ran side by side)"

job_status="$(kubectl -n "$NS" get jobs -l app.kubernetes.io/component=migrate -o jsonpath='{.items[*].status.succeeded}' 2>/dev/null || true)"
log "migration job succeeded count (hook jobs are deleted on success, so empty is normal): '${job_status}'"

wait_traffic
wait_ready worker 300
wait_ready ui 300
[ "$(call_status)" = "200" ] || die "calls fail after the upgrade"
for pod in $(pods worker); do
  readyz_field "$pod" | grep -qi '"ok"\|ready' || die "/readyz not green on $pod after upgrade"
done

# Failed-call budget from the generator result.
failed="$(node -e "
const r=require('$RESULTS/upgrade.json');const v=r.series.via||{count:0,errors:0};
const total=v.count+v.errors;console.log(total?(100*v.errors/total).toFixed(3):'100');")"
log "failed calls during the upgrade: ${failed}% (budget ${MAX_FAILED_PERCENT}%)"
awk "BEGIN{exit !($failed <= $MAX_FAILED_PERCENT)}" || die "too many failed calls during the rolling upgrade"
log "PASS upgrade $PREV -> $NEXT"
