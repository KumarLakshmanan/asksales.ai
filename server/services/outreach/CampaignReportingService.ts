import {campaignReportFiltersSchema} from './CampaignReportFilters.js';
import { sql, type SQL } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { requireBusinessScope } from '../../tenancy/businessContext.js';
import { assertOwnedCampaignThread } from '../CampaignWorkspaceService.js';
import { campaignReportUrl, type CampaignReport, type CampaignReportFilters, type CampaignDeliveryCounts } from '../../../shared/campaignReporting.js';
import type { CampaignReportOptions } from '../../../shared/campaignReporting.js';
import {customerReportingIdentityCtes} from './CustomerReportingIdentity.js';
import { deliveryStateSql, reportStateSql } from './OutreachDeliveryState.js';

export class CampaignReportError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

function reportChannelPredicate(column: SQL, channel?: string): SQL {
  if (!channel) return sql`TRUE`;
  const channels = channel === 'email' ? ['email', 'gmail', 'resend'] : [channel];
  return sql`${column} IN (${sql.join(channels.map(value => sql`${value}`), sql`, `)})`;
}

/** Email, Gmail and Resend are one channel. Either side may hold any of the
 * three: an older Gmail send record belongs to an `email` conversation. */
const reportChannel = (column: SQL) => sql`CASE WHEN ${column} IN('gmail','resend') THEN 'email' ELSE ${column} END`;
function sameReportChannel(left: SQL, right: SQL): SQL {
  return sql`${reportChannel(left)}=${reportChannel(right)}`;
}

function reportSourcePredicate(filters: CampaignReportFilters | undefined, source: {
  channel: SQL;
  account: SQL;
  createdAt: SQL;
  campaignId: SQL;
  messageKind?: SQL;
  preparedOutreachId?: SQL;
}): SQL {
  if (!filters) return sql`TRUE`;
  const clauses: SQL[] = [];
  if (filters.channel) clauses.push(reportChannelPredicate(source.channel, filters.channel));
  if (filters.accountId) clauses.push(sql`${source.account}=${filters.accountId}`);
  if (filters.from) clauses.push(sql`${source.createdAt}>=${new Date(filters.from).toISOString()}::timestamp`);
  if (filters.to) clauses.push(sql`${source.createdAt}<${new Date(filters.to).toISOString()}::timestamp`);
  if (filters.campaignId) clauses.push(sql`${source.campaignId}=${filters.campaignId}`);
  if (filters.messageKind !== 'all' && source.messageKind) clauses.push(sql`${source.messageKind}=${filters.messageKind}`);
  if (filters.preparedOutreachId) {
    if (source.preparedOutreachId) clauses.push(sql`${source.preparedOutreachId}=${filters.preparedOutreachId}`);
    else clauses.push(sql`FALSE`);
  }
  return clauses.length ? sql.join(clauses, sql` AND `) : sql`TRUE`;
}

