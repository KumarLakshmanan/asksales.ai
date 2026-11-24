#!/usr/bin/env bash
set -euo pipefail
umask 077

# Install a reviewed copy on the server. GitHub Actions never connects to it.
repository=KumarLakshmanan/asksales.ai
api="https://api.github.com/repos/$repository"
state=${STATE_DIRECTORY:-/var/lib/asksales-public-release}
release_script=/usr/local/lib/asksales/deploy-main-release.sh
production=/var/www/salesmarketing

fetch() {
  curl --fail --silent --show-error --max-time 20 \
    -H 'Accept: application/vnd.github+json' "$api/$1"
}

sha=$(fetch git/ref/heads/main | jq -er '.object.sha | select(test("^[0-9a-f]{40}$"))')
if [ -f "$state/deployed" ] && [ "$(cat "$state/deployed")" = "$sha" ]; then
  exit 0
fi

release=$(fetch "actions/workflows/production-release.yml/runs?branch=main&head_sha=$sha&per_page=1" |
  jq -r --arg sha "$sha" '
    first(.workflow_runs[] | select(
      .head_sha == $sha and .head_branch == "main" and .status == "completed" and
      .conclusion == "success" and (.event == "push" or .event == "workflow_dispatch")
    ) | [.id, .run_attempt] | @tsv) // empty')
if [ -z "$release" ]; then
  exit 0
fi
read -r run_id attempt <<< "$release"
[[ "$run_id" =~ ^[0-9]+$ && "$attempt" =~ ^[0-9]+$ ]]
if [ -f "$state/attempted" ] && [ "$(cat "$state/attempted")" = "$sha $run_id $attempt" ]; then
  exit 0
fi

jobs=$(fetch "actions/runs/$run_id/jobs?filter=all&per_page=100")
jq -e --arg sha "$sha" '
  [.jobs[] | select(.head_sha == $sha)]
  | group_by(.name) | map(max_by(.id))
  | map(select(.conclusion == "success") | .name)
  | . as $passed
  | ["operations / safety", "operations / Sandboxed Chromium in the API image",
     "regressions / contracts", "regressions / browser", "support / acceptance",
     "Ready for production"]
  | all(. as $job | $passed | index($job) != null)
' <<< "$jobs" > /dev/null

cutover_from=
if [ -f "$state/cutover-from" ]; then
  cutover_from=$(cat "$state/cutover-from")
fi
# A failed release needs a new successful workflow attempt. This avoids
# repeatedly touching an incomplete migration or overwriting recovery evidence.
echo "Deploying $sha from GitHub Actions run $run_id attempt $attempt."
available_kb=$(df --output=avail /var/lib/docker | tail -n 1)
if [ "$available_kb" -lt 12582912 ]; then
  echo 'The Docker filesystem needs at least 12 GiB free for the release.' >&2
  exit 1
fi
exec 9>/var/lock/asksales-release.lock
if ! flock -n 9; then
  echo 'A release is already running. The timer will check again.'
  exit 0
fi
printf '%s %s %s\n' "$sha" "$run_id" "$attempt" > "$state/attempted"
bash "$release_script" "$production" docker-compose.production.yml "$sha" - 0 "$cutover_from" inherited-lock
printf '%s\n' "$sha" > "$state/deployed"
