# Unified Outreach Inbox

Route: `/dashboard/outreach/inbox`.

## Behavior

- The first Outreach navigation item opens the Inbox. The Outreach overview,
  follow-up workspace, and channel pages keep their existing routes.
- Email (including Gmail), WhatsApp, Instagram, Messenger, SMS, LinkedIn and X
  share a searchable, paginated list. Each native conversation stays separate.
- Unread filters count threads; row badges count unread inbound messages.
  Counts use message read state, including when a cached conversation counter
  is stale. The selected thread remains visible in the Unread filter until left.
- Contacts, companies, addresses, subjects, and redacted message text are
  searched on the server, including records outside the current page.
- Confirmed historical sends without a unique exact provider-ID match appear
  as individual read-only records. Names, approximate timestamps and body text
  are never used to infer a thread or sending account.
- Replies show the original recipient and account. The server checks both
  again before creating a send intent. Opt-outs, unavailable accounts, unknown
  recipients and provider readiness failures block replying while retaining
  readable history. WhatsApp requires an approved template when applicable.
- Existing message, draft and attachment services handle sending. A failed or
  in-progress send retains its draft and idempotency key. Switching threads
  retains each local draft independently.
- Incoming events refresh the list and selected thread. A 30-second poll runs
  while the page is visible. Older messages use a message boundary, avoiding
  offset shifts when new messages arrive. If a burst replaces the first Inbox
  page completely, pagination restarts from that page so new items remain reachable.
- The signed-in business owner sees names and email addresses from retained
  original inbound emails in message history and list previews. Reads bind the
  vault to the exact owner, business profile, conversation and message and are
  audited. Other sensitive values remain masked. Responses use `no-store`.
  Members and reads without a retained original keep the protected copy.
  Storage, AI prompts, search and analytics continue to use redacted history.
  Ordinary interest phrases such as "I'm interested in a conversation" are
  preserved rather than being classified as names.

## Data and API

Migration `297_unified_outreach_inbox.js` adds the receipt link and redacted
search projections. Insert/update triggers handle both receipt-first and
message-first writes, changed IDs, and ambiguous matches. The projection is
invalidated on content edits and rebuilt with compare-and-set updates.

- `GET /api/outreach-conversations/inbox`: `channel`, `unread`, `search`,
  `cursor`, `limit` (1–100). Ordering uses activity time, kind and ID; the
  opaque cursor and returned activity times retain PostgreSQL timestamp precision.
- `GET /api/outreach-conversations/inbox/:kind/:id`: scoped item details and,
  for historical sends, a single redacted read-only message.
- Existing thread history also accepts `beforeMessageId` for stable older
  pages. Existing offset clients remain compatible.

Normal API requests retain user and business-profile scoping. Reconciliation
enumerates owners under system scope, then re-enters each persisted business
profile. Its pre-profile compatibility branch is for databases predating the
business-profile migration.

## Reconciliation and monitoring

Run after applying the migration, with the target environment's database
configuration:

```sh
pnpm --dir server outreach:inbox:reconcile
pnpm --dir server outreach:inbox:reconcile --apply
pnpm --dir server outreach:inbox:reconcile --user-id 123
```

The default report does not mutate data. `--apply` reconciles exact links and
prepares the search projection. Reports include expected/actual Inbox items,
duplicate items, historical sends, remaining linkable receipts, unindexed
receipts, and maximum observed page query time. A coverage mismatch exits
nonzero.

Operational signals:

- `[OutreachInbox] Loaded inbox`: query duration, result count and historical
  items on that page.
- `[OutreachInbox] List failed` / `Detail failed`: read failures.
- `[OutreachInbox] Reply sent` / `Reply failed or needs review`: delivery
  outcomes, channel and message ID, without logging message text.
- Reconciliation reports: total unmatched history and uncovered exact links.

