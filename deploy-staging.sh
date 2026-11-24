#!/usr/bin/env bash

# Deploy the committed local HEAD to the isolated AskSales staging site.
#
# This script is intentionally separate from deploy.sh. It never references
# the production checkout, production Compose file, production containers,
# production database, or production Nginx site.

set -euo pipefail

readonly STAGING_DIR="${STAGING_DIR:-/var/www/salesmarketing-dev}"
readonly STAGING_REF="${STAGING_REF-staging}"
readonly COMPOSE_PROJECT="salesmarketing-dev"
readonly COMPOSE_FILE="docker-compose.dev-env.yml"
readonly REMOTE_NGINX_SITE="/etc/nginx/sites-available/asksales-dev"
readonly REMOTE_NGINX_LINK="/etc/nginx/sites-enabled/asksales-dev"

case "$STAGING_DIR" in
  /var/www/salesmarketing-dev) ;;
  *)
    echo "Refusing to deploy staging outside /var/www/salesmarketing-dev: $STAGING_DIR" >&2
    exit 1
    ;;
esac

case "$STAGING_REF" in
  staging) ;;
  *)
    echo "Refusing publication to a non-staging ref: $STAGING_REF" >&2
    exit 1
    ;;
esac

repo_root=$(git rev-parse --show-toplevel)
cd "$repo_root"

for required_file in "$COMPOSE_FILE" nginx/dev.asksales.conf; do
  if [ ! -f "$required_file" ]; then
    echo "Missing staging deployment file: $required_file" >&2
    exit 1
  fi
done

staging_commit=$(git rev-parse HEAD)
if ! git diff --quiet HEAD --; then
  echo 'Refusing staging publication from a dirty checkout.' >&2
  exit 1
fi
if [ "${RELEASE_VERIFIED_SHA:-}" != "$staging_commit" ]; then
  echo 'Set RELEASE_VERIFIED_SHA to the exact commit after required CI checks pass.' >&2
  exit 1
fi

readonly STAGING_HOST="${STAGING_HOST:?Set the staging SSH target privately}"
echo "Publishing committed $staging_commit to origin/$STAGING_REF (staging only)."
git push origin "$staging_commit:refs/heads/$STAGING_REF"

bundle_file=$(mktemp "${TMPDIR:-/tmp}/asksales-staging.XXXXXX")
trap 'rm -f "$bundle_file"' EXIT
git bundle create "$bundle_file" HEAD >/dev/null

remote_bundle="/tmp/asksales-staging-${staging_commit}.bundle"
remote_nginx="/tmp/asksales-dev-$staging_commit.nginx"

echo "Transferring the committed source bundle and staging Nginx configuration."
scp -q "$bundle_file" "$STAGING_HOST:$remote_bundle"
scp -q nginx/dev.asksales.conf "$STAGING_HOST:$remote_nginx"

echo "Synchronizing the isolated staging checkout and Docker services."
ssh "$STAGING_HOST" bash -s -- \
  "$STAGING_DIR" \
  "$COMPOSE_PROJECT" \
  "$COMPOSE_FILE" \
  "$staging_commit" \
  "$remote_bundle" \
  "$remote_nginx" \
  "$REMOTE_NGINX_SITE" \
  "$REMOTE_NGINX_LINK" <<'REMOTE_STAGING'
set -euo pipefail

staging_dir="$1"
compose_project="$2"
compose_file="$3"
staging_commit="$4"
remote_bundle="$5"
remote_nginx="$6"
nginx_site="$7"
nginx_link="$8"

case "$staging_dir" in
  /var/www/salesmarketing-dev) ;;
  *) echo "Remote staging path guard failed: $staging_dir" >&2; exit 1 ;;
esac

if [ "$staging_dir" = "/var/www/salesmarketing" ] || [ "$compose_project" != "salesmarketing-dev" ]; then
  echo 'Production path/project guard failed; refusing staging deployment.' >&2
  exit 1
fi

exec 9>/var/lock/asksales-release.lock
flock -n 9 || { echo 'Another release owns the host lock.' >&2; exit 1; }
install -d -m 755 "$staging_dir"
if [ ! -d "$staging_dir/.git" ]; then
  git -C "$staging_dir" init -q
fi

# Fetch only the explicitly transferred commit. Existing untracked staging
# secrets are intentionally preserved by checkout and are never replaced.
git -C "$staging_dir" fetch -q "$remote_bundle" "$staging_commit"
if [ -n "$(git -C "$staging_dir" status --porcelain)" ]; then
  echo 'Staging checkout is dirty; preserving changes.' >&2; exit 1
fi
if git -C "$staging_dir" rev-parse --verify HEAD >/dev/null 2>&1 && \
  ! git -C "$staging_dir" merge-base --is-ancestor HEAD "$staging_commit"; then
  echo 'Staging release is not a fast-forward; review recovery separately.' >&2; exit 1
