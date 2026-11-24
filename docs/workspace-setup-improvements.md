# Workspace setup improvements

Implemented on 3 October 2026. Changes remain in the working tree; no production migration or deployment was performed.

## Pages and components updated

| Area | Improvements |
| --- | --- |
| Workspace setup | Account drafts resume across browsers/devices; offline tab recovery; saved status, retry and conflict recovery; explicit draft discard when its workspace is unavailable; stable creation keys prevent duplicate workspaces. |
| Website analyzer | Durable background jobs, staged progress, refresh recovery, stop/retry, manual continuation, analysis date/source warnings, and explicit review before applying refreshed details. |
| Profile setup/editing | Shared choices and validation; Save changes available in every edit section; inline errors focus the relevant field; unsaved navigation guard; version checks protect concurrent edits. |
| Brand toolkit | Essentials shortcut; full advanced flow; workspace-specific labels; optional guidance disclosures; grouped review with edit-and-return; social, email and headline previews; contrast hints. |
| Brand assets | Duplicate checks, selection order, alt text, dimensions, source metadata, lazy thumbnails, browser compression and bounded server WebP optimization. Replacement logos attach at final save. Unselected uploads can be managed from Storage. |
| Business chooser | Search, access filter, sort, favorites and recents; setup status; archive/restore preserves records. The last active owned workspace cannot be archived. |
| Dashboard/navigation | Next steps derived from actual saved activity and permissions; connection preferences are not reported as verified integrations; visible current workspace; account-specific menu preferences; accessible mobile drawer. |
| Account review | Clear next actions, support access, last-check status, and refresh on resume/online without overlapping checks. |
| Mobile/accessibility | Step heading focus, keyboard-aware action placement, reduced-motion support, drawer focus/Escape handling and hidden inactive navigation. |
| Measurement | Workflow events for steps, saves, analysis, uploads, completion and first actions, without names, URLs or contact information. |

## Draft and save behavior

Drafts are scoped to the authenticated account. Profile references and toolkit drafts require workspace ownership. Updates use compare-and-swap revisions; deleted drafts retain a revision tombstone so an older tab cannot revive completed work. The local copy is a recovery fallback, while the account copy is authoritative.

A draft also records the version of the saved profile/toolkit it began from. If saved details have changed, the older draft is not applied automatically. The user can load the latest details or explicitly reload a newer account draft. Profile/toolkit writes include the saved version and reject stale updates. Creation retries reuse a stable request key.

Website analysis runs in the standalone GENERAL worker. The API creates/polls/cancels jobs; it does not run an in-process worker. Cancellation and final knowledge/analysis persistence share a lock, so late provider responses cannot commit after cancellation.

## Rollout

1. Apply `server/migrations/322_workspace_setup_recovery.js` with the existing custom migration runner in `server/scripts/migrate.mjs`, following the repository migration instructions. Migration 322 adds draft/job tables, ownership policies and archive/idempotency fields.
2. Deploy the API and standalone worker changes together. Start the GENERAL worker with the existing worker entry/configuration and Redis connection.
3. Deploy the client after the new API routes are available.
4. Run the controlled live verification below in a disposable workspace before declaring crawling, AI, indexing and remote storage verified.

The legacy website-analysis endpoint remains available for existing callers. New setup screens use the background job endpoints. Existing clients can still omit save versions; the updated screens submit them.

## Controlled live verification

`server/scripts/verify-workspace-setup-live.ts` verifies authentication, ownership, queued analysis, real crawling/AI, saved knowledge, indexing and readable stored images. It intentionally requires a local QA API and an owned, active, nondefault disposable workspace.

Set these through the local environment/secret mechanism; do not paste tokens into logs:

- `WORKSPACE_SETUP_LIVE_ALLOW=true`
- `WORKSPACE_SETUP_LIVE_API_URL`: local QA API origin
- `WORKSPACE_SETUP_LIVE_TOKEN`: signed-in disposable workspace owner's token
- `WORKSPACE_SETUP_LIVE_PROFILE_ID`: owned nondefault disposable workspace ID
- `WORKSPACE_SETUP_LIVE_WEBSITE`: public test website
- `WORKSPACE_SETUP_LIVE_STORAGE_ORIGIN`: optional expected remote storage origin

Run with the project's Node 24 runtime and TypeScript runner: `pnpm --dir server exec tsx scripts/verify-workspace-setup-live.ts`.

The API/worker need the migrated database, Redis, configured active AI/embedding providers, writable storage/quota and a crawler browser executable. Provider readiness was not inferred from saved credentials. The script prints only check outcomes and counts; it does not print tokens or provider payloads.

## Verification

Backend: **48 tests across five suites passed**, including 11 authenticated HTTP/PostgreSQL scenarios, actual GENERAL dispatcher selection and two Sharp image optimization tests. Migration repeat-up/down, preservation checks, helper TypeScript checks and nine entry bundles passed. The disposable database was removed.

Client: **65 distinct tests across 12 suites passed** (64 in the combined run, plus the unavailable-workspace draft regression). Changed client entry points and their imports passed scoped TypeScript checks. Scoped client lint and lint for seven new backend controllers/services/helpers passed. Full server typechecking and broad server lint were not completed successfully.

Browser: **32 distinct desktop/mobile scenarios passed**, with **86 screenshots**. The comprehensive matrix passed 24 of its original 30 cases; six obsolete test expectations were corrected and those scenarios passed in the final 16-case audit/recovery run. The final run also verified unavailable-workspace recovery and reuse of the toolkit creation key stored in the account draft. Counts exclude overlapping runs. Mobile checks use an emulated viewport; a physical onscreen keyboard was not exercised.

Evidence is in `.local/workspace-setup-enhancements-20261003/evidence/VALIDATION.json`, the logs in that directory, and its searchable `SCREENSHOTS.html` gallery. Backend details are in `.local/workspace-improvements-20261003/BACKEND.md`. Earlier disk-full and resource-contention failures are not reported as passing.

Live external provider verification remains unavailable because the controlled authenticated disposable-workspace configuration was not supplied. The preflight exits with an explicit unavailable result. Tests using provider fixtures do not establish live provider readiness.
