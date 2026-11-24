# ─── Client (Next.js) Dockerfile ───────────────────────────────────────────────
# Multi-stage build with standalone output for minimal image size
# Build context: monorepo root (context: . in docker-compose)

# ─── Stage 1: Install dependencies ────────────────────────────────────────────
FROM node:24.18.1-alpine AS deps

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# Copy workspace root files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy client package.json
COPY client/package.json ./client/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# ─── Stage 2: Build the application ──────────────────────────────────────────
FROM node:24.18.1-alpine AS builder

RUN corepack enable && corepack prepare pnpm@10.30.3 --activate

WORKDIR /app

# Copy workspace root files
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./

# Copy client package.json
COPY client/package.json ./client/

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Copy client source
COPY client/ ./client/

# Copy monorepo-shared contracts imported by the client bundle.
COPY shared/ ./shared/

# Build-time env vars (NEXT_PUBLIC_* are inlined at build time)
ARG NEXT_PUBLIC_API_URL=
ARG NEXT_PUBLIC_APP_URL=
ARG NEXT_PUBLIC_WS_URL=
ARG NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID=
ARG BACKEND_URL=http://api:8080
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
ENV NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL
ENV NEXT_PUBLIC_WS_URL=$NEXT_PUBLIC_WS_URL
ENV NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID=$NEXT_PUBLIC_GOOGLE_SIGN_IN_CLIENT_ID
ENV BACKEND_URL=$BACKEND_URL
ENV NEXT_TELEMETRY_DISABLED=1

# Next's persistent webpack cache can retain stale route/chunk references when
# app-router pages are also consumed as workspace components. Build from a
# clean .next directory so prerendered HTML always references this image's
# current client chunks.
RUN cd client && rm -rf .next && pnpm build

# ─── Stage 3: Production runner ──────────────────────────────────────────────
FROM node:24.18.1-alpine AS runner
ARG RELEASE_SHA=unknown
LABEL org.opencontainers.image.revision=$RELEASE_SHA
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV BACKEND_URL=http://api:8080

# Security: non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone output first
RUN mkdir .next && chown nextjs:nodejs .next
COPY --from=builder --chown=nextjs:nodejs /app/client/.next/standalone ./

# Copy public assets and static files to both root and client subfolder (with correct owner nextjs:nodejs)
COPY --from=builder --chown=nextjs:nodejs /app/client/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/client/public ./client/public
COPY --from=builder --chown=nextjs:nodejs /app/client/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/client/.next/static ./client/.next/static

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

HEALTHCHECK --interval=30s --timeout=10s --retries=3 \
  CMD wget -qO- http://0.0.0.0:3000/ || exit 1

CMD ["node", "client/server.js"]
