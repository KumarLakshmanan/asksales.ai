# Deployment Guide — asksales.ai

## Architecture Overview

Production runs on a single VPS (`root@asksales.ai`, `104.236.63.192`).

`asksales.ai` and `dev.asksales.ai` resolve to `104.236.63.192`. The older
`138.197.13.158` address is not the active production server.

| Layer | Technology | Details |
|-------|-----------|---------|
| **Containers** | Docker Compose | 4 application services, built from monorepo |
| **Reverse proxy** | Nginx (native) | SSL via Let's Encrypt, proxies to `127.0.0.1` ports |
| **Database** | PostgreSQL 17 (native) | `127.0.0.1:5432`, user `postgres` |
| **Cache/Queue** | Redis 7 (native) | `0.0.0.0:6379`, password auth |
| **Process manager** | Docker Compose | `restart: unless-stopped` on all services |

### Container Services

| Container | Image | Port | Purpose |
|-----------|-------|------|---------|
| `sm-api` | `salesmarketing-api` | `127.0.0.1:8080` | Express API server |
| `sm-client` | `salesmarketing-client` | `127.0.0.1:3000` | Next.js frontend |
| `sm-worker-1` | `salesmarketing-worker-1` | — | BullMQ job worker |
| `sm-worker-2` | `salesmarketing-worker-2` | — | BullMQ job worker |

### Host Services (native, not containerized)

| Service | Port | Notes |
|---------|------|-------|
| PostgreSQL | `127.0.0.1:5432` | Accepts connections from Docker networks `172.17.0.0/16` and `172.19.0.0/16` |
| Redis | `0.0.0.0:6379` | Password auth (`requirepass`), `protected-mode no` via ACL |
| Nginx | `80`, `443` | Proxies to container ports on `127.0.0.1` |

### Nginx Routing

| Domain | Target | Notes |
|--------|--------|-------|
| `asksales.ai` | `127.0.0.1:3000` (client) | `/api/*` → `127.0.0.1:8080` (WebSocket support) |
| `admin.asksales.ai` | `127.0.0.1:3000` | Admin routes are part of the unified Next.js client |
| `api.asksales.ai` | → redirect to `asksales.ai` | Backward compat redirect |
| `dev.asksales.ai` | `127.0.0.1:3002` (dev client) | `/api/*` → `127.0.0.1:8081` (Dev API server) |

## Staging Environment (`dev.asksales.ai`)

An isolated staging environment runs on the same VPS so the chat, agents,
widgets, integrations, and campaign flows can be tested before production
deployment. Staging is a separate Compose project with separate containers,
networking, database, Redis instance, named volumes, loopback ports, and
Nginx site. It does not share production PostgreSQL, Redis, uploads, exports,
or application containers.

Never run `deploy.sh` for staging. `deploy.sh` is production-only. Use the
staging script below, which publishes only the committed local `HEAD` to the
`staging` branch and deploys only to `/var/www/salesmarketing-dev`.

### Key Differences from Production

| Feature | Production (`asksales.ai`) | Development (`dev.asksales.ai`) |
|---------|---------------------------|----------------------------------|
| **Path** | `/var/www/salesmarketing` | `/var/www/salesmarketing-dev` |
| **Git Branch** | `v8` | `staging` |
| **Compose File** | `docker-compose.production.yml` | `docker-compose.dev-env.yml` |
| **Database** | Host native PostgreSQL (port 5432) | Containerized PostgreSQL (`sm-dev-db`) |
| **Redis** | Host native Redis (port 6379) | Containerized Redis (`sm-dev-redis`) |
| **Loopback ports** | Client `3000`, API `8080` | Client `3002`, API `8081`, PostgreSQL `5433`, Redis `6380` |
| **Public route** | `asksales.ai` | `dev.asksales.ai` |

### Staging Container Services

