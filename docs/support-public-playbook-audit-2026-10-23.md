# Support AI public widget and playbook audit — 2026-10-23

## Publication follow-up

The parent authorized publishing this same audit to **`handoff/audit-20261023-support-widget`**. Fetched v8 again at **`c33cab7fece727585abaaaaa8512208413c34c7f`** and replayed the four preserved local commits onto it without conflicts. All original 40 audit-file blobs were identical after replay; the three product patches are unchanged. The final verification commit additionally retains this follow-up and its new evidence. Original branch `audit/support-ai-20261023` and the original bundle/tip remain preserved.

Actual changed-file comparison against the requested handoffs found **zero overlaps**: Support `db37aa7810d331b5e5410ebac8d6695c6bd9a610` (17 files), AI `ea798a76a712879be6e084a51b0610129f781254` (18), UI `75b9bd1dba2775a3677babea6d1280a19b23f758` (29), Tenant `7b54373dd2e9d91c81bd0a90f5dc607b4c08df8b` (55). Latest v8's four changed files also have zero overlap. Therefore no patch was discarded as a duplicate and no shared helper contract was needed. See `publication-overlap.json` for the exact manifests and source blob IDs.

The product-file manifest remains exactly:

- `server/controllers/supportWidgetController.ts`: whole-value positive PostgreSQL integer parsing for chat/history session IDs; completed no-op acknowledgement independent of the coordinated-turn flag.
- `client/src/app/support-widget/[token]/page.tsx`: clear the pending current-scope attempt and composer only on explicit New chat.

The supporting test change narrows the assistant-list mock in `client/e2e/support-ai-enhancements.spec.ts`; the three added test/helper files and one new component regression are enumerated in the handoff manifest. No ticket lifecycle, generic execution-budget/recovery, global guard/queue, central-scope, login/JWT or storage-lifecycle source was changed.

Exact publication source/test bytes were retested: **32 integration checks, 471 scoped server checks, 111 client tests and all 12 desktop/mobile browser checks passed**. Both builds, client types and changed-file lint passed. The new deeper PostgreSQL run reproduced the same **68 passes / 3 legacy assistant-context fixture failures**; server types reproduced the two existing settings-test errors. New `publication-*.log` files distinguish this verification from the original results below. Full server lint has one existing error and 2032 warnings. After moving disposable build outputs out of the source tree, full client lint has **one source error** (`client/e2e/settings-redesign.spec.ts:14`, `prefer-const`) and 184 warnings. The earlier 845-error count included generated output and must not be presented as application lint debt. The remaining source error is outside this patch and its file is changed by the named UI handoff. No lint configuration was relaxed. These are scoped verification results, not a global readiness claim.

The intended remote write is only the named handoff branch, without force; the parent remains the sole v8 writer. No deployment action or live-provider effect is authorized. Known workflows are main-only per parent guidance; external hooks remain unknown and were not inspected. No forbidden hook read was repeated. Final remote SHA, exact four publication commits, source manifest, bundle/checksum/size and push result are recorded in the external publication handoff after remote verification.

## Outcome and integration boundary

Fetched `origin/v8` at **35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7**. The saved environment was at `09fe888ec8bdd3fa12ccee0e047cd1d876306222`; preliminary checks on that older snapshot are not counted below. The fetched SHA matches the prior base supplied in the delegation. A filtered fetch succeeded after bounded full-pack transfers timed out. No remote write occurred.

The original audit used `/workspace/support-ai-v8`, branch `audit/support-ai-20261023`. Three confirmed public-widget defects were fixed sequentially and committed locally; the same worktree now holds the publication branch described above. Parent integration into v8 is pending. No migration was created; 540–549 remain unused. No Page was edited.

Production changes are confined to `server/controllers/supportWidgetController.ts` and `client/src/app/support-widget/[token]/page.tsx`. Ticket state/team ownership and approval execution/recovery code were not changed. The browser fixture correction changes `client/e2e/support-ai-enhancements.spec.ts`. New audit tests and evidence are listed below. Other owner manifests were unavailable during the original pass; the four requested handoffs have now been compared above. Broader combined integration remains with the parent.

No `AGENTS.md` or `.agents` skill files were present in either checkout. The applicable `.github/instructions/server.instructions.md` and `client.instructions.md` were read. The verification skill was used for tracing the browser/API/persistence boundary.

## Confirmed findings, in remediation order

### SW-01 — P2: malformed session IDs alias or create conversations

**Reproduced on fetched v8.** With a synthetic session 1 and its valid credential, history URLs ending in `1junk` or `1.5` returned session 1. Chat bodies with malformed IDs such as `garbage`, `0`, arrays and fractions could create a new session or reach dispatch. Out-of-range values returned 500 from PostgreSQL. This was not a credential bypass: a valid credential was still required when a parsed existing session was used.