export async function getCampaignReportOptions(userId: number): Promise<CampaignReportOptions> {
  const {businessProfileId:business} = requireBusinessScope();
  const result=await db.execute(sql`SELECT
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',name) ORDER BY id DESC)
      FROM outreach_campaigns WHERE user_id=${userId} AND business_profile_id=${business}),'[]'::jsonb) AS campaigns,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',w.id,'name',w.name) ORDER BY w.id DESC) FROM (
      SELECT t.id,CASE WHEN COUNT(*) OVER(PARTITION BY lower(btrim(t.title)))>1
          THEN btrim(t.title)||' (#'||t.id||')' ELSE btrim(t.title) END AS name
      FROM chat_threads t WHERE t.user_id=${userId} AND t.business_profile_id=${business} AND t.deleted_at IS NULL
        -- Only named workspaces that actually reach outreach; chat-only threads
        -- ("hi", "Yes, Proceed", untitled) cannot narrow a delivery report.
        AND NULLIF(btrim(t.title),'') IS NOT NULL AND lower(btrim(t.title)) NOT IN('null','undefined','untitled')
        AND (EXISTS(SELECT 1 FROM campaign_crm_contacts m WHERE m.thread_id=t.id AND m.user_id=t.user_id AND m.business_profile_id=t.business_profile_id)
          OR EXISTS(SELECT 1 FROM campaign_lead_imports i WHERE i.thread_id=t.id AND i.user_id=t.user_id AND i.business_profile_id=t.business_profile_id)
          OR EXISTS(SELECT 1 FROM outreach_campaigns c WHERE c.settings->>'threadId'=t.id::text AND c.user_id=t.user_id AND c.business_profile_id=t.business_profile_id)
          OR EXISTS(SELECT 1 FROM leads l WHERE l.legacy_campaign_thread_key=t.id::text AND l.user_id=t.user_id AND l.business_profile_id=t.business_profile_id)
          OR t.id::text IN(SELECT DISTINCT COALESCE(m.metadata->>'threadId',m.metadata->'outreachCreation'->'delivery'->>'threadId')
            FROM outreach_messages m WHERE m.user_id=${userId} AND m.business_profile_id=${business} AND m.direction='outbound'
              AND m.message_kind IN('outreach','follow_up')))) w),'[]'::jsonb) AS workspaces,
    COALESCE((SELECT jsonb_agg(to_jsonb(batch) ORDER BY batch.id DESC) FROM (
      SELECT id,'crm' AS source,file_name AS name FROM crm_contact_imports WHERE user_id=${userId} AND business_profile_id=${business}
      UNION ALL SELECT id,'campaign',file_name FROM campaign_lead_imports WHERE user_id=${userId} AND business_profile_id=${business}
    ) batch),'[]'::jsonb) AS imports,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('channel',channel,'id',account_id) ORDER BY channel,account_id)
      FROM (SELECT DISTINCT channel,account_id FROM (
        SELECT CASE WHEN c.channel IN('gmail','resend') THEN 'email' ELSE c.channel END AS channel,
          COALESCE(c.provider_account_id,m.provider_account_id,'') AS account_id
        FROM outreach_messages m JOIN outreach_conversations c ON c.id=m.conversation_id
          AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
        WHERE m.user_id=${userId} AND m.business_profile_id=${business} AND m.direction='outbound'
          AND m.message_kind IN('outreach','follow_up')
        UNION ALL
        SELECT CASE WHEN j.channel IN('gmail','resend') THEN 'email' ELSE j.channel END AS channel,
          COALESCE(j.metadata->>'providerAccountId',j.metadata->>'senderId','') AS account_id
        FROM outreach_jobs j WHERE j.user_id=${userId} AND j.business_profile_id=${business}
        UNION ALL
        SELECT CASE WHEN s.channel IN('gmail','resend') THEN 'email' ELSE s.channel END AS channel,
          COALESCE(s.sender_id::text,'') AS account_id
        FROM sent_messages s WHERE s.user_id=${userId} AND s.business_profile_id=${business} AND s.is_reply IS NOT TRUE
      ) candidates WHERE account_id<>'') accounts),'[]'::jsonb) AS accounts,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'name',COALESCE(result->>'name',payload->>'name','Prepared outreach')) ORDER BY created_at DESC)
      FROM dashboard_operations WHERE user_id=${userId} AND business_profile_id=${business} AND kind='campaign_prepare'),'[]'::jsonb) AS "preparedCampaigns"`);
  return result.rows[0] as CampaignReportOptions;
}
const countKeys = ['total','accepted','delivered','awaitingConfirmation','read','opened','clicked','queued','retrying','processing','failed','review','cancelled'] as const;
export function reportCounts(row: Record<string, unknown> = {}): CampaignDeliveryCounts {
  return Object.fromEntries(countKeys.map(key => [key,Math.max(0,Number(row[key]) || 0)])) as unknown as CampaignDeliveryCounts;
}
export function reportDefinitions(): CampaignReport['definitions'] {
  return {
    accepted: 'Accepted by the provider for sending. Includes delivered messages and messages awaiting delivery confirmation.',
    delivered: 'Provider delivery/read status or a recorded delivery/read receipt. Provider acceptance alone is not delivery.',
    responseRate: 'Distinct responding recipients divided by all distinct recipients in the selected outbound cohort, including queued recipients.',
    attribution: 'Outbound creation dates select the cohort. Replies are matched to its recipients, channel and receiving account after the recorded send, through this snapshot. A later reply does not prove it concerns this offer.',
    clicks: 'Recorded email/link tracking only; automated opens and link scanners are not proof of human interest. Phone-call button clicks are unavailable and must not be interpreted as zero.',
    history: 'Reply message counts describe saved inbox history. Responding customers also include older delivery records with a recorded reply marker; those records may not contain full conversation history.',
  };
}

/** All projections are suppressed by durable linkage/provider identity, never by
 * names, message text, date proximity or the account's current default sender. */
