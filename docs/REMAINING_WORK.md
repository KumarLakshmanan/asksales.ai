# Remaining Application Work

Last updated: 2026-09-23

This is the authoritative execution checklist for the work still required to reach the production-readiness goal. It reflects the current repository state and the focused repairs completed during the active audit. A checked item means the workflow was implemented and passed its focused build/type/lint checks; it does not replace the final end-to-end release verification.

## Working priorities

1. Finish primary user workflows and real client/backend contracts.
2. Remove unsafe or misleading side effects, especially sends, publishing, payments, and destructive actions.
3. Complete client/admin page states, responsive layout, and light/dark mode.
4. Verify queues, workers, WebSockets, and production infrastructure.
5. Run broad release verification only after the functional domains are repaired.

Broad legacy TypeScript cleanup and low-value test cleanup should not displace functional work. Focused type, lint, build, and runtime checks remain required for every changed domain.

## Current verification snapshot

- Client route inventory: **280** page files, including **29** redirect-only compatibility routes and **251/251** layout-owning pages with direct or composed responsive signals.
- Route resilience: **280/280** pages inherit both loading and error boundaries.
- Client/server contracts: **1,077** call sites, **590** unique contracts, and **590/590** statically matched to the current **1,072** registered Express routes.
- Client verification: full lint and type-check pass; **13/13** test files and **203/203** tests pass; the production build generates **232/232** static pages.
- Server verification: full type-check and lint pass with zero lint errors (52 non-blocking legacy warnings); API and worker production bundles pass; the last full run passed **60/60** suites and **1,000/1,000** tests with clean open-handle detection, followed by **12** new passing CSRF/webhook-signature checks.
- Repository-external gates still unavailable here: the testing skill's Playwright launcher is not exposed, Docker is not installed, provider credentials/app approval are environment-owned, and no isolated PostgreSQL release database is configured.

## Completed focused domain passes

- [x] Cross-application inventory and contract architecture
  - Reproducible inventory covers 280 client page files, 29 redirect-only routes, 251 layout-owning responsive surfaces, inherited route boundaries, and literal-palette review signals.
  - Reproducible contract matrix covers 1,077 call sites and matches all 590 unique method/path contracts to registered server declarations.
  - User, admin, and support API clients now share one transport implementation while retaining separate credential storage and unauthorized events.
  - Admin profile, chat drill-down, per-user outreach, ICP loading, email sender, and Resend test-send mismatches were repaired.
- [x] Chat-tab performance marketing and outreach truthfulness
  - Removed hardcoded/timer-based campaign and sequence simulations.
  - Connected both tabs to the persisted, credit-checked campaign builders and explicit ICP prerequisite states.
  - Multi-channel outreach now validates, stores, and enqueues both owned email and SMS sequences with legacy single-sequence compatibility.
- [x] Shared theme and deployment foundation
  - Correct dark sidebar variables, browser color-scheme behavior, reduced-motion handling, responsive integration controls, and touch-accessible actions.
  - Removed obsolete Compose reference to a nonexistent standalone admin image.
  - Browser API traffic remains same-origin while Next server rewrites use the Docker-only `BACKEND_URL`.
  - API and worker images are pinned to the workspace-supported Node 20.19 runtime and retain their non-root image users in production.
  - Admin hostnames route to the admin pages in the unified client instead of the removed port-3001 application.
  - Reversible migration `137` updates only untouched legacy automation endpoint defaults and preserves customized endpoints.
  - Current client/server typechecks and production builds pass; client generates 232/232 static pages.

- [x] Client and admin request-state/responsive follow-up pass
  - Admin home, users, campaigns, leads, wallets, revenue, integrations, outreach monitoring, content/calendar/template registries, and per-user detail pages now preserve visible retryable failures instead of rendering failed requests as zero or empty data.
  - Client home, CRM contacts/pipeline/reminders/alerts, analytics, knowledge-base editing, support AI, integration setup, outreach-agent settings, and social channel composers now distinguish unavailable, partial, empty, and loading states.
  - Integration status requests no longer convert transport failures into false disconnected states; independent status/settings/audit requests retain usable partial results and identify the unavailable section.
  - The home assistant no longer navigates as if a chat thread was created after the create request failed, and ad publishing no longer loses the creative list when only the optional business-profile default URL request fails.
  - Mobile support chat uses a stacked session panel, wide admin tables scroll within bounded containers, detail dialogs use viewport-safe heights, and touched surfaces use semantic foreground/background/border tokens for light and dark themes.
  - Full client lint, type-check, **203** tests, and the **232-page** production build pass after this follow-up; the static contract audit remains **590/590** matched.

- [x] Admin route and credential architecture consolidation
  - Modular admin routing is authoritative for administrator/user management, usage analytics, credentials, Meta configuration, system integrations, and webhook logs.
  - Removed 24 shadow registrations from the legacy monolithic router while retaining intentional compatibility aliases.
  - Detailed Apify, Gemini, ZeroBounce, LLM, embedding, and platform analytics can no longer be intercepted by older summary handlers.
  - Admin integration mutations and credential validation use the credential rate limiter; provider-named routes precede parameterized integration IDs.
  - User password resets require super-admin authorization, validated path/body schemas, the canonical password policy, session invalidation, and reset-token cleanup.
  - Admin integration pages, secret-reveal controls, and billing/usage surfaces received responsive, accessible light/dark-state corrections.

