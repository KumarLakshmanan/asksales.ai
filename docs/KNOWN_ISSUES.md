# Known Issues — AskSales.ai Platform

> Last updated: 2026-11-14 (section 0 only; sections 1–5 date from 2025-05-19 and have not been re-verified)
> Status key: ✅ Fixed | ⚠️ Partial / Needs re-auth | 🔴 Open

---

## 0. Support AI, Assistants and Privacy (2026-11-14)

### 0.1 No customer replies or sends unless the assistant runtime is enabled ⚠️ Deployment configuration
**Symptom**: No automatic replies on any channel; manual and campaign sends are rejected with `ASSISTANT_SETUP_REQUIRED`.
**Root cause**: `SUPPORT_ASSISTANTS_ENABLED` must be exactly `true` (and the business profile inside `SUPPORT_ASSISTANTS_BUSINESS_PROFILES` when that list is set). There is no legacy specialist fallback. An account without one live published assistant also stays silent.
**Action required**: Follow `server/ASSISTANTS_ROLLOUT.md`; variables are listed in `docs/DEPLOYMENT.md` ("Support AI runtime configuration").

### 0.2 PII redactor replaced ordinary words with name/SSN/phone tokens ✅ Fixed
**Symptom**: "I am looking for a room" became "I am [NAME_1] a room"; 9-digit booking references became `[SSN_1]`.
**Fix**: Conversational name, SSN and phone detection tightened in `server/services/agents/orchestration/PrivacyVaultService.ts`; covered by `server/tests/piiRedactionAccuracy.test.ts`.

### 0.3 Messages stored before fix 0.2 keep the over-redacted text 🔴 Open
Stored message content was overwritten with the redacted text. The original is recoverable only from the privacy vault, and only until its retention expires (30 days by default, 90 maximum). No repair job exists.

### 0.4 Redactor limits (regex only) 🔴 Open
Lowercase names after "i am" / "this is" ("i am ravi kumar") and bare names or addresses without a cue phrase are not detected. A 10-digit number directly after a reference label ("booking no. 9876543210") is treated as a reference, not a phone.

### 0.5 `SUPPORT_MODERATION_FAIL_CLOSED` has no runtime effect 🔴 Open
It is only reported in the deployment readiness view. Provider-moderation outages always hand off anything outside the low-risk set.

---

## 1. Meta / Social Integrations

### 1.1 Facebook Disconnect Still Shows "Connected" ✅ Fixed
**Symptom**: After clicking "Disconnect" on the Facebook integration page, the status still showed "Connected".  
**Root cause**: `POST /api/facebook/oauth/disconnect` deactivated the `channel_credentials` row (`platform = 'facebook_api'`) but left `meta_page_connections.is_active = true`. The status check reads both tables — the second remained active.  
**Fix**: `facebookOAuthController.ts` disconnect handler now also calls `disconnectMetaPageConnection(userId)` which sets `meta_page_connections.is_active = false`.  
**Files changed**: `server/controllers/facebookOAuthController.ts`

---

### 1.2 Instagram Disconnect Still Shows "Connected" ✅ Fixed
**Symptom**: Same as Facebook — Instagram Official API and OAuth disconnect left the integration appearing active.  
**Root cause**: `POST /api/instagram/oauth/disconnect` only deactivated `channel_credentials` but not `meta_page_connections`.  
**Fix**: Added `disconnectMetaPageConnection(userId)` call for `type = 'api'` or `type = 'all'`.  
**Files changed**: `server/controllers/instagramOAuthController.ts`

---

### 1.3 Instagram Official API Card Had No Disconnect Button ✅ Fixed
**Symptom**: When Instagram was connected via OAuth (Official API flow), there was no way to disconnect from the UI — no button was shown.  
**Root cause**: `InstagramOfficialAPI.tsx` component only displayed a "Connected" badge with no corresponding disconnect action or prop.  
**Fix**: Added `onDisconnect?: () => Promise<void>` prop to the component and a `LogOut` icon button. The parent page (`instagram/page.tsx`) passes `handleOAuthDisconnect` which calls `POST /api/instagram/oauth/disconnect` with `{ type: 'api' }`.  
**Files changed**: `client/src/app/dashboard/(main)/integrations/instagram/components/InstagramOfficialAPI.tsx`, `client/src/app/dashboard/(main)/integrations/instagram/page.tsx`

---

### 1.4 Instagram API Calls Fail — Dev Mode Restriction ⚠️ Needs Meta App Review
**Symptom**: Instagram endpoints return `(#10) No permission` or `(#3) Not capable`.  
**Root cause**: The Meta app (`ID: 1484460696638581`) is in **Development mode**. Permissions haven't been reviewed by Meta.  
**Affected permissions**: `instagram_basic`, `instagram_manage_messages`, `instagram_manage_insights`  
**Fix required**:  
1. Remove unused permissions (`pages_utility_messaging`, `instagram_business_manage_messages`) from Meta Developer Console.  
2. Add `instagram_manage_insights` to the app.  
3. Submit `instagram_basic`, `instagram_manage_messages`, `instagram_manage_insights` for Meta App Review.  
4. Switch app to **Live mode** once approved.

