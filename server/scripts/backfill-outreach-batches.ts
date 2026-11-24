/**
 * Gives outreach sent before message tracking existed a tracking record, so it
 * appears under Outreach > Message tracking.
 *
 * Read-only by default: it reports what it would do. Pass --apply to write.
 * Safe to run again; it only touches messages that have no tracking record.
 *
 *   tsx scripts/backfill-outreach-batches.ts [--apply] [--user-id=<id>]
 *
 * What it does, per business:
 *   1. Copies the WhatsApp template name and language out of each message's saved delivery details.
 *   2. Groups composer sends into outreaches. A prepared outreach is one group. Other sends are
 *      grouped by channel, sending account, template and scheduled time, and split wherever two
 *      consecutive messages were created more than ten minutes apart. These are marked
 *      "legacy_inferred" so the page can say they were grouped automatically.
 *   3. Puts each follow-up under the outreach of the message it follows.
 *   4. Records whether each grouped outreach's channel reports delivery and read receipts.
 *
 * Replies, inbox messages and sends from the older campaign builder are left untracked.
 */
import 'dotenv/config';
import { sql } from 'drizzle-orm';
import { db, pgPool } from '../models/db.js';
import { withBusinessScope, withSystemScope } from '../tenancy/businessContext.js';
import { channelsWithoutReceipts } from '../../shared/outreachTracking.js';

const apply = process.argv.includes('--apply');
const ownerArg = process.argv.find(arg => arg.startsWith('--user-id='));
const onlyUser = ownerArg ? Number(ownerArg.split('=')[1]) : null;
if (ownerArg && (!Number.isSafeInteger(onlyUser) || Number(onlyUser) <= 0)) throw new Error('Expected --user-id=<positive integer>.');

const TEMPLATE_CHUNK = 10_000;
const delivery = sql`m.metadata->'outreachCreation'->'delivery'`;
const prepared = sql`COALESCE(m.metadata->>'preparedOutreachId',${delivery}->>'preparedOutreachId')`;

/** Composer sends with no tracking record, each tagged with the group it belongs to. */
const grouped = (userId: number, business: number) => sql`
  candidates AS (
    SELECT m.id,m.created_at,m.confirmation_expires_at,
      CASE WHEN c.channel IN('gmail','resend') THEN 'email' ELSE c.channel END AS channel,
      COALESCE(m.provider_account_id,c.provider_account_id,'') AS account,
      COALESCE(${delivery}->>'templateName','') AS template_name,COALESCE(${delivery}->>'templateLanguage','') AS template_language,
      COALESCE(m.metadata->>'scheduledAt','') AS scheduled,
      CASE WHEN ${prepared} ~ '^[0-9a-fA-F-]{36}$' THEN ${prepared} ELSE '' END AS prepared
    FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id
      AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
    WHERE m.user_id=${userId} AND m.business_profile_id=${business} AND m.direction='outbound' AND m.message_kind='outreach'
      AND m.batch_id IS NULL AND m.metadata->'outreachCreation'->>'version'='1'
  ), marked AS (
    SELECT *,CASE WHEN prepared='' AND created_at-LAG(created_at) OVER run>interval '10 minutes' THEN 1 ELSE 0 END AS starts_new
    FROM candidates
    WINDOW run AS (PARTITION BY channel,account,template_name,template_language,scheduled,prepared ORDER BY created_at,id)
  ), numbered AS (
    SELECT *,SUM(starts_new) OVER (PARTITION BY channel,account,template_name,template_language,scheduled,prepared ORDER BY created_at,id) AS run_number
    FROM marked
  ), groups AS (
    SELECT channel,account,template_name,template_language,scheduled,prepared,run_number,
      MIN(id) AS first_id,COUNT(*)::int AS messages,MIN(created_at) AS started,MAX(confirmation_expires_at) AS expires,array_agg(id) AS ids,
      -- Stable per group, so a second run finds the record the first one made.
      encode(sha256(('legacy-outreach:'||MIN(id))::bytea),'hex') AS fingerprint
    FROM numbered GROUP BY channel,account,template_name,template_language,scheduled,prepared,run_number
  )`;

const channelLabel = sql`CASE g.channel WHEN 'whatsapp' THEN 'WhatsApp' WHEN 'sms' THEN 'SMS' ELSE initcap(g.channel) END`;

