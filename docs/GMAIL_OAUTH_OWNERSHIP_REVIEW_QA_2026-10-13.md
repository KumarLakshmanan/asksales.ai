# Gmail ownership/RLS review correction — 2026-10-13

This follow-up corrects the ownership and HTTP response gaps found in independent review of `ce7d46640d0ee75c62984a27b1de1a1c0c760988`. It remains on `fix/gmail-oauth-connection-v8`; the parent owns v8 integration. The [initial report](GMAIL_OAUTH_CONNECTION_QA_2026-10-13.md), original source/evidence manifest and all earlier QA artifacts remain unchanged as historical evidence.

## Proven ownership defect

The intended mailbox model is one active normalized Gmail mailbox connection across all businesses. Reconnecting that mailbox in its owning business updates the active row. Another business, including one owned by the same user, must not acquire a competing active connection because inbound Gmail notifications identify a mailbox rather than a business. Existing duplicate/unowned rows must be reviewed, not silently moved or deleted.

The old upsert's "global" conflict SELECT executed in an already-open business transaction. Migration 299 FORCE RLS hid other businesses. The `user_id <>` predicate also excluded sibling businesses sharing the user. `scopedPool` captures scope at checkout, so an AsyncLocalStorage `withSystemScope` around a transaction SELECT cannot change database visibility. The old query's mocks verified SQL shape but did not prove RLS behavior.

The new real-PostgreSQL baseline run reproduces all three failures on the prior committed head: sibling-business connection succeeds, different-owner connection succeeds, and all three concurrent connection attempts win. [Baseline log](../qa/gmail-oauth-connection-2026-10-13/follow-up-ownership-rls/logs/rls-baseline.log.gz).

## Corrected atomic boundary

`ChannelCredentialModel.upsert` now requires the authorized business scope for Gmail and rejects contradictory supplied owner/profile identifiers before starting SQL. It pins the write's businessProfileId to that scope.

One **Read Committed** transaction holds the normalized mailbox advisory lock through conflict read, tenant write and commit. On that same checked-out client, the existing repository `app.business_system` policy is enabled only for one parameterized query returning a conflict boolean. The query detects a foreign business/owner, an unowned legacy row or multiple active mailbox records. It returns no foreign IDs, credentials or tokens. A `finally` restores `app.business_system=off` before any INSERT/UPDATE. Read/restore failure aborts the transaction; rollback clears the transaction-local settings. No new pool checkout, production role grant, policy change, migration or bypass-RLS privilege is introduced.

The reconnect lookup prefers an active mailbox match before inactive legacy case variants. This prevents reactivating an inactive duplicate while an active same-business connection exists. Existing conflicts return the stable `GMAIL_MAILBOX_ALREADY_CONNECTED` code and a generic administrator-review message; no automatic reassignment/deletion occurs.

This is an application connection/upsert invariant. The database still has its existing business-scoped uniqueness; raw administrative writes bypassing this model are not claimed to gain a global unique constraint. Any future global constraint requires an independently reviewed legacy-data reconciliation.

## Provider reconnect must preserve app authentication

The manual `/api/gmail/oauth/refresh` `invalid_grant` response is now HTTP **409** with `GMAIL_RECONNECT_REQUIRED`. Only the captured Gmail credential is deactivated. Genuine app authentication failures retain HTTP 401. The shared API client treats 401 as application logout, so returning 401 for provider revocation unnecessarily cleared a valid user/token/business session.

Exact POST/refresh transport unit tests verify that the 409 preserves the token, user and selected business, dispatches no unauthorized event and permits later authenticated reads. A genuine 401 remains a control that clears the app session. Browser verification exercises the real shared API client/AuthProvider via the current **Restart sync** action (`POST /watch`) receiving that same mocked 409/code; the current product has no UI caller of POST/refresh. These endpoints are stated separately rather than claiming browser coverage of a nonexistent refresh button.

## Real database verification and final checks

