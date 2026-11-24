# Proposal improvements: implementation and verification

Scope: all 22 requirements from the 2026-09-12 proposal review, plus proposal
creation, refinement, approval, and delivery from Mastra campaign chat and the
support/outreach runtime. Existing unrelated paid-ad work in the shared working
tree is outside this report.

## Requirement checklist

| # | Requirement | Result and evidence |
|---|---|---|
| 1 | Resolve template fields and keep writing guidance out of customer copy | **Implemented · verified.** Template materialization fills known customer/business fields, retains team-only `instruction` text, and reports unresolved fields. Declared required fields are checked locally as the seller types and again by the server, even when a field is not printed as a placeholder. The browser suite verifies the saved draft contains resolved customer copy without losing the selected template. |
| 2 | Preserve seller input during AI generation and allow selective replacement | **Implemented · verified.** AI input includes the current proposal, line items, commercial terms, sources, and selected section IDs. Server and browser tests verify pricing, recipient, template, and unselected text survive generation/refinement. |
| 3 | Add a shared “Ready to send” checklist and intentional free pricing | **Implemented · verified.** `shared/proposals.ts` is the common client/server readiness authority for identity, unresolved and declared template fields, scope, prices, dates, terms, package/milestone validity, and approval. A zero price must be explicitly marked complimentary. Missing objectives, deliverables, timeline, responsibilities, or budget appear as a nonblocking confirmation warning in the Review step. The API rechecks every blocking rule at delivery time. |
| 4 | Show subtotal, discount, tax, and total consistently | **Implemented · verified.** One shared pricing calculator feeds the editor, customer preview/page, and PDF. Unit tests and extracted PDF text verify each pricing row and the final total. |
| 5 | Verify real AI, PDF, controlled email, acceptance, and handoff | **Implemented · verified end to end.** A real Gemini generation retained the exact eight selected template sections and used approved pricing. The generated three-page PDF was rendered and inspected. An explicitly enabled live run used the normal reviewed Resend path and Resend's provider-controlled delivered test address; the provider receipt reached `delivered`. The runner accepted the public proposal twice, processed its lifecycle twice, and proved proposal acceptance/signature, CRM `won`, one accepted event, one transcript, one charged durable action, and one assigned onboarding ticket with the persisted support outcome, copied checklist/deliverable, and exact SLA. No customer or person was contacted. |
| 6 | Guided Customer → Template → Scope and pricing → Review → Send flow | **Implemented · verified.** `ProposalEditor` presents the five named steps with step-specific validation and preserves data between them. Desktop and mobile browser tests cover the flow. |
| 7 | Customer preview while editing and matching PDF | **Implemented · verified.** The editor, public route, and PDF use the same full `ProposalDocument` component and commercial model, including branding, sections, package/add-on state, recurring fees, milestones, and signatures. Draft export no longer switches to a compact presentation. |
| 8 | Autosave, recovery, leave protection, and generation status | **Implemented · verified.** Drafts autosave with visible saving/saved/error state, recover locally after interruption, preserve inputs on AI failure, and warn before explicit back navigation, internal link navigation, or browser unload when edits remain unsaved. |
| 9 | Template gallery, categories, favorites, and library tabs | **Implemented · verified.** The gallery separates standard and tenant templates, supports category/search/favorites, provides visual customer previews, and keeps DOCX import as a secondary action. Shared templates can be copied privately without mutating the source. |
| 10 | Rich document editing and accessible section management | **Implemented · verified.** The editor supports Markdown headings, bold text, lists, tables, HTTPS images, reusable sections, previews, and keyboard-accessible move up/down controls with explicit labels. |
| 11 | Operational proposal list and filters | **Implemented · verified.** The table exposes customer, assigned CRM owner, value/currency, expiry, most recent proposal/contact activity, and next action. Its exact work filters are **Needs approval**, **Awaiting response**, and **Expiring soon**, alongside broader status filters; isolated PostgreSQL and desktop/mobile browser tests verify the returned fields and query parameters. |
| 12 | Consistency and accessibility | **Implemented · verified.** Proposal controls use labelled fields and icon actions, visible errors and disabled explanations, consistent minimum 40 px seller/staff controls, 44 px customer response controls, responsive primary actions, and mobile document switching. Desktop and mobile browser suites pass. |
| 13 | Agent refinement of existing proposals | **Implemented · verified.** Mastra tools can inspect tenant-owned proposals, selectively refine text, revise scope/timeline, list active approved services by stable ID, append exact catalog records to the current draft revision, and create a separate reviewable revision. The add operation rejects duplicate, inactive, wrong-currency, stale, and cross-selected-customer changes. PostgreSQL coverage proves newly linked names/prices come from the tenant catalog and that later catalog edits do not rewrite the agreed proposal snapshot. |
| 14 | Missing-requirement questions, sources, and assumptions | **Implemented · verified.** Drafting records missing objectives, deliverables, timeline, responsibilities, and budget; it stores CRM/conversation/knowledge source references separately from explicit assumptions and exposes both for seller review. Campaign-chat responses return the exact missing fields and questions alongside sources and assumptions, and the outreach prompt directs the agent to ask rather than invent answers. The browser suite verifies the Review warning. |
| 15 | Packages, add-ons, recurring fees, milestones, and stable catalog IDs | **Implemented · verified.** These values are modeled in the shared domain, editor, persistence, readiness rules, preview, PDF, revision comparison, and AI prompt. Catalog selection persists `catalogId` and a commercial snapshot. |
| 16 | Team approval rules, reviewers, comments, and status | **Implemented · verified.** Tenant policies can require manager/finance review by discount/value/manual-pricing thresholds, assign active reviewers from active tenant teams, collect decisions/comments, and gate delivery on the current revision and approval fingerprint. Status remains **changes requested** if any assigned reviewer requests changes, even when another reviewer approves. An isolated PostgreSQL suite verifies policy validation, immutable snapshots, all-reviewer approval, simultaneous decisions, inactive-team revocation, comments, tenant isolation, and stale-version invalidation. |
| 17 | Configurable follow-ups and pause rules | **Implemented · verified.** Sellers can edit timing/messages/timezone, preview the exact local schedule without writing reminders, replace a saved schedule, and pause/resume it. Public questions/change requests and replay-safe inbound replies on the proposal's exact outreach conversation pause active follow-ups; the due worker performs a final reply check before sending. The MSG91 callback now persists SMS replies through this same path instead of logging and discarding them. |
| 18 | Revision comparison and superseded links | **Implemented · verified.** Revision lineage is explicit, comparison covers copy, terms, pricing, options, and sections, and a newly sent revision marks the prior document superseded. Revisions preserve the original frozen template snapshot, required-field values, requirements, commercial structure, onboarding plan, and catalog-linked items even if the source template is edited later. Old customer links explain and link to the replacement when available. |
| 19 | Customer questions and change requests | **Implemented · verified.** The public proposal supports questions and requested changes alongside accept/decline. Feedback appears in the seller workspace, can be answered, and can start a revision. Source keys make repeated submissions idempotent. |
| 20 | Actionable acceptance handoff | **Implemented · verified.** Acceptance assigns an owner and creates exactly one support onboarding ticket containing the agreed deliverables, checklist, due date, SLA, and CRM/support outcome state. The PostgreSQL suite verifies replay safety. |
| 21 | Outcome analytics | **Implemented · verified.** Analytics expose a currency-separated sent → viewed → decided funnel, conversion, time to decision, overdue value, decline reasons, template performance, and metric definitions. |
| 22 | Admin template publishing | **Implemented · verified.** Admins get customer preview, required-field validation, version/audit history, rollback, and an explicit ten-slot replacement workflow. Browser and service tests verify publishing and rollback behavior. |
| 23 | Delivery through existing outreach/support channels | **Implemented · verified.** Delivery resolves only a tenant-owned recipient, conversation, and provider account for email, WhatsApp, Facebook, Instagram, SMS, LinkedIn, and X/Twitter. A live email run verified the exact tenant-bound Resend credential, durable action, provider receipt, and transcript against Resend's controlled delivery simulator. A real PostgreSQL suite verifies revision-bound claims, exact frozen targets, one receipt/transcript, reply-window gates, opt-outs, concurrency, refunds, and uncertain outcomes for all seven channels; provider calls are doubles in this suite. Separate provider-contract tests verify MSG91 Flow requests, X v2 direct-message requests, and LinkedIn's header-only `x-linkedin-id` receipt. Social access and refresh tokens are decrypted only for use, refreshed values are re-encrypted, queued sends retain the reviewed account, and inbound callbacks require the documented platform HMAC before any write. SMS replies use a tenant-specific callback, exact phone/account matching, stable provider receipts, privacy-vault storage, CRM reconciliation, and explicit ambiguity rejection. |
| 24 | Mastra campaign chat creates, refines, and sends proposals to selected leads | **Implemented · verified.** Campaign tools require an explicit nonempty selected-lead set, create one idempotent draft per selected lead, and bind inspect, catalog additions, refine, revision, and send actions to that exact selection. A conversation or ticket source can be used only with one selected lead, so one customer's context cannot fan out across several recipients. A real PostgreSQL tool-to-service test creates the selected lead's campaign draft, lists an approved service, appends its exact catalog snapshot, and rejects a duplicate. The send tool prepares a frozen review action; the outreach agent retains it unchanged as durable pending approval, and the campaign restores and opens the same review after reconnect. Proposal approvals reject all client-supplied argument overrides, preserve the selected lead set, revalidate target/content fingerprints and revision, record required team review, and dispatch the exact reviewed action. Rejection invokes no delivery, and pipeline completion remains blocked until a confirmed send. |
| 25 | Support agent proposal actions stay within the current customer conversation | **Implemented · verified.** The proposal subagent and five managed support-agent profiles expose customer-safe status, draft request, and revision-request journeys across email, WhatsApp, Facebook, Instagram, SMS, LinkedIn, and X/Twitter. Tool schemas and runtime ownership checks prevent cross-conversation records, seller approval, public social delivery, or invented links. Support-created revisions preserve the proposal's authoring fields while dropping prior approval and delivery state. A proposal-review inbox exposes pending work to staff. |

