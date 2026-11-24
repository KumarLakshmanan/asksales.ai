# Conversation workflow QA and repair log

## September 7 — sequential lead-module and loader audit

Scope: local enrichment, conversation processing surfaces, search-input review, lead directory, campaign leads, lead detail/edit, and backend provider/review/save/recovery contracts. Browser checks use saved local records; failure/completion/concurrency scenarios use mocked providers and persistence. No paid provider run, production write, outreach send, or deployment is part of this pass.

Issues repaired:

- Enrichment events are keyed by persisted run ID. Concurrent runs no longer share a progress indicator; late progress cannot revive terminal activity. Pending runs show a queue state, and the generic spinner yields to the detailed progress banner. Terminal events refresh saved results. Auto-scroll now targets the actual scroll viewport and clears its timer on cleanup.
- Runs without recorded activity for 15 minutes show a stale-status warning, not a claim that a worker is still active. This does not mark them failed or restart them. Local historical run with five-month-old running status verified the warning in Chrome.
- Provider failures are distinct from successful zero-result responses. All-source failures become failed runs; partial failures are disclosed. Completion is emitted after summary persistence, and deep-enrichment exceptions attempt to persist a failed terminal state. Lifecycle regressions use mocked providers/DB, including failed result, thrown request, empty success, failed summary save, and interrupted lead update.
- Search Settings labels its read-only load accurately and offers retry on errors instead of reporting missing parameters. Late responses from a previous campaign are ignored. Equivalent request ownership protects the lead directory, campaign leads, detail and edit pages against stale responses.
- The browser exposed a lead-detail crash on an empty location object (Rio Boutique, local lead 1174). Structured locations now render safely on detail/edit/sheet surfaces; zero engagement counts remain zero. Chrome verified the same detail record opens after the fix. Unnamed picker/directory entries have identifiable labels.

Browser observations: enrichment list/detail and stale status, new-enrichment empty-submit disabled, existing-lead picker loading-to-results, directory loading and name filtering to Rio Boutique, and successful detail rendering after the location fix. Local Next dev server was restarted after a stuck compilation; API/production were untouched. Broad client tests are run with one worker after parallel execution exhausted local resources; the successful rerun, not timed-out attempts, is the acceptance evidence.

Final browser check restored campaign 181 with eight saved leads and a completed search state. Lead Inputs loaded read-only, expanded the reviewed Instagram Post Author Profiles settings, and displayed both GoaHotels and BoutiqueHotelGoa, resultsLimit 5 per hashtag and global cap 10. No approval/run controls were clicked. Automated totals: 103 passing client tests across 16 suites; 236 unique passing server tests across 20 suites (including seven enrichment lifecycle cases). Live paid-provider acceptance across every platform remains separate from this mocked regression/saved-record browser pass. Latest backend changes still require API restart/rollout; no production deployment occurred.

Final client and server TypeScript checks and `git diff --check` passed.

## September 7 — enrichment candidate validation

Used production Manan Tholia enrichment as a read-only reference: decimal map coordinates became phones, formatting guessed +1, website variants/short links inflated counts, and employer profiles/statistics contaminated person fields.

Shared candidate validation now covers extraction, merges, aggregation, API history projection and client rendering. Historical counts reflect sanitized arrays without rewriting summaries or step audit data. Unattributed legacy social totals and company LinkedIn links under named people are hidden. Scores based on removed values are suppressed. Valid company/personal mailboxes remain candidates; syntax is not ownership or deliverability verification.

New runs scope person/social/stat fields to supplied subject handles. Discovered LinkedIn company URLs use the company actor; bare linkedin.com is not a company lookup. YouTube links no longer trigger recursive website crawling for platform legal contacts. Unverified scraped/LLM contact candidates stay in enrichment results for review instead of automatically populating outreach contact columns; existing contacts are preserved. This deliberately trades automatic filling for avoiding third-party misattribution.

Verification: 18 server regressions, one client rendering/copy regression, server/client TypeScript checks, and a read-only local browser check of an existing completed result. The Manan regression uses representative observed values, not a fresh paid production run. No production writes or deployment were performed. API changes require rollout; previously contaminated lead columns are not bulk-rewritten by this patch.

## September 7 — duplicate conversation loading surfaces

The screenshot showed a compact ToolExecutionCard plus ChatThinkingBubble's large ConversationActivityGroup, both tracking the same active tool. The fallback now uses the existing compact ToolCallChip accordion and yields to a current-turn/current-agent tool call, running linked widget, workflow progress row, or streaming reply. Completed tools and historical turns do not suppress new thinking. Linked running/queued/reconciling widget cards no longer render a second large progress surface below their tool accordion; editable review forms and failed/retry states remain available.

Rendered regressions cover ICP, leads, content, outreach, ads, fallback expansion, old turns, agent handoffs, tool completion, streaming, workflow steps, and linked widget statuses. 38 tests passed across progress ownership, tool cards, and conversation polish. Local Chrome campaign 181 read-only follow-up showed one collapsed Marcus loading accordion, no large activity card, and removal of the indicator upon response completion. No search or outreach was executed for this UI check.

## September 7 — Instagram customer journey, campaign 181

Live execution completed after review of saved input 122/revision 4: both requested hashtags, resultsLimit 5 per hashtag, and global saved-lead cap 10. Provider hashtag run `LKLUdMwe0yVD5ErsV` returned ten posts from nine authors; profile run `BNh6S8cHQwebETFCj` returned nine profiles. The UI completed in 29.7 seconds with eight saved hotel profiles and excluded Rivera Holiday (travel agency). Rio Boutique's detail showed an unavailable email, its real website/Instagram account, and disabled Approve leads first outreach control. These are hotel-business candidates, not proof that all eight are independent boutique properties: the dataset includes budget/generic/collection properties. Stricter requested-segment qualification remains open.

Rio Boutique also exposed a fabricated Twitter handle copied from the generic Instagram username. Final server normalization now scopes generic handles to their originating network while retaining explicit cross-network handles. Lead detail suppresses unsupported legacy cross-network handles; Chrome verified Twitter disappeared while Instagram remained. Twelve server normalization tests and four rendered lead-detail tests passed. This latest server handle change is not yet runtime-loaded; client hot reload was browser-verified. One post insert was skipped during the provider run (all ten raw posts have IDs and no provider error fields); the exact persistence failure still needs diagnosis. The full six-platform/multiple-workflow acceptance matrix is not complete.

Follow-up: browser JSON proved the total-limit helper deleted the second requested hashtag while the assistant claimed both were present. It now preserves all hashtags/Google Maps search strings and divides per-target fetch limits, keeping the separate global saved-lead cap. Natural numeric requests for “profiles” and “accounts” now count as lead-limit units. Chrome subsequently showed both actual hashtags; final regeneration with the new profile-limit parser is pending. The latest failure-state and limit fixes are loaded in the local API. The current server TypeScript check passed; 127 relevant tests passed across eight files (including 34 request-constraint tests). These remain partial journey results, not final acceptance.

The natural Goa boutique-hotel request reached ICP approval and automatic lead-strategy continuation. The assistant then invented unavailable Instagram strategies and IDs. The catalog presentation now uses authoritative workflow data with exact named selection buttons; natural requests to show all available options read that catalog directly even after incorrect assistant history. Chrome verified ten actual selectable Instagram workflows.

Live selection exposed another failure: the model supplied the display title `Instagram Post Author Profiles` rather than the catalog ID. Input generation now resolves exact, unambiguous catalog titles; unknown titles still fail, and the durable confirmed-strategy comparison remains mandatory. In the same chat, a natural retry successfully generated reviewable inputs for the actual post-author workflow and stopped at Approve & Run Search. No Instagram provider execution has occurred yet. The first settings included four hashtags and 50 posts; a customer refinement requesting only GoaHotels/BoutiqueHotelGoa and around ten profiles is in progress.

Normal assistant replies were also incorrectly limited to 2,000 characters by error sanitization. Chat serialization and WebSocket output now preserve full reply text while continuing to mask provider infrastructure errors. A duplicate ephemeral catalog reply was observed before this change; its separate cause is not yet verified. Failed input generation now attempts a source-stage-guarded transition from generating to needs_attention/failed, so it does not leave an active generation state blocking strategy reselection. This last failure-state change has tests but is not loaded into the local API yet.

Verification: 16 tests passed across strategy presentation/name resolution, user-facing error handling, and input-generation persistence. Server TypeScript passed before the final failure-state change. Browser evidence proves catalog availability and successful input preparation, not all-platform completion. Facebook campaign 180 previously returned a real hotel business record; Instagram execution, a second Instagram workflow/chat, Twitter, JustDial, Google Maps, and LinkedIn journeys remain outstanding. No outreach, paid-ad activation, commit, or deployment was performed.

## September 7 — preserve distinct streaming event identities

WebSocketService now deduplicates by explicit eventId, falling back to legacy messageId only when no event identity is present. This preserves distinct updates sharing one assistant message ID and suppresses a replay even if its transport messageId differs. Unidentified legacy events are passed through without filling the cache with random IDs. Added a real service regression (two chunks for one message plus replay); WebSocketService and conversationStreamReducer suites passed:34 tests (2049). Existing legacy dedup and envelope tests remain green. This does not complete the server envelope migration or prove browser reconnect acceptance.

Native Chrome campaign171 tab remained available and its title resolved to the saved campaign, but the screenshot still showed a blank page. No new chat turn, approval, outreach or ad mutation was submitted. Test wall time125.54s included83.53s environment setup, versus1.53s actual tests, consistent with the earlier host-pressure evidence but not conclusive root-cause attribution.

## September 7 — runtime healthy; browser and host pressure evidence

API95048/PID7530 completed startup and /health returned200 (76597). Browser CDP reported prior tab1 no longer belonged to the session; inventory confirmed no in-app tabs. Replacement-tab creation timed out/reset the CUA kernel. Native Chrome opened a separate localhost campaign171 tab, but screenshot showed an empty loading document; existing user tabs were not modified. Login HTTP check53727 timed out while NextPID1141 remained listening and consumingCPU.