- [x] Chats and conversations
  - User ownership and thread/message scoping.
  - Pagination and soft deletion.
  - Client route and URL handling.
  - Safer client error and navigation behavior.
  - The canonical conversation now loads older cursor pages without losing scroll position; the history list replenishes after deletion and remains touch-accessible and responsive.
  - Admin chat summaries now exclude soft-deleted records, report real message counts/latest snippets, validate nested ownership, and mask secret-bearing message metadata.
  - The campaign dashboard now has a retryable request failure state, reactive light/dark chart styling, responsive charts and lead tables, and semantic surfaces; the responsive chat header no longer injects a fake agent roster.
  - Business-profile, ICP, reconnect message-sync, saved-tab, and linked-business failures are visible to the user instead of being written only to the browser console.
- [x] Integrations recheck
  - Google/Gmail OAuth and token handling.
  - Instagram connection handling.
  - Secret masking and disconnect/readiness behavior.
  - Client integration-required and failure states.
  - Per-user API secrets and secret-bearing JSON configuration now encrypt at the authoritative credential-service boundary; reversible migration `144` upgrades existing plaintext records and production requires an independent encryption key.
  - Meta/Instagram/Facebook/WhatsApp Graph calls no longer put bearer tokens in URLs or ordinary request JSON; OAuth exchanges use bounded form posts and operational calls use authorization headers.
  - Meta Ads disconnect now clears the authoritative ad-account link while preserving the shared Facebook/Instagram page connection, and integration pages retain explicit retry/error states instead of showing false disconnected states.
  - Facebook, Instagram, WhatsApp, LinkedIn, and X webhook pages share one responsive event viewer; event and statistic failures remain distinct, and all user-facing webhook history/stat queries require an exact authenticated tenant instead of including unattributed or other-channel events.
- [x] Ads analytics recheck
  - Canonical metric columns and daily uniqueness migration.
  - User-scoped refresh and currency-aware responses.
  - Responsive analytics presentation.
  - Legacy ad CRUD is tenant-scoped and strictly validated; draft publishing writes the current performance-campaign schema and successful external publishes persist provider identity for analytics ingestion.
  - Meta publish verifies the live ad-account currency and normalizes account IDs before any external write; access tokens stay out of URLs and partially created campaigns are compensated on downstream failures.
  - Reach is labeled truthfully as a sum of daily reach, future-dated metrics are excluded, and mixed-currency/empty/error states are explicit.
- [x] Billing, wallet, credit analytics, and admin revenue recheck
  - Payment replay protection and pending verification recovery.
  - Credit/admin wallet ownership, transactions, search, and pagination.
  - USD-cost-to-INR accounting conversion and current rate visibility.
  - Revenue and credit charts updated for dark mode and responsive layouts.
  - Recharge now verifies server-side gateway readiness before loading checkout, restores pending payment verification safely, and shows the exact admin configuration blocker when Razorpay is unavailable.
  - Pricing/analytics/drill-down pages distinguish request failures from empty data, expose retry actions, and use responsive mobile detail drawers.
- [x] Knowledge base and RAG focused pass
  - Ownership, embeddings, chunk persistence, reprocessing, and deletion.
  - SSRF-hardened crawling.
  - Client polling and actionable errors.
- [x] Admin integration credential security
  - Encrypted credential marker and migration.
  - Masked secret editing.
  - Browser removal of raw provider credentials.
- [x] Social posts focused pass
  - Client/server method and endpoint alignment.
  - Page functionality and theme cleanup.
- [x] Content calendar and social publishing
  - Asset schema and persisted publishing metadata.
  - Multi-platform immediate and scheduled publishing.
  - Post type, tags, privacy, and media preservation through workers.
  - Calendar timezone/date boundaries and lifecycle filtering.
  - Published-item immutability and truthful unpublish behavior.
  - Duplicate content-generation fee disabled.
  - Migrations `112` and `113` added.
- [x] CRM focused pass
  - Non-colliding lead-backed contact references.
  - Contact materialization before writes and tenant-safe ownership.
  - Contacts, detail, activities, conversations, tickets, and pipeline actions.
  - CSV mapping validation, import limits, contact/lead linking, tags, deal values, and statuses.
  - Standalone CRM contacts included in totals and pipeline analytics.
  - True deal currencies and mixed-currency summaries.
  - Internal reminders no longer email contacts without explicit opt-in.
  - Reminder, alert, and automation validation and truthful deletion results.
  - CRM email content escaping and destructive confirmations.
