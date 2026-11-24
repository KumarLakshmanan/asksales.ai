# Pricing and subscriptions

## Customer pages

- `/pricing`: six fixed INR plans, monthly/yearly totals, comparison, FAQs and a five-question finder.
- `/subscribe`: account setup/approval guidance, checkout and payment recovery.
- `/dashboard/billing/subscription`: renewals, next-cycle changes, cancellation and verified invoices.
- `/dashboard/billing/recharge`: extra credits for active paid subscribers.

Every plan includes the same features. Yearly purchases save 20% compared with twelve monthly payments and deposit credits in twelve monthly instalments. Unused credits roll over indefinitely. Cancellation stops renewal while retaining the paid term and its remaining deposits. Lapsed accounts retain their wallet, but cannot spend it until access resumes.

The plan finder keeps customer type and content frequency single-select. Workflow focus accepts multiple choices and explains every selected workflow in the result. Two or more workflows use the original mixed-workflow guidance weight of 2, rather than adding overlapping work repeatedly. Lead and outreach volumes use keyboard-accessible range sliders with five labelled bands; they start at “Up to 100” and retain their values when going back. Restart clears choices and resets both sliders. Finder answers stay in component memory.

The catalog lives in `shared/subscriptions.ts` and migration `298_pricing_subscriptions.js`. Published versions are immutable. Do not change a Razorpay plan or a historical charge to implement a price change.

## Administrator setup

1. Open **Admin → Settings → Subscriptions** as a super administrator.
2. Choose an active Razorpay credential. Use **test mode on staging**. The dedicated subscription webhook secret is encrypted with the existing integration secret storage.
3. Save a webhook secret of at least 16 characters, then explicitly provision the twelve plans. Provisioning is resumable; ordinary page loads do not create provider plans.
4. In the matching Razorpay dashboard mode, add the webhook URL displayed by AskSales. On staging it begins `https://dev.asksales.ai/api/webhooks/razorpay/subscriptions/` and ends with the selected credential ID. Use exactly the same secret in both systems.
5. Subscribe to `subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.paused` and `subscription.resumed`. A successfully processed event for a managed subscription verifies delivery. A dashboard sample for an unrelated subscription does not satisfy the launch check.
6. Complete monthly and yearly test purchases. Test charges never fund spendable wallets or establish paid access. Keep evidence in the charge ledger.
7. A live launch additionally requires live credentials, twelve live plan mappings, a verified webhook for a managed live subscription since the latest credential or secret change, and no unresolved reconciliation or deposit errors. Earlier test events do not count as live delivery. The admin screen refuses enforcement until every check passes. Production credentials must not be copied into staging.

**Current QA evidence (26 September 2026):** real Razorpay test purchases for Starter monthly (₹100) and yearly (₹960) were verified against captured payments and paid invoices. The ledger created 1 and 12 deposits respectively; only the first due deposit in each was marked simulated. Automated tests separately verify real wallet transactions, concurrency, rollover and delayed deposits using an isolated database and a fake provider.

## Access and recovery

The first enable action records an immutable launch timestamp. Accounts created before it receive 30 days of access. Failed renewals receive seven days beyond the last paid period, with no unpaid deposits. This also covers an authorized next-cycle plan change whose payment fails. Cancelling that pending change ends its recovery access once the old paid term has expired. Disabling and re-enabling enforcement does not reset the launch timestamp.

Authentication, setup, billing, account, support and legal endpoints remain available. Operational HTTP requests, credit reservations and paid background work check access on the server. Module availability remains independent of subscription tier.

Plan changes authorize a replacement mandate at the next renewal before cancelling the old mandate. No proration or immediate upgrade charge is applied. Uncertain provider creation responses are reconciled by the saved local ID before another mandate can be created.

## Monitoring and incident recovery

- Workers run `cron-subscription-reconciliation` every minute. Provider reconciliation occurs approximately every 15 minutes per subscription; due annual deposits are processed every minute.
- The admin screen reports overdue deposits, missing deposit rows and subscriptions with reconciliation errors. **Reconcile now** retries provider checks.
- Webhook HMAC uses the original request bytes. Payment and invoice IDs, ownership, currency, full plan amount and billing period are checked before a deposit is scheduled.
- Webhook replay and refresh are safe. Each payment/month pair can create only one wallet transaction; duplicate or delayed events cannot advance access twice.
- If checkout creation remains uncertain, inspect the matching provider subscription notes before resolving the local record. Do not create a replacement blindly.
- Roll back application code with enforcement disabled if needed. Retain billing tables and the audit ledger; do not roll back migration 298 after receiving charges.

## Development checks

```bash
SUBSCRIPTIONS_LOCAL_QA=1 pnpm --dir server test --runInBand subscriptions.test.ts subscriptionsPostgres.test.ts csrf.test.ts
E2E_BASE_URL=http://127.0.0.1:3107 E2E_SKIP_WEBSERVER=1 pnpm --dir client exec playwright test e2e/subscriptions.spec.ts
pnpm --dir server build
pnpm --dir server build:worker
```

`server/scripts/verify-subscriptions.ts` is a local-only Razorpay test checkout harness. It refuses remote databases, live credentials and enabled enforcement. It creates two explicitly named non-login QA accounts and serves the monthly/yearly test checkout on loopback port 3118.

Use `deploy-staging.sh` from a clean, committed release checkout for `dev.asksales.ai`. Follow `.github/instructions/deployment.instructions.md`; the script deploys committed HEAD and preserves the separate staging environment.

Provider references: [subscription integration](https://razorpay.com/docs/payments/subscriptions/integration-guide/), [webhooks](https://razorpay.com/docs/payments/subscriptions/subscribe-to-webhooks/), [UPI plan-change restriction](https://razorpay.com/docs/api/payments/subscriptions/update-subscription/).