Investigate increases in query time, linkable receipts, duplicate items or
send failures. Unmatched old history can be expected; keep it read-only until
an exact provider receipt establishes the link.

## Staging verification — 2026-09-26

Applied migration 297 to `salesmarketing_dev` in the isolated
`salesmarketing-dev` Compose project (migration batch 112). Reconciliation
used the current service through a temporary compatibility harness because
staging was at migration 296 and did not yet have the newer business-profile
runtime role. No provider sends were executed by the reconciliation command.

| Owner | Conversations | Linked receipts | Read-only history | Expected / actual Inbox items |
|---|---:|---:|---:|---:|
| 1 | 30 | 230 | 38 | 68 / 68 |
| 3 | 18 | 26 | 0 | 18 / 18 |
| 9 | 601 | 200 | 1 | 602 / 602 |
| 18 | 1 | 0 | 0 | 1 / 1 |
| 22 | 1 | 1 | 0 | 1 / 1 |
| **Total** | **651** | **457** | **39** | **690 / 690** |

Both apply and subsequent read-only verification found zero duplicate items,
zero remaining linkable receipts and zero unindexed receipts. The subsequent
verification observed page query times up to 643 ms with 100 items per page.
One existing `persist_test` conversation is outside the seven Outreach channels.

## Verification commands

```sh
OUTREACH_QA_DATABASE_URL=postgresql://localhost/postgres pnpm --dir server test --runInBand tests/outreachInboxPostgres.test.ts tests/outreachConversations.test.ts tests/outreachMessageDeliveryOrder.test.ts tests/outreachProviderGateContract.test.ts
pnpm --dir client test src/__tests__/outreachComposerReply.test.tsx src/__tests__/outreachMessageTimeline.test.tsx src/__tests__/outreachMediaAttachments.test.tsx
pnpm --dir client exec playwright test e2e/outreach-inbox.spec.ts
```

The PostgreSQL suite creates and removes an isolated schema and temporary
database role. Browser tests mock external APIs and never contact real
recipients. Browser checks cover desktop and mobile, history, channel controls,
read state, failed and duplicate sends, live updates, drafts and attachments.

## Acceptance evidence — 2026-09-26

| Requirement | Verification |
|---|---|
| All seven channels, Email/Gmail normalization, campaign sends, follow-ups and inbound replies | PostgreSQL fixtures query the real service and apply the real migration. Receipts are excluded only after a unique exact match. |
| Historical coverage and safe linking | Both insertion orders, changed IDs, ambiguous and empty IDs, repeat migration, legacy detail and read-only availability are checked. Staging coverage is recorded above. |
| Full-history search and stable pagination | Tests find records outside page one, reject raw private text searches, retain microsecond timestamp precision and page older messages while replies arrive. Browser checks also cover a burst that replaces the first page. |
| Tenant and business-profile isolation | Real PostgreSQL row policies verify list, detail, counts, search and cross-profile receipt links. Foreign-user detail requests return no record. |
| Unread accuracy | Database checks distinguish thread counts from message counts and normalize Gmail. Browser checks mark opened threads read and retain the active selection in Unread until leaving. |
| Replies through the original account | Controller tests exercise all seven provider adapters with the reviewed account and recipient. Changed destinations, opt-outs, disconnected accounts, incomplete SMS configuration and WhatsApp template requirements are covered. |
| Failed and duplicate sends | Browser checks retain drafts and reuse the request key. Controller checks prevent a second send intent and provider dispatch for pending or completed duplicate requests. |
| Desktop and mobile workflow | Browser checks cover all channel filters, historical details, search, navigation, templates, AI drafts, attachments, error recovery and drafts retained per conversation. Screenshots were visually inspected. |
| Refresh and delivery states | Incoming events and visible-page polling update history; hidden pages do not poll. Delivery ordering tests prevent a late callback from regressing an already read message. |
| Navigation and existing pages | Inbox is the first Outreach item and its collapsed destination. Existing overview, follow-up and channel routes remain present. |
| Monitoring | Structured list latency, reply outcome and read-error logs, plus the reconciliation command's unmatched-history and coverage report. |

