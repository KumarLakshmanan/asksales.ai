/** Run after migration 297. Defaults to a read-only coverage report. */
import "dotenv/config";
import { sql } from "drizzle-orm";
import { db, pgPool } from "../models/db.js";
import {
  listInbox,
  parseInboxQuery,
  prepareInboxSearch,
} from "../services/outreach/InboxService.js";
import {
  withBusinessScope,
  withSystemScope,
} from "../tenancy/businessContext.js";

const apply = process.argv.includes("--apply");
const userArg = process.argv.indexOf("--user-id");
const userId = userArg >= 0 ? Number(process.argv[userArg + 1]) : undefined;
if (userArg >= 0 && (!Number.isSafeInteger(userId) || !userId || userId < 1))
  throw new Error("A positive --user-id is required.");
try {
  const users = await withSystemScope(
    "Inventory owners for the explicitly requested Inbox reconciliation",
    async () =>
      (
        await db.execute(sql`SELECT DISTINCT user_id,profile_id FROM (
      SELECT user_id,(to_jsonb(c)->>'business_profile_id')::integer AS profile_id FROM outreach_conversations c
      UNION SELECT user_id,(to_jsonb(s)->>'business_profile_id')::integer FROM sent_messages s
    ) owners WHERE user_id IS NOT NULL ${userId ? sql`AND user_id=${userId}` : sql``} ORDER BY user_id,profile_id`)
      ).rows as Array<{ user_id: number; profile_id: number | null }>,
  );
  for (const owner of users) {
    const reconcile = async () => {
      const started = Date.now();
      if (apply) {
        await db.execute(
          sql`UPDATE sent_messages s SET outreach_message_id=outreach_inbox_exact_message(s) WHERE user_id=${owner.user_id}`,
        );
        await prepareInboxSearch(owner.user_id);
      }
      const report = (
        await db.execute(sql`SELECT
      (SELECT COUNT(*)::int FROM outreach_conversations c WHERE user_id=${owner.user_id}
        AND channel IN ('email','gmail','whatsapp','instagram','facebook','sms','linkedin','twitter')
        AND EXISTS(SELECT 1 FROM outreach_messages m WHERE m.conversation_id=c.id)) AS conversations,
      COUNT(*) FILTER(WHERE outreach_message_id IS NOT NULL)::int AS linked_receipts,
      COUNT(*) FILTER(WHERE outreach_message_id IS NULL AND status IN ('sent','delivered','read','opened','clicked','replied','bounced'))::int AS historical_sends,
      COUNT(*) FILTER(WHERE outreach_message_id IS NULL AND outreach_inbox_exact_message(s) IS NOT NULL)::int AS linkable_receipts,
      COUNT(*) FILTER(WHERE inbox_search_text IS NULL)::int AS unindexed_receipts
      FROM sent_messages s WHERE user_id=${owner.user_id}
        AND channel IN ('email','gmail','whatsapp','instagram','facebook','sms','linkedin','twitter')`)
      ).rows[0];
      const keys = new Set<string>();
      let cursor: string | null = null;
      let duplicates = 0;
      let maxQueryMs = 0;
      do {
        const queryStarted = Date.now();
        const page = await listInbox(
          owner.user_id,
          parseInboxQuery({ limit: "100", ...(cursor ? { cursor } : {}) }),
        );
        maxQueryMs = Math.max(maxQueryMs, Date.now() - queryStarted);
        for (const item of page.items) {
          if (keys.has(item.key)) duplicates++;
          keys.add(item.key);
        }
        cursor = page.nextCursor;
      } while (cursor);
      const expected = report.conversations + report.historical_sends;
      console.log(
        JSON.stringify({
          userId: owner.user_id,
          businessProfileId: owner.profile_id,
          mode: apply ? "applied" : "dry-run",
          ...report,
          inboxItems: keys.size,
          expectedItems: expected,
          duplicateItems: duplicates,
          coverageMatches: keys.size === expected && duplicates === 0,
          maxQueryMs,
          durationMs: Date.now() - started,
        }),
      );
      if (keys.size !== expected || duplicates > 0) process.exitCode = 1;
    };
    if (owner.profile_id)
      await withBusinessScope(
        { userId: owner.user_id, businessProfileId: owner.profile_id },
        reconcile,
      );
    else
      await withSystemScope(
        "Reconcile pre-profile Inbox records for one explicitly enumerated owner",
        reconcile,
      );
  }
} catch (error) {
  process.exitCode = 1;
  console.error('Inbox reconciliation failed:', error instanceof Error ? error.message : error);
} finally {
  await pgPool?.end();
}
// Shared provider/logging modules may own long-lived background handles. This
// one-shot maintenance command is complete after the pool and output drain.
await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
process.exit(process.exitCode || 0);
