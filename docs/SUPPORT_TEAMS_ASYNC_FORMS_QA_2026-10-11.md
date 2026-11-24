# Support Teams asynchronous forms — mocked QA, 2026-10-11

Branch: `fix/support-teams-async-forms`.

Base: freshly fetched `origin/v8`, `eb023757d295546afad8b0ad84fdc52426c7e070`. The configured checkout began at `09fe888e`; the branch was created from the fetched v8, not that checkout. This is branch-only work for parent integration. No merge or deployment was performed.

## Scope and source findings

The current v8 Support Teams consumer still closed Routing defaults after `saveCapacity` caught a rejected PUT, swallowed the initial capacity GET error while retaining editable hardcoded values, and allowed repeated Create/Edit Team and Add Member submissions during an outstanding request. These findings were reproduced with disposable APIs before editing the consumer. **No live failure was observed or claimed. No live team, member, or response-target mutation was invoked.**

Repository guidance read: `.github/instructions/copilot.instructions.md`, `client.instructions.md`, `support-panel.instructions.md`, and `verification.instructions.md`, plus `client/README.md`. No `AGENTS.md` or `SKILL.md` was found in the repository; `/workspace/.agents` and `/workspace/.codex` were empty. Relevant API client, business-profile selection/workspace hooks, realtime refresh, focus-return hook, support routes, and capacity controller were inspected.

Changes are confined to the Support Teams page, its regression/browser tests, a focused browser configuration, and this evidence. Shared overlay, navigation, layer/theme primitives, server permissions, credentials, providers, jobs, and migrations were not changed.

## Reproduction before repair

Command, executed at the base with the initial five regression cases and only mocked APIs:

```sh
cd /workspace/salesmarketing && client/node_modules/.bin/vitest run --root client --config vitest.config.ts src/__tests__/supportTeamsForms.test.tsx
```

Corrected the harness's outdated “Response targets” action locator to the actual v8 label “Routing defaults” before using the following results as evidence:

| Case | Observed mocked result on base |
| --- | --- |
| Rejected defaults PUT | Dialog disappeared; `Unable to find role="dialog"` |
| Rejected initial defaults GET | Save defaults remained enabled; disabled assertion failed |
| Deferred Create Team with repeated clicks | 2 POSTs instead of 1 |
| Deferred Edit Team with repeated clicks | 2 PUTs instead of 1 |
| Deferred Add Member with repeated clicks/form submit | 3 POSTs instead of 1 |

Result: **5 failed / 5**, before repair. The same five cases subsequently passed; the final focused suite has 27 cases.

## Resulting behavior

- Defaults are unavailable until a usable server response loads. A rejected or malformed read displays an inline alert and explicit Retry loading defaults; no implicit fallback is editable or saveable.
- Rejected saves retain the open dialog and submitted fields with an actionable inline alert. Successful current-session responses close the dialog and retain the existing payload/endpoint semantics.
- All three mutation flows have a synchronous in-flight guard, disabled fields/submit controls, `aria-busy`, a status announcement, and a spinner. Create/Edit Team now supports normal form submission by Enter; existing name, member password, role, and atomic notification-onboarding semantics are retained.
- Dialog close/reopen and changed team targets invalidate old dialog sessions without releasing outstanding mutation locks. Closing UI does not abort an already-issued write. Old success/failure responses cannot reset or close a newer dialog. Locks release when the request settles.
- The page is keyed by verified actor/business profile. Reads are abortable and ordered; mutation requests use the captured business-profile header. Old workspace/unmounted results cannot update dialogs, toast, or start refresh reads. Loaded rosters/drafts survive a rejected background refresh.
- Existing server authentication/module/tenant permission checks and legacy routes are unchanged. Mocked 403 team-save rejection remains an error and does not bypass access checks.

## Exact final checks

Environment: Node `v24.19.0`, Chromium `151.0.7922.173` on Debian. Installed executables were used directly. The environment's pnpm was `11.19.0` rather than the pinned `10.30.3`; the first pnpm invocation attempted installation and stopped at an unwritable home store. No dependency or lockfile changes were made.

```sh
cd /workspace/salesmarketing && cd client && node_modules/.bin/vitest run src/__tests__/supportTeamsForms.test.tsx src/__tests__/supportResourceSurfaces.test.ts src/__tests__/supportAuthIsolation.test.ts src/__tests__/authTenantCacheIsolation.test.tsx src/__tests__/supportMemberActivityPages.test.tsx src/__tests__/controlledCreateDialogFocus.test.tsx
```