- [x] Outreach core send and scheduling pass
  - Separate validated contracts for single sends and workflow launches.
  - Tenant-owned workflow, ICP, lead, sequence, campaign, history, and progress queries.
  - Canonical campaign/job schema alignment and migrations `114` and `115`.
  - Persisted uploaded leads, normalized contact fields, deduplication, and row limits.
  - Request and worker idempotency around provider side effects.
  - One sent-message and credit event per successful email or SMS.
  - User-provider readiness for Gmail/Resend and MSG91.
  - Idempotent follow-up queueing, fractional-hour scheduling, and campaign completion.
  - Email/SMS composer contract, error-state, duplicate-submit, and focused theme fixes.
  - Social composer retry idempotency, filtered selection, partial-result, and provider-readiness enforcement.
  - WhatsApp approved-template language/parameter mapping and 24-hour reply-window enforcement.
  - Direct and queued-send credit reservation with idempotent definitive-failure refunds; migration `116` added.
  - Immediate and follow-up campaign steps consolidated onto the durable outreach queue.
  - Campaign retry backoff, stale-processing recovery, safe cancellation, terminal/manual-review failures, and tenant-scoped lifecycle actions.
  - Outreach dashboard campaign progress, failure reasons, cancellation, and safe retry controls.
- [x] Authentication focused security pass
  - Validated user, admin, and support login/password-reset contracts with a consistent strong-password policy.
  - User login lockout and authentication rate limits added without throttling authenticated `/me` reads.
  - User, admin, and support JWT types are rejected across the wrong authentication boundaries.
  - Password changes invalidate older sessions; explicit logout revokes the presented token and clears its cookie.
  - User/admin verification codes are cryptographically generated and stored as hashes, with compatibility for existing codes.
  - First-admin bootstrap is transactionally single-use, and admin creation/updates require super-admin authorization.
  - Login and verification responses use HttpOnly cookies instead of exposing session tokens to browser JavaScript.
  - Main dashboard routes consistently enforce onboarding and approval redirects.
  - Admin login, recovery, reset, legacy verification, and not-found pages share one responsive semantic-token shell with a theme toggle.
  - Misleading public admin verification/resend actions removed because administrator accounts are verified during super-admin provisioning.
  - Business-profile and brand-toolkit clients migrated from duplicate root routes to the authoritative settings/content routers.
  - Business-profile edit/save field mapping aligned with persisted server fields; modular create/update/delete/default routes validated.
  - Setup completion now requires the server-side completion marker before showing success; approval status refreshes automatically and manually.
  - Root, dashboard, admin, and support loading/error boundaries confirmed, with shared setup redirect states.
- [x] Leads and enrichment focused pass
  - Lead list, detail, create, edit, delete, search, filters, pagination, selection, and contextual navigation rechecked.
  - Canonical shared lead form and pipeline fields used by responsive create/edit pages.
  - Tenant scoping enforced on CRUD, scoring, validation, verification, enrichment, statistics, conversations, export, and bulk mutations.
  - Manual/admin lead creation no longer incurs a provider-generation charge.
  - Modular lead/enrichment routers made authoritative and duplicate legacy registrations removed.
  - File upload contract aligned with persisted import counts and truthful progress; MIME, size, and row limits retained server-side.
  - Email validation consolidated onto the credential-fallback, usage-ledger, and actual-credit service.
  - Deep enrichment queue submission deduplicated and live progress aligned to canonical tool events.
  - Redis/WebSocket bridging repaired for authenticated cleanup, multi-tab subscriptions, and enrichment cache refresh.
  - Focused client type/lint checks, server/worker bundles, 29 lead tests, and the 228-route client production build pass.
- [x] Campaigns, performance marketing, and campaign administration focused pass
  - Canonical `/api/campaigns` router now owns campaign CRUD, performance generation, Meta publishing, and analytics; duplicate legacy registrations removed.
  - User-scoped campaign reads and mutations, strict request validation, safe archival, and validated AI plan output.
  - Performance campaign generation persists selected platform/currency data and returns one client-aligned contract without request-time DDL.
  - Reversible migration `122` adds performance budget-plan persistence without colliding with concurrent migration numbering.
  - Meta publishing uses an atomic publishing claim, replay protection, partial-external-state recovery, account ownership checks, and truthful failure responses.
  - Meta insights use connected account identity, currency, and timezone; Google remains generation-only and does not claim unsupported external publishing.
  - Campaign analytics are tenant-scoped, use exact campaign lead counts, expose partial refresh failures, and no longer invent revenue, ROI, social reach, hooks, or hashtags.
  - Admin campaign creation requires an explicit tenant owner and canonical fields; admin removal archives records, lists exact lead totals, and exposes current/archive filters.
  - Admin user list/detail responses no longer expose password hashes or verification/reset tokens.
  - Responsive campaign/admin tables, semantic light/dark styling, empty/filter/loading states, currency display, and destructive confirmations rechecked.
  - Focused client type/lint checks, server/worker bundles, full server type-check, 12 campaign tests, and the 228-route client production build pass.

## P0/P1 work to do next

### 1. Outreach approval, sending, and scheduling

- [x] Replace the incorrect shared validation schema:
  - `/api/outreach/send` currently has a bulk `leadIds` schema while its controller expects one `leadId`.
  - `/api/outreach/start` incorrectly uses the send-message schema even though it expects `workflowId`, `useContentStudio`, and follow-up timing.
