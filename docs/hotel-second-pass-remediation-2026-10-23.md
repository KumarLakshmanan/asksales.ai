# Hotel second-pass corrections — 2026-10-23

## Audited and reviewed source

The second-pass audit was executed on `438b4126d43b0f8f923e4fed6bae1e9b8c4dd37b` and reconciled against `24c66b9cac2936ccbd119e39cf78b5b83b1e6212`. Remediation began from that exact second base. Approved remote v8 subsequently advanced to `e92ea9cca3eca7d025128f037877a91ae0148a60`; that base was merged locally and the changed Header, multipart-context and public-response boundaries were exercised together with these corrections.

The verified source/test candidate is `7c6a2670744bc134616ab23a8f6ccba3d5b938a6`. Production runtime files were built at `b4a471cc7d3a06a39f2c4e885ab7a9c3720d1b6d`; the subsequent commit only strengthens a test mock's type annotation. The final 247-check server run includes that exact annotated test. The publication tip, all file hashes, ancestry and bundle checksum are recorded in the accompanying handoff manifest.

Original inventory `7949ee24edf8df2c0e5cf6f2ea3b14aa0ea4bb7f` and financial handoff `9894d7fa2679abd4d39d34d6b5e957bd7ed7c6e3` are inherited from v8. They were not recreated. The initial independent second-pass inventory correction is `0b60a3f6599bdbd06a94092c8cf40b4831407c71`. Integration's fixture-lint blocker was corrected separately by `1fd024345960ba38a353fa40a97c528c64797f93` (parent `756de0f05a637b6bd70dcb9bc7e029872e50fd28`), preserving every runtime assertion and boundary guard.

## Per-finding disposition

| Finding | Status | Failing-before evidence and accepted behavior |
|---|---|---|
| H2-01, P1: free rooms submitted as total | Fixed | Price-only edit reduced total 5/free 4 to total 4/free 3; cancellation restored only 4. The editor now starts from total capacity. Client regression, real browser/HTTP/PostgreSQL and inventory regressions preserve 5/4, then restore 5/5. Existing reservation accounting and locks remain authoritative. |
| H2-03, P2: keyboard, names and focus | Fixed | Calendar cells were non-focusable DIVs and icon actions unnamed. Booking-details Escape left focus on BODY at 768/390px. Cells are named buttons; fields/actions include room/date context; Escape cancels and restores focus. All three booking dialogs restore their opener, with a surviving row-view fallback after mutation. Real checks cover 1440/768/390px, normal zoom. |
| H2-04, P2: invisible unfinished setup | Fixed | Reminder persistence failure left confirmed inventory with an unset completion marker and no operator action. A small public status now distinguishes pending, in-progress, complete and review-required setup. The explicit retry reuses existing durable orchestration. Actual reminder persistence, foreign-business denial, uncertain-alert preservation, financial immutability and rendered retry are tested. |
| COV2-02: late Save overwrites newer edits | Fixed | Saving A followed by editing B previously replaced B with readback. Submitted revisions, request sequence and component lifetime now protect B. Unknown save outcomes retain the draft and do not automatically retry. A response after unmount cannot launch readback or a toast. Browser payment mutations are explicitly mocked. |
| COV2-03: tab keyboard behavior | Fixed | ArrowRight on Payments left focus unchanged. Arrows now activate/wrap; Home/End work; there is one tab stop and associated panel IDs. Component and desktop/mobile browser checks pass. |
| D2-03: multi-property import selection | Fixed | No destination was submitted; the strict server rejects ambiguous imports. Scoped property choices now require an explicit selection when multiple properties exist, and multipart requests contain hotelId. Real upload changes only the selected second property's room inventory. Data's import implementation is untouched. |
| D2-04: row diagnostics | Fixed | Structured row errors appeared only as transient generic feedback. A persistent diagnostic includes workbook, destination, row and optional field. Rejected and unknown outcomes have distinct instructions. Actual row-3 rejection rolls back both nights; a corrected upload preserves reservations and clears the diagnostic. |
| Coverage P3: URL feedback mismatch | Fixed | Browser accepted localhost-dot, CGNAT, documentation IPv4 and mapped loopback IPv6 while the server rejected them. Browser feedback now matches the existing syntax policy; 29 parity cases cover reserved/public forms and signed query strings. Server DNS/address enforcement is unchanged. Four rendered cases make zero settings submissions. This was not a security bypass. |
| Coverage: member payment form | Fixed | Ordinary members could edit a form whose writes the server denies. The active business role now makes the form read-only for members/unknown authority; save and upload handlers also guard submission. Owner and billing-admin editing remain available. Server authority is unchanged. |
| H2-02: hidden availability errors | Withdrawn | The existing error alert, Retry action and inert calendar already worked at the audited base. The prior review missed the guard. It was not re-fixed. |
| Fixture unused bindings / regression typing | Fixed | Unused copied fixture helpers were removed without weakening lint or assertions. Unsupported RTL role options and browser geometry types were corrected. The new recovery mock is explicitly typed. |

