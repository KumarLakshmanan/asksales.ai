# Gmail connection fixes and regression evidence — 2026-10-13

Branch: `fix/gmail-oauth-connection-v8`. Fetched `origin/v8` before creating the branch; base is `2ff4d6250b6a2fdb0999c22c14a900e3564725fc`, replacing saved ref `09fe888ec8bdd3fa12ccee0e047cd1d876306222`. The parent owns combined review and integration into v8. An independent GPT 6.1 Sol agent with xhigh reasoning reviewed server security and implemented the focused client changes.

No AGENTS.md or applicable .agents/skills files were present in the checkout or supplied workspace instruction directories. Existing source changes and historical QA files were preserved. All writes in tests target in-memory mocks; browser APIs and Google destinations are intercepted locally. The isolated Next preview contains copied source and no environment files. No production OAuth initiation, grant, credential/provider setting, campaign, email, follow-up, database, or deployment operation was performed.

## Production diagnosis boundary

The parent observed dev Email integrations showing Gmail connected, reply sync active and one ready sender at 04:46 UTC. Production's connection error remains user-reported: its URL/configuration were not confirmed, and no production failure was reproduced. The following defects are proven from code/contracts or synthetic regressions; they are not proof of which defect caused that production report.

## Root causes and changes

- Gmail state had an unused random nonce and Redis tenant binding that were never consumed. Verification accepted extra state segments and future timestamps. State now binds the actor, business, browser session and exact OAuth client/redirect contract; cookie/JWT expiry/revocation/account/password checks precede atomic Redis consumption. A changed or revoked manager cannot finish consent.
- OAuth callback and refresh selected mutable current client settings. State detects changes before exchange; new credentials remember issuing client ID and config source. Reconnect preserves an old refresh token only for the same mailbox and proven issuing client. A new user config cannot take over refreshing a grant issued by the shared app. Inbox cursor metadata is merged rather than replaced.
- The shared URL helper preferred NGROK_URL even in production; frontend URL had no valid default or validation. Gmail's own contract now requires public HTTPS in production, excludes development tunnel defaults, validates callback paths, and preserves exact explicit redirects, including the legacy alias. Missing return/configuration contracts fail before initiation.
- Host-only browser cookies can be set on the frontend when its Next API proxy starts OAuth, while the registered callback is on the API hostname. A single fixed-destination handoff to the trusted frontend API proxy verifies those cookies before exchange; the original Google redirect URI remains the token exchange contract. Direct API initiation works without a handoff; a marked second hop cannot loop.
- Manual POST refresh omitted credential ID, causing ChannelCredentialModel.update to update every Gmail account belonging to the owner. The baseline regression reproduces that exact broad write. All token refresh and revocation updates now use the captured mailbox ID. Status refresh/re-read is also pinned to that mailbox; failed/empty refreshes cannot overwrite stored tokens.
- Ordinary business members could reach Gmail config, refresh, watch and disconnect mutations; the permission guard now requires owner/billing admin, including the auth-url alias.
- The client could navigate after a delayed authorize response belonging to a previous business/account and trusted arbitrary returned URLs. Initiation now coalesces, times out, aborts, checks current account/business and accepts only Google's HTTPS v2 authorization endpoint.
- Callback errors echoed provider text, and success claimed reply sync was active even when optional watch setup failed. Stable safe result codes support retry, the verified original business is restored before reads, and duplicate effect/remount notifications are prevented. Token scope capabilities are checked before saving a sender; actual granted scopes are retained unchanged.

## Final validation

| Check | Result | Retained evidence |
| --- | --- | --- |
| Server unit/HTTP integration regressions | 88 tests / 9 suites passed | [server log](../qa/gmail-oauth-connection-2026-10-13/server-logs/server-regressions-complete.log.gz) |
| Client unit regressions | 48 tests / 4 suites passed | [client log](../qa/gmail-oauth-connection-2026-10-13/client-logs/client-unit-complete.log.gz) |
| Mocked browser, 1440×900 and 390×844 | 8/8 passed | [browser log](../qa/gmail-oauth-connection-2026-10-13/client-logs/browser-complete.log.gz), [screenshots](../qa/gmail-oauth-connection-2026-10-13/browser-final) |
| Full server and client types | Passed | [server](../qa/gmail-oauth-connection-2026-10-13/server-logs/server-types-complete.log.gz), [client](../qa/gmail-oauth-connection-2026-10-13/client-logs/client-typecheck-complete.log.gz) |
| Final changed server paths lint | Passed, 0 errors/warnings | [log](../qa/gmail-oauth-connection-2026-10-13/server-logs/server-lint-final-clean.log.gz) |
| Full server lint | Passed, 0 errors, 2001 existing warnings | [log](../qa/gmail-oauth-connection-2026-10-13/server-logs/server-lint-final.log.gz) |
| Full client lint (`--quiet`) | Passed, 0 errors; warnings suppressed | [log](../qa/gmail-oauth-connection-2026-10-13/client-logs/client-lint-complete.log.gz) |

