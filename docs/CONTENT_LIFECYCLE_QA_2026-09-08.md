# Content lifecycle verification — September 8, 2026

## Scope and safety

Verify generation from campaign chat and Content Studio/library, manual creation, reusable template versions, publish-now and scheduled publishing from library/template and chat surfaces, and Content Calendar timing. Fix observed defects and verify the actual changed paths. Publication is mocked only: no real Facebook, Instagram, Threads, YouTube or other provider posts, outreach sends, ad activation, or spend.

Current worktree is authoritative. Pre-existing CRM/support edits are unrelated and will be preserved. Earlier campaign QA is context, not proof of this goal's content coverage. Existing tests that only inspect source text or replicate production logic do not establish end-to-end behavior.

## Verification matrix

Evidence distinguishes real browser/provider checks from deterministic tests of production handlers and rendered React components. Mocked tests exercise the real application code with provider responses and failure points controlled; they do not certify an external provider's availability or generated-content quality.

| Content type | Campaign chat generation | Studio/library generation | Manual creation/edit/reload | Versions/reuse |
| --- | --- | --- | --- | --- |
| Images, including reference-image generation | Actual executor with mocked generator; exact source ID/MIME, save failure | Actual controller and rendered page; durable receipt, parent/version guard | Upload/attachment and retry tests | Media assets use content identity/version, not reusable text-template snapshots |
| Videos, including image-to-video | Actual executor and durable queued-operation recovery tests | Actual controller, rendered page and completion polling tests | Exact parent attachment, trusted stored probe, no duplicate provider submission | Content identity/version and publish snapshots |
| Email / HTML email | Actual executor, save/provider failures, media exclusions | Actual controller + rendered page; real signed-in browser generation/reload | Manual composer and reusable library tests | Version model, controller, history/reuse UI tests |
| SMS | Actual executor, save/provider failures, media exclusions | Actual controller + rendered page; real signed-in browser generation/reload | Manual composer and reusable library tests | Version model, controller, history/reuse UI tests |
| Social posts (supported platforms and all-platform mode) | Actual executor + destination matrix | Actual controller + destination matrix + rendered page | Manual composer, caption/CTA/hashtag preservation and upload retry tests | Immutable reviewed publish payload plus reusable-template history |
| Social direct messages | Actual executor, save/provider failures, media exclusions | Actual controller + rendered page | Reusable library manual creation tests | Version model, controller, history/reuse UI tests |
| Ad creative/copy | Actual executor and post-save media queue tests | Actual controller + rendered page + active sidebar attachment tests | Reusable library manual creation tests | Version model, controller, history/reuse UI tests |
| Blog posts | Actual executor, save/provider failures, media exclusions | Actual controller + rendered page | Reusable library manual creation tests | Version model, controller, history/reuse UI tests |
| WhatsApp templates (separate existing workflow) | Actual draft executor, no Meta submission, persistence failure | Existing dedicated WhatsApp template lifecycle/payload tests | Dedicated template lifecycle; not an eighth Studio text generator | WhatsApp approval/submission contract remains separate |

| Publication/calendar requirement | Evidence/status |
| --- | --- |
| Mock publish-now from library/template surface | Production HTTP handler and isolated PostgreSQL fixture, mock provider; rendered SocialPublisher/PublishContentDialog/CreatePostModal |
| Mock publish-now from campaign chat | Production chat executor, same durable lifecycle and mock provider; rendered PublishPostWidget |
| Mock schedule from library/template surface | HTTP + isolated PostgreSQL fixture and rendered publishing forms |
| Mock schedule from campaign chat | Chat + isolated PostgreSQL fixture and rendered widget |
| Due-time worker, no early publish, idempotency/replay | PostgreSQL lifecycle tests: due-time claim, one provider invocation, replay binding, claimed-attempt protection |
| Same schedule shown in calendar, local timezone/day boundaries | Real calendar controller query against fixture including video; rendered calendar timezone, date range and response-order tests; strict DST gap/fold validation |
| Reschedule/cancel/replacement and historical attempts | Transactional fixture tests including concurrent replacement, invalid preflight rollback, cancelled history, more callers than pool connections |
| Multi-platform partial failures and honest status reporting | Lifecycle/preflight tests plus rendered controls preserve partial/pending/retry status instead of reporting published |
| Tenant ownership, exact reviewed version/media/account | Controller and fixture ownership checks; immutable request fingerprint; template approval/version/brand lineage; trusted media probe and guarded edits |
| Failure/loading/retry UI without duplicate creation | Rendered tests preserve draft IDs/upload receipts and reviewed idempotency key; unknown outcomes fail closed; media pending/save failure remains explicit |