**Fix:** parse the entire supplied value, permit numeric IDs and canonical decimal strings only, and bound IDs to PostgreSQL's positive integer range. Omitted/null chat IDs still create a conversation. Malformed supplied IDs now return 400 before controller database writes.

**Evidence:** `session-identity-v8-before.log`: 15 failures, 3 passes. `session-identity-after.log`: 24 passes after broadening invalid-input cases. The final integration run includes these regressions.

**Source commit:** `998637c43e2bdc6cccbfab4294d2dcf3fd9fd886`.

### SW-02 — P2: New chat can remain bound to an expired uncertain first request

**Reproduced in Chromium → actual HTTP adapter → PostgreSQL.** Seed an expired session with `client_session_key = widget:9:1:retry-session` and a tab-local uncertain first request carrying `retry-session`. Submit the restored message, receive the expired-conversation response, click New chat, and submit the same text. The second request reused `retry-session`, selected the expired record and failed again.

**Fix:** an explicit New chat clears the pending attempt for its current scope and clears the composer. Ordinary transient retries retain their identity.

**Evidence:** `widget-reset-v8-before.log` and `widget-reset-browser-before.log` fail before the fix. `widget-reset-after.log` passes 16 component/helper checks. The browser regression now creates a fresh database session, restores its history after reload, survives one injected HTTP 503 without losing the credential, submits with Enter, and checks normal zoom at 320/390/768/1440 widths. Public-widget screenshots are retained.

**Source commit:** `4b0096587144f62254a0e492db6bedd08e392c24`.

### SW-03 — P2: completed no-op retries incorrectly remain “processing”

**Reproduced through HTTP and PostgreSQL.** A dispatched `no_op` marked its user message completed and produced no assistant message. Repeating that request with the returned session credential returned 409 “still being processed” indefinitely when coordinated turns were disabled, despite the persisted completion.

**Fix:** acknowledge the existing completed user message without an assistant message for both legacy and coordinated widget modes. This does not run dispatch, execute an approval or change recovery ownership.

**Evidence:** `noop-retry-before.log`: expected 202, received 409. `noop-retry-after.log` passes. The final regression asserts one dispatch and one persisted message across the retry. In-progress duplicate requests remain 409; the concurrent-request fixture holds dispatch open to verify that boundary deterministically.

**Source commit:** `4b0ae546e69e47a73c6632985885e6227ce3e53e`.

### QA-01 — corrected browser fixture, not a production finding

The existing support AI browser suite mocked `assistants**` with a list response. That intercepted `/assistants/catalog`, omitted `permissions`, and caused `CommandPalette` to read `permissions.canManage` from undefined. The initial run had 10 passes and two chat failures. Narrowing the mock to the list endpoint preserves the complete shared catalog fixture. Both previously failing desktop/mobile chat checks then passed, with unchanged retry/export/rename/responsive/dark-mode assertions. See `dashboard-browser.log` and `dashboard-chat-browser-after.log`.

## Inventory

`audit/support-ai-2026-10-23/inventory.json` enumerates **9 pages, 57 APIs (including explicit owner-boundary APIs), 31 pipeline stages**, orchestration services, model/table mappings, configuration names and jobs. Inventory is static evidence, not a claim every entry was exercised.

| Domain | Pages/features | Implementation/API/model surface |
|---|---|---|
| Support AI workspace | Chat, reports, answer quality, embed/install, widget settings; workspace-scoped navigation | `/dashboard/support-ai/{chat,reports,quality,embed,widget-settings}`; owner chat/report controller and support report hooks |
| Playbook authoring | Draft/validate/publish/version, enable/archive, assignments, managed template install/reset, maps/questions, preview | `/dashboard/support/playbooks`, `/support/playbooks`; `/api/support/ai/playbooks*`, `playbook-templates*`, `simulate`, orchestration report; `SupportPlaybookTemplateService`, `PlaybookEngine`, `SupportPreviewStore` |
| Legacy configuration | Specialist list/get/update/activation/reset/seed; demo/KB parsing | `/dashboard/settings/outreach/[agentType]`; `/api/settings/ai-agents*`; `ai_agent_configs`, `support_agent_templates`; current runtime also requires explicit assistant context |
| Public installation | Generate/rotate/revoke token, branding, local preview, embed script/config, installation signal | `/api/support-widget/{token,generate-token,settings/:teamId,installed,embed.js,config}`; `support_teams.widget_token/widget_settings/widget_installation`; shared settings validators and framing headers |
| Customer session | Token + session credential, 24-hour expiry, first-request identity, retries, history polling, reload, feedback, handoff notice | `/support-widget/[token]`; `/api/support-widget/chat`, `session/:id/{messages,feedback}`, credentialed media/document endpoints, `confirm-email`; `support_chat_sessions`, `support_chat_messages` |
| Privacy and assets | Stable redaction, restricted encryption, reveal binding/audit, expiry/purge, approved attached PDF/media | `PrivacyVaultService`, `SupportWidgetDocuments`, media gateway/access; `support_privacy_vault`, `support_privacy_access_logs`, approved document/media/storage tables. Account privacy routes and ticket/member reveal authorization remain adjacent owner boundaries |
| Pipeline | Privacy → policy/rate/safety → context/intent → playbook/retrieval → dispatch/compliance/delivery/effects | `ChannelGateway`, pipeline stages, default configuration, playbook presentation/journey runtime; version/assignment/run tables and rate buckets. Outbox/tool/effect/turn recovery APIs are inventoried but excluded from implementation changes |
| Jobs | Widget turn processing; vault/rate purge and widget recovery invoked by support maintenance | `process_support_widget_turn` on OUTREACH; `cron-support-sla-check` maintenance plus notification/presence jobs on GENERAL. Whole jobs were not run because they include other owners' effects |

