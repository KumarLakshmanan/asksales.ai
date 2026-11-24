# AS015 — Dashboard main landmarks

Issue branch: `codex/asksales-as015-20261010`.
Base: latest fetched `origin/v8`, `ab4d082821f9007bc24c94137471413fff389a46`.
The required prior integration is the base itself. The saved checkout tracked only v7;
`git fetch origin refs/heads/v8:refs/remotes/origin/v8` refreshed the stale v8 tracking ref.
The checkout was initially clean. No AGENTS.md or checkout .agents/skills files were present;
`/workspace/.agents` was empty. No v8 merge or push was performed by this issue task.

## Source cause and fix

The shared `DashboardLayout` already owns `main#main-content`, its breadcrumb and page children.
The affected children independently emitted page-level main elements:

| Source | Confirmed inventory it covers | Change |
| --- | --- | --- |
| `client/src/app/dashboard/(main)/proposals/page.tsx` | Proposals | Main → div, same classes/children |
| `client/src/app/dashboard/(main)/settings/outreach/orchestration/page.tsx` | Outreach Orchestration | Main → div, same classes/children |
| `client/src/components/integrations/IntegrationWebhookPage.tsx` | Instagram Events | Main → div, same classes/children |
| `client/src/components/ai-visibility/Portfolio.tsx` | AI Visibility list | Outer main → div; the existing list section now references `ai-visibility-title` instead of duplicating its text in aria-label |
| `client/src/components/ai-visibility/AiVisibilityWorkspace.tsx` | Website overview and eight sections | Main → heading-associated section; error/audit-detail wrappers → div |

The portfolio keeps its existing named list region instead of adding another region with the
same name. The website workspace is a deliberately named section containing the selected
website's navigation, measurement context, settings and results. Heading IDs and useful
associations remain. All original wrapper classes remain identical. No role="main" was added.
The dashboard layout, skip link, breadcrumb, focus styles, data behavior and permissions are unchanged.

Regression files:

- `client/src/__tests__/aiVisibilityWorkbench.test.tsx`: 11 new rendered checks for the portfolio,
  all nine website views and the unavailable-website state, composed inside the dashboard main.
- `client/e2e/dashboard-main-landmarks.spec.ts`: direct loads, controlled loading/content states,
  refreshes, DOM and Chromium accessibility-tree assertions, skip navigation, keyboard traversal,
  reflow, route navigation and browser history, plus shared wrappers.
- `client/e2e/fixtures/dashboard-landmarks.ts`: browser-local synthetic identity/data, empty and
  populated proposals, incoming events, operations outcomes, and completed AI Visibility project/audit data.
  Every API request is intercepted. Existing mount-time project-resolve and competitor-suggestion POSTs
  return static fixtures; all other non-read actions are blocked and asserted absent.

## Local verification

The results below separate baseline failures from the focused change. No local result establishes a live deployment result.

| Check | Result |
| --- | --- |
| Baseline AI Visibility unit/integration suites | 53 passed |
| Relevant final unit/integration suites | 87 passed in six files |
| Client typecheck | Passed at baseline and after implementation |
| Production webpack build | Baseline passed; final clean isolated build passed |
| Changed-file lint | No errors; two existing AI Visibility hook-dependency warnings |
| Full client lint | Existing `businessBillingIdentity.test.tsx:47` react/display-name error and 204 warnings; unchanged from baseline |
| Baseline browser reproduction | All 26 direct-load DOM observations failed the single-main assertion: 13 routes × two viewports, each with two visible mains and a nested child |
| Final browser regression | 34/34 passed in the final combined sweep (17 desktop + 17 narrow), including AS010; expanded navigation and explicit fixture-state reruns also passed |

Commands use the repository's installed binaries and npm scripts because the environment's
pnpm 11 attempted an unnecessary managed-package installation outside the writable workspace.
No dependency or lockfile was changed. Node: 24.19.0; Playwright: 1.62.1; installed system
Chromium: 151.0.7922.173. The standard Playwright browser download was network-filtered;
coverage uses installed Chromium, with installed ffmpeg provided through a temporary runtime symlink.

The final production build used `NEXT_DIST_DIR=.next-as015 npm run build`. An intermediate
attempt encountered a malformed generated validator in an interrupted `.next/dev/types` cache.
Generated build output was moved aside under `/tmp/as015`, and a clean build succeeded without
changing source assertions, build checks or TypeScript limits. Next's temporary tsconfig additions
for the isolated output were reverted; generated output and runner configuration are not committed.

Reproduction commands (serve a local production build; all API data is mocked):

```sh
cd client
npm run test -- src/__tests__/aiVisibility.test.tsx src/__tests__/aiVisibilityWorkbench.test.tsx src/__tests__/webhookEventsWorkspace.test.tsx src/__tests__/proposalSettings.test.tsx src/__tests__/proposalTemplateExperience.test.tsx src/__tests__/brandToolkitFormAccessibility.test.tsx
npm run typecheck
npm run lint
npm run build
npm run start -- --hostname 127.0.0.1
E2E_SKIP_WEBSERVER=1 PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium ../node_modules/.bin/playwright test e2e/dashboard-main-landmarks.spec.ts
```

