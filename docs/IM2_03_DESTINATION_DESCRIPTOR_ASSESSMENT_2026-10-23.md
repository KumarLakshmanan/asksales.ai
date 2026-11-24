# IM2-03: destination descriptor assessment

**Resolution: withdraw the proposed extraction.** No broken destination or material metadata drift was demonstrated. No new shared interface, registry, adapter, application change, or sidebar caller edit is proposed. The coordinator can close this technical improvement without blocking UI integration.

## Source examined

- Fresh `origin/v8`: `52c189ef4b4d0d4a1e8a13023af2e597ce3f10f1`, whose parent is the supplied accepted baseline `7705d63689823f56f672a520f1e1d726a08f0204`.
- Fetched UI handoff: `801f0d5fe789b9137e1da47d7994383c7a776996` (`handoff/audit-20261023-ui`). The eight relevant source/test files listed below are identical across those three revisions.
- Read checkout Copilot, client and verification instructions; no checkout `AGENTS.md` or applicable `.agents/skills` files were present.

## Existing sharing and actual overlaps

[`dashboard-destinations.ts`](../client/src/lib/dashboard-destinations.ts#L113) already derives ordinary entries from sidebar `navSections`/`bottomNavItems`, imports `NavItem`/`NavSection`, calls `availableNavigationSections` with the verified workspace role, and delegates whitelisted query construction to `navigationItemHref`. The existing contracts are [`NavItem`](../client/src/lib/sidebarConfig.tsx#L41), [`availableNavigationSections`](../client/src/lib/sidebarConfig.tsx#L249) and [`navigationItemHref`](../client/src/lib/sidebarConfig.tsx#L264).

AST inspection found five exact URL overlaps between explicit finder task records and sidebar leaf records:

| Destination | Finder line / sidebar line | Assessment |
| --- | --- | --- |
| Assistants | `dashboard-destinations.ts:62` / `sidebarConfig.tsx:240` | Same URL, `support_ai` module and three workspace roles; finder adds task aliases and settings context. |
| Widget settings | `:64` / `:185` | Same URL, module, roles and `team` query whitelist; both use the shared URL helper. |
| Staff | `:65` / `:239` | Same URL, label and roles; no module requirement. |
| CRM configuration | `:67` / `:156` | Same URL, effective `crm` gate and roles. Finder's “CRM configuration” and sidebar's contextual “Configuration” are intentional labels. |
| Proposal settings | `:68` / `:200` | Same URL, effective `proposals` gate and roles; finder adds context/aliases. |

The remainder should retain distinct contracts:

- Finder form entries include `kind`, task aliases and explicit catalog permission for creating an assistant. They are not ordinary sidebar leaves. `CommandPalette.tsx:67–94` combines selected-workspace verification, the provider catalog's management permission and module access before exposing them.
- The Integrations overview is owner/billing-admin discovery; provider read pages remain independently available. Applying one overview role policy to the entire provider section would change access.
- Sidebar Paid Ads opens its workspace; finder entries select four specific tabs; integration features select provider-filtered campaigns/performance; onboarding opens a blank campaign brief. Unifying those URLs would change task intent.
- `workspace-next-steps.ts:25–42` derives titles/completion from saved preferences, verified connections and owner/module checks. Sidebar integration entries already derive provider labels/routes from `integrationDefinitions`/`integrationPath`; replacing onboarding's legacy channel labels requires another mapping, not less policy.
- Settings discovery has a third metadata consumer, `settings-navigation.ts`, with scope, editable-role and verification rules. Extending the proposal to that registry would exceed a narrow two-caller extraction.

A type-only descriptor would rename `path`/`label` and `href`/`title` through adapters without preventing value drift. A value registry would still need contextual overrides and policy ownership. Existing helpers and tests already cover the demonstrated common contract. Revisit only with a reproducible conflicting descriptor or a concrete repeated change that cannot safely use those helpers.

**Sidebar coordination:** no proposed interface or caller-line replacements; historical sidebar owner `01a1280f-0d0e-779c-9cb0-3de83da7b072` has no overlapping implementation request from this assessment. `DashboardLayout`'s delayed target observer, interaction cancellation, focus behavior, role verification, and `useSidebarPreferences` visit/saved-collapse handling were read and left untouched.

## Verification on the unchanged source

- **147 unit tests across 8 files passed** (`vitest run --maxWorkers=2`): `dashboardDestinations`, `dashboardDestinationMetadata`, `commandPaletteDestinations`, `sidebarNavigation`, `sidebarOrientation`, `workspaceNavigationImprovements`, `integrationWorkspace`, `paidAdsTabNavigation`.
- **Full client typecheck passed:** `node_modules/.bin/tsc --noEmit -p tsconfig.typecheck.json`, from `client`.
- **Scoped lint passed:** `node_modules/.bin/eslint src/lib/dashboard-destinations.ts src/lib/sidebarConfig.tsx src/lib/workspace-next-steps.ts src/lib/integrations.ts src/components/CommandPalette.tsx src/components/DashboardLayout.tsx src/hooks/use-sidebar-preferences.ts e2e/task-entry-links.spec.ts e2e/sidebar-orientation.spec.ts`, from `client`.
- **Production build passed:** tracked `client`/`shared` source copied to `/tmp/im2-03-preview`, with environment files excluded and installed dependencies linked. Built using `NEXT_TELEMETRY_DISABLED=1 NEXT_PUBLIC_API_URL=http://127.0.0.1:9 NEXT_PUBLIC_WS_URL=ws://127.0.0.1:9 node_modules/.bin/next build --webpack`. Copied production static/public assets into its standalone output, then served locally with `NEXT_TELEMETRY_DISABLED=1 HOSTNAME=127.0.0.1 PORT=3417 node .next/standalone/client/server.js`. No code was deployed.
- **Production navigation: 43 passed, 1 existing skip, 0 failed/flaky:** all **16 existing task-entry cases passed unchanged**; sidebar orientation contributed **27 passed and 1 existing desktop-project skip for the mobile-only navigation case**. No retries were used. Command from repository root: `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium E2E_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium node_modules/.bin/playwright test --config=/tmp/im2-03-playwright.config.ts task-entry-links.spec.ts sidebar-orientation.spec.ts --max-failures=1`. Temporary config inherited repository projects, set local base URL `http://127.0.0.1:3417`, system Chromium and video off; no repository runner config changed.
- Real project viewports were **1440×900** (Desktop Chrome) and **390×844** (Pixel 7). Existing sidebar journeys additionally set **1311×841, 1024×720, 768×1024 and 320×740**. Existing scale assertions retained normal zoom. Tests covered delayed target reveal, user-scroll cancellation, unchanged focus/collapsed preferences, reload/Back/Forward, provider/team/role/module gates and whitelisted team context.
- API traffic was synthetic and effects rejected. All task-entry journeys recorded **zero action requests**; sidebar journeys recorded **zero blocked mutation attempts**. No campaign/provider actions were invoked. No timeout/assertion/permission check or browser test was changed. The task-entry file's Git blob remained `551a84fcb50031d22f71e943d7edad1d48bd221e`.

## Limits and separate failed probe

An earlier broader production-build probe using `next start` reached the Blog/Email/DM finder destinations but failed its strict request audit on a cancelled `GET /api/notifications/unread/count` (`net::ERR_ABORTED`). A single-case repeat reproduced that audit failure. No audit exception was added, no request-failure assertion was relaxed, and no finder/UI fix is claimed. The successful standalone run above covers finder navigation through sidebar acceptance, not the entire finder-specific suite. This separate probe is an explicit acceptance limitation, not evidence of destination-descriptor drift or a live outage.

Local Node was 24.19.0 and system Chromium 151.0.7922.173. No GitHub CI result, live production/provider acceptance, live effects, credentials/settings change, CI/CD work, migration, or merge into `v8` is claimed. The repository-required `vscode_askQuestions` helper is unavailable in this cloud environment; that interactive gate remains unfulfilled. No affirmative answer was fabricated.

**Publication inventory:** this report only. The eight unchanged files compared across revisions were `client/src/lib/{dashboard-destinations.ts,sidebarConfig.tsx,workspace-next-steps.ts,integrations.ts}`, `client/src/components/{DashboardLayout.tsx,CommandPalette.tsx}`, `client/src/hooks/use-sidebar-preferences.ts`, and `client/e2e/task-entry-links.spec.ts`. No screenshots, private payloads, shared theme/layer changes or application edits accompany this handoff.
