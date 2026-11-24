import { db, pgPool } from '../models/db.js';
import { sql } from 'drizzle-orm';
import { inboundContactResolver } from '../services/InboundContactResolver.js';

type Candidate = {
  user_id: number;
  conversation_id: number;
  channel: string;
  external_identifier: string | null;
  display_name: string | null;
};

async function main() {
  const result = await db.execute(sql`
    SELECT oc.user_id,
           oc.id AS conversation_id,
           oc.channel,
           CASE
             WHEN oc.channel = 'whatsapp' THEN COALESCE(oc.metadata->>'phoneNumber', oc.external_thread_id)
             WHEN oc.channel IN ('email', 'gmail') THEN oc.lead_email
             ELSE oc.external_thread_id
           END AS external_identifier,
           COALESCE(NULLIF(oc.lead_name, ''), NULLIF(l.full_name, ''), NULLIF(l.name, '')) AS display_name
    FROM outreach_conversations oc
    JOIN leads l ON l.id = oc.lead_id AND l.user_id = oc.user_id
    WHERE oc.channel IN ('whatsapp', 'instagram', 'facebook', 'email', 'gmail')
    ORDER BY oc.id ASC
  `);
  let reconciled = 0;
  let skipped = 0;
  for (const row of result.rows as Candidate[]) {
    if (!row.external_identifier) {
      skipped += 1;
      continue;
    }
    const outcome = await inboundContactResolver.reconcile({
      userId: Number(row.user_id),
      conversationId: Number(row.conversation_id),
      channel: row.channel,
      externalIdentifier: row.external_identifier,
      displayName: row.display_name,
      source: 'identity_backfill',
      trust: 'provider',
      recordReply: false,
    });
    if (outcome) reconciled += 1;
    else skipped += 1;
  }
  console.log(JSON.stringify({ candidates: result.rows.length, reconciled, skipped }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => {
  await pgPool?.end();
});