Read-only macOS diagnostics reported14,994 MB swap used and3,854 free16KB pages, evidence of substantial memory pressure (not proof it causes every timeout). Cleaned up only owned QA API98088 and6242: both had previously logged completed graceful shutdown, were reverified as exact QA commands with no TCP listeners, then force-terminated after lingering. Observation sessions24458/9817 exited137. No files removed; activeAPI7530/frontend1141 and unrelated processes remain untouched. Full browser flow still unverified.

## September 7 — missing save receipt is not an empty lead result

readLeadSaveReceipt now rejects missing/malformed receipts rather than silently converting them into zero leads. Explicit workflow succeeded_empty remains supported when a zero-match provider skips its save node. Both executor branches pass the workflow outcome into validation. Added receipt and executor regressions; leadExecutor, leadSaveReceipt and outreachExecutorQueue passed together:48 tests (6262). This is not proof of end-to-end provider correctness; the producer's own empty-outcome classification still needs a complete audit.

Existing browser tab1 again timed out during focus emulation. API6242 logs confirmed authenticated user1 WebSocket/Event Bus registration at12:29:39, providing additional sign-in evidence, but not rendered campaign correctness. Reloading tested code:6242 gracefully closed its listeners at12:35:02; started the same gated local API in95048. No production deployment or live provider mutation.

## September 7 — QA runtime refresh and browser sign-in

Server type-check25667 passed. Sent SIGTERM to verified owned API98088; logs confirmed HTTP/WebSocket/Redis shutdown and port8080 was released, but PID remained alive after the clean-shutdown log (cleanup gap, not forcibly killed). Started the same local-only, Redis14, ad-mutations-disabled API as PID6242/session9817. Startup completed and /health returned200 (38126).

Isolated in-app browser tab1 opened campaign171, route returned200, and login rendered. Submitted the previously authorized QA login. Frontend began compiling /dashboard/home, without a visible login error; authenticated campaign access is not yet proven. Navigating back to campaign171 timed out in Page.navigate and the following snapshot timed out in focus emulation. Tab was marked for handoff before that timeout. Frontend51907 remains running; no restart merely for slow compilation. UI rerun49194 ended with12 passing tests and two five-second overview timeouts; Ad Copy/navigation passed on this run. Browser acceptance remains incomplete.

## September 7 — exact lead save receipts through the executor

Both executeLeadWorkflow branches use readLeadSaveReceipt: validate positive safe integer IDs, deduplicate them, and derive the conversation total from their union across providers. Reviewed capacity decreases only for newly seen IDs. A positive claimed count without saved IDs fails instead of claiming actionable leads. Updated successful executor fixtures to return realistic saved-ID receipts; added regression coverage for missing receipts and overlapping IDs in both explicit-selection and fallback execution paths. Lead executor, receipt validation, and outreach queue suites passed together: 40 tests (34498), using fake providers. These tests do not establish real provider delivery or full browser acceptance. Local API PID98088 has not yet been restarted for this change.

## September 7 — Content overview redesign and live counts

Content overview now uses native keyboard-accessible library buttons, a scoped heading, saved-count labels, and a loading state instead of premature zeroes. Counts supplied by the parent now update after refresh rather than remaining frozen in initial component state. Unknown counts use a dash; fallback count requests expose a retryable failure while libraries remain available. Thread changes remount the overview to isolate local state.

Three new rendered overview tests passed (26337), including count refresh, pending/unknown counts, and retry after failure. Initial combined run: 12 passed and one Ad Copy retry test timed out. Isolated Ad Copy rerun: eight passed, same retry test timed out at five seconds. Subsequent navigation run also timed out on its nine-button traversal (previously passed); no timeout limits changed. Full validation remains incomplete. Local preview HTTP request timed out; no new browser screenshots or production deployment in this pass.

## September 7 — regenerate malformed QA route types

Stopped owned Next preview PID98535 cleanly (session1898 exit0). Moved only malformed generated dev/types/routes.d.ts and validator.ts into /tmp/asksales-route-types.NRFYVC for recovery; no source files removed. Ran Next typegen with NEXT_DIST_DIR=.next-workflow-qa successfully, and inspected the regenerated routes file ending. Client type-check39213 passed. Restarted preview in session51907; Next reported Ready in410ms. Also reran five lead-input/outreach contract suites: 43 tests passed (76204), covering immutable input snapshots, exact queue recipients, campaign aggregates and delivery ordering/acknowledgement using fake providers. Full conversational acceptance remains unproven.

## September 7 — saved video playback diagnosis and recovery UI

The local QA tab had closed while another task used Chrome; no other tab was changed. Read-only local DB lookup identified asset117's /uploads/1/video/generated-1787303148863-d701993b-1787303148864-0737573d.mp4. File exists (7,415,886 bytes); ffprobe reports H.264/yuv420p,1920x1080,8 seconds. Backend HEAD returned200 video/mp4; frontend byte-range GET returned206 video/mp4 without redirect. These checks do not explain the previously observed browser failure and do not prove playback.

Added inline controls/preload metadata to VideoCard, a load-error notice and retry that remounts the same media URL without generation, and reset of error state when changing assets. Moved Open/Download outside the video so overlay buttons no longer cover controls. Four preview/date tests passed (85060); client type-check88616 pending. Browser playback retest still required. No media regenerated or deployed.

## September 7 — browser result-tab verification and video date repair

Native Chrome interaction restored usable browser QA. Conversation171 loaded authenticated with saved history, review widgets and result tabs; Ad Copy toolbar/filter rows were visible during loading. Added a result view through Explore Tabs → Content Studio → Video Gallery. Videos loaded one saved item; native accessibility reported Unable to play media and Created Invalid Date. The invalid date was traced to String(video.createdAt) passed into new Date: VideoTab now passes the numeric timestamp and VideoCard accepts numeric/ISO/legacy millisecond-string values with a Date unavailable fallback. Seven date/recovery tests passed (63104). HMR visual recheck is pending while Next recompiles. The existing saved video's playback failure is unresolved and must be investigated; no provider video request or publication was made. This does not prove the full conversation journey.

## September 7 — native Chrome fallback and local preview recovery

Local frontend PID64095 was absent and port3000 had no listener. Started Next webpack preview in session1898/PID98535 with the existing local API configuration and isolated .next-workflow-qa output. Next reported Ready in3.2s, then began compiling the conversation route. Its generated tsconfig includes were added automatically.

Chrome CDP Page.navigate timed out again. Native Chrome accessibility controls worked: selected the blank tab in the Workflow QA group and navigated via its address bar to localhost:3000/dashboard/conversations/171. Screenshot confirms the address and loading state; actual app rendering still awaits route compilation. Other task tabs were not modified. Server type-check41023/PID97940 completed successfully. This is verified runtime/browser progress, not a completed workflow test.

## September 7 — video completion persistence receipts

checkVideoStatus now refuses operations without an owned saved asset before querying the provider. Cached and newly attached results return assetId/persisted. A failed/missing database update returns retryable HTTP503 with done:false/providerDone:true/persisted:false rather than a false successful completion; failure-state persistence is also checked. VideoTab validates exact persisted asset identity before clearing a successful video operation. Five controller tests and five rendered recovery tests passed (33760/58101). Client type-check 89896 passed before these final edits; server type-check 41023 running.

Previous API PID95753 and session35009 were absent and port8080 had no listener, so the API was started in session24458 with the same local DB/Redis14/provider gates. Startup completed at 11:45:08 and /api/health returned HTTP200. No production deployment or real video request.

## September 7 — Videos library saved jobs and recovery

VideoTab standalone generation now requires persisted:true and an exact positive saved asset ID; removed manual-ID success fallback. Abort copy no longer claims cancellation of provider work. Added thread-keyed panel isolation, stale-load rejection, cleanup on unmount, per-operation deduplicated/non-overlapping polling and bounded status checks with a pending (not failed) timeout notice. Library reload rediscovers saved pending performance.operationName values and shows a pending request count instead of an empty-library headline.

Initial recovery/identity tests passed: 13 tests in two files (53679). Final three recovery tests including pending-notice assertions passed in 26866. Earlier handles 29624/83023 disappeared; actual process inventory confirmed neither remained active, so their results were not assumed. A fresh client type-check was started. The provider status endpoint still needs an exact persistence receipt for terminal updates, and attachment-parent jobs outside the standalone Videos library need equivalent reload recovery. No real video generation or production deployment.

## September 7 — content cards must not infer media failure

Audited Email, SMS, Social Message, Social Post and Ad Copy cards. Missing media plus an existing prompt (or auto-generation request flag) was being displayed as provider failure. Replaced those inferred failures with neutral unattached-media notices, neutral styling and Generate labels. Actual request errors remain in their request handlers; this change does not yet project durable queued/provider-failed media status into every card. All ten rendered tests passed across the five image states, three video states and Email video preview (43051). Client type-check 73599 passed. No live media request or deployment occurred.

## September 7 — awaited completion publication

Added WebSocketEmitter.emitPersistedWidgetUpdate and wired the completion reaper to it. It validates exact owner/thread scope, keeps the outbox event ID as both envelope messageId and payload event IDs, sanitizes error fields, and awaits EventBus.publish instead of swallowing rejection. Redis acceptance is not browser delivery; reconnect still requires durable state reload. EventChannel now explicitly types existing events:ws channels. Six new emitter tests cover acceptance timing, rejected transport, stable replay IDs and mismatched scope; all 16 emitter/dispatcher/gateway tests passed (53038).

Server-wide type-check 51061 finished with an unrelated shared-worktree error in tests/supportFaqRecoveryStage.test.ts:27 (Jest returned from a hook rather than void). No Support hunks changed. Local API PID 89175 shut down cleanly at 11:30:25; replacement session 35009 / PID 95753 started with local DB guard, Redis DB14 and live ad mutations/media workers disabled. Server listened at 11:31:35 with EventBus and gateway initialized. No production deployment.

## September 7 — gateway outage must not block completion continuation