- [x] Remove duplicate monolithic outreach route registrations from `server/routes.ts`; retain one authoritative modular router.
- [x] Fix duplicate credit charging:
  - Successful sends are currently charged by `SentMessageModel.create` and again by the controller.
  - Failed or queued sent-message records must not consume successful-send credits.
- [x] Add send idempotency around provider side effects and persist/replay the first response.
- [x] Make provider readiness explicit for email and SMS; do not store unsupported single-send channels as indefinitely queued messages.
- [x] Use the submitted email subject instead of a hardcoded generic subject.
- [x] Confirm lead ownership on single-send, bulk-send, workflow campaign, and scheduled retry paths.
- [x] Bound and paginate outreach message history and progress queries.
- [x] Ensure progress counts are user-scoped, including sent-message campaign counts.
- [x] Verify first-step/follow-up scheduling cannot duplicate delivery.
- [x] Verify campaign cancellation, retries, permanent failures, and user-visible failure reasons.
- [ ] Verify credit checks and deductions across email, SMS, WhatsApp, Instagram, Facebook, LinkedIn, and X.
- [ ] Complete atomic outreach credit reservation before every provider side effect:
  - [x] Direct conversation, single email/SMS, and queued bulk messages reserve the exact configured per-message amount.
  - [x] HTTP retries and queue redelivery are protected by request/message idempotency and atomic wallet deductions.
  - [x] Definitive provider failures refund idempotently; uncertain outcomes remain reserved for reconciliation.
  - [x] Concurrent direct and bulk worker sends cannot exceed the wallet balance.
  - [x] Apply the same reservation contract to the campaign/follow-up scheduler.
  - [ ] Audit remaining provider-specific endpoints outside the canonical direct, bulk, and campaign paths.
- [ ] Recheck each channel composer:
  - [x] Integration readiness and direct setup link.
  - [x] Lead contact-field validation before queueing.
  - [x] Template selection and personalization preview, including WhatsApp template parameters.
  - [x] Duplicate-submit lock.
  - [x] Partial-success result for bulk operations.
  - [x] Safe retry that does not resend successful recipients.
  - [x] Mobile layout, loading, empty, and retryable request-failure states for the shared conversation pages and email/SMS/WhatsApp channel views.
  - [ ] Complete keyboard behavior and focused mobile runtime checks for every create composer.
- [x] Remove production `console.error` calls from channel pages after useful UI errors are present.
- [ ] Add safe provider-adapter tests that never send real messages.

### 2. Authentication, onboarding, and authorization completion

- [x] Re-audit registration, login, logout, email verification, password reset, and session expiry.
- [ ] Verify separate user, admin, and support token types on every protected backend route.
- [x] Verify first-admin setup cannot be reused publicly.
- [ ] Confirm admin and support role checks are enforced server-side, not only hidden in navigation.
- [ ] Verify refresh/revocation behavior and production JWT-secret requirements.
- [x] Complete rate limits for login, verification, password reset, and sensitive authentication mutations.
- [x] Verify CSRF behavior for cookie-authenticated unsafe requests.
- [x] Add root/dashboard/admin/support loading and error boundaries.
- [x] Recheck onboarding and brand setup persistence, resume behavior, and redirect loops.

### 3. Leads and enrichment

- [x] Re-audit lead list, detail, create, edit, delete, search, filters, pagination, and bulk selection.
- [x] Verify every lead query and mutation is user-scoped.
- [ ] Verify imported/generated lead deduplication and normalized email/phone/social identifiers.
- [x] Confirm enrichment jobs are idempotent and expose queued/running/completed/failed states.
- [ ] Verify credit deductions use actual successful work and cannot double-charge retries.
- [ ] Verify enrichment provider readiness and exact external blockers.
- [x] Align client request/response contracts for single and bulk enrichment.
- [ ] Recheck file upload MIME, size, row limits, and error downloads.
- [ ] Complete responsive, empty, error, integration-required, and insufficient-credit states.

### 4. Campaigns and performance marketing

- [x] Re-audit campaign create/edit/version/publish/pause/archive flows.
- [x] Verify ownership, validation, optimistic concurrency, and destructive confirmations.
- [x] Verify Meta account, currency, timezone, and campaign-ID scoping; keep Google generation-only until a publish adapter exists.
- [x] Verify external publish/update failures never claim local success.
- [x] Confirm analytics refresh ingestion is duplicate-safe and partial/complete failures are visible.
- [x] Recheck campaign budgets and spend values for units and currencies.
- [x] Complete responsive tables/charts and dark/light chart tokens.
- [x] Remove duplicate legacy campaign routes and business logic.

## Remaining client feature domains

### Content studio, templates, and brand toolkit

- [x] Re-audit email, SMS, DM, ad, blog, image, and video generation end to end.
- [x] Confirm generation only persists when the initiating surface intends it.
- [x] Verify actual AI/media usage charging and remove remaining duplicate fixed fees.
- [x] Validate generated structured JSON and handle malformed model output safely.
- [x] Verify saved-template CRUD, preview, search, pagination, and ownership.
- [x] Recheck media upload/storage cleanup when assets are replaced or deleted.
- [x] Re-audit brand toolkit create/edit/delete, logo/media handling, and generation context.
- [ ] Apply shared loading, empty, error, partial-success, credit, and integration states.