export function canonicalOutreachCtes(userId: number, filters?: CampaignReportFilters): SQL {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new CampaignReportError('Report owner does not match this business.',403);
  const business = scope.businessProfileId;
  return sql`
    ${customerReportingIdentityCtes()},
    report_sent AS NOT MATERIALIZED (
      SELECT s.*,COALESCE(mapped.customer_key,'lead:'||s.lead_id) AS customer_key FROM sent_messages s
      LEFT JOIN customer_leads mapped ON mapped.lead_id=s.lead_id WHERE s.user_id=${userId} AND s.business_profile_id=${business}
        AND ${reportChannelPredicate(sql`s.channel`, filters?.channel)}
    ), report_jobs AS NOT MATERIALIZED (
      SELECT j.*,COALESCE(mapped.customer_key,'lead:'||j.lead_id) AS customer_key FROM outreach_jobs j
      LEFT JOIN customer_leads mapped ON mapped.lead_id=j.lead_id WHERE j.user_id=${userId} AND j.business_profile_id=${business}
        AND ${reportChannelPredicate(sql`j.channel`, filters?.channel)}
    ), report_conversations AS NOT MATERIALIZED (
      SELECT c.*,mapped.customer_key FROM outreach_conversations c JOIN conversation_customers mapped ON mapped.id=c.id
      WHERE c.user_id=${userId} AND c.business_profile_id=${business}
        AND ${reportChannelPredicate(sql`c.channel`, filters?.channel)}
    ),
    -- Receipts are linked by any of a message's provider identifiers. Expanding
    -- both sides to (kind,key) pairs lets PostgreSQL hash-join them once; the
    -- former per-message OR lookup scanned every receipt for every message
    -- (about 400 million comparisons for 31k WhatsApp messages).
    message_receipt_keys AS (
      SELECT m.id AS message_id,c.customer_key,c.channel AS conversation_channel,k.kind,k.key
      FROM outreach_messages m JOIN report_conversations c ON c.id=m.conversation_id
        AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
      CROSS JOIN LATERAL (VALUES ('om',m.id::text),('mid',m.external_message_id),('mid',m.provider_message_id),
        ('mid',m.rfc_message_id),('mid',m.waba_message_id),('gid',m.external_message_id),('gid',m.provider_message_id),
        ('rfc',m.rfc_message_id)) k(kind,key)
      WHERE m.user_id=${userId} AND m.business_profile_id=${business} AND m.direction='outbound'
        AND m.message_kind IN('outreach','follow_up') AND k.key IS NOT NULL AND k.key<>''
    ), sent_receipt_keys AS (
      SELECT s.id,s.customer_key,s.channel,k.kind,k.key,s.delivered_at,s.opened_at,s.clicked_at,s.open_count,s.click_count,
        s.status,s.delivery_status,s.sent_at,s.reply_received_at,s.sentiment,s.updated_at
      FROM report_sent s
      CROSS JOIN LATERAL (VALUES ('om',s.outreach_message_id::text),('mid',s.message_id),('gid',s.gmail_message_id),
        ('rfc',s.rfc_message_id)) k(kind,key)
      WHERE s.is_reply IS NOT TRUE AND k.key IS NOT NULL AND k.key<>''
    ), receipt_matches AS (
      SELECT mk.message_id,s.* FROM message_receipt_keys mk
      -- A stored outreach_message_id names exactly one message of this business, so it
      -- needs no further check. Its conversation may be keyed by CRM contact while the
      -- send record is keyed by lead, which used to count the same email twice.
      -- Provider IDs must also agree on customer and channel.
      JOIN sent_receipt_keys s ON s.kind=mk.kind AND s.key=mk.key
        AND (s.kind='om' OR (s.customer_key=mk.customer_key
          AND ${sameReportChannel(sql`s.channel`, sql`mk.conversation_channel`)}))
    ), linked_sent AS (
      -- Legacy receipts already represented by a canonical message.
      SELECT DISTINCT id FROM receipt_matches
    ), message_receipts AS (
      SELECT s.message_id,
        MIN(COALESCE(s.delivered_at,s.opened_at,s.clicked_at,
          CASE WHEN s.open_count>0 OR s.click_count>0 OR s.status IN('delivered','opened','clicked') OR s.delivery_status IN('delivered','opened','clicked') THEN s.sent_at END)) AS delivered_at,
        MIN(COALESCE(s.opened_at,CASE WHEN s.open_count>0 THEN s.sent_at END)) AS opened_at,
        MIN(COALESCE(s.clicked_at,CASE WHEN s.click_count>0 THEN s.sent_at END)) AS clicked_at,MIN(s.reply_received_at) AS reply_received_at,
        (array_agg(s.sentiment ORDER BY s.updated_at DESC) FILTER(WHERE s.sentiment IS NOT NULL))[1] AS sentiment
      FROM receipt_matches s
      GROUP BY s.message_id
    ),
    canonical_messages AS (
      SELECT 'message-'||m.id AS id,m.id AS message_id,c.lead_id,m.campaign_id,c.id AS conversation_id,
        CASE WHEN c.channel IN('gmail','resend') THEN 'email' ELSE c.channel END AS channel,
        COALESCE(c.provider_account_id,m.provider_account_id,'') AS account_id,
        m.message_kind,COALESCE(m.metadata->>'preparedOutreachId',m.metadata->'outreachCreation'->'delivery'->>'preparedOutreachId') AS prepared_outreach_id,
        COALESCE(m.metadata->>'threadId',m.metadata->'outreachCreation'->'delivery'->>'threadId',campaign.settings->>'threadId') AS workspace_id,
        CASE WHEN m.status='failed' AND m.metadata->'outreachQueue'->>'enqueueNeeded'='true' THEN 'pending' ELSE m.status END AS raw_status,
        m.sent_at,m.created_at,COALESCE(m.delivered_at,receipt.delivered_at) AS delivered_at,m.read_at,
        m.manual_review_required OR m.status IN('manual_review','setup_required') AS needs_review,
        m.metadata->'outreachQueue'->>'reason' AS reason,
        m.metadata->'outreachQueue'->>'providerCode' AS provider_code,
        COALESCE(m.metadata->'outreachQueue'->>'nextAttemptAt',m.metadata->>'scheduledAt') AS next_attempt_at,
        m.error_message AS error,receipt.opened_at,receipt.clicked_at,
        receipt.reply_received_at,NULL::text AS reply_message_id,receipt.sentiment
      FROM outreach_messages m JOIN report_conversations c ON c.id=m.conversation_id
        AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
      LEFT JOIN outreach_campaigns campaign ON campaign.id=m.campaign_id AND campaign.user_id=m.user_id AND campaign.business_profile_id=m.business_profile_id
      LEFT JOIN message_receipts receipt ON receipt.message_id=m.id
      WHERE m.user_id=${userId} AND m.business_profile_id=${business} AND m.direction='outbound'
        AND m.message_kind IN('outreach','follow_up')
        AND ${reportSourcePredicate(filters, {
          channel: sql`c.channel`, account: sql`COALESCE(c.provider_account_id,m.provider_account_id,'')`,
          createdAt: sql`m.created_at`, campaignId: sql`m.campaign_id`, messageKind: sql`m.message_kind`,
          preparedOutreachId: sql`COALESCE(m.metadata->>'preparedOutreachId',m.metadata->'outreachCreation'->'delivery'->>'preparedOutreachId')`,
        })}
    ), legacy_jobs AS (
      SELECT 'campaign-job-'||j.id AS id,NULL::int AS message_id,j.lead_id,j.campaign_id,NULL::int AS conversation_id,
        CASE WHEN j.channel IN('gmail','resend') THEN 'email' ELSE j.channel END AS channel,
        COALESCE(j.metadata->>'providerAccountId',j.metadata->>'senderId','') AS account_id,
        CASE WHEN j.metadata->>'isFollowUp'='true' THEN 'follow_up' ELSE 'outreach' END AS message_kind,
        j.metadata->>'preparedOutreachId' AS prepared_outreach_id,
        COALESCE(j.metadata->>'threadId',campaign.settings->>'threadId') AS workspace_id,
        j.status AS raw_status,j.sent_at,j.created_at,
        receipt.delivered_at,NULL::timestamp AS read_at,
        j.metadata->>'manualReviewRequired'='true' OR j.status='setup_required' AS needs_review,
        CASE WHEN j.attempts>0 AND j.status='pending' THEN 'provider_limit' END AS reason,
        j.metadata->>'providerCode' AS provider_code,
        CASE WHEN j.status='pending' THEN to_char(j.scheduled_for,'YYYY-MM-DD"T"HH24:MI:SS"Z"') END AS next_attempt_at,
        j.error,receipt.opened_at,receipt.clicked_at,receipt.reply_received_at,NULL::text AS reply_message_id,receipt.sentiment
      FROM report_jobs j LEFT JOIN outreach_campaigns campaign ON campaign.id=j.campaign_id
        AND campaign.user_id=j.user_id AND campaign.business_profile_id=j.business_profile_id
      LEFT JOIN LATERAL (
        SELECT MIN(COALESCE(s.delivered_at,s.opened_at,s.clicked_at,
          CASE WHEN s.open_count>0 OR s.click_count>0 OR s.status IN('delivered','opened','clicked') OR s.delivery_status IN('delivered','opened','clicked') THEN s.sent_at END)) AS delivered_at,
          MIN(COALESCE(s.opened_at,CASE WHEN s.open_count>0 THEN s.sent_at END)) AS opened_at,
          MIN(COALESCE(s.clicked_at,CASE WHEN s.click_count>0 THEN s.sent_at END)) AS clicked_at,MIN(s.reply_received_at) AS reply_received_at,
          (array_agg(s.sentiment ORDER BY s.updated_at DESC) FILTER(WHERE s.sentiment IS NOT NULL))[1] AS sentiment
        FROM report_sent s WHERE s.user_id=j.user_id AND s.business_profile_id=j.business_profile_id
          AND s.customer_key=j.customer_key AND s.is_reply IS NOT TRUE
          AND ${sameReportChannel(sql`s.channel`, sql`j.channel`)}
          AND j.external_message_id IS NOT NULL AND j.external_message_id IN(s.message_id,s.gmail_message_id,s.rfc_message_id)
      ) receipt ON TRUE
      WHERE j.user_id=${userId} AND j.business_profile_id=${business}
        AND NOT EXISTS(SELECT 1 FROM outreach_messages m JOIN report_conversations c ON c.id=m.conversation_id
          AND c.user_id=m.user_id AND c.business_profile_id=m.business_profile_id
          WHERE m.user_id=j.user_id AND m.business_profile_id=j.business_profile_id AND c.customer_key=j.customer_key
            AND m.direction='outbound' AND m.message_kind IN('outreach','follow_up')
            AND ${sameReportChannel(sql`c.channel`, sql`j.channel`)}
            AND (j.external_message_id IN(m.external_message_id,m.provider_message_id,m.rfc_message_id,m.waba_message_id)
              OR m.id::text=j.metadata->>'messageId'))
        AND ${reportSourcePredicate(filters, {
          channel: sql`j.channel`, account: sql`COALESCE(j.metadata->>'providerAccountId',j.metadata->>'senderId','')`,
          createdAt: sql`j.created_at`, campaignId: sql`j.campaign_id`,
          messageKind: sql`CASE WHEN j.metadata->>'isFollowUp'='true' THEN 'follow_up' ELSE 'outreach' END`,
          preparedOutreachId: sql`j.metadata->>'preparedOutreachId'`,
        })}
    ), legacy_sent AS (
      SELECT 'legacy-sent-'||s.id AS id,NULL::int AS message_id,s.lead_id,s.campaign_id,NULL::int AS conversation_id,
        CASE WHEN s.channel IN('gmail','resend') THEN 'email' ELSE s.channel END AS channel,
        COALESCE(s.sender_id::text,'') AS account_id,
        CASE WHEN COALESCE(s.follow_up_step,0)>0 THEN 'follow_up' ELSE 'outreach' END AS message_kind,
        NULL::text AS prepared_outreach_id,
        campaign.settings->>'threadId' AS workspace_id,
        CASE WHEN s.delivery_status IN('failed','bounced') THEN 'failed'
          WHEN s.status IN('sent','delivered','opened','clicked','replied') THEN 'sent' ELSE s.status END AS raw_status,
        s.sent_at,s.created_at,
        CASE WHEN COALESCE(s.delivered_at,s.opened_at,s.clicked_at) IS NOT NULL THEN COALESCE(s.delivered_at,s.opened_at,s.clicked_at)
          WHEN s.open_count>0 OR s.click_count>0 OR s.status IN('delivered','opened','clicked') OR s.delivery_status IN('delivered','opened','clicked') THEN s.sent_at END AS delivered_at,
        NULL::timestamp AS read_at,false AS needs_review,NULL::text AS reason,NULL::text AS provider_code,
        NULL::text AS next_attempt_at,s.bounce_reason AS error,
        COALESCE(s.opened_at,CASE WHEN s.open_count>0 THEN s.sent_at END) AS opened_at,
        COALESCE(s.clicked_at,CASE WHEN s.click_count>0 THEN s.sent_at END) AS clicked_at,s.reply_received_at,s.reply_message_id,s.sentiment
      FROM report_sent s LEFT JOIN outreach_campaigns campaign ON campaign.id=s.campaign_id
        AND campaign.user_id=s.user_id AND campaign.business_profile_id=s.business_profile_id
      WHERE s.user_id=${userId} AND s.business_profile_id=${business} AND s.is_reply IS NOT TRUE
        AND NOT EXISTS(SELECT 1 FROM linked_sent linked WHERE linked.id=s.id)
        AND NOT EXISTS(SELECT 1 FROM report_jobs j WHERE j.user_id=s.user_id AND j.business_profile_id=s.business_profile_id
          AND j.customer_key=s.customer_key AND ${sameReportChannel(sql`j.channel`, sql`s.channel`)}
          AND j.external_message_id IS NOT NULL AND j.external_message_id IN(s.message_id,s.gmail_message_id,s.rfc_message_id))
        AND ${reportSourcePredicate(filters, {
          channel: sql`s.channel`, account: sql`COALESCE(s.sender_id::text,'')`, createdAt: sql`s.created_at`,
          campaignId: sql`s.campaign_id`,
          messageKind: sql`CASE WHEN COALESCE(s.follow_up_step,0)>0 THEN 'follow_up' ELSE 'outreach' END`,
        })}
    ), raw_intents AS (
      SELECT * FROM canonical_messages UNION ALL SELECT * FROM legacy_jobs UNION ALL SELECT * FROM legacy_sent
    ), intents AS (
      SELECT raw.*,COALESCE(conversation.customer_key,lead.customer_key,'lead:'||raw.lead_id) AS customer_key,
        ${reportStateSql(deliveryStateSql({
          status: sql`raw_status`, deliveredAt: sql`delivered_at`, readAt: sql`read_at`,
          needsReview: sql`COALESCE(needs_review,false)`,
          // A requeued message already reads as pending here, and expiry folds into failed either way.
          requeued: sql`false`, expired: sql`false`,
          // Scheduled, waiting and limit-held all fold into queued, so the time is not needed.
          waitReason: sql`reason`, nextAttemptAt: sql`NULL::timestamptz`,
        }))} AS state
      FROM raw_intents raw LEFT JOIN conversation_customers conversation ON conversation.id=raw.conversation_id
        LEFT JOIN customer_leads lead ON lead.lead_id=raw.lead_id
    )`;
}