Relevant configuration: `SUPPORT_ASSISTANTS_ENABLED`, `SUPPORT_ASSISTANTS_BUSINESS_PROFILES`, `SUPPORT_CONVERSATION_TURN_CHANNELS`, `SUPPORT_MODERATION_ENABLED`, `SUPPORT_PLAYBOOK_AI_PRESENTATION_ENABLED`, `SUPPORT_NATIVE_BOOKING_CTA_ENABLED`, PII key version/tokenization/encryption settings, `CLIENT_URL`, and client API/WS origins. Only names are inventoried; no real key or production value was used or changed.

## Verification and limits

| Coverage | Result | Evidence / practical limit |
|---|---|---|
| New widget and playbook integration suites | **32 passed** | `final-integration.log`; actual PostgreSQL/Redis, forced non-superuser RLS for playbooks, real HTTP and Chromium for widget. Model dispatch is stubbed; starter provisioning is suppressed in the playbook CRUD fixture |
| Session permissions/lifecycle | **Passed** | Missing/incorrect credential, foreign widget team, expired session, ambient synthetic owner/staff cookies, key rotation/revocation invalidation, malformed IDs, concurrent duplicate/conflicting request identities |
| Privacy persistence/reveal | **Passed** | Actual redaction/encryption, no raw synthetic email in response/history/vault row, wrong owner/conversation reveal denied, valid reveal audit persisted, expired reveal denied and expired row purged |
| Feedback | **Passed** | Real HTTP/DB credential/team/origin binding and redacted comment persistence; component retry path also tested |
| Playbook persistence | **Passed** | Concurrent publish versions 1/2, immutable snapshots after editing, profile/owner denial through forced RLS, atomic archive/assignment disable; encrypted expiring profile-isolated previews |
| Pipeline/playbook/privacy/handoff contracts | **471 passed / 23 suites** | `server-scope-tests.log`; mixed runtime unit tests and static contracts with mocked dependencies, not a whole worker-driven conversation |
| Client components/helpers | **111 passed / 22 files** | `client-scope-tests.log`; includes owner chat isolation/retry, public recovery, playbook authoring, reports/quality, embeds and widget history timeout/backoff/visibility/cancellation behavior |
| Existing deeper PostgreSQL suites | **68 passed, 3 failed / 4 suites** | `deep-postgres-safe.log`; approved document/media checks use exact synthetic byte buffers and mocked storage/provider adapters. Three legacy agent-stage expectations fail as described below |
| Dashboard browser UI | **10 initial passes + 2 corrected-fixture retest passes** | Playbook editor/map, reports/transcript feedback, local widget preview/save, chat failure/retry/export/rename/dark mode, cross-origin framing; API fixtures are mocked. Width checks include 320/390/768/1440/1920 at normal zoom. Do not treat this as a real authenticated full-stack test |
| Build | **Passed client and server** | `client-build.log` (304 generated pages, compiled/typechecked); `server-build.log` (API and worker bundles). Build did not deploy or execute workers |
| Client types | **Passed** | `client-types-final.log` |
| Changed-file lint | **Passed** | `changed-client-lint.log`; `changed-server-lint.log` has zero errors and two existing unused-disable warnings in the widget controller |
| Full server types | **Failed: two existing errors** | `server-types-final.log`; `tests/settings.test.ts:201,222`, incomplete mocked settings values. No error remains in added audit files |
| Full server lint | **Failed: one existing error** | `server-lint.log`; unused `readFileSync` in `tests/newSupportPipeline.test.ts:2` plus existing warnings |
| Initial full client lint | **Superseded mixed-source/generated run** | `client-lint.log` reported 845 errors/1608 warnings while also scanning disposable Next output. The publication rerun after moving those outputs out of the source tree reports one existing source error/184 warnings; changed client files pass |
| Existing preview-store fixture | **Failed fixture setup / superseded coverage** | `deep-postgres.log`: its table omits `business_profile_id` required by the current conflict target. New playbook audit verifies the current business-scoped schema instead. The existing shared test was left for coordination |
| Full worker/model/provider/JWT/object flow | **Unrun** | Full startup/auth/session stack, real object-store I/O, queued worker reconnect/cancel/reconciliation and provider acceptance were not verified. Public adapter dispatch is stubbed; asset buffers/providers are synthetic. These results are not a mock-only completion claim |

