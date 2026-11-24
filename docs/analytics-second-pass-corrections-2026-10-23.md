# Analytics second-pass correction ledger — 2026-10-23

Base: `24c66b9cac2936ccbd119e39cf78b5b83b1e6212`, fetched from
`https://github.com/KumarLakshmanan/salesmarketing.git` at
2026-10-23T16:27:49Z. It matches the final second-pass audit snapshot. Previous
Analytics handoff `e08db4c4e4a006a58aad1cd29eddf5863dd36cf6` is an included
ancestor. The original reports and before-fix evidence are preserved separately.
This ledger covers the second-pass queue; it does not replace that audit.
During final preflight, remote v8 advanced to
`4476be38c6122d278c09c6fdd63c3c63aae27dc0`. Its delta from the tested base is
limited to support handoff/member controllers and a support regression file;
the reporting service/controller, Paid Ads callers and workflows are unchanged.
The correction remains based on24c66b9c; the integration owner can apply its
single commit to the newer tree. Combined whole-tree acceptance belongs there.

## Implemented correction

**A2-03, P2: provider detail trace end-date bounds.**

`GET /api/campaigns/analytics/provider/meta/777?account=7&period=7d`
previously excluded a future daily row from the KPI aggregate but included it
in `performanceTrace`. The same mismatch occurred with 30d and 90d. The route
uses `getProviderCampaignAdPerformance` in `autonomousAdsController.ts`, then
`AdPerformanceService.providerPerformanceDetail`. The UI consumes that trace
in `CampaignDetailPage.tsx`.

The correction captures the requested UTC reporting window once and uses it
for the campaign aggregate, child aggregate, reporting labels and inclusive
trace start/end filter. It preserves the existing 30-day API default, internal
service cached-snapshot mode, legacy no-daily-history fallback and stored raw
daily history. There is no ingestion rewrite, migration or historical repair.
The managed-campaign fallback and its separate SQL path are unchanged.

Reproduction uses a disposable network-isolated PostgreSQL instance, fixed
clock 2026-10-23, the actual mounted campaigns router, controller, service and
generated SQL. Each window contains a row before its start, a start-day row
with an exact duplicate, an end-day row and an Oct24 future row. Before the
correction the card reports spend30/conversions3.75 but the trace includes
Oct24 and sums to130. Afterward both report spend30 and the same two included
dates. Child aggregates/labels match; PostgreSQL raw history remains unchanged.

The regression is `server/tests/providerDetailWindowPostgres.test.ts`, enabled
only by `PROVIDER_WINDOW_LOCAL_QA=1`. Five assertions/tests cover 7d/30d/90d,
the API default and the distinct internal cached mode. The final before-fix
run had **3 failures / 2 passes**; the unchanged acceptance assertions against
the correction had **5 passes / 0 failures**. An earlier draft control wrongly
assumed an absent API period meant a snapshot. Source inspection showed the
controller's existing 30-day default; that draft failure is a harness error,
not an additional application defect. The direct service snapshot control
now separately verifies the intended compatibility behavior.

## Complete second-pass disposition

| Finding | Current status and next acceptance gate |
|---|---|
| A2-01 P2 stale account/period detail response | **Awaiting Paid Ads dependency.** No concurrent UI edit here. Only the latest immutable business/account/campaign/window request may replace the view. Reverse successful response order, older late failure, rapid date/account changes, browser back and business changes must preserve the latest context and prevent stale actions. |
| A2-02 P2 legacy redirect loses account/date context | **Awaiting Paid Ads dependency.** Legacy provider and managed URLs must retain whitelisted account/currency/period/tab/unit/return context; duplicated provider IDs across accounts must result in one canonical scoped request and correct back navigation. Consider a typed account-required 4xx instead of generic500 within that owner scope. |
| A2-03 P2 trace future-date inclusion | **Fixed in this tested patch; awaiting integration.** Five real PostgreSQL/mounted-route acceptance tests pass. No claim of current remote-v8 acceptance until integration. |
| A2-C01 P2 availability unknown versus zero | **Explicit product/data-provenance decision hold.** Returned positive/fractional provider values are already preserved. Agree provider-specific absent/null/available-empty/measured-zero semantics and a legacy provenance policy before changing normalization, API/UI/export contracts or history. Do not infer unavailable revenue, FX or historical facts from zero caches. |
| Historical carry-forward repair | **Explicit data-owner decision hold.** Existing repair guidance remains a dry-run proposal only; select authoritative source/account/date/currency/attribution windows, compare immutable source keys and approve a bounded reconciliation before any historical writes. No backfill executed. |
| Monetary verification semantics | **Explicit policy hold; integrated helper preserved.** Caller-supplied transaction, scoped immutable replay checks and exact NUMERIC refund bounds are unchanged. No new verification/settlement policy or Hotel orchestration change. |
| P3 duplicate legacy Sheet/detail requests, renderers and formatters | **Awaiting Paid Ads dependency.** Consolidate scoped read requests/window/context and read-only presentation only after compatibility/bookmark/tab/back/error tests. Preserve separate effect authorization, actor/billing identity and ledger boundaries. No deletion or refactor here. |
| P3 cold error-state heading/live announcement | **Awaiting Paid Ads dependency; optional UX improvement.** Preserve visible Retry and message, consider semantic page heading and consistent live announcement; verify keyboard/focus/retry in the owning UI. No formal compliance failure was established. |
| Suspected mobile overflow | **Withdrawn/resolved.** The original screenshot caught a sidebar transition; settled 390px normal-zoom checks fit. No corrective CSS justified. |
| Historical dialog opener focus | **Resolved in integrated `176e6352236bff2052c6e47538a7eb27fb5da735`.** Four desktop/mobile production-browser cases passed during the second audit; not repeated for this server-only patch. |
| Historical ledger WI02/WI03 and HT05b helper issues | **Resolved in integrated `e08db4c4e4a006a58aad1cd29eddf5863dd36cf6`; preserved.** Ten selected PostgreSQL cases passed during the second audit. Hotel passes the caller transaction; full Hotel HTTP acceptance remains its owner's gate. No ledger source edited here. |
| Earlier final-ref HTTP503 | **Resolved for this phase.** Fresh fetch succeeded and v8 remained24c66b9c at the recorded baseline time. A later push/ref verification is separately recorded in delivery evidence. |
| Earlier cross-owner pending integration | **Resolved as source integration.** Tenant/privacy, Followups, Campaign, Instagram, Social Listening570 and corrected organic LinkedIn are included. Their wider tests are owner evidence, not acceptance executed by Analytics. |

