# Provider authorization lifecycle

OAuth callbacks for Gmail, Google Ads, YouTube, Search Console, Facebook,
Instagram and Meta Ads require the initiating browser session and a one-time
business binding. Provider state signatures alone do not establish that binding.
The browser/session, actor, callback URI and issuing application configuration
must still match when the callback is consumed. Failure to read Redis or validate
the actor fails closed; users start authorization again.

Gmail uses a signed PKCE challenge and a per-flow HttpOnly verifier cookie.
Google Ads, YouTube and Search Console keep their PKCE verifier in a ten-minute
Redis browser-flow record. Meta flows retain their provider nonce checks and use
the same browser-flow guard without assuming unsupported PKCE parameters. Records
store session and cookie hashes, not the application JWT. Cookies use the existing
production Secure policy, SameSite=Lax and the /api/ path. API-host callbacks can
hand off once to the configured trusted frontend host so its host-only cookies
can be checked. Callback responses are non-cacheable and suppress referrers.

Existing in-flight authorization attempts must restart when this flow format is
introduced. No database migration or new credential is required. This change does
not alter deployed provider registrations, credentials, permission approvals or
live settings.

## Refresh and connection status

Gmail, X, LinkedIn and the YouTube publishing credential refresh path serialize
refreshes through a PostgreSQL row lock and re-read the exact active owner,
platform and account under that lock. Provider requests have bounded timeouts;
application configuration is resolved before entering the locked transaction to
avoid acquiring a second pooled connection while holding a lock. Reconnect and
disconnect writes to the same row wait for the refresh transaction.

A valid replacement receipt is encrypted before persistence. An invalid_grant
response marks that exact authorization as requiring reconnection. A timeout,
rate limit, malformed receipt or transient provider failure does not deactivate
the grant. Gmail SDK clients receive access token expiry but no refresh token,
preventing an uncoordinated SDK refresh or implicit replay of an application send.

Gmail status distinguishes changed issuing clients, authorization expiry,
temporary status failures, recorded cooldown and pending synchronization. This is
saved connection health, not proof of current provider availability. Recorded
initial watch failures are retried by the existing renewal worker; explicitly
stopped watches clear those retry fields.

## Disconnect semantics and owner decisions

The Gmail-specific disconnect retains its existing business-wide contract. It
locks the captured active Gmail accounts, attempts each distinct grant's remote
revocation, clears local secrets and removes only their Gmail sender bindings.
Remote HTTP rejection produces a visible partial-revocation warning. The generic
integration disconnect remains local-only and reports
remoteRevocationAttempted=false. Its alias predicates include gmail_api and use
typed IN expressions rather than interpolating arrays into ANY.

Google revokes grants at provider-defined scope, which can affect another Google
feature using the same client grant. Account-specific disconnect UX, shared-grant
separation and incremental Gmail consent require an explicit product decision.
The central connection-manager permission and capacity guards remain owned by the
tenant implementation. Search Console/LinkedIn pagination and large-mailbox
resumable backfill remain with the analytics/inbox/queue owners.

## Verification

Run the focused Gmail/provider Jest suites, including
providerOAuthBrowserFlow.test.ts and providerTokenRefresh.test.ts. Run
providerCredentialLifecyclePostgres.test.ts only against an explicitly disposable
synthetic PostgreSQL fixture using PROVIDER_FIXES_QA_DATABASE_URL; its guard requires
the audit-only Unix socket. It covers concurrent refresh/reconnect, terminal vs
transient failure, encrypted rotation, disconnect isolation and real SQL aliases.
No production database is an acceptable substitute.

Client coverage includes emailIntegrationComponents.test.tsx and
gmail-oauth-connection.spec.ts on desktop and mobile. Providers must be mocked;
these checks do not establish live OAuth app approval, revocation or delivery.
