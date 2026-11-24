# Tenant and billing integrity

These changes harden v8 at35d6107b50aaabf238a2fc1fa39ff172bdf6b8f7. Apply the new migrations through `node scripts/migrate.mjs up` before using the new billing paths. No live configuration is changed by this patch.

## Migration ordering

-340_live_capacity_plan_retention depends on308 administrator terms and selects live paid adoption while retaining last adopted limits after refund/expiry.
-341_modern_resource_capacity depends on302/304 capacity and311/316 modern resources. It backfills existing live assistants and active Instagram rules, updates reconciliation, and installs transactional triggers. It preserves existing over-capacity data. A migrated assistant shares its legacy configuration identity.
-342_subscription_credential_integrity depends on298 subscriptions, admin credential tables and provider mappings. It serializes credential mutation with the subscription settings row. Provider identities referenced by plans/history cannot be replaced; create a distinct credential and provision its plans. Disable enforcement before permitted secret/config/toggle changes. Labels/priority remain editable. Legacy plaintext credentials may need a reviewed identity-preserving encryption migration rather than rotation through the ordinary form.


Only new draft files were renumbered into the parent-reserved340–349 range. Historical migrations were not renamed. Other owners'330–331 migrations are independent and are not present in this checkout; combined migration validation remains an integration responsibility.

## Provider billing remains open (A03)

This verified change makes programmatic balance lookup fail closed. Broader provider reservations are preserved as a separate uncommitted draft for review. Do not claim complete affordability enforcement from a positive balance check. Provider-specific bounds, OpenRouter alpha Decisions coverage, persisted unknown/over-bound observations and receipt reconciliation, and recovery policy for held budgets remain unresolved. No live provider settings or automatic debt policy are changed by this commit.

## Approval, connections and closure

Operational subscription access checks the selected owner's approval before paid/admin/rollout grants. Staff use the selected owner's approval/setup and their own verified identity for checkout. Queued business work rechecks approval and scheduled operational inventories skip unapproved owners. Chat WebSocket authorization rechecks membership and approval. Recovery routes remain reachable.

Connection secret routes require the owner or billing admin, including WhatsApp manual credentials and Apify tokens. An archived invitation cannot be consumed or set as a preferred profile.

Hard deletion of an account referenced by a billing organization returns409 ACCOUNT_CLOSURE_REVIEW_REQUIRED. This is a mitigation only. A complete closure policy still needs owner decisions on financial retention, anonymization, legal holds, provider mandates, sessions and account recovery. Approval revocation restricts business operations; it is not personal-data erasure.

## Queued originating authority

`captureJobBusiness<T extends JobBusinessPayload>(data: T, options?: JobBusinessCaptureOptions): Promise<T>` preserves explicit business/billing actors and payer. Fresh trusted request capture may derive missing identity from its active business context. Only trusted server snapshots may supply originating fields; client-supplied actor IDs are not proof of origin.

Recovery must pass `{ requireOriginatingIdentity: true }` or independently reject an incomplete immutable snapshot before queue insertion. Its required positive integer fields are `userId`, `businessProfileId`, `businessActorUserId`, `billingOrganizationId`, and `billingActorUserId`. An owner-scoped inventory context cannot replace these persisted actors. Capture revalidates the selected payer under the preserved actors; a revoked origin is rejected instead of silently adopting the inventory owner. Distinct business/billing actors conflict with the application's single signed-in actor authority and return403 `JOB_ACTOR_MISMATCH`.

`runBusinessJob` requires that complete snapshot for all non-global jobs, independently of ambient context. Missing/invalid legacy authority returns409 `JOB_ORIGIN_REQUIRED`; retain failed work for review rather than inferring actor identity from a row owner/default workspace. The existing narrowly defined global system-job branch is separate authority and must never be used to reclassify unidentified historical work.

Instagram's recovery owner must preserve the original run snapshot in replacement payloads and handle incomplete/revoked runs as unsent and reviewable. The shared helper cannot reconstruct an actor that the runtime never persisted, nor detect a caller that deliberately discards origin and presents it as a new request. Its runtime/queue orchestration patches and full combined acceptance remain integration responsibilities.

## Account privacy interface for Data export-core

Exactly `/api/privacy/consents`, `/status`, `/opt-out`, `/opt-in`, and the current `/data-export` are authenticated account controls. Central middleware clears business scope, ignores stale business/billing selectors, skips payer resolution and subscription gating, and preserves `req.user.id` as the actor. These routes currently accept no authority to export another account or arbitrary business.

Data export-core must preserve actor-only account exports when adding its implementation. A business export needs an explicit selected business, a fresh ownership/membership check, allowed export fields, and its own authorized scope. Do not turn the exact account allowlist into a general privacy wildcard or use a body userId as authority. Unknown business-export routes still require a business and remain subscription-gated until an explicit policy/interface is agreed. No Data owner patches were fetched or merged here.

## Shared transport throttling

`claimRequest` atomically checks and consumes independent UTC day/hour/minute buckets and minimum delay using Redis server time. Use it immediately before provider dispatch; `isAllowed` is a preview, and `recordRequest` is accounting for already-performed work. Unknown delivery outcomes retain their attempt count. Redis failure blocks dispatch. Existing JSON counters migrate using their last-request timestamp, and usage inventory filters exact user identity. A provider-attempt budget is not a completed-delivery refund policy.

## Verification limits

Synthetic local PostgreSQL/Redis and mocked providers are mandatory. Browser fixtures verify real client rendering and mocked API contracts, not live billing or browser-to-database mutation. Preserve audit observer logs as historical evidence; regression tests assert corrected behavior. Full-stack production, real sends/charges and live enforcement changes are outside this task.

