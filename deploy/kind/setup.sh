#!/usr/bin/env bash
# Brings up a kind cluster with everything the sandbox, chaos, load and upgrade suites need (tdd 23.1):
#   kind cluster (3 fake zones) -> agent-sandbox controller v1.0.2 -> RuntimeClass -> Postgres + Valkey -> images ->
#   Helm chart in namespace "bastion", release "bastion".
#
#   deploy/kind/setup.sh [--gvisor] [--skip-chart] [--chart-version X] [--images-from-registry]
#
# Environment: CLUSTER (default bastion), BASTION_IMAGE / SANDBOX_IMAGE (default bastion:ci / sandbox-runtime:ci,
# built from the Dockerfiles and loaded into kind unless --images-from-registry), HELM_EXTRA_ARGS (extra helm args),
# AGENT_SANDBOX_VERSION (default v1.0.2).
#
# STATUS: written against the documented behavior of kind, helm and agent-sandbox; it has NOT been run (no Linux
# kind host in the authoring environment, and apps/server does not exist yet, so the image cannot be built).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CLUSTER="${CLUSTER:-bastion}"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v1.0.2}"
BASTION_IMAGE="${BASTION_IMAGE:-bastion:ci}"
SANDBOX_IMAGE="${SANDBOX_IMAGE:-sandbox-runtime:ci}"
GVISOR=0; SKIP_CHART=0; FROM_REGISTRY=0; CHART_VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --gvisor) GVISOR=1 ;;
    --skip-chart) SKIP_CHART=1 ;;
    --images-from-registry) FROM_REGISTRY=1 ;;
    --chart-version) CHART_VERSION="$2"; shift ;;
    *) echo "unknown argument $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '\n==> %s\n' "$*"; }

log "kind cluster $CLUSTER"
if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --name "$CLUSTER" --config "$HERE/kind-config.yaml" --wait 120s
fi
kubectl config use-context "kind-$CLUSTER"

if [ "$GVISOR" = 1 ]; then
  log "installing gVisor (runsc) into every kind node"
  arch="$(uname -m)"; base="https://storage.googleapis.com/gvisor/releases/release/latest/$arch"
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/runsc" "$base/runsc"
  curl -fsSL -o "$tmp/containerd-shim-runsc-v1" "$base/containerd-shim-runsc-v1"
  chmod +x "$tmp/runsc" "$tmp/containerd-shim-runsc-v1"
  for node in $(kind get nodes --name "$CLUSTER"); do
    docker cp "$tmp/runsc" "$node:/usr/local/bin/runsc"
    docker cp "$tmp/containerd-shim-runsc-v1" "$node:/usr/local/bin/containerd-shim-runsc-v1"
    version="$(docker exec "$node" sed -n 's/^version = \([0-9]*\)/\1/p' /etc/containerd/config.toml | head -n1)"
    if [ "${version:-2}" -ge 3 ]; then table="plugins.'io.containerd.cri.v1.runtime'.containerd.runtimes.runsc"
    else table="plugins.\"io.containerd.grpc.v1.cri\".containerd.runtimes.runsc"; fi
    docker exec "$node" sh -c "grep -q runtimes.runsc /etc/containerd/config.toml || printf '\n[$table]\n  runtime_type = \"io.containerd.runsc.v1\"\n' >> /etc/containerd/config.toml"
    docker exec "$node" systemctl restart containerd
  done
  rm -rf "$tmp"
  RUNTIME_CLASS=gvisor
  kubectl apply -f - <<'EOF'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata: { name: gvisor }
handler: runsc
EOF
else
  # runc stands in for gVisor in the per-push sandbox suite (23.1: "kind cluster with agent-sandbox (runc)").
  RUNTIME_CLASS=runc-test
  kubectl apply -f - <<'EOF'
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata: { name: runc-test }
handler: runc
EOF
fi

log "agent-sandbox $AGENT_SANDBOX_VERSION controller and extensions"
kubectl apply -f "https://github.com/kubernetes-sigs/agent-sandbox/releases/download/$AGENT_SANDBOX_VERSION/sandbox-with-extensions.yaml"
for crd in sandboxtemplates sandboxwarmpools sandboxclaims; do
  kubectl wait --for=condition=Established "crd/$crd.extensions.agents.x-k8s.io" --timeout=60s
done
kubectl wait --for=condition=Established crd/sandboxes.agents.x-k8s.io --timeout=60s

log "Postgres and Valkey"
kubectl apply -f "$HERE/deps.yaml"
kubectl -n bastion rollout status deploy/postgres --timeout=180s
kubectl -n bastion rollout status deploy/valkey --timeout=180s
if ! kubectl -n bastion get secret bastion-kek >/dev/null 2>&1; then
  kek="$(mktemp)"
  head -c 32 /dev/urandom > "$kek"
  kubectl -n bastion create secret generic bastion-kek --from-file=kek="$kek"
  rm -f "$kek"
fi

[ "$SKIP_CHART" = 1 ] && { log "skipping chart"; exit 0; }

if [ "$FROM_REGISTRY" = 0 ]; then
  log "building images and loading them into kind"
  docker build -f "$ROOT/deploy/docker/Dockerfile" -t "$BASTION_IMAGE" "$ROOT"
  docker build -f "$ROOT/deploy/docker/Dockerfile.sandbox" -t "$SANDBOX_IMAGE" "$ROOT"
  kind load docker-image "$BASTION_IMAGE" "$SANDBOX_IMAGE" --name "$CLUSTER"
fi

log "helm install"
chart_args=("$ROOT/deploy/helm/bastion")
[ -n "$CHART_VERSION" ] && chart_args=(--version "$CHART_VERSION" "oci://ghcr.io/bastion-mcp/charts/bastion")
image_repo="${BASTION_IMAGE%%:*}"; image_tag="${BASTION_IMAGE##*:}"
sandbox_repo="${SANDBOX_IMAGE%%:*}"; sandbox_tag="${SANDBOX_IMAGE##*:}"
# shellcheck disable=SC2086
helm upgrade --install bastion "${chart_args[@]}" --namespace bastion --wait --timeout 10m \
  --set publicUrl=http://bastion-worker.bastion.svc:8080 \
  --set existingSecret=bastion-secrets \
  --set kms.localKeySecret=bastion-kek \
  --set bootstrapAdminEmail=admin@example.com \
  --set image.repository="$image_repo" --set image.tag="$image_tag" --set image.pullPolicy=IfNotPresent \
  --set sandbox.image.repository="$sandbox_repo" --set sandbox.image.tag="$sandbox_tag" \
  --set sandbox.runtimeClassName="$RUNTIME_CLASS" \
  --set ingress.enabled=false \
  --set worker.autoscaling.enabled=false --set worker.replicas=3 \
  ${HELM_EXTRA_ARGS:-}
kubectl -n bastion get pods
