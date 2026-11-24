# UX001: Home navigation and completed setup

This is a focused implementation of the 9 October 2026 UX recommendation. It addresses an observed density and discoverability tradeoff; it does not establish a functional navigation defect or an objectively superior layout.

## Base and scope

Repository: `KumarLakshmanan/salesmarketing`, verified through the Git remote. The initial GitHub default was `v7`. The subsequent explicit base correction selected the latest remote `v8`, fetched at `09fe888ec8bdd3fa12ccee0e047cd1d876306222`. The issue branch was adjusted before it had changes, commits, or a remote branch. No published history was rewritten.

The isolated local Home UI reproduced the reported competition at 1311 × 841 using ten synthetic campaigns and one completed next step: CRM and Support were below the visible sidebar, while quick starts reached the bottom edge of the main viewport.

## Focused decisions

- Lead Generation, Content Creator, CRM, and Support appear first in the sidebar. This prioritizes the four work areas named in the acceptance criteria. Other modules retain their relative order after those destinations. Module access filtering remains in place.
- Campaign history starts collapsed on Home when there is no saved preference. Existing account preferences remain authoritative, and a campaign route still opens its section by default. Moving work areas above history also accommodates a previously saved expanded Campaigns section.
- Campaign links retain their complete text as their accessible names and gain native title tooltips. New campaign and View all campaigns remain available in the expanded section.
- When every next step returned by the existing role/module-aware completion logic is complete, Home shows a compact success summary. Native details/summary provides keyboard review of the original checklist, first goal, refresh control, and links. Incomplete steps remain expanded; unverified channel selections do not count as completed connections.
- A four-row brief and reduced spacing bring quick starts higher. The work-context column appears beside the brief at 1280px and above; narrower screens receive the brief and quick starts first at full content width. Submission, voice input, quick-start actions, initial Home tab behavior, and profile selection handlers are unchanged.
- Shared navigation configuration and page-finder rendering are unchanged. The CRM and Support Pipeline entries remain distinct.

No authentication, tenant/business selection, API, schema, campaign record, or provider behavior was changed. No merge, deployment, or live data changes were performed.

## Validation

- Eight local Chromium Playwright regressions passed in `client/e2e/home-ux001.spec.ts`: 1311 × 841, 1024 × 720, keyboard campaign and setup review, campaign expansion persistence, saved expanded history, sidebar visibility persistence, first-time incomplete workspace steps, mobile overflow at 390 × 844, and page-finder Pipeline distinction. At both laptop sizes, the four workspace headings are fully in view and at least half of the first quick-start button is in view.
- 51 focused Vitest tests passed across nine files: `homeCompletedSetup`, `workspaceNavigationImprovements`, `sidebarNavigation`, `authTenantCacheIsolation`, `sidebarMenuGroup`, `workspaceSetup`, `businessProfileSwitch`, `workspaceChooserImprovements`, and `workspaceProfileEditingRecovery`.
- Client source typecheck passed. Targeted ESLint passed for every changed TypeScript/TSX file.
- Full client source lint (`pnpm --dir client lint --ignore-pattern '.next*/**'`) found one existing error and 218 warnings. The error is `react/display-name` at `client/src/__tests__/businessBillingIdentity.test.tsx:47`. That file matches the fetched base; isolated lint reproduces the same error. It is outside UX001 and was left unchanged.
- Production build passed: `NODE_ENV=production NEXT_DIST_DIR=.next-ux001-build pnpm --dir client build`, including TypeScript and generation of 302 static pages. The initial build encountered stale `.next/types` entries for retired routes in the saved environment. Removing only those generated types and rerunning resolved it; no source or build-configuration change was needed.
- Final diff reviewed with `git diff --check`. Temporary browser configuration and automatic Next.js tsconfig additions are excluded from the commit.

The pinned Playwright browser download returned HTTP 403 / Domain forbidden. Local browser validation used the installed system Chromium with a temporary configuration, an isolated dev build directory, and video recording disabled. Network fixtures supply synthetic accounts, profiles, campaigns, suggestions, and completion status; unexpected API mutations are blocked by the fixture. Before/after, laptop, mobile, and incomplete-setup screenshots are retained in `/workspace/ux001-artifacts` and contain fixture titles only.

## Limits and follow-up

The complete client test suite, server checks, live authenticated sessions, provider workflows, and production behavior were not validated. These are local UI and regression results. User task-completion validation is still required before calling the layout objectively better. Incomplete onboarding intentionally remains prominent; expanded workspace subsections can still require sidebar scrolling. Persisted choices are respected rather than reset for returning accounts.
