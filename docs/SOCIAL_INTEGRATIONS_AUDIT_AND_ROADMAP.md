# Social integrations audit and roadmap

Last reviewed: 2026-08-13

## Executive view

The publishing core is now materially safer: Instagram, Facebook, and YouTube use credential-bound durable publish attempts; retries distinguish known failures from ambiguous provider outcomes; reviewed publish payloads are snapshotted; scheduled assets can be rescheduled without mutating claimed work; and provider IDs remain available for reconciliation or remote deletion.

The product is competitive as an AI-assisted publisher and scheduler, but it is not yet feature-complete against Buffer, Hootsuite, Later, Planable, or Sprout Social. The largest remaining product gaps are multi-account onboarding, a true team approval system, first-party analytics/listening, bulk planning, and stronger media preparation.

## Current platform parity

| Capability | Instagram | Facebook | YouTube |
| --- | --- | --- | --- |
| OAuth and manual connection | Yes | Yes | OAuth |
| Credential encryption and legacy reads | Yes | Yes | Yes |
| Credential-bound account selection | Yes | Yes | Yes |
| Durable immediate and scheduled publishing | Yes | Yes | Yes |
| Idempotency / ambiguous-outcome quarantine | Yes | Yes | Yes |
| Provider-side processing check | Media containers | Provider response | Upload processing poll |
| Supported formats | Photo, carousel, Reel, Story | Text, photo, video | Video, Short |
| Safe remote reconciliation/deletion | Yes | Yes | Yes |
| Webhook routing | Messages/comments | Messages/feed/leads | Not applicable to publishing |
| Multiple accounts visible to publisher | Data model/API ready | Data model/API ready | Data model/API ready |
| Multiple accounts connectable in one OAuth flow | No | No | No |
| Native post/profile analytics | Limited elsewhere in product | Limited elsewhere in product | No |

YouTube Community Posts are intentionally excluded. The public YouTube Data API supports video resources, including upload, list, update, and delete, but does not provide a Community Post creation endpoint.

## Improvements delivered in this tranche

### YouTube

- Replaced the false Community Post path with supported video and Short publishing only.
- Normalized legacy `shorts` requests to `short` and added server-side title, description, privacy, video, duration, and aspect-ratio validation.
- Added credential/channel binding, durable publish attempts, leasing, retry policy, mixed-platform preflight, and duplicate-upload protection.
- Added resumable streaming uploads from SSRF-checked public media URLs with a transfer-size guard.
- Preserved refresh tokens, refreshed expiring access tokens, exposed connection readiness/scopes, and added best-effort provider revocation.
- Defaulted uploads to private and surfaced Google project-audit readiness in the UI.
- Polls YouTube processing after acceptance; processing failures and 24-hour timeouts become terminal without re-uploading.
- Added credential-bound remote existence reconciliation and supported remote video deletion.

### Instagram and Facebook

- Encrypted OAuth/manual access tokens, app secrets, and page tokens; retained backward-compatible reads and rotation on refresh.
- Removed secret-bearing values from session metadata and expanded the migration to legacy Meta Ads rows.
- Made manual credentials participate in canonical connection/routing records.
- Scoped disconnects and webhook routing per platform so disconnecting Facebook does not silently disable Instagram, or vice versa.
- Decrypts per-tenant webhook app secrets for signature validation.
- Added deterministic reconnect account selection and preserved the previously selected Page.
- Retained credential-bound durable publishing for Instagram photo/carousel/Reel/Story and Facebook text/photo/video.

### Content Studio and calendar

- Retired the confusing AI Studio navigation/deep-link while retaining the Content Studio agent inside campaign conversations.
- Added YouTube account, format, visibility, and title controls across manual, dialog, widget, and AI approval publishing flows.
- Added Instagram multi-image carousel upload and cross-platform compatibility checks.
- Added platform/status calendar filters, attempt/retry/error/provider details, and safe rescheduling.
- Prevented deletion of assets with in-flight or provider-accepted attempts and cancelled safe pending attempts before deletion.

### WhatsApp and email

- Encrypted Gmail and WhatsApp credentials with legacy-compatible readers; preserves refresh tokens and revokes Gmail grants on disconnect.
- Added a forward migration that rotates legacy Gmail/WhatsApp token columns and nested credential metadata without restoring plaintext on rollback.
- Made WhatsApp webhook signature verification fail closed when the raw body is unavailable.
- Added recipient/account validation, readiness information, real enable/disable enforcement, and permanent-versus-transient retry classification.
- Kept Resend domains tenant-owned and blocked tenant access to deployment-wide Resend account resources.
- Isolated Resend domain claims so one workspace cannot adopt another workspace's provider domain.

### Dependency security

- Pinned both vulnerable transitive `protobufjs` lines to patched same-major releases, removing all critical and high `protobufjs` advisories reported by the production dependency audit.
- Removed the unused vulnerable `lodash.set` package and its unused type package from the client.

