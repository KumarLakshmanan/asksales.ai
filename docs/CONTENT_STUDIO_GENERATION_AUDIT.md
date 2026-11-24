# Content Studio generation and upload audit

Last updated: 2026-08-29

## Scope

This audit covers every content category exposed by `/dashboard/saved-templates`: image, video, email, SMS, WhatsApp, social post, social DM, ad creative, and blog post. Each category is checked for:

1. content-specific AI inputs;
2. custom/manual creation and media upload;
3. API validation and persistence;
4. immediate preview and durable library visibility;
5. live Chrome request, response, console, and saved-result evidence.

## Generation and upload matrix

| Content type | Generation route | AI inputs | Custom/manual upload | Persistence path |
| --- | --- | --- | --- | --- |
| Image | `/saved-templates/image/generate` | Prompt, source/reference image, negative prompt, aspect ratio, style, image size, count, seed | Required JPEG/PNG/WebP file or existing image URL; optional caption/alt text | `content_assets` type `image`, then `/api/content/assets/upload` |
| Video | `/saved-templates/video/generate` | Prompt, start-frame image, negative prompt, aspect ratio, style, duration, resolution, count, people policy, seed | Required video file or existing video URL; optional caption/transcript | `content_assets` type `video`, then `/api/content/assets/upload` |
| Email | `/saved-templates/email/generate` | Brief, email type, tone, audience, CTA, hashtag and emoji controls | Email body plus optional image | `content_assets` type `email_template`, then optional media upload |
| SMS | `/saved-templates/sms/generate` | Brief, SMS type, tone, character limit, opt-out, hashtag and emoji controls | SMS body plus optional MMS image | `content_assets` type `sms_template`, then optional media upload |
| WhatsApp | `/saved-templates/whatsapp/generate` | Category, format, AI brief, generated copy, language, header, variables, footer, buttons | Direct image/video/PDF header upload or existing media URL/Meta handle | `whatsapp_templates`, then `/api/whatsapp/templates/:id/media` |
| Social post | `/saved-templates/social/generate` | Brief, destination platform, reference image, post type, tone, hashtag and emoji controls | Caption plus optional image/video | `content_assets` type `social_post`, then optional media upload |
| Social DM | `/saved-templates/dm/generate` | Brief, messaging platform, DM type, tone, recipient name/context, hashtag and emoji controls | Message plus optional image/video attachment | `content_assets` type `social_dm`, then optional media upload |
| Ad creative | `/saved-templates/ads/generate` | Brief, ad platform, objective, tone, brand name, product URL, hashtag and emoji controls | Ad copy plus optional image/video creative | `content_assets` type `ad_copy`, then optional media upload |
| Blog post | `/saved-templates/blog/generate` | Topic, blog type, tone, length, audience, introduction/conclusion, hashtag and emoji controls | Article body plus optional cover image | `content_assets` type `blog_post`, then optional media upload |

## Defects found and corrected

- Custom social videos were persisted as type `video`, so `/api/content/assets?type=social_post` could not return them after refresh. They now remain `social_post` assets with video media attached.
- Social custom uploads ignored the upload response, so the new media was missing from the immediate preview. The returned media URL is now added to the result state.
- A failed second-step media upload could leave a draft asset behind while the UI reported that saving failed. Shared manual creation and the social custom form now remove the incomplete draft on attachment failure.
- Social AI had no destination-platform selector and no reference-image input. Both are now present. The reference bytes are schema-validated, passed through the durable image job, and used by the selected image provider as an input reference.
- Ad and DM pages had dormant platform lists but always sent `all`. Both now expose the platform choice and persist it for manual and AI output.
- WhatsApp was the only library category without AI assistance or direct file upload. It now generates draft copy through the existing text LLM provider path and supports validated image/video/PDF header upload.
- The social upload label was not programmatically associated with its file input. The label/input relationship is now accessible and testable.
- Content Studio text handlers selected one configured LLM credential directly. A recoverable 403 from the first Gemini credential therefore produced an empty response and a misleading 502 validation error instead of trying the next configured text provider. All nine text-completion call sites now use the existing provider fallback chain; the configured Gemini/OpenAI/Vertex preference remains authoritative and OpenRouter remains an optional text fallback.
- Generated JSON treated optional fields as strictly absent-or-string/array/boolean. Gemini can validly express “not applicable” as `null`, which caused SMS (and could cause other text formats) to fail schema validation after a successful provider response. Shared generated-content schemas now normalize `null` optional fields to missing/default values while continuing to reject missing/null required content.
- The Video page defaulted to `1080p` even though the configured OpenRouter `bytedance/seedance-2.5` model supports only `480p` and `720p`. The live request failed with HTTP 500 before creating a job. The page now defaults to `720p` and exposes only the two Seedance 2.5-supported resolutions.
- OpenRouter status checks treated every provider error as retryable. A legacy operation that OpenRouter reported as HTTP 404 therefore remained `done: false` and was repolled on every interval and reload. Terminal 4xx job errors now return `done: true`, persist the asset as failed, and stop polling; transient 408/409/425/429 and 5xx failures remain retryable.
- WhatsApp AI copy could return legacy named variables such as `{{first_name}}` even though Meta templates require numbered variables. AI output is now normalized deterministically to `{{1}}`, `{{2}}`, and so on, preserving repeated and already-numbered placeholders.
- Draft asset creation incorrectly required all canonical template variables to be resolved, so a valid manual email draft containing `{{first_name}}` failed with HTTP 422. Canonical variables are now allowed while creating/editing drafts and remain mandatory to resolve at publish time.
- Persisted manual SMS envelopes were displayed as raw JSON after save, producing an incorrect character count (observed as `731/160`). The SMS loader now extracts the stored `message`/`content`/`body` field while preserving legacy plain-text assets.

