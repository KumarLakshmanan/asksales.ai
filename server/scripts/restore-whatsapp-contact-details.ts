/**
 * Restores customer contact details (name, phone, email, address) in stored
 * WhatsApp messages that were saved with vault tokens such as [NAME_123],
 * so the inbox shows them permanently instead of only while the vault keeps
 * the original (30 days). `redacted_content`, which the AI reads, is untouched.
 * Payment cards, government IDs, OTPs and credentials stay masked.
 *
 *   tsx scripts/restore-whatsapp-contact-details.ts                 dry run, all tenants
 *   tsx scripts/restore-whatsapp-contact-details.ts --user-id 12    dry run, one tenant
 *   tsx scripts/restore-whatsapp-contact-details.ts --limit 500     stop after 500 vault rows
 *   tsx scripts/restore-whatsapp-contact-details.ts --apply         write the restored text
 *
 * Only unexpired vault rows can be restored. Output never contains message
 * text. Decrypting a vault row is recorded in support_privacy_access_logs,
 * in dry runs too.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pgPool } from '../models/db.js';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import {
  hasContactDetailTokens,
  privacyVaultService,
  whatsappDisplayText,
} from '../services/agents/orchestration/PrivacyVaultService.js';

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
const ACTOR = 'system:whatsapp-contact-restore';

interface VaultRow {
  id: number;
  user_id: number;
  business_profile_id: number | null;
  conversation_id: number;
  message_id: number;
}

const counts: Record<string, number> = {};
const bump = (key: string) => { counts[key] = (counts[key] || 0) + 1; };

async function restoreRow(row: VaultRow): Promise<string> {
  const stored = await db.execute(sql`SELECT m.content FROM outreach_messages m
    JOIN outreach_conversations c ON c.id = m.conversation_id AND c.user_id = m.user_id
    WHERE m.id = ${row.message_id} AND m.user_id = ${row.user_id} AND m.conversation_id = ${row.conversation_id}
      AND m.privacy_vault_id = ${row.id} AND c.channel = 'whatsapp'`);
  const storedContent = (stored.rows[0] as { content?: string | null } | undefined)?.content;
  if (typeof storedContent !== 'string') return 'message_not_found';
  // Cheap pre-check so rows already showing details create no vault access records.
  if (!hasContactDetailTokens(storedContent)) return 'already_visible';

  const revealed = await privacyVaultService.reveal(row.user_id, row.id, {
    conversationId: row.conversation_id,
    messageId: row.message_id,
    actor: ACTOR,
    purpose: apply ? 'Restore WhatsApp contact details for inbox display' : 'Dry run: assess WhatsApp contact restore',
  });
  if (!revealed) return 'vault_unavailable';
  const content = whatsappDisplayText(revealed.rawText, { userId: row.user_id, conversationId: row.conversation_id });
  if (content === storedContent) return 'unchanged';
  if (!apply) return 'would_update';

  // Compare-and-set on the assessed text: a concurrent edit wins.
  const updated = await db.execute(sql`UPDATE outreach_messages SET content = ${content}, updated_at = NOW()
    WHERE id = ${row.message_id} AND user_id = ${row.user_id} AND conversation_id = ${row.conversation_id}
      AND privacy_vault_id = ${row.id} AND content = ${storedContent} RETURNING id`);
  return updated.rows.length === 1 ? 'updated' : 'changed_concurrently';
}

async function main(): Promise<void> {
  let afterId = 0;
  let seen = 0;
  for (;;) {
    const size = limit ? Math.min(BATCH, limit - seen) : BATCH;
    if (size <= 0) break;
    const page = await withSystemScope('WhatsApp contact restore: list unexpired vault rows', () => db.execute(sql`
      SELECT id, user_id, business_profile_id, conversation_id, message_id
      FROM support_privacy_vault
      WHERE id > ${afterId} AND expires_at > NOW() AND channel = 'whatsapp'
        AND message_id IS NOT NULL AND conversation_id IS NOT NULL
        AND (${onlyUserId ?? null}::int IS NULL OR user_id = ${onlyUserId ?? null})
      ORDER BY id ASC LIMIT ${size}`));
    const rows = page.rows as unknown as VaultRow[];
    if (rows.length === 0) break;
    for (const row of rows) {
      afterId = Number(row.id);
      seen += 1;
      if (!row.business_profile_id) { bump('no_business_profile'); continue; }
      try {
        bump(await withBusinessScope({ userId: Number(row.user_id), businessProfileId: Number(row.business_profile_id) },
          () => restoreRow({ ...row, id: Number(row.id), user_id: Number(row.user_id),
            conversation_id: Number(row.conversation_id), message_id: Number(row.message_id) })));
      } catch (error) {
        bump('error');
        process.stderr.write(`vault ${row.id}: ${error instanceof Error ? error.message : String(error)}\n`);
      }
    }
  }
  process.stdout.write(`${JSON.stringify({ mode: apply ? 'apply' : 'dry_run', vaultRowsExamined: seen, outcomes: counts }, null, 2)}\n`);
  if (counts.error) process.exitCode = 1;
}

main()
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(() => pgPool?.end());