A new disposable **PostgreSQL 17.11** cluster was extracted/initialized entirely under `/tmp`; it accepted only its private Unix socket and loaded no application environment files or existing database credentials. Each test created an exclusively owned random schema and removed it afterward. The fixture uses actual Drizzle and the production `createBusinessScopedPool`, actual `salesmarketing_business_runtime` NOBYPASSRLS, FORCE RLS with the migration 299 policy expression, and the **actual ownership trigger function extracted from migration 299**. It uses the model's real column definitions and business-scoped uniqueness. It does not claim to apply every migration or inspect production.

The nine real-RLS checks cover hidden sibling rows/context-only elevation, different-owner conflicts, active/inactive reconnect choice, concurrent single-winner behavior, a disconnected prior business, preexisting duplicate/unowned records, rejected foreign supplied identity and tenant-only writes, failed conflict-read rollback/pool reuse, and a single-connection pool with an otherwise Repeatable Read default. A temporary fixture trigger rejects any model write while system visibility is enabled; successful INSERT and reconnect UPDATE prove restoration occurred. Another fixture trigger verifies the model transaction is Read Committed.

| Final check | Result | Evidence |
| --- | --- | --- |
| Server unit/HTTP/real-PG regression suite | 102 tests, 11 suites passed; includes nine real RLS tests | [log](../qa/gmail-oauth-connection-2026-10-13/follow-up-ownership-rls/logs/server-regressions-final-2.log.gz) |
| Client regression suite | 77 tests, five suites passed | [log](../qa/gmail-oauth-connection-2026-10-13/follow-up-ownership-rls/logs/client-unit-final.log.gz) |
| Full server/client types | Passed | [server](../qa/gmail-oauth-connection-2026-10-13/follow-up-ownership-rls/logs/server-typecheck-final-2.log.gz), [client](../qa/gmail-oauth-connection-2026-10-13/follow-up-ownership-rls/logs/client-typecheck-final.log.gz) |
| Changed server/client source/tests lint | Passed, zero errors/warnings | [server](../qa/gmail-oauth-connection-2026-10-13/follow-up-ownership-rls/logs/server-lint-final-2.log.gz), [client](../qa/gmail-oauth-connection-2026-10-13/follow-up-ownership-rls/logs/client-lint-final.log.gz) |
| New desktop/mobile session browser regression | 2/2 passed | [summary](../qa/gmail-oauth-connection-2026-10-13/follow-up-client-session-preservation/summary.json) |
| Full current-source Gmail browser scenarios | 10/10 desktop/mobile passed; tested source hashes unchanged | [summary/hashes](../qa/gmail-oauth-connection-2026-10-13/follow-up-client-session-preservation/full-current-10-summary.json) |

The first real RLS fixture run had six passes/two failures: its own unscoped seed writes were correctly rejected by the production ownership trigger. The fixture seed connection was corrected to use explicit local system context; the failed log remains retained. The prior-head baseline's three failures remain retained as proof of the defect. All original 46 evidence files were hash-checked unchanged. Fixture-schema count was zero afterward; the private cluster was stopped. [Cleanup log](../qa/gmail-oauth-connection-2026-10-13/follow-up-ownership-rls/logs/postgres-fixture-cleanup-check.log.gz).

## Remaining operator work

Production's Gmail failure remains user-reported, without a confirmed deployment URL or reproduced live OAuth error. The initial report's sanitized OAuth/frontend/Redis/encryption/provider configuration checks still apply. The new code relies on the existing migration 299 runtime role/policies; deployment operators should confirm that schema contract separately.

No production mailbox inventory was read, so no claim is made about the presence or count of live duplicates. A mailbox conflict requires an authorized administrator to review its existing connection records and decide on reconciliation. This task performs no such customer mutation. No live OAuth grant, email, campaign, follow-up, provider setting, credentials or deployment was changed. All database writes were disposable local fixtures.

[PostgreSQL RLS semantics](https://www.postgresql.org/docs/17/ddl-rowsecurity.html) and [Read Committed snapshots](https://www.postgresql.org/docs/17/transaction-iso.html) support the database contract; the regression evidence demonstrates its actual behavior with this repository's adapter.
