# Proposal legacy fixture maintenance — 23 October 2026

This is a separate test-only follow-up to verified proposal handoff `fc96096c7569196e7bf8f7e8183275036107a9fb`. That five-fix subset remains unchanged and independently available for integration. No application implementation, legacy send/approve/revise API, signature affirmation, reconciliation receipt, provider policy, migration, environment file, dependency or deployment trigger changes are included here.

## Baseline and before/after evidence

The current proposal implementation is the published fc96096c handoff. Remote v8 was independently fetched at `e92ea9cca3eca7d025128f037877a91ae0148a60` at 2026-10-23 17:14:52 UTC and again at 17:27:53 UTC. The handoff's direct parent is `a73dd61ed8876bd6774440ee2f3b06b4d7e63170`; later e92 changes concern notification/email UI and shared error-envelope/context boundaries, not these proposal services or three legacy fixtures. This follow-up's dependency is fc96096c, so its test-only delta can be integrated separately after that subset. It does not claim latest full-app/global-middleware acceptance.

Fresh disposable pgvector PostgreSQL was migrated through all 331 existing migrations; Redis was loopback-only. Explicitly enabling all three legacy suites on the unchanged source reproduced the recorded result exactly: **40 passed / 19 failed / zero skipped / 59 total**. After fixture maintenance, all three suites execute their original cases: **59 passed / zero failed / zero skipped**. A wider final proposal selection with both local database switches enabled passes **252 tests / zero failures / eight browser skips / 260 total**, across all 16 suites. The same 59 cases pass within that wider run.

| Suite | Before | Final wider run |
| --- | --- | --- |
| `proposalApprovalPostgres.test.ts` | 0 passed / 13 failed | 13 passed / zero failed/skipped |
| `proposalDeliveryPostgres.test.ts` | 26 passed / one failed | 27 passed / zero failed/skipped |
| `proposalWorkspacePostgres.test.ts` | 14 passed / five failed | 19 passed / zero failed/skipped |

No surviving application failure was established after supplying faithful fixtures and required local configuration. No product code correction was needed. These counts supersede the old legacy-fixture gate only; they do not retroactively turn earlier guarded skips into passes.

## Fixture corrections and retained assertions

### Approval policies and immutable review requests

The old handwritten policy table had only a user key; the production service writes `ON CONFLICT(business_profile_id,user_id)`. All 13 cases therefore failed before reaching their intended assertions. The approval ledger also had an obsolete uniqueness definition.

The fixture now clones current policy and approval tables using `LIKE public.<table> INCLUDING ALL`, preserving current columns, defaults, checks and compound indexes. It supplies the suite's synthetic business/current-user database settings, includes business identity in the loaded proposal DTO and gives foreign reviewer rows their own business identity. No reviewer, threshold, stale-review, simultaneous-decision or automatic-authority assertion was removed or weakened. All 13 cases now reach and pass their intended assertions, including inactive/foreign reviewers, pending team decisions, simultaneous approval serialization, stale changes and automatic-commercial exclusions.

### SMS recipient/account freezing

The old successful SMS fixture used plaintext `qa-secret`, omitted encryption/verification metadata and supplied an invalid nine-character sender ID. The current shared MSG91 contract requires a six-character uppercase/alphanumeric sender, protected credentials, a verified connection, sender binding and a complete Flow contract.

The fixture now uses the real encryption/key-ID helpers with a synthetic local key, real readiness inspection, current metadata and valid synthetic sender `QASEND`. Matching input/expected account literals were updated together; identity/freezing/transcript assertions remain. The current policy table is cloned rather than re-created with old DDL, and database business defaults/foreign-row identities are explicit. The provider dispatch, credit reservation and refund remain mocked. The incomplete-Flow negative case still rejects readiness; the successful SMS case now reaches and passes the same send, frozen target and durable transcript assertions. All 27 delivery cases pass.

### Workspace schema, business context and branding DTO

The old fixture recreated catalog/events/versions from migration-248-era DDL, omitted the review-policy table, invoked AI services without their required business AsyncLocalStorage context and inserted company settings without the now-mandatory billing organization.

The fixture now clones current workspace/approval tables before exercising the existing seed migration twice. Service scenarios run inside real `withBusinessScope`; fake controller calls use the matching caller scope. Synthetic company profiles include billing identity. Because `LIKE` does not copy triggers, proposal writes additionally retain the actual production `enforce_business_ownership` trigger and manifest. Setup-only administrative SQL uses a separate fixture connection; service SQL uses explicit primary business/user settings with that ownership trigger enabled.

