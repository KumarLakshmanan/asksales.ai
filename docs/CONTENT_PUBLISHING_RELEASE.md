# Publishing and calendar reliability — September 2026

## Delivered behavior

- Calendar cards open their details with mouse or keyboard; schedule selection is explicit and limited to eligible posts.
- Dragging into a weekly hour changes both the date and time, with a confirmation. Reschedule and cancel distinguish one destination from the whole cross-post group and detect stale edits.
- Scheduled posts offer cancellation, eligible pending posts offer Publish now, and drafts alone offer deletion. Failed destinations expose safe retry or provider reconciliation using the existing immutable receipt.
- Calendar refreshes pending delivery status, includes publish-now processing entries and cancelled posts, and distinguishes editorial plans from provider schedules. Notification links open the matching date and card.
- Attempt history is fetched in one calendar query. Failure notifications respect account notification preferences.
- Scheduled delivery uses a dedicated bounded worker queue. Claims and lease renewal protect against concurrent sends, repeated jobs, and long media uploads.
- Template, calendar-create, and legacy-dialog entry points use the same final publishing review. Conversation approval uses the same formats and advanced settings, with per-destination receipts and partial-success handling.
- Scheduling follows account timezone preferences and displays the exact reviewed instant. Idempotency receipts survive page reloads within a browser session.
- Facebook photo posts retain all reviewed images (up to ten). Instagram carousels accept two to ten images/videos in the displayed order: images, then videos.
- Instagram feed-photo alt text, location ID, collaborator usernames, Reel feed-sharing, cover library picker, and thumbnail offset are supported. Options are scoped to compatible formats.
- Actual image bytes are checked for size, dimensions, format, animation and feed ratio before publishing. Instagram images are normalized to correctly oriented sRGB JPEG when needed.
- YouTube review includes thumbnails, playlists, chapters, category, language, license, visibility and disclosures. Thumbnail/playlist access is checked before publishing. Follow-up setup retries preserve the original video receipt; repeated optional-setup failures produce a published-with-warning result instead of uploading again.
- Remote preparation happens before the database commit lock; the source version and media are checked again before committing. No database transaction waits through image downloads or optional YouTube provider operations.

## Explicit capability boundaries

Instagram supports feed photos, mixed carousels, Reels and Stories. Facebook supports text, multi-photo feed posts and videos. Facebook Reels/Stories remain unavailable in this integration and are explicitly labelled. YouTube supports video and Shorts; Community posts are not offered. LinkedIn and X templates are labelled for copy/export, rather than promising this durable IG/FB/YouTube publishing workflow. The separate legacy conversation integration is not migrated in this release.

## Verification

Focused server coverage includes isolated PostgreSQL lifecycle/race tests, provider adapters, media probing/normalization, queue leases, notifications and YouTube finalization. Frontend coverage includes review settings, timezone conversion, per-platform formats, conversation receipts and calendar actions.

`client/e2e/content-publishing.spec.ts` runs in Google Chrome on desktop and mobile. It verifies real wheel scrolling, calendar detail actions, full media previews, and an IST schedule submission. Provider/account responses are deterministic fixtures, unrelated reads are isolated, and every unmocked mutation is blocked. All four checks passed locally and against `https://asksales.ai` with `E2E_BASE_URL=https://asksales.ai E2E_SKIP_WEBSERVER=1`; they do not create real social posts.

Validation also passed 101 focused backend tests (including 24 isolated PostgreSQL lifecycle cases), 79 frontend tests, the client typecheck, and API/worker builds. The queue recovery regression was rerun after adding failed-job cleanup so exhausted infrastructure retries do not suppress later durable-attempt dispatch.

Production release checks must verify API/client health, new worker registration, due/processing attempt state, and the deployed revision. A fixture browser pass is not evidence that a particular connected account has successfully posted to a live provider.