## Remaining work, prioritized

### P0 — launch and provider compliance

1. Run the credential migration in staging and production, verify encryption coverage, and define a key-rotation/runbook policy. Production must use a dedicated `SECRETS_ENCRYPTION_KEY`.
2. Complete Google OAuth verification and YouTube API audit. Until the API project is audited, Google may force API uploads to private visibility.
3. Register Meta/WhatsApp webhook callbacks and verify tokens, enable required app-review permissions, and validate signatures using captured provider fixtures.
4. Configure Gmail redirect URIs, Pub/Sub, webhook delivery, and scheduled Gmail watch renewal.
5. Verify the Resend sending/receiving domain, DNS records, webhook secret, and inbound routing in a dedicated production Resend account.
6. Run real-provider canaries: one private YouTube video/Short, one Instagram photo/carousel/Reel/Story, one Facebook text/photo/video, one WhatsApp template/text, one Gmail message/reply, and one Resend message/reply.
7. Triage the remaining production dependency backlog (currently 94 high, 114 moderate, and 18 low advisories). Prioritize direct or internet-facing packages such as Next.js, `xlsx`, legacy `imap`/`semver`, and transitive HTTP/parser/glob libraries; several require replacement or coordinated framework/major upgrades rather than a safe automatic patch.
8. Deploy on the repository's declared Node runtime (`^20.19.0` or `>=22.12.0`); the local validation host was Node 20.11.1 and emitted an engine warning even though builds and tests passed.

### P1 — close the leading-product workflow gap

1. **Multi-account connection UX:** persist every authorized Facebook Page/Instagram professional account, add a Page/account chooser during OAuth, and support multiple YouTube channels/workspaces without overwriting the first credential.
2. **Channel-specific engagement views:** keep inbound conversations and replies in the existing Instagram/Facebook/WhatsApp outreach pages; route formal cases through the Support control board instead of adding a duplicate unified inbox.
3. **Calendar planning:** drag-and-drop rescheduling, week/list views, campaign labels, bulk CSV import, duplicate/evergreen actions, timezone display, conflict warnings, and mobile parity.
4. **Media pipeline:** transcode/normalize before scheduling, extract trusted duration/dimensions, validate codecs/size/aspect ratio per network, crop/thumbnail/cover editing, alt text, subtitles, and safe preview rendering.

### P2 — intelligence and optimization

1. Pull post/profile analytics into a normalized warehouse: reach, impressions, watch time, retention, engagement, clicks, follower change, response time, and failures.
2. Add best-time-to-post recommendations based on each connected audience and objective—not generic time slots.
3. Add campaign/UTM tracking, goals, share-of-voice, competitor benchmarks, scheduled reports, exports, and anomaly alerts.
4. Add listening for brand/keyword/hashtag mentions where provider terms permit it, with sentiment, trend spikes, and human-reviewed AI summaries.
5. Add AI repurposing by platform, brand voice controls, compliance checks, content scoring, accessible variants, and performance-grounded recommendations.

### P3 — YouTube depth

1. Thumbnail upload and selection, playlist assignment, category/language/license/audience/synthetic-media fields, caption tracks, chapters, and end-screen workflow guidance.
2. Scheduled visibility changes using YouTube-native `publishAt` where appropriate, with quota forecasts and audit-state-aware UX.
3. Channel/video analytics, comment moderation/replies, retention reporting, and content-gap recommendations.
4. Direct-to-provider resumable upload sessions so large media does not traverse an application worker twice.

## Acceptance gates

- No credential, token, app secret, webhook secret, or session secret is stored or logged in plaintext.
- A publish action is always bound to the reviewed workspace, provider account, media, copy, format, and schedule.
- Worker restarts, duplicate jobs, timeouts, and provider 5xx responses cannot create duplicate posts.
- Provider acceptance is not reported as final success until asynchronous processing is confirmed.
- Reschedule/edit/delete/disconnect actions cannot race a claimed or provider-accepted attempt.
- Every inbound webhook is signature-verified, tenant-routed, replay-safe, and idempotent.
- Production canaries and disconnect/reconnect tests pass for every enabled provider before general availability.

## Validation completed

- Server: full typecheck and production app/worker builds passed; 117 Jest suites and 1,376 tests passed; full lint completed with no errors.
- Client: full typecheck and production build passed (246 generated routes); 23 Vitest files and 253 tests passed; full lint completed with no errors.
- Static application-contract audit completed across 296 pages, 1,114 API call sites, 618 unique client contracts, and 1,110 server routes; 594 contracts were statically matched and the audit exited successfully.
- Production dependency audit: 0 critical, 94 high, 114 moderate, and 18 low advisories after the safe protobuf and unused-package remediations.
- Post-change authenticated browser verification remains pending because the Chrome profile available for this review was at the sign-in screen. No live provider publish, revoke, or webhook mutation was attempted; those release canaries are intentionally retained as P0 gates.
