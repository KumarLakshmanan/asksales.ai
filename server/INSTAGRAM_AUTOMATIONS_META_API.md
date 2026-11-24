# Instagram automation API mapping

Checked against Meta's developer documentation and the connected Meta developer apps on 2 October 2026.

## Automation catalog

The landing page presents Conversation starters, Main menu, Comment to DM, Public comment reply, and a Follow to unlock preset. Setup buttons open account-bound editor URLs. Saved comment automations are managed from their card; the catalog has no Comment rules/History navigation or activity dashboard. Follow to unlock uses the existing comment-to-DM definition with verification enabled, rather than a separate provider API.

The October 3 improvements add business-specific templates, paused duplication, revision-scoped tab draft recovery, industry question presets, menu drag/keyboard ordering, activation overlap review, connection health, and per-automation simulation/delivery details. The simulation checks saved matching/precedence only and never sends, verifies follow status, or claims actual delivery. DM/follow catalog counts are mutually exclusive. Media list pages cache for 60 seconds per business/account/cursor and can be refreshed explicitly.

## Burst handling and diagnostics

Meta documents 750 private replies per hour for post/reel comments. Automated private-reply intents reserve a slot transactionally and cap at 700 per business/account in a rolling hour, counting rejected/uncertain attempts and leaving headroom for other activity. Runs that cannot reserve a slot remain queued with a not-before time; the recovery sweep resumes them after the wait and live execution rechecks its eligibility window. No existing send intent is replayed. Migration 318 adds the matching partial index. Other features or workspaces using the same professional account must also be considered when monitoring the account's total Meta usage.

Provider errors expose stable next steps for throttling, authorization expiry, closed messaging windows, ineligible comments, and revoked message access. Raw Meta error text is excluded. The existing shared OUTREACH limiter and immutable effect receipts remain active.

## Provider contracts

| Feature | API | Behavior |
| --- | --- | --- |
| Conversation starters | `POST/GET/DELETE /{actor}/messenger_profile`, `platform=instagram`, `ice_breakers` | Up to four questions per locale; publication is confirmed by readback. Selected questions arrive as messaging postbacks. |
| Main menu | `POST/GET/DELETE /{actor}/messenger_profile`, `platform=instagram`, `persistent_menu` | URL and postback items, locale groups, configured responses, confirmed readback and stale-action handling. |
| Comment to DM | `POST /{ig-account-id}/messages`, recipient `{comment_id}` | A single initial text private reply within seven days. Follow-up content requires the person to respond. |
| Public comment reply | `POST /{comment-id}/replies`, message text | Uses the account-bound existing comment service; accepted comment receipts are recorded. |
| Follow verification | `GET /{IGSID}?fields=is_user_follow_business` after a messaging interaction | Only a boolean true releases promised content. False/unknown keeps content pending; a DONE message alone does not prove a follow. |
| Rich responses | `POST /{messaging-actor}/messages`, recipient `{id: IGSID}` | Text, quick replies, button and generic/carousel templates are available in an eligible messaging interaction. |
| Media selection | `GET /{ig-account-id}/media`; owned media lookup | Cursor pagination, supported fields for the login type, strict owner confirmation before Reel classification/activation. |

Direct Instagram Login uses `graph.instagram.com` with the Instagram User token. Facebook-backed credentials use `graph.facebook.com` with the bound Page token. Profile settings and legacy regular messaging use the Page actor; comment private replies address the Instagram account for both login types. The deployed Graph version is read from the administrator's configuration. Local configuration specifies v25.0; the connector reports v26.0 as latest without reporting deprecations for the accessible development app.

## Permissions and webhooks

Direct login requires `instagram_business_basic` plus `instagram_business_manage_messages` for messaging/profile features and `instagram_business_manage_comments` for comment features. Facebook-backed accounts require `instagram_basic`, `pages_read_engagement`, the applicable `instagram_manage_messages`/`instagram_manage_comments` grant, and `pages_manage_metadata` for the integration's account subscriptions. The automation service checks the base/dependency grants as well as feature approval, usable credentials and actual subscribed fields. Extra Business Manager access requirements depend on how the Page role was granted and must be verified for the chosen account.