Coverage includes denied/canceled consent, malformed/expired/future/reused/concurrent state, callback provider/exchange errors, wrong browser/account, revoked/expired/password-changed session, removed manager permission, stale cookie plus current Bearer, configuration changes, legacy redirect alias, direct/proxy callback topology, partial consent, missing ongoing grant, same-mailbox reconnect, optional watch/display failure, mailbox ownership conflict, client-bound refresh, transient/revoked/empty refresh responses and successful mocked connection.

Failure history is retained honestly. The unmodified latest-v8 baseline fails the manual-refresh isolation assertion because it invokes the broad owner/platform update. Initial pnpm 11 attempted an automatic install outside its writable cache; npm/local installed executables avoided that path. Intermediate type/lint failures in new test typing/unused catch were fixed. Browser attempts exposed duplicate toasts and ambiguous test locators; separate logs and available trace/screenshots are retained, along with preview startup/route and Chromium-download failures. Raw logs are losslessly gzip-compressed. Historical tracked QA/docs files were not modified or deleted. [Evidence hashes and final source hashes](../qa/gmail-oauth-connection-2026-10-13/evidence-manifest.json) allow exact verification.

## Operator dependencies and remaining blockers

These are contracts to inspect separately on the confirmed production deployment; no missing value is asserted from dev observations.

| Sanitized configuration name | Required operator verification/action |
| --- | --- |
| `gmail_oauth.apiKey`, `gmail_oauth.apiSecret`; optional business `gmail_config` | Confirm production's active client belongs to its intended Google Web application; inspect presence/identity without exposing values. |
| `GMAIL_REDIRECT_URI` → selected config `redirectUri` → `APP_URL`/`API_URL` | Confirm the exact resolved HTTPS callback, including path/slash, is registered for that same client in Google. Preserve legacy alias if registered. Do not use dev's registration as production evidence. |
| `CLIENT_URL`/`FRONTEND_URL`; frontend `BACKEND_URL`/`NEXT_PUBLIC_API_URL` | Confirm the trusted production frontend and callback API proxy reach this backend; verify cookies and any first-hop handoff on the real hosting topology. |
| `OAUTH_STATE_SECRET`/`JWT_SECRET`, session cookie; `REDIS_*` | Confirm consistent signing/session configuration on callback replicas and shared reachable Redis with GET/SET/DEL/EVAL permissions. |
| `SECRETS_ENCRYPTION_KEY`/`JWT_SECRET`, `SECRETS_ENCRYPTION_KEY_ID` | Confirm current production can decrypt its existing credentials and encrypt new connections; do not rotate keys as part of verification. |
| Google project/API/consent app | Confirm Gmail API is enabled, requested scopes/app verification and consent audience policies authorize the intended production users. No grants were created to test this. |
| `gmail_oauth.config.pubsubTopic` / legacy `topicName` | Confirm notification topic/project permissions separately if reply sync is required. Watch failure does not invalidate a successful sender connection. |

Legacy credentials without issuing-client metadata cannot prove their original OAuth client; a separately authorized reconnect establishes that identity. In-flight old-format Gmail states must restart after this code change. Live production consent/exchange/encryption/refresh/watch remains unverified and requires a separate authorized operator session after code integration/deployment.

Coordination with delivery task: this branch changes no delivery-status logic. The callback saves actual `grantedScopes`, issuing-client metadata in sessionData, and the exact credential ID. Google's documented send scopes include gmail.modify/gmail.compose/full-mail alternatives; ProviderBindingService currently checks only gmail.send. The delivery owner should reconcile that capability policy without fabricating scopes. See [Google send contract](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send), [OAuth redirect/offline consent contract](https://developers.google.com/identity/protocols/oauth2/web-server), and [scope verification guidance](https://developers.google.com/workspace/gmail/api/auth/scopes).