## Fixes

- Generation now reports durable saved IDs and honest failures, retains campaign/brand linkage, rejects foreign campaign references before provider work, and honors explicit media exclusions.
- Removed implicit prompt enhancement from all eight Studio generators. Enhancement remains an explicit user action. Added instruction priority for the reviewed prompt.
- Social previews retain CTA and hashtags; platform limits include the final combined caption. Added Threads to the generation contract. SMS previews do not append an opt-out footer twice. Reusable-template cards preserve underscores in variables and URLs.
- Reference-image generation never substitutes another thread image for a missing selected source; MIME and safe source resolution are preserved.
- Video generation saves parents and unfinished operations before queue handoff; retries resume saved operations/results instead of silently submitting another video. Attachments target the correct saved parent and version.
- Publishing, cancellation, rescheduling, edit/delete guards and calendar mutations share durable transactional rules. Replacement is atomic, replay keys bind the reviewed request, and claimed/remote-active attempts cannot be overwritten.
- Calendar includes standalone videos, preserves the intended slot on failure, and uses the selected timezone consistently.
- Template saves/approvals lock the current row and reject stale validated versions. Copies/imports start at version one with correct tenant governance; history excludes private/unapproved snapshots.
- Six reusable text-template libraries now expose manual creation and version history. Reuse goes through server rendering with variables, current approval/version and brand lineage.
- Publishing/manual-media controls show loading, preserve drafts/uploads across retries, use stable reviewed request keys, and distinguish queued/partial/failed outcomes from publication success.

## Evidence log

- Signed-in Chrome verification generated two email drafts and one SMS draft. The second email preserved the explicitly requested subject after removing implicit enhancement. Drafts remain in the user's library; no outreach or social publication occurred.
- Real browser reload verified the eight-generator shell's SMS form, saved recent items and creation-method controls after changes.
- After the coordinated API restart, a real browser created `QA lifecycle reusable SMS 2026-09-08`, edited it to version two, reloaded the library and inspected both snapshots. Version one retained the original text; version two retained the update; variables displayed correctly after the preview fix. The first save coincided with the restart and failed to fetch; the library was reloaded to confirm no record existed before retrying. Only one reusable QA template was created and remains saved, unsent.
- Local API restart loaded the completed changes and returned HTTP 200 health at 03:38:48 IST. Existing worker/provider-mutation safety settings were retained. This task did not deploy to production.
- Backend publishing/recovery group: 8 suites / 59 tests passed (including 16 isolated PostgreSQL lifecycle cases and 19 automatic/pending-video recovery cases). Fixture schema was removed after the run; no real application records were modified by those fixtures.
- Template group: 4 server suites / 63 tests and 3 client suites / 42 tests passed. Version concurrency tests use a deterministic transaction adapter; publish concurrency uses actual PostgreSQL.
- Final main backend group: 10 suites / 161 tests passed in 24.063 seconds (Studio generation, campaign generation, video completion receipt, compliance, social reference images, ad normalization, media ownership/preview safety, WhatsApp payload/lifecycle).
- Final publication fixture rerun: 18 / 18 passed in 4.533 seconds, adding explicit successful publish-now and no-duplicate replay from both HTTP and campaign chat.
- Final UI group: 113 distinct tests across 12 files passed, including 42 rendered generator-page scenarios, 20 active media-attachment caller cases and publishing/calendar/manual recovery. Two test timeouts under simultaneous Next compilation were rerun with a larger timeout and passed without runtime-code changes for the timeout.
- A final real-browser manual-template smoke identified underscore removal in library previews; the display fix and a new variable/URL-preservation regression passed (17 library tests).
- Together with the template group, verification covers 285 distinct backend tests and 156 distinct client tests (441 total). These are focused regression suites, not the entire repository test suite.
- Scoped UI lint: zero errors; three AdCopyTab hook warnings remain. Whitespace diff check passed.
- Full server and client TypeScript checks passed (`tsc --noEmit`, Node 24, 6 GiB server / 4 GiB client heaps). The client gate caught unsupported Testing Library selector options; those were corrected and the affected tests rerun.

