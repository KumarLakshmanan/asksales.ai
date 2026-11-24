# Operational hardening implementation

The first-pass receipt below is historical. Later integration/publication and the current
UI corrections are recorded in the dated second-pass section at the end.

Base: `35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7`. The original audit and evidence remain
unchanged outside the checkout. These changes are local review candidates: no commit,
push, deployment, credential rotation, live settings change or restore was performed.

## Implemented acceptance boundaries

- Tracked server credential defaults are empty and required startup validation remains
  intact. Unconfigured providers receive no fallback live keys. Supply private values in
  ignored `server/.env`; removing tracked values does not revoke historical credentials.
- Recursive Docker exclusions cover nested environment files and private-key files.
  `scripts/check-build-secrets.mjs` reports only key names and line numbers.
- A migration/backup failure leaves old writers stopped. Production holds one remote
  release lock through checkout, build, migration, replacement and verification; staging
  uses the same lock and never forces over dirty changes. Images carry the selected SHA;
  the private manifest records previous SHA, backup, image IDs and completion/failure.
- Both release entry points require a clean checkout and `RELEASE_VERIFIED_SHA` equal to
  HEAD after CI review. This is an explicit operator attestation; repository branch
  protection/required-check configuration must enforce it independently.
- Rollback metadata identifies refusal-only migrations before any down SQL. A rollback
  batch uses one transaction, preserving earlier schema/history when a later down fails.
  Migration URI credentials use structured fields; `status` performs no DDL.
- Tracing executes the provider callback once, preserves original results/errors under
  setup/end failures, and emits metadata/usage without prompts, output or raw error text.
- Pino records pass one recursive sanitizer before all sinks, including child bindings.
  Existing field-path redaction still protects structured exception messages/stacks.
  DB log persistence caps in-flight writes and exposes content-free pending/drop counters.
- API readiness checks DB/Redis with a deadline and fails while draining. Worker readiness
  additionally requires running consumers; Compose probes it on an internal-only port.
  A 150-second stop budget and explicit pool cleanup improve draining; long operations
  still need their existing provider receipt/uncertainty reconciliation.
- CI covers operational files and release branches, runs bounded synthetic regressions,
  enforces pnpm 10.30.3, checks empty defaults/exclusions and fails on advisory-query errors.

## Ownership and integration

OPS-09 / DI06 shared migration locking is owned by Data. This patch changes Pool creation,
status and rollback transaction/preflight regions in `server/scripts/migrate.mjs`, not lock
acquisition. Integrate Data's lock changes around the whole rollback transaction and around
mark-applied. Do not merge either workstream independently into the remote branch.

The integration candidate composes Data commit `d84dbe95`'s session advisory-lock
helper and up/down/mark-applied regions with this Release runner. The lock spans
the complete rollback transaction, including failure cleanup. Status retains
Release's read-only behavior, so it needs no schema-write lock. The rest of the
Data handoff remains separately held for its import/privacy acceptance gates.

Twelve historical migration files gain only `irreversible` metadata; their `up` SQL is
unchanged. If another workstream introduces migration checksums, explicitly approve this
metadata-only baseline rather than disabling drift detection or silently rewriting hashes.

The existing `settings.test.ts` type errors belong to the settings fixture owner and remain
baseline failures. No test was weakened to hide them. No frontend UI changed, so browser
journeys are not substituted for operational integration testing.

## Owner decisions still required

1. **Secret response:** identify owners/usage of exposed provider and encryption material;
   revoke/rotate it and plan compatible ciphertext re-encryption. No value was printed,
   used or claimed revoked. History/artifact cleanup requires a separate approved plan.
2. **Release governance:** configure required checks for the actual production/staging refs
   and approve the manual SHA-attestation process or replace it with verified CI provenance.
   Pin Actions/base images to reviewed immutable identities as part of that process.
3. **Recovery:** select RPO/RTO, retention, encryption/off-host destination and the DB/media/
   Redis/key snapshot/reconciliation policy. A complete synthetic restore drill is still
   needed. Never auto-restore a database or replay externally accepted sends/payments.
