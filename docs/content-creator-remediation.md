# Content creator remediation

Source: user-approved audit, 18 September 2026. A checked item means implemented and covered by local checks. External/provider verification is tracked separately below.

## Functional fixes
- [x] DM destination-aware handoff
- [x] SMS selected limit, encoding and segments
- [x] Opt-in companion media and configured credit estimates
- [x] Per-ad suggestions rendered
- [x] Frozen video proof, persistent errors and correct duration constraint
- [x] Live email/SMS/blog attachments
- [x] Generated asset editing/deletion/duplication/reusable conversion

## Shared workflow
- [x] Draft/template distinction, saving disclosure and real lifecycle status
- [x] Visible brand/provider/channel prerequisites (connections checked in destination workflows)
- [x] Durable generation idempotency and uncertain-request recovery; expired receipts keep tombstones
- [x] User-scoped prompt/manual draft recovery and reversible enhancement
- [x] Channel-specific post-generation handoffs (review/setup, never automatic sending)
- [x] Useful empty proofs, visible constraints, consistent search/actions/deletion
- [x] Media stages, failure/retry guidance and pre-read upload validation; unsupported cancellation explicitly disclosed

## Channel capabilities
- [x] Email mobile/inbox proof, suggested preheader, heuristic risk/variable checks
- [x] SMS opt-out/link warnings, encoding/segments and configured AskSales sending fee
- [x] DM variable samples/recipient proof/limits/readiness
- [x] Social separate platform variants, crop/safe-area proof and carousel order
- [x] Ads placement proofs/destination/policy/headline variants/campaign handoff
- [x] Blog outline review/sources/SEO/featured image/internal links/export and exact-version CMS review bridge
- [x] Image cropping/comparison/alt/white-background transparency/download
- [x] Video durable jobs/stages/retry/storyboard/WebVTT captions/audio/recovery
- [x] WhatsApp upload progress/URL preflight/clone/manual language variants

## Verification
- [x] Focused client and server tests: combined final run 363 client tests (42 suites) and 179 server tests (6 suites)
- [x] Client typecheck and production build; API and worker production bundles
- [ ] Full server typecheck: blocked by pre-existing/parallel errors outside this change; new content errors corrected
- [x] Chrome UI checks: final live desktop/mobile run passed 20/20 on `d4850c0c6`; the two initial SMS long-token clipping failures were fixed and retested. Mobile SMS and email screenshots were visually inspected.
- [x] Main application commit `f0049e3bf` and frontend polish commit `d4850c0c6` deployed; migration 278, runtime privileges, API/client health and worker startup verified. Production application release: `d4850c0c606d2194cb5235cd5dbc706120394983`.

## Constraints
Provider actions must reflect actual capabilities. Never display invented ETA, prices, successful publishing, cancellation, or sandbox verification. Uncertain paid operations must not silently retry.

## External validation and capability limits
- The Chrome extension connection returns `Transport closed`. The repository's Playwright runner successfully launches installed Chrome independently and tests the deployed UI using isolated API fixtures; real-account/provider end-to-end verification remains outstanding.
- No paid video generation, real sending, Meta template submission or CMS publication was performed.
- SMS carrier/provider rates require destination and sender; only the configured AskSales fee is displayed. No unsupported carrier quote is invented.
- Running video provider cancellation and reliable ETA are not currently supported. Jobs survive navigation, show known stages and failures, and provide explicit retry guidance.
- Captions are reviewed WebVTT tracks, not automatic transcription or burned-in subtitles.
- Image background removal targets white connected edges, not general AI subject segmentation. Crop/safe-area proofs do not silently rewrite social media.
- WhatsApp language variants require manual translation and fresh media; provider approval is never cloned. Sandbox verification remains pending a configured test environment.
- CMS handoff requires an owned matching project with completed analysis, then explicit exact-version approval before a remote draft is created.

## Live regression scope
The isolated Chrome suite covers seven non-video creators on desktop and mobile: typing does not create a proof, a submitted response updates it, and the next prompt does not overwrite it. It also checks copy-only defaults, SMS limits/encoding/segments/long-token wrapping, WhatsApp component-specific variables and language cloning, and the video page without generating a video. All API calls and sockets are intercepted; the suite neither reads customer data nor creates real provider jobs. The follow-up suite checks the visible save disclosure and accessible video prompt label.
