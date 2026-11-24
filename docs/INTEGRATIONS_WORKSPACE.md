# Integrations workspace

The sidebar exposes Instagram, WhatsApp, Facebook, Email, Meta Ads, Google Ads and All Integrations as direct links. SMS and YouTube remain on the overview. All six pages use the shared account-card and feature-panel layout, with their existing settings preserved below it.

## Self-service Meta onboarding

Approved users with access to the integrations module use the shared `meta_app` admin configuration. They do not enter an App ID, app secret or token. Instagram uses direct Instagram Login and requires a Business or Creator account. It does not require a Facebook Page. Personal Instagram accounts must switch to a professional account first. Facebook connects a Page and Messenger; it does not connect a personal profile inbox. Facebook-only consent does not authorize Instagram.

The initial permission sets live in `server/services/integrations/MetaConnectionPolicy.ts`:

- Facebook: `pages_show_list`, `pages_manage_metadata`, `pages_read_engagement`, `pages_messaging`.
- Instagram Login: `instagram_business_basic`, `instagram_business_manage_messages`. Existing Facebook-backed Instagram credentials retain their original permission requirements until reconnected.

Additional publishing, insights or comments permissions are only requested through an explicit feature consent, allowlisted for the provider and recorded as approved/not-required in the shared app configuration. Existing capability definitions still report optional feature availability. The existing Meta review runbook remains the deployment reference.

OAuth start routes accept `format=json` so the UI can display setup/configuration errors before redirecting. Existing redirect callers still work. OAuth nonces, tenant ownership checks and the current workspace context remain in force.

## Connection state and isolation

Meta status distinguishes `authorized`, `selectionRequired`, `connected`, expired/revoked authorization and missing scopes. Connected messaging requires the selected account, required grants and a webhook subscription. Only Facebook and legacy Facebook-backed Instagram accounts require a linked Page. Authorization alone does not imply readiness. Facebook consent can authorize multiple Pages and requires an explicit selection. Direct Instagram Login authorizes the account selected in Instagram; repeat login to add another account. Page metadata is shown only for legacy Facebook-backed Instagram connections.

Instagram and Facebook credentials, default selections and disconnects are independent. Shared Page routing rows keep each channel's active flag. Direct Instagram credentials carry `sessionData.useInstagramLogin=true`. Token exchange, refresh, messaging, publishing, comments and insights use `graph.instagram.com`; refresh uses `ig_refresh_token`. Provider permissions and per-account webhook subscriptions are verified on Instagram. The legacy routing table uses the Instagram user ID as its routing key without presenting it as a Facebook Page.

For OAuth credentials only, the encrypted `channel_credentials.apiKey` column stores the account-bound Page token with `sessionData.pageTokenBound=true`; `accessToken` retains the user token. Manual App IDs retain their existing meaning. Legacy Page tokens are pinned before replacing a shared Page row, so a narrower consent cannot substitute another channel's token. Chooser and status responses never include these secret values.

Meta Ads requires an ad account and Page selection. Google Ads requires its existing complete API/customer configuration, not just OAuth authorization. WhatsApp follows the existing provider readiness and paused states. Email requires usable Gmail authorization or a verified sender on a verified domain; shared Resend configuration alone is not connected.

## Shared Instagram app setup

In Admin → Integrations → Meta App, save the **Instagram App ID** and **Instagram App Secret** from the Instagram product's **API setup with Instagram login**. These differ from the parent Facebook App ID and secret. The previous direct-login compatibility flag no longer controls onboarding. Missing Instagram credentials produce an actionable setup error; the app does not silently fall back to Facebook Login.

Register `/api/instagram/oauth/callback` in Instagram's valid OAuth redirect URIs and configure the signed Instagram webhook at `/api/webhooks/instagram` using the deployment's public HTTPS origin. The server subscribes each authorized account to `messages` and `messaging_postbacks`; it adds `comments` only after that permission is granted. Record actual approval status for each `instagram_business_*` permission in the admin capability settings. Existing approvals for `instagram_manage_*` do not imply approval of the new scopes.

Facebook continues to use the parent Facebook app, Facebook Login, Page selection and Messenger. Personal profiles may authenticate to Facebook Login, but this integration cannot manage their personal inbox or publish to their timeline.

## Release validation

Run the integration workspace Vitest tests, Meta OAuth/policy/account isolation Jest tests, and `client/e2e/integrations-workspace.spec.ts` for desktop and mobile. Browser tests mock providers and do not send messages or change live accounts.

Before customer release, validate the deployed Meta app's live mode, relevant access approvals and configured redirect/webhook URLs with a regular account that has **no role on the Meta developer app**. Complete Facebook Page selection and direct Instagram Login with an unlinked professional account and verify an actual incoming webhook and permitted message response. Repository tests and admin configuration do not establish Meta's production approval or live delivery.

## Provider references

- [Meta: Instagram API with Instagram Login](https://www.postman.com/meta/instagram/folder/6raa77c/instagram-api-with-instagram-login)
- [Meta: Messenger Platform requirements](https://www.postman.com/meta/messenger-platform-api/collection/iyp204x/messenger-platform-api)
