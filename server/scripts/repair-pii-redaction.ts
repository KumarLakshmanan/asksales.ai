/**
 * Re-redacts stored inbound messages from their privacy-vault originals using
 * the current redactor, repairing text that the earlier name/SSN/phone
 * patterns over-redacted ("I am looking for a room" -> "I am [NAME_1] a room").
 *
 *   tsx scripts/repair-pii-redaction.ts                 dry run, all tenants
 *   tsx scripts/repair-pii-redaction.ts --user-id 12    dry run, one tenant
 *   tsx scripts/repair-pii-redaction.ts --limit 500     stop after 500 vault rows
 *   tsx scripts/repair-pii-redaction.ts --apply         write the repaired text
 *
 * Only unexpired vault rows can be repaired. Covers outreach inbox messages
 * and web-widget messages; inbound email rows in sent_messages are not linked
 * to a vault row and are not touched. Output never contains message text.
 * Decrypting a vault row is recorded in support_privacy_access_logs, in dry
 * runs too.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pgPool } from '../models/db.js';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import { privacyVaultService } from '../services/agents/orchestration/PrivacyVaultService.js';
import { planRedactionRepair } from '../services/agents/orchestration/PiiRedactionRepair.js';

const apply = process.argv.includes('--apply');
const numberArg = (name: string): number | undefined => {
  const index = process.argv.indexOf(name);
  if (index < 0) return undefined;
  const value = Number(process.argv[index + 1]);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} requires a positive integer.`);
  return value;
};
const onlyUserId = numberArg('--user-id');
const limit = numberArg('--limit');
const BATCH = 200;
const ACTOR = 'system:pii-redaction-repair';

interface VaultRow {
  id: number;
  user_id: number;
  business_profile_id: number | null;
  conversation_id: number | null;
  message_id: number | null;
  entity_type: string | null;
  entity_id: number | null;
}

const counts: Record<string, number> = {};
const bump = (key: string) => { counts[key] = (counts[key] || 0) + 1; };
const changes: Array<Record<string, unknown>> = [];

async function repairRow(row: VaultRow): Promise<string> {
  const widget = row.entity_type === 'widget_message';
  const targetId = widget ? Number(row.entity_id || 0) : Number(row.message_id || 0);
  if (!targetId || row.conversation_id == null) return 'no_linked_message';

  const stored = widget
    ? await db.execute(sql`SELECT content FROM support_chat_messages WHERE id = ${targetId} AND privacy_vault_id = ${row.id}`)
    : await db.execute(sql`SELECT content FROM outreach_messages WHERE id = ${targetId} AND user_id = ${row.user_id}
        AND conversation_id = ${row.conversation_id} AND privacy_vault_id = ${row.id} AND direction = 'inbound'`);
  const storedContent = (stored.rows[0] as { content?: string | null } | undefined)?.content;
  if (typeof storedContent !== 'string') return 'message_not_found';
  // Cheap pre-check so untouched rows do not create vault access records.
  if (!/\[[A-Z][A-Z_]*_\d+\]/.test(storedContent)) return 'not_redacted';

  const revealed = await privacyVaultService.reveal(row.user_id, row.id, {
    conversationId: row.conversation_id,
    actor: ACTOR,
    purpose: apply ? 'Repair over-redacted stored message' : 'Dry run: assess over-redacted stored message',
  });
  if (!revealed) return 'vault_unavailable';

  const plan = planRedactionRepair({ rawText: revealed.rawText, storedContent,
    userId: row.user_id, conversationId: row.conversation_id });
  if (plan.action === 'skip') return plan.reason;

  changes.push({ vaultId: row.id, userId: row.user_id, target: widget ? 'widget_message' : 'outreach_message',
    targetId, tokensBefore: plan.tokensBefore, tokensAfter: plan.tokensAfter });
  if (!apply) return 'would_update';

  // Compare-and-set on the text that was assessed: a concurrent edit wins.
  const updated = widget
    ? await db.execute(sql`UPDATE support_chat_messages
        SET content = ${plan.content},
            metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({ piiProtected: plan.tokensAfter > 0, piiTypes: plan.piiTypes })}::jsonb
        WHERE id = ${targetId} AND privacy_vault_id = ${row.id} AND content = ${storedContent} RETURNING id`)
    : await db.execute(sql`UPDATE outreach_messages
        SET content = ${plan.content}, redacted_content = ${plan.content}, updated_at = NOW()
        WHERE id = ${targetId} AND user_id = ${row.user_id} AND conversation_id = ${row.conversation_id}
          AND privacy_vault_id = ${row.id} AND content = ${storedContent} RETURNING id`);
  return updated.rows.length === 1 ? 'updated' : 'changed_concurrently';
}

async function main(): Promise<void> {
  let afterId = 0;
  let seen = 0;
  for (;;) {
    const size = limit ? Math.min(BATCH, limit - seen) : BATCH;
    if (size <= 0) break;
    const page = await withSystemScope('PII redaction repair: list unexpired vault rows', () => db.execute(sql`
      SELECT id, user_id, business_profile_id, conversation_id, message_id, entity_type, entity_id
      FROM support_privacy_vault
      WHERE id > ${afterId} AND expires_at > NOW()
        AND (${onlyUserId ?? null}::int IS NULL OR user_id = ${onlyUserId ?? null})
        AND (message_id IS NOT NULL OR entity_type = 'widget_message')
      ORDER BY id ASC LIMIT ${size}`));
    const rows = page.rows as unknown as VaultRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      afterId = Number(row.id);
      seen += 1;
      if (!row.business_profile_id) { bump('no_business_profile'); continue; }
      try {
        bump(await withBusinessScope({ userId: Number(row.user_id), businessProfileId: Number(row.business_profile_id) },
          () => repairRow({ ...row, id: Number(row.id), user_id: Number(row.user_id) })));
      } catch (error) {
        bump('error');
        process.stderr.write(`vault ${row.id}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ mode: apply ? 'apply' : 'dry_run', vaultRowsExamined: seen, outcomes: counts,
    changes: changes.slice(0, 200), changesTruncated: changes.length > 200 }, null, 2)}\n`);
  if (counts.error) process.exitCode = 1;
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pgPool?.end());