### Reproducible focused test groups

Use the repository's Node 24 runtime. Run serially on memory-constrained hosts.

```sh
# server/ — ordinary fixtures and mocked generation
node --max-old-space-size=2048 --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand tests/contentStudioGenerationLifecycle.test.ts tests/contentChatGenerationLifecycle.test.ts tests/videoCompletionReceipt.test.ts tests/contentCompliance.test.ts tests/contentStudioSocialReference.test.ts tests/adsExecutorNormalization.test.ts tests/contentAssetMedia.test.ts tests/contentAssetPreviewSecurity.test.ts tests/whatsappTemplatePayload.test.ts tests/whatsappTemplateLifecycle.test.ts

# server/ — isolated local PostgreSQL publishing and recovery; no public-schema writes or real provider calls
CONTENT_PUBLISH_LOCAL_QA=1 node --max-old-space-size=2048 --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand tests/contentAutoVideoRecovery.test.ts tests/organicPublishLifecyclePostgres.test.ts tests/generatedVideoStorageProbe.test.ts tests/mediaTranscoding.test.ts tests/openRouterMediaWorkers.test.ts tests/organicPublishingPolicy.test.ts tests/contentCalendarBulkPolicy.test.ts tests/mediaGenerationWorkerFactory.test.ts

# server/ — reusable-template model/controller regression
node --max-old-space-size=2048 --experimental-vm-modules node_modules/jest/bin/jest.js --runInBand tests/contentTemplateVersions.test.ts tests/contentTemplateLifecycle.test.ts tests/contentTemplateRendering.test.ts tests/content.test.ts

# client/ — rendered forms, generators, publishing controls, calendar and previews
node --max-old-space-size=2048 node_modules/vitest/vitest.mjs run --maxWorkers=1 --testTimeout=60000 src/__tests__/remainingMediaAttachmentCallers.test.tsx src/__tests__/studioGenerationPageMatrix.test.tsx src/__tests__/manualContentRecovery.test.tsx src/__tests__/contentCalendarTiming.test.tsx src/__tests__/contentGenerationUploads.test.tsx src/__tests__/contentGenerationReviewFlags.test.tsx src/__tests__/socialPublishingHelpers.test.ts src/__tests__/publishPostWidget.test.tsx src/__tests__/socialPublisher.test.tsx src/__tests__/publishContentDialog.test.tsx src/__tests__/contentPreviewCopy.test.tsx src/__tests__/socialPostCard.test.tsx src/__tests__/createPostModalPublishing.test.tsx src/__tests__/reusableTemplateReuse.test.tsx src/__tests__/reusableTemplateLibrary.test.tsx
```

## Verification boundary

No live social publish button was submitted, and no real social API publication was made. Production publishing code was exercised only behind an isolated fixture with a mocked provider. External-provider credentials, rate limits and upstream uptime were not validated by posting. Media-provider generation paths were validated deterministically, not by purchasing a fresh video for every combination. CRM/support work in the shared checkout is owned by the parallel support task and is not part of this report.