/** Validated, parameterized predicates. Workspace IDs and provider campaign IDs
 * are deliberately distinct; an import ID always includes its source. */
export function reportPredicate(filters: CampaignReportFilters): SQL {
  const {userId,businessProfileId:business} = requireBusinessScope();
  const clauses: SQL[] = [];
  if (filters.channel) clauses.push(sql`i.channel=${filters.channel}`);
  if (filters.accountId) clauses.push(sql`i.account_id=${filters.accountId}`);
  if (filters.messageKind !== 'all') clauses.push(sql`i.message_kind=${filters.messageKind}`);
  // Application timestamps are stored as UTC without a zone. Bind canonical
  // strings so a worker's local timezone cannot shift the cohort boundaries.
  if (filters.from) clauses.push(sql`i.created_at>=${new Date(filters.from).toISOString()}::timestamp`);
  if (filters.to) clauses.push(sql`i.created_at<${new Date(filters.to).toISOString()}::timestamp`);
  if (filters.campaignId) clauses.push(sql`i.campaign_id=${filters.campaignId}`);
  if (filters.preparedOutreachId) clauses.push(sql`i.prepared_outreach_id=${filters.preparedOutreachId}`);
  if (filters.workspaceId) clauses.push(sql`(i.workspace_id=${String(filters.workspaceId)} OR EXISTS(
    SELECT 1 FROM leads lead WHERE lead.id=i.lead_id AND lead.user_id=${userId} AND lead.business_profile_id=${business}
      AND lead.legacy_campaign_thread_key=${String(filters.workspaceId)}) OR EXISTS(
    SELECT 1 FROM campaign_crm_contacts membership JOIN contact_roots member_root ON member_root.contact_id=membership.contact_id
    JOIN crm_contacts contact ON contact.id=member_root.root_id
      AND contact.user_id=membership.user_id AND contact.business_profile_id=membership.business_profile_id
    WHERE membership.thread_id=${filters.workspaceId} AND membership.user_id=${userId}
      AND membership.business_profile_id=${business} AND (contact.lead_id=i.lead_id OR i.customer_key='contact:'||contact.id)) OR EXISTS(
    SELECT 1 FROM campaign_lead_imports batch JOIN campaign_lead_import_members member ON member.import_id=batch.id
      AND member.user_id=batch.user_id AND member.business_profile_id=batch.business_profile_id
    LEFT JOIN crm_contacts original ON original.id=member.contact_id AND original.user_id=member.user_id AND original.business_profile_id=member.business_profile_id
    LEFT JOIN contact_roots member_root ON member_root.contact_id=original.id
    LEFT JOIN crm_contacts canonical ON canonical.id=member_root.root_id
      AND canonical.user_id=member.user_id AND canonical.business_profile_id=member.business_profile_id
    WHERE batch.thread_id=${filters.workspaceId} AND batch.user_id=${userId} AND batch.business_profile_id=${business}
      AND (i.lead_id=COALESCE(canonical.lead_id,member.recipient_lead_id,member.lead_id) OR i.customer_key='contact:'||canonical.id)))`);
  if (filters.importSource === 'crm') {
    // These membership sets do not depend on the current intent. PostgreSQL
    // builds each once as a hashed subplan instead of repeating the import and
    // contact-root joins for every message in the selected report.
    const importedContacts = (selected: SQL) => sql`
      SELECT ${selected} FROM crm_contact_import_details detail JOIN crm_contact_imports batch ON batch.id=detail.import_id
        AND batch.business_profile_id=detail.business_profile_id
      JOIN crm_contacts original ON original.id=detail.created_contact_id AND original.user_id=batch.user_id
        AND original.business_profile_id=batch.business_profile_id
      JOIN contact_roots source_root ON source_root.contact_id=original.id
      JOIN crm_contacts contact ON contact.id=source_root.root_id AND contact.user_id=batch.user_id
        AND contact.business_profile_id=batch.business_profile_id
      WHERE batch.user_id=${userId} AND batch.business_profile_id=${business}
        AND detail.status IN('success','warning') ${filters.importId ? sql`AND batch.id=${filters.importId}` : sql``}`;
    clauses.push(sql`(i.lead_id IN (${importedContacts(sql`contact.lead_id`)})
      OR i.customer_key IN (${importedContacts(sql`'contact:'||contact.id`)}))`);
  }
  if (filters.importSource === 'campaign') clauses.push(sql`EXISTS(
    SELECT 1 FROM campaign_lead_import_members member JOIN campaign_lead_imports batch ON batch.id=member.import_id
      AND batch.user_id=member.user_id AND batch.business_profile_id=member.business_profile_id
    LEFT JOIN crm_contacts original ON original.id=member.contact_id AND original.user_id=member.user_id
      AND original.business_profile_id=member.business_profile_id
    LEFT JOIN contact_roots member_root ON member_root.contact_id=original.id
    LEFT JOIN crm_contacts canonical ON canonical.id=member_root.root_id
      AND canonical.user_id=member.user_id AND canonical.business_profile_id=member.business_profile_id
    WHERE member.user_id=${userId} AND member.business_profile_id=${business}
      AND (COALESCE(canonical.lead_id,member.recipient_lead_id,member.lead_id)=i.lead_id OR i.customer_key='contact:'||canonical.id)
      ${filters.importId ? sql`AND batch.id=${filters.importId}` : sql``})`);
  return clauses.length ? sql.join(clauses,sql` AND `) : sql`TRUE`;
}