fi
git -C "$staging_dir" checkout --detach "$staging_commit" >/dev/null

env_file="$staging_dir/server/.env"
if [ ! -f "$env_file" ]; then
  umask 077
  db_password=$(openssl rand -hex 32)
  redis_password=$(openssl rand -hex 32)
  jwt_secret=$(openssl rand -hex 32)
  channel_key=$(openssl rand -hex 32)
  secrets_key=$(openssl rand -hex 32)
  webhook_secret=$(openssl rand -hex 32)
  razorpay_secret=$(openssl rand -hex 32)
  notification_key=$(openssl rand -hex 32)

  cat >"$env_file" <<EOF
# Generated on the VPS for dev.asksales.ai. Do not copy production secrets here.
NODE_ENV=production
PORT=8080
APP_URL=https://dev.asksales.ai
API_URL=https://dev.asksales.ai
CLIENT_URL=https://dev.asksales.ai
FRONTEND_URL=https://dev.asksales.ai
ADMIN_URL=https://dev.asksales.ai
CORS_ORIGIN=https://dev.asksales.ai
GMAIL_REDIRECT_URI=https://dev.asksales.ai/api/gmail/oauth/callback

DB_HOST=db
DB_PORT=5432
DB_NAME=salesmarketing_dev
DB_DATABASE=salesmarketing_dev
DB_USER=asksales_dev
DB_PASSWORD=$db_password
DB_SSL=false

REDIS_HOST=redis
REDIS_PORT=6379
REDIS_PASSWORD=$redis_password
REDIS_URL=redis://:$redis_password@redis:6379

JWT_SECRET=$jwt_secret
JWT_EXPIRES_IN=7d
CHANNEL_AUTH_ENCRYPTION_KEY=$channel_key
SECRETS_ENCRYPTION_KEY=$secrets_key
WEBHOOK_SECRET=$webhook_secret
RAZORPAY_KEY_ID=staging-disabled
RAZORPAY_KEY_SECRET=$razorpay_secret
SUPPORT_NOTIFICATION_HMAC_KEY=$notification_key

# Safety defaults: staging has no production provider credentials and does not
# send external notifications or mutate live ad-provider accounts.
AD_PROVIDER_MUTATIONS_ENABLED=false
SUPPORT_NOTIFICATION_DELIVERY_MODE=simulate
SUPPORT_NOTIFICATION_EMAIL_ENABLED=false
SUPPORT_NOTIFICATION_WHATSAPP_ENABLED=false
SUPPORT_NOTIFICATION_SLACK_ENABLED=false
SUPPORT_NOTIFICATION_TEAMS_ENABLED=false
LANGFUSE_ENABLED=false
LOG_LEVEL=info
EOF
  chmod 600 "$env_file"
  echo "Created isolated staging environment file at $env_file."
else
  chmod 600 "$env_file"
  echo "Keeping existing isolated staging environment file at $env_file."
fi

for required_oauth_key in GOOGLE_SIGN_IN_CLIENT_ID META_APP_ID META_APP_SECRET; do
  if ! grep -Eq "^${required_oauth_key}=.+" "$env_file"; then
    echo "Set $required_oauth_key in the private staging server/.env before deploying." >&2
    exit 1
  fi
done

cd "$staging_dir"

compose() {
  docker compose \
    --project-name "$compose_project" \
    --env-file server/.env \
    -f "$compose_file" \
    "$@"
}

compose config --quiet

# Build one service at a time because the VPS is also serving production.
for service in api worker-1 worker-2 client; do
  echo "Building staging $service"
  COMPOSE_PARALLEL_LIMIT=1 compose build --build-arg RELEASE_SHA="$staging_commit" "$service"
done

echo 'Starting staging database, Redis, and upload initializer.'
compose up -d --wait --wait-timeout 180 db redis
compose run -T --interactive=false --rm upload-init

# Organization billing changes wallet ownership and subscription account keys.
# Stop the old writers before migrating; they cannot safely use the new schema.
echo 'Stopping staging writers and backing up the staging database.'
compose stop -t 60 api worker-1 worker-2
install -d -m 700 /var/backups/asksales-dev
staging_backup="/var/backups/asksales-dev/pre-${staging_commit}-$(date -u +%Y%m%dT%H%M%SZ).dump"
umask 077
compose exec -T --interactive=false db sh -c 'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl' > "$staging_backup"
test -s "$staging_backup"
# Keep stdin open for the archive while disabling TTY allocation.
compose exec -T --interactive=true db pg_restore --list < "$staging_backup" >/dev/null

echo 'Applying staging database migrations.'
compose run -T --interactive=false --rm --no-deps api node server/scripts/migrate.mjs up

