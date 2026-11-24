# Scan bundle remediation — 29 October 2026

The attached `scan-bundle (3).tar.gz` reports 14 findings against revision
`a7c8ee088550c82a49dbe932a564807a1201b85f`. Its JSON findings and SARIF export
both contain the same 14 issues. The report's coverage is partial; these changes
address the reported issues and do not establish that the entire repository is
free of vulnerabilities.

All 14 reported issues are implemented and deployed to the `v7` production
environment at `4fd73fae76494231b8e90e168a8f10ab080b5a7e`. Production verification
completed on 30 October 2026 IST (29 October 2026, 20:08 UTC). The API, both
workers and client are healthy at that exact revision; migrations 578/579 are
applied and all 346 migration entries are current.

The user confirmed on 29 October that all three exposed credentials were revoked,
and approved production rollout, the irreversible migrations and coordinated
shared-history cleanup. All 56 approved shared heads/tags were rewritten with
atomic expected-revision guards and verified; workflow states were restored.
Production `v7` was subsequently advanced to the verified security release.
Other private local branches/worktrees and recovery copies were preserved.

The user explicitly waived GitHub CI after billing prevented jobs from starting,
and later instructed us to skip replacement Google media credentials. Linux image
checks and live production verification passed. Google image/video generation
remains unavailable until valid credentials are configured. The detailed fixes
and verification evidence follow.

| Report finding | Repository remediation | Regression coverage |
| --- | --- | --- |
| 1. Stored email XSS in print/pop-out windows | Both actions use DOM text nodes, a script-denying document CSP, and opener isolation. No email fields enter `document.write`. | `emailMessageWindow.test.ts`, existing email rendering tests |
| 2. Cross-tenant workflow mutation | Custom definitions use opaque UUIDs, business-specific directories, exclusive creation, ownership checks and atomic replacements. Shared catalogs exclude legacy tenant definitions. | `scanWorkflowIsolation.test.ts`, `workflowCatalogBoundary.test.ts` |
| 3. IPv6/DNS-rebinding SSRF | IP parsing normalizes mapped IPv6 and rejects nonpublic ranges. Each redirect hop uses approved DNS addresses in a dedicated dispatcher, preserves TLS identity and verifies the connected peer. Cross-origin redirects strip credentials. | `safeRemoteFetch.test.ts`, `publicFetchPinning.test.ts` |
| 4. Committed cloud/provider credentials | Removed the service-account JSON and source literals. Legacy Vertex file loading now requires an explicit runtime mount. Docker context exclusions and CI scanning cover credential JSON, private keys and source literals. The user confirmed all three credentials are revoked. All 56 approved shared refs were cleaned and verified; replacement Google media credentials were explicitly skipped, and historical provider usage was not audited. | `scripts/check-build-secrets.mjs`, build-context checks, full reachable-object scan and atomic publication verification |
| 5. Unapproved direct workflow execution | Both legacy tenant execution handlers return `410 WORKFLOW_APPROVAL_REQUIRED` without invoking a provider. Lead execution uses the existing conversation approval flow. The authenticated platform-admin testing route remains separate. | `scanWorkflowIsolation.test.ts` |
| 6. Screenshot browser SSRF | The browser receives content from the same pinned HTTP transport; redirects resolve before browser navigation. Scripts, service workers and WebSockets are disabled/blocked. Chromium uses its sandbox and a nonfunctional proxy as an independent direct-network backstop. API Compose services use a default-deny namespace-compatible seccomp profile and a Debian runtime to keep Chromium's sandbox operational on Linux. Every result is validated before upload. | `publicScreenshot.test.ts` with real isolated Chromium; `scripts/check-chromium-sandbox.sh` verifies kernel sandbox state, PNG rendering and zero direct loopback requests on Linux |
| 7. Member administration of provider connections | Explicit connection-management middleware and handler checks cover credential access, selection, toggles, disconnects and OAuth aliases. Owners and billing admins retain connection authority. | `scanPermissionBoundaries.test.ts`, existing provider/WhatsApp tests |
| 8. Member disclosure of webhook capabilities | Full URL/verify-token disclosure requires manager authority, including Facebook/Twitter/LinkedIn status aliases. Callbacks use signed, business-bound, purpose-specific capabilities that expire after 90 days; SMS delivery has a separate purpose. Verification credentials bind to the exact capability. Public routes reject durable legacy tokens, check the current owner nonce and establish separate verified callback authority. Rotation remains owner-only; migration 579 and later staff authority changes revoke old capabilities. | `webhookCapabilityScope.test.ts`, `userWebhookTokens.test.ts`, `providerOAuthStatusContract.test.ts`, Meta status tests, and migration tests |
| 9. Unverified Meta routing identities | Verify token app, expiry, scopes and exact provider-returned Page/Instagram linkage. The legacy manual alias delegates to the same handler. Credential/routing writes are transactional; global partial unique indexes reject active identity conflicts; ambiguous reads fail closed. | `metaManualIdentity.test.ts`, `scanMigrationsPostgres.test.ts` |
| 10. Member AI policy/playbook changes | Owner checks protect configuration and playbook mutations at routes and handlers, with additional ownership checks in shared activation/template services. Existing audit actor attribution is retained. | Permission tests and existing support governance tests |
| 11. Public admin bootstrap | Disabled unless a deployment secret of at least 32 characters and a future expiry within one hour are provided. Constant-time header verification precedes password hashing/database access. Existing one-time database lock remains. Production readiness requires an initialized administrator. | `adminSessionSecurity.test.ts` |
| 12. Unbounded AI demo parsing | Only verified PDF/PNG/JPEG/WebP inputs up to 5 MiB are accepted. Disposable PDF/image processes have heap, pixel/page/text/output and time limits. Providers have 20-second deadlines, bounded responses, capped output and no OpenAI retries. Tenant rate/concurrency limits and an atomic credit precharge precede paid work; failures refund the original deduction. | `boundedDemoInput.test.ts`, `demoParseCredits.test.ts`, upload tests |
| 13. 500 MiB in-memory support upload | Multipart streams spool to private temporary files. Limits: 5 MiB/file, 20 MiB file data/request, 5 files/request, two uploads/business/process, eight/process, and a 30-second upload deadline. Image decoding runs in disposable bounded processes. The client splits a 50-image gallery selection into sequential bounded requests. | `boundedUpload.test.ts`, `boundedDemoInput.test.ts`, `supportMediaUpload.test.ts` |
| 14. Admin revocation/logout failures | Privileged revocation checks fail closed. Logout returns retryable 503 without claiming success when persistence fails. New admin access tokens expire after one hour and require a revocable JTI. | `adminSessionSecurity.test.ts` |