Verified in the current content pass: canonical content routes and strict request contracts; structured model-output validation; intentional `persist` behavior; durable image/video jobs with parent-asset updates; user-scoped assets, templates, threads, and toolkits; single-default toolkit migration; signed media-type validation; post-delete object cleanup; cost-based provider usage charging with the duplicate fixed generation fee disabled; and shared 24-item infinite-query contracts for all saved-template pages, including the image and video galleries, with debounced server search, retries, load-more states, media-failure fallbacks, and destructive confirmations. The server caps legacy array responses at 200 rows and exposes a backward-compatible paginated asset envelope. Generated storage records are linked to their durable content assets, replaced media is reclaimed only after a successful asset update, and shared files are reassigned instead of breaking another asset. Reversible migration `139` backfills older generated-file references. Client lint/type-check and 26 focused content/media tests pass; migration syntax and pending-order discovery are verified.

### Proposals

- [x] Re-audit proposal list, templates, create, edit, preview, send, public view, accept/reject, and analytics.
- [x] Verify public proposal tokens, expiry, replay, and ownership boundaries.
- [x] Ensure sending/acceptance side effects are idempotent.
- [x] Verify reminder behavior and customer notification consent.
- [x] Confirm currency, taxes, totals, dates, and exported document rendering.
- [x] Complete mobile and dark/light layouts for editor, detail, and templates.

Verified in the current proposal pass: strict create/update/template/public-response contracts; transactional proposal and line-item writes; tenant-scoped draft mutation/deletion; explicit template selection and single-default enforcement; bounded, validated DOCX extraction; structured AI output with actual provider usage accounting; credit-reserved, duplicate-safe email delivery with a durable reconciliation state; expiring hashed public tokens; race-safe public view/accept/decline actions; internal owner-only reminders; truthful list/template/error states; responsive semantic-token layouts; and paginated PDF output containing generated document sections, pricing, totals, and terms. Verification passed client/server type-checks, focused lint, server/worker production bundles, all 32 reminder-service tests, and the 228-route client production build. Migration `125` adds token expiry and default-template constraints.

### Support owner UI and support-member portal

- [x] Re-audit ticket create, assignment, reply, status, SLA, tags, and deletion/closure.
- [x] Verify owner/support-member/contact permission boundaries.
- [x] Verify ticket/contact links use persisted CRM contact IDs.
- [x] Recheck attachment storage, MIME/size restrictions, and download authorization.
- [x] Verify notification and WebSocket updates do not duplicate messages.
- [x] Complete knowledge-base public/support pages, search, empty states, and theme.

Verified in the current support pass: strict owner/member/public contracts; tenant-owned CRM contact, lead, conversation, team, and ticket links; role-gated handoff and canned-response administration; reversible soft deletion; truthful status/SLA/tag/assignment behavior; one idempotent reply-delivery service for email, social, and web-widget tickets; durable delivery claims and uncertain-outcome handling; authenticated ticket-scoped attachments with signature, MIME, size, quota, and download checks; atomic expiring single-use review requests; deduplicated persisted/realtime notifications; two-way human widget handoff with authenticated polling and request idempotency; bounded server-side knowledge-base search, pagination, and extracted-text previews; and responsive semantic-token light/dark layouts with a 12px metadata minimum. Migrations `133`–`136` add support invariants, expiring/consumed reviews, widget request idempotency, and review-delivery claims. Verification passed client/server type-checks, focused client/server lint with zero errors, all 46 focused support tests, migration syntax checks, server/worker production bundles, and the 228-route client production build.

### Notifications

- [x] Re-audit list, unread count, mark-read, mark-all-read, filters, pagination, and deletion.
- [x] Verify user ownership and bounded retention.
- [x] Align real-time events with cache invalidation and reconnect behavior.
- [x] Add actionable links and safe fallback when the target record no longer exists.

Verified in the current notification pass: authoritative `/api/notifications` pagination and type/unread filters; truthful unread-count failures; user-scoped read/delete mutations; admin-scoped read/delete mutations; 90-day/1,000-item tenant retention; duplicate system-alert ingestion prevention; authenticated WebSocket updates and reconnect refresh for the header and inbox; deduplicated unread counts; safe `/dashboard` action destinations with module-list fallbacks; responsive semantic-token inbox states; and removal of the duplicate settings notification aliases. Migration `126` adds persisted notification actions and prunes legacy overflow. Verification passed client/server type-checks, focused lint, server/worker production bundles, and all 28 focused controller tests.

### Storage and media library

- [x] Re-audit upload, preview, download, rename, delete, quotas, and pagination.
- [x] Verify object ownership, signed URL lifetime, path traversal protection, and MIME validation.
- [x] Remove orphaned objects after failed or replaced database records.
- [x] Add admin quota/usage visibility if supported by the backend.

