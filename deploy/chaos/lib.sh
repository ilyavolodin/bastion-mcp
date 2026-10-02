#!/usr/bin/env bash
# Shared helpers for the chaos scripts (tdd 23.1: kill workers mid-call, Redis failover, Postgres restart, network
# partition between worker and sandbox). Sourced, not executed.
#
# Preconditions: `deploy/kind/setup.sh` has created the cluster and installed the chart in namespace "bastion"
# (release "bastion"), kubectl points at it, `pnpm install --ignore-workspace` was run in packages/testkit/load, and a
# fake upstream that exposes an `echo` tool is installed as installation "echo" for the load user.
#
# STATUS: these scripts have NOT been run end to end (no Bastion server image exists yet). They encode the expected
# behavior from tdd 21.2 and 21.3; adjust thresholds only with a recorded reason.
set -euo pipefail

CHAOS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$CHAOS_DIR/../.." && pwd)"
NS="${NS:-bastion}"
RELEASE="${RELEASE:-bastion}"
WORKER_SVC="${WORKER_SVC:-$RELEASE-worker}"
LOCAL_PORT="${LOCAL_PORT:-18080}"
RESULTS="${RESULTS:-$ROOT/packages/testkit/load/results/chaos}"
BASTION_LOAD_TOKEN="${BASTION_LOAD_TOKEN:?set BASTION_LOAD_TOKEN to a PAT of the load user}"
INSTALLATION_URL="${INSTALLATION_URL:-http://127.0.0.1:$LOCAL_PORT/mcp/i/echo}"
mkdir -p "$RESULTS"

log() { printf '[%s] %s\n' "$(date -u +%H:%M:%S)" "$*"; }
die() { printf 'CHAOS FAIL: %s\n' "$*" >&2; exit 1; }

PF_PID=""
start_port_forward() {
  kubectl -n "$NS" port-forward "svc/$WORKER_SVC" "$LOCAL_PORT:8080" >/dev/null 2>&1 &
  PF_PID=$!
  for _ in $(seq 1 30); do curl -fsS "http://127.0.0.1:$LOCAL_PORT/healthz" >/dev/null 2>&1 && return 0; sleep 1; done
  die "cannot reach $WORKER_SVC through port-forward"
}
stop_port_forward() { [ -n "$PF_PID" ] && kill "$PF_PID" 2>/dev/null || true; }
trap stop_port_forward EXIT

# Pods of a component, one per line.
pods() { kubectl -n "$NS" get pods -l "app.kubernetes.io/instance=$RELEASE,app.kubernetes.io/component=$1" -o name; }

wait_ready() { # component, timeout seconds
  kubectl -n "$NS" rollout status "deploy/$RELEASE-$1" --timeout="${2:-180}s"
}

# One MCP tool call, JSON-RPC over HTTP, returns the HTTP status. Era-agnostic enough for a liveness probe: a modern
# server answers tools/call without a session; legacy clients are exercised by the load generator.
call_status() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X POST "$INSTALLATION_URL" \
    -H "Authorization: Bearer $BASTION_LOAD_TOKEN" -H 'Content-Type: application/json' \
    -H 'Accept: application/json, text/event-stream' \
    -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"echo","arguments":{"text":"chaos"}}}' || true
}

# Background steady tools/call traffic through the SDK-based generator (traffic-only: --skip-baseline); writes
# $RESULTS/<name>.json when it ends. The `check` command deliberately does not certify these runs.
TRAFFIC_PID=""
start_traffic() { # name, duration seconds, rate
  local name="$1" duration="$2" rate="${3:-100}"
  (cd "$ROOT/packages/testkit/load" && pnpm exec tsx src/cli.ts run --scenario call-guards-off --skip-baseline      --url "$INSTALLATION_URL" --duration "$duration" --rate "$rate"      --out "$RESULTS/$name.json" --connections 8) >"$RESULTS/$name.log" 2>&1 &
  TRAFFIC_PID=$!
}
wait_traffic() { wait "$TRAFFIC_PID" || log "traffic generator exited non-zero (see $RESULTS)"; }

# Polls call_status until it returns 200; prints the seconds taken; fails after $2 seconds.
wait_calls_ok() { # label, max seconds
  local start now
  start=$(date +%s)
  while :; do
    [ "$(call_status)" = "200" ] && { now=$(date +%s); log "$1: calls succeed again after $((now - start)) s"; echo $((now - start)); return 0; }
    now=$(date +%s)
    [ $((now - start)) -ge "$2" ] && die "$1: calls still failing after $2 s"
    sleep 1
  done
}

# Fraction of failed calls over N probes spaced one second apart.
failure_count() { # probes
  local fails=0
  for _ in $(seq 1 "$1"); do [ "$(call_status)" = "200" ] || fails=$((fails + 1)); sleep 1; done
  echo "$fails"
}

readyz_field() { # pod, jq-free grep of a check name in /readyz output
  kubectl -n "$NS" exec "$1" -- node -e "fetch('http://127.0.0.1:8080/readyz').then(r=>r.text()).then(t=>console.log(t))" 2>/dev/null || true
}