Historical before/after logs remain retained. Preliminary selector/readiness failures are diagnostic setup evidence, not additional product defects or passes. The final selected runs have no failed or skipped tests.

## Confirmation setup contract

`POST /api/hotel/bookings/:id/recovery` uses existing authentication/business scopes. `businessOwnerUserId` preserves actor identity, and the service explicitly matches owner and business profile when reading the booking. Non-confirmed bookings reject recovery; foreign businesses receive no booking state.

The route calls the existing leased orchestration only when retry is eligible. It does not invoke capture/refund accounting or the controller's guest-confirmation sender. Database-clock claims, completed local steps, notification receipt uniqueness and the started/returned/uncertain alert states are retained. An active claim is reported in progress. Uncertain alerts remain held for review; local scheduling recovery never implies that customer delivery should repeat.

Public DTOs omit claim tokens and arbitrary metadata. “Setup complete” means recorded setup steps finished and the alert helper returned; it is not proof of provider/customer delivery. A setup-status read failure after a successful booking confirmation returns a confirmed reservation with review-required setup instead of misreporting the booking mutation as failed.

The missing operator affordance is corrected. Existence or behavior of a separate background recovery mechanism remains unverified; no assumption about its absence was needed.

## Ownership and dependencies

- Hotel changes only its UI, booking orchestration/controllers and tests. In `server/routes.ts`, the sole outgoing change is the authenticated Hotel recovery route.
- Analytics transaction API `recordPaymentEvidence(evidence, tx?)` comes from `788810d0f1ea2cdb823d426a930b64203305e6ff` and correction `e08db4c4e4a006a58aad1cd29eddf5863dd36cf6`, already inherited. No outgoing SalesEvidence changes.
- Followups' rejecting `scheduleBookingReminders(...): Promise<void>` contract was supplied by `b75f8142a20daeda543452237b2b1cf2c7291ff2`, carried by `265f5fdc0d56e5890073c3cebf092b9fedfdc77e`. The integrated reminder-delivery implementation is reused without a shared helper edit.
- Data retains strict workbook/property/room validation, `(userId,132)` locking, confirmed/unreleased-pending occupancy and transactional workbook rollback. Neither `hotelImportController` nor its parsing helper is changed here.
- Integrated `responseWrapper` and `preserveAsyncContext` are reused from reviewed v8. The new browser fixture mounts both actual middleware boundaries.
- No migration or dependency/lockfile change is required. Reserved migrations 410–419 remain unused. The disposable database applied the existing 331 migrations.
- Incoming approved v8 history is ancestry, not outgoing Hotel work. Insights' publication hold was not used or bypassed; the outgoing scope excludes Insights implementations.

## Verification