Client type-check 28859 passed. Found that completion notification emission and durable workflow resumption shared one try block: a gateway exception prevented the run from resuming. The dispatcher now catches transport errors independently, still attempts the durable continuation, and retains the pending notification until both dispatch and continuation are settled. Retry uses the same event ID; the continuation's existing completed guard prevents re-execution. Added a gateway-outage/recovery regression. Eighteen notification/continuation tests passed across two suites (52131). Server type-check 51061 pending. Process-crash recovery for a continuation left running remains unresolved; this change is not a solution for that separate failure mode.

Chrome inventory showed the old local QA tab had closed. Creating a new local QA preview timed out at Page.navigate; Next process 64095 remains listening on localhost:3000. No application restart inferred from the browser timeout. Backend runtime has not been reloaded with this dispatcher change, and no production deployment occurred.

Follow-up inspection: actual WebSocketEmitter.publishToEventBus is fire-and-forget and swallows publish rejection. Therefore dispatcher exception handling alone does not prove transport acknowledgement in the live path. Next required repair is an awaited durable publication path for completion notifications before acknowledging their marker. Chrome's newly created tab 942342207 remained about:blank; reconnect failed at Emulation.setFocusEmulationEnabled, independently of application navigation.

## September 7 — sidebar Email attachment handoff

Found Email card image/video actions changed behavior when onSendMessage existed: they discarded the parent ID and sent a generic standalone-generation chat prompt. Removed that special case so saved-card attachment actions use the owned parent endpoint in both sidebar and library contexts, matching the other content cards. New email generation still uses chat when provided. The image success copy now says attached to the email instead of saved to a separate Images library. Added sidebar-callback coverage for image receipt handling and saved/queued/unconfirmed video outcomes.

The saved-video test exposed a real missing projection: EmailTab stored videoUrl but never passed it to EmailCard. Added that prop and a controlled, non-autoplay video preview. Removed the video failure label inferred from a prompt with no URL, which is not provider failure evidence. Initial tests found this projection failure plus one timeout; after the fix all 23 identity/generation tests passed in session 12832. Two actual EmailCard rendering tests also passed in session 35301. Earlier type-check 5030 passed; final type-check 28859 remains live (PID 94197 verified). No provider mutations or production deployment. Full browser/provider completion remains unverified.

## September 7 — content type navigation redesign and video receipts

Replaced the Content selector's uneven chips with an intrinsic-width responsive tile grid, aligned counts, wrapped labels, visible keyboard focus and a consistent blue active rail. All nine content types retain their existing callbacks. Known zero counts are distinguished from unavailable counts. This extends the shared toolbar/filter/card layout work; it is not a claim that every individual tab has completed visual QA.

Direct Email/Social/DM video actions now pass numeric saved parent IDs and thread scope, require an exact persisted parent receipt, and distinguish an attached video from a saved queued operation. Social Message uploads now pass numeric parent IDs. Chat-delegated media and upload receipt verification remain incomplete.

Targeted tests: 33 of 34 passed initially; one Email attachment case exceeded the unchanged five-second timeout. Its entire ten-case file passed separately with one worker. Navigation, identity, Ad Copy review and Blog checks passed. Client type-check passed in session 2632. Chrome visual verification could not finish: selecting local tab 942342158 first timed out, then returned Debugger unattached. No production changes, provider publication or real media generation occurred.

## September 7 — generated images attach to saved content

Direct image actions in Email/SMS/Social/DM previously created standalone images while only decorating the source card in memory. Added strict UI-to-numeric saved asset ID conversion, pass parent assetId and threadId to the existing owned attachment endpoint, and require persisted:true with the exact parent receipt before updating the preview. Malformed/manual/unsafe IDs and unrelated standalone receipts are rejected. Seventeen identity/generation tests passed before adding two rendered Email attachment cases; the expanded rerun is session 49210. TypeScript found unsupported Testing Library exact options in the new generator tests; removed them and reran in session 22289 (pending). No real media was generated.

Video/upload flows and chat-delegated image attachment still need equivalent exact-parent verification. These changes do not establish complete content-to-publishing coverage.

## September 7 — saved identities across text content generators

Extended the direct-generation repair to SMS, Social Posts and Social Messages: send threadId/persist:true, reject success without a positive safe saved assetId, and use db-asset IDs rather than manual timestamp IDs. Blog success now also requires a saved asset receipt. Removed SocialTab's automatic image/video calls after generation because the server already queues media against that asset. Eight rendered generation tests passed across Email/SMS/Social/DM with positive/missing receipts, exact campaign scope and no duplicate media request. Local insertion now replaces an existing same-ID card rather than appending a duplicate if a websocket update arrived first; this final deduplication edit still needs fresh regression coverage.

Full client rerun session 98973 (--maxWorkers=2, unchanged timeouts) completed successfully: 94 files / 609 tests passed. It began before this turn's added cases/edits, so the separate eight-test run is the focused evidence for the generator changes, not a claim that the full run covered the final tree. Latest edits still need client TypeScript/fresh regression and browser journey verification. No real content generation, publication, outreach or production deployment occurred in this pass.

## September 7 — direct Email generation persistence

The prior client TypeScript check passed. Full client Vitest session 87257 finished: 91 files / 604 tests passed, two files / three tests failed solely on the 5000ms test timeout (MetaAccountStatus and two AdCopyReviewEntry cases). Started the same full suite with --maxWorkers=2 in session 98973, without extending timeout limits, to distinguish contention from functional regression. Do not treat the rerun as green until its result is collected.

Found EmailTab's direct generator omitted threadId and discarded the server's saved assetId in favor of a manual timestamp ID. Added explicit threadId/persist:true, require success plus a positive safe asset ID, and retain db-asset identity and campaign ownership in the displayed result. Missing persistence evidence now reports an error instead of adding a success card. Two rendered generation tests passed with mocked enhancement/provider responses. No real content was generated in this pass. The chat-driven generation branch remains unchanged; fresh broad regression and type-check coverage of this final change are still pending.

## September 7 — review loading must not erase draft identity

Chrome reload completed: stop widget 41 retained campaign 23, its saved name, Meta-only selection, draft status and explicit unverified provider status. Review remained unapproved. Inspection found StopAdsWidget's loading/error callbacks supplied only _review_validation_error, while WidgetContext autosave replaces the whole form. Changed those callbacks to retain campaignId/platforms and filtered the transient validation key out of draft API saves. Submission payloads still retain validation blockers; no approval bypass was introduced. Twelve focused draft/stop/publishing UI tests passed, including exact identity preservation during loading/failure and blocker retention during submission. Client type-check is running. No backend restart was needed for this frontend-only change; no production deployment or provider action occurred.

## September 7 — browser stop-review journey

Latest server TypeScript completed successfully. On authenticated local Chrome campaign 171, sent a review-only request for paid campaign 23 / Meta, explicitly forbidding execution, publication and spend. The live turn routed to Sarah, executed query_ad_campaigns, created stop_ads widget 41 and produced the truthful pending-review response. After its lookup resolved, the card showed the exact saved campaign name, ID 23, Meta only and continuing-spend warning. No confirmation was clicked. Added saved local/provider status to the card, explicitly labelled provider status as last recorded and not live verified; three rendered UI tests and client TypeScript passed.

Reload verification encountered a transient browser deadline, then the page snapshot returned its persisted Blog tab and loading chat area. The stop card's post-reload state still needs verification. This browser test proves review creation/lookup/rendering, not stop execution or worker completion. No real ads were paused and production was not changed.

## September 7 — retry-aware background continuation

The explicit local PostgreSQL suite passed all 17 cases including the new atomic completion marker; the prior server TypeScript run passed. Added a detailed continuation disposition while preserving the synchronous route's boolean wrapper: resumed, waiting, obsolete, completed or failed. The notification sweep now invokes the scoped continuation handler before acknowledging. Open sibling cards/running continuation claims and failures retain the marker for retry; already completed/obsolete work can be acknowledged without advancing another run. Twenty-seven focused notification, continuation and widget-route tests passed. The latest server type-check is still running. Restarted only the owned local QA API after confirmed graceful shutdown; no live provider mutation or production deployment occurred.

Still required: actual worker-to-browser-to-agent verification, crash recovery for a continuation left running, broader job-type reconciliation, and bounded retry/backoff for repeatedly failing continuations. A successful unit dispatch is not proof of the full end-to-end journey.

## September 7 — durable stop completion notification

Stop reconciliation now atomically stores a pending completionNotification with stable widget event identity alongside its terminal receipts. Added bounded pending lookup and owner/event-scoped acknowledgement, plus a reaper dispatcher that sends the complete durable widget to its user/thread and acknowledges only after dispatch. Failed sends/acknowledgements can replay the same identity; dispatched is not a claim of browser receipt, and reconnect still uses durable widget state. Fifteen focused notification/continuation tests passed. Added a PostgreSQL assertion for the atomic marker, not yet executed in this pass. This currently covers stop reconciliation only; automatic orchestrator continuation and equivalent notification contracts for the other job types remain unfinished.

The existing QA process 88064 finished startup and /health returned 200. Server TypeScript session 32834 remained live at this checkpoint. New notification wiring still requires a fresh local runtime verification; no production changes were made.

## September 7 — completion callback scope guard

Before wiring background continuation, hardened resumeWorkflowAfterWidgetCompletion to re-read the exact owned widget, require its matching tool/run and a durable succeeded/failed status, then verify the thread still belongs to that run. Delayed callbacks cannot resume a newer request. Continuation now takes success and result from the durable widget rather than optimistic callback fields. Eleven orchestration tests passed, including tenant/thread/tool/run mismatches, queued state rejection, late completion and persisted failure overriding callback success. The prior client TypeScript check completed successfully. Background completion delivery/outbox and crash-safe continuation remain open; this guard alone does not connect them.

## September 7 — browser recovery and UTC campaign schedule repair

Rechecked the exact running API PID 85078: /health returned 200 without a restart. Chrome campaign 171 subsequently loaded durable messages and the Blog empty-library state. The saved campaign 23 review was present, retained asset 114 revision 1 and USD 50 lifetime cap, and blocked approval because Meta media was missing. No publication was authorized.

