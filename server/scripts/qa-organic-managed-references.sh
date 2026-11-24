#!/usr/bin/env bash
set -euo pipefail
organic_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
organic_pg_container="organic-bcs02-pg-$$"
organic_redis_container="organic-bcs02-redis-$$"
trap 'docker rm -f "$organic_pg_container" "$organic_redis_container" >/dev/null 2>&1 || true' EXIT
docker run --rm -d --name "$organic_pg_container" -p 127.0.0.1::5432 -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=organic_audit -e POSTGRES_DB=organic_audit pgvector/pgvector:pg16 >/dev/null
docker run --rm -d --name "$organic_redis_container" -p 127.0.0.1::6379 redis:7.2-alpine redis-server --save '' --appendonly no >/dev/null
for organic_ready_attempt in {1..40}; do
  if docker exec "$organic_pg_container" pg_isready -U organic_audit >/dev/null; then break; fi
  sleep 0.25
done
organic_pg_mapping="$(docker port "$organic_pg_container" 5432/tcp)"
organic_redis_mapping="$(docker port "$organic_redis_container" 6379/tcp)"
if (($# == 0)); then
  set -- tests/linkedInOrganicWorkerPostgres.test.ts \
    tests/organicPublishLifecyclePostgres.test.ts \
    tests/youtubeOrganicPublishing.test.ts \
    tests/contentManagedReferences.test.ts \
    tests/contentAssetMedia.test.ts \
    tests/organicPublishQueue.test.ts \
    tests/organicPublishingPolicy.test.ts \
    tests/organicPublishingMigration.test.ts \
    tests/organicPublishNotifications.test.ts \
    tests/youtubePublishingPolicy.test.ts \
    tests/socialPublishingFormats.test.ts \
    tests/youtubeContentPublishingContract.test.ts \
    tests/publishSocialPostContract.test.ts \
    tests/publishingImagePreflight.test.ts \
    tests/publicationReceiptSafety.test.ts \
    tests/youtubeManagementHttp.test.ts \
    tests/youtubeCommentIntentPostgres.test.ts \
    tests/contentManagementLifecycleGuard.test.ts
fi
cd "$organic_repo_root/server"
env CONTENT_PUBLISH_LOCAL_QA=1 PUBLICATION_REDIS_LOCAL_QA=1 STORAGE_BACKEND=local \
  DB_HOST=127.0.0.1 DB_PORT="${organic_pg_mapping##*:}" DB_NAME=organic_audit DB_USER=organic_audit DB_PASSWORD='' \
  REDIS_HOST=127.0.0.1 REDIS_PORT="${organic_redis_mapping##*:}" NODE_OPTIONS=--experimental-vm-modules \
  ./node_modules/.bin/jest --runInBand "$@"