Profile/messaging flows check `messages` and `messaging_postbacks`; comment flows also check `comments`. OAuth records actual granted permissions and configures the corresponding account subscription. Drafts remain editable while live operation is unavailable. The allowlist supports designated app testers; it cannot bypass missing token grants.

The user-profile API requires messaging consent. A comment alone does not establish that consent. Follow prompts therefore ask for a reply before checking follow status. Initial private replies do not expose rich templates; follow-up templates use the supported interaction window. No follow event is assumed to authorize unsolicited messages to new followers.

## Actual app configuration findings

- Accessible developer apps: **AskSales.ai Dev** (`1395911102593376`, development mode) and **AskSales.ai** (`1373318641307190`, live mode).
- Both apps subscribe to Instagram `messages`, `messaging_postbacks`, and `comments`. The connector masks callback paths, so those results do not independently verify the exact webhook endpoint or signature behavior.
- Their per-permission privilege reports do not show approved Instagram messaging/comment access. `instagram_business_manage_comments` is not listed in either report. The production app does show advanced `instagram_basic` access. A generic app-level approval flag must not be treated as approval of each required permission.
- The local database instead contains active parent Meta App ID **1484460696638581**, absent from the connector's accessible app list, no Instagram Login product ID, and no saved review-permission mapping. Its credentials were not replaced.
- The user has been asked which app to use. After selecting it, configure the parent Meta App credentials and the separate Instagram Login product ID/secret through the secure administrator interface, verify the callback URLs and actual grants, and complete Meta's required review for customer access. App approval cannot be granted by this application.
- The shared development database still needs the previously documented ownership/membership prerequisite chain and automation migration. The isolated API tests do not migrate that database.

## Sources

- [Meta: Ice Breakers with Instagram Login](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/ice-breakers/)
- [Meta: Persistent Menu](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/persistent-menu)
- [Meta: Private replies](https://developers.facebook.com/documentation/instagram-platform/private-replies)
- [Meta: Instagram User Profile API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile/)
- [Meta: Messaging API](https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api)
- [Meta: IG Media reference](https://developers.facebook.com/documentation/instagram-platform/reference/instagram-media)
- [Meta: Permission reference](https://developers.facebook.com/docs/permissions/)
- [Meta's official Instagram API collection](https://www.postman.com/meta/instagram/folder/1z5vxzu/instagram-api-with-instagram-login)
- [Meta: Graph API rate limits](https://developers.facebook.com/docs/graph-api/overview/rate-limiting/)
- [Meta: Messaging error codes](https://developers.facebook.com/documentation/business-messaging/messenger-platform/error-codes)

The saved local audit's `meta-app-readiness.json` and `configured-meta-apps.json` contain the sanitized app/configuration inspection results. Provider responses are fixtures in automated tests; real publication, delivery and webhook echoes remain unverified until the app/account blockers are resolved.

## Development selection and remaining setup (3 October 2026)

The user selected **AskSales.ai Dev (`1395911102593376`)** for development and `@aimplify.tech` as the professional account. Its matching parent App Secret and separate Instagram Login product ID/secret must be entered in the administrator interface; the user deferred that step. The connected Meta tools provide configuration/review inspection but do not expose those secrets. Do not substitute the parent app ID for a separate Instagram Login product ID, retain another app's secret under a new ID, or mark rejected/unapproved permissions approved locally.

The selected app has development redirect URIs for `/api/instagram/oauth/callback` and `/api/meta/oauth/callback` on `https://dev.asksales.ai`, and subscribed Instagram `messages`, `messaging_postbacks`, and `comments` fields. The connector masks the full callback endpoint, so an exact webhook callback comparison remains unverified. The privilege report shows no approved Instagram messaging/basic/comment access, and direct business-comment permission is absent from that report. An app administrator must resolve the appropriate use case and permissions/roles in Meta.

The user requested skipping real Instagram tests. Local tests use isolated account fixtures and simulated Meta HTTP responses. Real publication, delivery, follow checks and webhook receipt are not certified.
