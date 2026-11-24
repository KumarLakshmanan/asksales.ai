# Proposal workspace

The proposal dashboard supports guided creation, customer-ready template
materialization, tenant-owned templates, approved catalog pricing, seller and
team review, revisions, customer feedback, provider-bound delivery, lifecycle
automation, and acceptance onboarding.

## Admin template library

Open **Admin → Proposal Templates**. The proposal migrations seed ten published
starters: Digital Marketing, Website Development, SaaS Implementation,
Consulting, SEO Services, Social Media Management, Brand Identity, Customer
Support, Sales Outreach, and Maintenance and Retainer.

Super admins can create, edit, publish, unpublish, replace, preview, validate,
and roll back templates. The limit is ten *published* templates; additional
templates can remain drafts. Publishing is serialized in the database, and
admin changes are recorded in `proposal_template_audit`. Users can browse by
category, favorite templates, or customize a personal copy. Proposal content
includes a template snapshot, so admin edits affect only future proposals.

## Seller workflow

1. Follow **Customer → Template → Scope and pricing → Review → Send**. Known
   template fields are filled automatically; unresolved fields stay visible to
   the seller and never appear as silent customer placeholders.
2. Link a CRM contact, outreach conversation, support ticket, or campaign chat.
   AI retrieval uses tenant-owned sources and the protected/redacted copy of
   outreach messages. Sources and assumptions are shown separately.
3. Add approved catalog services, packages, optional add-ons, recurring fees,
   and milestone payments. A zero price must be explicitly marked
   complimentary. AI cannot substitute an unapproved price.
4. Preview the exact customer document and resolve every readiness item. AI
   suggestions are selective and reviewable; seller-entered recipient, terms,
   pricing, and unselected sections remain intact. Autosave and local recovery
   protect unfinished drafts. The draft export, live editor preview, and public
   customer page share the same full document presentation. Review also calls
   out any unconfirmed objectives, deliverables, timeline, responsibilities, or
   budget before sending.
5. Complete seller review and any assigned manager or finance review. Approval
   is tied to the current revision, document fingerprint, and frozen delivery
   target; later edits invalidate it. Only active members of active tenant teams
   can be assigned. Every assigned reviewer must approve, and any change request
   remains visible with its comment until the proposal is revised and reviewed.
6. Deliver through email, WhatsApp, Facebook, Instagram, SMS, LinkedIn, or
   X/Twitter. The selected tenant-owned provider account and recipient are
   revalidated immediately before dispatch. A durable idempotent outbox records
   the provider receipt and outreach transcript; uncertain outcomes cannot be
   resent automatically. For MSG91 longcode replies, copy the tenant-specific
   JSON callback URL from **Integrations → MSG91** and map `sender`, `message`,
   and the provider's stable inbound message ID to `requestId`. Replies enter
   the same protected outreach/CRM conversation; ambiguous customer numbers are
   rejected instead of guessed.

   MSG91 outbound delivery requires an approved SMS Template/Flow ID and one
   text variable that receives the complete AskSales message. The settings page
   stores the exact case-sensitive variable name. Proposal readiness rejects an
   incomplete binding before approval or credit reservation; the provider
   request uses `flow_id` and a `recipients` entry rather than an unbound
   raw-message payload.

   X and LinkedIn delivery use the exact provider account frozen during review.
   X sends through the v2 direct-message endpoint. LinkedIn delivery requires
   approved partner access to its restricted Messages API and remains an
   editable, seller-initiated action before dispatch. Social callbacks verify
   the platform HMAC over the exact raw request body before writing data, then
   bind the event to the configured receiving account; ambiguous LinkedIn
   account ownership is rejected.
7. Configure customer email follow-ups with editable days, local times,
   messages, and IANA timezone. **Preview schedule** calculates the exact times
   without writing reminders. Saving replaces the prior active schedule.
   Seller pause/resume is available; a public question, change request, or an
   inbound reply on the exact proposal conversation pauses it automatically.
8. Customers can accept, decline, ask a question, or request a change. Feedback
   appears in the seller workspace and can start a separate revision. A sent
   revision supersedes its predecessor while the old link explains where to
   find the replacement.
9. Acceptance updates the linked CRM deal and creates one replay-safe onboarding
   ticket when enabled. The ticket carries its assigned owner, agreed
   deliverables, checklist, due date, and SLA. The workspace shows the CRM and
   support handoff result. Decisions stop pending reminders.

The proposal table is the daily work queue. It shows the customer, assigned CRM
owner, currency-aware value, expiry, latest proposal/contact activity, and next
action. Use **Needs approval**, **Awaiting response**, or **Expiring soon** to
focus the queue without opening each proposal.

## Campaign chat