- Final server selection: **247 passed, 18 suites, zero failures/skips** on the reviewed combined source.
- Hotel client selection: **59 passed, 8 suites, zero failures/skips**. Hotel client source/tests are byte-identical across the subsequent approved-base merge.
- Production client build, API bundle and worker bundle pass. Explicit final client typecheck passes.
- Full server typecheck reports only TS2322:201 and TS2352:222 in unchanged `tests/settings.test.ts`, blob `53f712f8c3f41c7e4009655054c10d52659560fa`. Final scoped server typecheck excludes only that baseline file, in addition to normal package exclusions, and passes.
- Changed client lint: zero errors/warnings. Scoped server lint: zero errors and eight existing warnings. Whitespace checks pass.
- Eleven browser test cases are included: the two existing lifecycle/inventory cases plus nine new cases. Across them, actual viewport widths are 1440, 768 and 390, device scale and visual zoom 1. Existing stale approval, cancellation, reload, stock/rate persistence and new recovery/import/keyboard journeys pass. No claimed document overflow or page exceptions in checked journeys.
- New Hotel browser requests cross the production-built Next proxy into mounted Express controllers, actual public response/context middleware and scoped PostgreSQL. File uploads use real Multer/XLSX parsing. Redis/BullMQ expiry behavior is exercised by the lifecycle selection.

Selected server command: `NODE_OPTIONS=--experimental-vm-modules node node_modules/jest/bin/jest.js --runInBand --silent --runTestsByPath ...` with `HOTEL_LOCAL_QA=1`, `HOTEL_BROWSER_QA=1`, `HOTEL_INVENTORY_BROWSER_QA=1`, `HOTEL_CURRENCY_LOCAL_QA=1`, explicit disposable DB/Redis settings and a cleared environment. Exact file selections, build/type/lint commands and results are in the portable manifest/evidence packet.

Counts combine integration and mocked unit/contract tests. They are not counts of fully authenticated production E2E journeys.

## Remaining queue and decisions

| Item | Disposition / remaining gate |
|---|---|
| Shared occupancy-query consolidation | Decision hold for joint Data/Hotel review. Similar calculations belong to different locked transaction workflows; no confirmed defect requires moving their boundaries. Existing locks and regression coverage are retained. |
| Negotiation versus booking-time validation | Resolved as intentional independent authority checks. Booking must still reject stale prices even after negotiation validates a floor. |
| Optional mobile booking cards | Design decision hold. Current bounded horizontal tables pass document-overflow checks; a different mobile presentation is not necessary to correct the reproduced defects. |
| Receipt-free/complimentary booking semantics | Explicit financial policy hold; unchanged. |
| Booked value versus received-revenue terminology | Explicit product/accounting terminology hold. |
| Late/mismatched capture reconciliation | Explicit financial-action policy hold; no real payment/refund action performed. |
| Spreadsheet dates | Earlier permissive-parser concern is superseded by Data's integrated strict validation; current import checks pass. |
| Spreadsheet total rooms used as new-room guest capacity | Occupancy/product policy hold; no capacity interpretation invented. |
| Static negotiation fallback | Existing product-policy question; authoritative booking-time guards remain tested. |
| hotel_follow_ups lifecycle | Product/Followups decision hold; no parallel reminder product was created. |
| Full authenticated Hotel/CRM/provider path | Unrun gate: real owner/member/revoked/archived-session and billing middleware journeys, actual lead-to-CRM materialization, provider/customer delivery and settlement. |
| Background workers/object storage | Production bootstrap/cron and actual object upload/signing/cleanup remain unrun. Local expiry harness is distinct evidence. |
| CI | Prior push CI failure causes remain unknown; no green CI or deployment claim. |

Providers, alerts, storage/RAG/KB and app-shell/auth identity are mocked or disabled. The separate recovery suite uses actual reminder persistence; the browser recovery case intentionally injects a scheduling failure. Payment-settings browser writes are mocked and the URL/member cases submit none. No saved production DSN, real accounts/customer data, paid APIs, sends, charges/refunds, credential/security settings, deployments or Page writes were used. Only scoped handoff publication is performed; v8 integration remains with the original integration owner.