The branding test still asserts that `Private Company Identity` is absent from the opted-out LLM prompt. Its stale `businessProfileId === null` DTO assertion was corrected: that field now stores immutable tenant ownership, which must remain the selected business (1). The real ownership trigger supplies that identity. A new assertion excludes business source metadata, and a positive-control suggestion proves the same selected profile would appear when the template opt-out is absent. The test updates the active synthetic profile instead of inserting an unrelated profile. This strengthens the intended branding/identity assertions; it does not make ownership nullable or change product behavior.

The foreign widget-session rejection still returns null when invoked under the foreign caller's matching business scope. An additional assertion checks that deliberately mismatching account and scope rejects with the existing account-scope guard. Repeated/concurrent identity binding, idempotent draft, no outbound destination and no email assertions remain intact.

All 19 workspace cases pass, including the distinct legacy approval/send/revise paths. Those APIs were neither consolidated nor deleted.

## Verification and exact boundaries

Commands ran from server/ under `env -i`, with only synthetic JWT, loopback Redis and explicit disposable database URLs. Tracked environment files were temporarily excluded from the isolated worktree; no inherited provider credential or production database was used.

```sh
# Full formerly skipped selection:
NODE_OPTIONS=--experimental-vm-modules \
CLIENT_URL=https://proposal-audit.example.test \
PROPOSAL_QA_DATABASE_URL='<loopback disposable proposal_audit_pass2 DSN>' \
./node_modules/.bin/jest --runInBand \
  tests/proposalWorkspacePostgres.test.ts \
  tests/proposalApprovalPostgres.test.ts \
  tests/proposalDeliveryPostgres.test.ts --json

# Wider selection: also supply PROPOSAL_AUDIT_DATABASE_URL for runtime-RLS tests.
./node_modules/.bin/jest --runInBand tests/*roposal*.test.ts --json
```

The 59 legacy cases use real PostgreSQL persistence, transactions, locks, current table/index/default contracts and (for workspace proposal writes) the real ownership trigger. They use isolated schema clones, not the complete production RLS/FK/trigger graph or mounted authentication stack. Existing provider, LLM/knowledge, notification, CRM, SupportService and credit mocks remain explicit boundaries. SMS crypto/readiness is real; its external provider and account verification are synthetic fixtures. No live send, paid API, charge/refund or external account mutation occurred.

The wider run additionally exercises the separate public-lifecycle/runtime-RLS cases and concurrent-default tests against the migrated public schema. **Eight browser cases were intentionally unrun in this fixture-only follow-up**, because no frontend/browser URL was supplied: two public/PDF and six authoring/delivery journeys. Their prior successful compiled-production executions belong to fc96096c's separate evidence and are not counted again here. No frontend or app source changed; UI/build checks were not duplicated for this test-only delta.

The first wider attempt omitted the required synthetic CLIENT_URL, producing five public-delivery readiness failures. Supplying the documented local public URL resolved them without a source or assertion change. Intermediate workspace setup failures after restoring the ownership guard were also fixture problems: administrative status arrangement used an unscoped connection, and a foreign-user negative case needed the foreign caller's matching context. They are retained in evidence and not labeled application defects.

Touched-test ESLint passes. Server typecheck retains only the two known unrelated `settings.test.ts:201,222` fixture errors; changed fixtures introduce no errors. No green repository-wide typecheck or CI claim is made. The conditional DB guards remain unchanged: these suites require explicit local QA dependencies and are not silently forced to pass when those dependencies are absent.

## File/dependency manifest and remaining holds

This follow-up changes only:

1. `server/tests/proposalApprovalPostgres.test.ts`
2. `server/tests/proposalDeliveryPostgres.test.ts`
3. `server/tests/proposalWorkspacePostgres.test.ts`
4. `docs/proposal-legacy-fixture-maintenance-2026-10-23.md`

The dependency is fc96096c plus the existing migrated schema/crypto helpers. No migration or shared file is owned or changed by this patch. Signature affirmation and an additional reconciliation receipt remain held. Distinct legacy APIs remain intact; passing fixtures are evidence for their existing contracts, not permission or proof that they can be replaced by a different API. The existing integration owner alone writes v8. Publication, if successful, is an ordinary fast-forward update of the unique proposal handoff branch, with this fixture commit independently identified from fc96096c.
