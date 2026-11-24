# AskSales

AskSales uses a Next.js client and a Node.js API and workers, backed by PostgreSQL and Redis.

## Local development

Use Node.js 24.18.1 and pnpm 10.30.3. Run `corepack enable` and `pnpm install --frozen-lockfile` from the repository root. Configure PostgreSQL, Redis, and API settings in your local `server/.env`. See `server/env.ts` and `docker-compose.yml` for the environment variables used by the application. Run `pnpm --dir server dev` and `pnpm --dir client dev` to start the two development servers.

## Continuous integration

Cross-layer regression runs the same self-contained desktop and mobile browser tests on pull requests, staging, and production releases. GitHub Actions attaches a Playwright report when the browser tests fail.

The larger `client/e2e` directory also contains audits that need a dedicated Playwright configuration or disposable local fixtures. Run those with the associated `client/playwright.*.config.ts` and the fixture setup documented by the test. The local `pnpm --dir client test:e2e` command remains available.

## Production releases

A push to `main` runs the Production release workflow on GitHub-hosted runners. The production server deploys the exact head of `main` after those checks pass. It keeps its environment file locally and runs the existing backup, migration, and health checks.

After resolving a server release failure, re-run the successful workflow for the current `main` commit. Server operators can inspect `journalctl -u asksales-main-release.service`.