## Delivery invariants

- Proposal content, commercial calculations, field materialization, comparison,
  and readiness use shared server/client types and pure rules.
- Customer, catalog, campaign, team member, conversation, and provider-account
  references are checked against the active tenant.
- AI and customer-facing agents cannot approve a proposal, change the reviewed
  recipient, select another customer's record, or create a public link.
- Every delivery is bound to an immutable proposal revision, approval
  fingerprint, normalized target, and idempotency key. The public link is
  persisted before the provider call. An uncertain outcome cannot auto-retry.
- Sent snapshots remain immutable. Revisions have explicit lineage, and old
  links describe their superseded state.

## Verification record

Validated locally on 2026-09-15:

- Migrations `251_proposal_experience.js` through
  `255_enable_support_proposals.js` are recorded in `js_migrations` (batches
  88–92). The isolated delivery migration test also runs migration 252 twice to
  prove idempotence. The existing provider-account prerequisite
  `247_bind_meta_conversations_to_accounts.js` is also recorded locally (batch
  93); it supplies the conversation binding used by proposal delivery.
- Seed state contains exactly 10 published system proposal templates with 10
  distinct template keys, 15 published proposal support templates, and 15
  published managed tenant proposal playbooks.
- Real Gemini generation used `gemini-3.1-flash-lite`, returned all eight
  selected sections, preserved the selected template/title and approved
  pricing, and recorded a successful 1,829-token usage-ledger entry. The QA
  input used a synthetic `.test` recipient and persisted no proposal.