echo 'Synchronizing staging Meta OAuth credentials from the private environment file.'
compose run -T --interactive=false --rm --no-deps api node server/dist/sync-staging-meta-oauth.js

echo 'Starting staging API, workers, and client.'
COMPOSE_PARALLEL_LIMIT=1 compose up -d --no-build --remove-orphans --wait --wait-timeout 240 api worker-1 worker-2 client

curl -fsS --max-time 20 http://127.0.0.1:8081/health >/dev/null
curl -fsS --max-time 20 http://127.0.0.1:3002/ >/dev/null

# BEGIN STAGING NGINX TRANSACTION
cert_path=/etc/letsencrypt/live/dev.asksales.ai/fullchain.pem
bootstrap_site=/etc/nginx/sites-available/asksales-dev-bootstrap
# Validate the shared proxy before changing any staging entries.
nginx -t
nginx_backup=$(mktemp -d "${TMPDIR:-/tmp}/asksales-nginx.XXXXXX")
chmod 700 "$nginx_backup"
nginx_changed=false
nginx_paths=("$nginx_site" "$nginx_link" "$bootstrap_site")
for index in "${!nginx_paths[@]}"; do
  entry="${nginx_paths[$index]}"
  if [ -d "$entry" ]; then
    echo "Refusing to replace a Nginx directory: $entry" >&2
    rm -rf "$nginx_backup"
    exit 1
  fi
  if [ -e "$entry" ] || [ -L "$entry" ]; then
    cp -a "$entry" "$nginx_backup/$index"
  fi
done

restore_nginx_entries() {
  for index in "${!nginx_paths[@]}"; do
    entry="${nginx_paths[$index]}"
    rm -f "$entry" || return 1
    if [ -e "$nginx_backup/$index" ] || [ -L "$nginx_backup/$index" ]; then
      cp -a "$nginx_backup/$index" "$entry" || return 1
    fi
  done
  nginx -t || return 1
  systemctl reload nginx || return 1
}
finish_nginx_transaction() {
  local status=$?
  trap - EXIT
  if [ "$nginx_changed" = true ]; then
    echo 'Staging Nginx change failed; restoring the previous configuration and enabled entry.' >&2
    if ! restore_nginx_entries; then
      echo "Nginx restoration needs operator attention; backup retained at $nginx_backup" >&2
      exit 1
    fi
  fi
  rm -rf "$nginx_backup"
  exit "$status"
}
trap finish_nginx_transaction EXIT
install -d -m 755 /var/www/letsencrypt

if [ ! -s "$cert_path" ]; then
  echo 'Installing a temporary HTTP route for ACME certificate validation.'
  nginx_changed=true
  cat >"$nginx_backup/new-bootstrap" <<'EOF'
server {
    listen 80;
    server_name dev.asksales.ai;
    location /.well-known/acme-challenge/ {
        root /var/www/letsencrypt;
    }
    location /api/ {
        proxy_pass http://127.0.0.1:8081;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
    location / {
        proxy_pass http://127.0.0.1:3002;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
EOF
  install -m 644 "$nginx_backup/new-bootstrap" "$nginx_backup/bootstrap-ready"
  mv -f "$nginx_backup/bootstrap-ready" "$bootstrap_site"
  ln -sfn "$bootstrap_site" "$nginx_link"
  nginx -t
  systemctl reload nginx

  echo 'Issuing the dedicated dev.asksales.ai certificate.'
  certbot certonly --webroot -w /var/www/letsencrypt \
    --non-interactive --agree-tos --register-unsafely-without-email \
    --keep-until-expiring -d dev.asksales.ai
fi

current_nginx_target="$(readlink -f "$nginx_link" 2>/dev/null || true)"
if [ "$current_nginx_target" != "$nginx_site" ] || ! cmp -s "$remote_nginx" "$nginx_site"; then
  echo 'Installing the staging Nginx configuration.'
  nginx_changed=true
  install -m 644 "$remote_nginx" "$nginx_backup/site-ready"
  mv -f "$nginx_backup/site-ready" "$nginx_site"
  ln -sfn "$nginx_site" "$nginx_link"
  nginx -t
  systemctl reload nginx
else
  nginx -t
fi

# Commit only after the final shared configuration validates and reloads.
nginx_changed=false
# END STAGING NGINX TRANSACTION

echo 'Staging verification:'
curl -fsS --retry 30 --retry-delay 2 --retry-all-errors --max-time 30 \
  -o /dev/null -w 'dev.asksales.ai: %{http_code}\n' https://dev.asksales.ai/
curl -fsS --retry 30 --retry-delay 2 --retry-all-errors --max-time 30 \
  -o /dev/null -w 'dev API health: %{http_code}\n' https://dev.asksales.ai/health
compose ps
REMOTE_STAGING

echo "Staging deployment complete: https://dev.asksales.ai"
echo "Deployed committed revision: $staging_commit"
