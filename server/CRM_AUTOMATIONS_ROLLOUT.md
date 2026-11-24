# CRM automation rollout

Migration `314_crm_automation_builder.js` adds versioned definitions, the durable event/run/step outbox, ownership policies, and capture triggers. It backfills legacy rules without changing their IDs, activation, priority, or logs. The new runtime starts disabled, so applying the migration does not process old activity.

1. Apply migrations through 314 before deploying the matching API and worker binaries. Confirm sender connections, billing configuration, and Redis health.
2. Deploy both the server and the separate worker. Confirm the `crm-automations` BullMQ worker and the general `crm-automation-dispatch` repeatable job are running.
3. Inspect the global flag and backlog with `pnpm --dir server exec tsx scripts/crm-automation-cutover.ts status`.
4. Enable during a controlled window with `pnpm --dir server exec tsx scripts/crm-automation-cutover.ts enable --apply`. The first enable sets `cutover_at` and suppresses all pre-cutover pending events. The old inline evaluator stays off after this point.
5. Create a paused rule in the CRM builder, preview it, then activate it from the list. Trigger a low-volume internal CRM change and inspect the run, each step, and the provider receipt. No historical CRM activity is replayed.

Watch `oldestPendingSeconds`, event counts by status, failed run/step counts, and uncertain steps from the status command. A growing pending age indicates a worker or Redis dispatch problem. An uncertain delivery needs provider-side reconciliation before any manual resend. Provider delivery/read/failure receipts can arrive after the step has advanced and will update its history.

To stop new processing, run `pnpm --dir server exec tsx scripts/crm-automation-cutover.ts disable --apply`. This retains events, run history, and the cutover marker, and does not restart the legacy evaluator. Fix the issue, inspect pending/uncertain work, then re-enable. Do not reverse migration 314 once run history exists.
