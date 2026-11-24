# Support audit release — 19 September 2026

Scope: support agents, playbooks, privacy, knowledge, media, and channel-preview UX.

## Implemented

- Atomic KB deletion/withdrawal retires published retrieval evidence and both embedding stores. Publication snapshots protect live audience/profile/channel/staff scope from draft edits. Canonical citations, relevant empty-result diagnostics, deterministic quote recovery, explicit degraded-publication consent, live/draft comparison, retrieval testing and rebuild controls.
- Executable default hotel-availability and ticket-status journeys, mandatory runtime tool dispatch, customer-bound ticket lookups, boundary/date validation, encrypted tenant-isolated two-hour preview state, event-bound transitions and read-only simulation. Ticket previews use explicitly labeled fixtures; no customer records are queried.
- Server-validated attachment extraction enters a separate untrusted reference lane, limited to low-risk internal assistance. Follow-up turns reload authorized uploads. Claimed uploads expire after 30 days; expired files must be uploaded again. Assistant media previews and response provenance are returned.
- Stable conversation-scoped PII tokens, additional form/identifier/phone detection, idempotent redaction, stored-version decryption, auditable service-level reveal. Owner and claimed-member reveals require reasons and are cleared after at most five minutes. Ordinary ticket timelines never automatically return raw PII. Verified public catalog contacts can survive knowledge and reply privacy boundaries; uploads cannot grant that exemption.
- Media review/approval/rejection, OpenRouter image-safety fallback, per-file partial upload reporting/deduplication/cleanup, draft/live metadata isolation, text-only degradation on verification outage, evidence-based uncertain-send reconciliation and explicit authorized retry. Unknown sends are never blindly resent.
- Conversation request isolation, channel/mode restoration, title preservation, search/pagination/archive/restore/undo, exact intent selector, authoritative playbook validation, unsaved-change warnings, edge-based member journeys, readable themed responsive UI and accessible controls.
- Strict safe email HTML, accurate published-KB/provider readiness, per-platform auto-reply controls, provenance, extraction diagnostics and privacy-access history.

## Automated validation

- Final integrated backend: 75 suites passed, 979 tests passed, 64 skipped (three suites are separately opt-in). This rerun includes the final official-booking-link fix.
- Final focused client: 11 suites passed, 48 tests passed; additional member-reveal tests passed in delegated checks.
- Local isolated PostgreSQL covers KB withdrawal/scope, media publication/access, preview encryption/expiry/turn binding, uploads, support settings and CRM persistence.
- Client production build, API bundle and worker bundle passed. Client typecheck and scoped lint passed. Full server typecheck retains unrelated pre-existing errors; changed runtime errors were corrected.
- Independent review led to fixes for customer ticket ownership, preview transition concurrency/terminal commits, PII token stability, scoped knowledge access and explicit reveal.

## Deployment requirements and operational limits

1. Apply migrations `280_support_preview_sessions.js` and `281_support_media_review_workflows.js` using the normal backed-up deployment workflow.
2. Publish code templates `hotel-availability-booking-v1` and `technical-ticket-status-v1` with `publish-code-support-template` after dry-run review. Existing customized and archived tenant journeys remain unchanged. Active runs remain version-pinned; preflight found zero active runs on these two templates.
3. Existing KB versions that already contain redaction tokens cannot recover original contacts by code alone. Use **Rebuild index → review → publish** where retained original source permits. Never automatically republish customer-visible knowledge.
4. Historical media snapshots initialize from metadata present at migration time; earlier unrecorded metadata cannot be reconstructed. Member property access requires a verified ticket/conversation business-profile association.
5. Existing mixed sales/operations documents still need an owner content-scope review. Adding audience controls does not silently reclassify or republish historical customer-visible documents.

## Rollout and live verification