## Second-pass connection capabilities (N01)

On base24c66b9c, MSG91 settings and Resend domain mutations now declare the existing business-manager capability; their central aliases are also classified. Preserve staff readiness reads and operational send permissions. Mounted guard/controller fixtures and production declarations cover member rejection, owner/billing_admin scope and actor mismatch. Before:9 failed/7 passed; after:36 tests passed across connection and lifecycle suites. No provider was called.

The repository-mandated final `vscode_askQuestions` tool is unavailable in this execution environment; no affirmative answer is fabricated. Technical verification and remaining acceptance gates are reported separately.

## Queue bridge authority (N02)

Once queued media dispatch is attempted, rejection or uncertain acknowledgement is terminal for that attempt. Preserve the originating error/code and never start an inline provider effect. Deliberately configured direct mode remains separate. Regression tests cover authority errors, lost acknowledgement, worker rejection, valid queue/direct modes and real PostgreSQL origin rejection through registry capture. This does not resolve A03 provider affordability.

## Subscription reconciliation fairness (N03)

No-object creation recovery records a pending sync error and attempt timestamp, retaining the original intent and mandate uncertainty. It reuses the existing15-minute retry interval, so a batch of30 unresolved rows cannot monopolize every cron pass. Scheduler metrics distinguish attempted, reconciled, pending and errors. No intent is automatically failed/canceled or recreated; later evidence can recover the original provider object.

## Recharge originating credential (N04)

Apply `344_wallet_recharge_order_origins` after342 before the matching wallet API. Migration343 remains a separate excluded draft. New checkouts capture one live credential, persist an immutable actor/payer/quote/credential reference before returning checkout, and return that captured public key. The table is account-classified with forced RLS and SELECT/INSERT-only runtime grants. It contains no copied credential secret and does not backfill historical orders. Recharge-only history extends342's credential identity/deletion protection without changing its secret-rotation or enforcement policy. The migration refuses rollback to preserve recovery identities.

Verification authorizes the current billing role, checks the exact order's original actor/payer, and uses one originating credential context for HMAC plus both provider reads. A retained inactive or deselected admin credential remains available for its known order. Origin lookup failure, malformed origin, another actor/payer, missing credential or changed public identity fail closed. A successful absent lookup alone enters the existing legacy checks using one captured currently resolved context. The provider's captured/paid order, INR amount, ownership notes, receipt and quote still must match, and the existing payment claim ledger remains responsible for idempotent crediting.

No provider create is automatically retried, no uncertain payment is released or recreated, and no financial recovery policy is inferred. Persistence failure withholds checkout and returns a support-review error. Retained admin IDs cannot recover a secret overwritten under the existing rotation policy. Legacy system-integration credentials have no historical credential ID; a changed/missing original public identity requires review. Historical unbound payments still require the compatible currently resolved credential. These limits require explicit operational review, not scanning all credentials or retaining additional secrets.

Focused verification is split between real controller fixtures, the actual Razorpay/origin services with fake database/provider boundaries, and migrations342+344 with the actual runtime adapter in a disposable PostgreSQL schema. Run `tests/walletRechargeOrigins.test.ts`, `tests/walletRechargeVerification.test.ts`, `tests/razorpay.test.ts` and, with explicit local synthetic database settings and `SUBSCRIPTIONS_LOCAL_QA=1`, `tests/walletRechargeOriginsPostgres.test.ts`. These fixtures do not authorize real charges or production migration execution.

Mounted wallet verification additionally exercises authentication lookup,
business/billing membership, the runtime RLS adapter, actual Razorpay/origin
services and CreditService against a disposable full-schema clone. Session
transport, rate limiting, module availability, top-up eligibility and outbound
provider responses are fixtures. Concurrent callbacks must both return success
and leave one claim, one transaction and one balance increase. Drizzle-wrapped
duplicate-claim errors re-read the existing actor/payer-bound claim instead of
returning an incidental500. Nonfinancial notification ownership remains a
separate observed issue; passing payment tests does not certify notifications.

## Catalog capacity aliases (N05)

New draft saves and draft publication require equal `businessProfiles` and
`workspaces` allowances because both count the same business-profile inserts.
Matching zero and matching unlimited (`null`) remain valid; divergent values
return400 before draft/audit changes or payment gateway construction. Historical
catalog reads remain unchanged; no backfill, grandfathering or reinterpretation
is introduced. Mounted administrator/SQL fixtures cover the real role guard,
transactional persistence and below/at/above capacity boundary. The capacity-only
random-schema fixture deliberately substitutes authorization, so it does not
certify RLS; the separate mounted full-schema fixture uses the runtime adapter.

## Billing help (N07)

Subscription and invoice help use the existing public `/contact` page. Workspace
Support remains the business's own customer-ticket area. Contact help retains
the existing explicitly submitted email-draft form and destination; navigation
does not send email or create a ticket. Billing-help component tests cover
disabled Support and lapsed-subscription recovery.

## Read-only administrator wallets (N08)

The wallet page uses the verified administrator session to expose existing
super-admin credit/plan controls. Other sessions retain wallet/history reads
with explicit read-only copy. Role/account/revalidation changes invalidate open
forms, retained callbacks and old completion effects; an older request cannot
close a new form or show a stale success. This UI gate does not replace server
authorization or undo an already authorized request. No mutation is retried or
reversed automatically. Focused tests preserve successful super-admin actions
and exercise revoked, missing, loading and replaced sessions.
