# Instagram automation rollout

See [the Meta API mapping](INSTAGRAM_AUTOMATIONS_META_API.md) for the card catalog, provider endpoints, permission dependencies and inspected app configuration. Before live verification, resolve the configured parent app and separate Instagram Login product credentials, then verify actual approved grants and webhook subscriptions for that app.

Apply migration 318 after 316 for the hourly private-reply budget index. The existing database prerequisite chain includes 299, 300, 301, 302 and 304 before 316; membership migration 304 relies on the subscription catalog/capacity functions from 301–302. Restore and verify a backup in a clone before applying this broad chain to an existing database.

## Deployment order

1. Verify the business isolation and membership migrations (299 and 304, including their prerequisites) are applied, then apply `316_instagram_automations.js` using the custom migration runner. Select the environment explicitly with `NODE_ENV`; the runner selects `.env.development` or `.env.production` and preserves explicit database arguments. Use `node scripts/migrate.mjs up 316_instagram_automations.js` only after confirming that target and its prerequisites. Migration 299 changes ownership across the database and has no safe automatic rollback.
2. Build and deploy both the API and worker bundles. The API persists account-scoped configuration and webhook executions. OUTREACH workers deliver effects; the GENERAL recovery job runs every minute.
3. Set `INSTAGRAM_AUTOMATIONS_TEST_ACCOUNTS` to comma-separated account IDs on both API and worker processes. Leave `INSTAGRAM_AUTOMATIONS_ENABLED` unset during provider acceptance testing. Draft editing remains available without rollout.
4. Confirm app review permissions, usable credentials, and subscriptions for messages, messaging postbacks, and comments. Activation/publication checks the provider subscription as well as stored readiness. New rules always start paused.
5. Complete the live-account checklist below before setting `INSTAGRAM_AUTOMATIONS_ENABLED=true` broadly. Application tests use mocked Meta responses and cannot certify provider support.

## Implemented contract

- Hub: `/dashboard/integrations/instagram/automations?accountId=<id>`. API: `/api/instagram/automations/:accountId`, with profiles, rules, media, and runs subresources.
- Every request resolves the account under its owner and business profile. Executions, drafts, rules, and effects are protected by business RLS and explicit ownership/account predicates.
- Starters and menus support a default language and locale groups. Save the draft before attempting Meta publication. Publish only after a successful write and exact readback. A provider rejection retains the draft and the last confirmed publication. Interrupted publications are reconciled by readback after five minutes; recovery never blindly repeats a profile write.
- Menu postbacks resolve explicitly configured, confirmed response mappings. A removed/changed menu action receives a recorded explanation to refresh the Instagram chat; it never exposes an unpublished draft response. Starters enter the existing inbox/AI path as their configured question. Menu messages do not expose comment-personalization controls.
- One comment rule wins: specific media, reels, any media, then list priority. Negative keywords exclude the rule. After a match, audience filters or quotas may skip delivery but do not fall through to AI or another rule.
- First Comment-to-DM delivery is a text private reply addressed by `comment_id`. Public acknowledgement follows only an accepted private reply receipt. Rich messages are restricted to the subsequent supported messaging interaction or a menu postback.
- Text and quick-reply messages allow 1,000 UTF-8 bytes; button text allows 640 characters. Follow instructions count toward the text limit. Expanded messages are validated before sending. Carousel images and buttons are optional when another supported card property is present. Direct-login media reads omit Facebook-only fields; Reel scope uses the returned Reel permalink. An inconclusive Reel lookup claims a durable skipped run rather than dispatching a lower-priority response.
- Both login methods publish profile settings with `platform=instagram`. Icebreaker readback returns locale groups directly; menu readback may wrap the groups in `persistent_menu`. Compare supported fields and preserve menu action order. Private replies use the Instagram account actor for both login methods; regular Page-backed DMs use the Page actor and its bound token.
- Follow prompts ask the user to reply DONE. A callback or DONE alone is insufficient: only Meta's `is_user_follow_business === true` releases promised content. False, unavailable, or inconclusive results retain pending content and send retry/HELP guidance. HELP enters the existing inbox support path.
- Limits are per rule and recipient. Daily limits use UTC and durable reservation time, including in-flight and uncertain effects. Both public and private rules enforce them. Contact tags are set on a matching contact, even when an eligibility filter later skips delivery.
- Provider send intents commit before the network call. Duplicate webhooks/jobs cannot duplicate an effect. Missing receipts/timeouts remain uncertain; they are not retried automatically. Successful effect receipts can resume later processing without repeating sends.
- Reporting counts accepted provider effects separately from triggers. No read or reply rates are fabricated. A paused/deleted rule stops future queued work and pending follow content; already accepted effects remain in history.