Verified in the current storage pass: user-scoped upload/list/preview/download/rename/delete APIs; 25 MB client-upload limits with MIME signature validation; authenticated private-category delivery; bounded previews and remote imports; private-network and redirect rejection; normalized tenant/category object keys; 60–900 second application URL and 60–3,600 second backend signature limits; atomic quota reservation without prematurely exposing replacement capacity; exactly-once quota reclamation on deletion; revision-key replacement without destroying the previous live object; durable failed-object cleanup markers and a ten-minute worker retry; paginated responsive user and admin libraries; explicit destructive confirmations; validated quota/plan administration; explicit ISO storage-plan currency; and single-default-plan enforcement. Migrations `127` and `128` are reversible and were discovered in the correct pending order. Verification passed client/server type-checks, focused client/server lint, 18 safe-fetch/path tests, server/worker production bundles, and the full 228-route client production build. The cloud-provider policy action that cannot be completed from the repository is documented in `docs/PRODUCTION_CONFIGURATION.md`.

### Settings and preferences

- [x] Re-audit profile, AI provider, lead, outreach, preference, and security settings.
- [x] Verify secret values are always masked and never returned to the browser.
- [x] Confirm setting updates are whitelisted, validated, and user-scoped.
- [x] Verify theme, timezone, locale, currency, and notification preferences affect downstream workflows.
- [x] Remove duplicated settings implementations and stale navigation.

Verified in the current settings pass: canonical user-scoped settings routes; strict partial-update contracts for profile, AI, lead source, outreach, follow-up, and account preferences; masked webhook/provider state; strong password changes with old-session invalidation; persisted locale, currency, timezone, date/time, and theme preferences applied through one client context; IANA/DST-safe calendar boundaries; localized proposal/template values; in-app lead/campaign notification suppression; configured-provider-aware model selection; transactional default business profiles; legacy singular-profile migration and compatibility routing; and removal of misleading, unimplemented settings controls. Migrations `129`–`131` harden preferences, business-profile deletion, and canonical profile consolidation. Verification passed client/server type-checks, focused lint, 69 focused server tests, migration syntax checks, server/worker bundles, and the full 228-route client production build. Client compilation no longer depends on downloading Google Fonts, and the supported webpack builder is used for deterministic isolated builds.

### Hotel and booking workflows

- [x] Re-audit availability, quote, booking, payment confirmation, cancellation, and reminders.
- [x] Verify inventory updates and payment confirmation are transactional and idempotent.
- [x] Ensure booking-created CRM contacts do not increment outreach counters.
- [x] Confirm customer-facing reminders are explicit and correctly branded.
- [x] Verify currencies, timezones, date boundaries, and room inventory concurrency.

Verified in the current hotel pass: tenant-owned property and room configuration; IANA timezone and ISO currency authority; bounded exact-date availability in one aggregate query; truthful variable-night totals and per-night or whole-stay negotiated-price floors; transactional advisory-locked inventory holds; deterministic active-booking idempotency; exact-once inventory release on expiry/cancellation; signature-verified Razorpay capture webhooks using the raw request body; encrypted and masked gateway, webhook, and bank credentials; development-only opaque mock-payment links; owner-scoped manual confirmation and cancellation; explicit refund-reconciliation state; idempotently claimed branded confirmation delivery; internal-only check-in/check-out operations reminders at zoned wall times; CRM booking materialization without outreach increments; safe payment-link sharing; upload type/size enforcement; responsive semantic-token hotel administration; and truthful mixed-currency revenue presentation. Migration `132` adds the reversible lifecycle, inventory, payment, notification, reminder, and constraint state needed by these workflows. Verification passed client/server type-checks, focused client/server lint, migration syntax validation, 39 focused hotel/controller tests, server/worker production bundles, and the full 228-route client production build.

## Remaining admin work

- [x] Inventory every admin page against the real backend route and permission.
- [x] Re-audit user/admin/support-member management and role changes.
- [x] Add or repair management UI for subscription plans and active pricing records.
- [x] Verify API/LLM/media pricing unit labels, currencies, effective dates, and audit history.
- [x] Add queue/worker/failed-job visibility with retry/cancel permissions.
- [x] Add webhook health and recent-failure visibility without exposing secrets.
- [x] Verify OAuth/application credential rotation and validation for every integration.
- [x] Re-audit system settings, maintenance mode, feature flags, and tenant module availability.
- [x] Add storage quota/usage management where backend support exists.
- [x] Re-audit audit logs, system logs, filters, pagination, and PII/secret redaction.
- [ ] Complete admin dark mode, responsive tables/forms, loading, empty, error, and confirmation patterns.