The review exposed a timezone shift: the request specified September 8–15 UTC, while the stored draft displayed September 7–14 18:30 UTC. PublishAdsWidget converted zone-free datetime-local values through the browser's local timezone. Updated the editor to display and label UTC, serialize naive review values as UTC, preserve explicit offset instants, and round default schedules in UTC. Added exact midnight/offset round-trip assertions; 11 review contract/rendered tests passed with TZ=Asia/Kolkata. Existing saved draft dates were not rewritten. Full browser verification of newly prepared dates remains required.

Further inspection confirms the approval reaper reconciles durable widget rows but only logs a count; it does not itself emit completion or resume waiting orchestrator actions. This remains an open end-to-end reconciliation requirement, not a completed workflow merely because the database status changed.

## September 7 — side-panel design continuation

Continued the existing dark workspace design with shared container-width toolbar wrapping, visible keyboard focus, long-text wrapping and stable result-scroll gutters. Blog now uses the shared filter/results layout, has explicit load-failure/retry and no-search-match states, applies search within campaign groups, and isolates library/editor state by campaign. Request sequencing prevents a late load from replacing a newer one. Added three rendered Blog regressions; the Blog, Image and Ad Copy selection passed 15 tests, and client TypeScript passed.

Chrome access recovered without editing Codex configuration. Local campaign 171 Ad Copy rendered with measured clientWidth = scrollWidth = 695px and its actions/filters separated; a screenshot was inspected. Opening Blog showed the redesigned loading layout, also 695px without horizontal overflow, but its data and chat messages remained pending. The local API PID 85078 was listening yet /health timed out after ten seconds (curl exit 28). This is not a successful Blog end-to-end check. No production deployment, content generation, publication or outreach was performed. Remaining content types still need individual visual and interaction verification.

## September 7 — stop review, canonical approval and receipt reconciliation

Connected stop_ads to the performance agent, canonical widget registry, server/client widget mappings and explicit paid-stop routing. Ordinary tool invocation creates only a review; canonical submission requires a durable widget ID and queues using its stable identity. A read-only stop-review endpoint resolves the owned saved campaign; the UI blocks approval until that lookup succeeds and displays the exact campaign/platforms plus continuing-spend warning. Queued/gated and completed receipts render separately. Stop submission retains ownership/module checks but does not require purchasing credits. Generic confirmation is disabled until the editor is mounted.

Added exact-action stop reconciliation scoped by tenant, campaign, platform and stored action IDs. All receipts must be terminal; success requires explicit pause or safe pre-launch cancellation evidence, not a bare succeeded job. Missing provider evidence results in attention/failure. Seventeen temporary-table PostgreSQL tests passed including exact stop completion and missing-outcome failure; 27 focused client tests passed. The first server integration run passed 76 tests and both typechecks. A final route regression was added for zero-credit stop submission. Browser-to-provider verification, live socket propagation of reconciled stop state and in-flight provider/stop races remain open. No real ads were paused and nothing was deployed.

## September 7 — owned paid-campaign discovery

Added query_ad_campaigns to the performance agent and tool metadata. The read-only executor resolves exact IDs or name searches against the authenticated user's saved paid campaigns, with bounded pagination and a strict input schema. It selects and projects public fields only, excludes settings/credentials, and explicitly labels provider status as last recorded rather than live verified. This closes the campaign-discovery prerequisite for an exact stop review; it does not execute a stop. Twenty-nine focused query/agent-router tests passed. Browser verification and the actual stop review/approval integration remain incomplete.

## September 7 — durable stop queue foundation

Added AutonomousAdsService.queueCampaignStop for an explicitly authorized exact owned campaign/platform selection. Under the campaign row lock it validates platform membership, fences selected-platform approvals immediately, cancels pending/processing publish/activate/resume jobs, queues user-authored pause actions and writes an audit. Provider gates prevent claims of pausing, not durable local launch cancellation. Idempotent replay returns queued/gated/current receipt state without another action. Worker revocation is now platform-scoped while still honoring legacy global revocations; stopping Meta must not revoke Google approval. Forty-six focused review, fake-provider and explicit temporary-table PostgreSQL tests passed, including gated stop, unrelated-platform preservation, ownership, empty selection and paused receipt replay. The initial database run caught a missing SQL text cast, fixed before passing. The conversational tool, approval binding, in-flight provider completion race and end-to-end stop UX remain open; this backend method is not exposed as a completed chat feature.

## September 7 — explicit local PostgreSQL reconciliation verification

Ran the previously skipped adPublishQueuePostgres and outreachCampaignPostgres suites with an explicitly validated localhost connection. All 20 tests passed. Both use connection-local temporary tables and mocked ad readiness, not application rows or live providers. Evidence now covers exact saved approval replay, changed-review rejection, provider gating, tenant isolation, cancelled/reclaimed worker leases (including PostgreSQL microseconds), superseded-failure aggregation, per-platform partial activation in both completion orders, outreach enqueue acknowledgement races, delivery/bounce replay, missing receipts, cancellation, and durable stalled/conflict recovery. Temporary test tables disappear on connection close. This does not prove live-provider or browser journeys; the WhatsApp/support opt-in DB cases were not run in this pass.

## September 7 — full server regression pass and acceptance matrix

The complete configured Jest run under Node 24.19 passed 247 suites / 2,400 tests; three suites / 24 tests were skipped. Skipped tests are not acceptance evidence. The client full-run baseline is 89 files / 591 passing tests. Added CONVERSATION_ACCEPTANCE_MATRIX.md to retain the original full journey scope, required ordering, evidence limits and remaining release gates, including the missing conversational stop-ad action. No production mutation occurred, and browser/provider end-to-end completion remains unproven despite the green automated suites.

## September 7 — full client regression pass

Ran the complete configured client Vitest suite under Node 24.19: initial run had 88 passing files and one failing file (588 passing tests, three failures). All failures were registry smoke assertions expecting editable publishing platform labels while their mocked saved-review GET never resolves. Updated those tests to assert the intended loading status, exact retained campaign/asset/platform/account/budget fields, blocking review-validation message, and absence of an approval revision. The dedicated saved-review tests separately cover resolved authoritative data and retry failures. The full rerun passed all 89 files / 591 tests; client TypeScript passed. No application behavior was weakened to satisfy the old assertions. This is the configured Vitest suite, not live browser or provider end-to-end sign-off.

## September 7 — analytics summary contract

Verified PerformanceAgent exposes analytics_query and publishing but still lacks a stop-ad tool; provider pause handling exists lower down and is not yet an end-to-end conversational stop action. Repaired the analytics insight helper to read the executor's output.data envelope for campaign, lead, outreach and overview queries. It uses campaignName and avgLeadScore, requires recorded campaign data and positive impressions for CTR commentary, and never defaults absent metrics to zero. Lead/outreach recommendations require nonempty denominators; reported zero remains distinct from missing data. High CTR is no longer described as overall campaign success. Forty-eight focused analytics/policy/controller tests passed. No provider mutation was performed; browser and conversational stop verification remain open.

## September 7 — explicit lead-review authorization

The combined lead execution, input persistence/snapshot, review approval, outreach queue/aggregate, durable workflow and ICP suites passed 87 tests before this repair. Inspection then found the approval detector accepted negated requests because it searched independently for approve and leads. Replaced that with a conservative explicit full-set approval phrase, rejecting questions, conditional/reported/quoted intent, negation and partial-ID qualifications. Ambiguous wording must not change the approval gate. Normalization now accepts only positive safe integer IDs or decimal strings, not boolean/array/object coercions, hexadecimal/exponential strings or unsafe integers. Forty-four focused lead-review and orchestrator regressions passed after the repair. Server TypeScript is currently blocked by a separate shared-worktree error in tests/supportTicketAssignmentSync.test.ts:25 (callback is unknown); that file was not modified here.

Chrome retry found the old QA tab absent; inventory then failed because the computer-use configuration reported a duplicate key in /Users/lakshmananr/.codex/config.toml:283. No browser-policy bypass or configuration edit was attempted. Live browser approval/delivery verification remains pending, and no production or provider action was taken.

## September 7 — context indicator request ordering

Removed the module-global summary cache in favor of a mounted-conversation cache, and keyed the context indicator by thread so old data clears immediately on a switch. HTTP requests use a monotonically increasing local version; a matching WebSocket context update supersedes older requests and updates the cache. HTTP payloads with the wrong thread ID are rejected. Added rendered regressions for late HTTP versus newer socket data, wrong-thread responses, thread switching with pending requests/unrelated socket events, and remounting without stale global cache reuse. This is context-indicator isolation, not proof of complete conversation event ordering; unversioned WebSocket replay ordering still needs a shared durable event contract. Automatic compaction remains server-owned.

## September 7 — paid review UI isolation

Found that PublishAdsWidget retained local form/review state if reused for a different widget or saved campaign. Its load effect guarded its own response but did not reset the old form/review, and manual preparation callbacks could outlive a switch. Isolated the entire editor by thread ID, widget ID and saved campaign ID, and cleared review/error state at load. Added rendered regressions for failed loads after switching campaigns (same and different widget IDs), and a pending draft preparation completing after switching widgets. Old review revisions must never reach the new widget's approval form. Twenty-three focused saved-review, ad-card entry and exact-ID handoff tests passed; client TypeScript and whitespace checks passed. Browser verification remains pending; no production deployment or live approval occurred.

## September 7 — truthful retry summaries

Fixed the contradictory post-retry response: failed calls are now described as earlier attempts, not a blanket claim that no review exists or that the action remains unresolved. Failures remain in execution history; no failure is silently considered resolved merely because another call used the same tool name. Added toolCallId to validation failure execution events and persisted/emitted tool results for correct bubble pairing. Publishing card copy now points to Prepare saved campaign review before final approval and explicitly does not claim activation. Nine focused tool-loop tests and server TypeScript passed, including validation failure followed by a created generate_ad/publish_ads review without executing either tool. These are mocked loop regressions, not a replacement for browser verification. Production unchanged.

## September 7 — side-panel continuation and review routing

