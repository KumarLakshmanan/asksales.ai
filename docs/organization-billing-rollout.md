# Organization billing rollout

## Catalog and ownership

Migrations 300–303 create platform billing organizations, versioned subscription
catalogs, organization wallets and capacity accounting. AI Visibility organization
groupings remain separate. Each existing user receives a default billing
organization. Existing wallet balances, transaction records, subscriptions,
grants, storage and subscription grace dates retain their original values.

Catalog version 1 remains the published legacy catalog after migration. Version 2
is an editable draft containing the approved Starter, Growth and Scale plans.
Publish it from **Admin → Organization plans & credits → Plans & allowances**.
Publishing provisions six Razorpay plans before activating the catalog. Published
versions are immutable; create a new draft to change prices or allowances.

Monthly prices are ₹500 / ₹1,500 / ₹5,000; annual totals are ₹4,800 / ₹14,400 /
₹48,000, tax included. Annual customers receive twelve monthly deposits. Capacity
is current usage, not a monthly activity budget. Legacy subscriptions retain
their purchased credits/prices and legacy storage allowance until adopting a new
catalog plan.

Confirmed provider refunds remain recorded against the original charge. Partial
and full refunds stop that charge's paid access and cancel its remaining credit
deposits. Already deposited credits retain their balance and rollover; the
system does not invent a debt or erase historical ledger entries. Capacity keeps
the last adopted cap, as it does after a subscription lapse. Admin payment setup
shows refund evidence separately and checks that all remaining deposits were
cancelled. Refund and payment-only webhooks resolve the original subscription
through verified provider payment/invoice ownership.

## Access and APIs

- `/api/organizations` lists only the caller's organizations and invitations.
- Organization owners manage members; owners and billing admins manage payments.
- `X-Billing-Organization-Id` selects an authorized organization on billing pages.
  Operational APIs derive responsibility from the persisted resource association.
- Billing membership does not grant business or workspace data access.
- Explicit resource assignment moves its linked resource accounting. Historical
  funds, transactions, grants and reservations stay with their original payer.
- `/api/subscriptions/catalog` is public. Checkout submits `catalogVersion`,
  `plan` and `term`; the server selects the price from the published catalog.
- `/api/admin/subscriptions/catalog` manages draft/publish/retire operations.
- `/api/admin/subscriptions/organizations` lists organization balances. The
  matching `/:organizationId/credits` endpoint requires a reason and audits the
  adjustment in the same transaction as the ledger entry.
- `/api/admin/subscriptions/capacity-enforcement` switches reporting/enforcement.
  Enabling it requires every organization to reconcile successfully.

Capacity errors use `PLAN_LIMIT_EXCEEDED` with `resource`, `current`,
`requestedIncrease`, `limit` and `organizationId`. Resource triggers serialize
changes by organization, including imports, restorations, activation, OAuth
connection completion and file writes. Upload reservations cover concurrent
uploads before their durable metadata exists. Existing over-limit data remains
available; reductions and net-zero replacements are permitted.

## Staging deployment

Use only `deploy-staging.sh` for `dev.asksales.ai`. It builds before stopping the
staging API/workers, takes a private PostgreSQL backup in
`/var/backups/asksales-dev`, applies migrations and starts the new services.
The old binary must not run against migration 301 because wallet ownership and
subscription account keys have changed. Rollback requires coordinated code and
database restoration from the staging backup; the financial migrations reject a
destructive down migration.

1. Deploy with capacity enforcement disabled (the migration default).
2. Verify `billing_capacity_reconciliation(id)` returns `[]` for every organization
   in a system-authorized administrative query. Compare pre/post wallet, ledger,
   subscription, pending-grant and storage totals.
3. Publish the approved catalog using the staging test credential. Complete and
   verify monthly and yearly test checkouts. Test credit grants are simulated.
4. Enable capacity enforcement after reconciliation and checkout verification.
5. Keep live subscription enforcement behind its existing readiness gate:
   monthly/yearly test evidence, current live credential, provisioned plans,
   verified live webhook and reconciled grants. Test-mode readiness does not
   satisfy live-payment readiness.

## Verification

Focused suites include `billingOrganizations.test.ts`,
`organizationCapacityPostgres.test.ts`, `subscriptionsPostgres.test.ts`,
`queuedAuditBillingPostgres.test.ts`, `subscriptions.test.ts`,
`walletRechargeVerification.test.ts`, `creditService.test.ts` and the client
organization pricing/API tests. PostgreSQL tests require their explicit local QA
environment switch; consult each suite's fixture setup.

The guarded `server/scripts/qa-organization-wallet.mts` exercises real wallet
mutations, concurrent debits/refunds, resource transfers, payload redaction and
catalog publication using an in-memory payment provider. Run it only against a
disposable local `salesmarketing_org_billing_qa_*` database. It creates QA rows.

Browser coverage lives in `client/e2e/subscriptions.spec.ts` and
`client/e2e/organization-billing.spec.ts` for desktop/mobile pricing, finder,
organization switching, roles, membership, assignment, admin publication and
credit adjustments.
