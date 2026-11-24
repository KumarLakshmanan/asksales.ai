# Assistant-centred outreach: rollout and verification

The settings entry point is `/dashboard/settings/outreach`: list → create draft →
configure explicit resources → simulator → assignment review → publish. The old
specialist editor remains under `/dashboard/settings/outreach/legacy` as a reference
for the preserved legacy settings; it does not provide a runtime fallback.
Only WhatsApp, Instagram, Facebook Messenger, email and web chat are supported.

## Activation and migration

> **Warning — there is no legacy fallback.** Unless `SUPPORT_ASSISTANTS_ENABLED`
> is exactly `true` (and, when `SUPPORT_ASSISTANTS_BUSINESS_PROFILES` is set, the
> business profile is in that allowlist), no automatic customer reply is
> generated or sent on any channel. Routing fails closed with "Assistant replies
> are disabled. No legacy agent fallback is permitted."; the old specialists are
> not used instead. Customer-bound sends through the WhatsApp, Instagram,
> Facebook and email provider services, including new outreach batches, are also
> rejected with `ASSISTANT_SETUP_REQUIRED` (`runtime_disabled`). Inbound WhatsApp
> and Instagram/Facebook messages are still stored in their conversations for
> staff to read. Draft management and explicit simulator previews keep working.

1. Apply the additive `311_outreach_assistants` migration with the existing
   migration runner before deploying the new settings UI. It depends on the
   existing business-scope and support-orchestration migrations. Do not run
   automatic-reply workers against a copied production database.
2. Leave `SUPPORT_ASSISTANTS_ENABLED` absent/false initially. Draft management and
   explicitly selected assistant previews work in this state, but customers
   receive no automatic replies (see the warning above); it is not a return to
   the previous specialist routing.
3. As the business owner, use **Import existing settings**. Import is idempotent:
   approved knowledge/media, instructions, policies and tools are enumerated;
   determinate account/playbook/template settings are copied. Every import is
   paused and requires review. Multiple active legacy specialists, split traffic,
   unresolved credentials and generic/custom-body reminder settings are never
   guessed. No CRM or message history is removed.
4. Review each account's verified identity, provider/classifier/vault readiness,
   knowledge, PII collection fields, playbooks, templates, tools and approved
   fallback models. Optional categories require explicit selections or **None**.
5. On development, set `SUPPORT_ASSISTANTS_ENABLED=true` and restrict
   `SUPPORT_ASSISTANTS_BUSINESS_PROFILES` to a comma-separated list of approved
   development business-profile IDs. Invalid allowlists fail closed. An omitted
   list with the flag true intentionally enables routing for every profile.
   Flagged but unassigned accounts stay silent; publish reviewed bindings before
   exposing them to customers. Use only approved test contacts.
6. Verify actual provider receipts for private replies, comment replies, PDFs and
   proposal actions. The local simulator deliberately suppresses delivery,
   approvals, CRM effects and persistent customer decision audits. It proves
   configuration behavior, not real provider delivery. Web follow-ups remain
   unavailable because there is no proactive delivery transport.
7. Expand the profile allowlist gradually. Inspect `resolvedAssistant` in decision
   audit traces and assistant provenance in outbox/message/tool-approval records.

## Runtime guarantees

- Receiving identity is resolved from owned persisted records, not a selected
  integration. One enabled assistant exists per profile/account/surface.
- Published revisions are immutable; saving a draft does not alter a live reply.
  A turn uses one frozen configuration through generation, tools and delivery.
- Redaction, the encrypted privacy vault, business/audience permissions and
  high-risk approvals remain mandatory. An empty resource allowlist means none.
- Only the primary and explicitly approved fallback models can generate replies.
  Reply length controls do not cap internal classification/verification budgets.
- Reassignment supersedes unsent work and incompatible approvals. Public comments
  never advance private intake; private follow-through needs a matching private
  binding for the same assistant/revision/account. CRM history is retained.
- Rapid-message batching remains in the existing turn coordinator. Completed
  sessions retain history; the next session starts a fresh journey.
- Support check-ins start only from confirmed delivered support replies. Customer
  replies stop campaign reminders. Opt-out, human takeover, closure, pause,
  reassignment, withdrawn approvals and missing variables stop pending check-ins.
- Template personal values are inserted at the delivery boundary, never exposed
  to the model. Provider uncertainty is not reported as delivery or blindly retried.
- Availability is 24/7 by default. Explicit hours defer check-ins. Away-message
  reservations expire after five minutes; only confirmed sends consume the
  six-hour per-customer/account rate limit.

## API and rollback

All management APIs are profile-scoped under `/api/settings/outreach/assistants`.
Writes require the existing business-owner permission; staff access is unchanged.
Publishing requires `expectedDraftVersion` and `confirmAssignments:true`.
Account conflicts additionally require explicit `reassign:true`.

To restore the preceding release's **account bindings**, POST
`/:id/rollback-bindings` with `expectedPublishedRevision` and
`confirmAssignments:true`. It uses the immutable pre-publish binding snapshot,
rechecks current readiness, cancels superseded work and preserves history. It
rejects intervening account or previous-assistant changes instead of overwriting
them. To publish one assistant's previous configuration as a new revision, POST
`/:id/rollback` with `revision`, `expectedDraftVersion`, `confirmAssignments:true`
and explicit reassignment confirmation if needed.

For an emergency stop, disable `SUPPORT_ASSISTANTS_ENABLED` or remove the
affected profile from its allowlist. Assistant-bound pending deliveries fail
closed and no further automatic replies are generated or sent. This does not
restore legacy routing: the preserved legacy settings are not used to answer
customers, and customer-bound sends stay rejected (see the warning under
"Activation and migration") until the flag is re-enabled.
Both rollback endpoints above return 409 while the runtime is disabled.
Do not drop the migration after any revision is
published: its down migration deliberately protects published/audit history.

