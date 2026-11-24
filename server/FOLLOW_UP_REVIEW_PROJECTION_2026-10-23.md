# Follow-up authority review: read-only history projection

Base `babc42072ba499dab9cf504d69e2270acc0979d4`, branch `codex/followup-authority-review-projection`. This is a separate minimal delta after the already-published Followups corrections. Remote v8 was read at `356fd2849883ae268b07f1b554975bff7b51ac48` on2026-10-23 17:55:07 UTC; no owned history files or Tenant helper changed there. No independent merge, v8 write, deployment or real provider/customer effect is included.

## Reproduction and correction

A nonempty isolated PostgreSQL fixture uses actual model column definitions and mounts the actual outreach router, controller, new reader and legacy `/api/sent-messages` registration. The committed pre-projection reader failed all six initial acceptance cases: original SMS `review_required` envelopes were absent, and Email/social authority review was absent. The initial container-start race and fixture parameter-type failure occurred before assertions and remain setup diagnostics, not application defect claims.

The new `FollowUpHistoryService` is SELECT-only and requires the selected business scope. Owner/profile predicates cover original SMS, existing receipts, messages, conversations and Email receipt deduplication. A mismatched conversation cannot join another profile or hide a selected-profile receipt. That inconsistent-row case is defense-in-depth fixture evidence without production RLS; it does not establish a production cross-tenant leak.

Original SMS holds are projected directly from `sent_messages.follow_up_dispatches[step]` using the existing migration360 index predicate. Existing SMS sent-reply receipts remain separate. An original SMS's own sent status/provider ID is never attributed to a held follow-up. Email/social review is projected from `outreach_messages.metadata.configuredFollowUpDispatch`; their stored status, uncertainty and native ID remain independent. No migration or receipt store was added. All non-history `SentMessageModel` methods, including writers, are byte-identical to the base.

## Public read contract

`shared/followUpActivity.ts` defines the display fields plus:

- `activityKey`: stable conversation/historical ID, or original SMS ID plus durable envelope key. Multiple held steps remain distinct across pagination.
- `recordedMessageId`: the recorded message/native ID, not proof by itself of delivery. It is null for original-SMS outbox projections. Generated Email RFC identity alone is not exposed as a provider receipt.
- `authorityReview: null | { reason, origin, identity }`. `reason` is the stored `reviewReason`, bounded to a public uppercase code. No raw diagnostics or full payload are returned.
- `origin` retains the durable table/message ID/step and physical owner/business IDs. `identity` retains only the five persisted snapshot fields: `userId`, `businessProfileId`, `businessActorUserId`, `billingOrganizationId`, `billingActorUserId`. Missing/invalid snapshot IDs remain null; no current reader/actor/payer is substituted.
- SMS reserved-step projection has `status=review_required`, `deliveryStatus=unconfirmed`, `sentAt=null`. This means this envelope does not confirm delivery, not that a provider definitely was never called. Current historical SMS receipts lack a reliable original-origin/step join, so no lead/time heuristic suppresses them. Email/social statuses are preserved verbatim, including queued/sent/failed/manual-review and uncertainty.

The UI shows Review required and its reason/origin, optional stored-authority details, and the independent recorded delivery status/message ID. Uncertain outcomes remain explicit. It offers no replay, rebind, reauthorize or provider retry action. Refresh/Try again only reads history. This closes the prior static operator-visibility gap at the tested boundaries, not the separately held recovery-policy decision.

## Verification

- **25/25 server/browser tests, three suites**: `followUpAuthorityHistoryPostgres`, `sentMessageController`, `socialConversationSessionsPostgres`. The new suite has12 cases, including one production-browser case exercising nonempty persisted data across all five channels and390px layout. It uses the actual frontend -> actual session cookie middleware -> mounted history API -> actual PostgreSQL reader.
- **38/38 client tests, four suites**: `followUpAuthorityHistory`, `followUpActivity`, `followUpRecoveryUx`, `followUpPage`.
- Full server and prescribed client TypeScript pass; scoped server/client lint passes with zero errors/warnings. API and worker esbuild bundles pass. Clean isolated production frontend build passes and the changed History source hashes match that build's source. No type-ignore/build bypass was used.
- The existing social lifecycle suite passed8/8 before this change. The fail-closed scoped reader exposed five old fixture calls without business context. Only the fixture's scoped calls, business defaults and current schema columns were updated; all eight runtime assertions/cases pass unchanged. No production fallback to unscoped reads was added.
- Actual auth/profile/business-permission/billing-scope middleware and membership resolver SQL execute. Only synthetic token/user lookup, throttle infrastructure, subscription availability and module catalog are replaced. Module-disabled, unauthenticated, contradictory selection, foreign account/profile, revoked member and missing-scope negatives pass. Full runtime-role RLS/migration composition and live JWT/session infrastructure remain unrun; existing production authorization settings are unchanged.
- Browser setup exposed that AuthContext removes the old bearer token after `/auth/me`. The fixture now uses actual middleware to issue its synthetic HttpOnly session cookie, rather than faking successful history authorization. Cookie-backed reads pass. The app shell/profile list remains synthetic; monolithic server boot, real providers and current-v8 combined acceptance are unrun.

Reproduce from `server/` with only explicit disposable loopback `followup_qa` URLs, the committed `tests/helpers/followUpLocalOnly.cjs` preloaded, `--experimental-vm-modules`, and Jest `--runInBand`. Set both `FOLLOW_UP_IMPLEMENTATION_DATABASE_URL` and `OUTREACH_QA_DATABASE_URL` for the three suites. `FOLLOW_UP_REVIEW_BROWSER=1` adds the browser case; serve the exact production frontend on32802 with its API URL32801. The test mounts the actual API on32801. Providers/paid calls remain blocked by the guard; database writes are fixture-only.

## Setup blocker and remaining gates

Port32800 was occupied. Inspecting `/proc/13729/cwd` returned PermissionError on2026-10-23; that inspection was not retried, and no signal was sent to that process. Its ownership/cleanup is uncertain and it was left untouched. An independently created frontend on32802 was used instead; no denied metadata action, protection or setting was bypassed. Earlier browser setup failures are retained, not labelled product failures.

The required repository `vscode_askQuestions` helper remains unavailable/pending. Historical denied GitHub hook/settings reads remain unretried; checked-in push workflows do not match unique handoff refs and external-hook visibility is still uncertain. Integration must accept this delta after babc4207 on its current source.

Campaign consumer/writer and Tenant authority helpers are untouched. Root's newly assigned modernization of the older12-case producer/worker fixture against Campaign's actual callback/credit/ledger contract is pending separately; this history suite does not claim that old suite passes against the new consumer. The distinct CRM reminder retry baseline is also queued for reproduce-first investigation. No automatic replay/legacy authorization or running-sequence/DST policy was introduced.

## Changed files

- client/src/components/follow-ups/FollowUpHistory.tsx
- client/src/__tests__/followUpAuthorityHistory.test.tsx
- shared/followUpActivity.ts
- server/services/outreach/FollowUpHistoryService.ts
- server/models/sentMessages/functions.ts (history method/imports only)
- server/tests/followUpAuthorityHistoryPostgres.test.ts
- server/tests/socialConversationSessionsPostgres.test.ts (fixture scope/schema only)
- server/FOLLOW_UP_REVIEW_PROJECTION_2026-10-23.md

Final mandatory verification: unavailable `vscode_askQuestions` remains pending.
