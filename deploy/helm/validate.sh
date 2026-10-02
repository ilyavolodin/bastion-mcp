#!/usr/bin/env bash
# Validates the Helm chart (tdd 20.2, 8.4). No Vitest. Run from anywhere:
#   deploy/helm/validate.sh
#
# Steps, per values scenario in deploy/helm/ci/*.yaml (split, all, httproute, no-sandbox, otel-gke):
#   1. helm lint (with the scenario values)
#   2. helm template, then structural assertions (assert-rendered.mjs: ports, probes, RBAC verbs, SandboxTemplate
#      pod spec and NetworkPolicy, ingress annotations, PDBs, HPA, migration hook, collector...)
#   3. kubeconform -strict on the manifests, with the agent-sandbox v1.0.2 CRDs converted to JSON Schema
#      (crd-to-jsonschema.mjs) so SandboxTemplate and SandboxWarmPool are validated too, not skipped
#   4. negative checks: the chart must refuse to render without publicUrl or existingSecret
#
# Tools: uses a local `helm` and `kubeconform` when installed, else falls back to the docker images
# alpine/helm and ghcr.io/yannh/kubeconform. Needs node (>=20) and `pnpm install` (for the `yaml` package), curl for
# the CRD download (cached in deploy/helm/.cache), and network access for kubeconform's core Kubernetes schemas.
# Set SKIP_KUBECONFORM=1 to skip step 3, KUBE_VERSION to change the schema version (default 1.32.0).
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CACHE="$HERE/.cache"
AGENT_SANDBOX_VERSION="${AGENT_SANDBOX_VERSION:-v1.0.2}"
KUBE_VERSION="${KUBE_VERSION:-1.32.0}"
HELM_IMAGE="${HELM_IMAGE:-alpine/helm:3.19.0}"
KUBECONFORM_IMAGE="${KUBECONFORM_IMAGE:-ghcr.io/yannh/kubeconform:latest}"

# Path usable inside docker on Git Bash (C:/...) and plain POSIX hosts.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else echo "$1"; fi; }
HELM_MOUNT="$(winpath "$HERE")"

helm_run() {
  if command -v helm >/dev/null 2>&1; then
    (cd "$HERE" && helm "$@")
  else
    MSYS_NO_PATHCONV=1 docker run --rm -v "$HELM_MOUNT:/w" -w /w "$HELM_IMAGE" "$@"
  fi
}

if command -v kubeconform >/dev/null 2>&1; then SCHEMA_DIR="$CACHE/schemas"; else SCHEMA_DIR=/cache/schemas; fi
kubeconform_run() {
  if command -v kubeconform >/dev/null 2>&1; then
    kubeconform "$@"
  else
    MSYS_NO_PATHCONV=1 docker run --rm -i -v "$(winpath "$CACHE"):/cache" "$KUBECONFORM_IMAGE" "$@"
  fi
}

step() { printf '\n==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

mkdir -p "$CACHE/crds" "$CACHE/schemas"

# ---- CRDs -----------------------------------------------------------------------------------------------------
if [ "${SKIP_KUBECONFORM:-0}" != "1" ]; then
  step "agent-sandbox $AGENT_SANDBOX_VERSION CRDs"
  for f in extensions.agents.x-k8s.io_sandboxtemplates.yaml extensions.agents.x-k8s.io_sandboxwarmpools.yaml \
           extensions.agents.x-k8s.io_sandboxclaims.yaml agents.x-k8s.io_sandboxes.yaml; do
    if [ ! -s "$CACHE/crds/$f" ]; then
      curl -fsSL --retry 3 -o "$CACHE/crds/$f" \
        "https://raw.githubusercontent.com/kubernetes-sigs/agent-sandbox/$AGENT_SANDBOX_VERSION/k8s/crds/$f"
    fi
  done
  node "$HERE/crd-to-jsonschema.mjs" "$CACHE/schemas" "$CACHE"/crds/*.yaml
  # Kinds without a published schema (GKE BackendConfig, Gateway API) are skipped explicitly, never silently.
fi

scenarios=(split all httproute no-sandbox otel-gke)
for s in "${scenarios[@]}"; do
  values="ci/$s.yaml"
  step "[$s] helm lint"
  helm_run lint bastion -f "$values"
  step "[$s] helm template + assertions"
  helm_run template r bastion --namespace default -f "$values" > "$CACHE/$s.rendered.yaml"
  node "$HERE/assert-rendered.mjs" "$s" < "$CACHE/$s.rendered.yaml"
  if [ "${SKIP_KUBECONFORM:-0}" != "1" ]; then
    step "[$s] kubeconform -strict"
    kubeconform_run -strict -summary -kubernetes-version "$KUBE_VERSION" \
      -schema-location default \
      -schema-location "$SCHEMA_DIR/{{ .ResourceKind }}_{{ .Group }}_{{ .ResourceAPIVersion }}.json" \
      -skip BackendConfig,HTTPRoute \
      - < "$CACHE/$s.rendered.yaml"
  fi
done

# ---- negative checks ---------------------------------------------------------------------------------------------
step "chart refuses to render without required values"
if helm_run template r bastion --set existingSecret=s >/dev/null 2>&1; then fail "rendered without publicUrl"; fi
if helm_run template r bastion --set publicUrl=https://mcp.example.com >/dev/null 2>&1; then fail "rendered without existingSecret"; fi
if helm_run template r bastion -f ci/split.yaml --set deploymentMode=bogus >/dev/null 2>&1; then fail "schema accepted deploymentMode=bogus"; fi
echo "ok"

step "all scenarios passed"