export async function validateReportScope(userId: number, filters: CampaignReportFilters) {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new CampaignReportError('Report owner does not match this business.',403);
  if (filters.workspaceId) await assertOwnedCampaignThread(userId,filters.workspaceId);
  if(filters.preparedOutreachId) {
    const owned=await db.execute(sql`SELECT id FROM dashboard_operations WHERE id=${filters.preparedOutreachId}::uuid AND kind='campaign_prepare'
      AND user_id=${userId} AND business_profile_id=${scope.businessProfileId}`);
    if(!owned.rows.length)throw new CampaignReportError('The prepared campaign is not available in this business.',404);
  }
  for (const [id,table] of [
    [filters.campaignId,'outreach_campaigns'],
    [filters.importId,filters.importSource === 'crm' ? 'crm_contact_imports' : 'campaign_lead_imports'],
  ] as const) if (id) {
    const owned = await db.execute(sql`SELECT id FROM ${sql.identifier(table)} WHERE id=${id}
      AND user_id=${userId} AND business_profile_id=${scope.businessProfileId}`);
    if (!owned.rows.length) throw new CampaignReportError('The selected campaign or import is not available in this business.',404);
  }
}

const metrics = sql`
  COUNT(*)::int AS total,
  COUNT(*) FILTER(WHERE state IN('accepted','delivered'))::int AS accepted,
  COUNT(*) FILTER(WHERE state='delivered')::int AS delivered,
  COUNT(*) FILTER(WHERE state='accepted')::int AS "awaitingConfirmation",
  COUNT(*) FILTER(WHERE read_at IS NOT NULL OR raw_status='read')::int AS read,
  COUNT(*) FILTER(WHERE opened_at IS NOT NULL)::int AS opened,
  COUNT(*) FILTER(WHERE clicked_at IS NOT NULL)::int AS clicked,
  COUNT(*) FILTER(WHERE state='queued')::int AS queued,
  COUNT(*) FILTER(WHERE state='queued' AND reason IS NOT NULL)::int AS retrying,
  COUNT(*) FILTER(WHERE state='processing')::int AS processing,
  COUNT(*) FILTER(WHERE state='failed')::int AS failed,
  COUNT(*) FILTER(WHERE state='review')::int AS review,
  COUNT(*) FILTER(WHERE state='cancelled')::int AS cancelled`;

