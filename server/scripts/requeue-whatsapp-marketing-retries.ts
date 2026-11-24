/** Explicit, audited recovery of marketing-limit failures on original intents.
 * Defaults to a rolled-back dry run. The business poll dispatches delayed jobs. */
import { sql } from 'drizzle-orm';
import { db, pgPool } from '../models/db.js';
import { withBusinessScope } from '../tenancy/businessContext.js';
import { runBusinessJob } from '../tenancy/jobBusinessScope.js';
import { closeRedisConnections } from '../infrastructure/redis.js';
import { planWhatsAppMarketingRetryRecovery } from '../services/outreach/WhatsAppProviderRetry.js';

const args = process.argv.slice(2);
const value = (name: string) => {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
};
const userId = Number(value('--user-id'));
const businessProfileId = Number(value('--business-profile-id'));
const messageIds = [...new Set(String(value('--message-ids') || '').split(',').map(Number))];
if (![userId,businessProfileId,...messageIds].every(id => Number.isSafeInteger(id) && id > 0))
  throw new Error('Use --user-id N --business-profile-id N --message-ids ID,ID [--apply]');
const apply = args.includes('--apply');
const rollback = new Error('dry-run rollback');
let recovered: unknown[] = [];
try {
  await withBusinessScope({userId,businessProfileId},async () => {
    const rows = (await db.execute(sql`SELECT id,metadata->'outreachQueueOrigin' AS origin
      FROM outreach_messages WHERE user_id=${userId} AND business_profile_id=${businessProfileId}
      AND id IN(${sql.join(messageIds.map(id => sql`${id}`),sql`, `)}) ORDER BY id`)).rows as {id:number;origin:Record<string,unknown>}[];
    if (rows.length !== messageIds.length) throw new Error('Some explicit messages are outside this business');
    const origin = rows[0].origin as Record<string,unknown>;
    const identity = ['userId','businessProfileId','businessActorUserId','billingOrganizationId','billingActorUserId'];
    if (!origin || rows.some(row => identity.some(key =>
      (row.origin as Record<string,unknown>)?.[key] !== origin[key])))
      throw new Error('Original sending authorities differ or are missing');
    try {
      await runBusinessJob(origin,() => db.transaction(async (tx: typeof db) => {
        recovered = await planWhatsAppMarketingRetryRecovery(tx,userId,messageIds);
        if (!apply) throw rollback;
      }));
    } catch (error) { if (error !== rollback) throw error; }
  });
} finally {
  await closeRedisConnections();
  await pgPool?.end();
}
console.log(JSON.stringify({dryRun:!apply,requested:messageIds.length,eligible:recovered.length,recovered}));