The legacy configuration suite's three failures expect `AgentConfigurationStage` to load an old active agent without an assistant context. Current fetched v8 deliberately halts with “No explicitly assigned assistant is available for this receiving account.” No runtime guard was weakened to make that old fixture pass. This expectation needs alignment with the AI owner's current assistant-routing contract.

## Product decisions and follow-up boundaries

1. Confirm the intended compatibility/lifetime of legacy `/api/settings/ai-agents` controls relative to explicit assistant assignment. Keep the runtime guard until that contract is resolved; update old fixtures with valid assistant context as appropriate.
2. Public `config` and `embed.js` are statically routed without the explicit widget read limiter used by session history. Decide the intended metadata/script abuse budget and hosting/proxy protection before sharing or changing a rate-limit middleware path. No load/exhaustion test was performed and this is **not** reported as a reproduced denial of service.
3. Public write limits are 10/minute/IP and history limits are 60/minute/IP. Actual Redis budget separation and rejection passed. Expected behavior for many visitors behind one NAT, Redis outage latency and per-widget budgets remains a product/operational decision, not a silently changed threshold.
4. Ticket handoff state/teams and approval execution recovery remain with their assigned owners. This audit verifies public boundaries and unit contracts but does not attest to those owners' complete recovery behavior.

## Reproduction environment and evidence

Only disposable loopback containers `support-ai-audit-pg` (`pgvector/pgvector:pg16`, port 55432) and `support-ai-audit-redis` (`redis:7.2-alpine`, port 56379) were used. Each database suite creates and drops a random schema. The public fixture Redis is dedicated and may be flushed. Synthetic objects are in-memory image/PDF byte buffers; no real object store was accessed. The browser API adapter listened at 55881 and Next at 55880; unexpected external browser requests were blocked in the public integration regression.

The disposable containers and audit dev server were removed/stopped after verification. The environment used Node 24.19.0, installed TypeScript 5.9.3 and Next 16.2.11, with the workspace's existing dependency tree; no lockfile or dependency installation was changed.

Some existing PostgreSQL fixtures load checked-in local development environment files with `override: true`; the initial run attempted an unavailable local development connection and failed before fixture queries. `server/tests/helpers/supportAuditEnvironment.mjs` prevents dotenv file loading for subsequent explicitly selected audit runs. It requires the exact disposable host/port/database. No production database, account, provider send/post/charge/refund, credential/security setting, deployment or push was used.

Run the new integration suites from `server/`, with the disposable containers available:

```sh
NODE_ENV=test SUPPORT_PUBLIC_WIDGET_QA_BROWSER=1 \
SUPPORT_PUBLIC_WIDGET_QA_DATABASE_URL=postgresql://audit:synthetic-audit@127.0.0.1:55432/support_ai_audit \
REDIS_HOST=127.0.0.1 REDIS_PORT=56379 NODE_OPTIONS=--experimental-vm-modules \
./node_modules/.bin/jest --runInBand \
tests/supportPublicWidgetAuditPostgres.test.ts tests/supportPlaybookAuditPostgres.test.ts
```

The browser option requires a Next dev server on 55880 with `NEXT_PUBLIC_API_URL=http://127.0.0.1:55881` and system Chromium at `/usr/bin/chromium`. Without the browser option that case is explicitly skipped. Existing dotenv-loading suites must additionally use `SUPPORT_SYNTHETIC_AUDIT=1`, explicit `DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=support_ai_audit` and the matching disposable login, plus `--setupFilesAfterEnv=./tests/helpers/supportAuditEnvironment.mjs --` before test paths.

Evidence, screenshots, inventory, Playwright configuration and machine-readable results are in `audit/support-ai-2026-10-23/`. Bundle checksums, exact tip SHAs and file manifests are recorded in external handoff JSON files so they do not require self-referential commits. The original handoff was local-only; the publication follow-up authorizes only its named handoff branch. Parent must integrate and retest combined v8; no direct v8 push or deployment is authorized here.