export function campaignResponseCtes(userId:number):SQL {
  const scope=requireBusinessScope();
  return sql`
    cohort AS (SELECT customer_key,channel,account_id,MIN(sent_at) AS starts FROM selected
      WHERE sent_at IS NOT NULL AND state IN('accepted','delivered') GROUP BY customer_key,channel,account_id),
    response_rows AS (
      SELECT DISTINCT m.id,a.customer_key,a.account_id,CASE WHEN c.channel IN('gmail','resend') THEN 'email' ELSE c.channel END AS channel,
        CASE WHEN m.metadata#>>'{nativeSelection,kind}' IN('button_reply','template_button') OR m.message_type='button' THEN 'button'
          WHEN m.metadata#>>'{nativeSelection,kind}'='list_reply' THEN 'menu'
          -- Email, Messenger and Instagram store plain inbound text without a type.
          WHEN NULLIF(m.message_type,'') IS NULL THEN 'text' ELSE m.message_type END AS message_type,
        m.direction,m.is_ai_generated,m.created_at
      FROM cohort a JOIN conversation_customers identity ON identity.customer_key=a.customer_key
      JOIN outreach_conversations c ON c.id=identity.id AND c.user_id=${userId}
        AND c.business_profile_id=${scope.businessProfileId}
        AND (c.channel=a.channel OR (a.channel='email' AND c.channel IN('gmail','resend')))
        AND COALESCE(c.provider_account_id,'')=a.account_id
      JOIN outreach_messages m ON m.conversation_id=c.id AND m.user_id=c.user_id AND m.business_profile_id=c.business_profile_id
        AND m.created_at>=a.starts AND m.created_at<=CURRENT_TIMESTAMP AT TIME ZONE 'UTC'
        AND (m.direction='inbound' OR (m.direction='outbound' AND m.message_kind='reply'
          AND (m.status IN('sent','delivered','read') OR m.delivered_at IS NOT NULL OR m.read_at IS NOT NULL)))
    ), replies AS (SELECT * FROM response_rows WHERE direction='inbound'),
    reply_markers AS (SELECT customer_key,channel FROM selected WHERE state IN('accepted','delivered') AND sent_at IS NOT NULL
      AND reply_received_at>=sent_at AND reply_received_at<=CURRENT_TIMESTAMP AT TIME ZONE 'UTC')`;
}

