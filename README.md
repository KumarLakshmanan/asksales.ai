# AskSales

AskSales uses a Next.js client and a Node.js API and workers, backed by PostgreSQL and Redis.

## Local development

Use Node.js 24.18.1 and pnpm 10.30.3. Run `corepack enable` and `pnpm install --frozen-lockfile` from the repository root. Configure PostgreSQL, Redis, and API settings in your local `server/.env`. See `server/env.ts` and `docker-compose.yml` for the environment variables used by the application. Run `pnpm --dir server dev` and `pnpm --dir client dev` to start the two development servers.

## Production releases

A push to `main` runs the Production release workflow on GitHub-hosted runners. The production server deploys the exact head of `main` after those checks pass. It keeps its environment file locally and runs the existing backup, migration, and health checks.

After resolving a server release failure, re-run the successful workflow for the current `main` commit. Server operators can inspect `journalctl -u asksales-main-release.service`.
