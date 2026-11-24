# Business profile identity

The business profile (`company_settings.id`) is the customer-facing business,
workspace and organization. Staff join that profile. Billing organization IDs
remain internal payer identifiers so existing subscriptions, grants, wallet
balances, provider metadata and transactions retain their original ownership.

An owner's profiles continue sharing the owner's payer and allowances. Staff
membership in one profile does not grant access to its owner's other profiles.
Profile creation always uses the creator's account, even when a colleague's
profile was selected. Existing resources cannot be financially reparented.

## Authority

- Owner: business identity, staff invitations/roles, support-agent provisioning,
  notification consent, billing and ordinary business operations.
- Billing admin: business operations, connections and subscription management.
- Member: ordinary business operations and spending shared credits; no billing
  changes, connection administration or staff management.
- Separate support-agent logins retain their existing permissions and seat count.

`req.user` is always the authenticated actor. `BusinessScope.userId` and persisted
business `user_id` columns remain the owner. Use `businessOwnerUserId(req)` for
business records and actual actor IDs for personal settings, approval/audit
attribution and permissions. RLS checks both owner and active staff identity.
Jobs and OAuth state persist and revalidate the original actor/profile. Rejected
prepaid jobs may run only their trusted refund callback against the original payer.

## Migration

304 creates profile staff and preferences, seeds owners, updates RLS, and counts
canonical staff. Old billing memberships remain financial evidence and are never
automatically promoted to business-data access. Owners explicitly invite staff.
The `workspaces` allowance is a compatibility alias of business-profile capacity.
305 attaches legacy AI report-branding adapters to profiles, splitting an adapter
when its websites belonged to different profiles. Website IDs and branding remain.
306 records the actual staff author on support ticket replies.

No migration changes financial history. Take a database backup before deployment;
rollback of identity migrations requires restoring the verified backup.

## Verification

Use a disposable local database with migrations applied and explicitly set
`BUSINESS_STAFF_TEST_DATABASE=asksales_profile_identity_qa` to run
`server/tests/businessStaffIdentityPostgres.test.ts`. It covers invitations,
verified-email acceptance, SQL isolation, billing selectors, roles, shared wallet
charges, attribution, jobs, revocation and original-payer refunds.

Additional focused tests: businessStaffOauth, businessScopeBoundaries,
billingOrganizations, chatHttpBusinessProfile, subscriptions and realtimeGateway.
Frontend fixtures cover staff management, invitation acceptance before setup,
profile switching and pricing on desktop/mobile.
