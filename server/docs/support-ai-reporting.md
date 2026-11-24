# Support AI reporting and answer quality

Support AI now provides shared navigation for Chat, Reports, Answer quality, Embed, and Widget settings. Report and quality queries are cached by authenticated user and active business profile, pinned to that profile in API headers, and canceled on scope changes. Navigation remembers each view's filters and selected conversation for the same user and business in the current browser session.

## Reports

`GET /api/support/ai/report` supports inclusive UTC `from`/`to` dates, `source=all|widget|internal`, `teamId`, `assistantId`, literal `sessionSearch` and `leadSearch`, independent `sessionPage`/`leadPage`, and `limit` (default 25, maximum 100). Search queries are limited to 200 characters. Totals and performance metrics cover the filtered dataset independently of search and pagination. Conversation search includes persisted message content. Captured leads use their creation dates and exclude deleted records; when a conversation filter is applied, leads must be linked to a matching conversation.

Metrics describe recorded events: time from a user message to the next completed first assistant response, helpful staff ratings, helpful customer conversation ratings, human handoff or linked ticket, and explicit converted lead status. Missing samples display as unavailable. No resolution rate is inferred. The UI includes each definition and sample counts.

Conversation detail loads on demand. Chat and reports share formatted content, evidence, recorded provenance and delivery state, attachment handling, copy reply, and plain-text transcript export. Reports link captured leads through the CRM's existing virtual lead route and show recorded support ticket and human handoff state.

## Answer quality

`PUT /api/support/ai/messages/:messageId/feedback` saves an owner-authorized helpful or needs-review rating, optional reason and notes, review state, authenticated actor, and timestamp. Notes follow existing privacy redaction. The atomic metadata update preserves other message metadata.

`GET /api/support/ai/quality` uses the same date/source/team/assistant scope plus literal search, `status=open|reviewed|all`, page, and limit. It lists explicitly rated assistant answers with the preceding question, recorded evidence, and review notes. Staff can review, reopen, or update a flag and navigate to the existing knowledge base to improve supporting content. It does not automatically infer knowledge gaps from confidence values.

## Chat and public widget

Chat history is paginated, searches the complete persisted history, and debounces input. Chat supports rename and archive, retry with the same request identifier, upload count/type/size checks before posting, upload progress, and retained results during refresh. Assistant selection keeps the current assistant visible and groups draft/published configuration under the testing control.

See [support-widget-settings.md](support-widget-settings.md) for widget configuration, key rotation/revocation, installation telemetry, credentialed feedback, reconnection, scrolling, and polling contracts. Only the public widget iframe has external framing enabled; dashboard and other routes retain their framing protection. The anonymous installation signal uses a narrow cookie-free CORS path, and new public write endpoints have explicit token/session verification and rate limiting.

## Deployment prerequisites and verification

Apply custom-runner migrations `320_support_widget_settings.js` and `321_support_reporting_indexes.js` before serving the new backend. Migration 320 persists team appearance and installation data; migration 321 adds reporting indexes. The implementation was checked in disposable local PostgreSQL schemas, including repeatable up/down/up migration runs. No shared or live database was changed by this work.

Focused tests cover report filters, complete history search, independent totals and pages, tenant isolation, actor attribution, preservation of metadata, transcript formatting, upload rejection, retries, URL restoration, feedback review, widget scope changes, connection recovery, expiry, scrolling, and narrow CORS/CSRF/header behavior. Browser fixtures mock API data and do not validate live installation or external provider delivery.