Verified in the current pricing-management pass: the product&apos;s authoritative commercial model is wallet credits plus assignable storage plans (there is no recurring-subscription persistence or provider contract to expose); super-admins can manage recharge, platform-event, API margin, storage-plan, and active per-GB storage pricing records. Platform-event edits now participate in the shared atomic save instead of being silently omitted. Read-only pricing loads no longer seed records, all pricing mutations enforce bounded strict fields and unique positive IDs, missing records roll transactions back, storage pricing keys remain immutable, and the new responsive storage-pricing page has loading, retry, empty, edit, active/inactive, currency, and minor-unit states. Provider/customer units are explicit, LLM and media references show their INR basis, and each pricing or storage-plan mutation writes an admin-attributed before/after audit record in the same transaction with an immediate effective timestamp. The paginated pricing-history page exposes those immutable records and field-level differences. Reversible migration `140` creates the audit history. Focused client/server type and lint checks, nine pricing-validation/audit tests, migration syntax/order checks, and the current regenerated 279-page/587-contract audit pass.

Verified in the current platform-access pass: integration readiness remains authoritative in the existing integration registry rather than being duplicated as generic feature flags. Reversible migration `141` adds one global maintenance record, a fixed module catalog, per-user module overrides, and immutable administrator-attributed access audit records. Global maintenance is enforced before modular and legacy API routes while preserving administrator recovery, authentication, public legal documents, OAuth callbacks, and signed provider webhooks. Thirteen customer modules are independently enforceable at the API boundary; a user override can narrow an available module but cannot bypass global maintenance or a globally unavailable module. Super-admins have responsive light/dark control surfaces for global/module state and per-user access, while dashboard navigation and direct routes consume the same authenticated availability contract. Type-checks, focused lint, five access-control tests, migration syntax, and the regenerated 279-page/587-contract audit pass.

Verified in the current integration-credential pass: the authoritative `admin_api_credentials` store now handles both current and legacy system-credential creation; API keys and API secrets remain AES-GCM encrypted, while secret-bearing nested configuration such as webhook tokens, private keys, access/refresh tokens, and service-account payloads is recursively encrypted at rest and masked in every admin response. The Meta “full” endpoint no longer reveals secrets, edit forms use blank-to-preserve rotation semantics, and masked values can no longer overwrite live credentials. Strict bounded create/update contracts enforce immutable provider identity and provider-specific requirements. Saved-credential validation covers all fifteen supported provider types; Gmail OAuth is truthfully marked as requiring completion of the external consent callback, while Meta validates against Graph without putting its app token in a URL. Rotations clear stale validation state, persist actor/time metadata, and create secret-free audit events alongside validation, activation, deactivation, creation, and deletion history. The integration overview exposes recent activity and invalid status. Reversible migration `142` adds validation/rotation metadata and the audit table. Client/server type-checks, focused lint, seven credential secret/validation tests within the 47-test focused pass, migration syntax/order, and the regenerated 279-page/588-contract audit pass.

Verified in the current audit/log pass: the super-admin audit surface unifies immutable pricing, platform-access, and integration-credential events with domain/search filters, bounded server pagination, actor attribution, redacted details, responsive cards, and explicit loading/empty/error states. System-log filters now strictly validate levels, dates, ranges, pagination, and query lengths; source matching is partial and message/source search is supported. Pino headers and common credential/PII fields are censored before file/console output, while database logs receive recursive write-time redaction and read-time legacy-row redaction for tokens, provider keys, sensitive query values, emails, nested context, and local usernames in stack paths. Context size/depth is bounded and retention defaults to 30 days with a validated 7–365 day configuration window and hourly cleanup. Only super-admins see destructive clearing controls, and the action itself records actor/count context. The responsive viewer now has a durable retry state, busy refresh, horizontal table containment, and retention visibility. Three focused redaction tests, client/server type-checks, focused lint, and the regenerated 280-page/589-contract audit pass.

## Queues and real-time work

### Queues and workers

- [x] Inventory every queue producer, worker, retry policy, and terminal failure path.
- [x] Verify side-effecting jobs are idempotent across retries and multiple worker instances.
- [x] Add correlation/user/entity identifiers to job records and events.
- [x] Ensure failed jobs are inspectable by authorized admins.
- [x] Verify user-visible progress and actionable permanent-failure messages.
- [x] Confirm worker locks have safe TTL/renewal/release behavior.
- [x] Verify graceful shutdown and no abandoned in-progress jobs.

Verified in the current queue/worker pass: only registered durable tool processors can dispatch; obsolete or unknown jobs fail explicitly; image/video completion uses BullMQ completion semantics; legacy orphan queues drain to explicit terminal failures; queue failure records are redacted and correlated; super-admin queue inspection, pagination, retry, and safe removal are permission-checked; follow-up and publishing locks renew and release atomically; queue initialization recovers after startup failure; worker lock/stall settings are explicit; notification SLA claims are atomic and persisted; and API/worker shutdown closes workers, consumers, queues, event infrastructure, observability, Redis, and health servers. Seventeen focused queue/realtime tests, server type-check, focused lint, and both production bundles passed.

### WebSockets and events

- [x] Consolidate one authoritative client reconnect strategy.
- [x] Verify authentication, subscription ownership, cleanup, and stale subscription removal.
- [ ] Centralize and type event names and payloads.
- [x] Verify events trigger the correct React Query/cache refresh without duplicate UI updates.
- [ ] Test reconnect, token expiry, offline queues, and multi-tab behavior.