type ReportExecutor = { execute: typeof db.execute; transaction?: typeof db.transaction };

/**
 * Runs a query built on canonicalOutreachCtes without nested-loop joins.
 *
 * The contact-merge and lead-mapping CTEs are estimated at a few dozen rows
 * but hold tens of thousands on large accounts, so the planner rescans them
 * once per message. Oro Circle's WhatsApp report took over 7 minutes that way
 * and 4.6 seconds with hash joins. SET LOCAL ends with the report's own
 * transaction, or with the caller's when one is passed in.
 *
 * Disabling nested loops adds PostgreSQL's disable_cost to the estimate (about
 * 2e10), far past jit_inline_above_cost, so the server JIT-compiled and inlined
 * all ~540 expressions of this query on every request. On a business with 400
 * messages that took 19 seconds for a query that runs in 17 ms, and the report
 * hit the 25-second read limit. The query is short-lived; JIT never pays off.
 */
export async function executeReportQuery(executor: ReportExecutor, query: SQL) {
  const run = async (tx: ReportExecutor) => {
    await tx.execute(sql`SET LOCAL enable_nestloop = off`);
    await tx.execute(sql`SET LOCAL jit = off`);
    return tx.execute(query);
  };
  if (executor !== db) return run(executor);
  return typeof db.transaction === 'function' ? db.transaction((tx: typeof db) => run(tx)) : db.execute(query);
}

