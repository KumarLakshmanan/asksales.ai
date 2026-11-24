# Gmail connection diagnostics and reliability

## Incident evidence — 15 October 2026

Read-only inspection of `dev.asksales.ai` found callback failures at 11:21:00,
11:21:25, 11:21:50, 11:31:24 and 11:36:46 IST. They logged only
`[GmailOAuth] Callback error`. The callback explicitly discarded the exception
and returned `connection_failed`; its client message could not distinguish
mailbox identity, permission inspection, credential persistence or sender setup.
No recoverable exception, Google reason, HTTP status or failing step was stored.
The historical triggering cause cannot be established from those records.

A successful connection followed at 12:57:19 IST for business profile 1,
`aimplify ai`. On 16 October, a controlled check confirmed refresh HTTP 200,
Gmail profile HTTP 200, matching saved mailbox identity and an active inbox watch.
That verification did not read messages, send email, change configuration or
replace stored credentials. An expired short-lived access token alone was not
evidence of a broken connection: the saved ongoing grant renewed successfully.

## Proven defects repaired

1. **Failure details were discarded.** Callback failures now record a random
   reference ID, exact setup step, stable failure category, approved Google
   reason/HTTP status, PostgreSQL SQLSTATE or network code. Wrapped database
   causes are inspected. Raw exception messages/stacks, SQL, provider response
   bodies, authorization codes, tokens and mailbox identities are never logged
   or returned by this diagnostic path.
2. **The installed Google auth SDK replays token exchange.** Version 10.6.2's
   `AuthClient.RETRY_CONFIG` includes POST. An injected-fetch test reproduced
   four calls after a synthetic Google 503. A per-connection request interceptor
   disables both `retry` and `retryConfig.retry`, preventing reuse of an
   authorization code that Google might already have consumed. Setting only
   `retry: false` was insufficient: the SDK's explicit retry configuration still
   caused four requests. The final regression asserts one request with the real
   installed SDK and no live Google traffic. This is a verified defect, not
   proof that it caused the historical incident.
3. **Temporary mailbox failures aborted setup.** Safe mailbox identity reads
   retry network, temporary Google server and rate-limit errors at most twice,
   with 1s/2s delays and a 5s request timeout. Permanent permission, disabled
   API, account-policy and daily-quota failures do not retry. Code exchange and
   database writes do not use this retry helper. Other connection requests have
   a 10s transport timeout; optional display-name lookup has a 3s timeout.
4. **Errors disappeared with a toast.** A dismissible alert retains the reason,
   failed step and reference after callback query cleanup. Copy error details
   includes the stable code for support. All displayed query values are mapped
   through allowlists and the reference must be a UUID. The alert preserves the
   existing interface and uses foreground text for readable contrast.
5. **Success logging preceded sender setup.** Success is recorded after sender
   setup, while an optional inbox-watch failure has its own safe warning details.

Retry behavior follows [Google's Gmail error-handling guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

## Operator workflow

Ask for the copied error details. Find the matching `gmailDiagnosticId` in dev
API logs or the system log context. Inspect `failureStage`, `failureCode`,
`providerCode`, `httpStatus`, `databaseCode` and `networkCode`. Typical categories
now distinguish a disabled Gmail API, Google Workspace policy, missing scopes,
rejected client credentials, expired/reused authorization, database permission
denial, missing migrations, duplicate records and unavailable services.

Do not assume a generic Google 403 means the API is disabled: only Google's
explicit `SERVICE_DISABLED`/`accessNotConfigured` reason yields that diagnosis.
Unknown exceptions retain their failing step and reference without inventing a
specific underlying cause. Do not disconnect a working account to reproduce an
old failure. A fresh user-initiated failure can now be traced precisely.

## Verification

- Server: 84 tests across diagnostics, real Google SDK transport, callback,
  state, mailbox binding and business permissions passed.
- Client: 52 tests across callback recovery, safe error rendering/copying,
  authorization lifecycle and existing email components/read behavior passed.
- Changed source and tests pass ESLint; Impeccable's mechanical check found no
  issues in the changed interface.
- Server type checking passed. The default client/Next build config exposed a
  pre-existing campaign-test typing gap: its fixture declares
  `Window.emailWorkbench` in a TSX file excluded by that config. A type-only
  import in the test makes the declaration available without executing the
  fixture or changing application behavior.
- Initial local browser verification passed desktop. Mobile was blocked by
  Windows EPERM during the existing atomic development-asset rename. A preview
  across drives also hit Next's Windows module-resolution limitation. Final
  browser verification uses copied application source on the same drive, no
  environment files, and omits only the development-only asset-write plugin.
  These preview failures do not establish a Gmail application failure.
- Both desktop and mobile passed the new diagnostic/copy/dismiss/overflow
  browser check. The wider browser run passed 17/18; its first cold request
  encountered a partial development chunk (`Invalid or unexpected token`).
  A targeted rerun of that one failed desktop case passed after compilation.
  Runtime exceptions and failed RSC requests remain fatal in the tests.

Live rollout and final browser results are recorded separately with the release.
