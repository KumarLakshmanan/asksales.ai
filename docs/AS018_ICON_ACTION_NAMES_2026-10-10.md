# AS018 — contextual Campaign and Room Type icon actions

Branch: `codex/asksales-as018-20261010`.
Base: latest fetched `origin/v8`, `ab4d082821f9007bc24c94137471413fff389a46`. The required prior integration is the base itself. The first `git fetch origin v8` updated only `FETCH_HEAD` under this environment's fetch configuration; an explicit `refs/heads/v8:refs/remotes/origin/v8` fetch corrected the older tracking reference before any edits. No merge or push to `v8` is part of this task.

## Implementation

- Campaign History grid and list deletion triggers expose `Delete campaign [full displayed identity] (ID [stable record ID])`. ICP campaign name retains precedence over the thread title. Null/blank/whitespace-only titles fall back to `Campaign [ID]`. IDs are always included for named records, so duplicate titles remain distinguishable even across pages and filtering. Names do not depend on the visible subset or CSS truncation.
- Both existing confirmation dialogs still use the native Radix alert-dialog trigger and content, `Delete Campaign` title, initial Cancel focus, irreversible-action warning and explicit Delete action. The description now identifies the selected record using the same full context as the trigger. The trigger remains `type="button"`; the trash SVG is explicitly decorative.
- Hotel Room Types expose distinct `Edit room type …`, `Save changes to room type …`, and `Cancel editing room type …` names from the original full record identity and stable ID. Blank names fall back to `Room type [ID]`; the heading uses that same fallback. Unsaved draft renaming does not rename the action's target.
- Room actions remain visible at narrow widths and become visible on hover or keyboard focus at desktop widths. Existing button focus rings and card geometry remain. Edit/Save/Cancel explicitly use `type="button"`; Save still invokes only its existing validated API handler. Opening/cancelling does not save.
- Entering Hotel edit mode focuses the name input. Cancellation returns focus to the restored Edit button for the same ID and restores the stored title. A hidden/removed row loses its unsaved draft rather than carrying that draft across search/filter results. Tab unmounting also resets edit state. Cancel is disabled while an explicit Save request is already in flight.
- These surfaces currently use inline English strings and no translation hook/catalog. New strings follow that existing convention; no localization subsystem was added. Only record name and existing numeric ID are used for context, with no added customer/contact data.

Changed runtime files:

- `client/src/app/dashboard/(main)/chats/page.tsx`
- `client/src/app/dashboard/(main)/hotel/components/RoomTypesTab.tsx`

Coverage files:

- `client/src/__tests__/iconActionAccessibility.test.tsx`
- `client/e2e/icon-action-accessibility.spec.ts`
- `client/e2e/fixtures/icon-actions.ts`

Shared-file integration note: AS017 search-label work may touch the same two runtime files. AS018 primarily changes action controls, identity helpers, confirmation descriptions and Hotel focus hooks; it does not add/change search input labels. Integrate both sets of changes and rerun their focused suites.

## Verification

| Check | Actual result |
| --- | --- |
| New AS018 regressions against unchanged base | Six tests fail because contextual action names are absent. Isolated detached worktree at the exact base with the new synthetic fixtures/tests only. |
| Targeted component/query/workspace regressions | Three suites, 16 tests passed (six AS018 + four hotel query/cache + six campaign workspace regressions). |
| Client source typecheck | Passed before changes and after changes, using `tsconfig.typecheck.json`. |
| Focused ESLint on all five code/coverage files | Passed, zero errors and zero warnings. |
| Full client source lint | Same baseline and final result: one error, 204 warnings. |
| Production build | Passed with normal webpack build, TypeScript enabled, all 302 static pages generated and build tracing complete. |
| Desktop/narrow production-build browser regressions | All six passed; 73.75 seconds, no skipped/flaky/unexpected tests. Chromium 151.0.7922.173, 1440×900 and emulated narrow 390×844. |

The sole full-source lint error is `react/display-name` at `client/src/__tests__/businessBillingIdentity.test.tsx:47`. This file is unchanged; both base and working copy have blob hash `a8dfa37434c1d8a707cbae6028e54f9f08392565`. The final full-source lint excludes only this run's disposable `.next-as018-build/**` output via a CLI argument; source rules, limits and assertions are unchanged. An initial unscoped lint rerun was stopped when it began scanning that build output.

The first build compiled successfully but failed TypeScript on a malformed pre-existing `.next/dev/types/validator.ts:1799` (`rc/app/...`). This generated cache predates the task (mtime `2026-10-09 17:08:08 UTC`; SHA256 `6ae6f75899661761b24b39599a2c3b00b7c3b2d12ec08fad946fea31ca29f010`). The malformed directory is preserved at `/tmp/as018-stale-next-dev-types`. The second attempt exposed another saved-cache error: `.next/types/app/admin/dashboard/settings/ai/page.ts` references an admin route absent from current v8; its mtime is `2026-10-09 16:59:37 UTC`. The entire remaining old `.next` cache is preserved at `/tmp/as018-saved-next-cache`. Only ignored generated artifacts were moved; source/compiler settings are unchanged. The standard build is rerun with all TypeScript checks enabled. Next's temporary additions to the tracked tsconfig were restored before commit.

