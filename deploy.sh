#!/bin/bash
# Production deployment script for asksales.ai
# Run from local machine: ./deploy.sh
# Requires ASKSALES_PROD_HOST and a known SSH host key.
# Infrastructure: Docker Compose (replaces PM2)

set -euo pipefail

SSH_KEY="${ASKSALES_PROD_SSH_KEY:-$HOME/.ssh/id_rsa}"
PROD_DIR="/var/www/salesmarketing"
COMPOSE_FILE="docker-compose.production.yml"

ssh_script() {
  ssh \
    -o StrictHostKeyChecking=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=8 \
    -i "$SSH_KEY" \
    "$PROD_HOST" bash -s -- "$@"
}

scp_to_prod() {
  scp \
    -o StrictHostKeyChecking=yes \
    -o ServerAliveInterval=15 \
    -o ServerAliveCountMax=8 \
    -i "$SSH_KEY" \
    "$1" "$PROD_HOST:$2"
}

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"
release_sha=$(git rev-parse HEAD)
prebuilt_images=${RELEASE_PREBUILT_IMAGES:-0}
[[ "$prebuilt_images" = 0 || "$prebuilt_images" = 1 ]] || { echo 'RELEASE_PREBUILT_IMAGES must be 0 or 1.' >&2; exit 1; }
if [ -n "$(git status --porcelain)" ]; then
  echo 'Refusing release from a dirty checkout; commit and verify the intended artifact first.' >&2
  exit 1
fi
if [ "${RELEASE_VERIFIED_SHA:-}" != "$release_sha" ]; then
  echo 'Set RELEASE_VERIFIED_SHA to the exact commit after required CI checks pass.' >&2
  exit 1
fi
release_branch=$(git symbolic-ref --quiet --short HEAD || true)
if [ "$release_branch" != main ]; then
  echo 'Production deployment requires the main branch.' >&2
  exit 1
fi
PROD_HOST="${ASKSALES_PROD_HOST:?Set the production SSH target privately}"
bundle_dir=$(mktemp -d /tmp/asksales-deploy.XXXXXX)
bundle_file="$bundle_dir/release.bundle"
trap 'rm -f "$bundle_file"; rmdir "$bundle_dir"' EXIT
git bundle create "$bundle_file" HEAD >/dev/null
remote_bundle="/tmp/asksales-release-$release_sha.bundle"
git push origin "$release_sha:refs/heads/main"
scp_to_prod "$bundle_file" "$remote_bundle"
ssh_script "$PROD_DIR" "$COMPOSE_FILE" "$release_sha" "$remote_bundle" "$prebuilt_images" < "$repo_root/scripts/deploy-production-release.sh"
