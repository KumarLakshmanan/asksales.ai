# Governed Support Media Galleries

Support media is a separate evidence lane beside, but never inside, the text
Knowledge Base. Every specialist inherits the same deterministic retrieval and
delivery capability from `ChannelGateway`; persona agents do not query media
tables and the model never receives storage keys or URLs.

## Runtime contract

1. `MediaRetrievalStage` classifies explicit, helpful, or no visual intent.
2. `MediaGateway` applies tenant, profile, audience, purpose, channel,
   publication, effective-date, expiry, and conversation-cooldown filters
   before lexical/tag search.
3. `MediaSelectionStage` verifies every selected evidence ID after agent
   generation and suppresses media on handoff, refusal, and safety outcomes.
4. `DeliveryStage` sends text first. Each verified image then has its own
   checksum/version/order-scoped idempotency record.
5. Provider acknowledgement is stored per image without logging private bytes,
   signed URLs, or storage keys. Uncertain outcomes require reconciliation and
   are not blindly retried.

Media metadata cannot ground availability, rates, payment, booking, account,
CRM, or ticket claims. Those remain confirmed-live-tool facts. Owner-approved
name, description, and alt text are the only customer-facing media metadata;
machine tags are retrieval hints only.

## Ingestion and publication

- JPEG, PNG, and WebP only; 10 MB per image and 50 images per gallery.
- Safe decoding is capped at 40 million pixels and rejects animation.
- Rotation and JPEG re-encoding strip EXIF/GPS/device metadata and neutralize
  non-pixel payloads before external analysis.
- Rights, lawful authority, accuracy, and customer-use certification are
  mandatory.
- Vision/privacy/face/children/secret/moderation checks fail closed. Unsafe or
  sensitive assets are quarantined; scanner outages stay `ready_for_review`
  and are never auto-published.
- Published edits create a new immutable version; the previous version remains
  current until every mandatory replacement check passes.

## Privacy and policy requirements

Tenant-uploaded media is tenant-controlled personal/business data. The tenant
must certify source rights, lawful purpose, accuracy, audience, and retention.
The platform processes it only for the configured support purpose. Private
originals, derivatives, embeddings, access records, and delivery traces are
tenant-scoped and protected with forced PostgreSQL RLS.

Policy and DPA language must cover visual content, metadata stripping, faces and
children, intellectual-property rights, vision/moderation subprocessors,
cross-border processing, no-training terms, bounded provider retention,
correction, erasure, cascading deletion, incident response, and grievance
handling. India-facing legal text remains counsel-gated under the governed legal
publication workflow; engineering documentation is not a substitute for legal
approval.

`SUPPORT_MEDIA_V1_ENABLED=false` disables selection. `SUPPORT_MEDIA_DELIVERY_ENABLED=false`
is the global kill switch for media parts and preserves text delivery.

