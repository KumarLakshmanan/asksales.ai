#!/usr/bin/env bash
set -euo pipefail
prod_dir="$1"
compose_file="$2"
release_sha="$3"
bundle_file="$4"
prebuilt_images="${5:-0}"
cutover_from="${6:-}"
[[ "$release_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$prebuilt_images" = 0 || "$prebuilt_images" = 1 ]]
[[ -z "$cutover_from" || "$cutover_from" =~ ^[0-9a-f]{40}$ ]]
# One SSH process holds this lock from before checkout until all verification ends.
# Staging takes the same host lock because both environments share build resources.
if [ "${7:-}" != inherited-lock ]; then
  exec 9>/var/lock/asksales-release.lock
fi
flock -n 9 || { echo 'Another release owns the host lock.' >&2; exit 1; }
cleanup_bundle() {
  [ "$bundle_file" = - ] || rm -f -- "$bundle_file"
}
trap cleanup_bundle EXIT
cd "$prod_dir"
if [ -n "$(git status --porcelain)" ]; then
  echo 'Remote checkout is dirty; preserving changes and refusing release.' >&2
  exit 1
fi
previous_sha=$(git rev-parse HEAD)
if [ "$bundle_file" = - ]; then
  git fetch --no-tags https://github.com/KumarLakshmanan/asksales.ai.git refs/heads/main
else
  git fetch "$bundle_file" HEAD
fi
[ "$(git rev-parse FETCH_HEAD)" = "$release_sha" ] || { echo 'Bundle SHA mismatch.' >&2; exit 1; }
if git merge-base --is-ancestor "$previous_sha" "$release_sha"; then
  if git show-ref --verify --quiet refs/heads/main; then
    git merge-base --is-ancestor main "$release_sha" || { echo 'Production main has divergent history.' >&2; exit 1; }
    git switch main
  else
    git switch --no-track -c main
  fi
  git merge --ff-only FETCH_HEAD
else
  # The initial public snapshot has no private ancestors. Allow the one-time
  # switch only from the exact private release approved on this host.
  [ "$bundle_file" = - ] &&
    [ "$previous_sha" = "$cutover_from" ] &&
    [ "$(git branch --show-current)" = v8 ] &&
    ! git show-ref --verify --quiet refs/heads/main ||
    { echo 'Release does not descend from the current production checkout.' >&2; exit 1; }
  git switch --no-track -c main FETCH_HEAD
fi
[ "$(git rev-parse HEAD)" = "$release_sha" ] || { echo 'Release SHA mismatch.' >&2; exit 1; }
set -a
. server/.env
set +a
# A deployment never generates or rotates credentials implicitly.
: "${SUPPORT_NOTIFICATION_HMAC_KEY:?Provision the notification signing key privately before release}"
if [ "$prebuilt_images" = 1 ]; then
  # CI artifacts are loaded privately before release. Verify all three source
  # images before changing any Compose image tags or stopping writers.
  for role in api worker client; do
    image="asksales-security-$role:$release_sha"
    revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image")
    [ "$revision" = "$release_sha" ] || { echo "Prebuilt image revision mismatch for $role" >&2; exit 1; }
  done
fi
backup_dir=/var/backups/asksales
umask 077
install -d -m 700 "$backup_dir"
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
manifest="$backup_dir/release-$backup_stamp-$release_sha.manifest"
printf 'release_sha=%s\nprevious_sha=%s\nstate=building\n' "$release_sha" "$previous_sha" > "$manifest"
release_failed() {
  printf 'state=failed\n' >> "$manifest"
  echo "Release failed. Writers stopped for migrations remain stopped; inspect $manifest and use the reviewed recovery runbook." >&2
}
trap 'release_exit=$?; if [ "$release_exit" -ne 0 ]; then release_failed; fi; cleanup_bundle' EXIT
docker_build_active=false
for docker_pid in $(pgrep -x docker || true); do
  docker_cmd=$(tr '\0' ' ' < "/proc/$docker_pid/cmdline" 2>/dev/null || true)
  case "$docker_cmd" in
    *" compose "*" build"*)
      docker_build_active=true
      break
      ;;
  esac
done
if [ "$docker_build_active" = true ]; then
  echo 'Another Docker Compose build is already active; refusing a concurrent production build.' >&2
  exit 1
fi

available_kb=$(awk '/MemAvailable:/ { print $2 }' /proc/meminfo)
if [ "${available_kb:-0}" -lt 2097152 ]; then
  echo 'At least 2 GiB of available memory is required before a production build.' >&2
  free -h >&2
  exit 1
fi

total_kb=$(awk '/MemTotal:/ { print $2 }' /proc/meminfo)
swap_kb=$(awk '/SwapTotal:/ { print $2 }' /proc/meminfo)
if [ "${total_kb:-0}" -lt 12582912 ] && [ "${swap_kb:-0}" -lt 4194304 ]; then
  echo 'Hosts with less than 12 GiB RAM require at least 4 GiB swap for production image builds.' >&2
  free -h >&2
  exit 1
fi