The account-discovery patch below was subsequently loaded and browser-verified for Meta: Sarah listed the saved account and Page choices, explicitly distinguished saved settings from live verification, and did not silently select an account. A draft-only settings confirmation exposed another routing ambiguity: generic “campaign review” was classified as outreach even with a Meta ad account and creative context. Added a paid-review context guard and restricted ambiguous outreach review fallback to an existing outreach conversation. Fifty-two focused routing tests and server TypeScript passed. After local API reload, the exact request reached Sarah and widget 40 with asset 114 revision 1, Meta account, USD 50 lifetime, destination, countries, and dates intact. Final approval was disabled until a saved review existed. Only “Prepare saved campaign review” was clicked; its result remains unverified. An assistant summary incorrectly said no review card was created after a failed tool attempt was corrected on retry; that contradiction remains open.

On resuming, Chrome listed the QA tab but denied access because its admin-enforced policy could not be verified. No alternate browser access or security workaround was attempted. Visual sign-off and the saved-review result therefore remain pending.

Continued the Images side panel with search, distinct no-match and retryable load-error states, compact wrapping generation-form controls, and request-version isolation so a late previous-campaign library response cannot replace current images. Renamed the Content Studio category “Ad Campaigns” to “Ad Copy” to avoid implying stored creatives are published campaigns. Twelve rendered Images/Ad Copy tests and client TypeScript passed under Node 24.19; git diff whitespace checks passed. This is an incremental redesign using the existing visual system, not a completed visual sign-off of all content tabs. No production deployment or live publication occurred.

## September 7 — account discovery contract

Rechecked the handed-off Chrome tab 942342132 and the live local API session 78962. No new compaction/provider logs appeared during this inspection. The last account-settings chat turn has two durable Coordinator provider-unavailable messages, not a saved campaign review; account selection remains unverified end-to-end.

Inspection found that check_integration_status only supplied a prose connection flag, while Performance Marketing asks users for account IDs. Added a safe accountSelection result to that existing read-only tool: Meta saved ad account/Page choices plus selected IDs; Google only its configured customer (explicitly not an exhaustive accessible-account inventory). A strict field allowlist strips nested/root tokens and secrets. Saved configuration is marked providerVerified=false; no account is silently selected, and readiness must still be verified before activation. Performance prompt now tells the agent to retrieve Meta choices before asking for a raw ID. Forty-five focused tests passed covering credential stripping, no implicit selection, legacy connection fallback, malformed/duplicate saved entries, Google inventory limitation, and routing/tool registration. This latest account-discovery patch is not yet loaded into the local API or browser-verified; no production deployment occurred.

## September 7 — browser-verified asset handoff; compaction loop discovered

Added an explicit critical route for positively requested paid/performance/ad campaign draft or review preparation, ahead of copy-only routing. The exact card prompt now selects Performance Marketing even without a platform name, while negative draft commands do not trigger the new rule. Added executor-level tests compiling the generated SQL: exact asset IDs retain user ownership, legacy `assetId:114` does not become a title/body search, selected sets are not truncated by a text-search limit, and version/threadId are selected. These mock the DB result boundary; they are not a real PostgreSQL isolation test. Sixty-four focused server tests and server TypeScript passed.

Reloaded the local API, signed in using the supplied QA account, opened campaign 171 in Chrome tab 942342132 and clicked the Meta card's Review this creative action. Browser and logs verified Performance Marketing/Sarah received exact asset 114 revision 1, retrieved it, and asked for platform/account/budget/destination/schedule instead of claiming it was missing. Then submitted Meta-only proposed USD 50 lifetime, traffic objective, destination aimplifylabs.com, September 8–15 UTC dates, with explicit account-choice and no-activation boundaries. No final review or provider activation was approved.

That follow-up exposed a runaway background issue: repeated compaction calls summarized the same range and deducted credits (summary versions climbed to at least 20 during this observation). Stopped the owned local API PID 72961 to end the loop. Source confirmed the context-meter UI auto-POSTed compaction again whenever the refreshed meter stayed at 100%, competing with server auto-compaction. Removed the UI auto-trigger (manual action remains); added same-user/thread in-flight coalescing and saved summary range reuse in the server compaction service. Three service regressions plus a rendered client test prove no repeated provider calls for cached ranges and no auto POSTs from repeated full-meter events. Thirty-nine focused server tests, the rendered client test, and both type checks passed. Cross-process simultaneous compaction still needs a distributed fence; current single-flight protection is per process. Context token accounting and cross-thread context-request races still need review.

Restarted local QA with the protections in session 78962. The account/draft turn was interrupted by the deliberate API pause and is not signed off. Latest work remains uncommitted and undeployed; no live ad/outreach approval was performed.

## September 7 — ICP readiness repair and exact asset lookup

The prior browser failure was reproduced by the approval transaction: a saved usable profile had a durable run at `icp_draft`. The repair records `icp_awaiting_approval` inside the approval transaction after locking and validating the tenant/thread/profile/revision/fit score, then performs the existing approval transition. A draft bound to another profile/revision is rejected; an explicitly requested missing run is not fabricated. The global transition graph is unchanged. Forty focused tests and server TypeScript passed for this approval patch.

Restarted only the verified local QA API (old PID 69955, new terminal session 92547, Redis 14, ad provider mutations disabled); health returned 200. Chrome's old QA tab had disappeared, so reopened local campaign 171 as tab 942342128 in Personal Chrome. Clicking its saved Retry control accepted ICP approval and automatically resumed the retained request with Alex, who called query_content_assets twice and returned a final message. No user restatement, ad approval, or outreach delivery occurred. This proves continuation occurred, not that the requested campaign draft succeeded.

The next failure is now browser-grounded: the expanded tool result showed query `assetId:114`, filters `{limit:1}`, and zero assets. The tool searched only title/body text and had no exact-ID input. Added shared contentAssetQuerySchema with explicit assetIds, a tightly anchored legacy ID adapter, input validation at executor entry, and version/threadId in returned assets. Tenant ownership remains mandatory in the query. This latest lookup patch still requires API reload and end-to-end verification; it is not yet a proven campaign-draft journey. The retained pipeline also chose Content Studio for performance-campaign preparation, requiring follow-up routing/handoff review.

## September 7 — content panel redesign, first pass

- Ad Copy now separates the main actions from search/platform filters, wraps controls based on the panel container, contains its details table horizontally, and uses compact preview spacing. Card actions say “Review this creative” in conversations, retaining exact saved-asset handoff; the bulk action still says “Prepare campaign review.” Google previews no longer display Like/Comment/Share. Preview CTAs are no longer fake focusable buttons. Missing destination text no longer invents a website.
- Failed or malformed Ad Copy loads show an explicit retryable error rather than “No Ad Copy Yet.” No search matches has its own clear-filters state; empty selections and failed loads cannot trigger bulk review. Grouped results now respect search.
- Added a shared container-responsive shell to Blog, Email, SMS, Social Posts, Social Messages, Images and Video. Content Studio category tiles size from the available panel rather than the viewport; content-type navigation wraps and exposes selection. Fixed the intervening ContentTabContent wrapper's missing height/min-width containment.
- Verification: 16 existing focused ad entry/handoff/contract tests passed, then the expanded rendered Ad Copy suite passed all 9 tests (including three new error/filter/preview cases). Client TypeScript passed again after the layout changes; diff whitespace check passed. Chrome loaded campaign 171 and a screenshot verified the new Ad Copy toolbar, compact previews, and review labels. Browser responsiveness was intermittent during local compilation. Individual other tabs and narrow-width layouts are NOT yet visually signed off. Nothing committed or deployed.
- Workflow evidence: restarted the owned local QA API with Redis 14 and ad provider mutations disabled. Health returned 200; Overview showed “Execution progress.” Clicking the existing ICP approval in campaign 171 failed with `Invalid conversation workflow transition: icp_draft -> agent_selection`. Automatic continuation is therefore still failing for this legacy run despite the mocked unit tests. This requires a guarded approval-readiness transition and regression coverage; do not broaden the state machine to bypass prerequisite validation. No campaign activation or outreach delivery was approved.

Updated: 2026-09-05. Branch: `v7`, initial baseline `9518c64e` plus uncommitted work. Other tasks have subsequently committed unrelated support work; this QA pass has not committed or deployed.

## Scope and limits

This is an in-progress audit, not production sign-off. The repository contains unrelated changes from other tasks; they have not been committed or deployed by this QA pass.

Browser testing uses Chrome against `http://localhost:3000`, API port 8080, a local PostgreSQL database, and isolated Redis database 14. Node.js 24.19.0 is used. Production browser access was denied by the browser policy in this task; it was not bypassed. No live ads were activated and no outreach messages were sent.

The login screenshot's local API reachability failure was reproduced during environment startup. Sign-in, authenticated navigation, and session restoration now work locally. This does not establish production availability.

Earlier login recheck on 2026-09-05: the existing local API returned HTTP 200 from `/health`. Through the local frontend proxy, CSRF bootstrap, sign-in with the supplied test account, and cookie-authenticated `/api/auth/me` all returned HTTP 200; the restored user matched the signed-in user. The temporary verified test session was logged out (HTTP 204). These were API checks, not a new browser pass. Chrome was then unavailable because the Mac was locked. No production restart or deployment was performed.

Latest continuation: both local listeners had stopped (connection refused on ports 8080 and 3000). They were restarted using the existing isolated local QA configuration, with live ad mutations and embedded media workers disabled. `/health` on 8080 and `/login` on 3000 now return HTTP 200. This is reachability evidence, not a fresh authenticated browser pass. Chrome initially returned `Debugger unattached`; the latest browser inventory no longer exposes a connected Chrome session. Production remains unverified.

## Test flows

