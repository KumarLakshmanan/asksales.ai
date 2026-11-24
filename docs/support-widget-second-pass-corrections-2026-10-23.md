# Support widget second-pass corrections — 23 October 2026

Five scoped corrections/improvements are verified for handoff. They do not enable an assistant, change ticket ownership, alter billing authority or deploy anything. The separate product and cross-owner decisions below remain explicit holds; this is not a claim that the entire support/AI system is ready.

## Baseline and commit order

Original second-pass audit: `24c66b9cac2936ccbd119e39cf78b5b83b1e6212`. Fix work initially used that unchanged remote at 16:25 UTC. Before publication, remote v8 advanced to **`a73dd61ed8876bd6774440ee2f3b06b4d7e63170`**, fetched at **16:56:31 UTC**. The six intervening paths are Analytics reporting/docs and Support handoff/member fixes/tests; none overlap this patch. All five commits were rebased onto that approved v8 baseline. Own-file, entire-client and shared-source comparisons before/after rebase are identical. PostgreSQL/browser acceptance and server unit/build/type checks were rerun on the new baseline.

Apply in this order:

| Commit | Item |
|---|---|
| `807b6569025892b720348539ae7860c058b04744` | W1: explain completed unanswered messages |
| `f10046e3acb70e9b07a51b4520945ce29860a727` | W2: iframe Escape dismissal and focus |
| `91acee1ddd3b5cbd2f62128dea1ba013d1329bda` | N1: omit owner cookies from public reads |
| `9b0ddbd21ee2de9e05f7688a75f7af9950fbf5ab` | D1: share scoped dashboard read contract |
| `e94fcdd37c12e15e12c5329f02a8af3895135d2f` | U1: link installation to assistant settings |

The original widget handoff `5e1e33c32cce5f8a1ae55e92cb6755337df5715f` remains an ancestor. Strict session-ID parsing, expired New chat request reset and completed no-op replay acknowledgements remain covered. Parent is the sole v8 writer; only `handoff/audit-20261023-support-widget` is a publication target.

## Fixed items and before/after evidence

**W1 — P2, completed customer message with no explanation.** With runtime disabled or no published web binding, real assistant routing correctly fails closed, but `generateWidgetReply` finishes `no_op` without an answer. Previously the browser showed only the customer's question after processing and reload; the inline response also retained a stale `processing` value despite a completed DB row. The widget now uses the existing completed/handoff state to show an accessible, neutral notice: “Your message was saved, but an automated reply is not available.” Inline acknowledgement reports the persisted completed status. Queued, processing, committing, review, cancelled, answered and human-handoff states retain their distinct behavior. No new processing state, raw routing reason, fallback assistant or promised human follow-up was added.

Routes: `/support-widget/[token]`, `POST /api/support-widget/chat`, `GET /api/support-widget/session/:sessionId/messages`; adapter `server/controllers/supportWidgetController.ts`. Before: two client acceptance failures, one actual production-browser failure, and one stale inline HTTP status failure. After: production browser receives the notice after the actual worker finishes and after reload; inline response and replay remain idempotent. Evidence: `w1-client-before.log`, `w1-inline-before.log`, `w1-mounted-before.log`, corresponding after logs and `publish-mounted/iframe-keyboard.json`.

**W2 — P3, Escape inside iframe could not dismiss the host widget.** The loader's parent-document handler cannot see iframe key events. A shared, data-free close command now connects the customer page and floating loader. The child sends only to the exact validated HTTP(S) host origin supplied by the loader; the receiver requires the actual iframe window, widget origin and expected command, and ignores requests when already closed. Dismissal restores launcher focus. Standalone/inline chat without loader context, handled Escape, composing input and other keys are preserved.

Routes: `/api/support-widget/embed.js`, `/support-widget/[token]`; protocol `shared/supportWidgetEmbed.ts`; browser helper `client/src/lib/support-widget-embed.ts`. Before: acceptance timed out waiting for the actual iframe to close. After: Escape closes from the composer and restores focus at 320/390/768/1440 px, scale 1; parent Escape still works. Wrong-origin, wrong-window and wrong-command messages do not dismiss. Evidence: `w2-mounted-before.log`, `w2-mounted-after.log`, `publish-mounted/iframe-keyboard.json`; 13 protocol/keyboard unit cases. This additive behavior requires refreshed loader and client assets together; previously cached old loaders retain their earlier behavior until refreshed.

