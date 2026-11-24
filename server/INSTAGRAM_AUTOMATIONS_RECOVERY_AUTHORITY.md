# Instagram execution authority and recovery

Every matched run stores a versioned `context.queueIdentity` before dispatch:

```ts
{
  version: 1,
  userId,
  businessProfileId,
  businessActorUserId,
  billingOrganizationId,
  billingActorUserId
}
```

These are positive integer IDs captured by the server's business/billing helper. The business owner/profile must match the run. Current billing actor/payer are supplied explicitly when a billing scope exists. Conflicting fresh authority is rejected rather than silently replaced.

Replay and recovery load this original tuple; they never capture a new owner from inventory scope. Instagram requires the complete snapshot locally before enqueue, restores matching business/billing scopes, and supplies all five explicit fields to the dispatcher. The shared registry's capture helper revalidates them. This works with the existing capture signature and Tenant's strict origin helper; Instagram does not change shared helper code.

The worker and every effect compare the stored identity with their actual business/billing scopes. A conflicting actor or payer is rejected before provider IO. Follow checks inherit the parent comment run's identity, so a later owner-scoped callback cannot authorize its promised content. Accepted receipts and unconfirmed intents are preserved.

## Legacy and rollout

No migration or schema change is needed: the snapshot uses existing run JSON. Missing, invalid or inconsistent legacy identity is not backfilled from the owner, current profile, current payer, or a later webhook. Queued legacy work becomes failed and reviewable without enqueueing. An existing unconfirmed send intent keeps the run uncertain. Already-queued legacy jobs are rejected by the runtime too. Historical completed receipts remain intact.

Pending legacy work requires review or a fresh authorized event; this change does not add a manual retry endpoint. Do not blindly replay uncertain effects. API, GENERAL recovery consumers and OUTREACH consumers must use the corrected runtime together; old consumers do not enforce this boundary. No deployment is performed by these verification steps.

## Local acceptance

Use only fresh disposable PostgreSQL/Redis containers, never saved application DSNs. The launcher below ignores saved application environments and writes its own synthetic fixture configuration. The password shown is a synthetic local fixture value.

```sh
docker run --detach --rm --name ig-authority-pg --publish 127.0.0.1:55439:5432 --env POSTGRES_USER=ig_audit --env POSTGRES_PASSWORD=synthetic-local-only --env POSTGRES_DB=ig_audit --tmpfs /var/lib/postgresql/data pgvector/pgvector:pg16
docker run --detach --rm --name ig-authority-redis --publish 127.0.0.1:56389:6379 redis:7.2-alpine redis-server --save '' --appendonly no
docker exec ig-authority-pg pg_isready -U ig_audit
docker exec ig-authority-pg psql -U ig_audit -d ig_audit -v ON_ERROR_STOP=1 -c 'CREATE ROLE salesmarketing_business_runtime NOLOGIN'
env -i PATH="$PATH" node qa/instagram-automations-2026-10-23/verify-local.mjs --authority
docker stop ig-authority-pg ig-authority-redis
```

The former `--queue-observation` option now aliases `--authority`; it no longer asserts that owner replacement is acceptable. Historical failing evidence remains historical.

The authority tests execute actual registered GENERAL and OUTREACH BullMQ consumers, scoped PostgreSQL, registry/capture, business/billing revalidation and the outer subscription gate. Cases cover revoked origin, legitimate owner recovery, independent actor conflicts, payer change, legacy recovery/execution, unconfirmed intents and follow-gated content. Provider calls, event notifications, background sender/notification daemons and unrelated monitoring scheduling are mocked or disabled. This is fixture-environment worker acceptance, not a production deployment or live Meta acceptance.