| Journey | Test sequence | Required assertion |
| --- | --- | --- |
| Initial conversation | Sign in → create campaign → send brief → reload | One saved user message and one final assistant response; no cross-thread status |
| ICP | Website/brief → generate draft → review/edit → approve current revision | Suggestions appear only after approval; editing invalidates the old approval |
| Agent selection | Approved ICP → choose one suggested specialist | Independent choices; excluded agents are not silently hired |
| Lead configuration | Choose Marcus → review platforms/strategies → confirm strategy → generate inputs | Exact confirmed strategy; no redundant configuration approval or search execution |
| Lead execution | Review saved parameters → approve exact input revision → run → reconcile | No execution before approval; immutable input IDs; failed/partial/empty/success are distinct |
| Lead revision | Regenerate or edit → new review → click old approval | Old approval cannot authorize the new review or altered parameters |
| Lead review/outreach | Inspect results → select exact lead IDs → approve selection → draft outreach → approve delivery | Empty selection rejected; exact IDs survive campaign and sequence creation |
| Outreach delivery | Approve → queued → provider acceptance → delivery/failure callback | Queued is not sent; sent is not delivered; retries do not duplicate recipients |
| Content | Choose content agent → generate copy/image/blog/video → save → review assets | Asset IDs required; media/save failures cannot be described as creation success |
| Performance marketing | Select assets → campaign draft → review all spend fields and creative revision → approve → provider creation → activation | Separate Meta/Google states and receipts; explicit gating/partial failure |
| Existing campaigns | List → inspect analytics → request pause/stop | Read tools cause no mutation; stop requires an implemented, scoped provider action |
| Conversation UI | Stream/replay/reorder → reconnect → change thread → resize panels | One durable final bubble; spinner reflects workflow turn; tabs survive reload |

For every write journey also test double-click, stale approval, provider rejection, timeout after possible acceptance, persistence failure, and reconnect while awaiting approval. Use fake providers for destructive or spend-affecting cases.

## Browser evidence from this pass

Local campaign 178, “Aimplify AI CTO Lead Prospecting”:

1. Login and reload retained the authenticated session.
2. A brief for three CTO leads at B2B SaaS companies in Bengaluru generated ICP 132 and stopped at ICP approval.
3. ICP approval exposed a UI bug that combined independent agent choices into a single team. The repaired UI allowed choosing Marcus alone.
4. Marcus recommended LinkedIn Profile Search, strategy `linkedin`, and stopped for confirmation.
5. The first confirmation exposed a redundant configuration widget and later an incorrect fallback to company-employee extraction. That search was not approved.
6. With the repair, regeneration used the confirmed profile-search strategy directly. Saved input 113 and input-set revision 2 were recorded before the result tab opened. The input review survived API restart and browser reload.
7. Approving that exact review ran one bounded LinkedIn search. The provider returned zero items in approximately 17 seconds. The durable run ended `completed / succeeded_empty`; no lead IDs existed and no outreach handoff was offered.
8. The Leads tab exposed a separate HTTP 500: the local database was missing `leads.threads_handle` and `leads.threads_url`. Existing migration 223 was applied locally as batch 75. Its read query then succeeded. Migrations 243/244 had already been applied locally for the durable workflow work. Other pending migrations were not bulk-applied.
9. The zero-results layout and malformed execution-summary handling were corrected. A lead-list loading error now has a visible retry state instead of masquerading as zero matches.

Durable identifiers for cross-checking the local test:

- Workflow run: `8ab9e4bc-34a2-4842-8068-55303ac2c185`
- Confirmed strategy selection: `e9e0515d-74fc-4645-b5bc-c60ad90d444d`
- Reviewed input set: `ccec1b86-a156-4da1-a96f-a42b1f370a79`, revision 2, input ID 113
- Approval request: `lead-input-set:ccec1b86-a156-4da1-a96f-a42b1f370a79:2`
- Provider execution: `lead:178:113:linkedin_b2b`; `linkedin_b2b` is the internal workflow definition for the displayed `linkedin` strategy

## Repairs implemented and checked

- Lead generation returns exact durable input IDs, rejects missing persistence and empty generated schemas, and writes an immutable input review before announcing readiness.
- Run-scoped generation requires the stored strategy selection. Historical LinkedIn aliases are normalized; unknown or different workflows fail instead of falling back to another search.
- The generic tool loop does not insert a second configuration widget after durable strategy confirmation. Search execution remains a separate approval boundary.
- Input approval compares the reviewed snapshot with current records under a database transaction. Execution reads the approved snapshot, not whichever input rows are latest.
- Successful zero-match runs may transition to `completed / succeeded_empty` without claiming leads or offering outreach.
- Independent agent cards replace automatic team bundling. ICP approval says “ICP approved,” not “Starting.” Explicitly excluded agents are filtered from recommendations.
- New approval/rejection buttons carry their exact request identity across specialists. Legacy identities are recovered from the original saved message, never substituted from the latest pending thread action.
- Durable final messages seal streaming state. Delayed chunks and reconnect replay cannot replace that final response. Workflow turn IDs prevent one completed turn from blocking the next turn in the same workflow.
- Pending approval is restored from durable thread metadata after reload/reconnect. Bound lead reviews do not open an additional floating approval card.
- The results tab no longer announces “queued” solely because an approval callback returned.
- Lead execution summaries accept validated legacy maps and arrays; malformed payloads do not crash or invent success. Empty, failed, cancelled, and not-started result states have different copy. Hard-coded conversion percentages were removed from provider search cards.
- Lead-list fetch failures now show an explicit loading error and retry control.
- Email/SMS campaign status and counts now reconcile under a campaign-row lock from durable outreach jobs. Queue finalization cannot overwrite a fast worker's progress, and failures before enqueue are retained.
- Missing provider receipts and uncertain outcomes stop for review instead of claiming sent or automatically resending. Exact-ID executor tests cover immediate/default scheduling, explicit future scheduling, unavailable recipients, partial/all-failed enqueue, and persistence failure after enqueue.
- Email provider milestones now update delivery fields monotonically. Replayed/late sent callbacks cannot erase a delivery/bounce receipt; campaign delivery counts are recomputed rather than incremented.
- Verified email delivery/read webhooks return a retryable error if receipt persistence/reconciliation fails, instead of acknowledging an unsaved event.
- Outreach cards distinguish sent, delivered, queued, pre-enqueue failures, partial success, and manual review. Enqueue failures and uncertain outcomes do not expose a blind delivery-job retry.
- An independent architecture review found and led to fixes for lost enqueue acknowledgements. Queue receipts are checked against the exact persisted step-1 job IDs. Contradictions persist a visible `needs_attention` warning and disallow safe-retry claims. A periodic worker pass recovers complete exact selections and missed final worker updates; incomplete closure stalls require review rather than invented completion.
- The older outreach-message ledger now compares callback status atomically and retains first delivery/read timestamps. A late sent callback cannot regress a delivered/read bubble; inbound messages are excluded from outbound receipt updates.

## Verification

- Initial server full suite after approval/workflow repairs: **223 suites, 2,172 tests passed**. Subsequent full server run: **228 suites, 2,211 tests passed**; the opt-in PostgreSQL suite was skipped there and passed separately.
- Initial client full suite: **81 files, 543 tests passed**. A later run timed out in one WhatsApp template test; that file passed in isolation, and the full lower-concurrency rerun passed **82 files, 545 tests**.
- Server/client TypeScript and `git diff --check` passed after the delivery-order changes. The concurrent support-test hook type error was corrected by its owning task.
- Targeted tests cover immutable inputs, strategy aliases/mismatch rejection, persistence failure, exact review actions, delayed durable messages, replay ordering, approval hydration, malformed summaries, and visible lead loading failures.
- Browser evidence covers the successful-empty lead branch only. Passing unit/contract tests is not evidence that all provider journeys or production work.
- After the full-suite runs, the final recovery hardening passed **45 focused server tests**, **3 outreach dashboard rendered-component tests**, and **8 explicit local PostgreSQL tests**. The PostgreSQL tests use connection-local TEMP tables only; they verify queue-finalization ordering, tenant-scoped aggregation, delivery/bounce replay, missing receipts, cancellation, lost-acknowledgement recovery (including recovery-before-producer ordering), and durable stalled-state warnings. These tests do not contact providers or alter application rows.
- Latest targeted server rerun (including verified webhook persistence-failure responses): **39 tests passed**. Chrome's local-tab debugger connection is currently timing out; the new outreach dashboard has rendered-component coverage but its latest live-browser visual review is not yet verified.

## Remaining priorities — not fixed or signed off

| Priority | Finding | Required repair and proof |
| --- | --- | --- |
| P1 | Ad review/worker hardening is implemented but the complete publishing boundary is not signed off | Finish direct-create/manual-resume review binding, historical approval rendering, account-refresh recovery, and browser review verification |
| P1 | Worker crash after provider activation can outlive the approval validity window | Reconcile existing receipts and perform safety pause independently of authorization for fresh activation; do not blindly create or activate on recovery |
| P1 | Campaign aggregates still need complete partial-activation and stop reconciliation | Superseded failures no longer poison a successful retry; finish aggregate truthfulness when one platform remains active and another fails or is stopped |
| P1 | Cancellation has additional in-flight provider and cross-platform edges | Finish transactional per-platform stop/revocation, escaped-call reconciliation, and manual-resume credential/resource binding |
| P1 | Social/BullMQ outreach still increments campaign counters separately from the email/SMS job ledger | Reconcile social sequence receipts idempotently, preserve pre-enqueue failures, and close the worker/queue-finalization race on those channels |
| P1 | Some provider adapters return generic failure after a possibly accepted request; early webhook receipts may arrive before persistence | Preserve definitive versus uncertain transport outcomes end to end; use a durable verified webhook inbox and receipt reconciliation; finish SMS/provider-specific delivery confirmation |
| P1 | Asynchronous widget completion can update a widget without resuming its durable action/orchestrator | One idempotent completion coordinator for worker, webhook, and reaper paths; include unified publish_ads |
| P1 | Some legacy paths still rely on thread metadata rather than the durable state machine | Move prerequisite checks and final status to one authority; retain a scoped legacy adapter |
| P2 | Conversational ad stop/pause tool is absent from the performance agent registry | Implement scoped review/receipt-backed stop control and fake-provider tests |
| P2 | Inline approval may remain visible after approval through another surface | Reconcile source-message action state from the same durable approval receipt |
| P2 | Local API shutdown leaves database pools open | Close owned pools after draining requests; verify clean restart without force-terminating an idle process |
| QA | Non-empty/mixed/all-failed leads, exact recipient delivery, media/save failures, Meta+Google partial activation | Complete fake-provider end-to-end journeys and browser result/retry checks |
| QA | Narrow viewport, platform-specific outreach conversation pages, remaining tab families, thread switching under concurrent streams | Capture layout evidence and verify no overflow or cross-thread updates |