**N1 — P3, unnecessary owner-cookie transport on same-origin public reads.** Reproduced after the audit: config, restored history and polling used default fetch credentials. In a same-origin fixture all three attached a synthetic HttpOnly owner-session cookie, although the server still required widget/session capabilities. This was not an access bypass. Both bounded widget requests and polling now explicitly use `credentials: omit`, matching chat/feedback. The private dashboard API client remains credentialed.

Before/after: an actual same-origin browser uses the production Next page/assets through a local HTTP proxy to the mounted API. Config/restoration/polling traces change from `hasOwnerCookie:true` to `false`, retain `hasAuthorization:false`, and customer history still loads. Evidence: `n1-before/public-read-cookies.json`, `n1-after/public-read-cookies.json`, `publish-mounted/public-read-cookies.json` and failing/passing client/browser logs. No Auth/JWT lifecycle or cookie-setting policy was changed.

**D1 — duplicate token-read contracts, behavior-preserving consolidation.** Embed and appearance settings now share one `SupportWidgetTeam` type and `listSupportWidgetTeams` API function in `client/src/lib/support-widget-api.ts`. Each page retains its different cancellation/generation, mutation serialization, scoped remount and focus lifecycle. This was a static duplication proposal, not a reproduced runtime defect: the same 19 request-order/profile-switch characterization tests passed before and after. Both pages subsequently loaded actual profile-scoped API data in the production browser.

**U1 — contextual assistant setup navigation.** `/dashboard/support-ai/embed` now links to the existing `/dashboard/settings/outreach` settings page. It does not claim readiness, generate keys, activate or publish anything. The link test failed before and passes after. Browser acceptance checks real scoped token reads, appearance settings and canonical destination navigation at 390/1440 px with no document horizontal overflow. Assistant destination APIs and unrelated app-shell reads are synthetic; this is not positive assistant setup acceptance. Evidence: `u1-client-before.log`, `u1-client-after.log`, `publish-mounted/assistant-navigation.json` and screenshots.

## Complete disposition of remaining audit items

| Item | Disposition and owner |
|---|---|
| R1: preliminary payer drift | **Withdrawn/resolved, not an open defect.** The preliminary fixture omitted migration 304. Its actual immutable-payer guard rejects reassignment with SQLSTATE `42501`. Current recovery retains owner 9/profile 91/business actor 9/billing actor 9/payer 100. No guard or authority was relaxed. |
| R2: durable inbox omits originating profile/actor/payer | **Awaiting dependency / reproduce-first outside Widget.** Static contract review for original AI/Tenant owners via parent; current anonymous widget recovery passed. Do not promote it to a reproduced billing defect. |
| P1: token-management role policy | **Explicit product decision hold.** All-role appearance access and owner-only support administration are distinct existing navigation contracts. No authorization bypass was reproduced. Preserve current permissions until the intended key-management role policy is chosen. |
| D2: shared public-session/capability guard | **Explicit design decision hold.** Chat/history/feedback/media/document checks have operation-specific expiry, origin and approval requirements. No behavior divergence was established as a defect. Define the common contract before consolidation; no guard was relaxed merely to share code. |
| D3: legacy configuration versus published assistants | **Awaiting original AI owner/product decision.** Preserve separate functionality and explicit published receiving-account assignment. Do not delete legacy product surfaces or restore the removed active-agent fallback. |
| Installation and local-preview labels | **Already resolved by existing behavior.** Installation says script-loaded, not conversation-verified; preview says local and creates no customer conversation. Preserved, with the U1 navigation improvement. |
| Historical three fallback-fixture failures | **Historical fixture alignment for AI owner, not a new product defect.** They expected the removed legacy active-agent fallback without explicit assistant context. Not rerun or weakened to pass. |
| Historical preview fixture missing profile column | **Superseded by current passing coverage.** Current encrypted, expiring, forced-RLS business-scoped preview regression passes. The old shared fixture was not rewritten here. |

Original shared owners: AI `handoff/audit-20261023-ai-reliability` (`ea798a76a712879be6e084a51b0610129f781254`); Tenant `handoff/audit-20261023-tenant` (`7b54373dd2e9d91c81bd0a90f5dc607b4c08df8b`); Support `handoff/audit-20261023-support` (`db37aa7810d331b5e5410ebac8d6695c6bd9a610`). Auth owns login/JWT lifecycle; Storage owns file lifecycle. No shared AI, central scope, ticket-state or storage-lifecycle source was changed.

## Verification on the handoff source