Result: **6 files passed, 93 tests passed**, 7.02 seconds. Includes 27 focused form cases, success/rejection after workspace changes, deferred reads, out-of-order realtime reads, cancelled/reopened dialogs, changed member team targets, retries, unmount, validation, unchanged payload/header assertions, background-refresh failure, auth isolation and existing focus regressions.

```sh
cd /workspace/salesmarketing && client/node_modules/.bin/tsc --noEmit -p client/tsconfig.typecheck.json
cd /workspace/salesmarketing && cd client && node_modules/.bin/eslint 'src/app/dashboard/(main)/support/teams/page.tsx' src/__tests__/supportTeamsForms.test.tsx e2e/support-teams-forms.spec.ts playwright.support-teams.config.ts
cd /workspace/salesmarketing && git diff --check
```

Results: **exit 0**, no TypeScript diagnostics, no ESLint errors/warnings, no whitespace errors.

Local browser server (no backend started):

```sh
cd /workspace/salesmarketing && cd client && NEXT_DIST_DIR=.next-support-teams-qa NEXT_PUBLIC_API_URL=http://127.0.0.1:3007 NEXT_PUBLIC_WS_URL=ws://127.0.0.1:3007 node_modules/.bin/next dev --hostname 127.0.0.1 --port 3007
```

Next was run from the client directory because invoking `next dev client` from the repository root failed to resolve the config's TypeScript imports. Its generated tsconfig additions were removed; no config/theme/navigation modifications from local QA remain.

```sh
cd /workspace/salesmarketing && cd client && E2E_SKIP_WEBSERVER=1 E2E_BASE_URL=http://127.0.0.1:3007 E2E_CHROMIUM_EXECUTABLE=/usr/bin/chromium E2E_SUPPORT_TEAMS_OUTPUT_DIR=/tmp/support-teams-final-artifacts E2E_SUPPORT_TEAMS_REPORT=/tmp/support-teams-final-browser-results.json ../node_modules/.bin/playwright test --config playwright.support-teams.config.ts
```

Result: **25 passed, 0 failed, 0 skipped, 0 flaky**, 75.38 seconds. The focused configuration keeps screenshots/failure traces and disables optional video recording; inherited video capture initially prevented browser startup because FFmpeg was absent. No assertion was removed or relaxed.

| Chromium viewport | Cases passed | Zoom/geometry assertions |
| --- | ---: | --- |
| 360 × 800, mobile + touch | 5 | viewport scale 1; exact inner dimensions; dialog within viewport; no page horizontal overflow |
| 393 × 852, mobile + touch | 5 | same |
| 768 × 1024, tablet + touch | 5 | same |
| 820 × 1180, tablet + touch | 5 | same |
| 1440 × 900, desktop | 5 | same |

Browser cases exercise rejected/deferred defaults load/save, explicit retry, double-click and normal Enter submissions, duplicate submit events while disabled, rejected Create Team/Edit Team/Add Member, preserved team color/description and member notification consent, create focus return, cancelled/reopened sessions, a changed member target, and a business-profile change during a pending defaults save. Every API response is disposable; unmatched writes are blocked, and application sockets use the fixture. Tests assert no unexpected mutations and no uncaught page errors. Mocked 403/503 responses intentionally produce browser resource-error messages; they are not live failures.

Representative rejected-member screenshots were visually inspected, use fictional `.test` identities with masked synthetic passwords, and show retained inputs, alert, and available retry controls:

- [360 × 800 mobile screenshot](qa/support-teams-forms-2026-10-11/mobile-member-save-error.png)
- [768 × 1024 tablet screenshot](qa/support-teams-forms-2026-10-11/tablet-member-save-error.png)

## Limits and repository verification

This verifies browser/component behavior with mocked APIs, not production availability, physical devices, Safari/Firefox, assistive-technology speech output, or live server persistence. Existing server save/idempotency and authorization contracts were inspected and preserved; no production mutation was used to validate them. Parent integration into v8 remains outstanding by request.

`.github/instructions/verification.instructions.md` says: “The `vscode_askQuestions` verification step is REQUIRED and ABSOLUTE for every change made to this repository.” Tool discovery found no callable `vscode_askQuestions` helper in this execution environment. No affirmative helper response is claimed; this unavailable repository verification step remains a tooling limitation alongside the recorded automated results.