## Automated evidence

- `client/src/__tests__/contentGenerationUploads.test.tsx`: three focused tests pass for rollback, durable social-video typing/immediate media, and AI reference-image submission.
- `client/src/__tests__/whatsappTemplateLifecycle.test.tsx`: seven lifecycle tests pass, including AI copy, direct header media upload, and stale-media clearing when the header type changes.
- `client/src/__tests__/contentVideoGenerationContract.test.ts`: guards the Seedance 2.5-compatible `720p` default and `480p`/`720p` choices.
- `client/src/__tests__/contentAssetMapping.test.ts`: covers manual SMS envelope extraction and legacy plain-text compatibility.
- `server/tests/contentStudioSocialReference.test.ts`: two schema tests pass for accepted and rejected reference formats.
- `server/tests/contentStudioTextProviderFallback.test.ts`: two contract tests pass and guard all nine Content Studio text-completion call sites against bypassing the configured provider fallback chain.
- `server/tests/contentCompliance.test.ts` plus the fallback contract: 12 focused tests pass, including nullable optional SMS/social output.
- `server/tests/content.test.ts`: 25 controller tests pass, including canonical personalization variables in draft assets while publish-time resolution remains enforced.
- `server/tests/openRouterMediaWorkers.test.ts`: four worker tests pass, including terminal HTTP 404 status handling and retryable HTTP 503 handling.
- The exact release lineage passes the full client TypeScript check, 10/10 focused client tests under the repository-required Node 24 runtime, and changed client files have no ESLint errors.
- Server API and worker bundles build successfully.
- The full server TypeScript check currently stops on one unrelated pre-existing comparison in `instagramWebhookController.ts` (line 898); no changed content-studio file is reported.

## Production deployment evidence

- Content-studio commit `563be98b` was fast-forwarded onto the current production lineage and is contained by deployed head `1ad74856`.
- A verified pre-deployment PostgreSQL backup was created at `/var/backups/asksales/predeploy-20260828T194429Z.dump`.
- API, both workers, client, and Hermes images were built sequentially from the combined head and the containers were recreated.
- API, client, Hermes, and public HTTPS checks returned HTTP 200; Redis returned `PONG`; PostgreSQL accepted connections; and BullMQ loaded in `sm-worker-1`.
- Authenticated Chrome confirmed the deployed Social destination/reference-image controls, DM platform control, Ads platform control, and WhatsApp AI-copy/direct-upload controls.
- Text-provider fallback commit `ec6953bd` and nullable-output commit `cbe3945d` were deployed in the API image. The rollout retained the concurrent conversation-hardening lineage, and API/public HTTPS health checks returned HTTP 200 after each scoped recreate.
- Live server logs proved the first Gemini credential's 403 was followed by a successful second Gemini-provider attempt; OpenRouter was not selected for the successful email/SMS text generation.
- Seedance resolution fix `237216e7` was deployed after a verified backup at `/var/backups/asksales/predeploy-20260829T051421Z.dump`. The production client compiled all 255 pages; API, client, and Hermes health checks returned HTTP 200 after container recreation.
- Draft/preview contract fix `649ea16d` was deployed after verified backup `/var/backups/asksales/predeploy-20260829T055537Z.dump`. The final mixed-variable hardening commit `993f5387` was deployed after verified backup `/var/backups/asksales/predeploy-20260829T062323Z.dump`. Both deployments compiled all 255 pages; API, client, and Hermes returned HTTP 200, and both workers were running.
- Terminal OpenRouter status fix `d6af49dc` was deployed after verified backup `/var/backups/asksales/predeploy-20260829T064826Z.dump`; API, client, and Hermes returned HTTP 200 and both workers were running.