Regression checks cover every rendered action by role/name, full names despite actual CSS truncation, duplicate/missing identities, ICP name precedence, native button types, decorative SVGs, keyboard Enter/Space opening, dialog title/description associations and Cancel initial focus, no navigation/deletion on open/Cancel/Escape, restored trigger focus, filtered/paged target identity, mocked deletion of only the confirmed synthetic record, Hotel distinct Edit/Save/Cancel states, repeated cancellation, search/tab resets, no unrelated form submission, preserved validation and mocked Save of only the selected row. Browser fixtures additionally assert hover/focus visibility, visible focus rings, in-viewport action geometry, no document overflow and no unexpected API writes or console errors. Counts derive from fixtures/current query results, rather than the live QA page's observed record count.

Browser evidence is committed in [AS018_ICON_ACTION_EVIDENCE_2026-10-10.json](AS018_ICON_ACTION_EVIDENCE_2026-10-10.json): actual test statuses/durations, rendered dialog snapshots and intercepted-request checkpoints. All cancellation checkpoints have zero deletion/Save requests; campaign confirmation deletes only synthetic ID 911, and Hotel Save updates only synthetic ID 803. Every checkpoint has zero unexpected writes. Tests also assert stored room fixture values/other rows remain unchanged through cancellation. Desktop Campaign and narrow Campaign/Hotel cancellation screenshots were visually inspected for visible focus, truncation and retained layout. Raw screenshots/traces and logs remain locally in `/tmp/as018-evidence`.

The first browser launch could not create a page because Playwright's FFmpeg download was absent. Download hosts returned 403; the disposable `/tmp/as018-playwright` cache uses the installed `/usr/bin/ffmpeg` (7.1.5) through a symlink. Video, screenshots, traces and all assertions remain enabled. Intermediate runs caught test harness selectors: a `has` locator incorrectly included `#main-content` inside each room card, and a numeric pagination selector targeted a control hidden on narrow layouts. The selectors were corrected to the selected Save button's card ancestor and the visible Next button, retaining the same focus/record/paging assertions. Earlier runs were interrupted once the harness issues were diagnosed; they are not counted as passing verification. The final six-test run used the final test file unchanged throughout and passed against the standalone production server.

Reproduction commands (from `client`, with existing installed dependencies):

```sh
npm run test -- src/__tests__/iconActionAccessibility.test.tsx src/__tests__/hotelWorkspaceQueries.test.tsx src/__tests__/campaignWorkspaceConsolidation.test.tsx
npm run typecheck
npm run lint -- 'src/app/dashboard/(main)/chats/page.tsx' 'src/app/dashboard/(main)/hotel/components/RoomTypesTab.tsx' src/__tests__/iconActionAccessibility.test.tsx e2e/icon-action-accessibility.spec.ts e2e/fixtures/icon-actions.ts
npm run lint -- --ignore-pattern '.next-as018-build/**'
NEXT_DIST_DIR=.next-as018-build NEXT_PUBLIC_API_URL=http://127.0.0.1:8080 NEXT_PUBLIC_WS_URL=ws://127.0.0.1:8080 npm run build
# Serve the generated standalone/client/server.js with copied public/static assets on loopback port 3108.
PLAYWRIGHT_BROWSERS_PATH=/tmp/as018-playwright PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium E2E_BASE_URL=http://127.0.0.1:3108 E2E_SKIP_WEBSERVER=1 npm run test:e2e -- e2e/icon-action-accessibility.spec.ts
```

The saved environment's pnpm wrapper tried to install into an unavailable home directory, so scripts were run with npm against the already installed dependencies. No dependency/lockfile changes were made. React review confirms stable record keys, targeted effects/ref cleanup, no new fetching, preserved shared Radix/Button semantics and no additional package or global UI change. `git diff --check` passed.

## Safety and limits

All records are synthetic fixtures. Unit API methods are mocks; browser API requests (including auth, deletion, Save and unknown endpoints) are fulfilled in the browser. Application WebSockets are mocked by the existing regression fixture. No real authentication, customer record mutation, live deletion/Hotel Save, provider job, message, payment, migration, backfill, deployment or external communication was performed.

These are local component and browser checks, not a live deployment verification, a real screen-reader session or a complete accessibility audit. Server tests, the full client unit suite, unrelated E2E suites, Firefox and WebKit are outside this targeted UI change. No server/runtime API behavior was changed.
