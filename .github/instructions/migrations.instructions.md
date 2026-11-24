---
applyTo: 'server/**'
---

# Database Migration Instructions for GitHub Copilot

Historical holds in 571/572 set `app.business_system=on` transaction-locally
inside their hold SQL. This is the existing trusted migration context required
by `enforce_business_ownership`; it does not disable RLS or triggers, change
ownership, enable assistant runtime, or survive the runner's commit/rollback.

## Custom Migration Runner (NOT drizzle-kit migrate)

**CRITICAL**: The project uses a **custom migration runner** in `server/scripts/migrate.mjs`. NEVER use `drizzle-kit migrate`.

### Migration Commands
```bash
cd server
pnpm run migrate:up       # Run all pending migrations
pnpm run migrate:status   # Check status of all migrations
pnpm run migrate:down     # Rollback the last batch of migrations
pnpm run migrate:create <migration-name>  # Create a new migration

# Or use the runner directly:
node server/scripts/migrate.mjs up
node server/scripts/migrate.mjs status
node server/scripts/migrate.mjs down
node server/scripts/migrate.mjs create my_table_migration
```

## Environment Configuration

The runner selects `.env.production` only for `NODE_ENV=production`, otherwise
`.env.development`, then loads the private `server/.env`. Explicit database environment
variables retain precedence. `MIGRATION_DATABASE_URL` is preferred; separate
`DB_MIGRATION_USER`/`DB_MIGRATION_PASSWORD` select migration credentials, otherwise runtime
DB fields are used. Structured Pool fields preserve reserved password characters.
Connection, statement and lock waits are bounded at 10 seconds, 5 minutes and 15 seconds;
review long-running migrations before deployment rather than retrying blindly.

`status` is read-only even when the tracking table does not exist. Every migration whose
`down()` refuses recovery must export `irreversible = true`. Rollback preflights the whole
batch and uses one transaction: a later failure rolls back preceding down SQL and history.
Do not remove irreversible markers to force a rollback. Shared advisory-lock changes are
owned by the separate Data workstream and must be integrated without dropping these safeguards.

## Migration File Format

Location: `server/migrations/NNN_descriptive_name.js` (e.g., `001_create_users_table.js`)