Before any production release: coordinate the shared working tree, inspect the exact diff and migration set, retain a recoverable backup, run the completed acceptance matrix, and use one serialized deployment with health and revision verification.

## Ad approval and retry hardening — latest local evidence

- Added a shared, credential-free saved-review contract. The review includes canonical money, platform allocations, provider account identity, dates, destinations, placements/policy configuration, and effective creative/source revisions. Preparation persists the draft before approval; the widget loads those saved values instead of presenting a fallback budget for an existing campaign.
- Chat publishing submits campaign/review references. The queue compares the current review before a new action and persists the approved snapshot. Existing approval receipts are resolved first, so a changed draft or disabled gate cannot rewrite a previously completed outcome on replay.
- Per-platform summaries distinguish `provider_created`, `queued`, `running`, `active`, `gated`, and partial outcomes. Terminal mixed results no longer remain queued solely because the aggregate says `partial_success`.
- Provider execution reads the approved snapshot. Fake-provider tests cover exact Meta/Google request fields, changed-budget rejection before activation, retained/discovered Google activation failure followed by safety pause, and missing/different resource approval binding.
- Creation/activation intent and completion/failure/defer/cancel writes are fenced by the current worker claim. PostgreSQL claim timestamps retain microseconds as text; stale workers cannot overwrite cancellation or a newer claim with the same worker name.
- Missing Meta create receipts block blind duplicate creation. Meta activation errors retain the original provider identity/error even if the safety pause also throws. Creation-complete evidence is persisted before activation intent.
- Campaign stop records cancellation before requiring a provider resource. No-resource responses distinguish local cancellation from confirmed provider pause; uncertain escaped requests still require reconciliation.

Verification on the current hardening changes:

- **125 focused server tests passed** across 11 suites (worker fake providers, approval receipt replay, state aggregation, review contracts, widgets, provider contracts, and ad policy).
- **8 explicit local PostgreSQL tests passed** using connection-local TEMP tables. Coverage: exact approval persistence/replay, changed-draft and gate behavior, tenant isolation, cancelled/reclaimed worker writes, and microsecond claim precision. These are real SQL tests, but not a multi-connection concurrency stress test.
- **10 focused client tests passed** across three files, including rendered saved-review loading/error/preparation behavior. No latest real-browser visual sign-off.
- Server and client TypeScript checks passed. The server check needed a 4 GB heap after its default heap was exhausted; test payload ID types were corrected. Existing full-suite totals above predate these ad changes and must not be interpreted as a full-suite result for them.
- No real ad-provider creation/activation, outreach delivery, production mutation, commit, or deployment was performed in this pass.

Subsequent aggregate repair: `updateLocalPublished` now considers the latest publish attempt per tenant/campaign/platform instead of every historical attempt. A new local PostgreSQL regression proves failed attempt A followed by successful retry B can set the campaign active while preserving A's failure receipt. Another test proves a latest pending action on the other platform still prevents an all-complete claim. The isolated PostgreSQL suite now passes **10 tests**. This does not yet prove complete cross-platform partial-activation, manual-stop, or worker-crash reconciliation; those remain open above.

Mixed-platform continuation: provider-success aggregation and the worker failure path now preserve partial activation, the active-spend indicator, first launch time, and the failed platform's error. Local PostgreSQL coverage now includes both Meta-success/Google-failure completion orders (**12 tests passed**). Both `status` and `local_status` show `partial_success`. A confirmed safety pause can clear the old active flag when no other platform remains active. Crash recovery, concurrent completion across database connections, manual stop/resume, and browser rendering still need end-to-end sign-off; the local API has not yet been restarted with these last aggregate-only edits.

## Browser approval restoration — verified locally

Chrome became available again. Authenticated campaign 178 loaded successfully. Its completed input review (message 2896) still displayed clickable “Approve & Execute” and “Edit Parameters” controls. Read-only local database inspection confirmed the original message's `pendingApproval.executionId` exactly matched the succeeded `execute_lead_workflow` approval receipt; the message lacked its own resolution metadata.

Added a read-time approval projection for paginated history and reconnect message responses. It uses the exact tenant/thread/request/tool identity from the original message or button, including the legacy message reference. It does not infer approval from later prose or the newest workflow. Rejections are distinguished from approvals, and unknown references remain unresolved. This repairs reload/history representation; live cross-surface broadcasts and older messages outside a reconnect fetch still need separate verification.

After restarting the local API (also loading the preceding ad aggregate changes), Chrome verified that the stale execution controls were replaced by an “Approved” status. The misleading “Approved · Starting” text was removed: approval acceptance is separate from execution progress. The screenshot also showed the completed zero-match result and the composer within the conversation panel at the current desktop size; narrow-layout sign-off remains open. No search was rerun and no outreach/ad provider mutation was triggered.

Verification: **18 focused server tests passed** for approval projection, action contracts, and identity binding; server TypeScript passed after correcting projection typing. The local API health check returned HTTP 200. The old API listener drained on SIGTERM, but the known pool-shutdown leak required terminating its remaining idle process before the new local process was started.

## Empty-result follow-up — verified locally

### September 7 lead-quality repair pass — unit verified, browser journeys pending

#### Instagram catalog / selection failure (local campaign 181)

A separate natural-language request targeted independent boutique hotels in Goa through Instagram posts, excluded influencers, and explicitly withheld messages. ICP approval again continued automatically to Marcus. Recommended Post Author Profiles was reasonable, but Show All Strategies returned only three rows, including invented Business Directory Scraping and Competitor Follower Analysis titles. A natural-language choice of post-author discovery then failed with an unavailable strategy ID; the recovery reply invented `ig_post_authors` and other IDs. No Instagram actor search ran.

The current lead-agent final response now renders full-catalog listings from the real tool output, preserving actual titles/descriptions and omitting invented fit percentages. Each named choice is bound to its actual catalog ID using the existing strategy-confirmation action; users need not type an internal ID. Four new presentation tests exercise the real Instagram catalog, subsequent-tool precedence, empty catalogs, and bound choice buttons. Thirty strategy/review-gate tests passed. The outcome suite now has 25 passing tests, including filtering-vs-error cases and incremental-progress ownership. Client TypeScript passed after the historical-link and outreach-lock changes. Latest server TypeScript and API startup are still in progress; the live catalog/selection repair has not yet been retested.

#### Facebook customer journey follow-up (local campaign 180)

Latest verification update: server TypeScript completed successfully after the catalog/outcome changes. The replacement local API started on port 8080 and restored WebSocket connections; these changes are now loaded for the next browser retry. The catalog/selection repair still requires live verification.

The local UI eventually hydrated and Chrome direct controls recovered. A native-input attempt created campaign 179 with a mismatched traveller request; that profile was not approved and is not counted as the intended test. Subsequent messages used direct field entry and a separate visible verification before Send. Moved testing into a dedicated QA tab after the shared tab was navigated away.

Campaign 180 used a natural request for luxury hotel/resort properties around Hyderabad active on Facebook, explicitly research-only. The generated ICP matched the business/location/channel. Approving it automatically continued to Marcus and strategy selection. The customer then requested simpler hotel and resort searches. This reproduced a deterministic defect: successful generated queries were overwritten by the fallback-ICP mapper, collapsing both searches into the same query and repeating Hyderabad. The saved location_uid was also a city name. Successful input generation now preserves distinct queries; optional location IDs are omitted unless explicitly supplied; fallback geography is not appended twice. After the local API loaded the change, the browser verified distinct saved `luxury hotels Hyderabad` and `luxury resorts Hyderabad` queries, no location UID, and an overall 20-lead cap.

The reviewed Facebook Post Author Profiles batch ran for 76.8 seconds across both searches. The UI showed one saved record, ClickHotelShamshabadHyderabad. Detail inspection showed a Hyderabad property address, a supplied reservation email and phone, a genuine facebook.com profile link, and a bio describing an affordable luxury hotel. This establishes a hotel business and source-provided contact evidence, not an independently verified five-star classification or a named general manager. No lead-review/outreach approval or contact was performed.

The journey exposed two additional defects: incremental quality rejections prematurely set the platform to error/100%, and quality filtering made the final summary say partial completion with zero failed workflows. The current source separates actual provider/database errors from ICP exclusions and leaves incremental platform saves running until final workflow completion. These latest outcome changes await API reload and a new live run. The detail sheet also briefly exposed Start Outreach before chat-state projection caught up; its lock now also considers observed workflow progress and refreshes unapproved review state. That latest UI change needs live verification.

Display-side social URL validation now also hides historical mislabeled links without modifying stored records. Eight focused client tests passed, including rendered old-invalid/new-valid Facebook links. Fifty-three server constraint/executor tests passed after the query fix; sixty-one provider/quality/executor tests passed before the final added outcome regressions. The earlier server TypeScript check passed for query changes; latest outcome checks are still in progress. Instagram (multiple workflows), Twitter, JustDial, Google Maps, and a fresh natural-language LinkedIn journey remain untested in this pass. Facebook outcome-fix retesting and narrow empty-state layout verification also remain open.

Added a post-mapping contact normalizer to prevent generic provider URLs (notably Google Maps) from being stored as Facebook links. Social links require an actual allowed hostname; spoofed suffixes and credentials are rejected. Supplied email aliases and arrays are recovered without inventing addresses or claiming verification. This affects newly mapped records; historical bad links still need display handling or a separately scoped data repair.

Hotel/resort business searches now reject obvious institutes, colleges, consultants, suppliers and booking agencies rather than accepting any hotel keyword. Explicit luxury targeting requires descriptive or hotel-star evidence; a consumer review score of five is not hotel-star evidence. This is a conservative text gate, not proof of every ICP attribute, and existing LinkedIn provider-filter behavior is unchanged.

