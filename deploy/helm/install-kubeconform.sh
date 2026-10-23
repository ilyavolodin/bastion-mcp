#!/usr/bin/env bash
# Installs a pinned kubeconform into /usr/local/bin after verifying the release tarball's SHA-256 (linux amd64).
# Bump KUBECONFORM_VERSION and KUBECONFORM_SHA256 together (the release publishes a CHECKSUMS file).
set -euo pipefail

KUBECONFORM_VERSION="v0.8.0"
KUBECONFORM_SHA256="9bc2bffbf71f261128533edaf912153948b7ff238f9a531ae6d34466ec287883"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
curl -fsSL -o "$tmp/kubeconform.tar.gz" \
  "https://github.com/yannh/kubeconform/releases/download/${KUBECONFORM_VERSION}/kubeconform-linux-amd64.tar.gz"
echo "${KUBECONFORM_SHA256}  $tmp/kubeconform.tar.gz" | sha256sum --check --strict
sudo tar -xz -C /usr/local/bin -f "$tmp/kubeconform.tar.gz" kubeconform
kubeconform -v