### Template
```javascript
export async function up(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS my_table (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS my_table;`);
}
```

## Migration Workflow

### CRM Configuration
- `312_crm_configuration.js` adds nullable JSONB `company_settings.crm_configuration` to the existing business profile table. Profiles without saved settings use the shared CRM defaults; no contact status keys are rewritten.
- Apply it with the custom migration runner before serving the CRM configuration API. Rollback removes the configuration column; verify rollback in an isolated test schema rather than a populated workspace.

### Creating a New Migration
1. Run migration create command:
   ```bash
   pnpm run migrate:create add_new_column_to_users
   ```
   This creates: `migrations/NNN_add_new_column_to_users.js`

2. Implement `up()` function:
   ```javascript
   export async function up(client) {
     await client.query(`
       ALTER TABLE users
       ADD COLUMN email_verified BOOLEAN DEFAULT FALSE;
     `);
   }
   ```

3. Implement `down()` function (for rollback):
   ```javascript
   export async function down(client) {
     await client.query(`
       ALTER TABLE users
       DROP COLUMN email_verified;
     `);
   }
   ```

4. Run the migration:
   ```bash
   pnpm run migrate:up
   ```

5. Verify it was applied:
   ```bash
   pnpm run migrate:status
   ```

### Checking Migration Status
```bash
pnpm run migrate:status
```
Output shows:
- Applied migrations (✓)
- Pending migrations (pending)
- Migration numbers and names

### Rolling Back
```bash
pnpm run migrate:down
```
This runs the `down()` function of the last applied migration batch.

## Common Migration Patterns

### Create Table
```javascript
export async function up(client) {
  await client.query(`
    CREATE TABLE users (
      id SERIAL PRIMARY KEY,
      email VARCHAR(255) UNIQUE NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

export async function down(client) {
  await client.query(`DROP TABLE IF EXISTS users;`);
}
```

### Add Column
```javascript
export async function up(client) {
  await client.query(`
    ALTER TABLE users
    ADD COLUMN last_login TIMESTAMP;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE users
    DROP COLUMN last_login;
  `);
}
```

### Create Index
```javascript
export async function up(client) {
  await client.query(`
    CREATE INDEX idx_users_email ON users(email);
  `);
}

export async function down(client) {
  await client.query(`
    DROP INDEX IF EXISTS idx_users_email;
  `);
}
```

### Create Foreign Key
```javascript
export async function up(client) {
  await client.query(`
    ALTER TABLE posts
    ADD CONSTRAINT fk_posts_user_id
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE posts
    DROP CONSTRAINT IF EXISTS fk_posts_user_id;
  `);
}
```

### Data Migration
```javascript
export async function up(client) {
  // Create new column
  await client.query(`
    ALTER TABLE users ADD COLUMN full_name VARCHAR(255);
  `);
  
  // Copy/transform data
  await client.query(`
    UPDATE users
    SET full_name = CONCAT(first_name, ' ', last_name);
  `);
  
  // Drop old columns
  await client.query(`
    ALTER TABLE users
    DROP COLUMN first_name,
    DROP COLUMN last_name;
  `);
}

export async function down(client) {
  await client.query(`
    ALTER TABLE users
    ADD COLUMN first_name VARCHAR(255),
    ADD COLUMN last_name VARCHAR(255);
  `);
  
  await client.query(`
    UPDATE users
    SET first_name = SPLIT_PART(full_name, ' ', 1),
        last_name = SPLIT_PART(full_name, ' ', 2);
  `);
  
  await client.query(`
    ALTER TABLE users
    DROP COLUMN full_name;
  `);
}
```

## Related Drizzle Schema Files
After creating a migration, if it adds/modifies tables:
1. Create or update schema file in `server/models/<table-name>/schema.ts`
2. Export the table from `server/models/allSchemas.ts`
3. Update associations in `server/associations/` if needed

## Migration Best Practices
- **Keep migrations small and focused** - one logical change per migration
- **Always include down() function** - for rollback capability
- **Test rollback locally** - ensure down() function works
- **Use IF EXISTS/IF NOT EXISTS** - prevents errors if migration runs twice
- **Write comments** for complex migrations
- **Never assume data state** - always check conditions in data migrations
- **Include CASCADE constraints** for related tables
- **Test in development first** before running on production

## AI Visibility migration note

Migration `186_harden_ai_visibility_profile_wallet_and_monitoring.js` is
backward-compatible. It links an existing AI Visibility workspace to a Business
Profile only when the owned website domain matches exactly, preserves ambiguous
records as `legacy`, records immutable audit inputs, and adds unique monitoring
period protection. Run it before rebuilding API and worker services.

Migration `188_ai_visibility_website_search_and_direct_billing.js` adds reusable
`website_search` workspaces, direct/reservation billing-mode compatibility, and
unique wallet-usage and website-domain indexes. It is backward compatible and
must be applied before deploying the matching API and worker bundles.

## MSG91 SMS verification and delivery receipts

Migration `313_msg91_provider_verification.js` adds `msg91` to the provider verification platform allowlist and a business/user-scoped unique index on MSG91 delivery receipt keys in `webhook_events`. Apply it before the matching API and worker deployment with the custom runner. Rollback retains immutable MSG91 verification history and applies the old platform allowlist to new writes with `NOT VALID`. The up/down path and receipt deduplication are tested in a disposable local schema by `MSG91_LOCAL_QA=1 pnpm test --runInBand tests/msg91DeliveryPostgres.test.ts` from `server`.

## Troubleshooting

### Migration Stuck
If a migration appears stuck:
```bash
# Check status
pnpm run migrate:status

# Manually check migration table in DB
psql -h localhost -U postgres -d salesmarketing
SELECT * FROM js_migrations;
\q
```

### Rollback a Specific Migration
The custom runner supports only the latest complete batch. Do not delete tracking
rows or run an earlier migration's down SQL independently: that bypasses the shared
session lock, irreversible preflight and atomic batch boundary. Preserve the current
schema/history evidence and have the owner review a forward repair or compatible
recovery plan before making any changes.

### Lost Down History
Compare the deployed immutable release artifact, actual schema and recorded tracking
history. Preserve that evidence and escalate missing or incompatible down history for
owner review; do not guess SQL or rewrite the ledger. Migration checksum policy and
any historical baseline repair require the separate Data-owner decision.

## Production Migration Strategy
1. **Test migrations in development** - always test locally first
2. **Backup production database** before running migrations
3. **Schedule during low-traffic window** - early morning UTC
4. **Monitor migration progress** - long-running migrations may need indexes
5. **Rollback plan** - have down() functions ready if issues arise
6. **Verify after completion** - check app functionality post-migration

## Migration Files Location
`/var/www/salesmarketing/server/migrations/` on production server

## Instagram automations

Migration `318_instagram_private_reply_budget_index.js` requires 316 and adds a partial index on business/user/time/run for private-reply intents. It stores no new data; its rollback only removes the index. Up/down and hourly-budget concurrency are verified with the isolated Instagram runtime suite.

Migration `316_instagram_automations.js` adds account-scoped profile drafts/publications, rules, durable executions, and provider-effect receipts. It registers all four tables in `business_scope_tables` and applies forced RLS plus ownership guards. `reserved_at` records quota reservation time; `sync_remove` preserves an interrupted removal intent. Apply this migration before the matching API/worker code, including when rollout is disabled.

Migration 316 checks for the isolation/membership functions and registry from migrations 299 and 304 before creating tables. A database missing them cannot serve this feature; do not replace ownership checks with permissive placeholder functions. Migration 299 affects the full ownership graph and has no safe automatic rollback, so verify its prerequisites and coordinate that upgrade before applying 316 to an existing database.

The up/down path and real RLS/runtime concurrency cases run in a disposable local schema with `INSTAGRAM_AUTOMATIONS_LOCAL_QA=1` and `tests/instagramAutomationRuntimePostgres.test.ts`. This test loads only `.env.development` and rejects a nonlocal database host. Rollback deletes automation configuration/history and must be coordinated with an API/worker rollback; it does not remove settings already published to Meta.

## Storage workspace indexes

`320_storage_workspace_indexes.js` adds partial indexes for selected-profile recent/size sorting and expired Trash lookup. The workspace reuses existing JSON metadata and quota accounting; no columns or capacity backfill are required. Migration identity is the full filename (other 320-prefixed migrations are independent). Run it through the custom migration runner before the corresponding API/worker rollout. `down` removes only these three indexes and leaves file metadata intact. Validate up/down and forced-RLS behavior in a disposable local schema with `STORAGE_WORKSPACE_LOCAL_QA=1 pnpm --dir server test --runInBand tests/storageWorkspacePostgres.test.ts` from the repository root. Trash continues to consume quota until permanent deletion; the existing storage cleanup cron enforces the 30-day retention period.

## Knowledge authoring recovery

`400_knowledge_authoring_recovery.js` adds nullable `knowledge_base.creation_request_key` and a unique tenant/profile/request-key index. Apply it with the custom migration runner before serving the resumable Q&A batch authoring API. Batch clients must retain the same `requestId` or `Idempotency-Key` and unchanged payload when resuming partial indexing receipts; changed payloads/counts return a conflict instead of creating another source batch.

The migration is additive and preserves existing source rows and RLS policies. `down()` removes the column/index only while no recovery identities exist; after use it refuses rollback so durable retry identities are retained and a forward migration is required. `tests/knowledgeRemediationPostgres.test.ts` tests up/down/up on an empty disposable schema, refusal after use, concurrent retry identity and processing claims. Run this fixture with `AUDIT_LOCAL_POSTGRES=1` and a synthetic isolated local database; never load production credentials for it. Full migration-chain/RLS integration remains a separate gate.

### Data integrity migrations 330 and 331

`330_crm_import_recovery.js` adds import fingerprint/progress and unique per-row receipts. `331_hotel_room_import_identity.js` adds exact `(hotel_id,name)` room identity. Each preflights historical duplicates and aborts with an owner-review instruction; neither merges/deletes customer history. Apply through the custom runner before the matching API code. `up`, `down`, `mark-applied` and initial tracking-table creation share lock 8623 and exit 2 when busy. Verify only in disposable PostgreSQL with `DATA_INTEGRITY_LOCAL_QA=1` and `tests/dataIntegrityMigrationsPostgres.test.ts`; no production migration is authorized by the local verification.


## Tenant integrity migrations

New tenant drafts340–342 follow historical329 and depend on existing capacity/subscription/assistant tables. See `docs/tenant-billing-integrity.md` for ordering, retained data and forward-only capacity rollback policy. Do not renumber deployed history.

Migration `344_wallet_recharge_order_origins.js` follows342 and the existing
account-isolation registry;343 remains an excluded billing-policy draft. Apply344
before the matching wallet API. It retains immutable actor/payer/quote/credential
references for new checkouts, extends credential-history protection and grants
the runtime SELECT/INSERT only. No credential secrets or historical orders are
backfilled. Its rollback refuses to remove recovery identities; use a reviewed
forward migration. Verify with the recharge PostgreSQL fixtures against a
disposable local database, never production payment data.
## Durable generic SMS consumer claims

Migration `351_sms_queue_delivery_claims.js` uses the Campaign-reserved range and
requires the existing isolation/membership functions from 299/304. It adds a
scoped immutable intent/actor/payer hash, token-fenced preparation/provider start,
atomic reservation reference and retained outcome/receipt evidence. It registers
forced RLS and ownership guards using the existing Tenant contract. Rollback is
explicitly forward-only to preserve uncertainty and provider-start evidence.
Apply only with the matching fully reconciled consumer; local draft testing is
not production migration authorization. Verify actual registered-worker process
loss/recovery and final provenance after adapter preparation with mocked effects.


## Campaign manual follow-up isolation (572)

Apply `572_campaign_manual_follow_ups.js` after `571_hold_unreviewed_customer_delivery.js` and the existing business isolation/workspace migrations, before starting the matching API and workers. It creates campaign/channel heads, immutable sequence/template revisions and immutable recipient reviews, all registered in `business_scope_tables` with forced RLS/parent ownership guards. The Drizzle declarations live in `models/campaignManualFollowUps/schema.ts` and are exported from `allSchemas.ts`. No historical campaign or recipient is assigned by inference.

572 marks ambiguous unsent global-template/inline manual deliveries for owner review and cancels old social manual schedules; provider-started/uncertain and genuine generated follow-ups retain their reconciliation state. These holds are not automatically restored. The migration is marked `irreversible = true` for whole-batch rollback preflight. Retain immutable history and roll forward; do not restore workers that consume live global manual templates. The release owner must stop old writers and retain the verified pre-migration backup. No assistant/runtime/provider settings are changed.

Local targeted validation: `MANUAL_FOLLOW_UP_QA_DATABASE_URL` must be an explicit loopback PostgreSQL URL for `tests/campaignManualFollowUpsPostgres.test.ts`. The fixture executes migration DDL/checks and service SQL in TEMP tables, substitutes test ownership helpers and omits grants to avoid changing shared cluster roles. A separately named disposable synthetic schema exercises conflicting saves on independent PostgreSQL connections and is removed after that case. It does not attest deployed runtime-role RLS; that belongs to deployment schema/readiness verification.