## Local verification

### Settings and operations improvements

- Setup checklist, field errors, explicit unsaved-navigation protection and
  tab-local structural recovery guide configuration without publishing it.
  Guided policy controls retain an advanced validated JSON option.
- Account assignments share one health view across Settings and Operations.
  Resource selection has search, bounded rendering, safe previews and reasons
  for unavailable resources. Playbook routing previews use runtime precedence.
- Follow-up creation and assistant sequences share fictional-variable preview.
  Business approval never implies Meta/provider approval or an open message window.
- Revision history supports comparison and explicit rollback as a new revision.
  History combines paginated confirmed messages, schedules and real delivery
  records with cancellation/failure reasons.
- Saved scenarios replay sequential messages with assertions and separate
  draft/published sessions. Model/stage traces report actual runtime metadata;
  provider delivery and customer-side effects remain suppressed in previews.
- `/dashboard/settings/outreach/operations` reports per-day/account/channel
  outcomes, tokens and exact attributed recorded model-cost estimates. These
  are not billing invoices; historical unattributed costs remain unavailable.
  Staff do not receive owner-only cost totals.
- Knowledge review includes stale/conflicting/unverified answers, daily counts,
  redacted question samples, conversation links and durable review notes.
  A new occurrence reopens a previously reviewed gap.
- Inbox/CRM timelines show current assistant, playbook, session and follow-up
  context alongside actual PDF/proposal statuses and provider receipts. No
  unverified media links or ambiguous legacy-ID mappings are manufactured.

These changes reuse the existing additive assistant schema and audit ledger.
They do not enable production feature flags or perform live provider calls.

Use the project's bundled Node 24 runtime. Run the assistant configuration/model
tests, support regression suites and frontend tests. Server typechecking needs
an increased heap (`NODE_OPTIONS=--max-old-space-size=8192 pnpm --dir server exec
tsc --noEmit`) in this repository.

For real PostgreSQL isolation tests, create a disposable database whose name
starts `asksales_assistants_qa_`, apply the required migrations, then set
`ASSISTANTS_TEST_DATABASE` and run `server/tests/outreachAssistantsPostgres.test.ts`.
External providers are offline fakes. Optional `ASSISTANT_BROWSER_QA_PORT` serves
the isolated management API for browser verification without starting cron or
provider workers; POST its loopback `/__qa/stop` endpoint when finished. Never use
this fixture server or its authentication stubs outside local QA.

### Verification record — 3 October 2026 improvements

- 235 distinct backend checks passed across assistant configuration/catalog,
  PostgreSQL revisions/routing/privacy/follow-ups, exact usage attribution,
  message batching, journey corrections, session lifecycle, audit and
  PDF/proposal safety suites. External providers were offline fixtures.
- 65 distinct frontend checks passed across the editor, policies, structural
  recovery, bounded resource selection, revision review, simulator, operations,
  follow-up creation, Support-AI selection and Inbox/CRM timeline/navigation.
- Four desktop/mobile Playwright checks passed with isolated API responses,
  covering account health, knowledge review, scenario controls, unsaved guards
  and horizontal-overflow checks. Screenshots were visually inspected.
- Scoped frontend TypeScript and changed-file whitespace checks passed.
  Scoped backend TypeScript is clear for these assistant changes but still
  reports three existing implicit-`any` callbacks in `CRMService.ts` (lines
  798–799); those unrelated changes were preserved.
- No production data, feature flags, deployments or live deliveries changed.
  The repository's final owner-verification question remains pending review.

### Verification record — 29 September 2026

- 278 backend unit/regression tests, 31 assistant PostgreSQL tests, 65 existing
  conversation/document/proposal PostgreSQL tests and 37 frontend tests passed
  (411 total).
- Server and client TypeScript checks, the client production build and the API
  and worker production builds passed.
- Chrome verification covered creation, explicit resource selection, draft
  simulation with redaction, account-conflict review, publishing, draft/live
  separation, pause/resume, discard and availability controls against the local
  API and PostgreSQL fixture.
- No production migrations, feature flags or deployments were changed. Actual
  WhatsApp/Meta/email delivery receipts still need development canary verification
  with approved test contacts before activation.

## Local browser session

The current local session serves the frontend at `http://localhost:3000` and the
backend at `http://localhost:8080` (`/health`). It uses the isolated
`asksales_local_browser_20260929` PostgreSQL copy and Redis database 15, not the
original `salesmarketing` database or production. Required business-isolation,
membership and assistant migrations were applied to that copy only.

Login additionally requires `312_crm_configuration.js`, because the current
business-profile model selects `company_settings.crm_configuration`. This
additive migration is installed in the local copy; the profile and toolkit
queries used after authentication were verified under the runtime role. Do not
remove business-access protections to work around an outdated local schema.

The API runs with `DOTENV_OVERRIDE=false`, `DISABLE_BACKGROUND_JOBS=true`,
`START_EMBEDDED_MEDIA_WORKERS=false` and `SUPPORT_ASSISTANTS_ENABLED=false`.
Scheduled jobs, the approval reaper and embedded sending/media workers stay off;
no dedicated workers are started. These opt-in startup switches do not change
normal production defaults. Draft management and the explicit Support-AI
simulator remain available. With the flag false, customer-bound sends are
rejected with `ASSISTANT_SETUP_REQUIRED`; use approved test contacts only once
it is enabled.