- **39 passed, no selected skips:** three PostgreSQL suites with browser enabled: `supportWidgetBoundaryPostgres`, `supportPublicWidgetAuditPostgres`, `supportPlaybookAuditPostgres`. This includes seven new mounted-boundary cases and the legacy public browser case.
- **280 passed / 14 server unit suites:** router, pipeline/policy, playbook/journey, widget settings/privacy/CORS and runtime regressions. External effects/DB are mocked in these unit suites.
- **61 passed / nine client suites:** outcomes, dismissal, snippets/settings, isolation/reload/polling, scoped dashboard reads and request ownership/order.
- **Passed:** production Next build (304 routes, including TypeScript); explicit client typecheck; server API and worker builds; changed-source lint has no errors. The client/shared trees are identical across the final rebase, and the same production browser assets were exercised afterward.
- **Global baseline checks remain red:** server types retain only `tests/settings.test.ts:201,222`; full server lint retains the unrelated unused `readFileSync` at `tests/newSupportPipeline.test.ts:2`. Full client lint now passes with 0 errors and 188 warnings; the historical `prefer-const` failure is no longer present in this integrated baseline. Full server lint reports 1 error and 2328 warnings. Exact output is in the external evidence logs. No configuration was relaxed to suppress them. No remote-CI readiness claim.

Real boundaries: actual mounted widget router, response wrapper, CSRF/CORS, public capability scope, Drizzle/PG runtime role with forced RLS, privacy/persistence services, Redis/BullMQ, widget processor and `runBusinessJob`, AgentRouter/ChannelGateway/assistant resolver, production Chromium, history/reload and focus. Assistant routing genuinely reaches disabled/unassigned gates. The old public-adapter suite still stubs AgentRouter; its positive response fixtures do not prove later pipeline execution.

Synthetic boundaries: disposable users/teams/tokens/session data, cookie/session establishment, unrelated app-shell and destination-assistant APIs, and mocked external effects. Fixtures require the exact loopback PostgreSQL 55432 database `support_ai_audit` and loopback Redis 56379 before connecting, use random schemas, block dotenv loading and external browser requests, and never invoke a live provider. No actual key-generation/revocation HTTP request was issued. Model-derived tables plus migration 293, initial 311 DDL, 299-style RLS and the actual 304 immutability guard are a focused subset, not full migration-chain acceptance.

Unrun: full positive assistant/playbook/model/tool/provider execution, full worker bootstrap/scheduler/restart, full JWT login/refresh/logout, real object storage and complete media/document delivery, ticket-state mutation/handoff execution, uncertain external-effect cancellation/reconciliation, staff-origin recovery under complete migrations, full accessibility conformance and other browsers. The fixes do not establish those capabilities.

## Reproduction and delivery

Use dedicated disposable PostgreSQL/Redis and a production Next server on 55880 with `NEXT_PUBLIC_API_URL=http://127.0.0.1:55881`. From `server/`:

```sh
SUPPORT_SYNTHETIC_AUDIT=1 SUPPORT_PUBLIC_WIDGET_QA_BROWSER=1 \
SUPPORT_WIDGET_FIX_EVIDENCE_DIR=/tmp/widget-fix-evidence \
SUPPORT_PUBLIC_WIDGET_QA_DATABASE_URL=postgres://postgres:fixture@127.0.0.1:55432/support_ai_audit \
DB_HOST=127.0.0.1 DB_PORT=55432 DB_NAME=support_ai_audit DB_USER=postgres DB_PASSWORD=fixture \
REDIS_HOST=127.0.0.1 REDIS_PORT=56379 CLIENT_URL=http://127.0.0.1:55880 NODE_ENV=test \
NODE_OPTIONS=--experimental-vm-modules ./node_modules/.bin/jest --runInBand \
  --setupFilesAfterEnv ./tests/helpers/supportAuditEnvironment.mjs --runTestsByPath \
  tests/supportWidgetBoundaryPostgres.test.ts tests/supportPublicWidgetAuditPostgres.test.ts \
  tests/supportPlaybookAuditPostgres.test.ts
```

Without explicit fixture URLs/browser opt-in, those cases are intentionally skipped rather than contacting application data. All listed credentials are disposable fixture values. No production DSN/account was used, no migration was created (540–549 remain unused), and no credentials/security settings, Pages, workflow/deployment triggers or denied metadata operations were changed.

External evidence: `/workspace/widget-fix-evidence-20261023/` (before/after logs, source/base reconciliation, every-item queue, traces/screenshots and hashes). Exact final commit/tree, file/dependency manifest, remote verification, incremental bundle and checksums are in `/workspace/widget-second-pass-fix-handoff-20261023.json`; keeping that outside the commit avoids self-referential hashes. Publication does not integrate v8 or deploy the result.