## Chrome DevTools completion ledger

Authenticated Chrome confirmed every AI-settings form and every custom-creation form is present in production. Action-time approval was granted for 18 clearly labelled `Codex QA` production drafts and workspace-credit use. The extension file chooser remained unavailable because **Allow access to file URLs** was disabled, so Chrome DevTools populated each real file input with a synthetic 3,137-byte PNG or 2,323-byte MP4 and dispatched the normal `change` event. All listed custom results below therefore exercised the live React form handler, asset-create request, multipart upload request, and durable reload path; no API-only shortcut was used.

| Content type | Custom upload request + durable result | AI request + durable result | Console/network clean |
| --- | --- | --- | --- |
| Image | **Pass:** asset `140`; create HTTP 201; multipart upload HTTP 200; `/uploads/1/content_asset/codex-qa-image-1787981815806-2525b054.png` survived reload | **Pass:** asset `137`; `/uploads/1/image/generated-1787979669605-f1fb2e80-1787979669606-ab1da0a4.bin`; OpenRouter `bytedance-seed/seedream-5-0-pro` | Ready preview and Recent count `12`; media fetch HTTP 200 |
| Video | **Pass:** asset `141`; create HTTP 201; multipart upload HTTP 200; `/uploads/1/content_asset/codex-qa-video-1787982083474-843a793f.mp4` survived reload | **Provider-blocked after app fix:** deployed UI sends supported `720p`; the current-account request reaches OpenRouter `bytedance/seedance-2.5` but returns insufficient provider credits. A prior user-9 run produced asset `128` while the provider was funded. | Custom MP4 served HTTP 206. A legacy missing operation produced exactly one terminal status call, changed to “Needs attention,” was not repolled, and produced zero status calls after reload |
| Email | **Pass after fix:** asset `147`; create HTTP 201; multipart upload HTTP 200; canonical `{{first_name}}` remained in the draft; `/uploads/1/content_asset/codex-qa-email-1787984237841-9b778dc1.png` was returned by the authenticated list after reload | **Pass:** HTTP 200, asset `130`; first Gemini credential returned 403 and the second configured Gemini provider succeeded | Recent count increased from `34` to `35`; draft and media remained durable |
| SMS | **Pass:** asset `142`; create HTTP 201; multipart upload HTTP 200; `/uploads/1/content_asset/codex-qa-sms-1787982327614-c01793d8.png` survived reload | **Pass:** HTTP 200, asset `131`, 152/160 characters | Final Recent view rendered the custom message rather than its JSON envelope and reported the correct `104/160` count |
| WhatsApp | **Pass:** template `2`; create HTTP 200; `/api/whatsapp/templates/2/media` HTTP 201; `/uploads/1/content_asset/codex-qa-whatsapp-1787982563676-221c2536.png` survived the template-list reload | **Pass after fix:** live HTTP 200 returned mixed `{{first_name}}` and `{{1}}`; the deployed editor rendered canonical first-appearance order `{{1}}`, then `{{2}}` | Final console check had no application error; only two expected WebSocket reconnect warnings during container restart |
| Social post | **Pass:** asset `143`, type `social_post`, channel `all`; create HTTP 201; upload HTTP 200; `/uploads/1/content_asset/codex-qa-social-1787982407856-fd71853b.png` | **Pass:** HTTP 200, asset `132`, platform `all`; companion image/video jobs queued | Recent count increased to `25`; custom image rendered durably |
| Social DM | **Pass:** asset `144`; create HTTP 201; upload HTTP 200; `/uploads/1/content_asset/codex-qa-dm-1787982452414-57de6e86.mp4` | **Pass:** HTTP 200, asset `133`, platform `all`; companion image/video jobs queued | Recent count increased to `2`; custom message and video persisted |
| Ad creative | **Pass:** asset `145`; create HTTP 201; upload HTTP 200; `/uploads/1/content_asset/codex-qa-ad-1787982483062-abcb84ca.png` | **Pass:** HTTP 200, asset `138`; structured headline/body/CTA persisted; companion video failed separately on OpenRouter provider balance | Custom proof displayed image, approved domain, headline, and Learn More CTA |
| Blog post | **Pass:** asset `146`; create HTTP 201; upload HTTP 200; `/uploads/1/content_asset/codex-qa-blog-1787982528331-7b1011a3.png` | **Pass:** HTTP 200, asset `139`; durable generated title/body | Recent custom draft confirmed as `Draft #146`; no page errors |

Remaining external blocker: add funds to the configured OpenRouter account, then resubmit the current-account Seedance 2.5 video request. All application-side release verification is complete.