4. **Browser containment:** select/deploy a sandboxed browser service with no app/provider
   credentials, narrow storage access, bounded resources/egress and a timeout/cleanup API.
   Browser execution currently remains in app containers; no unverified sandbox flag or
   infrastructure topology change was invented here. Coordinate SSRF policy with Security.
5. **Monitoring:** choose an independent alert/error destination, event thresholds, log-loss
   metrics and access/retention controls. Metadata-only tracing deliberately provides no
   customer-body debugging store. Do not export raw content to diagnose an outage.
6. **Migration integrity:** approve checksum baselining and long-migration budgets. Timeouts
   limit hangs but the full production migration history was not run by this implementation.

## Verification

Use the focused unit suites for telemetry/logging/readiness and provider recovery; run
`python3 -m unittest discover -s scripts/tests -p 'test_deploy*.py' -v` for fake-command
release failures, backup ordering, lock contention and manifest verification. Run
`node --experimental-vm-modules --test scripts/tests/migration-safety.test.mjs` for synthetic
tracking/rollback and metadata checks. All such SQL/provider effects are in-memory or mocked.
The test network guard is a backstop, not a general-purpose sandbox.

The original audit defect-observer harnesses are preserved as evidence. They intentionally
expect old failures and are not acceptance tests for the patched source. Acceptance tests
are the new checked-in regressions and the final-source results in the implementation ledger.

## Second-pass corrections (2026-10-23)

Owner: original Release audit chat. Base: `a73dd61ed8876bd6774440ee2f3b06b4d7e63170` (advanced without conflicts from audit baseline `24c66b9cac2936ccbd119e39cf78b5b83b1e6212`).
Original audit/evidence remains preserved outside this implementation checkout.

### Finding ledger

| Finding | Status | Result / remaining boundary |
|---|---|---|
| OPS2-01 contradictory health | Fixed with targeted and local HTTP evidence | Legacy inspection responses retain HTTP 200 but report measured bounded DB/Redis health. External workers, queues and event-bus state are unknown rather than invented. No current UI outage is claimed for these legacy endpoints. |
| OPS2-02 queue credential forms | Fixed with real Redis/API evidence | `redactCredentialText` is shared by logs and queue diagnostics. Queue PII markers, depth/size limits and permissions are preserved. |
| OPS2-03 stale log responses | Fixed with unit/browser evidence | Superseded requests are aborted; only the current controller may update rows, loading or errors. Unmount aborts outstanding reads. |
| OPS2-04 timezone window | Fixed with real SQL/browser evidence | Local date controls send explicit ISO instants; device-local interpretation is visible. Kolkata and New York contexts select the intended SQL rows. |
| OPS2-05 false-zero statistics | Fixed with unit/browser evidence | Unavailable counts are distinct from valid zeros; last-known counts are labeled stale and have an independent retry. |
| OPS2-06 keyboard access | Fixed with unit/browser evidence | Native named disclosure/filter buttons, expanded state, visible labels and focus. Desktop/mobile layout remains at normal zoom. |
| OPS2-07 draining race | Fixed with unit/HTTP evidence | A dependency probe begun before draining cannot finish healthy after the flag changes. Real production SIGTERM/load-balancer traffic remains unrun. |
| OPS2-08 initial failure shown as empty (newly reproduced) | Fixed with unit/browser evidence | Initial read failure shows unavailable count/results rather than a successful empty result. Retry restores actual rows. |
| NEW-AUTH-UI01 queue keyboard access | Awaiting original Auth/admin UI owner | Standalone production UI reproduced DIV queue cards with tabIndex -1 and job rows with no keyboard disclosure. `client/src/app/admin/dashboard/queues/page.tsx` was not edited. Add named native queue-navigation/disclosure controls while preserving super-admin and pause/retry/cancel/clean boundaries. |
| NEW-TENANT-MIG01 missing irreversible markers | Awaiting Tenant/Data; baseline check failure retained | The required migration metadata scan fails at `340_live_capacity_plan_retention.js`; static enumeration also identifies `341_modern_resource_capacity.js`. Both refusal-only down implementations lack the irreversible marker. Runner, scan and those migrations are unmodified here. Coordinate metadata-only correction with their owner; this is not evidence of the remote CI failure cause. |
| S1 mandatory notification consumer | Awaiting Notifications/root decision | The caught NotificationEventConsumer startup failure and workers-map-only readiness need an explicit decision on required consumers and recovery behavior. No worker startup policy was invented or modified. |
| S2 mocked telemetry completion hang | Withdrawn as a current SDK defect | Installed Langfuse 3.38.20 `generation.end()` returns the client synchronously; disabled-network SDK probe confirms it is not thenable. Existing once-only tracing/error tests remain. Future asynchronous completion/deadline policy requires fresh evidence. |
| I1 log-loss diagnostics | Safe subset fixed; alert policy held | Actual logger registers its sink; authenticated admin health exposes enabled/pending/dropped counters for this process only, without record content. Independent alert destination/thresholds and worker aggregation remain owner decisions. |
| I2 duplicate metrics endpoints | Resolved by preserving distinct contracts | Both already share QueueRegistry metrics. Their wrappers/authorization surfaces differ legitimately. No endpoint was deleted or permissions widened; retirement would require external caller inventory. |
| I3 migration drift/runbook | Runbook corrected; checksum policy held | Default advice to delete tracking rows/run independent down SQL was removed. No migration ledger, checksum baseline, schema or historical record was changed. |
| I4 labels/freshness | Fixed | Destination-specific settings button names, visible date/filter labels, device-timezone hint, and last-success timestamps/staleness. |
| Failed push CI diagnostics | Blocked / unknown cause | Existing failed checks are not green. Previously denied metadata/annotation/log operations were not retried; workflows and deployment triggers are unchanged. |
| Settings-fixture TypeScript errors | Preserved baseline | `server/tests/settings.test.ts:201` TS2322 and `:222` TS2352 remain outside Release ownership. |

