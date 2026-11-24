#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo 'Usage: bash scripts/check-chromium-sandbox.sh <api-image-id> [repo-root]' >&2
  exit 2
fi
repo_root=${2:-$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}
timeout --signal=TERM --kill-after=5s 60s \
  docker run --rm --init -i --network=none --memory=512m --pids-limit=256 --cpus=1 \
  --security-opt "seccomp=$repo_root/docker/chromium-seccomp.json" \
  --workdir=/app/server --entrypoint=node "$1" - \
  < "$repo_root/scripts/tests/chromium-sandbox-smoke.cjs"