Verified in the current real-time pass: one generation-guarded reconnect strategy with capped jitter; per-user durable offline chat sends; user-switch and logout cancellation; thread ownership validation and resubscription; origin, payload, command, rate, and in-flight validation; user-scoped idempotency with failed-claim release; EventBus-to-client event-name translation; stable event IDs and client deduplication across direct/Redis delivery; safe disconnect cleanup; and graceful WebSocket shutdown. Twenty-nine focused client WebSocket/context tests and four focused gateway tests passed. Central event-name typing plus explicit token-expiry and multi-tab runtime coverage remain open.

## Cross-cutting client redesign checklist

- [x] Generate the final complete inventory of all client, admin, support, and public pages.
- [ ] Check every visible button, menu, tab, form, modal, filter, and destructive action.
- [ ] Replace remaining hardcoded colors with semantic theme tokens.
- [ ] Verify light and dark contrast across every page, modal, chart, table, and empty state.
- [ ] Normalize page padding, section spacing, typography scale, card density, and control heights.
- [ ] Replace page-specific headers/containers with shared `PageShell`/`PageHeader` patterns where appropriate.
- [ ] Standardize loading, skeleton, empty, filtered-empty, error, permission, integration, credit, and partial-success states.
- [ ] Repair mobile navigation, table overflow, dialogs, drawers, and touch target sizes.
- [ ] Verify keyboard focus order, visible focus, labels, icon-button names, dialogs, and form errors.
- [ ] Remove production console logging, raw JSON, generic errors, fake success, placeholder actions, and stale “coming soon” text.
- [x] Add route-level loading and error boundaries for user, admin, support, and public surfaces.

## Architecture and security follow-up

- [x] Finish consolidation of user/admin/support HTTP transports while preserving separate auth boundaries.
- [x] Complete the frontend-call-to-backend-route contract inventory.
- [ ] Remove remaining duplicate monolithic/modular route registrations.
- [ ] Add Zod validation for every unvalidated mutation and important query/path parameter.
- [ ] Finish ownership/tenant filters on all reads, writes, exports, uploads, and background jobs.
- [ ] Verify external webhooks use signature verification and replay protection.
- [ ] Verify OAuth state signing, redirect allow-lists, token encryption, and rotation.
- [ ] Verify Redis-backed distributed rate limits for authentication and expensive/side-effecting operations.
- [ ] Review HTML/email/template sanitization and log redaction across remaining domains.
- [x] Verify production health endpoints expose no sensitive dependency details publicly.

## Database and migrations

- [ ] Apply and validate pending migrations on an isolated PostgreSQL database, including `109` through `117`.
- [ ] Verify migration concurrency protection and repeat execution behavior.
- [ ] Verify rollback behavior where a down migration is supported.
- [ ] Check existing production data for duplicate CRM user/lead links before adding any future uniqueness constraint.
- [ ] Add constraints/indexes only after safe data reconciliation.
- [ ] Confirm all new JSON metadata columns and pricing changes are included in deployment startup/migration execution.

## Final verification and release gates

- [ ] Update `CURRENT_STATE_AUDIT.md` with the final state.
- [ ] Update `FEATURE_COVERAGE_MATRIX.md` with domain evidence.
- [x] Update `API_CONTRACT_MATRIX.md` with every active client call.
- [ ] Update `VERIFICATION_MATRIX.md`; remove stale baseline failures that now pass.
- [ ] Update `IMPLEMENTATION_PLAN.md` from the executed state.
- [ ] Create `PRODUCTION_READINESS_REPORT.md` only after release gates complete.
- [x] Run final client lint, typecheck, tests, and production build without error suppression.
- [x] Run actionable server lint, typecheck, tests, and production bundle checks.
- [x] Run Python checks configured in the repository.
- [ ] Validate all migrations against an isolated database.
- [ ] Add and run safe end-to-end coverage for authentication, onboarding, chats, CRM, content generation, publishing, outreach, billing, notifications, and admin authorization.
- [ ] Test light/dark mode, keyboard use, contrast, mobile navigation, and responsive layouts.
- [ ] Validate Docker Compose, Dockerfiles, Nginx, health checks, workers, volumes, Redis, and graceful shutdown.
- [ ] Verify production domains, OAuth callbacks, webhook URLs, cookies, CORS, WebSocket URLs, and uploads.
- [ ] Record exact external blockers such as provider credentials, app review, account approval, or production DNS.

## Definition of done for each remaining item

An item can be checked only when all applicable parts are complete:

- The page or workflow is reachable and authorized.
- The client action matches a registered backend route, method, payload, and response.
- Inputs, query parameters, and path parameters are validated.
- User/tenant ownership and role permissions are enforced server-side.
- Persistence and external side effects are truthful, transactional where needed, and idempotent where retried.
- Loading, empty, error, success, permission, integration, credit, partial-success, and destructive states are represented.
- Light mode, dark mode, mobile layout, keyboard use, and accessible labels are checked.
- Focused lint/type/build checks pass, plus a safe runtime or automated workflow check where possible.
- The relevant coverage and verification matrices contain evidence.
