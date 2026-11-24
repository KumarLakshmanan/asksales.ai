# CRM reminder baseline explanation — 2026-10-23 UTC

This handoff changes only the existing CRM PostgreSQL fixture and this report. No production reminder, notification adapter, authority or replay behavior changes. Base: `babc42072ba499dab9cf504d69e2270acc0979d4`; remote v8 independently read as `356fd2849883ae268b07f1b554975bff7b51ac48`. ReminderService, ReminderNotificationDeliveryService and the CRM workspace test were identical between these trees and CRM's `d35a5f43aa3f0452c9d2de188da0f42725b0917d` for the examined boundary.

## Reproduction and cause

The original `moves contact follow-up to the retry date...` test reproduced unchanged: **1 failed, 26 skipped**. It returned `{success:false,error:'Fixture delivery failure'}` from the notification mock and expected `pending`, a future retry date, and a cleared claim. Actual persisted result was `failed`, retry_count1 and a retained lastSentAt.

`ReminderNotificationDeliveryService.ts` deliberately classifies a false result without `deliveryAttempted:false` or `outcomeUncertain:false` as `unknown`. It records that destination receipt and throws ReminderNotificationUncertainError. ReminderService holds that error instead of automatically replaying a possibly accepted message. Therefore this failure does not demonstrate broken safe retry: the fixture supplied an uncertain outcome for an expected confirmed-rejection scenario.

The corrected existing mock explicitly supplies `outcomeUncertain:false`. Every original assertion remains; an additional assertion checks the durable internal-destination receipt is failed. A separate real-persistence case leaves the outcome unspecified and verifies unknown receipt, held claim, no sentAt, unchanged actionable contact date and zero further attempts on another scheduled processing call. The correction does not replace a failure with synthetic success or weaken receipt protection.

## Verification

Run serially from server with `CRM_WORKSPACE_LOCAL_QA=1`, `FOLLOW_UP_IMPLEMENTATION_DATABASE_URL=postgresql://audit:synthetic_local_only@127.0.0.1:32770/followup_qa`, DB_HOST127.0.0.1/DB_PORT32770/DB_NAMEfollowup_qa and synthetic local user/password, plus `NODE_OPTIONS='--require=<repo>/server/tests/helpers/followUpLocalOnly.cjs --experimental-vm-modules --max-old-space-size=4096'`:

`node node_modules/jest/bin/jest.js --runInBand --runTestsByPath tests/crmWorkspacePostgres.test.ts tests/reminderNotificationDeliveryPostgres.test.ts`

Result: **34 passed, 2 suites** (28 workspace including the new uncertainty control, 6 receipt cases). Actual CRM/reminder service, Drizzle/PostgreSQL transactions, scoped pool/runtime role and fixture RLS run. All notification effects are mocked; external TCP and saved env reads are blocked. A disposable PostgreSQL16 container was used. Public base-table shapes were generated from actual model columns/defaults, omitting business-profile defaults because the existing scoped test installs its own current-setting default. First disposable bootstrap failed on absent app_business_profile_id; this harness omission was corrected, not a product change. This is not a production migration rehearsal or actual SMTP/Resend acceptance test.

Full server TypeScript (`tsc --noEmit --incremental false`) passed. Scoped ESLint passed with 0 errors and 3 unchanged existing explicit-any warnings (mock declarations at lines34–36). Whitespace check passed. Evidence: `/workspace/followup-reminder-baseline/{retained-crm-baseline.log,red.log,green.log,types.log,lint.log,bootstrap.mts}`. Parent cannot read that separate filesystem; this committed report contains the substantive evidence.

## Limits and disposition

- Baseline retry assertion: explained and fixture corrected, with both safe retry and uncertainty acceptance. No new production reminder defect established.
- Actual adminEmailService currently does not expose these optional outcome fields. Unclassified failures therefore continue to hold conservatively; this handoff does not invent a safe-retry classification for that adapter. Any adapter-specific definite rejection improvement needs its owner and real adapter tests.
- Existing alert copy says 'after 3 attempts' even when uncertainty causes a first-attempt hold. This source observation is separate from the baseline expectation, not silently treated as a proven retry defect or changed here.
- Campaign's cb9c68f3 two CRM email schema-fixture corrections are separate; not included or claimed tested here.
- No live sends, paid calls, production DB mutations, credential/security-setting changes, deployment or v8 writes.
- Required repository vscode_askQuestions verification remains **pending: tool unavailable**; no formal completion claim. Prior external-hook metadata denials are not retried. Publication on a normal unique handoff is authorized; remote v8 integration and CI remain the integration owner's gates.