export async function getCampaignReport(userId: number, input: unknown = {},executor=db): Promise<CampaignReport> {
  const filters = campaignReportFiltersSchema.parse(input);
  await validateReportScope(userId,filters);
  const result = await executeReportQuery(executor, sql`WITH ${canonicalOutreachCtes(userId,filters)},
    selected AS (SELECT * FROM intents i WHERE ${reportPredicate(filters)}),
    totals AS (SELECT ${metrics},COUNT(DISTINCT customer_key)::int AS recipients,
      COUNT(DISTINCT campaign_id) FILTER(WHERE state='queued')::int AS active_sequences,
      COUNT(*) FILTER(WHERE state='queued' AND message_kind='follow_up')::int AS pending_follow_ups FROM selected),
    ranked_waiting AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY channel ORDER BY (reason IS NULL),next_attempt_at NULLS FIRST,id) AS queue_rank
      FROM selected WHERE state='queued'),
    channel_totals AS (SELECT channel,${metrics},
      CASE WHEN COUNT(*) FILTER(WHERE state='queued' AND next_attempt_at IS NULL)>0 THEN NULL
        ELSE MIN(next_attempt_at) FILTER(WHERE state='queued') END AS "nextAttemptAt"
      FROM selected GROUP BY channel),
    ${campaignResponseCtes(userId)},
    responses AS (SELECT
      (SELECT COUNT(DISTINCT customer_key)::int FROM (
        SELECT customer_key FROM replies UNION SELECT customer_key FROM reply_markers
      ) responded) AS responding,
      (SELECT COUNT(*)::int FROM replies) AS inbound,
      (SELECT COUNT(*)::int FROM replies WHERE message_type='text') AS typed,
      (SELECT COUNT(*)::int FROM replies WHERE message_type='button') AS buttons,
      (SELECT COUNT(*)::int FROM replies WHERE message_type='menu') AS menus,
      (SELECT COUNT(*)::int FROM replies WHERE message_type IS NULL OR message_type NOT IN('text','button','menu')) AS other,
      (SELECT COUNT(*)::int FROM response_rows r WHERE r.direction='outbound' AND r.is_ai_generated
        AND EXISTS(SELECT 1 FROM replies incoming WHERE incoming.customer_key=r.customer_key AND incoming.channel=r.channel
          AND incoming.account_id=r.account_id AND incoming.created_at<=r.created_at)) AS assistant),
    responded AS (SELECT customer_key,channel FROM replies UNION SELECT customer_key,channel FROM reply_markers),
    daily AS (SELECT to_char(created_at,'YYYY-MM-DD') AS date,
      COUNT(*) FILTER(WHERE state IN('accepted','delivered'))::int AS sent,
      COUNT(*) FILTER(WHERE opened_at IS NOT NULL)::int AS opened,
      COUNT(*) FILTER(WHERE clicked_at IS NOT NULL)::int AS clicked,
      COUNT(DISTINCT customer_key) FILTER(WHERE customer_key IN(SELECT customer_key FROM responded))::int AS replied
      FROM selected GROUP BY 1),
    errors AS (SELECT channel,provider_code AS code,COALESCE(NULLIF(error,''),NULLIF(reason,''),'Needs review') AS reason,COUNT(*)::int AS count
      FROM selected WHERE state IN('failed','review') GROUP BY channel,provider_code,COALESCE(NULLIF(error,''),NULLIF(reason,''),'Needs review'))
    SELECT CURRENT_TIMESTAMP AS checked_at,to_jsonb(totals) AS counts,to_jsonb(responses) AS responses,
      COALESCE((SELECT jsonb_agg(to_jsonb(ct)||jsonb_build_object(
        'respondingCustomers',(SELECT COUNT(DISTINCT r.customer_key) FROM responded r WHERE r.channel=ct.channel),
        'waiting',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',w.id,'reason',w.reason,'nextAttemptAt',w.next_attempt_at,'error',w.error)
          ORDER BY w.queue_rank) FROM ranked_waiting w WHERE w.channel=ct.channel AND w.queue_rank<=20),'[]'::jsonb)) ORDER BY ct.channel)
        FROM channel_totals ct),'[]'::jsonb) AS channels,
      COALESCE((SELECT jsonb_agg(to_jsonb(daily) ORDER BY date) FROM daily),'[]'::jsonb) AS timeline,
      (SELECT jsonb_build_object('positive',COUNT(*) FILTER(WHERE sentiment='positive'),'neutral',COUNT(*) FILTER(WHERE sentiment='neutral'),
        'negative',COUNT(*) FILTER(WHERE sentiment='negative'),'urgent',COUNT(*) FILTER(WHERE sentiment='urgent'),
        'total',COUNT(*) FILTER(WHERE sentiment IN('positive','neutral','negative','urgent'))) FROM selected WHERE reply_received_at>=sent_at) AS sentiment,
      COALESCE((SELECT jsonb_agg(to_jsonb(errors) ORDER BY count DESC,channel,reason) FROM errors),'[]'::jsonb) AS failures,
      CASE WHEN EXISTS(SELECT 1 FROM selected WHERE state='queued' AND next_attempt_at IS NULL) THEN NULL
        ELSE (SELECT MIN(next_attempt_at) FROM selected WHERE state='queued') END AS next_attempt_at
    FROM totals,responses`);
  const row = result.rows[0];
  if (!row) throw new CampaignReportError('The report snapshot could not be read.',503);
  const counts = reportCounts(row.counts);
  const responses = row.responses || {};
  const recipients = Number(row.counts?.recipients || 0);
  return {
    version:1,source:'canonical_outreach',checkedAt:new Date(row.checked_at).toISOString(),filters,counts,
    channels:(row.channels || []).map((channel: Record<string,unknown>) => ({...reportCounts(channel),channel:String(channel.channel),
      respondingCustomers:Number(channel.respondingCustomers || 0),waiting:Array.isArray(channel.waiting) ? channel.waiting : [],
      nextAttemptAt:channel.nextAttemptAt ? String(channel.nextAttemptAt) : null})),
    timeline:row.timeline || [],activeSequences:Number(row.counts?.active_sequences || 0),pendingFollowUps:Number(row.counts?.pending_follow_ups || 0),
    sentiment:row.sentiment,
    uniqueRecipients:recipients,
    engagement:{ respondingCustomers:Number(responses.responding || 0),inboundResponses:Number(responses.inbound || 0),
      typedReplies:Number(responses.typed || 0),quickReplies:Number(responses.buttons || 0),menuSelections:Number(responses.menus || 0),
      otherResponses:Number(responses.other || 0),assistantReplies:Number(responses.assistant || 0),
      responseRate:recipients ? Math.round(Number(responses.responding || 0)/recipients*10000)/100 : 0,
      callButtonClicks:null,callButtonClickAvailability:'unavailable'},
    failures:row.failures || [],nextAttemptAt:row.next_attempt_at || null,definitions:reportDefinitions(),
    links:{report:campaignReportUrl(filters),...(filters.preparedOutreachId ? {campaign:`/dashboard/outreach/prepared/${filters.preparedOutreachId}`} : filters.campaignId ? {campaign:`/dashboard/outreach/campaigns/${filters.campaignId}/review`} : filters.workspaceId ? {campaign:`/dashboard/conversations/${filters.workspaceId}`} : {}),contacts:'/dashboard/crm/contacts'},
  };
}

/** Compatibility for the existing activity and analytics screens. */
export function campaignReportStats(report: CampaignReport, range = 'all') {
  const rate = (count: number,total: number) => total ? count/total*100 : 0;
  const timeline=range==='all' ? report.timeline : Array.from({length:Number.parseInt(range,10)},(_,index)=>{
    const day=new Date(report.checkedAt);day.setUTCDate(day.getUTCDate()-Number.parseInt(range,10)+index+1);
    const date=day.toISOString().slice(0,10);
    return report.timeline.find(row=>row.date===date) || {date,sent:0,opened:0,clicked:0,replied:0};
  });
  return {
    totalSent:report.counts.accepted,totalMessages:report.counts.total,
    ...report.counts,delivered:report.counts.delivered,opened:report.counts.opened,clicked:report.counts.clicked,
    replied:report.engagement.respondingCustomers,openRate:rate(report.counts.opened,report.counts.accepted),
    replyRate:report.engagement.responseRate,activeSequences:report.activeSequences,pendingFollowUps:report.pendingFollowUps,
    byChannel:Object.fromEntries(report.channels.map(ch=>[ch.channel,{
      sent:ch.accepted,delivered:ch.delivered,opened:ch.opened,clicked:ch.clicked,replied:ch.respondingCustomers,
      queued:ch.queued,failed:ch.failed,conversions:0,conversionRate:0,
      openRate:rate(ch.opened,ch.accepted),clickRate:rate(ch.clicked,ch.accepted),replyRate:rate(ch.respondingCustomers,report.uniqueRecipients),
    }])),byStatus:{sent:report.counts.accepted,pending:report.counts.queued,failed:report.counts.failed},
    timeline,sentiment:report.sentiment,checkedAt:report.checkedAt,range,source:'canonical_outreach',report,
  };
}