## Rollout record and owner follow-up

1. All three exposed credentials are revoked according to the user's confirmation.
   Runtime credential replacement was explicitly skipped. Configure valid Google
   media credentials privately in Admin Integrations when restoring those features.
   Historical provider usage and live IAM were not independently audited.
2. The 56-ref shared-history cleanup is published and verified. Collaborators must
   resynchronize their clones by recloning or rebasing onto cleaned history; merging
   an old branch can reintroduce it. Private worktrees and retained recovery images,
   backups and archives require their owners' retention handling. GitHub retains
   24 affected provider-controlled pull-request refs. Its Support policy limits
   cached-data removal to risks that rotation cannot mitigate; the exposed keys
   here are already revoked. See
   [GitHub's policy](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/removing-sensitive-data-from-a-repository).
   The local provider inventory is `.local/security-provider-history-followup.json`.
3. Migrations 578/579 are applied. Affected manual Meta connections must reconnect
   through the verified setup flow. All old account webhook capabilities and
   legacy WhatsApp token hashes were revoked: owners must update external callback
   URLs and verify tokens. New capabilities are purpose-specific and expire after
   90 days; update the external provider before expiry. These security migrations
   are intentionally irreversible. The final packaging update found zero pending
   migrations and did not rotate capabilities again.
4. If the legacy Vertex path is needed later, provide replacement JSON through a
   managed runtime mount and set `VERTEX_SERVICE_ACCOUNT_FILE` or
   `GOOGLE_APPLICATION_CREDENTIALS` to its absolute path. Checkout-relative
   credential discovery is removed. Provider keys belong in encrypted credential
   management or private runtime configuration.
5. An administrator exists, and bootstrap is disabled in production. Fresh
   installations require a temporary 32-character deployment secret and an expiry
   within one hour, supplied with the `X-Admin-Bootstrap-Secret` header. Remove the
   opt-in settings after initialization.
6. Legacy custom workflows lacking a business-profile assignment remain excluded
   from shared catalogs. Verify ownership before assigning both `userId` and
   `businessProfileId` and moving a definition under
   `data/workflows/tenants/<businessProfileId>/`. Do not infer ownership from names.
7. Bounded demo parsing precharges at least 10 credits and refunds failures; the
   optional `ai_demo_parse` price can be configured by the owner. Uploads accept
   5 MiB per image and 20 MiB per request, with five files per request. The client
   retains its 50-image gallery through sequential bounded requests.
8. CI and replacement media credentials were waived explicitly. The release used
   verified prebuilt Linux images with exact revision labels, the host release
   lock, a private database backup, migration status checks and final health checks.
   Duplicate Git packs were compacted from 14,165,705,893 to 832,888,801 bytes while
   preserving all 64,049 objects and every ref. Recovery images, volumes and
   backups were retained. Future releases can use `RELEASE_PREBUILT_IMAGES=1`
   with a clean `v7` checkout and matching `RELEASE_VERIFIED_SHA` after verification.

## Verification boundaries

Local validation passed 334 server tests across 36 suites, including real
Chromium screenshot tests and both migrations against disposable PostgreSQL
tables, plus 44 client tests across five suites. Server API and worker builds
succeeded. Both server/client TypeScript checks passed, and focused server/client
lint reported zero errors (warnings remain). The QA cluster is isolated from
application databases and has been stopped. The source credential scan and
`git diff --check` passed. A live pinned fetch to `https://example.com/` succeeded.
Six migration-runner safety tests also passed, including irreversible rollback
refusal before any database changes.
The deployment regressions subsequently passed all 26 Linux tests, including
prebuilt image validation and refusal to stop writers on a revision mismatch.

The release dependency audit also identified two additional high-severity
transitive advisories. Compatible overrides update `@modelcontextprotocol/node`
to 2.1.0 and `systeminformation` to 5.33.16. The follow-up production audit has
zero high/critical findings; two moderate and one low advisory remain outside
the attached scan's 14 findings. Sources:
[MCP advisory](https://github.com/advisories/GHSA-f897-62hf-6gxq) and
[systeminformation advisory](https://github.com/advisories/GHSA-3f7j-7jwc-fxfj).
The follow-up server TypeScript check and 42 tests across ten Apify, tracing,
logging, readiness and credential suites passed after these dependency updates.

A pre-existing client lint dependency mismatch was also repaired with an
`eslint-plugin-react-hooks`-scoped override of `zod-validation-error` to 4.0.2,
which exposes the plugin's required `/v4` module. The server's separate validation
dependency is unchanged. See the [upstream export issue](https://github.com/causaly/zod-validation-error/issues/606).

The Docker context integration passed on the repository-configured SSH host
using a disposable `/tmp` directory, `FROM scratch`, and `--network=none`. All
nine synthetic credential fixtures were excluded and ordinary source survived.
The verified `.dockerignore` SHA-256 is
`49be13b9c8e045f73eb999a0165325b8e05e5b05ab9700977f8177a4eb14e750`.
The temporary files were removed; no production checkout or container changed.
Evidence is saved locally in `.local/security-docker-context-remote.log`.

The initial read-only preflight found the original production services healthy,
an initialized administrator and two pending security migrations. Required secret
variables were present without exposing their values. The old image contained
the revoked service-account file. The verified release removes that file from
all four running containers. Replacement Google media credentials were explicitly
skipped; no Vertex runtime file was provisioned.

The Linux container preflight caught two compatibility failures that the Windows
browser tests could not establish: Docker's default policy denied Chromium's
namespaces, and the deployed Alpine/musl runtime crashed in Chromium's GPU
sandbox on `pwritev2`. The API now uses Debian Bookworm and the Moby default-deny
policy with only the namespace allow rule recommended by
[Playwright](https://playwright.dev/docs/docker#crawling-and-scraping). The Moby
source revision and license are recorded in `docker/README.md`. Neither elevated
container capabilities nor disabled browser sandboxes are required.

An isolated Debian runtime using the actual compiled browser launcher passed on
the configured Linux host with no external network and a 512 MiB memory limit.
All three inspected renderers had nested PID namespaces (depth 3 versus 1),
Chromium seccomp filters (2 versus 1), and `NoNewPrivs=1`. It rendered a 6,062-byte
PNG and made zero direct loopback requests. All three Compose configurations
resolved the seccomp policy correctly, and the documented shell check passed.
Evidence from this initial runtime check is in
`.local/security-compose-sandbox-check.log`. The full API release image and the
live production API subsequently passed the same kernel sandbox and rendering
checks. CI was explicitly waived; the shipping images were verified locally on
Linux, as recorded in the final production evidence below.

A nonsecret revocation inventory in
`.local/security-key-revocation-inventory.json` identifies the exposed service
account/key ID and two distinct provider-key fingerprints without copying key
values. The existing Google Cloud console session cannot access project
`salesandmarketing-491305`: the console reports missing
`iam.serviceAccounts.list` and `resourcemanager.projects.get` permissions. No
provider-administration connector or configured `gcloud` command was available.
Revocation is recorded from the user's explicit confirmation, not an independent
provider lookup. Historical usage, replacement runtime credentials, live IAM,
and deployed firewall policy have not been independently verified.

The isolated history preview is saved at
`.local/security-history-preview-20261029-v5/sanitized.git`, with its full
evidence and ref inventory in the adjacent `manifest.json`. It removed the
credential JSON path throughout history and replaced 27 occurrences of the
known exposed values across 16 blobs. A streaming scan of all 64,747 reachable
objects (1,805,836,038 bytes) found zero matches for those values, and
`git fsck --full --no-reflogs` passed. Its remediation branch is
`codex/security-remediation-history-preview`, at
`eecf456f8a82258e115ad2680bc724cf6106f813`.

The initial preview's application tree matched the tested working-tree snapshot.
The adjacent `latest-remediation.json` retains refreshed release-base object-scan
evidence. The preview has no configured remote or object alternates; its manifest
distinguishes publishable heads/tags, private refs and provider-controlled refs.
At preparation, shared `v7` was three commits behind local production work. That
work was preserved in the mapped clean production base
`1ac4fbd91067f8a1c3c21e80c5e4c34705ecbf2e` before the security release advanced
production. The original 56-ref publication inventory remains historical evidence;
subsequent `v7` promotions to the security release have separate guarded publication
receipts. The final application revision is recorded below.

The DNS pinning and browser routing implementations follow the
[Node DNS contract](https://nodejs.org/api/dns.html) and
[Playwright routing contract](https://playwright.dev/docs/api/class-route).


## Verified production release — 30 October 2026 IST

Application revision: `4fd73fae76494231b8e90e168a8f10ab080b5a7e`.
All four containers run as UID 1001 without privileged mode and are healthy at
that revision. The exposed service-account file is absent from each container.
Production verification and rollout cover the `v7` environment.

The first migration attempt rolled back when the existing ownership trigger
required administrative session scope. The approved data changes then succeeded
using that scope only in the disposable migration process. The permanent fix
sets transaction-local system scope in migrations 578/579 and restores its prior
value. Two isolated PostgreSQL 18 tests passed with the actual ownership trigger,
including the previously rejected update and scope restoration. The final API
image adds exactly the two corrected migration files to the verified release
base; worker and client filesystem layers are identical to their verified base
images. Packaged migration hashes were checked against the committed Git blobs.

Live checks passed: API health 200, disabled bootstrap 404 with a valid CSRF pair,
legacy webhook 403, anonymous admin access 401, both routing indexes valid, and
zero active unverified manual Meta credentials, ambiguous active routes, invalid
nonces or legacy WhatsApp token hashes. The live browser rendered a 6,062-byte PNG;
all three inspected renderers had nested namespaces and additional seccomp
filters, with zero direct loopback requests. Public home/login and three deployed
JavaScript assets returned 200 over verified TLS.

Isolated Linux checks also confirmed valid PDF extraction, malformed PDF rejection,
bounded native image processing, client startup and static-asset loading. The
earlier 378 server/client regression executions, 42 dependency follow-up tests,
26 deployment tests and four guarded history-transplant fixtures passed. The
dependency audit has zero high/critical findings; the remaining two moderate and
one low advisory are outside the attached report's 14 findings.

The final release manifest is
`/var/backups/asksales/release-20261029T200528Z-4fd73fae76494231b8e90e168a8f10ab080b5a7e.manifest`.
Its database backup is 79,738,412 bytes, mode 0600, validated by the deployment's
`pg_restore --list` check, with SHA-256
`aad3b4aac1684d2dc822f4e8492633ef40bc7a180690009dec7f8667422073ed`.
Local operator evidence is saved in `.local/security-production-receipt.json`,
`.local/security-production-verification-final.log`,
`.local/security-production-chromium-sandbox-final.log`,
`.local/security-public-website-check.log`,
`.local/security-final-release-ready.json` and
`.local/security-migration-context-tests.log`.
