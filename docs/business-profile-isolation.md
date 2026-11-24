# Business profiles

Each account can create several business profiles. The chooser, app bar and sidebar select the current business. The account's default profile is a separate preference. Selection is stored per browser tab; switching opens a fresh dashboard and clears in-memory queries, page state and realtime connections. New profiles become the current business immediately.

## Ownership

- Business requests carry `X-Business-Profile-Id`. The server verifies account ownership and rejects conflicting selectors. Requests from older clients without a selector use the account's default.
- `businessContext.ts` carries immutable ownership through asynchronous work. Queued jobs, OAuth state, public capabilities and verified provider callbacks restore their original business before processing. Ambiguous legacy jobs fail instead of following a changed default.
- Migration 299 adds ownership to the business data graph, including campaigns, content, leads, CRM, outreach, support, knowledge, integrations, analytics and files. Existing explicit ownership and parent relationships take precedence over the legacy default during backfill.
- PostgreSQL uses a restricted runtime role, forced row-level security and ownership triggers for ORM and raw SQL. Reads, updates, deletes, inserts and parent references are checked. Business ownership cannot be reassigned by updating a record.
- Authentication, account preferences, wallet, subscription and billing registries remain account scoped. Approved global templates remain readable. Unassigned callback diagnostics are accessible only to system administration.
- Cache keys, drafts, request receipts and websocket queues include the business. Scoped services must run inside `withBusinessScope`; system access is reserved for explicit administration and narrow ownership lookups.

## Rollout

1. Back up the database. Stop API instances and workers while applying the migration; it locks business tables while backfilling ownership.
2. Apply earlier pending migrations, including 297 and 298, then run the normal JS migration runner for `299_business_profile_isolation.js` using the intended database's migration credentials. For example, from `server`, `node scripts/migrate.mjs up 299_business_profile_isolation.js` runs that migration only. Confirm the database target first.
3. The migration login needs permission to create and grant `salesmarketing_business_runtime`. If the application uses a different login, set `DB_RUNTIME_USER` to that login for the migration (otherwise `DB_USER` is used). The application login must be able to `SET ROLE salesmarketing_business_runtime`.
4. Review `business_scope_migration_issues`. Unresolvable legacy rows stay hidden from businesses. Contradictory account or parent ownership aborts the transaction and requires correction before retrying.
5. Deploy the API and worker builds together. Startup checks require the ownership registries, policies and triggers. Reconnect provider authorization flows initiated before the rollout if their business binding has expired.

The migration cannot be automatically reversed without removing ownership protections. Use a forward fix or restore a verified backup with the matching previous application version.

## Adding tables

Every new public table must be explicitly classified. For an account table, add a registry entry to `business_scope_accounts`. For a business table, add `business_profile_id` with the current-business default, the profile foreign key/index, a `business_scope_tables` entry with its owning account and parent links, forced RLS with `business_isolation`, and the before/after ownership guards. Grant runtime table and sequence access explicitly in the migration. Future tables receive no automatic runtime privileges. `assertBusinessScopeSchema` rejects unclassified or unprotected tables at startup.

## Verification

Focused client checks:

```sh
pnpm --dir client exec vitest run src/__tests__/businessProfileSwitch.test.tsx src/__tests__/authTenantCacheIsolation.test.tsx src/__tests__/websocketContext.test.tsx src/__tests__/websocketService.test.ts src/__tests__/api.test.ts src/__tests__/conversationAttempt.test.ts src/__tests__/socialPublishingHelpers.test.ts src/__tests__/setupFlow.test.tsx
```

Request, job and transaction boundaries:

```sh
pnpm --dir server test --runInBand tests/businessScopeBoundaries.test.ts tests/realtimeGateway.test.ts tests/chat.test.ts tests/leadInputSnapshot.test.ts tests/adminProposalTemplatePublishing.test.ts
```

For the backfill regression, restore a schema-only copy through migration 296 into a **new disposable database** named `salesmarketing_business_isolation_qa_<suffix>` on the local `/tmp` PostgreSQL socket. The script installs migrations 297–299 and fixtures; do not run it against an application database or reuse a database already migrated by this script.

```sh
BUSINESS_ISOLATION_TEST_DATABASE=salesmarketing_business_isolation_qa_<suffix> node server/scripts/verify-business-profile-isolation.mjs
BUSINESS_ISOLATION_TEST_DATABASE=salesmarketing_business_isolation_qa_<suffix> pnpm --dir server test --runInBand tests/businessProfileIsolationPostgres.test.ts
```

For a reproducible test without a historical schema dump, run from the repository root:

```sh
node server/scripts/test-business-isolation-local.mjs
```

This requires the local Docker daemon and server dependencies. It creates a fresh
PostgreSQL 16 container with networking disabled, no published ports, and an
exclusively owned Unix socket. It loads only synthetic tables, applies the unchanged
migration 299 and the canonical earlier support-team trigger, then runs the business
isolation, authenticated lead-export, request/job boundary and authorization suites.
The container and socket directory are removed afterward. Application environment
files and external databases are never loaded. Set
`BUSINESS_ISOLATION_QA_RESULTS_FILE` to an absolute local path for Jest JSON evidence.

The synthetic schema covers 13 business tables, not the full application schema or
migration chain. Its real PostgreSQL checks cover forced RLS, ownership guards,
cross-profile references, runtime role restrictions, pool reuse after SQL errors,
savepoints, abandoned transactions, scope cleanup and read-only global templates.
The export suite uses real JWT verification, middleware, HTTP, SQL and runtime RLS,
with synthetic account lookups and its own explicitly defined test policy. The two
request/job authorization suites use mocked database responses. These checks do not
attest production configuration, provider delivery, all application tables or the
historical backfill described above.

Browser tests use mocked API responses and perform no real provider operations. Start a local client dev server, then:

```sh
E2E_BASE_URL=http://127.0.0.1:3109 E2E_SKIP_WEBSERVER=1 pnpm --dir client exec playwright test e2e/business-profiles.spec.ts
```

### Local verification, 2026-09-26

- Schema-only backfill regression: preserved explicit non-default ownership and completed/uncertain conversation receipts; 244 business tables protected, zero migration issues in the fixture database.
- 59 server tests passed, including real PostgreSQL isolation, request/job boundaries, realtime filtering and related regressions.
- 101 client tests passed, including session restoration, selection, setup, request headers, drafts and websocket behavior.
- Four Playwright tests passed across desktop and mobile: chooser, app bar, sidebar, profile creation and website-analysis ownership. Browser API responses were mocked.
- Full server and client TypeScript checks passed. API and worker production bundles built successfully.

Application and production databases were not migrated during this verification. Follow the rollout steps before starting this code against an existing database.