---

## 2. Email Outreach

### 2.1 Send Email Modal — Body Not Sent to Server ✅ Fixed
**Symptom**: When clicking "Send Emails" from the `SendEmailModal` (opened from Leads tab), emails failed with "Subject and body are required" error, even when filled in.  
**Root cause**: The modal sent the email body as `html` in the request payload, but the `sendBulkEmails` server controller destructured it as `body`. Since `req.body.body` was undefined, the validation check failed with a 400 error.  
**Fix**: Changed the modal request payload from `html: body` → `body` to match what the server reads.  
**Files changed**: `client/src/components/modals/SendEmailModal.tsx`

---

### 2.2 Send Email Modal — Response Format Mismatch ✅ Fixed
**Symptom**: Even if the email was sent, the modal crashed with a `TypeError` because it tried to read `response.summary.sent` but the server returns `{ sent, failed, errors }` — no `summary` object.  
**Root cause**: The TypeScript response type in the modal (`summary: { total, sent, failed }; results: [...]`) did not match the server's actual return shape (`{ sent, failed, errors, message }`).  
**Fix**: Updated the TypeScript type, mapped server `errors[]` to per-email results for display, and replaced `response.summary.sent` with `response.sent`.  
**Files changed**: `client/src/components/modals/SendEmailModal.tsx`

---

### 2.3 Gmail Token Revoked — Integration Shows "Connected" ⚠️ Needs User Re-auth
**Symptom**: Production logs show recurring `[GmailOAuth] Failed to refresh token` errors with `invalid_grant`. The Gmail sync button returns 0 synced messages, and Gmail-based email sends silently fail.  
**Root cause**: The OAuth refresh token for the connected Gmail account was revoked (expired or manually removed from Google). The credential row in `channel_credentials` was not deactivated so the integration page kept showing "Connected".  
**Fix**: `getGmailClientForUser` now detects `invalid_grant` during refresh and calls `ChannelCredentialModel.deactivate(userId, 'gmail_api')`. On the next page load, Gmail shows as disconnected and prompts re-authentication.  
**Action required**: User must reconnect Gmail from the Email Integrations page.  
**Files changed**: `server/controllers/gmailOAuthController.ts`

---

### 2.4 CRM Contacts Not Visible in Email Outreach ✅ Fixed
**Symptom**: Contacts created in CRM did not appear in the Email Outreach leads list. There was no way to email CRM contacts via the outreach system.  
**Root cause**: CRM contacts (`crm_contacts` table) and Email Outreach leads (`leads` table) are separate records. No sync mechanism existed between them.  
**Fix**: Added:  
- `POST /api/crm/contacts/sync-to-leads` — copies all (or selected) CRM contacts with email addresses into the `leads` table. Skips duplicates (matched by email + userId).  
- "Sync to Email Outreach" button on the CRM Contacts page header.  
**Files changed**: `server/controllers/crmController.ts`, `server/routes/crm.routes.ts`, `client/src/app/dashboard/(main)/crm/contacts/page.tsx`

---

## 3. Build / Deployment

### 3.1 Client Build Fails — `dompurify` Module Not Found ✅ Fixed
**Symptom**: `pnpm build` on the production server failed with `Module not found: Can't resolve 'dompurify'`.  
**Root cause**: `dompurify` and `@types/dompurify` were referenced in `SendEmailModal.tsx` for safe HTML preview rendering but were not installed on the production server (the `node_modules` were not committed).  
**Fix**: Ran `pnpm add dompurify @types/dompurify` in the `client/` directory on production.  
**Note**: The package is now in `client/package.json` so future deploys via `pnpm install` will include it.

---

## 4. WhatsApp

### 4.1 WhatsApp Disconnect ✅ No Issue
The WhatsApp disconnect (`DELETE /api/whatsapp/config`) correctly deletes the `channel_credentials` row. No fix needed.

---

## 5. Recurring / Monitoring Items

| Item | Severity | Notes |
|------|----------|-------|
| Gmail Pub/Sub webhook `invalid_grant` | Medium | Fires every ~10 min when Gmail is revoked. Auto-deactivation fix (2.3) will reduce noise. |
| Instagram API in Dev mode | High | Blocks real-user testing until Meta App Review completes. |
| WhatsApp Quality: GREEN | OK | Oro Circle WABA is healthy. |
| `salesmarketing-api` PM2 | OK | Online, no restarts needed. |
| `salesmarketing-client` PM2 | OK | Online, no restarts needed. |