- Core audit release: `cef3d8447`, followed by rollout/label/history corrections (`092663869`, `d5c4fd6a9`, `54e20b2fd`) and booking-link fix `00ca5b401`. Migrations 280 and 281 are applied; all 265 migrations are applied, with zero pending.
- Database backup verified at `/var/backups/asksales/predeploy-20260918T203405Z.dump`; previous runtime images retained as rollback tags.
- Fixed deployment stdin handling in `092663869`: command-only SSH and migration Compose runs no longer consume a resumed script/remote heredoc. The first resumed attempt left migrations pending; direct verification caught this and the corrected migration phase completed successfully before QA.
- Published hotel availability and technical ticket-status templates as v3 after dry runs. Three hotel and four ticket managed copies updated. One archived hotel copy remains archived at v2. No active version-bound runs existed during publication.
- Live Owner Support AI tests in the ORO workspace passed for Web, WhatsApp, Instagram, Facebook and Email formatting. Responses cited four or five published sources; the provenance panel showed sufficient knowledge and grounded verification. Email rendered safe HTML rather than visible HTML markup.
- Multi-turn Instagram customer preview retained its journey and trip details; its availability step executed `check_room_availability (success)` and displayed tool/playbook/node provenance. The existing tenant hospitality journey continues into its configured contact collection after room selection; no customer message or booking was created.
- Desktop history titles measured 14px/500 weight with ellipsis. No document horizontal overflow at the effective 1920px desktop and 520px narrow viewport; the temporary viewport override was reset.
- The published-knowledge retrieval tester returned customer-scoped evidence. Live KB cards show publication/version/index status; final wording separates extraction completion from availability to agents.
- Media galleries loaded published previews and safety/review controls. Historical failed/uncertain sends now expose retry/reconciliation controls. They were not resent during QA.
- A live support media request returned five Premium Club Room images. All five image elements completed loading with nonzero natural width.
- A synthetic text attachment was uploaded in live Owner Support AI. Its unique label was answered correctly, and a later turn recovered its three checklist steps without re-upload. No real customer data was used.
- Live conversation search filtered to the QA sessions. Reopening Email restored its saved channel. A QA-only conversation was archived with confirmation, then successfully restored using Undo; no user conversations were removed.
- Oro Circle Instagram is active, webhook-subscribed and has an unexpired token. Eighteen provider-confirmed sends in the prior 48 hours predate this release. No new provider-delivered Instagram test was performed; channel previews are not delivery proof.
- Additional history-filter regression coverage: 17 tests passed across isolation, formatting and retry suites, including owner/member delayed-reply search tests. Follow-up effect-based synchronization passed its nine-test isolation suite and scoped lint.
- Unrelated concurrent workspace theme changes are intentionally excluded from these commits and production images.
- Final booking-link regression found during QA: an explicit official search-link request was being replaced by local room selection when inventory existed. `00ca5b401` uses the existing validated search-handoff path for that request, without bypassing checkout confirmation or putting guest identity in URLs. It also accepts canonical `promoCode=` / `currency=` input. The focused booking suites passed 66 tests; two opt-in tests were skipped. A stale Facebook confirmation test was updated to assert the existing conversation-bound send argument.
- Final deployment of `00ca5b401` completed successfully. API, client and Hermes returned HTTP 200, both workers are running, Nginx validation/reload passed, and no migrations remain pending. A second verified backup is `/var/backups/asksales/predeploy-20260918T212426Z.dump`.
- Post-deployment live retest produced the exact approved Oro search link containing propertyId=10955, 2026-10-05/2026-10-07, overnight, adults=2, children=0, rooms=1, promoCode=QA26 and currency=INR, without guest PII or creating a reservation. Changing the history search while that new reply was in flight retained the current filter and returned only the matching conversation.

### External booking-engine limitations observed, not changed

Opening the generated link on the live Simplotel engine populated the dates. A second read-only check with the user-supplied `promo` alias and nondefault guests/rooms populated three adults and one child in **each** of two rooms. Both `promoCode=QA26` and `promo=QA26` left the promo input blank. Therefore URL inclusion alone is not proof that this installation supports promo prefilling, and `adults`/`children` must not be interpreted as a total spread across multiple rooms. Per-room allocation/child-age and valid-promo behavior need confirmation with the booking-engine configuration/provider. No availability submission, reservation or payment was made on that site.