- A read-only Resend provider call validated the configured email credential
  and found two provider domains. The application credential service
  re-encrypted that legacy plaintext row without changing its provider value;
  the strict delivery binding now reports ready with no missing requirements.
  This preflight sent no message.
- `pnpm qa:proposal:live -- --user-id 1 --run-id plan-validation` passed every
  operational preflight check against the local database: user and modules,
  official Resend binding, verified sender, active support team/member, and
  credits. Before/after queries confirmed zero controlled leads, CRM contacts,
  proposals, delivery actions, or onboarding tickets were added in plan mode.
  Independent guard checks rejected execution when the enable flag,
  confirmation phrase, or controlled recipient was missing. The runner binds a
  run ID permanently to one recipient and uses the saved delivery action when
  resumed, so a pending receipt cannot cause a second send.
- The explicitly enabled `provider-live-20260915` run completed through the
  production proposal services using Resend's documented provider-controlled
  delivered test address. Resend reported `delivered` for provider message
  `d5bbd648-3565-42e9-8dd5-fff6305aa4b5`. Proposal 5 is accepted and signed,
  its CRM contact is `won`, and assigned onboarding ticket 12 contains the
  copied checklist/deliverable with SLA `2026-09-22T23:59:59.999`. The runner
  deliberately repeated public acceptance and proposal-scoped event processing.
  An independent database query still found exactly one sent durable action,
  one proposal-delivery credit deduction, one proposal outreach message, one
  accepted event, and one assigned onboarding ticket. Resuming the same run ID
  polled the saved provider receipt and made no duplicate send. Resend documents
  these test addresses as safe delivery simulations that do not reach a real
  person: <https://resend.com/docs/dashboard/emails/send-test-emails>.
