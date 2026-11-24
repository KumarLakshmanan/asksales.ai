# ─── Build stage ───────────────────────────────────────────────────────────────
# Uses esbuild to bundle the server into a single ESM file
# Build context: monorepo root (context: . in docker-compose)
FROM node:24.18.1-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# Copy workspace root files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy server package.json
COPY server/package.json ./server/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Remove pnpm-created symlinks in server/node_modules before copying source
RUN rm -rf server/node_modules

# Copy server source
COPY server/ ./server/

# Copy monorepo-shared runtime contracts imported by server source.
COPY shared/ ./shared/

# Build with esbuild (bundles local code, externalizes node_modules packages)
RUN cd server && npx esbuild index.ts \
    --platform=node \
    --packages=external \
    --bundle \
    --format=esm \
    --outdir=dist && \
    npx esbuild utils/browserAutomation.ts \
      --platform=node --packages=external --bundle --format=esm \
      --outfile=dist/browserAutomation.js && \
    npx esbuild scripts/migrate-knowledge-v2.ts \
    --platform=node \
    --packages=external \
    --bundle \
    --format=esm \
    --outfile=dist/migrate-knowledge-v2.js && \
    npx esbuild scripts/run-knowledge-maintenance.ts \
    --platform=node \
    --packages=external \
    --bundle \
    --format=esm \
    --outfile=dist/run-knowledge-maintenance.js && \
    npx esbuild scripts/migrate-support-playbook-template.ts \
      --platform=node \
      --packages=external \
      --bundle \
      --format=esm \
      --outfile=dist/migrate-support-playbook-template.js && \
    npx esbuild scripts/publish-code-support-template.ts \
      --platform=node \
      --packages=external \
      --bundle \
      --format=esm \
      --outfile=dist/publish-code-support-template.js && \
    npx esbuild scripts/diagnose-support-preview.ts \
      --platform=node \
      --packages=external \
      --bundle \
      --format=esm \
      --outfile=dist/diagnose-support-preview.js && \
    npx esbuild scripts/backfill-crm-channel-identities.ts \
      --platform=node \
      --packages=external \
      --bundle \
      --format=esm \
      --outfile=dist/backfill-crm-channel-identities.js && \
    npx esbuild scripts/sync-staging-meta-oauth.ts \
      --platform=node \
      --packages=external \
      --bundle \
      --format=esm \
      --outfile=dist/sync-staging-meta-oauth.js && \
    npx esbuild scripts/check-social-echo-subscriptions.ts \
      --platform=node \
      --packages=external \
      --bundle \
      --format=esm \
      --outfile=dist/check-social-echo-subscriptions.js && \
    npx esbuild scripts/recover-whatsapp-app-rate-limits.ts \
      --platform=node --packages=external --bundle --format=esm \
      --outfile=dist/recover-whatsapp-app-rate-limits.js && \
    npx esbuild scripts/requeue-whatsapp-marketing-retries.ts \
      --platform=node --packages=external --bundle --format=esm \
      --outfile=dist/requeue-whatsapp-marketing-retries.js


# ─── Runtime stage ─────────────────────────────────────────────────────────────
# Scrapling's Python browser dependencies require glibc (Alpine uses musl).
# Chromium's sandbox must run on a supported glibc distribution. The Alpine
# musl 1.2.6 pwritev2 path crashes inside Chromium's GPU seccomp sandbox.
FROM node:24.18.1-bookworm-slim AS runtime

ENV BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV META_AD_LIBRARY_CHROME_PATH=/usr/bin/chromium
ENV META_AD_LIBRARY_PYTHON=/opt/scrapling/bin/python

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
# ffmpeg provides both ffmpeg and ffprobe, required by the media
# transcoding worker before a publish job can be accepted.
RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium ffmpeg python3 python3-venv wget ca-certificates && \
    rm -rf /var/lib/apt/lists/*

COPY server/scripts/requirements-scrapling.txt /tmp/requirements-scrapling.txt
RUN python3 -m venv /opt/scrapling && \
    /opt/scrapling/bin/python -m pip install --no-cache-dir -r /tmp/requirements-scrapling.txt

WORKDIR /app

# Security: non-root user
RUN groupadd --gid 1001 appgroup && useradd --uid 1001 --gid appgroup --create-home appuser

# Copy workspace root files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy server package.json
COPY server/package.json ./server/

# Install production dependencies only
RUN pnpm install --frozen-lockfile --prod && \
    chown -R appuser:appgroup /app

# Copy built output
COPY --from=builder --chown=appuser:appgroup /app/server/dist/ ./server/dist/

# Copy runtime data files (actor schemas, migrations, drizzle config, scripts)
COPY --chown=appuser:appgroup server/data/ ./server/data/
COPY --chown=appuser:appgroup server/migrations/ ./server/migrations/
COPY --chown=appuser:appgroup server/scripts/ ./server/scripts/

# Create directories for uploads and exports
RUN mkdir -p server/uploads exports && \
    chown appuser:appgroup server/uploads exports

USER appuser

# Environment
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/health || exit 1

# Keep revision metadata after filesystem layers so releases reuse dependencies.
ARG RELEASE_SHA=unknown
LABEL org.opencontainers.image.revision=$RELEASE_SHA

CMD ["node", "server/dist/index.js"]