async function backfill(userId: number, business: number) {
  const pending = await db.execute(sql`WITH ${grouped(userId, business)}
    SELECT COUNT(*)::int AS outreaches,COALESCE(SUM(messages),0)::int AS messages,
      COUNT(*) FILTER(WHERE prepared<>'')::int AS prepared FROM groups`);
  const templates = await db.execute(sql`SELECT COUNT(*)::int AS count FROM outreach_messages m
    WHERE m.user_id=${userId} AND m.business_profile_id=${business} AND m.template_name IS NULL AND ${delivery}->>'templateName' IS NOT NULL`);
  const followUps = await db.execute(sql`SELECT COUNT(*)::int AS count FROM outreach_messages f
    WHERE f.user_id=${userId} AND f.business_profile_id=${business} AND f.batch_id IS NULL AND f.follow_up_origin_message_id IS NOT NULL`);
  const report = {
    userId, businessProfileId: business,
    outreaches: Number(pending.rows[0]?.outreaches) || 0, messages: Number(pending.rows[0]?.messages) || 0,
    preparedOutreaches: Number(pending.rows[0]?.prepared) || 0,
    templateNames: Number(templates.rows[0]?.count) || 0, followUpsToCheck: Number(followUps.rows[0]?.count) || 0, applied: false,
  };
  if (!apply) return report;

  // 1. Template names, a slice at a time so no statement holds a long lock.
  for (;;) {
    const updated = await db.execute(sql`UPDATE outreach_messages m SET
        template_name=left(${delivery}->>'templateName',512),template_language=left(${delivery}->>'templateLanguage',20)
      WHERE m.id IN(SELECT id FROM outreach_messages m WHERE m.user_id=${userId} AND m.business_profile_id=${business}
        AND m.template_name IS NULL AND ${delivery}->>'templateName' IS NOT NULL ORDER BY id LIMIT ${TEMPLATE_CHUNK})`);
    if (!updated.rowCount) break;
  }

  // 2. One record per group, then point its messages at it.
  await db.execute(sql`WITH ${grouped(userId, business)}, created AS (
      INSERT INTO outreach_batches(id,user_id,business_profile_id,name,channel,provider_account_id,template_name,template_language,
        scheduled_at,source,prepared_outreach_id,request_fingerprint,status,requested_count,admitted_count,expires_at,created_at)
      SELECT gen_random_uuid(),${userId},${business},
        left(COALESCE(NULLIF(op.result->>'name',''),NULLIF(op.payload->>'name',''),
          ${channelLabel}||' · '||COALESCE(NULLIF(g.template_name,''),'Message')),200),
        g.channel,NULLIF(g.account,''),NULLIF(left(g.template_name,512),''),NULLIF(left(g.template_language,20),''),
        CASE WHEN g.scheduled ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' THEN g.scheduled::timestamptz END,
        CASE WHEN g.prepared<>'' THEN 'legacy_prepared' ELSE 'legacy_inferred' END,NULLIF(g.prepared,'')::uuid,
        g.fingerprint,'queued',g.messages,g.messages,g.expires AT TIME ZONE 'UTC',g.started AT TIME ZONE 'UTC'
      FROM groups g LEFT JOIN dashboard_operations op ON op.id=NULLIF(g.prepared,'')::uuid
        AND op.user_id=${userId} AND op.business_profile_id=${business} AND op.kind='campaign_prepare'
      ON CONFLICT(business_profile_id,user_id,request_fingerprint) DO UPDATE SET updated_at=now()
      RETURNING id,request_fingerprint
    )
    UPDATE outreach_messages m SET batch_id=created.id
    FROM groups g JOIN created ON created.request_fingerprint=g.fingerprint
    WHERE m.id=ANY(g.ids) AND m.batch_id IS NULL`);

  // 3. Follow-ups join the outreach of the message they follow.
  await db.execute(sql`UPDATE outreach_messages f SET batch_id=origin.batch_id FROM outreach_messages origin
    WHERE f.follow_up_origin_message_id=origin.id AND f.batch_id IS NULL AND origin.batch_id IS NOT NULL
      AND f.user_id=${userId} AND f.business_profile_id=${business}
      AND origin.user_id=f.user_id AND origin.business_profile_id=f.business_profile_id`);

  // 4. Whether each older outreach's channel reports receipts at all, so its rates read "Not reported" instead of 0%.
  const noReceipts = sql.join(channelsWithoutReceipts.map(channel => sql`${channel}`), sql`,`);
  await db.execute(sql`UPDATE outreach_batches b SET receipt_support=s.support,counts_dirty=true FROM (
      SELECT m.batch_id,CASE WHEN bool_and(c.channel IN(${noReceipts})) THEN 'none'
        WHEN bool_or(c.channel IN(${noReceipts})) THEN 'partial' ELSE 'full' END AS support
      FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id
        AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
      WHERE m.user_id=${userId} AND m.business_profile_id=${business} AND m.message_kind='outreach' AND m.batch_id IS NOT NULL
      GROUP BY m.batch_id
    ) s WHERE b.id=s.batch_id AND b.source IN('legacy_inferred','legacy_prepared') AND b.receipt_support<>s.support`);
  return { ...report, applied: true };
}

async function main() {
  const owners = await withSystemScope('List businesses with untracked outreach', () => db.execute(sql`
    SELECT DISTINCT user_id,business_profile_id FROM outreach_messages
    WHERE direction='outbound' AND user_id IS NOT NULL AND business_profile_id IS NOT NULL
      AND (batch_id IS NULL OR template_name IS NULL) AND metadata->'outreachCreation'->>'version'='1'
      AND (${onlyUser}::integer IS NULL OR user_id=${onlyUser})`));
  const totals = { businesses: 0, outreaches: 0, messages: 0, failed: 0 };
  for (const owner of owners.rows) {
    const userId = Number(owner.user_id), business = Number(owner.business_profile_id);
    try {
      const report = await withBusinessScope({ userId, businessProfileId: business }, () => backfill(userId, business));
      console.log(JSON.stringify(report));
      totals.businesses++; totals.outreaches += report.outreaches; totals.messages += report.messages;
    } catch (error) {
      totals.failed++;
      console.error(JSON.stringify({ userId, businessProfileId: business, error: error instanceof Error ? error.message : String(error) }));
    }
  }
  console.log(JSON.stringify({ ...totals, mode: apply ? 'applied' : 'dry run; pass --apply to write' }));
  if (totals.failed) process.exitCode = 1;
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}).finally(async () => {
  await pgPool?.end();
});