Completed checks:

- 92 backend tests passed across four suites, including the real PostgreSQL integration.
- 23 composer, timeline and attachment tests passed across three client suites.
- 20 browser tests passed: ten scenarios each on desktop and mobile Chromium.
- Full server TypeScript, scoped client TypeScript and Inbox/shared composer ESLint checks passed.
- The server production bundle compiled successfully with the project's esbuild options.

Browser verification used an isolated copy whose Inbox files, shared components,
navigation and layout matched the working tree. Its server used the workspace's
Node 22.23.2 executable; an earlier Node 20 development run had a startup script
error. The Node 22 cold-start check and full browser run both passed. The repository
declares Node 24 for its normal deployment runtime.

Provider adapters and browser APIs were mocked for send verification. No messages
were sent to real recipients. Reconciliation used the actual staging database.
Local verification logs and desktop/mobile previews are saved in `.local/inbox-qa/`.

## Gmail notification queue and cooldown recovery

Apply migration `326_gmail_mailbox_sync` before starting the updated API and workers.
Authenticated Pub/Sub notifications are coalesced into the highest pending history
ID on the exact active Gmail credential. The API acknowledges after this PostgreSQL
write; it does not fetch mail or wait for Redis. A best-effort BullMQ wake-up starts
the sync, and a once-per-minute recovery sweep picks up saved work after enqueue
failure, worker interruption, or cooldown expiry.

Workers lease one mailbox at a time and advance `session_data.lastHistoryId` only
after all fetched messages and attachments have been durably processed. Newer
notifications arriving during a sync remain pending. Failed work retains its
cursor and uses bounded exponential backoff. A Gmail 429 or documented rate-limit
403 persists `gmail_cooldown_until` on the credential; inbox reads and outbound
sends share it across API and worker processes. SDK retries are disabled so they
cannot bypass this cooldown. Google controls the retry time; unrelated mailboxes
continue normally. No notification is acknowledged solely on an in-memory timer.


## Campaign manual follow-ups

Open `/dashboard/outreach/create`, select **Use a campaign manual sequence**, and choose **Manual follow-up campaign**. Create a named campaign workspace here if needed. Add up to three approved-template steps with increasing delays measured from the initial successful send, then **Save campaign sequence**. The saved sequence belongs to that exact business/campaign/channel. Later batches select the same campaign and load its saved revision. **Copy global defaults as preset** is an explicit starting copy; it never creates a live dependency on shared channel settings. Draft configuration does not need a live assistant/provider.

Batch review displays the recipient's rendered manual sequence and template revisions. The send API accepts `campaignManualReviewId`, obtained from `/api/outreach/manual-follow-ups/preview`; every origin and delayed step retain that immutable campaign/revision/content record. Campaign workspaces are `chat_thread` identities; sequence-based outreach campaigns are `outreach_campaign` identities. A contact in two campaigns keeps independent origin records and email threads. Existing messaging channels retain their provider conversation identity and stop on reply/takeover/opt-out.

Saving a new sequence affects new enrollments. To change pending work, use **Preview revision for unsent enrollments**, review its exact recipients/copy/timing, confirm, and **Apply reviewed revision**. Sent, claimed, stopped, held and uncertain work cannot be re-enabled this way. Queue retries retain stable message identities; superseded review jobs cannot claim revised work.

An edited/unapproved library template or changed business brand holds the pinned work for review; the system never swaps in latest content. Legacy manual work without an exact campaign review is held. AI-generated follow-ups retain their configured generation path. All sending still requires the original account's current assistant receipt, recipient eligibility, suppression, provider permission/window, quota and final delivery checks. WhatsApp outside its reply window continues to require an approved account template; saving a business template does not grant provider permission.