The local combined run also executed the unchanged `brand-toolkit-landmarks.spec.ts`, using
a temporary config that supplied the system Chromium executable to both existing projects.
AS015 viewport sizes are 1440×900 and 390×844 CSS pixels. The retained AS010 test uses
1311×841 and 390×844. These are Chromium viewport checks, not physical-device coverage.

## Explicit route inventory

All 13 live-confirmed AS015 routes are exercised locally with synthetic data:

1. `/dashboard/proposals`
2. `/dashboard/integrations/instagram/events`
3. `/dashboard/settings/outreach/orchestration`
4. `/dashboard/ai-visibility`
5. `/dashboard/ai-visibility/websites/1`
6. `/dashboard/ai-visibility/websites/1/seo`
7. `/dashboard/ai-visibility/websites/1/aeo`
8. `/dashboard/ai-visibility/websites/1/geo`
9. `/dashboard/ai-visibility/websites/1/commerce`
10. `/dashboard/ai-visibility/websites/1/competitors`
11. `/dashboard/ai-visibility/websites/1/fixes`
12. `/dashboard/ai-visibility/websites/1/assets`
13. `/dashboard/ai-visibility/websites/1/reports`

The final tests require exactly one visible main, no implicit/explicit main ancestor, one
non-ignored Chromium accessibility-tree main, and one main in the rendered ARIA snapshot.
They preserve the unique `main-content` ID, heading association and current breadcrumb.
All routes receive delayed/held data responses and are refreshed after settling. The skip link
still targets the content start; native fragment navigation places subsequent keyboard traversal
inside that main. Further Tab checks reach proposal/event filters, portfolio measurement filters,
website measurement selectors, and orchestration tabs without activating side effects.

Website list, overview and all eight sections are traversed using their rendered links/native
select, leaving and returning through the portfolio with Back/Forward checks. Proposals is
reached through dashboard page search; Instagram Events through the parent integration's Events
link; orchestration through Assistant operations' Reply queue. Empty proposals and a populated
synthetic offer are covered. Events and orchestration contain synthetic data only; AI Visibility
uses a synthetic saved project, completed audit and SEO page inventory, with empty section results
where appropriate. No new analysis is requested.

Additional local audit of sources changed by this fix:

- `/dashboard/integrations/facebook/events`, `/dashboard/integrations/whatsapp/events`,
  `/dashboard/integrations/msg91/events`: reachable consumers of `IntegrationWebhookPage`.
- `/dashboard/ai-visibility/audits/11`: audit-detail consumer in the changed workspace module.
- Unavailable website state on `/dashboard/ai-visibility/websites/1` and a corresponding unit test.
- `/dashboard/brand-toolkit/new`: retained AS010 regression, all five panels.
- LinkedIn/Twitter Events also import the shared component, but their routes redirect to Home;
  source-audited only, with no claim that the hidden Events view was rendered.

The dashboard route-group source audit found other independent main wrappers in
`/dashboard/proposals/[id]`, `/dashboard/support/notifications`,
`/dashboard/settings/outreach/[agentType]`, `/dashboard/enrichment`, and
`/dashboard/outreach/campaigns/[id]/review`. These are source-level candidates outside the
13-route confirmed inventory and the changed shared components. They were not changed or
claimed as live/browser-confirmed findings by this task. No application-wide accessibility claim is made.

## Evidence and limits

The initial baseline landmark capture waited for the route heading; its overview alerts fixture was subsequently completed for the final settled-state checks. The 26 recorded baseline DOM observations establish the nested wrappers at capture time; they do not prove every asynchronous baseline section response had settled.

- [Baseline DOM observations](as015/evidence/baseline-landmarks.json): 26 captures, two visible nested mains each.
- [Final DOM and accessibility observations](as015/evidence/verified-landmarks.json): the 26 exact-route captures and test outcome summary.
- [Proposals desktop](as015/evidence/proposals-desktop.png) and [narrow](as015/evidence/proposals-narrow.png): synthetic empty list.
- [Website overview desktop](as015/evidence/ai-overview-desktop.png) and [narrow](as015/evidence/ai-overview-narrow.png): synthetic completed audit/project.

An early fixed-browser attempt exposed a missing synthetic alerts response and an overly exact
label lookup; the fixture/role locator were corrected. A later sweep passed 33/34 cases and
caught a test race: browser Back was issued before the preceding client navigation committed.
The trace showed the correct Events page before the click and the parent Instagram page after
the premature history call. Explicit destination-URL waits fixed the test sequencing; both
focused desktop/narrow history reruns passed. No assertion or timeout was weakened, and no
production navigation code was changed for these test-harness issues.

There were no customer mutations, delivery reconciliations, permission changes, messages,
auth/payment changes, provider/AI jobs, migrations, backfills or live deployment checks.
No private replies occur in fixtures or evidence. Real screen-reader sessions, Firefox,
WebKit/Safari, live deployed retests, every dataset-dependent state, and other website IDs
were not tested. The parent owns final integration into v8 and deployment verification.
