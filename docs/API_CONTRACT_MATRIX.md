# API Contract Matrix

Generated from static client and Express route declarations on 2026-10-03 by `scripts/audit-app-contracts.mjs`. Dynamic and indirectly constructed paths remain explicitly marked for review rather than being assumed valid.

## Contract rules

- Browser calls use same-origin `/api/...` unless an explicitly external provider is required.
- User, administrator, and support-member credentials remain separate.
- Shared transport owns URL normalization, JSON parsing, CSRF headers, standardized errors, and response-envelope handling.
- Every mutation must expose pending, success, actionable error, and cache-invalidation behavior.
- Mount discovery follows TypeScript imports/re-exports and router variables. URL-rewriting middleware, computed paths and runtime feature gates still require behavioral review.

## Static coverage summary

- Client API method call sites found: **1330**
- Unique method/path contracts: **863**
- Statically matched to a registered Express route: **858**
- Explicit review items (dynamic, indirect mount, or possible mismatch): **5**
- Registered Express method/path declarations inventoried: **1450**

## Active client contracts

| Surface | Method | Client path | Client sources | Backend evidence | Static status |
| --- | --- | --- | --- | --- | --- |
| User/public | GET | `/api/:param/oauth/authorize` | `client/src/components/social-insights/SocialContentInsights.tsx:1138` | `server/controllers/instagramOAuthController.ts:118`<br>`server/controllers/facebookOAuthController.ts:101`<br>`server/controllers/gmailOAuthController.ts:397` | Matched |
| User/public | GET | `/api/:param/oauth/status` | `client/src/lib/integration-status.ts:32` | `server/controllers/instagramOAuthController.ts:215`<br>`server/controllers/facebookOAuthController.ts:428`<br>`server/controllers/twitterOAuthController.ts:29` | Matched |
| Admin | GET | `/api/admin/account-deletion-requests` | `client/src/app/admin/dashboard/policies/page.tsx:137` | `server/routes/admin.routes.ts:307` | Matched |
| Admin | PATCH | `/api/admin/account-deletion-requests/:param` | `client/src/app/admin/dashboard/policies/page.tsx:254` | `server/routes/admin.routes.ts:308` | Matched |
| Admin | GET | `/api/admin/admins` | `client/src/app/admin/dashboard/admins/page.tsx:54` | `server/routes/admin.routes.ts:234` | Matched |
| Admin | POST | `/api/admin/admins` | `client/src/app/admin/dashboard/admins/new/page.tsx:53` | `server/routes/admin.routes.ts:236` | Matched |
| Admin | DELETE | `/api/admin/admins/:param` | `client/src/app/admin/dashboard/admins/page.tsx:74` | `server/routes/admin.routes.ts:238` | Matched |
| Admin | GET | `/api/admin/api-pricing` | `client/src/app/admin/dashboard/credit-pricing/page.tsx:175` | `server/routes/admin.routes.ts:466` | Matched |
| Admin | POST | `/api/admin/api-pricing` | `client/src/app/admin/dashboard/credit-pricing/page.tsx:303`<br>`client/src/app/admin/dashboard/credit-pricing/page.tsx:329`<br>`client/src/app/admin/dashboard/credit-pricing/page.tsx:356` | `server/routes/admin.routes.ts:467` | Matched |
| Admin | PUT | `/api/admin/api-pricing/:param` | `client/src/app/admin/dashboard/credit-pricing/page.tsx:301`<br>`client/src/app/admin/dashboard/credit-pricing/page.tsx:327`<br>`client/src/app/admin/dashboard/credit-pricing/page.tsx:354` | `server/routes/admin.routes.ts:468`<br>`server/routes/admin.routes.ts:469` | Matched |
| Admin | PUT | `/api/admin/api-pricing/bulk` | `client/src/app/admin/dashboard/credit-pricing/page.tsx:409` | `server/routes/admin.routes.ts:468`<br>`server/routes/admin.routes.ts:469` | Matched |
| Admin | GET | `/api/admin/api-pricing/genai-model-price` | `client/src/components/admin/IntegrationCredentialForm.tsx:159` | `server/routes/admin.routes.ts:462` | Matched |
| Admin | GET | `/api/admin/api-pricing/genai-provider-models` | `client/src/app/admin/dashboard/credit-pricing/page.tsx:226`<br>`client/src/components/admin/IntegrationCredentialForm.tsx:105` | `server/routes/admin.routes.ts:463` | Matched |
| Admin | GET | `/api/admin/api-pricing/image-pricing-reference` | `client/src/app/admin/dashboard/credit-pricing/page.tsx:243` | `server/routes/admin.routes.ts:464` | Matched |
| Admin | GET | `/api/admin/api-pricing/video-pricing-reference` | `client/src/app/admin/dashboard/credit-pricing/page.tsx:250` | `server/routes/admin.routes.ts:465` | Matched |
| Admin | GET | `/api/admin/audit-logs` | `client/src/app/admin/dashboard/audit-logs/page.tsx:36` | `server/routes/admin.routes.ts:461` | Matched |
| Admin | GET | `/api/admin/brand-toolkits` | `client/src/app/admin/dashboard/brand-toolkits/page.tsx:85` | `server/routes/admin.routes.ts:323` | Matched |
| Admin | GET | `/api/admin/business-categories` | `client/src/app/admin/dashboard/business-categories/page.tsx:145` | `server/routes/admin.routes.ts:508` | Matched |
| Admin | POST | `/api/admin/business-categories` | `client/src/app/admin/dashboard/business-categories/page.tsx:254` | `server/routes/admin.routes.ts:510` | Matched |
| Admin | DELETE | `/api/admin/business-categories/:param` | `client/src/app/admin/dashboard/business-categories/page.tsx:282` | `server/routes/admin.routes.ts:512` | Matched |
| Admin | PUT | `/api/admin/business-categories/:param` | `client/src/app/admin/dashboard/business-categories/page.tsx:257`<br>`client/src/app/admin/dashboard/business-categories/page.tsx:305` | `server/routes/admin.routes.ts:511` | Matched |
| Admin | POST | `/api/admin/business-categories/:param/subcategories` | `client/src/app/admin/dashboard/business-categories/page.tsx:260` | `server/routes/admin.routes.ts:516` | Matched |
| Admin | DELETE | `/api/admin/business-categories/:param/subcategories/:param` | `client/src/app/admin/dashboard/business-categories/page.tsx:294` | `server/routes/admin.routes.ts:518` | Matched |
| Admin | PUT | `/api/admin/business-categories/:param/subcategories/:param` | `client/src/app/admin/dashboard/business-categories/page.tsx:263` | `server/routes/admin.routes.ts:517` | Matched |
| Admin | GET | `/api/admin/campaigns` | `client/src/app/admin/dashboard/campaigns/page.tsx:110` | `server/routes/admin.routes.ts:312` | Matched |
| Admin | POST | `/api/admin/campaigns` | `client/src/app/admin/dashboard/campaigns/new/page.tsx:124` | `server/routes/admin.routes.ts:316` | Matched |
| Admin | DELETE | `/api/admin/campaigns/:param` | `client/src/app/admin/dashboard/campaigns/page.tsx:156` | `server/routes/admin.routes.ts:317` | Matched |
| Admin | POST | `/api/admin/change-password` | `client/src/app/admin/dashboard/change-password/page.tsx:67` | `server/routes/admin.routes.ts:273` | Matched |
| Admin | GET | `/api/admin/content-calendar` | `client/src/app/admin/dashboard/content-calendar/page.tsx:100` | `server/routes/admin.routes.ts:324` | Matched |
| Admin | GET | `/api/admin/content-templates` | `client/src/app/admin/dashboard/content-templates/page.tsx:91` | `server/routes/admin.routes.ts:322` | Matched |
| Admin | GET | `/api/admin/credit-analytics/daily` | `client/src/app/admin/dashboard/credit-analytics/page.tsx:106` | `server/routes/admin.routes.ts:394` | Matched |
| Admin | GET | `/api/admin/credit-analytics/providers` | `client/src/app/admin/dashboard/credit-analytics/page.tsx:108` | `server/routes/admin.routes.ts:396` | Matched |
| Admin | GET | `/api/admin/credit-analytics/summary` | `client/src/app/admin/dashboard/credit-analytics/page.tsx:105` | `server/routes/admin.routes.ts:393` | Matched |
| Admin | GET | `/api/admin/credit-analytics/top-users` | `client/src/app/admin/dashboard/credit-analytics/page.tsx:107` | `server/routes/admin.routes.ts:395` | Matched |
| Admin | GET | `/api/admin/credit-analytics/user/:param` | `client/src/app/admin/dashboard/users/[id]/billing/page.tsx:122` | `server/routes/admin.routes.ts:397` | Matched |
| Admin | GET | `/api/admin/credit-events` | `client/src/app/admin/dashboard/credit-events/page.tsx:69` | `server/routes/admin.routes.ts:390` | Matched |
| Admin | GET | `/api/admin/credit-pricing` | `client/src/app/admin/dashboard/credit-pricing/page.tsx:155` | `server/routes/admin.routes.ts:379` | Matched |
| Admin | PUT | `/api/admin/credit-pricing/bulk` | `client/src/app/admin/dashboard/credit-pricing/page.tsx:276` | `server/routes/admin.routes.ts:380`<br>`server/routes/admin.routes.ts:381` | Matched |
| Admin | POST | `/api/admin/credit-pricing/seed` | `client/src/app/admin/dashboard/credit-pricing/page.tsx:285` | `server/routes/admin.routes.ts:382` | Matched |
| Admin | GET | `/api/admin/dashboard/stats` | `client/src/app/admin/dashboard/home/page.tsx:51` | `server/routes/admin.routes.ts:276` | Matched |
| Admin | POST | `/api/admin/forgot-password` | `client/src/app/admin/forgot-password/page.tsx:37` | `server/routes/admin.routes.ts:226` | Matched |
| Admin | GET | `/api/admin/integrations` | `client/src/app/admin/dashboard/integrations/apify/page.tsx:83`<br>`client/src/app/admin/dashboard/integrations/embeddings/page.tsx:96`<br>`client/src/app/admin/dashboard/integrations/gmail_oauth/page.tsx:104`<br>`client/src/app/admin/dashboard/integrations/llm/page.tsx:107`<br>+6 more | `server/routes/admin.routes.ts:414` | Matched |
| Admin | POST | `/api/admin/integrations` | `client/src/app/admin/dashboard/integrations/gmail_oauth/page.tsx:170`<br>`client/src/app/admin/dashboard/integrations/llm/custom/add/page.tsx:77`<br>`client/src/app/admin/dashboard/integrations/resend/page.tsx:139`<br>`client/src/components/admin/ApifyCredentialForm.tsx:146`<br>+2 more | `server/routes/admin.routes.ts:422` | Matched |
| Admin | DELETE | `/api/admin/integrations/:param` | `client/src/app/admin/dashboard/integrations/apify/page.tsx:150`<br>`client/src/app/admin/dashboard/integrations/embeddings/page.tsx:143`<br>`client/src/app/admin/dashboard/integrations/gmail_oauth/page.tsx:131`<br>`client/src/app/admin/dashboard/integrations/llm/page.tsx:141`<br>+3 more | `server/routes/admin.routes.ts:426` | Matched |
| Admin | PUT | `/api/admin/integrations/:param` | `client/src/app/admin/dashboard/integrations/gmail_oauth/page.tsx:219`<br>`client/src/app/admin/dashboard/integrations/llm/custom/edit/[id]/page.tsx:103`<br>`client/src/app/admin/dashboard/integrations/resend/page.tsx:176`<br>`client/src/components/admin/ApifyCredentialForm.tsx:144`<br>+2 more | `server/routes/admin.routes.ts:401`<br>`server/routes/admin.routes.ts:423` | Matched |
| Admin | GET | `/api/admin/integrations/:param/full` | `client/src/app/admin/dashboard/integrations/gmail_oauth/page.tsx:195`<br>`client/src/app/admin/dashboard/integrations/llm/custom/edit/[id]/page.tsx:49`<br>`client/src/app/admin/dashboard/integrations/resend/page.tsx:160`<br>`client/src/components/admin/ApifyCredentialForm.tsx:74`<br>+1 more | `server/routes/admin.routes.ts:420`<br>`server/controllers/adminIntegrationsController.ts:76` | Matched |
| Admin | POST | `/api/admin/integrations/:param/test` | `client/src/app/admin/dashboard/integrations/apify/page.tsx:133`<br>`client/src/app/admin/dashboard/integrations/embeddings/page.tsx:125`<br>`client/src/app/admin/dashboard/integrations/gmail_oauth/page.tsx:145`<br>`client/src/app/admin/dashboard/integrations/llm/page.tsx:130`<br>+3 more | `server/routes/admin.routes.ts:402`<br>`server/routes/admin.routes.ts:425` | Matched |
| Admin | POST | `/api/admin/integrations/:param/toggle` | `client/src/app/admin/dashboard/integrations/apify/page.tsx:122`<br>`client/src/app/admin/dashboard/integrations/embeddings/page.tsx:113`<br>`client/src/app/admin/dashboard/integrations/gmail_oauth/page.tsx:120`<br>`client/src/app/admin/dashboard/integrations/llm/page.tsx:121`<br>+3 more | `server/routes/admin.routes.ts:424` | Matched |
| Admin | GET | `/api/admin/integrations/apify/balance` | `client/src/app/admin/dashboard/integrations/apify/page.tsx:96` | `server/routes/admin.routes.ts:417` | Matched |
| Admin | GET | `/api/admin/integrations/audit` | `client/src/app/admin/dashboard/integrations/page.tsx:252` | `server/routes/admin.routes.ts:416`<br>`server/routes/admin.routes.ts:421` | Matched |
| Admin | GET | `/api/admin/integrations/resend-domains` | `client/src/components/admin/SmtpCredentialForm.tsx:103` | `server/routes/admin.routes.ts:418`<br>`server/routes/admin.routes.ts:421` | Matched |
| Admin | POST | `/api/admin/integrations/validate` | `client/src/app/admin/dashboard/integrations/llm/custom/add/page.tsx:49`<br>`client/src/app/admin/dashboard/integrations/llm/custom/edit/[id]/page.tsx:78`<br>`client/src/components/admin/ApifyCredentialForm.tsx:98`<br>`client/src/components/admin/IntegrationCredentialForm.tsx:188` | `server/routes/admin.routes.ts:419` | Matched |
| Admin | GET | `/api/admin/intent-classifier-integrations` | `client/src/app/admin/dashboard/integrations/page.tsx:253` | `server/routes/admin.routes.ts:406` | Matched |
| Admin | GET | `/api/admin/leadflow/actors` | `client/src/app/admin/dashboard/integrations/apify/page.tsx:107`<br>`client/src/app/admin/dashboard/leadflow/ActorsSidebar.tsx:26`<br>`client/src/components/admin/ApifyCredentialForm.tsx:61` | `server/routes/admin.routes.ts:429` | Matched |
| Admin | GET | `/api/admin/leadflow/workflows` | `client/src/app/admin/dashboard/leadflow/WorkflowManager.tsx:71` | `server/routes/admin.routes.ts:432` | Matched |
| Admin | DELETE | `/api/admin/leadflow/workflows/:param` | `client/src/app/admin/dashboard/leadflow/WorkflowManager.tsx:264` | `server/routes/admin.routes.ts:435` | Matched |
| Admin | POST | `/api/admin/leadflow/workflows/:param/execute` | `client/src/app/admin/dashboard/leadflow/Canvas.tsx:244` | `server/routes/admin.routes.ts:436` | Matched |
| Admin | GET | `/api/admin/leads` | `client/src/components/admin/AdminLeadWorkspace.tsx:91` | `server/routes/admin.routes.ts:310` | Matched |
| Admin | POST | `/api/admin/leads` | `client/src/app/admin/dashboard/leads/new/page.tsx:59` | `server/routes/admin.routes.ts:318` | Matched |
| Admin | DELETE | `/api/admin/leads/:param` | `client/src/components/admin/AdminLeadWorkspace.tsx:152` | `server/routes/admin.routes.ts:319` | Matched |
| Admin | GET | `/api/admin/leads/export` | `client/src/components/admin/AdminLeadWorkspace.tsx:118` | `server/routes/admin.routes.ts:311` | Matched |
| Admin | POST | `/api/admin/login` | `client/src/app/admin/login/page.tsx:32` | `server/routes/admin.routes.ts:224` | Matched |
| User/public | POST | `/api/admin/logout` | `client/src/contexts/AdminAuthContext.tsx:71` | `server/routes/admin.routes.ts:225` | Matched |
| User/public | GET | `/api/admin/me` | `client/src/contexts/AdminAuthContext.tsx:33` | `server/routes/admin.routes.ts:230` | Matched |
| Admin | POST | `/api/admin/meta/config` | `client/src/app/admin/dashboard/integrations/meta_app/page.tsx:336` | `server/routes/admin.routes.ts:366` | Matched |
| Admin | GET | `/api/admin/meta/config/full` | `client/src/app/admin/dashboard/integrations/meta_app/page.tsx:263` | `server/routes/admin.routes.ts:365` | Matched |
| Admin | GET | `/api/admin/meta/connections` | `client/src/app/admin/dashboard/integrations/meta_app/page.tsx:291` | `server/routes/admin.routes.ts:367` | Matched |
| Admin | GET | `/api/admin/meta/health` | `client/src/app/admin/dashboard/integrations/meta_app/page.tsx:293` | `server/routes/admin.routes.ts:369` | Matched |
| Admin | GET | `/api/admin/meta/stats` | `client/src/app/admin/dashboard/integrations/meta_app/page.tsx:292` | `server/routes/admin.routes.ts:368` | Matched |
| Admin | GET | `/api/admin/meta/webhook-logs` | `client/src/app/admin/dashboard/integrations/meta_app/page.tsx:311` | `server/routes/admin.routes.ts:370` | Matched |
| Admin | GET | `/api/admin/notifications` | `client/src/components/admin/AdminDashboardLayout.tsx:147` | `server/routes/admin.routes.ts:530` | Matched |
| Admin | PATCH | `/api/admin/notifications/:param/read` | `client/src/components/admin/AdminDashboardLayout.tsx:172` | `server/routes/admin.routes.ts:533` | Matched |
| Admin | PATCH | `/api/admin/notifications/read-all` | `client/src/components/admin/AdminDashboardLayout.tsx:162` | `server/routes/admin.routes.ts:532` | Matched |
| Admin | GET | `/api/admin/outreach-conversations/:param/messages` | `client/src/components/admin/user-outreach-page.tsx:134` | `server/routes/admin.routes.ts:326` | Matched |
| Admin | GET | `/api/admin/outreach/email` | `client/src/app/admin/dashboard/outreach/email/page.tsx:85` | `server/routes/admin.routes.ts:325` | Matched |
| Admin | GET | `/api/admin/outreach/instagram` | `client/src/app/admin/dashboard/outreach/instagram/page.tsx:76` | `server/routes/admin.routes.ts:325` | Matched |
| Admin | GET | `/api/admin/outreach/sms` | `client/src/app/admin/dashboard/outreach/sms/page.tsx:74` | `server/routes/admin.routes.ts:325` | Matched |
| Admin | GET | `/api/admin/outreach/whatsapp` | `client/src/app/admin/dashboard/outreach/whatsapp/page.tsx:77` | `server/routes/admin.routes.ts:325` | Matched |
| Admin | GET | `/api/admin/platform-access` | `client/src/app/admin/dashboard/settings/platform-access/page.tsx:41` | `server/routes/admin.routes.ts:254` | Matched |
| Admin | PUT | `/api/admin/platform-access` | `client/src/app/admin/dashboard/settings/platform-access/page.tsx:55` | `server/routes/admin.routes.ts:255` | Matched |
| Admin | GET | `/api/admin/policies` | `client/src/app/admin/dashboard/policies/page.tsx:104` | `server/routes/admin.routes.ts:303` | Matched |
| Admin | POST | `/api/admin/policies` | `client/src/app/admin/dashboard/policies/page.tsx:211` | `server/routes/admin.routes.ts:304` | Matched |
| Admin | DELETE | `/api/admin/policies/:param` | `client/src/app/admin/dashboard/policies/page.tsx:235` | `server/routes/admin.routes.ts:306` | Matched |
| Admin | PUT | `/api/admin/policies/:param` | `client/src/app/admin/dashboard/policies/page.tsx:208` | `server/routes/admin.routes.ts:305` | Matched |
| Admin | GET | `/api/admin/predefined-templates` | `client/src/app/admin/dashboard/dm-templates/page.tsx:83`<br>`client/src/app/admin/dashboard/email-templates/page.tsx:95` | `server/routes/admin.routes.ts:288` | Matched |
| Admin | POST | `/api/admin/predefined-templates` | `client/src/app/admin/dashboard/dm-templates/page.tsx:148`<br>`client/src/app/admin/dashboard/email-templates/page.tsx:169` | `server/routes/admin.routes.ts:289` | Matched |
| Admin | DELETE | `/api/admin/predefined-templates/:param` | `client/src/app/admin/dashboard/dm-templates/page.tsx:170`<br>`client/src/app/admin/dashboard/email-templates/page.tsx:191` | `server/routes/admin.routes.ts:291` | Matched |
| Admin | PUT | `/api/admin/predefined-templates/:param` | `client/src/app/admin/dashboard/dm-templates/page.tsx:146`<br>`client/src/app/admin/dashboard/email-templates/page.tsx:167` | `server/routes/admin.routes.ts:290` | Matched |
| Admin | GET | `/api/admin/pricing-audit` | `client/src/app/admin/dashboard/pricing-history/page.tsx:74` | `server/routes/admin.routes.ts:460` | Matched |
| Admin | PUT | `/api/admin/profile` | `client/src/app/admin/dashboard/profile/page.tsx:53` | `server/routes/admin.routes.ts:231` | Matched |
| Admin | GET | `/api/admin/proposal-templates` | `client/src/app/admin/dashboard/proposal-templates/page.tsx:96` | `server/routes/admin.routes.ts:292` | Matched |
| Admin | POST | `/api/admin/proposal-templates` | `client/src/app/admin/dashboard/proposal-templates/page.tsx:285` | `server/routes/admin.routes.ts:295` | Matched |
| Admin | PUT | `/api/admin/proposal-templates/:param` | `client/src/app/admin/dashboard/proposal-templates/page.tsx:281` | `server/routes/admin.routes.ts:296` | Matched |
| Admin | GET | `/api/admin/proposal-templates/:param/history` | `client/src/app/admin/dashboard/proposal-templates/page.tsx:122` | `server/routes/admin.routes.ts:293` | Matched |
| Admin | POST | `/api/admin/proposal-templates/:param/rollback` | `client/src/app/admin/dashboard/proposal-templates/page.tsx:145` | `server/routes/admin.routes.ts:294` | Matched |
| Admin | GET | `/api/admin/queues` | `client/src/app/admin/dashboard/queues/page.tsx:103` | `server/routes/admin.routes.ts:521` | Matched |
| Admin | POST | `/api/admin/queues/:param/clean` | `client/src/app/admin/dashboard/queues/page.tsx:165` | `server/routes/admin.routes.ts:527` | Matched |
| Admin | GET | `/api/admin/queues/:param/jobs` | `client/src/app/admin/dashboard/queues/page.tsx:118` | `server/routes/admin.routes.ts:522` | Matched |
| Admin | DELETE | `/api/admin/queues/:param/jobs/:param` | `client/src/app/admin/dashboard/queues/page.tsx:155` | `server/routes/admin.routes.ts:524` | Matched |
| Admin | POST | `/api/admin/queues/:param/jobs/:param/retry` | `client/src/app/admin/dashboard/queues/page.tsx:146` | `server/routes/admin.routes.ts:523` | Matched |
| Admin | POST | `/api/admin/queues/:param/pause` | `client/src/app/admin/dashboard/queues/page.tsx:128` | `server/routes/admin.routes.ts:525` | Matched |
| Admin | POST | `/api/admin/queues/:param/resume` | `client/src/app/admin/dashboard/queues/page.tsx:137` | `server/routes/admin.routes.ts:526` | Matched |
| Admin | POST | `/api/admin/reset-password` | `client/src/app/admin/reset-password/page.tsx:80` | `server/routes/admin.routes.ts:227` | Matched |
| Admin | GET | `/api/admin/revenue/daily` | `client/src/app/admin/dashboard/revenue/page.tsx:154` | `server/routes/admin.routes.ts:474` | Matched |
| Admin | GET | `/api/admin/revenue/summary` | `client/src/app/admin/dashboard/revenue/page.tsx:140` | `server/routes/admin.routes.ts:473` | Matched |
| Admin | GET | `/api/admin/revenue/transactions` | `client/src/app/admin/dashboard/revenue/page.tsx:183` | `server/routes/admin.routes.ts:476` | Matched |
| Admin | GET | `/api/admin/storage/dashboard` | `client/src/app/admin/dashboard/storage/page.tsx:71` | `server/routes/admin.routes.ts:484` | Matched |
| Admin | GET | `/api/admin/storage/plans` | `client/src/app/admin/dashboard/storage/plans/page.tsx:73`<br>`client/src/app/admin/dashboard/storage/users/page.tsx:164` | `server/routes/admin.routes.ts:487` | Matched |
| Admin | POST | `/api/admin/storage/plans` | `client/src/app/admin/dashboard/storage/plans/page.tsx:144` | `server/routes/admin.routes.ts:488` | Matched |
| Admin | DELETE | `/api/admin/storage/plans/:param` | `client/src/app/admin/dashboard/storage/plans/page.tsx:160` | `server/routes/admin.routes.ts:490` | Matched |
| Admin | PUT | `/api/admin/storage/plans/:param` | `client/src/app/admin/dashboard/storage/plans/page.tsx:141` | `server/routes/admin.routes.ts:489` | Matched |
| Admin | GET | `/api/admin/storage/pricing` | `client/src/app/admin/dashboard/storage/pricing/page.tsx:56` | `server/routes/admin.routes.ts:493` | Matched |
| Admin | POST | `/api/admin/storage/pricing` | `client/src/app/admin/dashboard/storage/pricing/page.tsx:122` | `server/routes/admin.routes.ts:494` | Matched |
| Admin | PUT | `/api/admin/storage/pricing/:param` | `client/src/app/admin/dashboard/storage/pricing/page.tsx:119` | `server/routes/admin.routes.ts:495` | Matched |
| Admin | GET | `/api/admin/storage/quotas` | `client/src/app/admin/dashboard/storage/users/page.tsx:99` | `server/routes/admin.routes.ts:498` | Matched |
| Admin | GET | `/api/admin/storage/users/:param/files` | `client/src/app/admin/dashboard/storage/users/page.tsx:126`<br>`client/src/app/admin/dashboard/storage/users/page.tsx:144` | `server/routes/admin.routes.ts:503` | Matched |
| Admin | DELETE | `/api/admin/storage/users/:param/files/:param` | `client/src/app/admin/dashboard/storage/users/page.tsx:208` | `server/routes/admin.routes.ts:504` | Matched |
| Admin | POST | `/api/admin/storage/users/:param/files/bulk-delete` | `client/src/app/admin/dashboard/storage/users/page.tsx:222` | `server/routes/admin.routes.ts:505` | Matched |
| Admin | PUT | `/api/admin/storage/users/:param/limit` | `client/src/app/admin/dashboard/storage/users/page.tsx:181` | `server/routes/admin.routes.ts:500` | Matched |
| Admin | PUT | `/api/admin/storage/users/:param/plan` | `client/src/app/admin/dashboard/storage/users/page.tsx:176` | `server/routes/admin.routes.ts:501` | Matched |
| Admin | POST | `/api/admin/storage/users/:param/recalculate` | `client/src/app/admin/dashboard/storage/users/page.tsx:197` | `server/routes/admin.routes.ts:502` | Matched |
| Admin | GET | `/api/admin/subscriptions` | `client/src/app/admin/dashboard/settings/subscriptions/page.tsx:36` | `server/routes/subscriptions.routes.ts:74` | Matched |
| Admin | GET | `/api/admin/subscriptions/catalog` | `client/src/components/admin/PlanCatalogEditor.tsx:20` | `server/routes/subscriptions.routes.ts:67` | Matched |
| Admin | POST | `/api/admin/subscriptions/catalog/:param/publish` | `client/src/components/admin/PlanCatalogEditor.tsx:56` | `server/routes/subscriptions.routes.ts:71` | Matched |
| Admin | POST | `/api/admin/subscriptions/catalog/:param/retire` | `client/src/components/admin/PlanCatalogEditor.tsx:56` | `server/routes/subscriptions.routes.ts:72` | Matched |
| Admin | POST | `/api/admin/subscriptions/catalog/drafts` | `client/src/components/admin/PlanCatalogEditor.tsx:50` | `server/routes/subscriptions.routes.ts:68` | Matched |
| Admin | PUT | `/api/admin/subscriptions/catalog/drafts/:param` | `client/src/components/admin/PlanCatalogEditor.tsx:54`<br>`client/src/components/admin/PlanCatalogEditor.tsx:56` | `server/routes/subscriptions.routes.ts:70` | Matched |
| Admin | GET | `/api/admin/subscriptions/organizations` | `client/src/components/admin/OrganizationCredits.tsx:17` | `server/routes/subscriptions.routes.ts:53` | Matched |
| Admin | POST | `/api/admin/subscriptions/organizations/:param/credits` | `client/src/components/admin/OrganizationCredits.tsx:32` | `server/routes/subscriptions.routes.ts:62` | Matched |
| Admin | GET | `/api/admin/subscriptions/organizations/:param/plan` | `client/src/components/admin/AdminPlanAssignment.tsx:49` | `server/routes/subscriptions.routes.ts:55` | Matched |
| Admin | POST | `/api/admin/subscriptions/organizations/:param/plan` | `client/src/components/admin/AdminPlanAssignment.tsx:93` | `server/routes/subscriptions.routes.ts:56` | Matched |
| Admin | POST | `/api/admin/subscriptions/organizations/:param/plan/end` | `client/src/components/admin/AdminPlanAssignment.tsx:101` | `server/routes/subscriptions.routes.ts:58` | Matched |
| Admin | GET | `/api/admin/support-agent-templates` | `client/src/app/admin/dashboard/support-agents/page.tsx:50` | `server/routes/admin.routes.ts:301` | Matched |
| Admin | PUT | `/api/admin/support-agent-templates/:param` | `client/src/app/admin/dashboard/support-agents/page.tsx:64` | `server/routes/admin.routes.ts:302` | Matched |
| Admin | GET | `/api/admin/support-playbook-templates` | `client/src/app/admin/dashboard/support-playbooks/page.tsx:210` | `server/routes/admin.routes.ts:298` | Matched |
| Admin | POST | `/api/admin/support-playbook-templates` | `client/src/app/admin/dashboard/support-playbooks/page.tsx:330` | `server/routes/admin.routes.ts:299` | Matched |
| Admin | PUT | `/api/admin/support-playbook-templates/:param` | `client/src/app/admin/dashboard/support-playbooks/page.tsx:334` | `server/routes/admin.routes.ts:300` | Matched |
| Admin | DELETE | `/api/admin/system-logs` | `client/src/app/admin/dashboard/system-logs/page.tsx:278` | `server/routes/admin.routes.ts:481` | Matched |
| Admin | GET | `/api/admin/system-logs` | `client/src/app/admin/dashboard/system-logs/page.tsx:243` | `server/routes/admin.routes.ts:479` | Matched |
| Admin | GET | `/api/admin/system-logs/stats` | `client/src/app/admin/dashboard/system-logs/page.tsx:223` | `server/routes/admin.routes.ts:480` | Matched |
| Admin | GET | `/api/admin/usage/apify` | `client/src/app/admin/dashboard/usage/apify/page.tsx:113` | `server/routes/admin.routes.ts:341` | Matched |
| Admin | GET | `/api/admin/usage/embeddings` | `client/src/app/admin/dashboard/usage/embeddings/page.tsx:121` | `server/routes/admin.routes.ts:344` | Matched |
| Admin | GET | `/api/admin/usage/gemini` | `client/src/app/admin/dashboard/usage/gemini-image/page.tsx:93`<br>`client/src/app/admin/dashboard/usage/gemini-video/page.tsx:93`<br>`client/src/app/admin/dashboard/usage/gemini/page.tsx:108`<br>`client/src/app/admin/dashboard/usage/llms/page.tsx:168` | `server/routes/admin.routes.ts:342` | Matched |
| Admin | GET | `/api/admin/usage/llm` | `client/src/app/admin/dashboard/usage/llms/page.tsx:163`<br>`client/src/app/admin/dashboard/usage/openai/page.tsx:123`<br>`client/src/app/admin/dashboard/usage/openrouter/page.tsx:111` | `server/routes/admin.routes.ts:340` | Matched |
| Admin | GET | `/api/admin/usage/platform` | `client/src/app/admin/dashboard/usage/platform/page.tsx:123` | `server/routes/admin.routes.ts:345` | Matched |
| Admin | GET | `/api/admin/usage/zerobounce` | `client/src/app/admin/dashboard/usage/zerobounce/page.tsx:164` | `server/routes/admin.routes.ts:343` | Matched |
| Admin | GET | `/api/admin/users` | `client/src/app/admin/dashboard/campaigns/new/page.tsx:64`<br>`client/src/app/admin/dashboard/users/page.tsx:84` | `server/routes/admin.routes.ts:241` | Matched |
| Admin | POST | `/api/admin/users` | `client/src/app/admin/dashboard/users/new/page.tsx:70` | `server/routes/admin.routes.ts:243` | Matched |
| Admin | DELETE | `/api/admin/users/:param` | `client/src/app/admin/dashboard/users/page.tsx:125` | `server/routes/admin.routes.ts:245` | Matched |
| Admin | GET | `/api/admin/users/:param` | `client/src/app/admin/dashboard/users/[id]/edit/page.tsx:70`<br>`client/src/app/admin/dashboard/users/[id]/view/page.tsx:91` | `server/routes/admin.routes.ts:242` | Matched |
| Admin | PUT | `/api/admin/users/:param` | `client/src/app/admin/dashboard/users/[id]/edit/page.tsx:120` | `server/routes/admin.routes.ts:244` | Matched |
| Admin | POST | `/api/admin/users/:param/:param` | `client/src/app/admin/dashboard/users/page.tsx:106` | `server/routes/admin.routes.ts:246`<br>`server/routes/admin.routes.ts:247`<br>`server/routes/admin.routes.ts:248` | Matched |
| Admin | GET | `/api/admin/users/:param/ads` | `client/src/app/admin/dashboard/users/[id]/ads/page.tsx:52` | `server/routes/admin.routes.ts:267` | Matched |
| Admin | GET | `/api/admin/users/:param/brand-toolkits` | `client/src/app/admin/dashboard/users/[id]/brand-toolkits/page.tsx:50` | `server/routes/admin.routes.ts:265` | Matched |
| Admin | GET | `/api/admin/users/:param/campaigns` | `client/src/app/admin/dashboard/users/[id]/campaigns/page.tsx:48` | `server/routes/admin.routes.ts:259` | Matched |
| Admin | GET | `/api/admin/users/:param/chats` | `client/src/app/admin/dashboard/users/[id]/chats/page.tsx:45` | `server/routes/admin.routes.ts:260` | Matched |
| Admin | GET | `/api/admin/users/:param/chats/:param/messages` | `client/src/app/admin/dashboard/users/[id]/chat/[threadId]/page.tsx:39` | `server/routes/admin.routes.ts:261` | Matched |
| Admin | GET | `/api/admin/users/:param/content` | `client/src/app/admin/dashboard/users/[id]/content/page.tsx:97` | `server/routes/admin.routes.ts:264` | Matched |
| Admin | GET | `/api/admin/users/:param/icps` | `client/src/app/admin/dashboard/users/[id]/icps/page.tsx:45` | `server/routes/admin.routes.ts:263` | Matched |
| Admin | GET | `/api/admin/users/:param/knowledge-base` | `client/src/app/admin/dashboard/users/[id]/knowledge-base/page.tsx:88` | `server/routes/admin.routes.ts:268` | Matched |
| Admin | GET | `/api/admin/users/:param/leads` | `client/src/app/admin/dashboard/users/[id]/leads/page.tsx:45` | `server/routes/admin.routes.ts:262` | Matched |
| Admin | GET | `/api/admin/users/:param/modules` | `client/src/app/admin/dashboard/users/[id]/modules/page.tsx:33` | `server/routes/admin.routes.ts:250` | Matched |
| Admin | PUT | `/api/admin/users/:param/modules` | `client/src/app/admin/dashboard/users/[id]/modules/page.tsx:45` | `server/routes/admin.routes.ts:251` | Matched |
| Admin | GET | `/api/admin/users/:param/outreach/:param` | `client/src/components/admin/user-outreach-page.tsx:109` | `server/routes/admin.routes.ts:269` | Matched |
| Admin | PUT | `/api/admin/users/:param/password` | `client/src/app/admin/dashboard/users/[id]/update-password/page.tsx:69` | `server/routes/admin.routes.ts:249` | Matched |
| Admin | GET | `/api/admin/users/:param/templates` | `client/src/app/admin/dashboard/users/[id]/templates/page.tsx:46` | `server/routes/admin.routes.ts:266` | Matched |
| Admin | GET | `/api/admin/users/:param/usage` | `client/src/app/admin/dashboard/users/[id]/usage/page.tsx:64` | `server/routes/admin.routes.ts:337` | Matched |
| Admin | GET | `/api/admin/wallets` | `client/src/app/admin/dashboard/wallets/page.tsx:87` | `server/routes/admin.routes.ts:385` | Matched |
| Admin | POST | `/api/admin/wallets/:param/add-credits` | `client/src/app/admin/dashboard/wallets/page.tsx:124` | `server/routes/admin.routes.ts:387` | Matched |
| Admin | GET | `/api/admin/webhook-logs` | `client/src/app/admin/dashboard/webhook-logs/page.tsx:66` | `server/routes/admin.routes.ts:371` | Matched |
| User/public | GET | `/api/ai-visibility/audits/:param` | `client/src/lib/ai-visibility.ts:839` | `server/routes/aiVisibility.routes.ts:597` | Matched |
| User/public | POST | `/api/ai-visibility/audits/:param/cancel` | `client/src/lib/ai-visibility.ts:841` | `server/routes/aiVisibility.routes.ts:607` | Matched |
| User/public | POST | `/api/ai-visibility/audits/:param/report-deliveries` | `client/src/lib/ai-visibility.ts:1065` | `server/routes/aiVisibility.routes.ts:1006` | Matched |
| User/public | POST | `/api/ai-visibility/audits/:param/report-shares` | `client/src/lib/ai-visibility.ts:1074` | `server/routes/aiVisibility.routes.ts:1022` | Matched |
| User/public | POST | `/api/ai-visibility/audits/:param/report/retry` | `client/src/lib/ai-visibility.ts:843` | `server/routes/aiVisibility.routes.ts:617` | Matched |
| User/public | GET | `/api/ai-visibility/business-profiles` | `client/src/lib/ai-visibility.ts:801` | `server/routes/aiVisibility.routes.ts:322` | Matched |
| User/public | POST | `/api/ai-visibility/organizations` | `client/src/lib/ai-visibility.ts:730` | `server/routes/aiVisibility.routes.ts:260` | Matched |
| User/public | PATCH | `/api/ai-visibility/organizations/:param` | `client/src/lib/ai-visibility.ts:741` | `server/routes/aiVisibility.routes.ts:260` | Matched |
| User/public | GET | `/api/ai-visibility/projects` | `client/src/components/content-library/BlogCmsReviewHandoff.tsx:20`<br>`client/src/lib/ai-visibility.ts:723` | `server/routes/aiVisibility.routes.ts:215` | Matched |
| User/public | POST | `/api/ai-visibility/projects` | `client/src/lib/ai-visibility.ts:819` | `server/routes/aiVisibility.routes.ts:332` | Matched |
| User/public | DELETE | `/api/ai-visibility/projects/:param` | `client/src/lib/ai-visibility.ts:823` | `server/routes/aiVisibility.routes.ts:410` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param` | `client/src/lib/ai-visibility.ts:821` | `server/routes/aiVisibility.routes.ts:376` | Matched |
| User/public | PATCH | `/api/ai-visibility/projects/:param` | `client/src/lib/ai-visibility.ts:679` | `server/routes/aiVisibility.routes.ts:396` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/:param:param` | `client/src/lib/ai-visibility.ts:862` | `server/routes/aiVisibility.routes.ts:420`<br>`server/routes/aiVisibility.routes.ts:476`<br>`server/routes/aiVisibility.routes.ts:511` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/aeo/coverage:param` | `client/src/lib/ai-visibility.ts:878` | Manual mount/route review | Dynamic review |
| User/public | GET | `/api/ai-visibility/projects/:param/aeo/questions` | `client/src/lib/ai-visibility.ts:868` | `server/routes/aiVisibility.routes.ts:743` | Matched |
| User/public | POST | `/api/ai-visibility/projects/:param/aeo/questions` | `client/src/lib/ai-visibility.ts:891` | `server/routes/aiVisibility.routes.ts:763` | Matched |
| User/public | PATCH | `/api/ai-visibility/projects/:param/aeo/questions/:param` | `client/src/lib/ai-visibility.ts:901` | `server/routes/aiVisibility.routes.ts:780` | Matched |
| User/public | POST | `/api/ai-visibility/projects/:param/aeo/questions/:param/assets` | `client/src/lib/ai-visibility.ts:907` | `server/routes/aiVisibility.routes.ts:804` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/alerts` | `client/src/lib/ai-visibility.ts:1055` | `server/routes/aiVisibility.routes.ts:1281` | Matched |
| User/public | PATCH | `/api/ai-visibility/projects/:param/alerts/:param` | `client/src/lib/ai-visibility.ts:1057` | `server/routes/aiVisibility.routes.ts:1291` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/asset-approvals` | `client/src/lib/ai-visibility.ts:998` | `server/routes/aiVisibility.routes.ts:1160` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/assets` | `client/src/lib/ai-visibility.ts:996` | `server/routes/aiVisibility.routes.ts:1141` | Matched |
| User/public | PATCH | `/api/ai-visibility/projects/:param/assets/:param` | `client/src/lib/ai-visibility.ts:694` | `server/routes/aiVisibility.routes.ts:1118` | Matched |
| User/public | PATCH | `/api/ai-visibility/projects/:param/assets/:param/approval` | `client/src/lib/ai-visibility.ts:1008` | `server/routes/aiVisibility.routes.ts:1173` | Matched |
| User/public | POST | `/api/ai-visibility/projects/:param/assets/:param/cms-drafts` | `client/src/lib/ai-visibility.ts:1050` | `server/routes/aiVisibility.routes.ts:1254` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/assets/:param/versions` | `client/src/lib/ai-visibility.ts:687` | `server/routes/aiVisibility.routes.ts:1104` | Matched |
| User/public | POST | `/api/ai-visibility/projects/:param/assets/import-blog` | `client/src/components/content-library/BlogCmsReviewHandoff.tsx:28` | `server/routes/aiVisibility.routes.ts:1151` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/assignees` | `client/src/lib/ai-visibility.ts:683` | `server/routes/aiVisibility.routes.ts:1094` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/audits` | `client/src/components/content-library/BlogCmsReviewHandoff.tsx:22`<br>`client/src/lib/ai-visibility.ts:837` | `server/routes/aiVisibility.routes.ts:576` | Matched |
| User/public | POST | `/api/ai-visibility/projects/:param/audits` | `client/src/lib/ai-visibility.ts:831` | `server/routes/aiVisibility.routes.ts:529` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/audits/estimate` | `client/src/lib/ai-visibility.ts:827` | `server/routes/aiVisibility.routes.ts:519` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/cms-connections` | `client/src/lib/ai-visibility.ts:1014` | `server/routes/aiVisibility.routes.ts:1200` | Matched |
| User/public | DELETE | `/api/ai-visibility/projects/:param/cms-connections/:param` | `client/src/lib/ai-visibility.ts:1039` | `server/routes/aiVisibility.routes.ts:1229` | Matched |
| User/public | PUT | `/api/ai-visibility/projects/:param/cms-connections/:param` | `client/src/lib/ai-visibility.ts:1034` | `server/routes/aiVisibility.routes.ts:1210` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/cms-publish-attempts` | `client/src/lib/ai-visibility.ts:1041` | `server/routes/aiVisibility.routes.ts:1244` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/commerce` | `client/src/lib/ai-visibility.ts:912` | `server/routes/aiVisibility.routes.ts:835` | Matched |
| User/public | POST | `/api/ai-visibility/projects/:param/commerce/feeds` | `client/src/lib/ai-visibility.ts:923` | `server/routes/aiVisibility.routes.ts:863` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/commerce/products` | `client/src/lib/ai-visibility.ts:705` | `server/routes/aiVisibility.routes.ts:843` | Matched |
| User/public | POST | `/api/ai-visibility/projects/:param/commerce/shopify/sync` | `client/src/lib/ai-visibility.ts:926` | `server/routes/aiVisibility.routes.ts:888` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/competitor-intelligence:param` | `client/src/lib/ai-visibility.ts:946` | Manual mount/route review | Dynamic review |
| User/public | POST | `/api/ai-visibility/projects/:param/competitor-intelligence/briefs` | `client/src/lib/ai-visibility.ts:953` | `server/routes/aiVisibility.routes.ts:490` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/competitors` | `client/src/lib/ai-visibility.ts:930` | `server/routes/aiVisibility.routes.ts:420` | Matched |
| User/public | POST | `/api/ai-visibility/projects/:param/competitors` | `client/src/lib/ai-visibility.ts:958` | `server/routes/aiVisibility.routes.ts:430` | Matched |
| User/public | PATCH | `/api/ai-visibility/projects/:param/competitors/:param` | `client/src/lib/ai-visibility.ts:968` | `server/routes/aiVisibility.routes.ts:448` | Matched |
| User/public | DELETE | `/api/ai-visibility/projects/:param/gsc` | `client/src/lib/ai-visibility.ts:860` | `server/routes/aiVisibility.routes.ts:725` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/gsc` | `client/src/lib/ai-visibility.ts:851` | `server/routes/aiVisibility.routes.ts:662` | Matched |
| User/public | POST | `/api/ai-visibility/projects/:param/gsc/auth-url` | `client/src/lib/ai-visibility.ts:855` | `server/routes/aiVisibility.routes.ts:678` | Matched |
| User/public | PUT | `/api/ai-visibility/projects/:param/gsc/property` | `client/src/lib/ai-visibility.ts:857` | `server/routes/aiVisibility.routes.ts:686` | Matched |
| User/public | POST | `/api/ai-visibility/projects/:param/gsc/sync` | `client/src/lib/ai-visibility.ts:859` | `server/routes/aiVisibility.routes.ts:703` | Matched |
| User/public | PATCH | `/api/ai-visibility/projects/:param/monitoring` | `client/src/lib/ai-visibility.ts:1088` | `server/routes/aiVisibility.routes.ts:1316` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/overview:param` | `client/src/lib/ai-visibility.ts:825` | Manual mount/route review | Dynamic review |
| User/public | GET | `/api/ai-visibility/projects/:param/providers` | `client/src/lib/ai-visibility.ts:681` | `server/routes/aiVisibility.routes.ts:511` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/recommendations:param` | `client/src/lib/ai-visibility.ts:970` | Manual mount/route review | Dynamic review |
| User/public | PATCH | `/api/ai-visibility/projects/:param/recommendations/:param` | `client/src/lib/ai-visibility.ts:985` | `server/routes/aiVisibility.routes.ts:912` | Matched |
| User/public | POST | `/api/ai-visibility/projects/:param/recommendations/:param/assets` | `client/src/lib/ai-visibility.ts:990` | `server/routes/aiVisibility.routes.ts:937` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/report-deliveries` | `client/src/lib/ai-visibility.ts:1061` | `server/routes/aiVisibility.routes.ts:996` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/report-shares` | `client/src/lib/ai-visibility.ts:1070` | `server/routes/aiVisibility.routes.ts:986` | Matched |
| User/public | DELETE | `/api/ai-visibility/projects/:param/report-shares/:param` | `client/src/lib/ai-visibility.ts:1079` | `server/routes/aiVisibility.routes.ts:1037` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/reports` | `client/src/lib/ai-visibility.ts:1059` | `server/routes/aiVisibility.routes.ts:976` | Matched |
| User/public | GET | `/api/ai-visibility/projects/:param/seo:param` | `client/src/lib/ai-visibility.ts:845` | Manual mount/route review | Dynamic review |
| User/public | POST | `/api/ai-visibility/projects/:param/suggest-competitors` | `client/src/lib/ai-visibility.ts:940` | `server/routes/aiVisibility.routes.ts:468` | Matched |
| User/public | POST | `/api/ai-visibility/projects/resolve` | `client/src/lib/ai-visibility.ts:803` | `server/routes/aiVisibility.routes.ts:309` | Matched |
| User/public | POST | `/api/ai-visibility/prompt-runs/:param/corrections` | `client/src/lib/ai-visibility.ts:994` | `server/routes/aiVisibility.routes.ts:964` | Matched |
| User/public | GET | `/api/ai-visibility/website-searches` | `client/src/lib/ai-visibility.ts:787` | `server/routes/aiVisibility.routes.ts:286` | Matched |
| User/public | POST | `/api/ai-visibility/website-searches` | `client/src/lib/ai-visibility.ts:796` | `server/routes/aiVisibility.routes.ts:296` | Matched |
| User/public | GET | `/api/ai-visibility/workspaces` | `client/src/lib/ai-visibility.ts:725` | `server/routes/aiVisibility.routes.ts:250` | Matched |
| User/public | PATCH | `/api/ai-visibility/workspaces/:param` | `client/src/lib/ai-visibility.ts:754` | `server/routes/aiVisibility.routes.ts:263` | Matched |
| User/public | POST | `/api/ai-visibility/workspaces/:param/members` | `client/src/lib/ai-visibility.ts:762` | `server/routes/aiVisibility.routes.ts:260` | Matched |
| User/public | PATCH | `/api/ai-visibility/workspaces/:param/members/:param` | `client/src/lib/ai-visibility.ts:779` | `server/routes/aiVisibility.routes.ts:260` | Matched |
| User/public | GET | `/api/approvals/:param` | `client/src/services/workflowApi.ts:140` | `server/routes.ts:413` | Matched |
| User/public | POST | `/api/approvals/:param/approve` | `client/src/services/workflowApi.ts:88` | `server/routes.ts:414` | Matched |
| User/public | POST | `/api/approvals/:param/reject` | `client/src/services/workflowApi.ts:88` | `server/routes.ts:415` | Matched |
| Admin | GET | `/api/auth/csrf-token` | `client/src/app/admin/login/page.tsx:25`<br>`client/src/app/support/login/page.tsx:29`<br>`client/src/components/SupportDashboardLayout.tsx:32`<br>`client/src/components/admin/AdminDashboardLayout.tsx:81`<br>+1 more | `server/routes/auth.routes.ts:35` | Matched |
| User/public | POST | `/api/auth/forgot-password` | `client/src/app/forgot-password/page.tsx:35` | `server/routes/auth.routes.ts:41` | Matched |
| User/public | POST | `/api/auth/google` | `client/src/components/auth/ClientAuthPage.tsx:228` | `server/routes/auth.routes.ts:38` | Matched |
| User/public | POST | `/api/auth/login` | `client/src/components/auth/ClientAuthPage.tsx:285` | `server/routes/auth.routes.ts:37` | Matched |
| User/public | POST | `/api/auth/logout` | `client/src/contexts/AuthContext.tsx:171` | `server/routes/auth.routes.ts:39` | Matched |
| User/public | POST | `/api/auth/mark-setup-complete` | `client/src/components/setup/BrandToolkitSetup.tsx:437` | `server/routes/auth.routes.ts:48` | Matched |
| User/public | GET | `/api/auth/me` | `client/src/contexts/AuthContext.tsx:90` | `server/routes/auth.routes.ts:46` | Matched |
| User/public | POST | `/api/auth/register` | `client/src/components/auth/ClientAuthPage.tsx:332` | `server/routes/auth.routes.ts:36` | Matched |
| User/public | POST | `/api/auth/resend-verification` | `client/src/app/verify-email/page.tsx:57` | `server/routes/auth.routes.ts:43` | Matched |
| User/public | POST | `/api/auth/reset-password` | `client/src/app/reset-password/page.tsx:36` | `server/routes/auth.routes.ts:42` | Matched |
| User/public | POST | `/api/auth/verify-email` | `client/src/app/verify-email/page.tsx:41` | `server/routes/auth.routes.ts:40` | Matched |
| User/public | GET | `/api/campaigns/accounts` | `client/src/components/performance-marketing/CampaignDetailPage.tsx:164`<br>`client/src/components/performance-marketing/PaidAdAccountSelector.tsx:15` | `server/routes/campaigns.routes.ts:134`<br>`server/routes/campaigns.routes.ts:220` | Matched |
| User/public | GET | `/api/campaigns/accounts/:param/google-diagnostics/:param` | `client/src/components/performance-marketing/CampaignDetailPage.tsx:402` | `server/routes/campaigns.routes.ts:137` | Matched |
| User/public | POST | `/api/campaigns/accounts/:param/refresh` | `client/src/app/dashboard/(main)/ads-analytics/page.tsx:159`<br>`client/src/components/performance-marketing/CampaignDetailPage.tsx:169`<br>`client/src/components/performance-marketing/UnifiedCampaignInventory.tsx:64` | `server/routes/campaigns.routes.ts:136` | Matched |
| User/public | POST | `/api/campaigns/accounts/discover` | `client/src/components/performance-marketing/PaidAdAccountSelector.tsx:22` | `server/routes/campaigns.routes.ts:135` | Matched |
| User/public | GET | `/api/campaigns/analytics/dashboard` | `client/src/hooks/usePaidAdsDashboard.ts:25` | `server/routes/campaigns.routes.ts:163`<br>`server/routes/campaigns.routes.ts:165` | Matched |
| User/public | POST | `/api/campaigns/analytics/fetch-now` | `client/src/app/dashboard/(main)/ads-analytics/page.tsx:167` | `server/routes/campaigns.routes.ts:171` | Matched |
| User/public | GET | `/api/campaigns/analytics/provider/:param/:param` | `client/src/app/dashboard/(main)/ads-analytics/page.tsx:191` | `server/routes/campaigns.routes.ts:164` | Matched |
| User/public | GET | `/api/campaigns/autonomous` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:490` | `server/routes/campaigns.routes.ts:144`<br>`server/routes/campaigns.routes.ts:220` | Matched |
| User/public | POST | `/api/campaigns/autonomous` | `client/src/app/dashboard/(main)/saved-templates/ads/publish/page.tsx:672`<br>`client/src/app/dashboard/(main)/saved-templates/ads/publish/page.tsx:766`<br>`client/src/components/modals/PublishCampaignModal.tsx:738`<br>`client/src/components/modals/PublishCampaignModal.tsx:878` | `server/routes/campaigns.routes.ts:145` | Matched |
| User/public | GET | `/api/campaigns/autonomous/:param/google-diagnostics` | `client/src/components/performance-marketing/CampaignDetailPage.tsx:402` | `server/routes/campaigns.routes.ts:151` | Matched |
| User/public | POST | `/api/campaigns/autonomous/:param/improved-version` | `client/src/app/dashboard/(main)/ads-analytics/page.tsx:287`<br>`client/src/app/dashboard/(main)/ads-campaigns/page.tsx:354` | `server/routes/campaigns.routes.ts:154` | Matched |
| User/public | GET | `/api/campaigns/autonomous/:param/performance` | `client/src/app/dashboard/(main)/ads-analytics/page.tsx:182`<br>`client/src/app/dashboard/(main)/ads-campaigns/page.tsx:330`<br>`client/src/components/performance-marketing/CampaignWorkflowList.tsx:51` | `server/routes/campaigns.routes.ts:150` | Matched |
| User/public | PUT | `/api/campaigns/autonomous/:param/policy` | `client/src/app/dashboard/(main)/ads-analytics/page.tsx:265`<br>`client/src/components/performance-marketing/CampaignDetailPage.tsx:180`<br>`client/src/components/performance-marketing/CampaignWorkflowList.tsx:52` | `server/routes/campaigns.routes.ts:149` | Matched |
| User/public | PATCH | `/api/campaigns/autonomous/:param/recommendations/:param` | `client/src/app/dashboard/(main)/ads-analytics/page.tsx:271`<br>`client/src/components/performance-marketing/CampaignDetailPage.tsx:285` | `server/routes/campaigns.routes.ts:153` | Matched |
| User/public | POST | `/api/campaigns/autonomous/:param/targets/:param/:param/resume` | `client/src/app/dashboard/(main)/ads-analytics/page.tsx:280` | `server/routes/campaigns.routes.ts:155` | Matched |
| User/public | POST | `/api/campaigns/autonomous/import-provider` | `client/src/app/dashboard/(main)/ads-analytics/page.tsx:297`<br>`client/src/components/performance-marketing/CampaignDetailPage.tsx:149`<br>`client/src/components/performance-marketing/CampaignWorkflowList.tsx:48` | `server/routes/campaigns.routes.ts:146` | Matched |
| User/public | POST | `/api/campaigns/autonomous/infer-objective` | `client/src/app/dashboard/(main)/saved-templates/ads/publish/page.tsx:420`<br>`client/src/components/modals/PublishCampaignModal.tsx:364` | `server/routes/campaigns.routes.ts:143` | Matched |
| User/public | GET | `/api/campaigns/meta/account/insights` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:575` | `server/routes/campaigns.routes.ts:199` | Matched |
| User/public | DELETE | `/api/campaigns/meta/ads/:param` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:852` | `server/routes/campaigns.routes.ts:214` | Matched |
| User/public | POST | `/api/campaigns/meta/ads/:param/pause` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:908` | `server/routes/campaigns.routes.ts:212` | Matched |
| User/public | POST | `/api/campaigns/meta/ads/:param/resume` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:919` | `server/routes/campaigns.routes.ts:213` | Matched |
| User/public | DELETE | `/api/campaigns/meta/adsets/:param` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:841`<br>`client/src/components/tabs/CampaignsTab.tsx:276` | `server/routes/campaigns.routes.ts:211` | Matched |
| User/public | POST | `/api/campaigns/meta/adsets/:param/pause` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:872` | `server/routes/campaigns.routes.ts:209` | Matched |
| User/public | POST | `/api/campaigns/meta/adsets/:param/resume` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:888` | `server/routes/campaigns.routes.ts:210` | Matched |
| User/public | GET | `/api/campaigns/meta/cache/campaigns` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:396`<br>`client/src/components/tabs/CampaignsTab.tsx:149` | `server/routes/campaigns.routes.ts:200` | Matched |
| User/public | GET | `/api/campaigns/meta/cache/campaigns/:param/adsets` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:668`<br>`client/src/components/tabs/CampaignsTab.tsx:217` | `server/routes/campaigns.routes.ts:201` | Matched |
| User/public | POST | `/api/campaigns/meta/cache/refresh` | `client/src/app/dashboard/(main)/ads-analytics/page.tsx:168`<br>`client/src/app/dashboard/(main)/ads-campaigns/page.tsx:541`<br>`client/src/components/tabs/CampaignsTab.tsx:202` | `server/routes/campaigns.routes.ts:202` | Matched |
| User/public | GET | `/api/campaigns/meta/campaigns` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:474`<br>`client/src/components/tabs/CampaignsTab.tsx:177` | `server/routes/campaigns.routes.ts:196` | Matched |
| User/public | DELETE | `/api/campaigns/meta/campaigns/:param` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:835`<br>`client/src/components/tabs/CampaignsTab.tsx:264` | `server/routes/campaigns.routes.ts:208` | Matched |
| User/public | GET | `/api/campaigns/meta/campaigns/:param/adsets` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:715`<br>`client/src/components/tabs/CampaignsTab.tsx:222` | `server/routes/campaigns.routes.ts:197` | Matched |
| User/public | POST | `/api/campaigns/meta/campaigns/:param/pause` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:802`<br>`client/src/components/tabs/CampaignsTab.tsx:240` | `server/routes/campaigns.routes.ts:206` | Matched |
| User/public | POST | `/api/campaigns/meta/campaigns/:param/resume` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:815`<br>`client/src/components/tabs/CampaignsTab.tsx:252` | `server/routes/campaigns.routes.ts:207` | Matched |
| User/public | POST | `/api/campaigns/performance/budget-plan` | `client/src/components/PerformanceMarketingDashboard.tsx:159` | `server/routes/campaigns.routes.ts:177` | Matched |
| User/public | GET | `/api/campaigns/performance/campaigns` | `client/src/components/PerformanceMarketingDashboard.tsx:136`<br>`client/src/components/tabs/CampaignsTab.tsx:120` | `server/routes/campaigns.routes.ts:186` | Matched |
| User/public | POST | `/api/campaigns/performance/generate` | `client/src/components/PerformanceMarketingDashboard.tsx:194` | `server/routes/campaigns.routes.ts:178` | Matched |
| User/public | POST | `/api/campaigns/performance/optimize` | `client/src/components/PerformanceMarketingDashboard.tsx:233` | `server/routes/campaigns.routes.ts:179` | Matched |
| User/public | GET | `/api/channel-accounts/:param` | `client/src/components/integrations/ChannelAccountSelector.tsx:96` | `server/routes.ts:420` | Matched |
| User/public | GET | `/api/channel-accounts/:param_api` | `client/src/components/widgets/SendOutreachWidget.tsx:63` | `server/routes.ts:420` | Matched |
| User/public | DELETE | `/api/channel-accounts/:param/:param` | `client/src/components/integrations/ChannelAccountSelector.tsx:305` | `server/routes.ts:422` | Matched |
| User/public | POST | `/api/channel-accounts/:param/select` | `client/src/app/dashboard/(main)/marketing/analytics/page.tsx:634`<br>`client/src/components/integrations/ChannelAccountSelector.tsx:133` | `server/routes.ts:421` | Matched |
| User/public | GET | `/api/channel-accounts/youtube` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:76` | `server/routes.ts:420` | Matched |
| User/public | POST | `/api/channel-accounts/youtube/select` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:89` | `server/routes.ts:421` | Matched |
| User/public | POST | `/api/chat/langgraph/action` | `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:2426`<br>`client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:2447`<br>`client/src/components/ChatInterface.tsx:501`<br>`client/src/components/tabs/LeadsTab.tsx:957`<br>+1 more | `server/routes/chat.routes.ts:131` | Matched |
| User/public | POST | `/api/chat/langgraph/approve` | `client/src/hooks/useToolExecution.ts:39` | `server/routes/chat.routes.ts:128` | Matched |
| User/public | POST | `/api/chat/langgraph/message` | `client/src/hooks/useChat.ts:204` | `server/routes/chat.routes.ts:124` | Matched |
| User/public | GET | `/api/chat/langgraph/state/:param` | `client/src/components/tabs/LeadsTab.tsx:552` | `server/routes/chat.routes.ts:130` | Matched |
| User/public | POST | `/api/chat/langgraph/switch-agent` | `client/src/components/ChatInterface.tsx:359` | `server/routes/chat.routes.ts:129` | Matched |
| User/public | GET | `/api/chat/threads` | `client/src/app/dashboard/(main)/chats/page.tsx:133`<br>`client/src/app/dashboard/(main)/home/page.tsx:318`<br>`client/src/app/dashboard/(main)/home/page.tsx:339`<br>`client/src/components/CampaignHistorySidebar.tsx:68`<br>+1 more | `server/routes/chat.routes.ts:74` | Matched |
| User/public | POST | `/api/chat/threads` | `client/src/app/dashboard/(main)/home/page.tsx:255` | `server/routes/chat.routes.ts:75` | Matched |
| User/public | DELETE | `/api/chat/threads/:param` | `client/src/app/dashboard/(main)/chats/page.tsx:155`<br>`client/src/components/CampaignHistorySidebar.tsx:101` | `server/routes/chat.routes.ts:82` | Matched |
| User/public | GET | `/api/chat/threads/:param` | `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:1441`<br>`client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:1953`<br>`client/src/components/content-library/useContentLibrary.ts:17` | `server/routes/chat.routes.ts:76` | Matched |
| User/public | PATCH | `/api/chat/threads/:param` | `client/src/components/CampaignHistorySidebar.tsx:138` | `server/routes/chat.routes.ts:81` | Matched |
| User/public | PUT | `/api/chat/threads/:param/active-tab` | `client/src/hooks/useInlineWidgets.ts:279`<br>`client/src/hooks/useInlineWidgets.ts:404` | `server/routes/chat.routes.ts:110` | Matched |
| User/public | POST | `/api/chat/threads/:param/compact` | `client/src/components/chat/ChatContextWindow.tsx:184` | `server/routes/chat.routes.ts:89` | Matched |
| User/public | GET | `/api/chat/threads/:param/context-window` | `client/src/components/chat/ChatContextWindow.tsx:120` | `server/routes/chat.routes.ts:88` | Matched |
| User/public | GET | `/api/chat/threads/:param/details` | `client/src/components/CampaignDashboardView.tsx:116`<br>`client/src/components/CampaignDetailView.tsx:103` | `server/routes/chat.routes.ts:78` | Matched |
| User/public | PUT | `/api/chat/threads/:param/lead-inputs` | `client/src/components/tabs/LeadsInputsTab.tsx:324` | `server/routes/chat.routes.ts:115` | Matched |
| User/public | DELETE | `/api/chat/threads/:param/lead-inputs/:param` | `client/src/components/tabs/LeadsInputsTab.tsx:338` | `server/routes/chat.routes.ts:116` | Matched |
| User/public | GET | `/api/chat/threads/:param/messages` | `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:1473`<br>`client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:2021`<br>`client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:2147`<br>`client/src/components/modals/PublishCampaignModal.tsx:339` | `server/routes/chat.routes.ts:83` | Matched |
| User/public | GET | `/api/chat/threads/:param/overview` | `client/src/components/tabs/CampaignsTab.tsx:94`<br>`client/src/components/tabs/OverviewTab.tsx:108` | `server/routes/chat.routes.ts:79` | Matched |
| User/public | GET | `/api/chat/threads/:param/scraping-details/latest` | `client/src/components/tabs/LeadsTab.tsx:510` | `server/routes/chat.routes.ts:117` | Matched |
| User/public | POST | `/api/chat/threads/:param/stop` | `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:2689` | `server/routes/chat.routes.ts:70` | Matched |
| User/public | GET | `/api/chat/threads/:param/tabs` | `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:1742` | `server/routes/chat.routes.ts:106` | Matched |
| User/public | POST | `/api/chat/threads/:param/tabs` | `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:1805`<br>`client/src/hooks/useInlineWidgets.ts:257`<br>`client/src/hooks/useInlineWidgets.ts:327` | `server/routes/chat.routes.ts:108` | Matched |
| User/public | PUT | `/api/chat/threads/:param/tabs` | `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:1785`<br>`client/src/hooks/useInlineWidgets.ts:445` | `server/routes/chat.routes.ts:109` | Matched |
| User/public | GET | `/api/chat/threads/:param/turns` | `client/src/hooks/useChat.ts:83` | `server/routes/chat.routes.ts:69` | Matched |
| User/public | GET | `/api/chat/threads/campaigns` | `client/src/components/CampaignsSidebar.tsx:36` | `server/routes/chat.routes.ts:76` | Matched |
| User/public | GET | `/api/content/assets` | `client/src/app/dashboard/(main)/saved-templates/ads/page.tsx:94`<br>`client/src/app/dashboard/(main)/saved-templates/ads/publish/page.tsx:292`<br>`client/src/app/dashboard/(main)/saved-templates/blog/page.tsx:95`<br>`client/src/app/dashboard/(main)/saved-templates/dm/page.tsx:127`<br>+8 more | `server/routes/content.routes.ts:204` | Matched |
| User/public | POST | `/api/content/assets` | `client/src/components/content-library/DraftLibraryCard.tsx:73`<br>`client/src/components/content-studio/GeneratorMode.tsx:262`<br>`client/src/components/content-studio/creators/SocialCreator.tsx:328`<br>`client/src/components/modals/CreatePostModal.tsx:510` | `server/routes/content.routes.ts:207` | Matched |
| User/public | DELETE | `/api/content/assets/:param` | `client/src/app/dashboard/(main)/content-calendar/page.tsx:436`<br>`client/src/app/dashboard/(main)/saved-templates/image/page.tsx:135`<br>`client/src/app/dashboard/(main)/saved-templates/video/page.tsx:151`<br>`client/src/components/content-library/DraftLibraryCard.tsx:103`<br>+8 more | `server/routes/content.routes.ts:209` | Matched |
| User/public | GET | `/api/content/assets/:param` | `client/src/app/dashboard/(main)/content-calendar/page.tsx:222`<br>`client/src/components/content-library/BlogCmsReviewHandoff.tsx:19`<br>`client/src/components/content-library/DraftLibraryCard.tsx:65`<br>`client/src/components/content-library/DraftLibraryCard.tsx:71`<br>+14 more | `server/routes/content.routes.ts:205`<br>`server/routes/content.routes.ts:206` | Matched |
| User/public | PUT | `/api/content/assets/:param` | `client/src/app/dashboard/(main)/saved-templates/email/page.tsx:354`<br>`client/src/components/MediaManager.tsx:113`<br>`client/src/components/content-library/DraftLibraryCard.tsx:128`<br>`client/src/components/content-studio/AttachMediaToDraft.tsx:44`<br>+6 more | `server/routes/content.routes.ts:208` | Matched |
| User/public | POST | `/api/content/assets/:param/publish` | `client/src/components/social-publishing/SocialPublisher.tsx:347` | `server/routes/content.routes.ts:211` | Matched |
| User/public | GET | `/api/content/assets/:param/publish-attempts` | `client/src/app/dashboard/(main)/content-calendar/page.tsx:316`<br>`client/src/components/social-publishing/SocialPublisher.tsx:156`<br>`client/src/hooks/useSocialPublishReceipt.ts:17` | `server/routes/content.routes.ts:215` | Matched |
| User/public | POST | `/api/content/assets/:param/publish-attempts/:param/recover` | `client/src/app/dashboard/(main)/content-calendar/page.tsx:541` | `server/routes/content.routes.ts:217` | Matched |
| User/public | POST | `/api/content/assets/:param/reschedule` | `client/src/app/dashboard/(main)/content-calendar/page.tsx:483` | `server/routes/content.routes.ts:212` | Matched |
| User/public | GET | `/api/content/assets/counts` | `client/src/hooks/use-content-counts.ts:17` | `server/routes/content.routes.ts:205`<br>`server/routes/content.routes.ts:206` | Matched |
| User/public | POST | `/api/content/assets/upload` | `client/src/app/dashboard/(main)/saved-templates/ads/page.tsx:173`<br>`client/src/app/dashboard/(main)/saved-templates/ads/page.tsx:185`<br>`client/src/app/dashboard/(main)/saved-templates/dm/page.tsx:205`<br>`client/src/app/dashboard/(main)/saved-templates/social/page.tsx:292`<br>+5 more | `server/routes/content.routes.ts:210` | Matched |
| User/public | GET | `/api/content/brand-toolkits` | `client/src/app/dashboard/(main)/brand-toolkit/page.tsx:64`<br>`client/src/components/BrandToolkitForm.tsx:258`<br>`client/src/components/BrandToolkitSelectorModal.tsx:48`<br>`client/src/components/content-library/useContentLibrary.ts:16`<br>+2 more | `server/routes/content.routes.ts:176` | Matched |
| User/public | POST | `/api/content/brand-toolkits` | `client/src/components/BrandToolkitForm.tsx:467`<br>`client/src/components/BrandToolkitModal.tsx:185`<br>`client/src/components/setup/BrandToolkitSetup.tsx:425` | `server/routes/content.routes.ts:180` | Matched |
| User/public | DELETE | `/api/content/brand-toolkits/:param` | `client/src/app/dashboard/(main)/brand-toolkit/page.tsx:68` | `server/routes/content.routes.ts:182` | Matched |
| User/public | GET | `/api/content/brand-toolkits/:param` | `client/src/components/BrandToolkitForm.tsx:252` | `server/routes/content.routes.ts:177`<br>`server/routes/content.routes.ts:178`<br>`server/routes/content.routes.ts:179` | Matched |
| User/public | PUT | `/api/content/brand-toolkits/:param` | `client/src/components/BrandToolkitForm.tsx:462`<br>`client/src/components/BrandToolkitModal.tsx:182`<br>`client/src/components/setup/BrandToolkitSetup.tsx:412` | `server/routes/content.routes.ts:181` | Matched |
| User/public | POST | `/api/content/brand-toolkits/:param/default` | `client/src/app/dashboard/(main)/brand-toolkit/page.tsx:80` | `server/routes/content.routes.ts:183` | Matched |
| User/public | GET | `/api/content/brand-toolkits/default` | `client/src/app/dashboard/(main)/saved-templates/ads/publish/page.tsx:291` | `server/routes/content.routes.ts:178`<br>`server/routes/content.routes.ts:179` | Matched |
| User/public | POST | `/api/content/brand-toolkits/upload-image` | `client/src/components/setup/BrandImagesStep.tsx:117` | `server/routes/content.routes.ts:186` | Matched |
| User/public | GET | `/api/content/calendar` | `client/src/app/dashboard/(main)/content-calendar/page.tsx:266` | `server/routes/content.routes.ts:166` | Matched |
| User/public | DELETE | `/api/content/calendar/:param` | `client/src/app/dashboard/(main)/content-calendar/page.tsx:438` | `server/routes/content.routes.ts:171` | Matched |
| User/public | PUT | `/api/content/calendar/:param` | `client/src/app/dashboard/(main)/content-calendar/page.tsx:490` | `server/routes/content.routes.ts:169` | Matched |
| User/public | POST | `/api/content/calendar/bulk` | `client/src/app/dashboard/(main)/content-calendar/page.tsx:522` | `server/routes/content.routes.ts:172` | Matched |
| User/public | POST | `/api/content/generate-email-template` | `client/src/app/dashboard/(main)/saved-templates/email/page.tsx:319` | `server/routes/content.routes.ts:163` | Matched |
| User/public | GET | `/api/content/publishing/accounts` | `client/src/components/widgets/PublishPostWidget.tsx:159`<br>`client/src/hooks/useOrganicPublishingAccounts.ts:24` | `server/routes/content.routes.ts:214` | Matched |
| User/public | POST | `/api/content/studio/ad-copy-content` | `client/src/app/dashboard/(main)/saved-templates/ads/page.tsx:128`<br>`client/src/components/content-studio/creators/AdCreator.tsx:257` | `server/routes/content.routes.ts:158` | Matched |
| User/public | POST | `/api/content/studio/blog-post` | `client/src/app/dashboard/(main)/saved-templates/blog/page.tsx:128`<br>`client/src/components/content-studio/creators/BlogCreator.tsx:282`<br>`client/src/components/content-studio/creators/BlogCreator.tsx:323` | `server/routes/content.routes.ts:160` | Matched |
| User/public | POST | `/api/content/studio/email` | `client/src/components/OutreachDialog.tsx:106`<br>`client/src/components/content-studio/creators/EmailCreator.tsx:210`<br>`client/src/components/modals/SendEmailModal.tsx:188` | `server/routes/content.routes.ts:154` | Matched |
| User/public | POST | `/api/content/studio/enhance-prompt` | `client/src/components/content-cards/AdCopyCard.tsx:269`<br>`client/src/components/content-cards/AdCopyCard.tsx:292`<br>`client/src/components/content-cards/EmailCard.tsx:139`<br>`client/src/components/content-cards/EmailCard.tsx:163`<br>+6 more | `server/routes/content.routes.ts:161` | Matched |
| User/public | GET | `/api/content/studio/estimates` | `client/src/components/content-studio/GenerationEstimate.tsx:8`<br>`client/src/components/content-studio/SmsSendingEstimate.tsx:8` | `server/routes/content.routes.ts:137` | Matched |
| User/public | POST | `/api/content/studio/image` | `client/src/app/dashboard/(main)/saved-templates/ads/page.tsx:144`<br>`client/src/app/dashboard/(main)/saved-templates/dm/page.tsx:178`<br>`client/src/app/dashboard/(main)/saved-templates/email/page.tsx:344`<br>`client/src/app/dashboard/(main)/saved-templates/sms/page.tsx:197`<br>+3 more | `server/routes/content.routes.ts:150` | Matched |
| User/public | POST | `/api/content/studio/magic-prompt` | `client/src/components/ChatInterface.tsx:770`<br>`client/src/components/MediaManager.tsx:183`<br>`client/src/components/content-studio/creators/AdCreator.tsx:391`<br>`client/src/components/content-studio/creators/BlogCreator.tsx:397`<br>+9 more | `server/routes/content.routes.ts:159` | Matched |
| User/public | POST | `/api/content/studio/sms` | `client/src/app/dashboard/(main)/saved-templates/sms/page.tsx:178`<br>`client/src/components/content-studio/creators/SmsCreator.tsx:207` | `server/routes/content.routes.ts:155` | Matched |
| User/public | POST | `/api/content/studio/social` | `client/src/app/dashboard/(main)/saved-templates/social/page.tsx:216`<br>`client/src/components/content-studio/creators/SocialCreator.tsx:492`<br>`client/src/components/modals/CreatePostModal.tsx:343` | `server/routes/content.routes.ts:156` | Matched |
| User/public | POST | `/api/content/studio/social-message` | `client/src/app/dashboard/(main)/saved-templates/dm/page.tsx:163`<br>`client/src/components/content-studio/creators/DmCreator.tsx:212`<br>`client/src/components/outreach/DrillDownPage.tsx:400`<br>`client/src/components/whatsapp-templates/WhatsAppTemplateEditor.tsx:401` | `server/routes/content.routes.ts:157` | Matched |
| User/public | POST | `/api/content/studio/video` | `client/src/app/dashboard/(main)/saved-templates/ads/page.tsx:158`<br>`client/src/app/dashboard/(main)/saved-templates/dm/page.tsx:191`<br>`client/src/app/dashboard/(main)/saved-templates/email/page.tsx:368`<br>`client/src/app/dashboard/(main)/saved-templates/social/page.tsx:268`<br>+2 more | `server/routes/content.routes.ts:151` | Matched |
| User/public | GET | `/api/content/studio/video/status/:param` | `client/src/components/content-studio/creators/VideoCreator.tsx:293` | `server/routes/content.routes.ts:153` | Matched |
| User/public | GET | `/api/content/templates` | `client/src/components/modals/CreatePostModal.tsx:263`<br>`client/src/components/modals/SendEmailModal.tsx:136`<br>`client/src/hooks/use-paginated-content-templates.ts:48`<br>`client/src/lib/contentTemplateLibrary.ts:12` | `server/routes/content.routes.ts:189` | Matched |
| User/public | POST | `/api/content/templates` | `client/src/app/dashboard/(main)/saved-templates/ads/page.tsx:99`<br>`client/src/app/dashboard/(main)/saved-templates/blog/page.tsx:100`<br>`client/src/app/dashboard/(main)/saved-templates/dm/page.tsx:132`<br>`client/src/app/dashboard/(main)/saved-templates/email/page.tsx:185`<br>+5 more | `server/routes/content.routes.ts:194` | Matched |
| User/public | DELETE | `/api/content/templates/:param` | `client/src/app/dashboard/(main)/saved-templates/ads/page.tsx:116`<br>`client/src/app/dashboard/(main)/saved-templates/blog/page.tsx:117`<br>`client/src/app/dashboard/(main)/saved-templates/dm/page.tsx:149`<br>`client/src/app/dashboard/(main)/saved-templates/email/page.tsx:201`<br>+2 more | `server/routes/content.routes.ts:196` | Matched |
| User/public | GET | `/api/content/templates/:param` | `client/src/app/dashboard/(main)/saved-templates/ads/publish/page.tsx:294`<br>`client/src/components/content-library/ReusableTemplateActions.tsx:43`<br>`client/src/hooks/use-library-campaign-handoff.ts:25` | `server/routes/content.routes.ts:190`<br>`server/routes/content.routes.ts:191`<br>`server/routes/content.routes.ts:192` | Matched |
| User/public | PUT | `/api/content/templates/:param` | `client/src/app/dashboard/(main)/saved-templates/ads/page.tsx:108`<br>`client/src/app/dashboard/(main)/saved-templates/blog/page.tsx:109`<br>`client/src/app/dashboard/(main)/saved-templates/dm/page.tsx:141`<br>`client/src/app/dashboard/(main)/saved-templates/email/page.tsx:183`<br>+2 more | `server/routes/content.routes.ts:195` | Matched |
| User/public | POST | `/api/content/templates/:param/approve` | `client/src/components/content-library/ReusableTemplateActions.tsx:57` | `server/routes/content.routes.ts:201` | Matched |
| User/public | POST | `/api/content/templates/:param/duplicate` | `client/src/components/content-library/ReusableTemplateActions.tsx:40` | `server/routes/content.routes.ts:198` | Matched |
| User/public | POST | `/api/content/templates/:param/import` | `client/src/app/dashboard/(main)/saved-templates/email/page.tsx:215` | `server/routes/content.routes.ts:199` | Matched |
| User/public | POST | `/api/content/templates/:param/use` | `client/src/lib/reusableTemplates.ts:21` | `server/routes/content.routes.ts:197` | Matched |
| User/public | GET | `/api/content/templates/:param/versions` | `client/src/components/content-library/TemplateVersionHistory.tsx:34` | `server/routes/content.routes.ts:200` | Matched |
| User/public | GET | `/api/content/templates/counts` | `client/src/app/dashboard/(main)/saved-templates/page.tsx:123` | `server/routes/content.routes.ts:191`<br>`server/routes/content.routes.ts:193` | Matched |
| User/public | GET | `/api/content/templates/predefined` | `client/src/components/outreach/TemplateSelector.tsx:284`<br>`client/src/components/outreach/create/OutreachCreationPage.tsx:493` | `server/routes/content.routes.ts:192`<br>`server/routes/content.routes.ts:193` | Matched |
| User/public | GET | `/api/crm/alerts` | `client/src/app/dashboard/(main)/crm/alerts/page.tsx:109` | `server/routes/crm.routes.ts:136` | Matched |
| User/public | POST | `/api/crm/alerts` | `client/src/app/dashboard/(main)/crm/alerts/page.tsx:166` | `server/routes/crm.routes.ts:137` | Matched |
| User/public | DELETE | `/api/crm/alerts/:param` | `client/src/app/dashboard/(main)/crm/alerts/page.tsx:197` | `server/routes/crm.routes.ts:139` | Matched |
| User/public | PUT | `/api/crm/alerts/:param` | `client/src/app/dashboard/(main)/crm/alerts/page.tsx:163`<br>`client/src/app/dashboard/(main)/crm/alerts/page.tsx:185` | `server/routes/crm.routes.ts:138` | Matched |
| User/public | GET | `/api/crm/alerts/:param/logs` | `client/src/app/dashboard/(main)/crm/alerts/page.tsx:126` | `server/routes/crm.routes.ts:141` | Matched |
| User/public | GET | `/api/crm/alerts/logs` | `client/src/app/dashboard/(main)/crm/alerts/page.tsx:126` | `server/routes/crm.routes.ts:140` | Matched |
| User/public | GET | `/api/crm/analytics` | `client/src/app/dashboard/(main)/crm/contacts/page.tsx:108` | `server/routes/crm.routes.ts:106` | Matched |
| User/public | GET | `/api/crm/assignees` | `client/src/components/crm/ContactEditForm.tsx:64`<br>`client/src/components/crm/ContactReminders.tsx:78`<br>`client/src/components/crm/CrmCollectionFilters.tsx:30` | `server/routes/crm.routes.ts:72` | Matched |
| User/public | GET | `/api/crm/automations` | `client/src/app/dashboard/(main)/crm/automations/page.tsx:96` | `server/routes/crm.routes.ts:109` | Matched |
| User/public | DELETE | `/api/crm/automations/:param` | `client/src/app/dashboard/(main)/crm/automations/page.tsx:127` | `server/routes/crm.routes.ts:116` | Matched |
| User/public | PUT | `/api/crm/automations/:param` | `client/src/app/dashboard/(main)/crm/automations/page.tsx:115` | `server/routes/crm.routes.ts:115` | Matched |
| User/public | GET | `/api/crm/automations/logs` | `client/src/app/dashboard/(main)/crm/automations/page.tsx:86` | `server/routes/crm.routes.ts:117`<br>`server/routes/crm.routes.ts:119` | Matched |
| User/public | GET | `/api/crm/contacts` | `client/src/components/support/CreateSupportTicketDialog.tsx:35` | `server/routes/crm.routes.ts:82` | Matched |
| User/public | POST | `/api/crm/contacts` | `client/src/components/crm/CreateContactDialog.tsx:42` | `server/routes/crm.routes.ts:84` | Matched |
| User/public | DELETE | `/api/crm/contacts/:param` | `client/src/app/dashboard/(main)/crm/contacts/page.tsx:165` | `server/routes/crm.routes.ts:86` | Matched |
| User/public | GET | `/api/crm/contacts/:param` | `client/src/app/dashboard/(main)/crm/contacts/[id]/edit/page.tsx:25`<br>`client/src/hooks/use-contact-workspace.ts:31` | `server/routes/crm.routes.ts:75`<br>`server/routes/crm.routes.ts:83` | Matched |
| User/public | PUT | `/api/crm/contacts/:param` | `client/src/app/dashboard/(main)/crm/contacts/page.tsx:187`<br>`client/src/components/crm/ContactEditForm.tsx:77` | `server/routes/crm.routes.ts:85` | Matched |
| User/public | GET | `/api/crm/contacts/:param/:param` | `client/src/hooks/use-contact-workspace.ts:42` | `server/routes/crm.routes.ts:77`<br>`server/routes/crm.routes.ts:78`<br>`server/routes/crm.routes.ts:95` | Matched |
| User/public | POST | `/api/crm/contacts/:param/activities` | `client/src/components/crm/workspace/AddActivityDialog.tsx:29` | `server/routes/crm.routes.ts:87`<br>`server/routes/crm.routes.ts:102` | Matched |
| User/public | GET | `/api/crm/contacts/:param/conversations/:param/messages` | `client/src/components/crm/workspace/ConversationThread.tsx:58` | `server/routes/crm.routes.ts:79` | Matched |
| User/public | PATCH | `/api/crm/contacts/:param/pipeline-status` | `client/src/app/dashboard/(main)/crm/pipeline/page.tsx:119` | `server/routes/crm.routes.ts:131` | Matched |
| User/public | GET | `/api/crm/contacts/:param/workspace-summary` | `client/src/hooks/use-contact-workspace.ts:36` | `server/routes/crm.routes.ts:77` | Matched |
| User/public | POST | `/api/crm/contacts/bulk` | `client/src/app/dashboard/(main)/crm/contacts/page.tsx:152` | `server/routes/crm.routes.ts:76` | Matched |
| User/public | GET | `/api/crm/contacts/export` | `client/src/app/dashboard/(main)/crm/contacts/page.tsx:137` | `server/routes/crm.routes.ts:75`<br>`server/routes/crm.routes.ts:83` | Matched |
| User/public | POST | `/api/crm/contacts/import` | `client/src/app/dashboard/(main)/crm/import/page.tsx:153` | `server/routes/crm.routes.ts:91` | Matched |
| User/public | POST | `/api/crm/contacts/sync-to-leads` | `client/src/app/dashboard/(main)/crm/contacts/page.tsx:172` | `server/routes/crm.routes.ts:88` | Matched |
| User/public | GET | `/api/crm/pipeline/analytics` | `client/src/app/dashboard/(main)/crm/pipeline/page.tsx:96` | `server/routes/crm.routes.ts:130` | Matched |
| User/public | GET | `/api/crm/pipeline/summary` | `client/src/app/dashboard/(main)/crm/pipeline/page.tsx:76` | `server/routes/crm.routes.ts:129` | Matched |
| User/public | GET | `/api/crm/reminders` | `client/src/app/dashboard/(main)/crm/reminders/page.tsx:34`<br>`client/src/components/crm/ContactReminders.tsx:183` | `server/routes/crm.routes.ts:122` | Matched |
| User/public | POST | `/api/crm/reminders` | `client/src/components/crm/ContactReminders.tsx:120` | `server/routes/crm.routes.ts:123` | Matched |
| User/public | DELETE | `/api/crm/reminders/:param` | `client/src/components/crm/ContactReminders.tsx:154` | `server/routes/crm.routes.ts:125` | Matched |
| User/public | PUT | `/api/crm/reminders/:param` | `client/src/app/dashboard/(main)/crm/work/page.tsx:73`<br>`client/src/components/crm/ContactReminders.tsx:119`<br>`client/src/components/crm/ContactReminders.tsx:155` | `server/routes/crm.routes.ts:124` | Matched |
| User/public | GET | `/api/crm/reports` | `client/src/app/dashboard/(main)/crm/reports/page.tsx:58` | `server/routes/crm.routes.ts:74` | Matched |
| User/public | GET | `/api/crm/work` | `client/src/app/dashboard/(main)/crm/work/page.tsx:59` | `server/routes/crm.routes.ts:73` | Matched |
| User/public | GET | `/api/dashboard/stats` | `client/src/app/dashboard/(main)/home/page.tsx:292` | `server/routes.ts:271` | Matched |
| User/public | GET | `/api/email-outreach/templates` | `client/src/components/OutreachDialog.tsx:87`<br>`client/src/components/modals/SendEmailModal.tsx:135` | `server/routes.ts:676` | Matched |
| User/public | GET | `/api/email-senders` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:92`<br>`client/src/app/dashboard/(main)/integrations/page.tsx:23`<br>`client/src/components/outreach/EmailSenderPicker.tsx:55` | `server/routes.ts:499` | Matched |
| User/public | POST | `/api/email-senders` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:279` | `server/routes.ts:501` | Matched |
| User/public | DELETE | `/api/email-senders/:param` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:301` | `server/routes.ts:505` | Matched |
| User/public | POST | `/api/email-senders/:param/default` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:315` | `server/routes.ts:504` | Matched |
| User/public | POST | `/api/email-senders/sync` | `client/src/components/outreach/EmailSenderPicker.tsx:54`<br>`client/src/components/outreach/create/OutreachCreationPage.tsx:334` | `server/routes.ts:502` | Matched |
| User/public | GET | `/api/email/status` | `client/src/lib/integration-status.ts:25` | `server/routes.ts:481` | Matched |
| Admin | GET | `/api/embeddings/admin/settings` | `client/src/components/admin/EmbeddingSettingsPanel.tsx:23` | `server/routes/embeddings.routes.ts:26` | Matched |
| Admin | PUT | `/api/embeddings/admin/settings` | `client/src/components/admin/EmbeddingSettingsPanel.tsx:32` | `server/routes/embeddings.routes.ts:27` | Matched |
| User/public | GET | `/api/enrichments` | `client/src/app/dashboard/(main)/enrichment/page.tsx:1006` | `server/routes/enrichments.routes.ts:30` | Matched |
| User/public | GET | `/api/enrichments/:param` | `client/src/app/dashboard/(main)/enrichment/page.tsx:1014` | `server/routes/enrichments.routes.ts:33` | Matched |
| User/public | POST | `/api/enrichments/by-handle` | `client/src/app/dashboard/(main)/enrichment/page.tsx:1029` | `server/routes/enrichments.routes.ts:32` | Matched |
| User/public | POST | `/api/facebook/manual-credentials` | `client/src/app/dashboard/(main)/integrations/facebook/components/FacebookOfficialAPI.tsx:105` | `server/routes.ts:723` | Matched |
| User/public | GET | `/api/facebook/oauth/authorize` | `client/src/app/dashboard/(main)/integrations/facebook/page.tsx:86` | `server/controllers/facebookOAuthController.ts:101` | Matched |
| User/public | POST | `/api/facebook/oauth/disconnect` | `client/src/app/dashboard/(main)/integrations/facebook/page.tsx:114` | `server/controllers/facebookOAuthController.ts:398` | Matched |
| User/public | POST | `/api/facebook/oauth/refresh` | `client/src/app/dashboard/(main)/integrations/facebook/page.tsx:98` | `server/controllers/facebookOAuthController.ts:329` | Matched |
| User/public | GET | `/api/facebook/oauth/status` | `client/src/app/dashboard/(main)/integrations/facebook/page.tsx:50`<br>`client/src/app/dashboard/(main)/integrations/page.tsx:15` | `server/controllers/facebookOAuthController.ts:428` | Matched |
| User/public | GET | `/api/gmail/oauth/authorize` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:135` | `server/controllers/gmailOAuthController.ts:397` | Matched |
| User/public | POST | `/api/gmail/oauth/disconnect` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:149` | `server/controllers/gmailOAuthController.ts:666` | Matched |
| User/public | GET | `/api/gmail/oauth/status` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:74`<br>`client/src/app/dashboard/(main)/integrations/page.tsx:22` | `server/controllers/gmailOAuthController.ts:187` | Matched |
| User/public | POST | `/api/gmail/oauth/watch` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:169` | `server/controllers/gmailOAuthController.ts:731` | Matched |
| User/public | GET | `/api/google-ads/oauth` | `client/src/app/dashboard/(main)/integrations/google-ads/page.tsx:98` | `server/controllers/googleAdsOAuthController.ts:71` | Matched |
| User/public | POST | `/api/hotel/availability` | `client/src/app/dashboard/(main)/hotel/components/AvailabilityTab.tsx:121`<br>`client/src/app/dashboard/(main)/hotel/components/AvailabilityTab.tsx:154` | `server/routes.ts:901` | Matched |
| User/public | PUT | `/api/hotel/bookings/:param/cancel` | `client/src/app/dashboard/(main)/hotel/components/BookingsTab.tsx:154` | `server/routes.ts:920` | Matched |
| User/public | PUT | `/api/hotel/bookings/:param/confirm` | `client/src/app/dashboard/(main)/hotel/components/BookingsTab.tsx:135` | `server/routes.ts:919` | Matched |
| User/public | POST | `/api/hotel/import-rate-report` | `client/src/app/dashboard/(main)/hotel/components/RoomTypesTab.tsx:193` | `server/routes.ts:909` | Matched |
| User/public | GET | `/api/hotel/payment-settings` | `client/src/app/dashboard/(main)/hotel/components/PaymentsTab.tsx:117` | `server/routes.ts:894` | Matched |
| User/public | POST | `/api/hotel/payment-settings` | `client/src/app/dashboard/(main)/hotel/components/PaymentsTab.tsx:230` | `server/routes.ts:895` | Matched |
| User/public | POST | `/api/hotel/property` | `client/src/app/dashboard/(main)/hotel/components/PropertyTab.tsx:73` | `server/routes.ts:893` | Matched |
| User/public | POST | `/api/hotel/room-types` | `client/src/app/dashboard/(main)/hotel/components/RoomTypesTab.tsx:153` | `server/routes.ts:897` | Matched |
| User/public | DELETE | `/api/hotel/room-types/:param` | `client/src/app/dashboard/(main)/hotel/components/RoomTypesTab.tsx:122` | `server/routes.ts:899` | Matched |
| User/public | PUT | `/api/hotel/room-types/:param` | `client/src/app/dashboard/(main)/hotel/components/RoomTypesTab.tsx:100` | `server/routes.ts:898` | Matched |
| User/public | POST | `/api/hotel/upload-qr` | `client/src/app/dashboard/(main)/hotel/components/PaymentsTab.tsx:270` | `server/routes.ts:910` | Matched |
| User/public | GET | `/api/icp` | `client/src/components/ICPSelectorModal.tsx:52` | `server/routes.ts:400` | Matched |
| User/public | PUT | `/api/icp/:param` | `client/src/components/tabs/ICPTab.tsx:226` | `server/routes.ts:405` | Matched |
| User/public | POST | `/api/icp/build` | `client/src/services/workflowApi.ts:62` | `server/routes.ts:401` | Matched |
| User/public | GET | `/api/icp/profile/:param` | `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:446`<br>`client/src/components/tabs/ICPTab.tsx:277` | `server/routes.ts:403` | Matched |
| User/public | GET | `/api/icp/thread/:param` | `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:1855`<br>`client/src/app/dashboard/(main)/saved-templates/ads/publish/page.tsx:425`<br>`client/src/components/tabs/ICPTab.tsx:184` | `server/routes.ts:404` | Matched |
| User/public | GET | `/api/icps/:param` | `client/src/components/modals/PublishCampaignModal.tsx:446` | `server/routes.ts:408` | Matched |
| User/public | GET | `/api/insights` | `client/src/app/dashboard/(main)/insights/page.tsx:56` | `server/routes/insights.routes.ts:25` | Matched |
| User/public | GET | `/api/insights/details` | `client/src/app/dashboard/(main)/insights/page.tsx:59` | `server/routes/insights.routes.ts:48` | Matched |
| User/public | POST | `/api/instagram/dm/bulk` | `client/src/components/modals/InstagramDMModal.tsx:160` | `server/routes.ts:696` | Matched |
| User/public | GET | `/api/instagram/oauth/authorize` | `client/src/app/dashboard/(main)/integrations/instagram/page.tsx:95`<br>`client/src/app/dashboard/(main)/marketing/analytics/page.tsx:455` | `server/controllers/instagramOAuthController.ts:118` | Matched |
| User/public | POST | `/api/instagram/oauth/disconnect` | `client/src/app/dashboard/(main)/integrations/instagram/page.tsx:123` | `server/controllers/instagramOAuthController.ts:349` | Matched |
| User/public | POST | `/api/instagram/oauth/manual` | `client/src/app/dashboard/(main)/integrations/instagram/components/InstagramOfficialAPI.tsx:81` | `server/controllers/instagramOAuthController.ts:592` | Matched |
| User/public | POST | `/api/instagram/oauth/refresh` | `client/src/app/dashboard/(main)/integrations/instagram/page.tsx:107` | `server/controllers/instagramOAuthController.ts:306` | Matched |
| User/public | GET | `/api/instagram/oauth/status` | `client/src/app/dashboard/(main)/integrations/instagram/automations/page.tsx:38`<br>`client/src/app/dashboard/(main)/integrations/instagram/page.tsx:55`<br>`client/src/app/dashboard/(main)/integrations/page.tsx:14`<br>`client/src/components/modals/InstagramDMModal.tsx:111` | `server/controllers/instagramOAuthController.ts:215` | Matched |
| User/public | GET | `/api/integration-readiness` | `client/src/components/integrations/ProviderReadinessPanel.tsx:68` | `server/routes/providerVerification.routes.ts:11` | Matched |
| User/public | POST | `/api/integration-readiness/:param/verify` | `client/src/components/integrations/ProviderReadinessPanel.tsx:83` | `server/routes/providerVerification.routes.ts:13` | Matched |
| User/public | GET | `/api/integrations/:param/webhook-events` | `client/src/components/integrations/WebhookEventsWorkspace.tsx:105` | `server/routes.ts:848` | Matched |
| User/public | GET | `/api/integrations/google-ads/accounts` | `client/src/app/dashboard/(main)/integrations/google-ads/page.tsx:54`<br>`client/src/app/dashboard/(main)/integrations/page.tsx:37` | `server/routes.ts:628` | Matched |
| User/public | GET | `/api/integrations/google-ads/config` | `client/src/app/dashboard/(main)/integrations/google-ads/page.tsx:70`<br>`client/src/app/dashboard/(main)/integrations/page.tsx:35` | `server/routes.ts:627` | Matched |
| User/public | DELETE | `/api/integrations/google-ads/disconnect` | `client/src/app/dashboard/(main)/integrations/google-ads/page.tsx:123` | `server/routes.ts:496`<br>`server/routes.ts:630` | Matched |
| User/public | POST | `/api/integrations/google-ads/select` | `client/src/app/dashboard/(main)/integrations/google-ads/page.tsx:111` | `server/routes.ts:629` | Matched |
| User/public | GET | `/api/integrations/whatsapp/status` | `client/src/lib/integration-status.ts:36` | `server/routes.ts:568` | Matched |
| User/public | GET | `/api/knowledge-base` | `client/src/app/dashboard/(main)/knowledge-base/page.tsx:120`<br>`client/src/app/dashboard/(main)/settings/outreach/[agentType]/page.tsx:287` | `server/routes.ts:338` | Matched |
| User/public | POST | `/api/knowledge-base` | `client/src/app/dashboard/(main)/knowledge-base/[id]/page.tsx:526` | `server/routes.ts:349` | Matched |
| User/public | DELETE | `/api/knowledge-base/:param` | `client/src/app/dashboard/(main)/knowledge-base/page.tsx:162` | `server/routes.ts:351` | Matched |
| User/public | GET | `/api/knowledge-base/:param` | `client/src/app/dashboard/(main)/knowledge-base/[id]/page.tsx:186` | `server/routes.ts:340` | Matched |
| User/public | PUT | `/api/knowledge-base/:param` | `client/src/app/dashboard/(main)/knowledge-base/[id]/page.tsx:474`<br>`client/src/app/dashboard/(main)/knowledge-base/[id]/page.tsx:524` | `server/routes.ts:350` | Matched |
| User/public | GET | `/api/knowledge-base/:param/extracted-text` | `client/src/app/dashboard/(main)/knowledge-base/[id]/page.tsx:329`<br>`client/src/app/dashboard/(main)/knowledge-base/page.tsx:186` | `server/routes.ts:341` | Matched |
| User/public | POST | `/api/knowledge-base/:param/reprocess` | `client/src/app/dashboard/(main)/knowledge-base/page.tsx:207` | `server/routes.ts:348` | Matched |
| User/public | GET | `/api/knowledge-base/:param/versions` | `client/src/components/knowledge/KnowledgeReviewDialog.tsx:46`<br>`client/src/components/knowledge/KnowledgeReviewDialog.tsx:51` | `server/routes.ts:342` | Matched |
| User/public | POST | `/api/knowledge-base/:param/versions/:param/draft` | `client/src/components/knowledge/KnowledgeReviewDialog.tsx:132` | `server/routes.ts:346` | Matched |
| User/public | POST | `/api/knowledge-base/:param/versions/:param/publish` | `client/src/components/knowledge/KnowledgeReviewDialog.tsx:128` | `server/routes.ts:343` | Matched |
| User/public | PUT | `/api/knowledge-base/:param/versions/:param/scope` | `client/src/components/knowledge/KnowledgeReviewDialog.tsx:79` | `server/routes.ts:345` | Matched |
| User/public | POST | `/api/knowledge-base/:param/withdraw` | `client/src/components/knowledge/KnowledgeReviewDialog.tsx:136` | `server/routes.ts:347` | Matched |
| User/public | POST | `/api/knowledge-base/crawl-url` | `client/src/app/dashboard/(main)/knowledge-base/[id]/page.tsx:360`<br>`client/src/app/dashboard/(main)/knowledge-base/[id]/page.tsx:504` | `server/routes.ts:354` | Matched |
| User/public | POST | `/api/knowledge-base/qa` | `client/src/app/dashboard/(main)/knowledge-base/[id]/page.tsx:484` | `server/routes.ts:353` | Matched |
| User/public | POST | `/api/knowledge-base/test-retrieval` | `client/src/components/knowledge/KnowledgeReviewDialog.tsx:166` | `server/routes.ts:339` | Matched |
| User/public | POST | `/api/knowledge-base/upload` | `client/src/app/dashboard/(main)/knowledge-base/[id]/page.tsx:457` | `server/routes.ts:352` | Matched |
| User/public | POST | `/api/knowledge-base/url` | `client/src/app/dashboard/(main)/knowledge-base/[id]/page.tsx:516` | `server/routes.ts:355` | Matched |
| User/public | GET | `/api/leads` | `client/src/app/dashboard/(main)/enrichment/page.tsx:803`<br>`client/src/app/dashboard/(main)/leads/page.tsx:167`<br>`client/src/components/LeadSelectionModal.tsx:93`<br>`client/src/components/modals/InstagramDMModal.tsx:98`<br>+1 more | `server/routes/leads.routes.ts:48` | Matched |
| User/public | POST | `/api/leads` | `client/src/app/dashboard/(main)/leads/new/page.tsx:75`<br>`client/src/components/tabs/LeadsTab.tsx:1038` | `server/routes/leads.routes.ts:55` | Matched |
| User/public | DELETE | `/api/leads/:param` | `client/src/app/dashboard/(main)/leads/page.tsx:251`<br>`client/src/app/dashboard/(main)/leads/view/[id]/page.tsx:203`<br>`client/src/components/tabs/LeadsTab.tsx:1901` | `server/routes/leads.routes.ts:58` | Matched |
| User/public | GET | `/api/leads/:param` | `client/src/app/dashboard/(main)/leads/edit/[id]/page.tsx:83`<br>`client/src/app/dashboard/(main)/leads/view/[id]/page.tsx:142`<br>`client/src/components/outreach/TemplateSelector.tsx:159`<br>`client/src/components/tabs/LeadsTab.tsx:916` | `server/routes/leads.routes.ts:49`<br>`server/routes/leads.routes.ts:50`<br>`server/routes/leads.routes.ts:54` | Matched |
| User/public | PATCH | `/api/leads/:param` | `client/src/app/dashboard/(main)/leads/edit/[id]/page.tsx:127` | `server/routes/leads.routes.ts:57` | Matched |
| User/public | PUT | `/api/leads/:param` | `client/src/app/dashboard/(main)/leads/page.tsx:313` | `server/routes/leads.routes.ts:56` | Matched |
| User/public | POST | `/api/leads/:param/deep-enrich` | `client/src/app/dashboard/(main)/enrichment/page.tsx:1042`<br>`client/src/app/dashboard/(main)/leads/view/[id]/page.tsx:223`<br>`client/src/components/LeadDetailSheet.tsx:963`<br>`client/src/components/tabs/LeadsTab.tsx:978`<br>+1 more | `server/routes/leads.routes.ts:69` | Matched |
| User/public | POST | `/api/leads/:param/enrich` | `client/src/app/dashboard/(main)/leads/page.tsx:381` | `server/routes/leads.routes.ts:68` | Matched |
| User/public | POST | `/api/leads/:param/score` | `client/src/app/dashboard/(main)/leads/page.tsx:354` | `server/routes/leads.routes.ts:67` | Matched |
| User/public | POST | `/api/leads/:param/validate-email` | `client/src/app/dashboard/(main)/leads/page.tsx:408` | `server/routes/leads.routes.ts:79` | Matched |
| User/public | POST | `/api/leads/bulk-delete` | `client/src/app/dashboard/(main)/leads/page.tsx:292` | `server/routes/leads.routes.ts:61` | Matched |
| User/public | GET | `/api/leads/export` | `client/src/app/dashboard/(main)/leads/page.tsx:213`<br>`client/src/components/tabs/LeadsTab.tsx:1010` | `server/routes/leads.routes.ts:50`<br>`server/routes/leads.routes.ts:54` | Matched |
| User/public | POST | `/api/leads/import/csv` | `client/src/components/tabs/LeadsTab.tsx:1092` | `server/routes.ts:329` | Matched |
| User/public | POST | `/api/leads/import/save` | `client/src/components/tabs/LeadsTab.tsx:1107` | `server/routes.ts:328` | Matched |
| User/public | GET | `/api/leads/stats` | `client/src/app/dashboard/(main)/leads/page.tsx:196` | `server/routes/leads.routes.ts:49`<br>`server/routes/leads.routes.ts:54` | Matched |
| User/public | GET | `/api/leads/thread/:param` | `client/src/components/LeadSelectionModal.tsx:83` | `server/routes/leads.routes.ts:51`<br>`server/routes/leads.routes.ts:53` | Matched |
| User/public | POST | `/api/leads/verify` | `client/src/components/ManualVerificationWorkflow.tsx:227` | `server/routes/leads.routes.ts:63` | Matched |
| User/public | POST | `/api/legal/account-deletion-requests` | `client/src/app/account-deletion/page.tsx:44` | `server/routes/legal.routes.ts:14` | Matched |
| User/public | GET | `/api/legal/policies/:param` | `client/src/components/legal/LegalPolicyPage.tsx:85` | `server/routes/legal.routes.ts:13` | Matched |
| User/public | GET | `/api/meta/oauth` | `client/src/app/dashboard/(main)/integrations/meta/page.tsx:99` | `server/controllers/adPlatformOAuthController.ts:89` | Matched |
| User/public | GET | `/api/meta/oauth/platforms` | `client/src/app/dashboard/(main)/ads-campaigns/page.tsx:379`<br>`client/src/app/dashboard/(main)/integrations/meta/page.tsx:56`<br>`client/src/app/dashboard/(main)/integrations/page.tsx:30` | `server/controllers/adPlatformOAuthController.ts:310` | Matched |
| User/public | DELETE | `/api/meta/oauth/platforms/meta` | `client/src/app/dashboard/(main)/integrations/meta/page.tsx:114` | `server/controllers/adPlatformOAuthController.ts:451` | Matched |
| User/public | GET | `/api/meta/oauth/selection` | `client/src/app/dashboard/(main)/integrations/meta/components/MetaAccountStatus.tsx:86` | `server/controllers/adPlatformOAuthController.ts:355` | Matched |
| User/public | POST | `/api/meta/oauth/selection` | `client/src/app/dashboard/(main)/integrations/meta/components/MetaAccountStatus.tsx:103` | `server/controllers/adPlatformOAuthController.ts:388` | Matched |
| User/public | DELETE | `/api/msg91-settings` | `client/src/app/dashboard/(main)/integrations/msg91/page.tsx:77` | `server/routes.ts:553` | Matched |
| User/public | GET | `/api/msg91-settings` | `client/src/app/dashboard/(main)/integrations/msg91/page.tsx:34`<br>`client/src/app/dashboard/(main)/integrations/page.tsx:41`<br>`client/src/lib/integration-status.ts:40` | `server/routes.ts:550` | Matched |
| User/public | POST | `/api/msg91-settings` | `client/src/app/dashboard/(main)/integrations/msg91/page.tsx:59` | `server/routes.ts:551` | Matched |
| User/public | POST | `/api/msg91-settings/test` | `client/src/app/dashboard/(main)/integrations/msg91/page.tsx:59` | `server/routes.ts:552` | Matched |
| User/public | GET | `/api/notifications` | `client/src/app/dashboard/(main)/notifications/page.tsx:62`<br>`client/src/components/Header.tsx:89`<br>`client/src/services/workflowApi.ts:93` | `server/routes.ts:470` | Matched |
| User/public | DELETE | `/api/notifications/:param` | `client/src/app/dashboard/(main)/notifications/page.tsx:130` | `server/routes.ts:475` | Matched |
| User/public | PUT | `/api/notifications/:param/read` | `client/src/app/dashboard/(main)/notifications/page.tsx:97`<br>`client/src/components/Header.tsx:130`<br>`client/src/services/workflowApi.ts:101` | `server/routes.ts:473` | Matched |
| User/public | PUT | `/api/notifications/read-all` | `client/src/app/dashboard/(main)/notifications/page.tsx:114`<br>`client/src/services/workflowApi.ts:102` | `server/routes.ts:474` | Matched |
| User/public | GET | `/api/notifications/unread/count` | `client/src/components/Header.tsx:80`<br>`client/src/services/workflowApi.ts:99` | `server/routes.ts:472` | Matched |
| User/public | POST | `/api/orchestrator/analyze-goal` | `client/src/services/workflowApi.ts:56` | `server/routes.ts:391` | Matched |
| User/public | GET | `/api/orchestrator/workflows/:param` | `client/src/services/workflowApi.ts:59` | `server/routes.ts:393` | Matched |
| User/public | GET | `/api/organizations` | `client/src/hooks/use-billing-organizations.ts:43` | `server/routes/organizations.routes.ts:10` | Matched |
| User/public | POST | `/api/outreach-conversations` | `client/src/components/outreach/DrillDownPage.tsx:424`<br>`client/src/components/outreach/NewEmailDialog.tsx:85` | `server/routes.ts:790` | Matched |
| User/public | DELETE | `/api/outreach-conversations/:param` | `client/src/components/outreach/useOutreachPage.ts:572`<br>`client/src/components/outreach/useOutreachPage.ts:581` | `server/routes.ts:798` | Matched |
| User/public | GET | `/api/outreach-conversations/:param` | `client/src/components/outreach/useOutreachPage.ts:202`<br>`client/src/components/outreach/useOutreachPage.ts:243`<br>`client/src/components/outreach/useOutreachPage.ts:278` | `server/routes.ts:780`<br>`server/routes.ts:786`<br>`server/routes.ts:787` | Matched |
| User/public | POST | `/api/outreach-conversations/:param/:param/discard-draft` | `client/src/components/outreach/inbox/useInboxConversation.ts:328`<br>`client/src/components/outreach/useOutreachPage.ts:765` | `server/routes.ts:794` | Matched |
| User/public | POST | `/api/outreach-conversations/:param/:param/draft-reply` | `client/src/components/outreach/inbox/useInboxConversation.ts:283`<br>`client/src/components/outreach/useOutreachPage.ts:649`<br>`client/src/components/outreach/useOutreachPage.ts:675`<br>`client/src/components/outreach/useOutreachPage.ts:686` | `server/routes.ts:792` | Matched |
| User/public | GET | `/api/outreach-conversations/:param/:param/messages` | `client/src/components/crm/workspace/ConversationThread.tsx:123`<br>`client/src/components/outreach/inbox/useInboxConversation.ts:156`<br>`client/src/components/outreach/inbox/useInboxConversation.ts:86`<br>`client/src/components/outreach/useOutreachPage.ts:321` | `server/routes.ts:781`<br>`server/routes.ts:795` | Matched |
| User/public | POST | `/api/outreach-conversations/:param/:param/messages` | `client/src/components/crm/workspace/ConversationThread.tsx:82`<br>`client/src/components/outreach/inbox/useInboxConversation.ts:230`<br>`client/src/components/outreach/useOutreachPage.ts:377`<br>`client/src/components/outreach/useOutreachPage.ts:415` | `server/routes.ts:796` | Matched |
| User/public | POST | `/api/outreach-conversations/:param/:param/send-draft` | `client/src/components/outreach/useOutreachPage.ts:724` | `server/routes.ts:793` | Matched |
| User/public | POST | `/api/outreach-conversations/bulk` | `client/src/components/outreach/create/OutreachCreationPage.tsx:803` | `server/routes.ts:789` | Matched |
| User/public | POST | `/api/outreach-conversations/compose/contact` | `client/src/components/outreach/create/OutreachCreationPage.tsx:288` | `server/routes.ts:785` | Matched |
| User/public | GET | `/api/outreach-conversations/compose/options` | `client/src/components/outreach/CampaignDeliveryReview.tsx:58`<br>`client/src/components/outreach/create/OutreachCreationPage.tsx:335` | `server/routes.ts:782` | Matched |
| User/public | GET | `/api/outreach-conversations/compose/templates` | `client/src/components/outreach/create/OutreachCreationPage.tsx:471`<br>`client/src/components/outreach/inbox/InboxWhatsAppTemplate.tsx:48` | `server/routes.ts:784` | Matched |
| User/public | GET | `/api/outreach-conversations/daily-stats` | `client/src/components/outreach/DrillDownPage.tsx:272` | `server/routes.ts:788`<br>`server/routes.ts:791` | Matched |
| User/public | POST | `/api/outreach-conversations/email/:param/messages` | `client/src/components/outreach/NewEmailDialog.tsx:107` | `server/routes.ts:796` | Matched |
| User/public | GET | `/api/outreach-conversations/inbox` | `client/src/components/outreach/inbox/OutreachInbox.tsx:496` | `server/routes.ts:780`<br>`server/routes.ts:791` | Matched |
| User/public | GET | `/api/outreach-conversations/inbox/:param/:param` | `client/src/components/outreach/inbox/OutreachInbox.tsx:621`<br>`client/src/components/outreach/inbox/useInboxConversation.ts:80` | `server/routes.ts:781`<br>`server/routes.ts:795` | Matched |
| User/public | GET | `/api/outreach-conversations/inbox/conversation/:param` | `client/src/components/crm/workspace/ConversationThread.tsx:49` | `server/routes.ts:781`<br>`server/routes.ts:795` | Matched |
| User/public | GET | `/api/outreach-conversations/unread` | `client/src/components/outreach/useOutreachPage.ts:310` | `server/routes.ts:786`<br>`server/routes.ts:791` | Matched |
| User/public | POST | `/api/outreach/attachments` | `client/src/app/dashboard/(main)/support-ai/chat/page.tsx:466`<br>`client/src/components/outreach/create/OutreachCreationPage.tsx:840`<br>`client/src/components/outreach/inbox/useInboxConversation.ts:309`<br>`client/src/components/outreach/useOutreachPage.ts:509` | `server/routes/outreach.routes.ts:79` | Matched |
| User/public | GET | `/api/outreach/campaigns` | `client/src/app/dashboard/(main)/outreach/activity/page.tsx:141` | `server/routes/outreach.routes.ts:58` | Matched |
| User/public | POST | `/api/outreach/campaigns` | `client/src/components/OutreachCampaignBuilder.tsx:166` | `server/routes/outreach.routes.ts:60` | Matched |
| User/public | GET | `/api/outreach/campaigns/:param` | `client/src/components/outreach/CampaignDeliveryReview.tsx:54` | `server/routes/outreach.routes.ts:59` | Matched |
| User/public | POST | `/api/outreach/campaigns/:param/:param` | `client/src/app/dashboard/(main)/outreach/activity/page.tsx:161` | `server/routes/outreach.routes.ts:61`<br>`server/routes/outreach.routes.ts:62`<br>`server/routes/outreach.routes.ts:63` | Matched |
| User/public | POST | `/api/outreach/campaigns/:param/preview` | `client/src/components/outreach/CampaignDeliveryReview.tsx:91` | `server/routes/outreach.routes.ts:61` | Matched |
| User/public | POST | `/api/outreach/campaigns/:param/schedule` | `client/src/components/outreach/CampaignDeliveryReview.tsx:102` | `server/routes/outreach.routes.ts:62` | Matched |
| User/public | POST | `/api/outreach/leads/upload-file` | `client/src/components/LeadFileUpload.tsx:118` | `server/routes/outreach.routes.ts:72` | Matched |
| User/public | GET | `/api/outreach/messages` | `client/src/app/dashboard/(main)/outreach/activity/page.tsx:127` | `server/routes/outreach.routes.ts:50` | Matched |
| User/public | GET | `/api/outreach/progress/:param` | `client/src/services/workflowApi.ts:85` | `server/routes/outreach.routes.ts:53` | Matched |
| User/public | POST | `/api/outreach/send` | `client/src/components/modals/SendEmailModal.tsx:282`<br>`client/src/components/modals/SendSMSModal.tsx:161` | `server/routes/outreach.routes.ts:54` | Matched |
| User/public | POST | `/api/outreach/sequences/email` | `client/src/components/OutreachCampaignBuilder.tsx:98` | `server/routes/outreach.routes.ts:68` | Matched |
| User/public | POST | `/api/outreach/sequences/sms` | `client/src/components/OutreachCampaignBuilder.tsx:103` | `server/routes/outreach.routes.ts:69` | Matched |
| User/public | POST | `/api/outreach/start` | `client/src/services/workflowApi.ts:78` | `server/routes/outreach.routes.ts:55` | Matched |
| User/public | GET | `/api/outreach/stats` | `client/src/app/dashboard/(main)/outreach-analytics/page.tsx:138`<br>`client/src/app/dashboard/(main)/outreach/activity/page.tsx:114` | `server/routes/outreach.routes.ts:52` | Matched |
| User/public | GET | `/api/platform/access` | `client/src/hooks/use-platform-access.ts:15` | `server/routes/platform.routes.ts:7` | Matched |
| User/public | GET | `/api/proposals` | `client/src/app/dashboard/(main)/proposals/page.tsx:23`<br>`client/src/components/tabs/ProposalsTab.tsx:80` | `server/routes/proposals.routes.ts:73` | Matched |
| User/public | POST | `/api/proposals` | `client/src/components/proposals/ProposalEditor.tsx:135` | `server/routes/proposals.routes.ts:111` | Matched |
| User/public | DELETE | `/api/proposals/:param` | `client/src/app/dashboard/(main)/proposals/page.tsx:27` | `server/routes/proposals.routes.ts:114` | Matched |
| User/public | GET | `/api/proposals/:param` | `client/src/app/dashboard/(main)/proposals/[id]/page.tsx:38`<br>`client/src/components/proposals/ProposalEditor.tsx:194`<br>`client/src/components/proposals/ProposalEditor.tsx:93` | `server/routes/proposals.routes.ts:74`<br>`server/routes/proposals.routes.ts:75`<br>`server/routes/proposals.routes.ts:79` | Matched |
| User/public | PUT | `/api/proposals/:param` | `client/src/components/proposals/ProposalEditor.tsx:137` | `server/routes/proposals.routes.ts:95`<br>`server/routes/proposals.routes.ts:113` | Matched |
| User/public | GET | `/api/proposals/:param/approvals` | `client/src/components/proposals/ProposalWorkflowPanel.tsx:47` | `server/routes/proposals.routes.ts:63`<br>`server/routes/proposals.routes.ts:98` | Matched |
| User/public | POST | `/api/proposals/:param/approve` | `client/src/components/proposals/ProposalDeliveryPanel.tsx:98` | `server/routes/proposals.routes.ts:101` | Matched |
| User/public | GET | `/api/proposals/:param/comments` | `client/src/app/dashboard/(main)/proposals/[id]/page.tsx:41` | `server/routes/proposals.routes.ts:63`<br>`server/routes/proposals.routes.ts:125` | Matched |
| User/public | POST | `/api/proposals/:param/comments` | `client/src/app/dashboard/(main)/proposals/[id]/page.tsx:43` | `server/routes/proposals.routes.ts:126` | Matched |
| User/public | GET | `/api/proposals/:param/feedback` | `client/src/components/proposals/ProposalWorkflowPanel.tsx:45` | `server/routes/proposals.routes.ts:63`<br>`server/routes/proposals.routes.ts:105` | Matched |
| User/public | PATCH | `/api/proposals/:param/feedback/:param` | `client/src/components/proposals/ProposalWorkflowPanel.tsx:74` | `server/routes/proposals.routes.ts:107` | Matched |
| User/public | POST | `/api/proposals/:param/feedback/:param/reply` | `client/src/components/proposals/ProposalWorkflowPanel.tsx:77` | `server/routes/proposals.routes.ts:106` | Matched |
| User/public | PATCH | `/api/proposals/:param/followups` | `client/src/components/proposals/ProposalWorkflowPanel.tsx:82` | `server/routes/proposals.routes.ts:104`<br>`server/routes/proposals.routes.ts:127` | Matched |
| User/public | POST | `/api/proposals/:param/followups` | `client/src/components/proposals/ProposalWorkflowPanel.tsx:83` | `server/routes/proposals.routes.ts:103` | Matched |
| User/public | POST | `/api/proposals/:param/followups/preview` | `client/src/components/proposals/ProposalWorkflowPanel.tsx:68` | `server/routes/proposals.routes.ts:102` | Matched |
| User/public | POST | `/api/proposals/:param/prepare-delivery` | `client/src/components/proposals/ProposalDeliveryPanel.tsx:88` | `server/routes/proposals.routes.ts:97` | Matched |
| User/public | POST | `/api/proposals/:param/recover-delivery` | `client/src/components/proposals/ProposalWorkflowPanel.tsx:92` | `server/routes/proposals.routes.ts:109` | Matched |
| User/public | GET | `/api/proposals/:param/reminders` | `client/src/components/proposals/ProposalWorkflowPanel.tsx:46` | `server/routes/proposals.routes.ts:63`<br>`server/routes/proposals.routes.ts:130` | Matched |
| User/public | POST | `/api/proposals/:param/revise` | `client/src/components/proposals/ProposalWorkflowPanel.tsx:72`<br>`client/src/components/proposals/ProposalWorkflowPanel.tsx:74` | `server/routes/proposals.routes.ts:108` | Matched |
| User/public | POST | `/api/proposals/:param/send` | `client/src/components/proposals/ProposalDeliveryPanel.tsx:116` | `server/routes/proposals.routes.ts:117` | Matched |
| User/public | GET | `/api/proposals/:param/timeline` | `client/src/components/proposals/ProposalWorkflowPanel.tsx:43` | `server/routes/proposals.routes.ts:63`<br>`server/routes/proposals.routes.ts:99` | Matched |
| User/public | GET | `/api/proposals/:param/versions` | `client/src/components/proposals/ProposalWorkflowPanel.tsx:44` | `server/routes/proposals.routes.ts:63`<br>`server/routes/proposals.routes.ts:100` | Matched |
| User/public | GET | `/api/proposals/analytics` | `client/src/app/dashboard/(main)/proposals/analytics/page.tsx:54`<br>`client/src/app/dashboard/(main)/proposals/page.tsx:25`<br>`client/src/app/dashboard/(main)/proposals/page.tsx:27` | `server/routes/proposals.routes.ts:74`<br>`server/routes/proposals.routes.ts:110` | Matched |
| User/public | GET | `/api/proposals/brand` | `client/src/app/dashboard/(main)/proposals/[id]/page.tsx:38`<br>`client/src/components/proposals/ProposalEditor.tsx:117` | `server/routes/proposals.routes.ts:75`<br>`server/routes/proposals.routes.ts:110` | Matched |
| User/public | GET | `/api/proposals/catalog` | `client/src/app/dashboard/(main)/proposals/catalog/page.tsx:33`<br>`client/src/components/proposals/ProposalEditor.tsx:117` | `server/routes/proposals.routes.ts:89`<br>`server/routes/proposals.routes.ts:110` | Matched |
| User/public | POST | `/api/proposals/catalog` | `client/src/app/dashboard/(main)/proposals/catalog/page.tsx:62` | `server/routes/proposals.routes.ts:90` | Matched |
| User/public | PUT | `/api/proposals/catalog/:param` | `client/src/app/dashboard/(main)/proposals/catalog/page.tsx:61` | `server/routes/proposals.routes.ts:91`<br>`server/routes/proposals.routes.ts:122` | Matched |
| User/public | GET | `/api/proposals/onboarding-resources` | `client/src/components/proposals/ProposalEditor.tsx:117` | `server/routes/proposals.routes.ts:96`<br>`server/routes/proposals.routes.ts:110` | Matched |
| User/public | GET | `/api/proposals/performance` | `client/src/components/proposals/ProposalPerformance.tsx:30` | `server/routes/proposals.routes.ts:93`<br>`server/routes/proposals.routes.ts:110` | Matched |
| User/public | GET | `/api/proposals/public/:param` | `client/src/app/proposal/[token]/page.tsx:86` | `server/routes/proposals.routes.ts:63`<br>`server/routes/proposals.routes.ts:98`<br>`server/routes/proposals.routes.ts:99` | Matched |
| User/public | POST | `/api/proposals/public/:param/:param` | `client/src/app/proposal/[token]/page.tsx:122` | `server/routes/proposals.routes.ts:64`<br>`server/routes/proposals.routes.ts:65`<br>`server/routes/proposals.routes.ts:66` | Matched |
| User/public | GET | `/api/proposals/public/:param/feedback` | `client/src/app/proposal/[token]/page.tsx:75` | `server/routes/proposals.routes.ts:67` | Matched |
| User/public | POST | `/api/proposals/public/:param/feedback` | `client/src/app/proposal/[token]/page.tsx:142` | `server/routes/proposals.routes.ts:68` | Matched |
| User/public | POST | `/api/proposals/public/:param/view` | `client/src/app/proposal/[token]/page.tsx:94` | `server/routes/proposals.routes.ts:64` | Matched |
| User/public | GET | `/api/proposals/related` | `client/src/components/proposals/RelatedProposals.tsx:28` | `server/routes/proposals.routes.ts:92`<br>`server/routes/proposals.routes.ts:110` | Matched |
| User/public | GET | `/api/proposals/resolve-source` | `client/src/components/proposals/ProposalEditor.tsx:105`<br>`client/src/components/proposals/ProposalSourcePicker.tsx:87` | `server/routes/proposals.routes.ts:88`<br>`server/routes/proposals.routes.ts:110` | Matched |
| User/public | GET | `/api/proposals/review-policy` | `client/src/components/proposals/ProposalReviewPolicyDialog.tsx:17` | `server/routes/proposals.routes.ts:94`<br>`server/routes/proposals.routes.ts:110` | Matched |
| User/public | PUT | `/api/proposals/review-policy` | `client/src/components/proposals/ProposalReviewPolicyDialog.tsx:18` | `server/routes/proposals.routes.ts:95`<br>`server/routes/proposals.routes.ts:113` | Matched |
| User/public | GET | `/api/proposals/sources` | `client/src/components/proposals/ProposalSourcePicker.tsx:33` | `server/routes/proposals.routes.ts:87`<br>`server/routes/proposals.routes.ts:110` | Matched |
| User/public | POST | `/api/proposals/suggest` | `client/src/components/proposals/ProposalEditor.tsx:191` | `server/routes/proposals.routes.ts:76` | Matched |
| User/public | GET | `/api/proposals/templates` | `client/src/app/dashboard/(main)/proposals/templates/page.tsx:92`<br>`client/src/components/proposals/ProposalEditor.tsx:117`<br>`client/src/components/tabs/ProposalsTab.tsx:64` | `server/routes/proposals.routes.ts:79`<br>`server/routes/proposals.routes.ts:110` | Matched |
| User/public | POST | `/api/proposals/templates` | `client/src/app/dashboard/(main)/proposals/templates/page.tsx:281` | `server/routes/proposals.routes.ts:83` | Matched |
| User/public | DELETE | `/api/proposals/templates/:param` | `client/src/app/dashboard/(main)/proposals/templates/page.tsx:676` | `server/routes/proposals.routes.ts:85` | Matched |
| User/public | PUT | `/api/proposals/templates/:param` | `client/src/app/dashboard/(main)/proposals/templates/page.tsx:280` | `server/routes/proposals.routes.ts:84`<br>`server/routes/proposals.routes.ts:122` | Matched |
| User/public | PUT | `/api/proposals/templates/:param/favorite` | `client/src/app/dashboard/(main)/proposals/templates/page.tsx:123` | `server/routes/proposals.routes.ts:81` | Matched |
| User/public | GET | `/api/proposals/templates/favorites` | `client/src/app/dashboard/(main)/proposals/templates/page.tsx:93` | `server/routes/proposals.routes.ts:80` | Matched |
| User/public | POST | `/api/proposals/templates/import` | `client/src/app/dashboard/(main)/proposals/templates/page.tsx:158` | `server/routes/proposals.routes.ts:82` | Matched |
| User/public | GET | `/api/resend/domains` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:83`<br>`client/src/app/dashboard/(main)/integrations/page.tsx:24` | `server/routes.ts:508` | Matched |
| User/public | POST | `/api/resend/domains` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:184` | `server/routes.ts:509` | Matched |
| User/public | DELETE | `/api/resend/domains/:param` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:199` | `server/routes.ts:514` | Matched |
| User/public | POST | `/api/resend/domains/:param/verify` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:213` | `server/routes.ts:512` | Matched |
| User/public | POST | `/api/resend/send-test` | `client/src/app/dashboard/(main)/integrations/email/page.tsx:238` | `server/routes.ts:515` | Matched |
| User/public | GET | `/api/scraping/:param/progress` | `client/src/services/workflowApi.ts:71` | `server/routes.ts:460` | Matched |
| User/public | POST | `/api/scraping/start` | `client/src/services/workflowApi.ts:68` | `server/routes.ts:459` | Matched |
| User/public | GET | `/api/sent-messages` | `client/src/components/follow-ups/FollowUpHistory.tsx:42` | `server/routes.ts:295` | Matched |
| User/public | GET | `/api/settings/ads` | `client/src/app/dashboard/(main)/saved-templates/ads/publish/page.tsx:406`<br>`client/src/app/dashboard/(main)/settings/ads/page.tsx:66`<br>`client/src/components/modals/PublishCampaignModal.tsx:348` | `server/routes/settings.routes.ts:175` | Matched |
| User/public | PUT | `/api/settings/ads` | `client/src/app/dashboard/(main)/settings/ads/page.tsx:89` | `server/routes/settings.routes.ts:176` | Matched |
| User/public | GET | `/api/settings/ads/autonomy` | `client/src/app/dashboard/(main)/settings/ads/page.tsx:71` | `server/routes/settings.routes.ts:182` | Matched |
| User/public | PUT | `/api/settings/ads/autonomy` | `client/src/app/dashboard/(main)/settings/ads/page.tsx:93` | `server/routes/settings.routes.ts:187` | Matched |
| User/public | GET | `/api/settings/ai-agents` | `client/src/app/dashboard/(main)/settings/outreach/[agentType]/page.tsx:362`<br>`client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:214`<br>`client/src/components/outreach/LegacyOutreachSettings.tsx:69` | `server/routes.ts:880` | Matched |
| User/public | GET | `/api/settings/ai-agents/:param` | `client/src/app/dashboard/(main)/settings/outreach/[agentType]/page.tsx:369` | `server/routes.ts:882` | Matched |
| User/public | PUT | `/api/settings/ai-agents/:param` | `client/src/app/dashboard/(main)/settings/outreach/[agentType]/page.tsx:412`<br>`client/src/app/dashboard/(main)/settings/outreach/[agentType]/page.tsx:430`<br>`client/src/app/dashboard/(main)/settings/outreach/[agentType]/page.tsx:446`<br>`client/src/app/dashboard/(main)/settings/outreach/[agentType]/page.tsx:456`<br>+1 more | `server/routes.ts:881`<br>`server/routes.ts:883` | Matched |
| User/public | POST | `/api/settings/ai-agents/:param/reset-default` | `client/src/app/dashboard/(main)/settings/outreach/[agentType]/page.tsx:498` | `server/routes.ts:884` | Matched |
| User/public | PUT | `/api/settings/ai-agents/active` | `client/src/components/outreach/LegacyOutreachSettings.tsx:95` | `server/routes.ts:881`<br>`server/routes.ts:883` | Matched |
| User/public | POST | `/api/settings/ai-agents/parse-demo-file` | `client/src/app/dashboard/(main)/settings/outreach/[agentType]/page.tsx:235` | `server/routes.ts:886` | Matched |
| User/public | POST | `/api/settings/ai-agents/parse-kb-entry` | `client/src/app/dashboard/(main)/settings/outreach/[agentType]/page.tsx:317` | `server/routes.ts:887` | Matched |
| User/public | GET | `/api/settings/business-profiles` | `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:134`<br>`client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:402`<br>`client/src/app/dashboard/(main)/knowledge-base/[id]/page.tsx:168`<br>`client/src/app/dashboard/(main)/knowledge-base/documents/page.tsx:47`<br>+10 more | `server/routes/settings.routes.ts:205` | Matched |
| User/public | POST | `/api/settings/business-profiles` | `client/src/components/setup/BusinessProfileSetup.tsx:174`<br>`client/src/components/setup/BusinessProfileSetup.tsx:216` | `server/routes/settings.routes.ts:226` | Matched |
| User/public | DELETE | `/api/settings/business-profiles/:param` | `client/src/components/BusinessProfileSwitcher.tsx:155` | `server/routes/settings.routes.ts:237` | Matched |
| User/public | GET | `/api/settings/business-profiles/:param` | `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:1987`<br>`client/src/components/BusinessProfileForm.tsx:52`<br>`client/src/components/setup/BrandToolkitSetup.tsx:132`<br>`client/src/components/setup/BusinessProfileSetup.tsx:76`<br>+2 more | `server/routes/settings.routes.ts:206`<br>`server/routes/settings.routes.ts:221` | Matched |
| User/public | PUT | `/api/settings/business-profiles/:param` | `client/src/components/BusinessProfileForm.tsx:87`<br>`client/src/components/setup/BusinessProfileSetup.tsx:209` | `server/routes/settings.routes.ts:231` | Matched |
| User/public | POST | `/api/settings/business-profiles/:param/archive` | `client/src/components/BusinessProfileSwitcher.tsx:134` | `server/routes/settings.routes.ts:242` | Matched |
| User/public | POST | `/api/settings/business-profiles/:param/default` | `client/src/hooks/use-business-profiles.ts:77` | `server/routes/settings.routes.ts:252` | Matched |
| User/public | GET | `/api/settings/business-profiles/:param/members` | `client/src/app/dashboard/(main)/settings/team/page.tsx:67` | `server/routes/settings.routes.ts:211` | Matched |
| User/public | POST | `/api/settings/business-profiles/:param/members` | `client/src/app/dashboard/(main)/settings/team/page.tsx:194` | `server/routes/settings.routes.ts:212` | Matched |
| User/public | DELETE | `/api/settings/business-profiles/:param/members/:param` | `client/src/app/dashboard/(main)/settings/team/page.tsx:409` | `server/routes/settings.routes.ts:217` | Matched |
| User/public | PATCH | `/api/settings/business-profiles/:param/members/:param` | `client/src/app/dashboard/(main)/settings/team/page.tsx:324` | `server/routes/settings.routes.ts:213` | Matched |
| User/public | POST | `/api/settings/business-profiles/:param/restore` | `client/src/components/BusinessProfileSwitcher.tsx:134` | `server/routes/settings.routes.ts:247` | Matched |
| User/public | GET | `/api/settings/business-profiles/invitations` | `client/src/components/BusinessInvitations.tsx:35` | `server/routes/settings.routes.ts:206`<br>`server/routes/settings.routes.ts:221` | Matched |
| User/public | POST | `/api/settings/business-profiles/invitations/:param/accept` | `client/src/components/BusinessInvitations.tsx:45` | `server/routes/settings.routes.ts:207` | Matched |
| User/public | GET | `/api/settings/integrations/:param/follow-ups` | `client/src/components/FollowUpSettings.tsx:78`<br>`client/src/hooks/use-channel-follow-up-settings.ts:30` | `server/routes/settings.routes.ts:195` | Matched |
| User/public | PUT | `/api/settings/integrations/:param/follow-ups` | `client/src/components/FollowUpSettings.tsx:112` | `server/routes/settings.routes.ts:199` | Matched |
| User/public | GET | `/api/settings/knowledge-base/:param/extracted-text` | `client/src/components/setup/KnowledgeBasePreview.tsx:22` | `server/routes/settings.routes.ts:265` | Matched |
| User/public | GET | `/api/settings/leads` | `client/src/app/dashboard/(main)/settings/leads/page.tsx:30` | `server/routes/settings.routes.ts:171` | Matched |
| User/public | PUT | `/api/settings/leads` | `client/src/app/dashboard/(main)/settings/leads/page.tsx:64` | `server/routes/settings.routes.ts:172` | Matched |
| User/public | POST | `/api/settings/media-deliveries/:param/reconcile` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:357` | `server/routes/settings.routes.ts:298` | Matched |
| User/public | POST | `/api/settings/media-deliveries/:param/retry` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:367` | `server/routes/settings.routes.ts:299` | Matched |
| User/public | GET | `/api/settings/media-deliveries/uncertain` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:105` | `server/routes/settings.routes.ts:297` | Matched |
| User/public | GET | `/api/settings/media-galleries` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:112` | `server/routes/settings.routes.ts:296` | Matched |
| User/public | POST | `/api/settings/media-galleries` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:132` | `server/routes/settings.routes.ts:300` | Matched |
| User/public | DELETE | `/api/settings/media-galleries/:param` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:312` | `server/routes/settings.routes.ts:324` | Matched |
| User/public | GET | `/api/settings/media-galleries/:param` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:179` | `server/routes/settings.routes.ts:305` | Matched |
| User/public | PUT | `/api/settings/media-galleries/:param` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:246` | `server/routes/settings.routes.ts:306` | Matched |
| User/public | DELETE | `/api/settings/media-galleries/:param/assets/:param` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:316` | `server/routes/settings.routes.ts:322` | Matched |
| User/public | PATCH | `/api/settings/media-galleries/:param/assets/:param` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:293` | `server/routes/settings.routes.ts:312` | Matched |
| User/public | POST | `/api/settings/media-galleries/:param/assets/:param/replace` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:289` | `server/routes/settings.routes.ts:317` | Matched |
| User/public | POST | `/api/settings/media-galleries/:param/assets/:param/review` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:346` | `server/routes/settings.routes.ts:313` | Matched |
| User/public | POST | `/api/settings/media-galleries/:param/images` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:152` | `server/routes/settings.routes.ts:307` | Matched |
| User/public | POST | `/api/settings/media-galleries/:param/retry-scans` | `client/src/app/dashboard/(main)/knowledge-base/media/page.tsx:333` | `server/routes/settings.routes.ts:323` | Matched |
| User/public | GET | `/api/settings/outreach/assistants/conversations/:param/activity` | `client/src/components/support/ConversationEventTimeline.tsx:44` | `server/routes/outreachAssistants.routes.ts:54` | Matched |
| User/public | GET | `/api/settings/preferences` | `client/src/components/modals/CreatePostModal.tsx:251`<br>`client/src/components/social-publishing/SocialPublisher.tsx:181`<br>`client/src/components/widgets/PublishPostWidget.tsx:160`<br>`client/src/contexts/PreferencesContext.tsx:89` | `server/routes/settings.routes.ts:193` | Matched |
| User/public | PUT | `/api/settings/preferences` | `client/src/contexts/PreferencesContext.tsx:105` | `server/routes/settings.routes.ts:194` | Matched |
| User/public | GET | `/api/settings/profile` | `client/src/app/dashboard/(main)/settings/page.tsx:76` | `server/routes/settings.routes.ts:158` | Matched |
| User/public | PUT | `/api/settings/profile` | `client/src/app/dashboard/(main)/settings/page.tsx:138` | `server/routes/settings.routes.ts:159` | Matched |
| User/public | POST | `/api/settings/profile/change-password` | `client/src/app/dashboard/(main)/settings/page.tsx:163` | `server/routes/settings.routes.ts:160` | Matched |
| User/public | GET | `/api/settings/profile/notification-preferences` | `client/src/app/dashboard/(main)/settings/page.tsx:96` | `server/routes/settings.routes.ts:161` | Matched |
| User/public | PUT | `/api/settings/profile/notification-preferences` | `client/src/app/dashboard/(main)/settings/page.tsx:120` | `server/routes/settings.routes.ts:165` | Matched |
| User/public | GET | `/api/settings/storage/check-upload` | `client/src/components/storage/StorageUpload.tsx:93` | `server/routes/settings.routes.ts:345` | Matched |
| User/public | POST | `/api/settings/storage/files` | `client/src/app/dashboard/(main)/knowledge-base/documents/page.tsx:70`<br>`client/src/components/ChatInterface.tsx:619`<br>`client/src/components/storage/StorageUpload.tsx:104` | `server/routes/settings.routes.ts:341` | Matched |
| User/public | DELETE | `/api/settings/storage/files/:param` | `client/src/components/ChatInterface.tsx:640`<br>`client/src/components/ChatInterface.tsx:654` | `server/routes/settings.routes.ts:346` | Matched |
| User/public | GET | `/api/settings/storage/workspace` | `client/src/hooks/use-storage-workspace.ts:90` | `server/routes/settings.routes.ts:331` | Matched |
| User/public | POST | `/api/settings/storage/workspace/actions` | `client/src/app/dashboard/(main)/storage/page.tsx:111` | `server/routes/settings.routes.ts:334` | Matched |
| User/public | GET | `/api/settings/storage/workspace/activity` | `client/src/hooks/use-storage-workspace.ts:140` | `server/routes/settings.routes.ts:336` | Matched |
| User/public | POST | `/api/settings/storage/workspace/download` | `client/src/lib/storage-workspace.ts:107` | `server/routes/settings.routes.ts:339` | Matched |
| User/public | GET | `/api/settings/storage/workspace/files` | `client/src/hooks/use-storage-workspace.ts:100` | `server/routes/settings.routes.ts:332` | Matched |
| User/public | GET | `/api/settings/storage/workspace/files/:param` | `client/src/components/storage/StorageDetails.tsx:43` | `server/routes/settings.routes.ts:333` | Matched |
| User/public | GET | `/api/settings/storage/workspace/folders` | `client/src/hooks/use-storage-workspace.ts:114` | `server/routes/settings.routes.ts:335` | Matched |
| User/public | GET | `/api/settings/support-documents` | `client/src/app/dashboard/(main)/knowledge-base/documents/page.tsx:46` | `server/routes/settings.routes.ts:150` | Matched |
| User/public | POST | `/api/settings/support-documents` | `client/src/app/dashboard/(main)/knowledge-base/documents/page.tsx:77` | `server/routes/settings.routes.ts:151` | Matched |
| User/public | PUT | `/api/settings/support-documents/:param` | `client/src/app/dashboard/(main)/knowledge-base/documents/page.tsx:76` | `server/routes/settings.routes.ts:152` | Matched |
| User/public | POST | `/api/settings/support-documents/:param/publish` | `client/src/app/dashboard/(main)/knowledge-base/documents/page.tsx:101` | `server/routes/settings.routes.ts:153` | Matched |
| User/public | POST | `/api/settings/support-documents/:param/withdraw` | `client/src/app/dashboard/(main)/knowledge-base/documents/page.tsx:111` | `server/routes/settings.routes.ts:154` | Matched |
| User/public | POST | `/api/setup/analyze-website` | `client/src/components/BrandToolkitForm.tsx:343` | `server/routes.ts:359` | Matched |
| User/public | GET | `/api/setup/onboarding-status` | `client/src/components/WorkspaceNextSteps.tsx:20` | `server/routes.ts:360` | Matched |
| User/public | POST | `/api/social-analytics/best-times` | `client/src/app/dashboard/(main)/marketing/analytics/page.tsx:1661` | `server/routes.ts:433` | Matched |
| User/public | POST | `/api/social-analytics/competitors` | `client/src/app/dashboard/(main)/marketing/analytics/page.tsx:1770` | `server/routes.ts:438` | Matched |
| User/public | DELETE | `/api/social-analytics/competitors/:param` | `client/src/app/dashboard/(main)/marketing/analytics/page.tsx:1815` | `server/routes.ts:453` | Matched |
| User/public | PATCH | `/api/social-analytics/competitors/:param` | `client/src/app/dashboard/(main)/marketing/analytics/page.tsx:1506`<br>`client/src/app/dashboard/(main)/marketing/analytics/page.tsx:1765` | `server/routes.ts:452` | Matched |
| User/public | POST | `/api/social-analytics/competitors/:param/refresh` | `client/src/app/dashboard/(main)/marketing/analytics/page.tsx:1517` | `server/routes.ts:454` | Matched |
| User/public | POST | `/api/social-analytics/competitors/:param/snapshots` | `client/src/app/dashboard/(main)/marketing/analytics/page.tsx:1889` | `server/routes.ts:441` | Matched |
| User/public | POST | `/api/social-analytics/content/:param/comments/:param/actions` | `client/src/components/social-insights/SocialContentInsights.tsx:1284` | `server/routes.ts:448` | Matched |
| User/public | POST | `/api/social-analytics/listening` | `client/src/components/social-insights/SocialListeningPanel.tsx:630` | `server/routes.ts:436` | Matched |
| User/public | DELETE | `/api/social-analytics/listening/:param` | `client/src/components/social-insights/SocialListeningPanel.tsx:732` | `server/routes.ts:456` | Matched |
| User/public | PATCH | `/api/social-analytics/listening/:param` | `client/src/components/social-insights/SocialListeningPanel.tsx:231`<br>`client/src/components/social-insights/SocialListeningPanel.tsx:621` | `server/routes.ts:455` | Matched |
| User/public | POST | `/api/social-analytics/reports` | `client/src/components/social-insights/SocialReportsPanel.tsx:241` | `server/routes.ts:444` | Matched |
| User/public | DELETE | `/api/social-analytics/reports/:param` | `client/src/components/social-insights/SocialReportsPanel.tsx:695` | `server/routes.ts:450` | Matched |
| User/public | PATCH | `/api/social-analytics/reports/:param` | `client/src/components/social-insights/SocialReportsPanel.tsx:240`<br>`client/src/components/social-insights/SocialReportsPanel.tsx:448` | `server/routes.ts:449` | Matched |
| User/public | POST | `/api/social-analytics/reports/:param/export` | `client/src/components/social-insights/SocialReportsPanel.tsx:256` | `server/routes.ts:445` | Matched |
| User/public | POST | `/api/social-analytics/sync` | `client/src/app/dashboard/(main)/marketing/analytics/page.tsx:664` | `server/routes.ts:427` | Matched |
| User/public | GET | `/api/strategies/:param/recommendations` | `client/src/services/workflowApi.ts:65` | `server/routes.ts:396` | Matched |
| User/public | POST | `/api/subscriptions/cancel` | `client/src/components/pricing/SubscriptionManager.tsx:102` | `server/routes/subscriptions.routes.ts:46` | Matched |
| User/public | GET | `/api/subscriptions/catalog` | `client/src/hooks/use-pricing-catalog.ts:9` | `server/routes/subscriptions.routes.ts:38` | Matched |
| User/public | POST | `/api/subscriptions/change` | `client/src/components/pricing/SubscriptionManager.tsx:75` | `server/routes/subscriptions.routes.ts:43` | Matched |
| User/public | GET | `/api/subscriptions/current` | `client/src/hooks/use-subscription.ts:12` | `server/routes/subscriptions.routes.ts:40` | Matched |
| User/public | POST | `/api/subscriptions/refresh` | `client/src/components/pricing/SubscriptionManager.tsx:66` | `server/routes/subscriptions.routes.ts:45` | Matched |
| User/public | POST | `/api/subscriptions/start` | `client/src/components/pricing/SubscriptionManager.tsx:75` | `server/routes/subscriptions.routes.ts:41` | Matched |
| User/public | POST | `/api/subscriptions/verify` | `client/src/components/pricing/SubscriptionManager.tsx:82` | `server/routes/subscriptions.routes.ts:44` | Matched |
| User/public | GET | `/api/suggestions` | `client/src/app/dashboard/(main)/conversations/[[...threadId]]/page.tsx:1679`<br>`client/src/app/dashboard/(main)/home/page.tsx:236` | `server/routes.ts:274` | Matched |
| User/public | GET | `/api/support` | `client/src/app/dashboard/(main)/support/page.tsx:95`<br>`client/src/app/dashboard/(main)/support/pipeline/page.tsx:30`<br>`client/src/app/dashboard/(main)/support/pipeline/page.tsx:37`<br>`client/src/components/tabs/SupportTab.tsx:75` | `server/routes/support.routes.ts:179` | Matched |
| User/public | POST | `/api/support` | `client/src/components/support/CreateSupportTicketDialog.tsx:62` | `server/routes/support.routes.ts:185` | Matched |
| Support member | PUT | `/api/support-portal/change-password` | `client/src/app/support/settings/page.tsx:50` | `server/routes/supportMember.routes.ts:80` | Matched |
| Support member | GET | `/api/support-portal/chat/sessions` | `client/src/app/support/chat/page.tsx:93`<br>`client/src/app/support/tickets/[id]/page.tsx:251` | `server/routes/supportMember.routes.ts:138` | Matched |
| Support member | POST | `/api/support-portal/chat/sessions` | `client/src/app/support/chat/page.tsx:141`<br>`client/src/app/support/chat/page.tsx:200`<br>`client/src/app/support/tickets/[id]/page.tsx:258` | `server/routes/supportMember.routes.ts:137` | Matched |
| Support member | GET | `/api/support-portal/chat/sessions/:param` | `client/src/app/support/chat/page.tsx:124`<br>`client/src/app/support/tickets/[id]/page.tsx:255` | `server/routes/supportMember.routes.ts:142` | Matched |
| Support member | PATCH | `/api/support-portal/chat/sessions/:param` | `client/src/app/support/chat/page.tsx:157`<br>`client/src/app/support/chat/page.tsx:341` | `server/routes/supportMember.routes.ts:144` | Matched |
| Support member | PUT | `/api/support-portal/chat/sessions/:param` | `client/src/app/support/chat/page.tsx:175` | `server/routes/supportMember.routes.ts:143` | Matched |
| Support member | POST | `/api/support-portal/chat/sessions/:param/messages` | `client/src/app/support/chat/page.tsx:233`<br>`client/src/app/support/tickets/[id]/page.tsx:281` | `server/routes/supportMember.routes.ts:146` | Matched |
| Support member | POST | `/api/support-portal/handoffs/:param/ai-replies` | `client/src/app/support/tickets/[id]/page.tsx:366` | `server/routes/supportMember.routes.ts:102` | Matched |
| Support member | GET | `/api/support-portal/handoffs/:param/messages/:param/reveal` | `client/src/app/support/tickets/[id]/page.tsx:221` | `server/routes/supportMember.routes.ts:106` | Matched |
| Support member | GET | `/api/support-portal/knowledge-base` | `client/src/app/support/knowledge-base/page.tsx:83` | `server/routes/supportMember.routes.ts:127` | Matched |
| Support member | GET | `/api/support-portal/knowledge-base/:param/extracted-text` | `client/src/app/support/knowledge-base/page.tsx:163` | `server/routes/supportMember.routes.ts:128` | Matched |
| Support member | POST | `/api/support-portal/login` | `client/src/app/support/login/page.tsx:36` | `server/routes/supportMember.routes.ts:67` | Matched |
| User/public | POST | `/api/support-portal/logout` | `client/src/contexts/SupportAuthContext.tsx:93` | `server/routes/supportMember.routes.ts:68` | Matched |
| User/public | GET | `/api/support-portal/me` | `client/src/contexts/SupportAuthContext.tsx:35` | `server/routes/supportMember.routes.ts:77` | Matched |
| Support member | GET | `/api/support-portal/media-galleries` | `client/src/app/support/media/page.tsx:66` | `server/routes/supportMember.routes.ts:131` | Matched |
| Support member | GET | `/api/support-portal/media-galleries/:param` | `client/src/app/support/media/page.tsx:81` | `server/routes/supportMember.routes.ts:133` | Matched |
| Support member | GET | `/api/support-portal/notification-availability` | `client/src/app/support/settings/page.tsx:32` | `server/routes/supportMember.routes.ts:83` | Matched |
| Support member | PUT | `/api/support-portal/notification-availability` | `client/src/app/support/settings/page.tsx:34` | `server/routes/supportMember.routes.ts:84` | Matched |
| Support member | POST | `/api/support-portal/notification-deliveries/:param/retry` | `client/src/app/support/notifications/page.tsx:92` | `server/routes/supportMember.routes.ts:94` | Matched |
| Support member | GET | `/api/support-portal/notifications` | `client/src/app/support/notifications/page.tsx:66`<br>`client/src/components/SupportHeader.tsx:58` | `server/routes/supportMember.routes.ts:89` | Matched |
| Support member | POST | `/api/support-portal/notifications/:param/acknowledge` | `client/src/app/support/notifications/page.tsx:86` | `server/routes/supportMember.routes.ts:92` | Matched |
| Support member | POST | `/api/support-portal/notifications/:param/claim` | `client/src/app/support/notifications/page.tsx:96` | `server/routes/supportMember.routes.ts:93` | Matched |
| Support member | POST | `/api/support-portal/notifications/:param/read` | `client/src/app/support/notifications/page.tsx:109` | `server/routes/supportMember.routes.ts:91` | Matched |
| Support member | POST | `/api/support-portal/notifications/read-all` | `client/src/app/support/notifications/page.tsx:120` | `server/routes/supportMember.routes.ts:90` | Matched |
| Support member | GET | `/api/support-portal/playbooks` | `client/src/app/support/playbooks/page.tsx:27` | `server/routes/supportMember.routes.ts:134` | Matched |
| Support member | GET | `/api/support-portal/presence` | `client/src/app/support/profile/page.tsx:32` | `server/routes/supportMember.routes.ts:79` | Matched |
| User/public | POST | `/api/support-portal/presence/heartbeat` | `client/src/contexts/SupportAuthContext.tsx:60` | `server/routes/supportMember.routes.ts:78` | Matched |
| Support member | GET | `/api/support-portal/proposal-reviews` | `client/src/app/support/proposal-reviews/page.tsx:93` | `server/routes/supportMember.routes.ts:97` | Matched |
| Support member | POST | `/api/support-portal/proposal-reviews/:param/decision` | `client/src/app/support/proposal-reviews/page.tsx:118` | `server/routes/supportMember.routes.ts:98` | Matched |
| Support member | GET | `/api/support-portal/stats` | `client/src/app/support/analytics/page.tsx:40`<br>`client/src/app/support/dashboard/page.tsx:41`<br>`client/src/components/SupportHeader.tsx:35` | `server/routes/supportMember.routes.ts:95` | Matched |
| Support member | GET | `/api/support-portal/team-members` | `client/src/app/support/tickets/page.tsx:88`<br>`client/src/app/support/tickets/pipeline/page.tsx:54` | `server/routes/supportMember.routes.ts:96` | Matched |
| Support member | GET | `/api/support-portal/tickets` | `client/src/app/support/dashboard/page.tsx:42`<br>`client/src/app/support/tickets/page.tsx:78`<br>`client/src/app/support/tickets/pipeline/page.tsx:46`<br>`client/src/app/support/tickets/pipeline/page.tsx:47` | `server/routes/supportMember.routes.ts:112` | Matched |
| Support member | GET | `/api/support-portal/tickets/:param` | `client/src/app/support/tickets/[id]/page.tsx:171` | `server/routes/supportMember.routes.ts:114` | Matched |
| Support member | PUT | `/api/support-portal/tickets/:param` | `client/src/app/support/tickets/[id]/page.tsx:337`<br>`client/src/app/support/tickets/pipeline/page.tsx:78` | `server/routes/supportMember.routes.ts:115` | Matched |
| Support member | POST | `/api/support-portal/tickets/:param/attachments` | `client/src/app/support/tickets/[id]/page.tsx:303` | `server/routes/supportMember.routes.ts:120` | Matched |
| Support member | POST | `/api/support-portal/tickets/:param/claim` | `client/src/app/support/tickets/[id]/page.tsx:237`<br>`client/src/app/support/tickets/page.tsx:105`<br>`client/src/app/support/tickets/pipeline/page.tsx:91` | `server/routes/supportMember.routes.ts:116` | Matched |
| Support member | POST | `/api/support-portal/tickets/:param/close` | `client/src/app/support/tickets/[id]/page.tsx:396`<br>`client/src/app/support/tickets/pipeline/page.tsx:76` | `server/routes/supportMember.routes.ts:123` | Matched |
| Support member | POST | `/api/support-portal/tickets/:param/reply` | `client/src/app/support/tickets/[id]/page.tsx:308` | `server/routes/supportMember.routes.ts:119` | Matched |
| Support member | POST | `/api/support-portal/tickets/:param/summary/refresh` | `client/src/app/support/tickets/[id]/page.tsx:209` | `server/routes/supportMember.routes.ts:118` | Matched |
| Support member | GET | `/api/support-portal/tickets/:param/timeline` | `client/src/app/support/tickets/[id]/page.tsx:187` | `server/routes/supportMember.routes.ts:117` | Matched |
| User/public | POST | `/api/support-widget/generate-token` | `client/src/app/dashboard/(main)/support-ai/embed/page.tsx:151` | `server/routes/supportWidget.routes.ts:41` | Matched |
| User/public | PUT | `/api/support-widget/settings/:param` | `client/src/app/dashboard/(main)/support-ai/widget-settings/page.tsx:143` | `server/routes/supportWidget.routes.ts:38` | Matched |
| User/public | GET | `/api/support-widget/token` | `client/src/app/dashboard/(main)/support-ai/embed/page.tsx:113`<br>`client/src/app/dashboard/(main)/support-ai/widget-settings/page.tsx:88` | `server/routes/supportWidget.routes.ts:40` | Matched |
| User/public | DELETE | `/api/support-widget/token/:param` | `client/src/app/dashboard/(main)/support-ai/embed/page.tsx:188` | `server/routes/supportWidget.routes.ts:39` | Matched |
| User/public | GET | `/api/support/:param` | `client/src/app/dashboard/(main)/support/[id]/page.tsx:211` | `server/routes/support.routes.ts:132`<br>`server/routes/support.routes.ts:144`<br>`server/routes/support.routes.ts:145` | Matched |
| User/public | PUT | `/api/support/:param` | `client/src/app/dashboard/(main)/support/[id]/page.tsx:317`<br>`client/src/app/dashboard/(main)/support/[id]/page.tsx:347`<br>`client/src/components/crm/workspace/TicketActions.tsx:24` | `server/routes/support.routes.ts:186` | Matched |
| User/public | POST | `/api/support/:param/attachments` | `client/src/app/dashboard/(main)/support/[id]/page.tsx:275` | `server/routes/support.routes.ts:94`<br>`server/routes/support.routes.ts:190`<br>`server/routes/support.routes.ts:197` | Matched |
| User/public | POST | `/api/support/:param/messages` | `client/src/app/dashboard/(main)/support/[id]/page.tsx:280`<br>`client/src/components/crm/workspace/TicketActions.tsx:34` | `server/routes/support.routes.ts:94`<br>`server/routes/support.routes.ts:190`<br>`server/routes/support.routes.ts:196` | Matched |
| User/public | POST | `/api/support/:param/messages/:param/:param/reveal` | `client/src/app/dashboard/(main)/support/[id]/page.tsx:196` | `server/routes/support.routes.ts:195` | Matched |
| User/public | POST | `/api/support/:param/resolve-ownership` | `client/src/app/dashboard/(main)/support/[id]/page.tsx:331` | `server/routes/support.routes.ts:94`<br>`server/routes/support.routes.ts:183`<br>`server/routes/support.routes.ts:190` | Matched |
| User/public | GET | `/api/support/:param/timeline` | `client/src/app/dashboard/(main)/support/[id]/page.tsx:227` | `server/routes/support.routes.ts:93`<br>`server/routes/support.routes.ts:133`<br>`server/routes/support.routes.ts:194` | Matched |
| User/public | POST | `/api/support/ai/chat` | `client/src/app/dashboard/(main)/support-ai/chat/page.tsx:379` | `server/routes/support.routes.ts:174` | Matched |
| User/public | GET | `/api/support/ai/conversation-recovery` | `client/src/components/support/ConversationRecovery.tsx:16` | `server/routes/support.routes.ts:120` | Matched |
| User/public | POST | `/api/support/ai/conversation-recovery/:param/:param` | `client/src/components/support/ConversationRecovery.tsx:25` | `server/routes/support.routes.ts:121` | Matched |
| User/public | GET | `/api/support/ai/delivery-actions` | `client/src/app/dashboard/(main)/settings/outreach/orchestration/page.tsx:111`<br>`client/src/app/dashboard/(main)/settings/outreach/orchestration/page.tsx:112`<br>`client/src/app/dashboard/(main)/settings/outreach/orchestration/page.tsx:113` | `server/routes/support.routes.ts:122` | Matched |
| User/public | POST | `/api/support/ai/delivery-actions/:param/reconcile` | `client/src/app/dashboard/(main)/settings/outreach/orchestration/page.tsx:165` | `server/routes/support.routes.ts:123` | Matched |
| User/public | PUT | `/api/support/ai/messages/:param/feedback` | `client/src/app/dashboard/(main)/support-ai/quality/page.tsx:332`<br>`client/src/components/support/SupportAnswerFeedback.tsx:36` | `server/routes/support.routes.ts:166` | Matched |
| User/public | GET | `/api/support/ai/orchestration-report` | `client/src/app/dashboard/(main)/settings/outreach/[agentType]/page.tsx:390`<br>`client/src/app/dashboard/(main)/settings/outreach/orchestration/page.tsx:110` | `server/routes/support.routes.ts:119` | Matched |
| User/public | GET | `/api/support/ai/playbook-templates` | `client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:215` | `server/routes/support.routes.ts:106` | Matched |
| User/public | POST | `/api/support/ai/playbook-templates/:param/install` | `client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:355` | `server/routes/support.routes.ts:107` | Matched |
| User/public | GET | `/api/support/ai/playbooks` | `client/src/app/dashboard/(main)/settings/outreach/[agentType]/page.tsx:370`<br>`client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:213` | `server/routes/support.routes.ts:104` | Matched |
| User/public | POST | `/api/support/ai/playbooks` | `client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:332` | `server/routes/support.routes.ts:108` | Matched |
| User/public | PUT | `/api/support/ai/playbooks/:param` | `client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:385` | `server/routes/support.routes.ts:111` | Matched |
| User/public | POST | `/api/support/ai/playbooks/:param/archive` | `client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:554` | `server/routes/support.routes.ts:113` | Matched |
| User/public | POST | `/api/support/ai/playbooks/:param/assignments` | `client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:464` | `server/routes/support.routes.ts:116` | Matched |
| User/public | DELETE | `/api/support/ai/playbooks/:param/assignments/:param` | `client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:487` | `server/routes/support.routes.ts:118` | Matched |
| User/public | PATCH | `/api/support/ai/playbooks/:param/assignments/:param/enabled` | `client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:527` | `server/routes/support.routes.ts:117` | Matched |
| User/public | PATCH | `/api/support/ai/playbooks/:param/enabled` | `client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:507` | `server/routes/support.routes.ts:114` | Matched |
| User/public | POST | `/api/support/ai/playbooks/:param/publish` | `client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:443` | `server/routes/support.routes.ts:112` | Matched |
| User/public | POST | `/api/support/ai/playbooks/:param/reset-default` | `client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:581` | `server/routes/support.routes.ts:115` | Matched |
| User/public | POST | `/api/support/ai/playbooks/validate` | `client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:269`<br>`client/src/app/dashboard/(main)/settings/outreach/playbooks/page.tsx:412` | `server/routes/support.routes.ts:109` | Matched |
| User/public | GET | `/api/support/ai/quality` | `client/src/app/dashboard/(main)/support-ai/quality/page.tsx:81` | `server/routes/support.routes.ts:165` | Matched |
| User/public | GET | `/api/support/ai/report` | `client/src/app/dashboard/(main)/support-ai/reports/page.tsx:116` | `server/routes/support.routes.ts:164` | Matched |
| User/public | GET | `/api/support/ai/sessions` | `client/src/app/dashboard/(main)/support-ai/chat/page.tsx:191` | `server/routes/support.routes.ts:167` | Matched |
| User/public | GET | `/api/support/ai/sessions/:param` | `client/src/app/dashboard/(main)/support-ai/chat/page.tsx:242`<br>`client/src/app/dashboard/(main)/support-ai/reports/page.tsx:137` | `server/routes/support.routes.ts:172` | Matched |
| User/public | PATCH | `/api/support/ai/sessions/:param` | `client/src/app/dashboard/(main)/support-ai/chat/page.tsx:1122`<br>`client/src/app/dashboard/(main)/support-ai/chat/page.tsx:288`<br>`client/src/app/dashboard/(main)/support-ai/chat/page.tsx:656` | `server/routes/support.routes.ts:176` | Matched |
| User/public | GET | `/api/support/ai/sessions/:param/messages` | `client/src/app/dashboard/(main)/leads/view/[id]/page.tsx:188` | `server/routes/support.routes.ts:168`<br>`server/routes/support.routes.ts:173` | Matched |
| User/public | GET | `/api/support/ai/sessions/by-lead/:param` | `client/src/app/dashboard/(main)/leads/view/[id]/page.tsx:172` | `server/routes/support.routes.ts:168`<br>`server/routes/support.routes.ts:169`<br>`server/routes/support.routes.ts:173` | Matched |
| User/public | POST | `/api/support/ai/simulate` | `client/src/app/dashboard/(main)/settings/outreach/orchestration/page.tsx:181` | `server/routes/support.routes.ts:126` | Matched |
| User/public | GET | `/api/support/ai/tool-executions` | `client/src/app/dashboard/(main)/settings/outreach/orchestration/page.tsx:114`<br>`client/src/app/dashboard/(main)/settings/outreach/orchestration/page.tsx:115` | `server/routes/support.routes.ts:124` | Matched |
| User/public | POST | `/api/support/ai/tool-executions/:param/reconcile` | `client/src/app/dashboard/(main)/settings/outreach/orchestration/page.tsx:209` | `server/routes/support.routes.ts:125` | Matched |
| User/public | GET | `/api/support/analytics` | `client/src/app/dashboard/(main)/support/analytics/page.tsx:36`<br>`client/src/app/dashboard/(main)/support/page.tsx:102` | `server/routes/support.routes.ts:180`<br>`server/routes/support.routes.ts:184` | Matched |
| User/public | POST | `/api/support/notification-deliveries/:param/retry` | `client/src/components/support/OwnerSupportNotificationSettings.tsx:102` | `server/routes/support.routes.ts:148` | Matched |
| User/public | GET | `/api/support/notification-health` | `client/src/components/support/OwnerSupportNotificationSettings.tsx:57` | `server/routes/support.routes.ts:144`<br>`server/routes/support.routes.ts:184` | Matched |
| User/public | GET | `/api/support/notification-settings` | `client/src/app/dashboard/(main)/support/teams/[id]/members/[memberId]/page.tsx:52`<br>`client/src/components/support/OwnerSupportNotificationSettings.tsx:56` | `server/routes/support.routes.ts:145`<br>`server/routes/support.routes.ts:184` | Matched |
| User/public | PUT | `/api/support/notification-settings/email` | `client/src/components/support/OwnerSupportNotificationSettings.tsx:72` | `server/routes/support.routes.ts:146` | Matched |
| User/public | PUT | `/api/support/notification-settings/whatsapp` | `client/src/components/support/OwnerSupportNotificationSettings.tsx:86` | `server/routes/support.routes.ts:147` | Matched |
| User/public | GET | `/api/support/teams` | `client/src/app/dashboard/(main)/support/[id]/page.tsx:245`<br>`client/src/app/dashboard/(main)/support/pipeline/page.tsx:29`<br>`client/src/app/dashboard/(main)/support/teams/page.tsx:116`<br>`client/src/components/support/CreateSupportTicketDialog.tsx:53` | `server/routes/support.routes.ts:132`<br>`server/routes/support.routes.ts:184` | Matched |
| User/public | POST | `/api/support/teams` | `client/src/app/dashboard/(main)/support/teams/page.tsx:160` | `server/routes/support.routes.ts:134` | Matched |
| User/public | DELETE | `/api/support/teams/:param` | `client/src/app/dashboard/(main)/support/teams/page.tsx:176` | `server/routes/support.routes.ts:136` | Matched |
| User/public | GET | `/api/support/teams/:param` | `client/src/app/dashboard/(main)/support/teams/[id]/members/[memberId]/activity/page.tsx:34`<br>`client/src/app/dashboard/(main)/support/teams/[id]/members/[memberId]/page.tsx:50`<br>`client/src/app/dashboard/(main)/support/teams/[id]/page.tsx:135` | `server/routes/support.routes.ts:129`<br>`server/routes/support.routes.ts:131`<br>`server/routes/support.routes.ts:133` | Matched |
| User/public | PUT | `/api/support/teams/:param` | `client/src/app/dashboard/(main)/support/teams/[id]/page.tsx:247`<br>`client/src/app/dashboard/(main)/support/teams/page.tsx:157` | `server/routes/support.routes.ts:130`<br>`server/routes/support.routes.ts:135` | Matched |
| User/public | POST | `/api/support/teams/:param/members` | `client/src/app/dashboard/(main)/support/teams/[id]/page.tsx:174`<br>`client/src/app/dashboard/(main)/support/teams/page.tsx:197` | `server/routes/support.routes.ts:137` | Matched |
| User/public | DELETE | `/api/support/teams/:param/members/:param` | `client/src/app/dashboard/(main)/support/teams/[id]/page.tsx:234` | `server/routes/support.routes.ts:139` | Matched |
| User/public | PUT | `/api/support/teams/:param/members/:param` | `client/src/app/dashboard/(main)/support/teams/[id]/members/[memberId]/page.tsx:128`<br>`client/src/app/dashboard/(main)/support/teams/[id]/page.tsx:213`<br>`client/src/app/dashboard/(main)/support/teams/[id]/page.tsx:225` | `server/routes/support.routes.ts:138` | Matched |
| User/public | GET | `/api/support/teams/:param/members/:param/presence` | `client/src/app/dashboard/(main)/support/teams/[id]/members/[memberId]/activity/page.tsx:34` | `server/routes/support.routes.ts:161` | Matched |
| User/public | PUT | `/api/support/teams/:param/members/:param/reset-password` | `client/src/app/dashboard/(main)/support/teams/[id]/members/[memberId]/page.tsx:99`<br>`client/src/app/dashboard/(main)/support/teams/[id]/page.tsx:192` | `server/routes/support.routes.ts:159` | Matched |
| User/public | GET | `/api/support/teams/:param/members/:param/tickets` | `client/src/app/dashboard/(main)/support/teams/[id]/members/[memberId]/page.tsx:51` | `server/routes/support.routes.ts:158` | Matched |
| User/public | PUT | `/api/support/teams/:param/members/:param/toggle-active` | `client/src/app/dashboard/(main)/support/teams/[id]/members/[memberId]/page.tsx:82`<br>`client/src/app/dashboard/(main)/support/teams/[id]/page.tsx:203` | `server/routes/support.routes.ts:160` | Matched |
| User/public | GET | `/api/support/teams/:param/tickets` | `client/src/app/dashboard/(main)/support/teams/[id]/page.tsx:148` | `server/routes/support.routes.ts:157`<br>`server/routes/support.routes.ts:198` | Matched |
| User/public | GET | `/api/support/teams/capacity-settings` | `client/src/app/dashboard/(main)/support/teams/page.tsx:131` | `server/routes/support.routes.ts:129`<br>`server/routes/support.routes.ts:133` | Matched |
| User/public | PUT | `/api/support/teams/capacity-settings` | `client/src/app/dashboard/(main)/support/teams/page.tsx:137` | `server/routes/support.routes.ts:130`<br>`server/routes/support.routes.ts:135` | Matched |
| User/public | GET | `/api/support/teams/routing-estimate` | `client/src/components/support/CreateSupportTicketDialog.tsx:44` | `server/routes/support.routes.ts:131`<br>`server/routes/support.routes.ts:133` | Matched |
| User/public | GET | `/api/wallet` | `client/src/app/dashboard/(main)/billing/page.tsx:74`<br>`client/src/app/dashboard/(main)/billing/recharge/page.tsx:157`<br>`client/src/components/Header.tsx:73`<br>`client/src/components/billing/CreditCosts.tsx:48`<br>+1 more | `server/routes/wallet.routes.ts:55` | Matched |
| User/public | GET | `/api/wallet/campaign-spending` | `client/src/app/dashboard/(main)/billing/_components/CategorySpends.tsx:129` | `server/routes/wallet.routes.ts:82` | Matched |
| User/public | GET | `/api/wallet/daily-transactions` | `client/src/app/dashboard/(main)/billing/_components/DaywiseSpends.tsx:52`<br>`client/src/app/dashboard/(main)/billing/analytics/page.tsx:72` | `server/routes/wallet.routes.ts:70` | Matched |
| User/public | GET | `/api/wallet/deduction-summary` | `client/src/app/dashboard/(main)/billing/analytics/page.tsx:63` | `server/routes/wallet.routes.ts:73` | Matched |
| User/public | GET | `/api/wallet/drilldown/details` | `client/src/app/dashboard/(main)/billing/_components/CampaignSpends.tsx:121`<br>`client/src/app/dashboard/(main)/billing/transactions/page.tsx:134` | `server/routes/wallet.routes.ts:90` | Matched |
| User/public | GET | `/api/wallet/drilldown/references` | `client/src/app/dashboard/(main)/billing/_components/CampaignSpends.tsx:101`<br>`client/src/app/dashboard/(main)/billing/transactions/page.tsx:110` | `server/routes/wallet.routes.ts:88` | Matched |
| User/public | GET | `/api/wallet/event-logs` | `client/src/app/dashboard/(main)/billing/spending-by-provider/page.tsx:90` | `server/routes/wallet.routes.ts:64` | Matched |
| User/public | GET | `/api/wallet/provider-usage` | `client/src/hooks/use-provider-credit-usage.ts:18` | `server/routes/wallet.routes.ts:76` | Matched |
| User/public | GET | `/api/wallet/razorpay-key` | `client/src/app/dashboard/(main)/billing/recharge/page.tsx:94` | `server/routes/wallet.routes.ts:94` | Matched |
| User/public | POST | `/api/wallet/recharge/create-order` | `client/src/app/dashboard/(main)/billing/recharge/page.tsx:163` | `server/routes/wallet.routes.ts:97` | Matched |
| User/public | POST | `/api/wallet/recharge/verify` | `client/src/app/dashboard/(main)/billing/recharge/page.tsx:181` | `server/routes/wallet.routes.ts:98` | Matched |
| User/public | GET | `/api/wallet/transactions` | `client/src/app/dashboard/(main)/billing/_components/RechargeHistory.tsx:81`<br>`client/src/app/dashboard/(main)/billing/page.tsx:79`<br>`client/src/components/billing/CreditActivity.tsx:66` | `server/routes/wallet.routes.ts:58` | Matched |
| User/public | GET | `/api/wallet/usage` | `client/src/components/billing/CreditCosts.tsx:55` | `server/routes/wallet.routes.ts:61` | Matched |
| User/public | GET | `/api/webhooks/config` | `client/src/app/dashboard/(main)/integrations/msg91/components/MSG91Callbacks.tsx:22` | `server/routes.ts:608` | Matched |
| User/public | DELETE | `/api/whatsapp/config` | `client/src/app/dashboard/(main)/integrations/whatsapp/page.tsx:160` | `server/routes.ts:560` | Matched |
| User/public | GET | `/api/whatsapp/config` | `client/src/app/dashboard/(main)/integrations/page.tsx:17`<br>`client/src/app/dashboard/(main)/integrations/whatsapp/page.tsx:61`<br>`client/src/components/whatsapp-templates/WhatsAppTemplateEditor.tsx:130` | `server/routes.ts:556` | Matched |
| User/public | POST | `/api/whatsapp/manual-credentials` | `client/src/app/dashboard/(main)/integrations/whatsapp/components/WhatsAppConfig.tsx:67`<br>`client/src/app/dashboard/(main)/integrations/whatsapp/components/WhatsAppConnection.tsx:106` | `server/routes.ts:727` | Matched |
| User/public | GET | `/api/whatsapp/oauth/url` | `client/src/app/dashboard/(main)/integrations/whatsapp/components/WhatsAppConfig.tsx:84`<br>`client/src/app/dashboard/(main)/integrations/whatsapp/components/WhatsAppConnection.tsx:134`<br>`client/src/app/dashboard/(main)/integrations/whatsapp/page.tsx:120` | `server/routes.ts:563` | Matched |
| User/public | GET | `/api/whatsapp/templates` | `client/src/components/whatsapp-templates/WhatsAppTemplateLibrary.tsx:259` | `server/routes.ts:590` | Matched |
| User/public | POST | `/api/whatsapp/templates` | `client/src/components/whatsapp-templates/WhatsAppTemplateEditor.tsx:457` | `server/routes.ts:592` | Matched |
| User/public | DELETE | `/api/whatsapp/templates/:param` | `client/src/components/whatsapp-templates/WhatsAppTemplateDetails.tsx:141` | `server/routes.ts:598` | Matched |
| User/public | GET | `/api/whatsapp/templates/:param` | `client/src/components/Breadcrumbs.tsx:18`<br>`client/src/components/whatsapp-templates/WhatsAppTemplateDetails.tsx:116`<br>`client/src/components/whatsapp-templates/WhatsAppTemplateEditor.tsx:214`<br>`client/src/components/whatsapp-templates/WhatsAppTemplateEditor.tsx:491` | `server/routes.ts:591` | Matched |
| User/public | PUT | `/api/whatsapp/templates/:param` | `client/src/components/whatsapp-templates/WhatsAppTemplateEditor.tsx:456` | `server/routes.ts:594` | Matched |
| User/public | POST | `/api/whatsapp/templates/:param/media` | `client/src/components/whatsapp-templates/WhatsAppTemplateEditor.tsx:469` | `server/routes.ts:595` | Matched |
| User/public | POST | `/api/whatsapp/templates/:param/refresh` | `client/src/components/whatsapp-templates/WhatsAppTemplateDetails.tsx:169` | `server/routes.ts:596` | Matched |
| User/public | POST | `/api/whatsapp/templates/:param/submit` | `client/src/components/whatsapp-templates/WhatsAppTemplateEditor.tsx:482` | `server/routes.ts:597` | Matched |
| User/public | POST | `/api/whatsapp/templates/media-preflight` | `client/src/components/whatsapp-templates/WhatsAppTemplateEditor.tsx:426` | `server/routes.ts:593` | Matched |
| User/public | POST | `/api/whatsapp/templates/sync` | `client/src/components/support/OwnerSupportNotificationSettings.tsx:96`<br>`client/src/components/whatsapp-templates/WhatsAppTemplateLibrary.tsx:372` | `server/routes.ts:599` | Matched |
| User/public | POST | `/api/whatsapp/test` | `client/src/app/dashboard/(main)/integrations/whatsapp/page.tsx:132` | `server/routes.ts:559` | Matched |
| User/public | POST | `/api/whatsapp/toggle` | `client/src/app/dashboard/(main)/integrations/whatsapp/page.tsx:180` | `server/routes.ts:558` | Matched |
| User/public | GET | `/api/widgets` | `client/src/components/widgets/api.ts:21` | `server/routes/widget.routes.ts:309` | Matched |
| User/public | DELETE | `/api/widgets/:param` | `client/src/components/widgets/api.ts:65` | `server/routes/widget.routes.ts:825` | Matched |
| User/public | PATCH | `/api/widgets/:param` | `client/src/components/widgets/api.ts:33` | `server/routes/widget.routes.ts:340` | Matched |
| User/public | GET | `/api/widgets/:param/ad-review` | `client/src/components/widgets/PublishAdsWidget.tsx:139`<br>`client/src/components/widgets/PublishAdsWidget.tsx:153` | `server/routes/widget.routes.ts:281` | Matched |
| User/public | POST | `/api/widgets/:param/ad-review` | `client/src/components/widgets/PublishAdsWidget.tsx:189` | `server/routes/widget.routes.ts:248` | Matched |
| User/public | POST | `/api/widgets/:param/close` | `client/src/components/widgets/api.ts:49` | `server/routes/widget.routes.ts:772` | Matched |
| User/public | POST | `/api/widgets/:param/reopen` | `client/src/components/widgets/api.ts:57` | `server/routes/widget.routes.ts:801` | Matched |
| User/public | GET | `/api/widgets/:param/stop-review` | `client/src/components/widgets/StopAdsWidget.tsx:36` | `server/routes/widget.routes.ts:228` | Matched |
| User/public | POST | `/api/widgets/:param/submit` | `client/src/components/widgets/api.ts:41` | `server/routes/widget.routes.ts:382` | Matched |
| User/public | POST | `/api/workflow/cancel` | `client/src/components/tabs/LeadsTab.tsx:396`<br>`client/src/components/tabs/LeadsTab.tsx:415` | `server/routes.ts:379` | Matched |
| User/public | GET | `/api/workflow/logs/thread/:param` | `client/src/components/tabs/LeadsTab.tsx:571` | `server/routes.ts:373` | Matched |
| User/public | POST | `/api/workflow/stop-thread` | `client/src/components/tabs/LeadsTab.tsx:409` | `server/routes.ts:380` | Matched |
| User/public | GET | `/api/workflows` | `client/src/components/WorkflowSelectorModal.tsx:50` | `server/routes.ts:853` | Matched |
| User/public | GET | `/api/workflows/existing-inputs/:param` | `client/src/components/tabs/LeadsInputsTab.tsx:247`<br>`client/src/components/tabs/LeadsTab.tsx:944` | `server/routes.ts:803` | Matched |
| User/public | GET | `/api/workflows/sub-workflows` | `client/src/components/tabs/LeadsInputsTab.tsx:238` | `server/routes.ts:852`<br>`server/routes.ts:854` | Matched |
| User/public | POST | `/api/youtube/manage/analytics/sync` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:147` | `server/controllers/youtubeManagementController.ts:95` | Matched |
| User/public | DELETE | `/api/youtube/manage/captions/:param` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:143` | `server/controllers/youtubeManagementController.ts:89` | Matched |
| User/public | POST | `/api/youtube/manage/chapters/validate` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:124` | `server/controllers/youtubeManagementController.ts:91` | Matched |
| User/public | POST | `/api/youtube/manage/comments/:param/moderate` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:152` | `server/controllers/youtubeManagementController.ts:98` | Matched |
| User/public | POST | `/api/youtube/manage/comments/:param/replies` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:153` | `server/controllers/youtubeManagementController.ts:99` | Matched |
| User/public | GET | `/api/youtube/manage/playlists` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:138` | `server/controllers/youtubeManagementController.ts:84` | Matched |
| User/public | GET | `/api/youtube/manage/readiness` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:82` | `server/controllers/youtubeManagementController.ts:56` | Matched |
| User/public | POST | `/api/youtube/manage/uploads/finalize` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:110` | `server/controllers/youtubeManagementController.ts:74` | Matched |
| User/public | POST | `/api/youtube/manage/uploads/initiate` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:97` | `server/controllers/youtubeManagementController.ts:55` | Matched |
| User/public | PATCH | `/api/youtube/manage/videos/:param` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:118`<br>`client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:126` | `server/controllers/youtubeManagementController.ts:82` | Matched |
| User/public | GET | `/api/youtube/manage/videos/:param/captions` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:141` | `server/controllers/youtubeManagementController.ts:87` | Matched |
| User/public | POST | `/api/youtube/manage/videos/:param/captions` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:142` | `server/controllers/youtubeManagementController.ts:88` | Matched |
| User/public | GET | `/api/youtube/manage/videos/:param/comments` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:151` | `server/controllers/youtubeManagementController.ts:97` | Matched |
| User/public | POST | `/api/youtube/manage/videos/:param/playlists` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:140` | `server/controllers/youtubeManagementController.ts:85` | Matched |
| User/public | POST | `/api/youtube/manage/videos/:param/thumbnail` | `client/src/app/dashboard/(main)/integrations/youtube/YouTubeStudioPanel.tsx:132` | `server/controllers/youtubeManagementController.ts:83` | Matched |
| User/public | GET | `/api/youtube/oauth/auth` | `client/src/app/dashboard/(main)/integrations/youtube/page.tsx:60` | `server/controllers/youtubeOAuthController.ts:81` | Matched |
| User/public | POST | `/api/youtube/oauth/disconnect` | `client/src/app/dashboard/(main)/integrations/youtube/page.tsx:71` | `server/controllers/youtubeOAuthController.ts:285` | Matched |
| User/public | GET | `/api/youtube/oauth/status` | `client/src/app/dashboard/(main)/integrations/page.tsx:42`<br>`client/src/app/dashboard/(main)/integrations/youtube/page.tsx:37` | `server/controllers/youtubeOAuthController.ts:247` | Matched |