Zero-match execution wording no longer says leads were generated successfully. Empty-state rendering recognizes canonical terminal statuses. The empty card stacks its copy and actions instead of using the viewport's XL breakpoint to squeeze a narrow result panel. Browser layout verification remains pending.

Verification: 31 server quality/contact tests and 35 nearby executor/save-receipt tests passed; 14 client summary tests passed. Both server and client TypeScript checks passed; diff whitespace check passed. These counts do not constitute all-platform execution evidence.

The local frontend stopped responding to HTTP. Its exact orphan QA parent (1138) was terminated and restarted; the route compiled and returned HTTP 200. The local API (7530) was drained and replaced with the same local-DB/Redis-14 configuration and ad-provider mutations disabled, loading these changes; health returned HTTP 200. The old API retained its known idle shutdown process and was terminated after draining. Chrome extension control repeatedly timed out; native Chrome accessibility works, but the page currently renders a blank shell rather than a usable chat. No new Facebook, Instagram, Twitter, JustDial, Google Maps or LinkedIn customer conversation has been executed in this repair pass. All six platforms, multiple Instagram workflows, visual narrow-panel verification, and persisted provider-result review remain open.

Chrome campaign 178 reproduced a false positive on a read-only follow-up: Marcus claimed persisted leads existed and requested their approval, despite the recorded `succeeded_empty` result. The agent prompt incorrectly equated `leadWorkflowExecuted` with generated leads. It now distinguishes execution from verified current lead IDs, disallows empty-set approval/outreach claims, and avoids treating the current selection as a workspace-wide count.

After loading the fix into the local API, the same conversation (including the earlier incorrect reply) correctly answered that the previous execution found zero matches, there was no set to approve, and the next options were refining criteria or importing leads. The browser showed one new user message and one assistant reply, with no new tool execution cards. No search, outreach, or ad action was requested. Historical incorrect replies were preserved, not rewritten.

Verification: **19 focused server tests passed** across lead-review approval and message-approval projection, including empty-result and exact-current-ID prompt regressions. This is local Chrome evidence for the empty-result follow-up, not production or full-workflow sign-off.

The overview scraping description now explicitly labels the percentage as **Execution progress**, rather than appending an ambiguous percentage to the lead count. This final wording-only change has not yet been reloaded into the local API or browser-verified.

## Overview isolation and loading recovery

Source inspection found that the Overview tab accepted every asynchronous response, retained old campaign state during a thread switch, and only logged refresh failures. It now clears state on scope changes, invalidates requests on cleanup, accepts only the latest request and exact returned thread ID, and offers an accessible retry control. A same-campaign refresh failure preserves the last loaded view with an explicit stale-data warning; it does not pretend the data is current or empty. The recovery UI retains the existing semantic colors and typography.

Four rendered regressions cover delayed previous-thread responses, wrong-thread payload rejection plus successful retry, overlapping same-thread refreshes, and visible refresh failure with retained data. **11 tests passed across three client files**, including nearby message-surface and lead-load tests; client TypeScript and `git diff --check` passed. Attempted Chrome verification could not reuse the previous QA tab because the browser reported that tab ID no longer exists. This repair has component-level evidence, not a fresh browser sign-off or production deployment.

September 7 continuation: Overview now scopes refresh events to the current thread, prefers the versioned envelope identity over legacy payload fields, ignores unscoped events, and reloads durable state after WebSocket connection restoration. Tests also cover event coalescing, contradictory envelope/payload identities, reconnect, and timer/subscription cleanup on unmount (**6 overview tests passed**). Local API health returned HTTP 200. The existing frontend listener remained alive but timed out on an HTTP probe; Chrome navigation subsequently reached the conversation title and skip link only, without campaign content. Browser workflow verification remains incomplete; no shared process was restarted or production action performed.

### Local browser recovery and tab verification

### Content Studio conversational publish entry

Source inspection confirmed ad-card Publish opened the standalone legacy modal even when a conversation callback was available. AdCopyTab now uses that callback to request saved campaign review preparation with exact selected asset IDs and displayed revisions (unknown revisions remain unknown). Card/list actions preserve one selected asset; the toolbar uses the visible filtered selection. Empty, unsaved, duplicate, or unsafe-integer IDs are rejected before dispatch. The preparation request expressly withholds publication/activation/spend and asks for missing configuration and verification of current saved revisions. This request is not an approval receipt; the saved-review server boundary must still enforce approval.

Ten focused client tests passed across handoff payload validation and existing publishing entry contracts. These are helper/source-contract tests, not a fresh browser or provider journey. The standalone content-library modal remains a separate legacy publishing path requiring unification; this change does not claim to fix that path or the complete asset-to-active acceptance case.

Rendered entry-point follow-up: real AdCopyTab/AdCopyCard tests (with modal boundaries mocked) verified grid-card and details-row selection, visible toolbar filtering, no legacy modal opening or POST during conversational dispatch, and retention of the standalone entry. The tests exposed an upstream mapper that invented revision 1 for records without a revision; removed that fallback for loaded ad state. Missing revisions now reach conversational preparation as unknown. **14 tests passed across three files**. This remains preparation-boundary evidence, not orchestrator/provider execution evidence.

Ad selection isolation follow-up: AdCopyTab now invalidates asynchronous asset loads on scope change/unmount, accepts only the latest request, hides assets whose loaded scope differs from the current thread/grouping, clears open selections/modals on a scope change, and prevents preparation while the selection is loading. Its content-update subscription now captures the current thread rather than the initial thread. Rendered regressions prove a delayed old-thread response cannot replace current assets or enter the handoff, current-thread updates query the current endpoint, and old cards disappear while the destination loads. **16 focused tests passed**, plus client TypeScript and diff checks. Media-generation callbacks and other content-tab families still need equivalent race coverage; this is not a full-content concurrency sign-off.

### Live ad-card handoff and ICP prerequisite

Chrome campaign 171, single Meta card: clicking Publish sent exactly asset 114/revision 1 as a review-preparation request, explicitly withholding activation/spend. No legacy modal opened. The workflow returned to Coordinator with Improve ICP / Approve ICP controls rather than the expected campaign review. Read-only local SQL established that this prerequisite was legitimate: ICP 128 is unapproved, revision 1, approved_revision NULL, fit_score 81. The approval gate must not be bypassed merely because legacy content exists.

The confusing behavior was the handoff announcing website analysis and the prerequisite prompt instructing generation despite an existing usable profile. Updated the two specialist-to-ICP handoffs to explain existing-profile approval and retained pending work; updated the prerequisite prompt to reuse a usable saved ICP and request approval rather than crawl/regenerate solely for missing approval. A regression preserves the exact pending ad request and approval gate. **17 router tests passed**, server TypeScript and diff checks passed. These latest server wording/prompt changes are not yet reloaded into the running API. No ICP approval or provider activation was performed, so automatic post-approval continuation remains to be browser-verified.

ICP approval continuation inspection: the action handler currently always emits agent-selection buttons on first approval, including when a specialist request was already retained. Automatic continuation of that explicitly requested specialist remains an implementation gap, not merely missing browser evidence. A related replay defect was repaired first: approveIcpRevision now resolves a matching tenant/thread/run-scoped successful receipt before any write and returns the existing run unchanged. The controller returns that recorded status/stage on replay instead of emitting another selection message. Changed revisions still fail before receipt lookup; an unavailable recorded run is not fabricated. **27 focused server tests passed** across replay, state-machine, and router suites. Replay tests mock the transaction boundary; real SQL concurrency and live approval continuation are still unverified. Latest server edits are not loaded into the API yet.

Initial automatic ICP continuation implementation: the handler now attempts the retained lead/content/performance request after durable approval, under the thread mutex and a uniquely inserted workflow action. It requires the current run/profile/revision and an ICP-first pending pipeline, preserves separate execution approvals, and saves only an assistant response (no synthetic user bubble). Routing consumes an internal one-use hint only for the exact approved revision and selected specialist. A repeat approval can recover the approval-before-continuation gap; an existing failed continuation is not blindly rerun. Generic ICP approvals still offer agent selection, and outreach is not automatically resumed by this path. **28 focused tests passed** covering router eligibility, approval replay, and nearby action contracts. Full continuation orchestration, crash recovery, stage reconciliation, API reload, and live browser approval remain unverified; do not treat this initial implementation as signed off.

Continuation orchestration tests now exercise the actual controller continuation with mocked provider/persistence boundaries: exact request and route, assistant-only persistence, duplicate claim suppression, mismatched run/unapproved profile rejection, thrown and returned failures, and mutex release. Added run-stage reconciliation so a finished continuation does not remain generically running: review/input readiness is recorded, or failure becomes needs_attention. The transactional transition helper accepts an optional source-stage guard, preserving more-specific tool transitions or cancellation under its row lock. **35 tests passed across four suites**. Transaction tests use mocks, not real concurrent SQL, and the new API path is still awaiting restart/browser approval verification. This is stronger orchestration evidence but not the full acceptance journey.

Confirmed the stalled frontend was this task's orphaned Next QA process (parent 18932, child 18935; original terminal handle missing). Terminated the exact parent with SIGTERM and verified both processes and the listener exited. Restarted the same local-only frontend command, leaving API/production untouched. Compilation completed and the campaign route returned HTTP 200. Removed only Next's automatic QA output-directory additions to tsconfig.

Chrome then fully loaded authenticated campaign 178: message history, the resolved Approved control, zero-match follow-up, composer, and Overview. Switching through the sidebar to campaign 171 cleared the old content, showed saved-workspace loading, then restored that campaign's own history and five result tabs. The Leads tab displayed two saved records; Content Studio displayed three saved ad cards and generated copy. A desktop screenshot showed the composer, campaign review, and result panel contained within their columns. This is a normal thread-switch and saved-tab loading check, not concurrent-stream, narrow-screen, fresh creation, or live publishing proof. The existing campaign review correctly disabled Confirm and run until saved review preparation; no approval, publishing, search, or outreach action was triggered. The backend wording-only progress-label edit remains unloaded.