The suspected no-period UI mismatch is not promoted to a finding: the actual
controller already defaults the API to30d, matching the current selector.
This is distinct from the confirmed legacy redirect dropping an explicit7d.
The Insights product publication hold is unchanged; no held product patch was
copied, implemented or published through this correction.

The first-pass R01–R16 correction groups and their historical evidence remain
in `docs/reporting/IMPLEMENTATION_STATUS.md`; its original local-only delivery
status is historical, superseded by the included reporting/ledger commits.
Its remaining C02/C04/C05 lifecycle, late-attribution and monetary decisions,
C06 unused pixel-queue activation and C07 conversational date/ranking contract
are **decision holds/reproduce-first**, not silently completed by this patch.
The C03 large-history/social cap item belongs to the Social owner for current
source reconciliation; no old cap failure is asserted as a new current defect.
Unscored-zero provenance, concurrent export snapshots and broader paid-detail
browser coverage remain documented gates, not passed tests.

## Final-source verification

All commands ran from an env-free physical server copy with identical changed
source/test hashes, inherited credentials removed, UTC and an outbound-network
guard. Tests ran serially. PostgreSQL used tmpfs, network none and a temporary
Unix socket; the container and socket were removed after the run.

| Check | Result |
|---|---|
| New mounted-route/PostgreSQL regression | **5 passed**, zero skipped in the explicit opt-in run |
| `paidAdReportingWindow.test.ts` | **2 passed** |
| `reportingCorrections.test.ts` | **16 passed** |
| `adPerformancePolicy.test.ts` | **32 passed** |
| Changed service/test ESLint | **0 errors**, one unchanged `no-explicit-any` warning at service line88 |
| Full server TypeScript, `--noEmit --incremental false` | **Baseline failure only:** `settings.test.ts:201` TS2322 and `:222` TS2352; no new diagnostics |
| API and worker esbuild entry bundles | **Passed**; bundles compiled, not executed/deployed |
| Diff whitespace / source-copy checks | **Passed** |
| Frontend/browser and full historical suites | **Unrun in this correction**, no UI source changed; prior audit evidence retained |
| Required repository `vscode_askQuestions` helper | **Blocked/unavailable:** no callable helper in this environment. `.github/instructions/verification.instructions.md` requires it before overall completion; no answer or successful completion signal is claimed. |

Representative execution (from the env-free server copy, not tracked runtime
environment files):

```sh
env -i PATH="$PATH" TMPDIR=/tmp NODE_ENV=test SKIP_DB=true \
  FILE_LOGGING_ENABLED=false LOG_LEVEL=silent TZ=UTC \
  PROVIDER_WINDOW_LOCAL_QA=1 \
  NODE_OPTIONS='--experimental-vm-modules --require=/workspace/audit-reporting/no-external-network.cjs' \
  node node_modules/jest/bin/jest.js --runInBand --forceExit \
  --runTestsByPath tests/providerDetailWindowPostgres.test.ts
```

The same serial Jest setup ran the three affected unit files without the opt-in
flag. The new database suite otherwise skips by design. Its real boundaries are
router validation, controller, selected-account lookup/service projection,
generated SQL, persistence and response. Authentication/module/credit gates and
unrelated actions are synthetic mocks; the database schema is minimal and does
not exercise full RLS/membership/billing. No live provider, queue, export,
account-timezone policy or browser chart acceptance is claimed. The existing UTC
convention is preserved rather than replaced with an invented provider policy.

## Integration contract

Changed files are exactly the service, new PostgreSQL regression and this ledger.
Apply the single new correction commit on top of the recorded current-v8 base.
There are no new dependencies, migrations, configuration changes or backfills.
Existing migration370 and earlier reporting fixes are already in the base.
The correction adds only a private optional helper argument; public service and
Hotel/SalesEvidence signatures remain unchanged. Paid Ads may consume the same
response shape while implementing its own race/navigation fixes.

Only the designated integration owner writes v8. Normal handoff publication is
authorized; published SHA, remote-ref verification and exact file manifest are
returned separately. Checked-in workflows on this base restrict push triggers
to main/v8/v7/staging, excluding the handoff branch; no workflow was changed.
Previously denied external hook/actions/deployment metadata reads remain
unretried, so external hook visibility is unknown. No live effects or deployment
commands were performed, and no green-CI or all-scope-complete claim is made.