| Container | Image | Purpose |
|-----------|-------|---------|
| `sm-dev-api` | `salesmarketing-dev-api` | Dev API server |
| `sm-dev-client` | `salesmarketing-dev-client` | Dev Next.js frontend |
| `sm-dev-worker-1` | `salesmarketing-dev-worker-1` | Dev BullMQ job worker |
| `sm-dev-worker-2` | `salesmarketing-dev-worker-2` | Dev BullMQ job worker |
| `sm-dev-db` | `pgvector/pgvector:pg16` | Isolated PostgreSQL + pgvector |
| `sm-dev-redis` | `redis:7.2-alpine` | Isolated Redis for queueing/caching |

The staging `.env` is generated on the VPS at
`/var/www/salesmarketing-dev/server/.env` with mode `600`. It is never copied
from production. By default it has no provider credentials, sets
`AD_PROVIDER_MUTATIONS_ENABLED=false`, and uses simulated support-notification
delivery so staging tests cannot send through live provider accounts.

### Deploying to Staging

From the repository root:

```bash
./deploy-staging.sh
```

The script performs these staging-only steps:

1. Pushes committed `HEAD` to `origin/staging`.
2. Transfers a Git bundle to `/var/www/salesmarketing-dev` and preserves the
   existing staging `.env`.
3. Validates `docker-compose.dev-env.yml` under the fixed project name
   `salesmarketing-dev`.
4. Builds the API, workers, and client one at a time so production remains
   available on the VPS.
5. Starts the isolated database and Redis, applies migrations, and waits for
   staging health checks.
6. Issues the dedicated `dev.asksales.ai` certificate if needed, installs
   `nginx/dev.asksales.conf` as a separate site, validates Nginx, and reloads
   it without restarting production containers.

The script deploys committed `HEAD` only. Uncommitted working-tree changes are
reported and deliberately excluded; commit the intended staging revision
before running it.

### Staging verification

```bash
ssh root@104.236.63.192 \
  "cd /var/www/salesmarketing-dev && \
   docker compose --project-name salesmarketing-dev --env-file server/.env \
   -f docker-compose.dev-env.yml ps"

curl --fail https://dev.asksales.ai/
curl --fail https://dev.asksales.ai/health
curl -sS -o /dev/null -w '%{http_code}\n' https://dev.asksales.ai/api/auth/me
```

An unauthenticated `/api/auth/me` response may be HTTP 401; that proves the
staging route reaches the staging API. The production equivalents remain
`127.0.0.1:3000`, `127.0.0.1:8080`, and `https://asksales.ai`.

### Staging operations

```bash
ssh root@104.236.63.192
cd /var/www/salesmarketing-dev
docker compose --project-name salesmarketing-dev --env-file server/.env \
  -f docker-compose.dev-env.yml logs -f --tail 100
docker compose --project-name salesmarketing-dev --env-file server/.env \
  -f docker-compose.dev-env.yml ps
```

Do not use `docker compose down -v`, `docker volume rm`, `docker system prune`,
or the production compose file while operating staging. If staging data must
be reset, identify only the `salesmarketing-dev` volumes and get an explicit
approval before removing them.


## Quick Deploy

```bash
# From a clean local checkout, after CI passes for HEAD
git switch v8
RELEASE_VERIFIED_SHA=$(git rev-parse HEAD) ./deploy.sh
```

This will:
1. Push current `v8` branch to origin
2. Switch the production checkout to `v8` and fast-forward to the release commit
   - If the VPS cannot authenticate to GitHub, transfer an incremental Git bundle over SSH
   - Divergent production history is rejected; the script never force-pushes or force-resets production
3. Create and verify a timestamped PostgreSQL backup
4. Build API, both worker, and client Docker images
5. Apply forward migrations
6. Recreate application containers and wait for health checks
7. Reconcile encrypted CRM channel identities
8. Run health checks, stop the retired `sm-hermes` container, and print container status

The script deploys the committed local `v8` HEAD. Review `git status` first;
uncommitted working-tree changes are not included in the Git synchronization.
The VPS keeps its production secrets in `/var/www/salesmarketing/server/.env`;
that file is not copied from the local machine.

## Manual Commands

### Build images

```bash
ssh root@asksales.ai "cd /var/www/salesmarketing && docker compose -f docker-compose.production.yml build"
```