### Integration dependency manifest

- Keep `server/utils/logRedaction.ts`, `server/utils/queueDiagnostics.ts` and their credential
  regression together. Auth/Support callers retain their separate PII/authorization policies.
- Keep `server/infrastructure/logPersistenceDiagnostics.ts`, its logger registration and the
  infrastructure controller read together. These counters never contain log records and do
  not claim to aggregate other processes or deliver alerts.
- The log page uses the existing admin API client's AbortSignal support. No API-client,
  authentication, tenant/business/billing identity, notification delivery or queue processor
  contract was changed.
- The migration instruction edit is documentation only. Data owns checksum policy; Notifications
  owns required-consumer semantics. No shared locking/migration implementation was edited.
- Only the integration owner may write v8. This change is intended for the existing Release
  handoff branch; no deployment or workflow mutation is authorized by this document.

### Verification interpretation

Regressions assert corrected behavior and were recorded failing before their corrections.
The original audit observers that asserted defects are not counted as fixed acceptance.
Real local boundaries use disposable PostgreSQL/Redis, actual mounted admin handlers/models
and actual Next UI source. Authentication, unrelated controllers and provider effects remain
mocked; no customer data, sends, payments or paid model calls are involved.

Final test/type/lint/build/browser receipts and before/after outputs are retained in the task's
isolated verification workspace. Full production recovery, deployed traffic, provider effects,
credential rotation, branch protections and CI diagnostics are not verified by these local checks.
Final local results include 32 server and 12 client targeted tests passed, 20 fake-deployment
tests and one real Docker exclusion test passed, client types/scoped lint/API-worker and client
production builds passed. The migration scan is 5/6 passed with the baseline marker failure
above; server types retain only the two settings-fixture baseline errors. Seven standalone
production browser journeys exercised the fixed boundaries, while recording the separate
queue keyboard gap rather than treating its observer as acceptance.
The repository's `vscode_askQuestions` helper is unavailable in this environment; its required
owner-verification step remains pending rather than being treated as passed.