# Retain the previous image by commit. Retention is a reviewed operator policy;
# a failed release never overwrites the only known-good image tag.
for service in api worker-1 worker-2 client; do
  container="sm-$service"
  if docker inspect "$container" >/dev/null 2>&1; then
    image_id=$(docker inspect --format '{{.Image}}' "$container")
    docker image tag "$image_id" "asksales-rollback-$service:$previous_sha"
  fi
done

if [ "$prebuilt_images" = 1 ]; then
  project_name=$(docker compose --env-file server/.env -f "$compose_file" config --format json | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
  [[ "$project_name" =~ ^[a-z0-9][a-z0-9_-]*$ ]]
  for service in api worker-1 worker-2 client; do
    role="$service"
    case "$service" in worker-*) role=worker ;; esac
    docker image tag "asksales-security-$role:$release_sha" "$project_name-$service:latest"
  done
else
 for service in api worker-1 worker-2 client; do
  echo "--- Building $service ---"
  if [ "$service" = client ]; then
    COMPOSE_PARALLEL_LIMIT=1 timeout --signal=TERM --kill-after=30s 30m \
      nice -n 10 docker compose --progress plain --env-file server/.env -f "$compose_file" build --build-arg RELEASE_SHA="$release_sha" "$service"
  else
    COMPOSE_PARALLEL_LIMIT=1 timeout --signal=TERM --kill-after=30s 30m \
      docker compose --progress plain --env-file server/.env -f "$compose_file" build --build-arg RELEASE_SHA="$release_sha" "$service"
  fi
 done
fi
# Build before stopping traffic, then capture the last pre-migration writer state.
backup_file="$backup_dir/predeploy-$backup_stamp.dump"
cp server/.env "$backup_dir/server-env-$backup_stamp.bak"
chmod 600 "$backup_dir/server-env-$backup_stamp.bak"
# Most releases contain no pending migrations. Keep the healthy API and workers
# serving in that case instead of creating an avoidable migration outage.
# Compose run defaults to interactive input; disable it so it cannot consume
# the remaining remote bash heredoc and silently skip the migration phase.
migration_status=$(docker compose --env-file server/.env -f "$compose_file" run -T --interactive=false --rm --no-deps \
  -e DB_MIGRATION_USER="$DB_USER" -e DB_MIGRATION_PASSWORD="$DB_PASSWORD" \
  api node server/scripts/migrate.mjs status)
printf '%s\n' "$migration_status"
pending_count=$(printf '%s\n' "$migration_status" | sed -n 's/.*Pending: \([0-9][0-9]*\).*/\1/p' | tail -1)
if ! [[ "$pending_count" =~ ^[0-9]+$ ]]; then
  echo 'Could not determine pending migration count; refusing to continue.' >&2
  exit 1
fi

backup_database() {
  PGPASSWORD="$DB_PASSWORD" pg_dump \
    --host="${DB_HOST:-127.0.0.1}" --port="${DB_PORT:-5432}" \
    --username="$DB_USER" --dbname="${DB_NAME:-${DB_DATABASE}}" \
    --format=custom --file="$backup_file"
  pg_restore --list "$backup_file" >/dev/null
  chmod 600 "$backup_file"
  printf 'database_backup=%s\n' "$backup_file" >> "$manifest"
}
if [ "$pending_count" -gt 0 ]; then
  # Schema migrations run with the previous API and workers stopped so a
  # request cannot observe a partially upgraded contract.
  docker compose --env-file server/.env -f "$compose_file" stop api worker-1 worker-2
  backup_database
  docker compose --env-file server/.env -f "$compose_file" run -T --interactive=false --rm --no-deps \
    -e DB_MIGRATION_USER="$DB_USER" -e DB_MIGRATION_PASSWORD="$DB_PASSWORD" \
    api node server/scripts/migrate.mjs up
else
  backup_database
  echo 'No pending migrations; keeping the current API and workers online until container replacement.'
fi
COMPOSE_PARALLEL_LIMIT=1 docker compose --env-file server/.env -f "$compose_file" up -d --no-build --wait --wait-timeout 180
curl -fsS --max-time 15 http://127.0.0.1:8080/health >/dev/null
curl -fsS --max-time 15 http://127.0.0.1:3000/ >/dev/null
docker exec sm-api node /app/server/dist/backfill-crm-channel-identities.js
for service in api worker-1 worker-2 client; do
  image_id=$(docker inspect --format '{{.Image}}' "sm-$service")
  revision=$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image_id")
  [ "$revision" = "$release_sha" ] || { echo "Image revision mismatch for $service" >&2; exit 1; }
  printf 'image_%s=%s\n' "$service" "$image_id" >> "$manifest"
done
backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
cp /etc/nginx/sites-available/asksales "$backup_dir/nginx-predeploy-$backup_stamp.conf"
install -m 644 "$prod_dir/nginx/asksales.conf" /etc/nginx/sites-available/asksales
if ! nginx -t || ! systemctl reload nginx; then
  install -m 644 "$backup_dir/nginx-predeploy-$backup_stamp.conf" /etc/nginx/sites-available/asksales
  nginx -t && systemctl reload nginx || echo 'Nginx recovery needs operator attention; backup retained.' >&2
  exit 1
fi
printf 'state=verified\n' >> "$manifest"
echo "Verified release $release_sha; manifest: $manifest"