### Start/stop/restart

```bash
# Start all
docker compose -f docker-compose.production.yml up -d

# Restart specific service
docker compose -f docker-compose.production.yml restart sm-api

# Stop all
docker compose -f docker-compose.production.yml down

# Recreate with fresh images
docker compose -f docker-compose.production.yml up -d --force-recreate
```

### View logs

```bash
# All services
docker compose -f docker-compose.production.yml logs -f

# Specific service
docker logs sm-api -f --tail 50
docker logs sm-client -f --tail 50
docker logs sm-worker-1 -f --tail 50
```

### Health checks

```bash
curl -s http://127.0.0.1:8080/health    # API
curl -s http://127.0.0.1:3000/          # Client
```

### Container status

```bash
docker compose -f docker-compose.production.yml ps
```

## Docker Networking

Containers use the default bridge network (`salesmarketing_default`). PostgreSQL and Redis on the host are accessed via `host.docker.internal` (resolved through `extra_hosts: host-gateway`).

**Environment overrides in `docker-compose.production.yml`:**
```yaml
REDIS_HOST: host.docker.internal
REDIS_PORT: 6379
REDIS_PASSWORD: <password>
REDIS_URL: redis://:<password>@host.docker.internal:6379
DB_HOST: host.docker.internal
DB_PORT: 5432
```

These override values from `server/.env` to redirect container traffic to host services.

## Support AI runtime configuration

These variables are read from `server/.env` by the API and both workers. None
of them is set by `docker-compose.production.yml`, `ecosystem.config.js` or the
deploy scripts, so they must be provisioned in the server-side `.env`. Never
commit their values.

| Variable | Purpose | When unset |
|----------|---------|------------|
| `SUPPORT_ASSISTANTS_ENABLED` | Enables assistant routing and customer delivery. Only the exact value `true` enables it. | No automatic customer reply is generated or sent on any channel; there is no legacy specialist fallback. Customer-bound sends through the WhatsApp, Instagram, Facebook and email services are rejected with `ASSISTANT_SETUP_REQUIRED`. Draft management and simulator previews still work. |
| `SUPPORT_ASSISTANTS_BUSINESS_PROFILES` | Comma-separated positive business-profile IDs allowed to use the runtime while the flag is `true`. | The flag applies to every business profile. An invalid list (any non-numeric entry) enables nobody. |
| `SUPPORT_PII_ENCRYPTION_KEY` | Master key for the encrypted support privacy vault (key version 1). Must be at least 32 characters. | Falls back to `SECRETS_ENCRYPTION_KEY`. If neither is a 32+ character value, vault encryption throws and the assistant readiness check for the privacy vault fails. |
| `SUPPORT_PII_KEY_VERSION`, `SUPPORT_PII_ENCRYPTION_KEY_V<n>` | Key rotation. New records are encrypted with version `<n>` = `SUPPORT_PII_KEY_VERSION`; `SUPPORT_PII_ENCRYPTION_KEY_V<n>` takes precedence over the unversioned key. | Version defaults to `1`. Versions above 1 have no fallback and require their own `_V<n>` key. Existing records are decrypted with the version stored on them, so keep earlier keys configured. |
| `SUPPORT_PII_TOKENIZATION_KEY` | Optional dedicated HMAC key for the stable suffix of redaction tokens such as `[EMAIL_…]`. | Uses the PII encryption key, then `SECRETS_ENCRYPTION_KEY`. With no key at all, a random per-process key is used, so token suffixes differ between the API, each worker and every restart. |
| `SUPPORT_MODERATION_ENABLED` | `true` adds provider moderation (OpenAI via `OPENAI_API_KEY` or admin-managed OpenAI, OpenRouter, Vertex AI and Gemini credentials) to the deterministic checks. | Only the deterministic checks run. When enabled and no provider answers, a narrow set of low-risk messages continues and everything else goes to human handoff. |
| `SUPPORT_MODERATION_FAIL_CLOSED` | Reported as the moderation outage mode in the support readiness view (`false` only when set to exactly `false`). | Reported as fail closed. The server code does not read it anywhere else, so it does not change the outage behaviour described above. |
| `KNOWLEDGE_V2_ENABLED` | Override for vector knowledge retrieval and reranking. `true` forces it on; `false` forces lexical-only retrieval. | The `knowledge_v2_enabled` value in the `knowledge_runtime_settings` table decides. Publication and privacy governance apply in every mode. |