Select the intended lead or leads in campaign chat before asking the outreach
agent to create a proposal. Proposal actions fail closed when no lead is
explicitly selected. The agent creates one customer-specific draft per selected
lead and returns exact questions for any missing objectives, deliverables,
timeline, responsibilities, or budget. It identifies the CRM, conversation, and
knowledge sources it used and keeps assumptions separate. It can list active
approved services by stable catalog ID and
append them to an exact draft revision. Newly linked services take their name,
unit, and price from the tenant catalog; duplicates, inactive items, currency
mismatches, stale revisions, and cross-customer changes are rejected. Existing
proposal prices remain frozen if the catalog changes later. Inspect,
refinement, revision, and delivery remain limited to the selected leads. A
proposal sourced from an outreach conversation or support ticket requires
exactly one selected lead, preventing one customer's context from being reused
for other recipients.

When the agent prepares delivery, the approval card shows the exact proposal
number and revision, customer, total, channel, provider account, subject,
message, and full proposal link. Approving carries that frozen payload and the
selected lead set to the delivery executor, which re-resolves and compares the
target before dispatch. Client-supplied approval overrides are rejected for
proposal delivery. Cancelling leaves the saved draft and customer link
unchanged and makes no provider call.

## Revisions, analytics and recovery

The detail page has customer feedback, configurable follow-ups, assigned
approvals, onboarding outcome, activity timeline, and saved-version history.
**Create revision** creates a separate draft linked to the previous proposal and
preserves its pricing, frozen template snapshot, field values, requirements,
commercial options, onboarding plan, and catalog-linked items. The comparison
view identifies copy, scope, terms, package, add-on, milestone, and price
changes. Sent proposals remain immutable.

Analytics shows a currency-separated sent → viewed → decided funnel, conversion,
time to decision, overdue value, decline reasons, and template performance.
Campaign attribution uses the latest campaign linked to the selected outreach
conversation; assignee is the CRM contact's current owner.

A delivery with an uncertain provider result is never automatically resent. It appears as **Delivery needs review**. Check the provider history and record evidence before confirming delivered or not delivered. Customer follow-up failures likewise require inspection rather than a blind retry.

## Runtime and rollout

Apply the normal migration sequence, including the existing
`247_bind_meta_conversations_to_accounts.js` provider-account prerequisite and
`251_proposal_experience.js` through `255_enable_support_proposals.js`, from
`server`, then restart the API and worker with the updated code. The existing
`cron-process-reminders` job runs every five minutes and processes durable
proposal events, expiry, onboarding, and follow-ups. Lifecycle failures retain
a visible error and retry with backoff. Configure every delivery provider that
sellers should be able to select.

The local development migration was applied during implementation. Production deployment is separate.

## Verification

- Run focused server coverage with
  `NODE_OPTIONS='--experimental-vm-modules' pnpm exec jest --runInBand` and the
  proposal, support-proposal, delivery, workspace, reminder, and inbound-CRM
  suites. PostgreSQL suites require `PROPOSAL_QA_DATABASE_URL` pointing to a
  local database; each creates and drops an isolated schema.
- Run browser coverage from `client` with
  `pnpm exec playwright test e2e/proposal-workspace.spec.ts`.
- Run `pnpm build` in `server` and `client`. The Next.js build performs the
  application TypeScript pass. Repository-wide standalone typecheck currently
  has unrelated test-file errors documented in `PROPOSAL_IMPROVEMENTS.md`.
- Inspect the controlled live-delivery preflight without writing fixtures or
  contacting Resend:
  `pnpm qa:proposal:live -- --user-id 1 --run-id <stable-qa-run-id>`. The JSON
  result reports only readiness, status, and record IDs; it omits recipient,
  sender, domain, token, and credential values.
- After choosing an exact controlled inbox or Resend's documented
  provider-controlled delivered test address, run the live check from `server`:
  `PROPOSAL_LIVE_QA_ALLOW_EXECUTE=true PROPOSAL_LIVE_QA_EMAIL='<exact-inbox>' pnpm qa:proposal:live -- --user-id 1 --run-id <stable-qa-run-id> --execute --confirm SEND_CONTROLLED_PROPOSAL_QA`.
  The runner uses the normal seller review, team-approval gate, credit charge,
  Resend binding, durable outbox, public acceptance, CRM, and support services.
  Keep the same run ID when a provider receipt or team review is pending: the
  runner resumes that delivery and cannot send it twice. A new run ID means a
  deliberate new email. Receipt polling uses the credential and tenant domain
  frozen on the durable action, so later credential rotation cannot redirect
  the lookup. Exit code 2 means an external result or assigned review is still
  pending; an uncertain provider outcome is never retried.
- See `PROPOSAL_IMPROVEMENTS.md` for the requirement-by-requirement evidence,
  migrations, exact test counts, real AI run, rendered PDF checksum, and email
  provider preflight.

Default and automated checks send no external message. The verification record
includes one explicitly enabled run to Resend's provider-controlled delivery
simulator; Resend reported it delivered, and no customer or person was
contacted. Reusing that run ID resumes verification without another send.