## Live provider acceptance checklist

Use a designated professional Instagram test account and a second consenting test identity. Test each supported login path (direct Instagram login and Page-backed login) before enabling that path broadly. Use original test copy, not the Sendiee reference account's content.

- Publish starters in the default language and one additional supported locale; read back and verify on a fresh Instagram conversation. Verify tapping a question reaches the inbox with the intended text. Remove, read back, and confirm removal.
- Publish a menu with an HTTPS link and a configured response action. Confirm both on Instagram. Test each enabled rich response format after a menu interaction. Verify unsupported locales/features remain visibly unavailable with the draft retained. Remove and confirm removal.
- Create a paused public rule and DM rule, then explicitly activate each. Confirm account-specific media selection, reels scope, positive/negative keywords, exact/contains matching, precedence, and manual ordering.
- From the second identity, comment on selected content. Confirm one text private reply, then its public acknowledgement; verify a public-only rule sends no DM. Repeat a webhook/job and confirm no duplicate accepted effect.
- Enable the follow gate. Confirm a nonfollower receives only the prompt. Reply DONE before following: content stays pending. Follow and reply DONE: verify a provider-confirmed follow releases content once. Repeat and simulate missing follower data to verify strict behavior.
- Test cooldown/day limits and contact tagging. Check opt-out, paused rules, revoked permissions, and expired credentials. Check provider rejections versus uncertain outcomes in history. Never replay an uncertain send without independently resolving its delivery receipt.
- Verify failure/readback mismatch keeps the previous confirmed profile and saved draft. Interrupt publication after the provider update and confirm recovery reconciles the durable pending revision.

## Local verification

From `server`, with a supported Node runtime:

```sh
INSTAGRAM_AUTOMATIONS_LOCAL_QA=1 NODE_OPTIONS='--experimental-vm-modules' node node_modules/jest/bin/jest.js --runInBand tests/instagramAutomationRuntimePostgres.test.ts tests/instagramAutomationProvider.test.ts tests/instagramAutomationRoutes.test.ts
```

Client interaction tests cover languages, menu actions, previews, validation, media, switching editors, failures, and account isolation. `e2e/instagram-automations.spec.ts` is the quick desktop/mobile test with mocked API responses. The expanded `e2e/instagram-automations-audit.spec.ts` uses the real router, account resolver, configuration/provider services and scoped PostgreSQL. The test authentication boundary and Meta requests use explicit fixtures. No real account is configured or messaged.

Start the isolated browser harness from `server`:

```sh
INSTAGRAM_AUTOMATIONS_LOCAL_QA=1 INSTAGRAM_AUTOMATIONS_BROWSER_QA=1 NODE_OPTIONS='--experimental-vm-modules' node node_modules/jest/bin/jest.js --runInBand tests/instagramAutomationRoutes.test.ts --testNamePattern 'browser audit harness'
```

Start an isolated Next dev server, then run from `client` (set the actual dev-server URL):

```sh
INSTAGRAM_AUTOMATIONS_HTTP_QA=1 E2E_SKIP_WEBSERVER=1 E2E_BASE_URL=http://localhost:34179 node ../node_modules/@playwright/test/cli.js test e2e/instagram-automations-audit.spec.ts
```

Screenshots are saved under `output/instagram-automation-audit/screenshots/` at the repository root. The opt-in harness binds only to loopback on port 8087 and provides fixture reset, simulated provider errors and history data. POST `/__audit/stop` after the browser pass removes its disposable schema. The default route suite also removes its schema when finished.

## Rollback

Disable rollout on API and workers to stop new automation work, then inspect queued/uncertain executions and pending publications. Existing confirmed profile settings remain at Meta until explicitly removed. Coordinate code rollback before removing migration 316: dropping it erases drafts, rules, executions, and receipts and does not undo external provider changes. Do not remove the receipt ledger while related workers can still run.