Do not set `SUPPORT_ASSISTANTS_ENABLED=true` in production as a standalone
change. Follow the reviewed rollout in `server/ASSISTANTS_ROLLOUT.md`
(migration, import, review, published bindings, profile allowlist, canary
verification) first.

## Volumes

| Volume | Mount | Purpose |
|--------|-------|---------|
| `sm-uploads` | `/app/server/uploads` | User-uploaded files (shared across api/workers) |
| `sm-exports` | `/app/exports` | CSV/data exports (api only) |

## Build Details

### Server (API + Worker)

- **Builder**: esbuild bundles `index.ts` → `dist/index.js` (ESM, `--packages=external`)
- **Runtime**: Node 24.18.1 Alpine, `pnpm install --prod` for runtime deps
- **Key**: `PUPPETEER_SKIP_DOWNLOAD=true` in builder to avoid downloading Chromium

### Client (Next.js)

- **Output**: `standalone` mode (self-contained `server.js`)
- **Build args**: empty `NEXT_PUBLIC_API_URL` for same-origin browser calls and `BACKEND_URL=http://api:8080` for server-side rewrites
- **CMD**: `node client/server.js` (monorepo nested standalone output)

### Retired Hermes browser automation

V7 removes the Hermes source and routes. Production Compose runs only API,
two workers, and client. The deployment script keeps the previous Hermes image
and data volume for rollback and stops the old container after the application
passes health checks. Social outreach requires the official provider API/OAuth
integration; legacy browser session approvals cannot authorize sends.

## Troubleshooting

### Container keeps restarting

```bash
docker logs sm-api --tail 50
# Common issues:
# - Missing env vars in server/.env
# - Redis/PostgreSQL not reachable
# - Port already in use
```

### Redis connection refused

```bash
# Check Redis is running
redis-cli ping

# Check bind address
redis-cli CONFIG GET bind

# Check password
redis-cli CONFIG GET requirepass
```

### PostgreSQL connection refused

```bash
# Check pg_hba.conf has Docker network entries
grep '172\.' /etc/postgresql/*/main/pg_hba.conf

# Reload after changes
systemctl reload postgresql
```

### Disk space

```bash
# Check Docker usage
docker system df

# Prune build cache
docker builder prune -af
docker image prune -af
```

### Out of memory

```bash
# Check container memory usage
docker stats --no-stream

# Restart specific container
docker compose -f docker-compose.production.yml restart sm-api
```

## Security Notes

- **Redis**: Bound to `0.0.0.0` with password auth. Firewall limits external access.
- **PostgreSQL**: Bound to `0.0.0.0` with `scram-sha-256` auth. Docker network access configured via `pg_hba.conf`.
- **Nginx**: SSL via Let's Encrypt, security headers configured.
- **Containers**: Run as non-root users (`appuser` for API, `nextjs` for client).
- **Secrets**: `server/.env` (gitignored) contains DB password, JWT secret, Redis password. Docker `env_file` loads this.

## File Structure

```
/var/www/salesmarketing/
├── docker-compose.production.yml   # Production Docker Compose
├── deploy.sh                       # Deployment script (run locally)
├── server/
│   ├── Dockerfile                  # API server build
│   ├── Dockerfile.worker           # BullMQ worker build
│   └── .env                        # Secrets (gitignored, on server only)
├── client/
│   └── Dockerfile                  # Next.js client build
├── nginx/
│   ├── asksales.conf               # Nginx config for asksales.ai
│   └── dev.asksales.conf           # Nginx config for dev.asksales.ai
├── deploy-staging.sh               # Staging-only deployment script
└── ecosystem.config.js             # DEPRECATED — PM2 config (reference only)
```