- The shared React document renderer produced
  `output/pdf/customer-growth-program.pdf`: A4, 3 pages, 242,648 bytes, SHA-256
  `3ab02202d167d29a662e0a72628c27bac636846d8f4ae6e7fddb22ce1079af42`.
  Every page was rendered to an image and inspected; text extraction confirms
  the proposal number, subtotal, discount, tax, total, milestones, terms, and
  typed signature.
- Combined proposal, campaign-chat, agent-tool contract, support, delivery,
  lifecycle, live-QA policy, provider/credential binding, inbound-CRM,
  reminder, MSG91, and social-provider regression: 24 suites / 308 tests
  passed. Five suites use isolated real
  PostgreSQL schemas. Coverage
  includes all seven delivery channels, the durable outbox state machine,
  no-write timezone previews and schedule replacement, typed acceptance and
  onboarding, proposal-scoped lifecycle processing, exact-conversation reply
  pausing, and duplicate-receipt safety.
  The live-QA policy suite directly proves that only a missing durable action
  may enter preparation: a confirmed sent action resumes receipt polling, while
  sending, uncertain, failed, queued, and incomplete sent actions stop without
  another provider call. It also verifies every execution interlock and output
  redaction rule.
  A separate isolated PostgreSQL suite proves that a new Resend send selects
  the newest verified credential while a resumed delivery resolves its exact
  frozen credential ID and tenant domain. Missing, inactive, and foreign-domain
  bindings fail closed, and readiness results contain no credential value.
  Direct Resend-service tests prove receipt lookup decrypts that exact frozen
  credential, never falls back when it is unavailable, and preserves default
  credential resolution only for unbound admin operations.
  The inbound SMS case exercises six concurrent copies of one callback,
  encrypted raw-content retention, redacted operational content, payload
  collision rejection, one CRM reply, and one proposal pause. New MSG91 Auth
  Keys are encrypted before persistence and never returned by the settings API.
  The provider-contract suites verify the exact MSG91 Flow API request,
  decrypted request header, configured message-variable mapping, preflight
  gating, X v2 direct-message endpoint/body/receipt handling, LinkedIn's
  header-only success receipt, confirmed provider rejection, and uncertain
  network outcomes. Signature tests verify X and LinkedIn HMACs against the
  exact raw callback bytes and challenge-response derivation. Campaign approval
  tests prove the exact frozen send and selected lead set reach the executor,
  reject client argument overrides, and make no delivery call on rejection.
  The agent-tool contract exposes catalog lookup and exact catalog additions;
  tests cover empty selection, duplicate, stale, unavailable, wrong-customer,
  and exact-price behavior, including the real PostgreSQL tool/service boundary.
  Campaign responses expose exact missing-requirement questions, sources, and
  assumptions. The team-approval suite proves active-team ownership, immutable
  review snapshots, comments, changes-requested precedence, serialized
  simultaneous decisions, all-reviewer gating, and stale-version invalidation.
  The outreach-agent handoff preserves the reviewed payload and
  blocks campaign completion until send confirmation. No SMS or social message
  was sent.
- Client component regression: 3 suites / 15 tests passed, including the
  campaign-chat proposal review card, reconnect restoration, and both approval
  decisions.
- Playwright proposal workspace: 8/8 scenarios passed in desktop Chromium and
  8/8 passed in mobile Chromium, including the daily-work table fields, mobile
  overflow check, exact **Needs approval** request filter, and measured 44 px
  minimum customer response controls.
- Server production bundle and the full Next.js production build passed; the
  Next build completed its TypeScript phase and generated every proposal,
  template-admin, public proposal, analytics, and support-review route.
- Proposal-specific client and server ESLint passes completed with zero errors.
  The support fixture tests retain existing `any` warnings. Repository-wide
  server lint still reports 18 errors in unrelated content, ads, booking,
  knowledge, and outreach files in the shared dirty working tree.
- `git diff --check` passed. Repository-wide standalone typecheck still reports
  pre-existing errors in unrelated lead/Twitter/YouTube server tests and the
  unrelated AI-visibility client test; no proposal error appears in those runs.

Automated verification sent no SMS or social message. One explicit guarded run
sent through the normal provider-bound email path to Resend's controlled
delivery simulator; it contacted no customer or person. The same run ID is now
durably complete and can be inspected or resumed without another send.
