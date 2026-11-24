import { threadLeadIds } from './threadLeadCohort.js';
import { beginCrmImport, importRowCommitted, saveCrmImportReceipt, readCrmImportProgress, CrmImportInterruptedError, CRM_IMPORT_TERMINAL_STATUSES } from './CrmImportLedger.js';
import { assertOwnedCampaignThread, associateCampaignContact } from './CampaignWorkspaceService.js';
import { normalizeCapacityError } from './billing/entitlements.js';
import { db } from '../models/db';
import { createHash } from 'node:crypto';
import { outreachMessagesTable, outreachConversationsTable } from '../models/outreachConversations/schema';
import { crmContactsTable } from '../models/crmContacts/schema';
import { crmActivitiesTable } from '../models/crmActivities/schema';
import { leadsTable } from '../models/leads/schema';
import { LeadModel } from '../models/leads/functions';
import { eq, and, desc, sql, isNull, isNotNull, inArray, or, type SQL } from 'drizzle-orm';
import { logger } from '../utils/logger.js';
import { sentimentAnalysisService } from './SentimentAnalysisService';
import { alertService } from './AlertService';
import { getInboundReplyTransition } from '../utils/inboundReplyStatus.js';
import { contactPhoneFingerprint, mergeContactByPhone, normalizedContactPhone } from './CRMContactMergeService.js';
import { DEFAULT_CRM_CONFIGURATION, crmSelectedPlatforms, crmStagesForStatuses, type CrmConfiguration } from '../../shared/crmConfiguration.js';
import type { CrmStageType } from '../../shared/crmConfiguration.js';
import { crmContactStatusForStage, crmLeadStatusForStage, resolveCrmStageReference, crmStageForOutcome } from '../../shared/crmPipeline.js';
import { CrmConfigurationError, getCrmConfiguration } from './CRMConfigurationService.js';
import { requireBusinessScope } from '../tenancy/businessContext.js';
import { validateCrmAssignee } from './CRMAssigneeService.js';
import { serializeUtcTimestamp } from '../utils/supportTimestamp.js';
import { setupRequestHash } from '../utils/setupIdempotency.js';
import { crmImportPatch } from '../utils/crmImportPatch.js';
import {contactImportPhoneMatch} from '../utils/contactImportPhoneMatch.js';
import {contactPhoneCandidateIds} from '../utils/contactPhoneCandidates.js';
import {contactLeadAliasIds} from '../utils/contactLeadAliases.js';
import { crmDateBounds, crmReportPlatforms, type CrmContactFilters, type CrmBulkContactUpdate } from '../utils/crmWorkspaceValidation.js';
import {
  getMissingContactImportFields,
  contactImportIdentity,
} from '../utils/contactImportValidation.js';


/** Virtual contacts must use the same saved stage types as stored contacts. */
function virtualLeadCrmState(configuration: CrmConfiguration, hasConversation: SQL) {
  const { stages } = configuration;
  const active = stages.find(stage => stage.type === 'active')?.key || 'new';
  const stage = sql`CASE
    WHEN l.status IN ('won', 'converted') THEN ${crmStageForOutcome(stages, 'won')?.key || 'new'}
    WHEN l.status IN ('lost', 'rejected') THEN ${crmStageForOutcome(stages, 'lost')?.key || 'new'}
    WHEN l.status <> 'new' AND l.status = ANY(${sql.param(stages.map(item => item.key))}::text[]) THEN l.status
    WHEN ${hasConversation} THEN ${active}
    ELSE 'new' END`;
  const status = sql`CASE
    WHEN (${stage}) = ANY(${sql.param(stages.filter(item => item.type === 'won').map(item => item.key))}::text[]) THEN 'won'
    WHEN (${stage}) = ANY(${sql.param(stages.filter(item => item.type === 'lost').map(item => item.key))}::text[]) THEN 'lost'
    WHEN (${stage}) = 'new' THEN 'new'
    WHEN l.status IS NULL OR l.status IN ('new', 'won', 'lost', 'converted', 'rejected') THEN 'contacted'
    ELSE l.status END`;
  return { stage, status };
}

/** Reused by collection, work and reporting queries so virtual contacts share stage semantics. */
export function crmVisibleContactsCte(userId: number, configuration: CrmConfiguration) {
  const virtual = virtualLeadCrmState(configuration, sql`oc_agg.conversation_count > 0`);
  return sql`      WITH oc_agg AS (
        SELECT lead_id, COUNT(*)::int AS conversation_count
        FROM outreach_conversations
        WHERE user_id = ${userId}
        GROUP BY lead_id
      ),
      -- One pass over pipeline history instead of a correlated MAX() lookup
      -- for every visible row, which every CRM list/report query evaluated.
      stage_changes AS (
        SELECT activity.contact_id, MAX(activity.created_at) AS entered_at
        FROM crm_activities activity
        WHERE activity.user_id = ${userId} AND activity.type = 'pipeline_change' AND activity.contact_id IS NOT NULL
        GROUP BY activity.contact_id
      ),
      base AS (
        SELECT
          ${userId}::int AS user_id,
          CASE WHEN c.id IS NOT NULL THEN c.id ELSE -l.id END AS id,
          l.id AS lead_id,
          c.id AS crm_contact_id,
          COALESCE(c.first_name, l.first_name, l.name) AS first_name,
          COALESCE(c.last_name, l.last_name) AS last_name,
          COALESCE(c.first_name || ' ' || c.last_name, l.name, l.first_name || ' ' || l.last_name, l.email) AS display_name,
          COALESCE(c.email, l.email) AS email,
          COALESCE(c.phone, l.phone) AS phone,
          COALESCE(c.company, l.company, l.company_name) AS company,
          COALESCE(c.role, l.role) AS role,
          COALESCE(c.status, ${virtual.status}) AS status,
          COALESCE(c.pipeline_status, ${virtual.stage}) AS pipeline_status,
          c.last_sentiment_status,
          c.deal_value,
          COALESCE(c.currency, 'USD') AS currency,
          c.sentiment_score,
          COALESCE(c.total_outreach_sent, 0)::int AS total_outreach_sent,
          COALESCE(c.last_activity_at, l.updated_at) AS last_activity_at,
          COALESCE(c.tags, '[]'::jsonb) AS tags,
          COALESCE(c.created_at, l.created_at) AS created_at,
          COALESCE(c.priority, 'medium') AS priority,
          COALESCE(c.source, l.source) AS source,
          COALESCE(c.fit_score, l.fit_score::real) AS fit_score,
          COALESCE(c.linkedin_url, l.linkedin_url) AS linkedin_url,
          COALESCE(c.avatar_url, l.profile_picture) AS avatar_url,
          c.assigned_to, c.next_follow_up_at, COALESCE(c.updated_at, l.updated_at) AS updated_at,
          COALESCE(stage_changes.entered_at, c.created_at, l.created_at) AS stage_entered_at,
          COALESCE(c.business_category_name, l.business_category_name) AS business_category_name
        FROM leads l
        LEFT JOIN crm_contacts c ON c.lead_id = l.id AND c.user_id = ${userId} AND c.deleted_at IS NULL
        LEFT JOIN oc_agg ON oc_agg.lead_id = l.id
        LEFT JOIN stage_changes ON stage_changes.contact_id = c.id
        WHERE l.user_id = ${userId}
          AND l.deleted_at IS NULL
          AND (c.id IS NOT NULL OR NOT EXISTS (SELECT 1 FROM outreach_conversations alias
            JOIN crm_contacts canonical ON canonical.id=alias.crm_contact_id AND canonical.deleted_at IS NULL
            WHERE alias.user_id=${userId} AND alias.lead_id=l.id))
          AND (
            c.id IS NOT NULL OR NOT EXISTS (
              SELECT 1
              FROM crm_contacts deleted_contact
              WHERE deleted_contact.user_id = ${userId}
                AND deleted_contact.lead_id = l.id
                AND deleted_contact.deleted_at IS NOT NULL
            )
          )

        UNION ALL

        SELECT
          c.user_id,
          c.id,
          c.lead_id,
          c.id AS crm_contact_id,
          c.first_name,
          c.last_name,
          COALESCE(c.first_name || ' ' || c.last_name, c.email) AS display_name,
          c.email,
          c.phone,
          c.company,
          c.role,
          COALESCE(c.status, 'new') AS status,
          COALESCE(c.pipeline_status, 'new') AS pipeline_status,
          c.last_sentiment_status,
          c.deal_value,
          COALESCE(c.currency, 'USD') AS currency,
          c.sentiment_score,
          COALESCE(c.total_outreach_sent, 0)::int AS total_outreach_sent,
          c.last_activity_at,
          COALESCE(c.tags, '[]'::jsonb) AS tags,
          c.created_at,
          COALESCE(c.priority, 'medium') AS priority,
          COALESCE(c.source, 'manual') AS source,
          c.fit_score,
          c.linkedin_url,
          c.avatar_url,
          c.assigned_to, c.next_follow_up_at, COALESCE(c.updated_at, l.updated_at) AS updated_at,
          COALESCE(stage_changes.entered_at, c.created_at, l.created_at) AS stage_entered_at,
          c.business_category_name
        FROM crm_contacts c
        LEFT JOIN leads l ON l.id = c.lead_id
        LEFT JOIN stage_changes ON stage_changes.contact_id = c.id
        WHERE c.user_id = ${userId}
          AND c.deleted_at IS NULL
          AND (c.lead_id IS NULL OR l.id IS NULL OR l.deleted_at IS NOT NULL)
      )
`;
}

type ImportIssue = {
  row: number;
  type: 'duplicate' | 'skipped' | 'error' | 'warning';
  message: string;
};

export interface ContactTransition {
  updated: typeof crmContactsTable.$inferSelect;
  oldStatus: string;
  stage: CrmConfiguration['stages'][number];
  changed: boolean;
}

// Shared by virtual-contact materialization and every inbound channel. Keeping
// identity discovery, provisioning and association under the same lock prevents
// two different temporary leads from racing to create the canonical contact.
export async function lockCrmContactResolution(tx: any, userId: number) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('crm-contact-resolution'), ${userId})`);
}

async function canonicalContactForChannelLead(tx: any, userId: number, leadId: number) {
  const linked = await tx.select({ contact: crmContactsTable }).from(outreachConversationsTable)
    .innerJoin(crmContactsTable, and(
      eq(crmContactsTable.id, outreachConversationsTable.crmContactId),
      eq(crmContactsTable.userId, userId), isNull(crmContactsTable.deletedAt),
    )).where(and(eq(outreachConversationsTable.userId, userId), eq(outreachConversationsTable.leadId, leadId)));
  if (linked.length) return linked.every((row: any) => row.contact.id === linked[0].contact.id) ? linked[0].contact : null;
  const retired = (await tx.execute(sql`SELECT target.id FROM crm_contacts source
    JOIN crm_contacts target ON target.id = source.merged_into_contact_id AND target.user_id = source.user_id
      AND target.business_profile_id IS NOT DISTINCT FROM source.business_profile_id AND target.deleted_at IS NULL
    WHERE source.user_id = ${userId} AND source.lead_id = ${leadId} AND source.deleted_at IS NOT NULL`)).rows;
  if (!retired.length || !retired.every((row: any) => row.id === retired[0].id)) return null;
  return (await tx.select().from(crmContactsTable).where(and(
    eq(crmContactsTable.id, retired[0].id), eq(crmContactsTable.userId, userId), isNull(crmContactsTable.deletedAt),
  )).limit(1))[0] || null;
}

async function resolveMergedContact(tx: any, userId: number, contactId: number) {
  const row = (await tx.execute(sql`SELECT target.id FROM crm_contacts source
    JOIN crm_contacts target ON target.id = source.merged_into_contact_id AND target.user_id = source.user_id
      AND target.business_profile_id IS NOT DISTINCT FROM source.business_profile_id AND target.deleted_at IS NULL
    WHERE source.id = ${contactId} AND source.user_id = ${userId} AND source.deleted_at IS NOT NULL`)).rows[0];
  return row ? (await tx.select().from(crmContactsTable).where(and(
    eq(crmContactsTable.id, row.id), eq(crmContactsTable.userId, userId), isNull(crmContactsTable.deletedAt),
  )).limit(1))[0] || null : null;
}

async function reconcileContactPhone(tx: any, userId: number, contact: any, conversationId: number | null = null, stagedDuplicate = false) {
  if (!contact) return null;
  const canonicalId = await mergeContactByPhone(tx, userId, contact.id, contact.phone, conversationId, stagedDuplicate);
  if (canonicalId === contact.id) return contact;
  return (await tx.select().from(crmContactsTable).where(and(
    eq(crmContactsTable.id, canonicalId), eq(crmContactsTable.userId, userId), isNull(crmContactsTable.deletedAt),
  )).limit(1))[0] || null;
}

async function insertCrmContact(tx: any, userId: number, values: any) {
  const phone = normalizedContactPhone(values.phone);
  const fingerprint = phone ? contactPhoneFingerprint(userId, phone) : null;
  const businessProfileId=values.businessProfileId ?? requireBusinessScope().businessProfileId;
  const prior = phone ? (await tx.execute(sql`SELECT candidate.id FROM crm_contacts candidate
    WHERE candidate.user_id = ${userId} AND candidate.deleted_at IS NULL
      AND candidate.business_profile_id IS NOT DISTINCT FROM COALESCE(${values.businessProfileId ?? null}::integer, app_business_profile_id())
      AND candidate.id IN (${contactPhoneCandidateIds(userId,businessProfileId,phone!,fingerprint)})
      AND (candidate.phone_lookup_digits = ${phone}
        OR EXISTS (SELECT 1 FROM crm_contact_channel_identities identity WHERE identity.contact_id=candidate.id
          AND identity.user_id=${userId} AND identity.business_profile_id IS NOT DISTINCT FROM candidate.business_profile_id
          AND identity.identifier_type='phone' AND identity.identifier_fingerprint=${fingerprint}
          AND identity.verification_level IN ('provider','customer_verified','owner_verified'))) LIMIT 2`)).rows : [];
  const virtual = phone && !prior.length ? (await tx.execute(sql`SELECT lead.id FROM leads lead
    WHERE lead.user_id = ${userId} AND lead.deleted_at IS NULL
      AND lead.business_profile_id IS NOT DISTINCT FROM COALESCE(${values.businessProfileId ?? null}::integer, app_business_profile_id())
      AND lead.id IS DISTINCT FROM ${values.leadId ?? null}::integer
      AND lead.phone_lookup_digits = ${phone}
      AND NOT EXISTS (SELECT 1 FROM crm_contacts contact WHERE contact.user_id=lead.user_id
        AND contact.business_profile_id IS NOT DISTINCT FROM lead.business_profile_id AND contact.lead_id=lead.id)
      AND NOT EXISTS (SELECT 1 FROM outreach_conversations conversation WHERE conversation.user_id=lead.user_id
        AND conversation.business_profile_id IS NOT DISTINCT FROM lead.business_profile_id
        AND conversation.lead_id=lead.id AND conversation.crm_contact_id IS NOT NULL) LIMIT 2`)).rows : [];
  // A duplicate must not consume a temporary extra slot at the contact cap.
  // Its retired row preserves the original lead/reference and merge evidence.
  const staged = prior.length === 1 || virtual.length === 1;
  const [inserted] = await tx.insert(crmContactsTable).values({ ...values, ...(staged ? { deletedAt: new Date() } : {}) }).returning();
  const result = await reconcileContactPhone(tx, userId, inserted, null, staged);
  if (staged && result?.id === inserted.id) {
    const [active] = await tx.update(crmContactsTable).set({ deletedAt: null })
      .where(and(eq(crmContactsTable.id, inserted.id), eq(crmContactsTable.userId, userId))).returning();
    return active;
  }
  return result;
}

async function pauseProposalFollowupsForInboundReply(tx: typeof db, userId: number, conversationId: number) {
  const result = await tx.execute(sql`
    UPDATE proposal_reminders AS reminder
    SET status = 'paused',
        last_sent_at = NULL,
        metadata = (COALESCE(reminder.metadata, '{}'::jsonb) - 'resumedAt')
          || jsonb_build_object('pauseReason', 'customer_reply', 'pausedAt', NOW()),
        updated_at = NOW()
    FROM proposals AS proposal
    WHERE reminder.user_id = ${userId}
      AND proposal.user_id = ${userId}
      AND proposal.id = reminder.proposal_id
      AND proposal.outreach_conversation_id = ${conversationId}
      AND proposal.status IN ('sent', 'viewed')
      AND reminder.reminder_type = 'customer_followup'
      AND reminder.status IN ('pending', 'snoozed')
  `);
  if ((result.rowCount ?? 0) > 0) {
    logger.info(
      { userId, conversationId, paused: result.rowCount },
      '[CRMService] Paused proposal follow-ups after an inbound customer reply',
    );
  }
}

export interface InboundContactOptions {
  source?: string;
  channel?: string;
  recordReply?: boolean;
  contactId?: number;
  conversationId?: number;
  messageId?: number;
  providerMessageId?: string;
}

class CRMService {
  private static instance: CRMService;

  static getInstance(): CRMService {
    if (!this.instance) this.instance = new CRMService();
    return this.instance;
  }

  async autoCreateContactOnOutreachSend(
    userId: number,
    leadId: number,
    options?: { sourceCampaignId?: number; source?: string }
  ) {
    try {
      const contact = await this.materializeContactReference(
        userId,
        -Math.abs(leadId),
        options?.source || 'outreach',
      );
      if (!contact) {
        logger.warn({ leadId }, 'Lead not found for CRM contact creation');
        return null;
      }

      const now = new Date();
      const configuration = await getCrmConfiguration(userId);
      const contactedStage = configuration.stages.find(stage => stage.key === 'contacted' && stage.type === 'active')
        || configuration.stages.find(stage => stage.type === 'active');
      const [updated] = await db.update(crmContactsTable)
        .set({
        status: sql`CASE WHEN ${crmContactsTable.status} = 'new' THEN 'contacted' ELSE ${crmContactsTable.status} END`,
        pipelineStatus: sql`CASE WHEN ${crmContactsTable.pipelineStatus} = 'new'
          THEN ${contactedStage?.key || 'new'} ELSE ${crmContactsTable.pipelineStatus} END`,
        totalOutreachSent: sql`COALESCE(${crmContactsTable.totalOutreachSent}, 0) + 1`,
        firstContactedAt: sql`COALESCE(${crmContactsTable.firstContactedAt}, ${now})`,
        lastContactedAt: now,
        lastActivityAt: now,
        updatedAt: now,
        ...(options?.sourceCampaignId && { sourceCampaignId: options.sourceCampaignId }),
      })
        .where(and(eq(crmContactsTable.id, contact.id), eq(crmContactsTable.userId, userId)))
        .returning();

      if (!updated) return null;
      await this.addActivity(userId, contact.id, 'outreach_sent', 'Outreach sent', null, {
        leadId,
        source: options?.source,
      });

      logger.info({ userId, contactId: contact.id, leadId }, 'CRM contact auto-created on outreach send');
      return updated;
    } catch (error) {
      logger.error({ err: error, userId, leadId }, 'Failed to auto-create CRM contact');
      throw error;
    }
  }

  async updateContactStatus(userId: number, contactId: number, status: string, _metadata?: Record<string, unknown>) {
    const [updated] = await db.update(crmContactsTable)
      .set({ status, updatedAt: new Date() })
      .where(and(eq(crmContactsTable.id, contactId), eq(crmContactsTable.userId, userId)))
      .returning();
    if (updated) {
      await this.syncStatusToLead(updated.userId, contactId, status, updated.pipelineStatus || undefined);
    }
    return updated;
  }

  async updateContactStatusBySentiment(userId: number, contactId: number, sentiment: string, score: number) {
    const [contact] = await db.select().from(crmContactsTable)
      .where(and(eq(crmContactsTable.id, contactId), eq(crmContactsTable.userId, userId)))
      .limit(1);

    if (!contact) return null;

    // Sentiment is engagement evidence, not a configured stage transition.
    const newStatus = contact.status;

    const [updated] = await db.update(crmContactsTable)
      .set({
        sentimentScore: score,
        lastSentimentAnalysisAt: new Date(),
        totalReplies: sql`${crmContactsTable.totalReplies} + 1`,
        lastActivityAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(crmContactsTable.id, contactId), eq(crmContactsTable.userId, userId)))
      .returning();

    return { contact: updated, oldStatus: contact.status, newStatus };
  }

  async getContacts(userId: number, filters: Partial<CrmContactFilters> = {}, executor: any = db) {
    const limit = Math.min(Math.max(filters.limit || 20, 1), 500);
    const page = Math.max(filters.page || 1, 1);
    const offset = filters.offset ?? (page - 1) * limit;
    const configuration = await getCrmConfiguration(userId,executor);
    const scope = requireBusinessScope();
    // Use one UTC instant for list and count, including the exact due boundary.
    const followupNow = new Date().toISOString();
    const conditions: SQL[] = [sql`base.user_id = ${userId}`];
    if (filters.status) conditions.push(sql`base.status = ${filters.status}`);
    if (filters.pipelineStatus) conditions.push(sql`base.pipeline_status = ${filters.pipelineStatus}`);
    if (filters.priority) conditions.push(sql`base.priority = ${filters.priority}`);
    if (filters.tag) conditions.push(sql`base.tags ? ${filters.tag}`);
    const assignedTo = filters.assignedTo ?? filters.ownerUserId;
    if (assignedTo === 'unassigned') conditions.push(sql`base.assigned_to IS NULL`);
    else if (assignedTo) conditions.push(sql`base.assigned_to = ${assignedTo}`);
    if (filters.followup === 'overdue' || filters.needsFollowUp) conditions.push(sql`base.followup_due_at < ${followupNow}::timestamp`);
    if (filters.followup === 'upcoming') conditions.push(sql`base.followup_due_at >= ${followupNow}::timestamp`);
    if (filters.followup === 'none') conditions.push(sql`base.followup_due_at IS NULL`);
    if (filters.search) {
      const pattern = `%${filters.search.replace(/[\\%_]/g, '\\$&')}%`;
      conditions.push(sql`(base.first_name ILIKE ${pattern} OR base.last_name ILIKE ${pattern}
        OR base.display_name ILIKE ${pattern} OR base.email ILIKE ${pattern} OR base.phone ILIKE ${pattern} OR base.company ILIKE ${pattern})`);
    }
    // Board/list defaults remain all-time/all-channel. Reporting drilldowns opt in explicitly.
    if (filters.dateRange || filters.from || filters.to || filters.dateStart || filters.dateEnd) {
      const bounds = crmDateBounds(configuration.preferences, filters);
      if (bounds.from) conditions.push(sql`base.created_at >= ${bounds.from}`);
      if (bounds.to) conditions.push(sql`base.created_at < ${bounds.to}`);
    }
    if (filters.platforms || filters.platform) {
      const platforms = crmReportPlatforms(configuration, filters);
      if (!platforms.includes('all')) conditions.push(sql`EXISTS (SELECT 1 FROM outreach_conversations platform
        WHERE platform.user_id=${userId} AND platform.channel=ANY(${sql.param(platforms)}::text[])
          AND (platform.crm_contact_id=base.crm_contact_id OR (platform.crm_contact_id IS NULL AND platform.lead_id=base.lead_id)))`);
    }
    if (filters.threadId) {
      await assertOwnedCampaignThread(userId, filters.threadId,executor);
      conditions.push(sql`(EXISTS (SELECT 1 FROM campaign_crm_contacts link
        WHERE link.user_id=${userId} AND link.contact_id=base.id AND link.thread_id=${filters.threadId}) OR base.lead_id IN (
        ${threadLeadIds(userId, scope.businessProfileId, filters.threadId)}))`);
    }
    const sortColumns: Record<string, SQL> = {
      lastActivityAt: sql`base.last_activity_at`, createdAt: sql`base.created_at`,
      name: sql`LOWER(COALESCE(base.display_name,base.email,''))`, dealValue: sql`base.deal_value`,
      priority: sql`CASE base.priority WHEN 'high' THEN 3 WHEN 'medium' THEN 2 ELSE 1 END`, nextFollowUpAt: sql`base.followup_due_at`,
    };
    const order = sql`${sortColumns[filters.sortBy || 'lastActivityAt']} ${filters.sortOrder === 'asc' ? sql`ASC` : sql`DESC`} NULLS LAST, base.id ASC`;
    const where = sql.join(conditions, sql` AND `);
    // Legacy delivery transitions could clear the persisted contact snapshot.
    // Resolve open work on read, just like My Work and contact detail, so those
    // contacts need no backfill. One aggregate row per contact preserves totals.
    const cte = sql`${crmVisibleContactsCte(userId, configuration)}, followups AS MATERIALIZED (
      SELECT reminder.contact_id, MIN(COALESCE(reminder.snoozed_until,reminder.reminder_due_at)) AS due_at
      FROM crm_activity_reminders reminder
      WHERE reminder.user_id=${userId} AND reminder.business_profile_id=${scope.businessProfileId}
        AND reminder.contact_id IS NOT NULL AND reminder.status NOT IN ('completed','cancelled')
      GROUP BY reminder.contact_id
    ), collection AS (
      SELECT base.*, followups.due_at AS followup_due_at FROM base
      LEFT JOIN followups ON followups.contact_id=base.crm_contact_id
    )`;
    const [dataResult, totalsResult] = await Promise.all([
      executor.execute(sql`${cte} SELECT base.id, base.lead_id, base.crm_contact_id,
        base.first_name AS "firstName",base.last_name AS "lastName",base.email,base.phone,base.company,base.role,
        base.status,base.pipeline_status AS "pipelineStatus",base.last_sentiment_status AS "lastSentimentStatus",
        base.deal_value::text AS "dealValue",base.currency,base.sentiment_score AS "sentimentScore",
        base.total_outreach_sent AS "totalOutreachSent",base.last_activity_at AS "lastActivityAt",base.tags,
        base.created_at AS "createdAt",base.updated_at AS "updatedAt",base.priority,base.source,
        base.fit_score AS "fitScore",base.linkedin_url AS "linkedinUrl",base.avatar_url AS "avatarUrl",
        base.assigned_to AS "assignedTo",base.followup_due_at AS "nextFollowUpAt",base.stage_entered_at AS "stageEnteredAt",
        base.business_category_name AS "businessCategoryName"
        FROM collection base WHERE ${where} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`),
      executor.execute(sql`${cte} SELECT base.pipeline_status,base.currency, COUNT(*)::int AS count,COALESCE(SUM(base.deal_value),0)::text AS value
        FROM collection base WHERE ${where} GROUP BY base.pipeline_status,base.currency`),
    ]);
    const totals = totalsResult.rows as Array<{ pipeline_status: string; currency: string; count: number; value: string }>;
    const total = totals.reduce((sum,row) => sum + row.count, 0);
    const dealValueByCurrency: Record<string,string> = {};
    for (const row of totals) dealValueByCurrency[row.currency || 'USD'] = (Number(dealValueByCurrency[row.currency || 'USD'] || 0) + Number(row.value)).toFixed(2);
    const stages = crmStagesForStatuses(configuration.stages, totals.map(row => row.pipeline_status)).map(stage => {
      const rows = totals.filter(row => row.pipeline_status === stage.key);
      return { ...stage, count: rows.reduce((sum,row) => sum + row.count,0),
        dealValueByCurrency: Object.fromEntries(rows.map(row => [row.currency || 'USD',row.value])) };
    });
    return { contacts: ((dataResult.rows || []) as Array<Record<string,unknown>>).map((contact: any) => ({ ...contact,
      ...Object.fromEntries(['createdAt','updatedAt','lastActivityAt','nextFollowUpAt','stageEnteredAt'].map(key => [key,serializeUtcTimestamp(contact[key])])),
    })), total, page, limit, totalPages: Math.ceil(total / limit),
      dealValueByCurrency, stages };
  }

  async getContactById(userId: number, contactId: number) {
    if (!Number.isSafeInteger(contactId) || contactId === 0) return null;

    const virtualLeadId = contactId < 0 ? Math.abs(contactId) : null;

    // Positive references are authoritative CRM contact IDs.
    const [crmContact] = await db.select().from(crmContactsTable)
      .where(and(
        eq(crmContactsTable.id, contactId),
        eq(crmContactsTable.userId, userId),
        isNull(crmContactsTable.deletedAt),
      ))
      .limit(1);
    if (crmContact) return crmContact;
    if (contactId > 0) {
      const merged = await resolveMergedContact(db, userId, contactId);
      if (merged) return merged;
      const [deleted] = await db.select({ id: crmContactsTable.id }).from(crmContactsTable).where(and(
        eq(crmContactsTable.id, contactId), eq(crmContactsTable.userId, userId), isNotNull(crmContactsTable.deletedAt),
      )).limit(1);
      if (deleted) return null;
    }

    // Backward-compatible positive lead references are still accepted when
    // they do not collide with a real CRM contact.
    const leadId = virtualLeadId || contactId;
    const [lead] = await db.select({ id: leadsTable.id }).from(leadsTable)
      .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId), isNull(leadsTable.deletedAt))).limit(1);
    if (!lead) return null;
    // Channel leads may alias a CRM-only or another canonical lead's contact.
    // Honor that association before falling back to historical lead-backed rows.
    const canonicalContact = await canonicalContactForChannelLead(db, userId, leadId);
    if (canonicalContact) return canonicalContact;
    const [linkedContact] = await db.select().from(crmContactsTable)
      .where(and(eq(crmContactsTable.userId, userId), eq(crmContactsTable.leadId, leadId), isNull(crmContactsTable.deletedAt))).limit(1);
    if (linkedContact) return linkedContact;
    const configuration = await getCrmConfiguration(userId);
    const virtual = virtualLeadCrmState(configuration, sql`oc_agg.conversation_count > 0`);
    const leadResult = await db.execute(sql`
      WITH oc_agg AS (
        SELECT lead_id, COUNT(*)::int AS conversation_count
        FROM outreach_conversations
        WHERE user_id = ${userId}
        GROUP BY lead_id
      )
      SELECT
        -l.id AS id,
        l.id AS lead_id,
        NULL::int AS crm_contact_id,
        COALESCE(l.first_name, l.name) AS "firstName",
        l.last_name AS "lastName",
        l.email AS email,
        l.phone AS phone,
        COALESCE(l.company, l.company_name) AS company,
        l.role AS role,
        ${virtual.status} AS status,
        ${virtual.stage} AS "pipelineStatus",
        NULL AS "lastSentimentStatus",
        NULL AS "dealValue",
        NULL::real AS "sentimentScore",
        0 AS "totalOutreachSent",
        l.updated_at AS "lastActivityAt",
        '[]'::jsonb AS tags,
        l.created_at AS "createdAt",
        l.updated_at AS "updatedAt",
        'medium' AS priority,
        l.source AS source,
        l.fit_score AS "fitScore",
        l.linkedin_url AS "linkedinUrl",
        l.profile_picture AS "avatarUrl",
        NULL AS notes,
        NULL::int AS "assignedTo",
        NULL::int AS "totalReplies",
        NULL::int AS "totalMeetings",
        NULL::timestamp AS "firstContactedAt",
        NULL::timestamp AS "lastContactedAt",
        NULL::timestamp AS "nextFollowUpAt",
        NULL::timestamp AS "deletedAt",
        'USD' AS currency,
        NULL::int AS "sourceCampaignId",
        NULL::timestamp AS "lastSentimentAnalysisAt",
        NULL AS "icpTier",
        NULL AS website,
        l.business_category_name AS "businessCategoryName"
      FROM leads l
      LEFT JOIN oc_agg ON oc_agg.lead_id = l.id
      WHERE l.id = ${leadId}
        AND l.user_id = ${userId}
        AND l.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1
          FROM crm_contacts deleted_contact
          WHERE deleted_contact.user_id = ${userId}
            AND deleted_contact.lead_id = l.id
            AND deleted_contact.deleted_at IS NOT NULL
        )
      LIMIT 1
    `);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const virtualContact = (leadResult.rows as any)?.[0];
    return virtualContact ? { ...virtualContact,...Object.fromEntries(['createdAt','updatedAt','lastActivityAt'].map(key=>[key,serializeUtcTimestamp(virtualContact[key])])) } : null;
  }

  /**
   * Resolve a CRM/virtual-lead reference to a persisted contact. Writes use a
   * transaction-scoped advisory lock so concurrent requests cannot create two
   * active CRM contacts for the same user and lead.
   */
  async materializeContactReference(userId: number, contactId: number, source = 'crm', transaction?: any) {
    if (!Number.isSafeInteger(contactId) || contactId === 0) return null;

    const leadId = Math.abs(contactId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const materialize = async (tx: any) => {
      await lockCrmContactResolution(tx, userId);
      if (contactId > 0) {
        const [existingById] = await tx.select().from(crmContactsTable)
          .where(and(
            eq(crmContactsTable.id, contactId),
            eq(crmContactsTable.userId, userId),
            isNull(crmContactsTable.deletedAt),
          ))
          .limit(1);
        if (existingById) return existingById;
        const merged = await resolveMergedContact(tx, userId, contactId);
        if (merged) return merged;
        const [deleted] = await tx.select({ id: crmContactsTable.id }).from(crmContactsTable).where(and(
          eq(crmContactsTable.id, contactId), eq(crmContactsTable.userId, userId), isNotNull(crmContactsTable.deletedAt),
        )).limit(1);
        if (deleted) return null;
      }

      const [lead] = await tx.select().from(leadsTable)
        .where(and(
          eq(leadsTable.id, leadId),
          eq(leadsTable.userId, userId),
          isNull(leadsTable.deletedAt),
        ))
        .limit(1);
      if (!lead) return null;

      const linkedContact = await canonicalContactForChannelLead(tx, userId, leadId);
      if (linkedContact) return linkedContact;
      const [existingByLead] = await tx.select().from(crmContactsTable)
        .where(and(
          eq(crmContactsTable.userId, userId),
          eq(crmContactsTable.leadId, leadId),
          isNull(crmContactsTable.deletedAt),
        ))
        .limit(1);
      if (existingByLead) return reconcileContactPhone(tx, userId, existingByLead);
      // A stale UI/API reference cannot implicitly restore an intentionally deleted contact.
      // Merge redirects were resolved above; only deliberate deletion markers block materialization.
      const [tombstone] = await tx.select({ id: crmContactsTable.id }).from(crmContactsTable).where(and(
        eq(crmContactsTable.userId, userId), isNotNull(crmContactsTable.deletedAt), isNull(crmContactsTable.mergedIntoContactId),
        or(eq(crmContactsTable.leadId, leadId), contactId > 0 ? eq(crmContactsTable.id, contactId) : undefined),
      )).limit(1);
      if (tombstone) return null;

      const conversationResult = await tx.execute(sql`
        SELECT EXISTS(
          SELECT 1 FROM outreach_conversations
          WHERE user_id = ${userId} AND lead_id = ${leadId}
        ) AS has_conversation
      `);
      const hasConversation = Boolean((conversationResult.rows as Array<{ has_conversation?: boolean }>)[0]?.has_conversation);
      const configuration = await getCrmConfiguration(userId, tx);
      const leadStatus = String(lead.status || '').toLowerCase();
      const derivedStage = (leadStatus === 'converted' || leadStatus === 'won'
        ? crmStageForOutcome(configuration.stages, 'won')
        : leadStatus === 'lost' || leadStatus === 'rejected' ? crmStageForOutcome(configuration.stages, 'lost')
          : leadStatus !== 'new' ? resolveCrmStageReference(configuration.stages, leadStatus) : undefined)
        || (hasConversation ? configuration.stages.find(stage => stage.type === 'active') : undefined)
        || configuration.stages[0];

      const created = await insertCrmContact(tx, userId, {
        userId,
        leadId,
        firstName: lead.firstName || null,
        lastName: lead.lastName || null,
        email: lead.email || null,
        phone: lead.phone || null,
        company: lead.company || lead.companyName || null,
        role: lead.role || null,
        linkedinUrl: lead.linkedinUrl || null,
        website: lead.website || null,
        avatarUrl: lead.profilePicture || null,
        businessCategoryId: lead.businessCategoryId || null,
        businessCategoryName: lead.businessCategoryName || null,
        status: crmContactStatusForStage(derivedStage, lead.status),
        pipelineStatus: derivedStage.key,
        priority: 'medium',
        source, createdAt: lead.createdAt || new Date(), updatedAt: lead.updatedAt || new Date(),
        lastActivityAt: lead.updatedAt || lead.createdAt || new Date(),
      });

      return reconcileContactPhone(tx, userId, created);
    };
    return transaction ? materialize(transaction) : db.transaction(materialize);
  }

  async createContact(userId: number, data: {
    chatThreadId?: number;
    name?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    phone?: string;
    company?: string;
    role?: string;
    status?: string;
    priority?: string;
    notes?: string;
    tags?: string[];
    pipelineStatus?: string;
    dealValue?: string | null;
    currency?: string;
    assignedTo?: number | null;
    ownerUserId?: number | null;
    nextFollowUpAt?: Date | string | null;
  }, request?: { key: string }) {
    const now = new Date();
    const nameParts = data.name?.trim().split(/\s+/).filter(Boolean) || [];
    const firstName = data.firstName || nameParts[0] || null;
    const lastName = data.lastName || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : null);
    // Resolve business category from user's business profile
    const catInfo = await LeadModel.resolveBusinessCategory({ userId });
    let transition: ContactTransition | undefined;
    const created = await db.transaction(async (tx: any) => {
      const configuration = await getCrmConfiguration(userId, tx, true);
      const stage = data.pipelineStatus ? resolveCrmStageReference(configuration.stages, data.pipelineStatus)
        : data.status ? resolveCrmStageReference(configuration.stages, data.status) : undefined;
      if (data.pipelineStatus && !stage) throw new CrmConfigurationError('Choose a stage from the saved CRM configuration.', 400);
      const assignedTo = data.assignedTo !== undefined ? data.assignedTo : data.ownerUserId;
      await validateCrmAssignee(userId, assignedTo, tx);
      await lockCrmContactResolution(tx, userId);
      const scope = requireBusinessScope();
      const receiptKey = request ? `crm-create:${scope.businessProfileId}:${scope.actorUserId || userId}:${request.key}` : undefined;
      const requestHash = request ? setupRequestHash(JSON.parse(JSON.stringify(data))) : undefined;
      if (receiptKey) {
        const [receipt] = await tx.select().from(crmActivitiesTable).where(and(
          eq(crmActivitiesTable.userId, userId), eq(crmActivitiesTable.businessProfileId, scope.businessProfileId),
          eq(crmActivitiesTable.idempotencyKey, receiptKey),
        )).limit(1);
        if (receipt) {
          if (receipt.metadata?.requestHash !== requestHash) throw new CrmConfigurationError('This request key was already used for different contact details.', 409);
          const [existing] = await tx.select().from(crmContactsTable).where(and(
            eq(crmContactsTable.id, receipt.contactId), eq(crmContactsTable.userId, userId), isNull(crmContactsTable.deletedAt),
          )).limit(1);
          if (!existing) throw new CrmConfigurationError('The contact created by this request is no longer available.', 410);
          return { ...existing, creationReplayed: true };
        }
      }
      if (data.chatThreadId) await assertOwnedCampaignThread(userId, data.chatThreadId, tx);
      const contact = await insertCrmContact(tx, userId, {
        userId,
        firstName,
        lastName,
        email: data.email || null,
        phone: data.phone || null,
        company: data.company || null,
        role: data.role || null,
        status: stage ? crmContactStatusForStage(stage, data.status) : data.status || 'new',
        pipelineStatus: stage?.key || configuration.stages[0].key,
        priority: data.priority || 'medium',
        notes: data.notes || null,
        tags: data.tags || [],
        dealValue: data.dealValue ?? null,
        currency: data.currency || 'USD',
        assignedTo: assignedTo ?? null,
        nextFollowUpAt: data.nextFollowUpAt ? new Date(data.nextFollowUpAt) : null,
        source: 'manual',
        lastActivityAt: now,
        ...(catInfo.businessCategoryId && {
          businessCategoryId: catInfo.businessCategoryId,
          businessCategoryName: catInfo.businessCategoryName,
        }),
      });
      let canonical = await reconcileContactPhone(tx, userId, contact);
      if (!canonical) throw new Error('Failed to resolve the newly created CRM contact.');
      {
        const fields = ['dealValue', 'currency', 'nextFollowUpAt'] as const;
        const patch: Record<string, unknown> = Object.fromEntries(fields.filter(key => data[key] !== undefined).map(key => [key, data[key]]));
        if (assignedTo !== undefined) patch.assignedTo = assignedTo;
        if (stage && (data.pipelineStatus !== undefined || data.status !== undefined)) patch.pipelineStatus = stage.key;
        if (Object.keys(patch).length) {
          const applied = await this.commitContactUpdate(userId, canonical.id, patch, tx, configuration);
          if (!applied) throw new Error('The matched contact is no longer available.');
          canonical = applied.updated;
          transition = applied.transition;
        }
      }
      if (data.chatThreadId) await associateCampaignContact(tx, userId, canonical.id, data.chatThreadId);
      if (receiptKey) await tx.insert(crmActivitiesTable).values({
        userId, businessProfileId: scope.businessProfileId, contactId: canonical.id, type: 'contact_created',
        subject: 'Contact created', idempotencyKey: receiptKey,
        metadata: { source: 'crm', actorUserId: scope.actorUserId || userId, requestHash },
      });
      return canonical;
    });
    if (transition) await this.publishContactTransition(userId, transition);
    return created;
  }

  async updateContact(userId: number, contactId: number, updates: Partial<{
    name: string; firstName: string; lastName: string; email: string | null; phone: string | null;
    company: string | null; role: string | null; status: string; priority: string;
    assignedTo: number | null; ownerUserId: number | null; tags: string[]; notes: string | null;
    dealValue: string | null; currency: string; nextFollowUpAt: Date | string | null;
    pipelineStatus: string; expectedUpdatedAt: Date | string;
  }>, context?: { automation?: boolean; recoverableAutomation?: boolean | 'pipeline' }) {
    const result = await db.transaction(async (tx: any) => {
      if (context?.automation) await tx.execute(sql`SELECT set_config('app.crm_automation_origin','automation',true)`);
      // Keep lock order consistent with configuration saves and pipeline edits.
      const configuration = await getCrmConfiguration(userId, tx, Boolean(updates.pipelineStatus));
      await validateCrmAssignee(userId, updates.assignedTo !== undefined ? updates.assignedTo : updates.ownerUserId, tx);
      return this.commitContactUpdate(userId, contactId, updates, tx, configuration, context?.recoverableAutomation);
    });
    if (result?.transition) await this.publishContactTransition(userId, result.transition);
    return result?.updated || null;
  }

  private async commitContactUpdate(userId: number, contactId: number, updates: Record<string, any>, tx: any,
    configuration: CrmConfiguration, recoverableAutomation: boolean | 'pipeline' = false) {
    const scope = requireBusinessScope();
    await lockCrmContactResolution(tx, userId);
    const contact = await this.materializeContactReference(userId, contactId, 'crm_update', tx);
    if (!contact) return null;
    const canonical = await resolveMergedContact(tx, userId, contact.id);
    const [current] = await tx.select().from(crmContactsTable).where(and(
      eq(crmContactsTable.id, canonical?.id || contact.id), eq(crmContactsTable.userId, userId),
      eq(crmContactsTable.businessProfileId, scope.businessProfileId), isNull(crmContactsTable.deletedAt),
    )).limit(1).for('update');
    if (!current) return null;
    if (updates.expectedUpdatedAt !== undefined && serializeUtcTimestamp(updates.expectedUpdatedAt) !== serializeUtcTimestamp(current.updatedAt))
      throw new CrmConfigurationError('This contact was changed by someone else. Reload it before saving.', 409);
    const { name: _name, pipelineStatus, expectedUpdatedAt: _version, ownerUserId, ...fields } = updates;
    if (typeof _name === 'string' && fields.firstName === undefined && fields.lastName === undefined) {
      const names = _name.trim().split(/\s+/);
      fields.firstName = names[0] || null;
      fields.lastName = names.slice(1).join(' ') || null;
    }
    if (ownerUserId !== undefined && fields.assignedTo === undefined) fields.assignedTo = ownerUserId;
    if (fields.nextFollowUpAt && typeof fields.nextFollowUpAt === 'string') fields.nextFollowUpAt = new Date(fields.nextFollowUpAt);
    const requested = pipelineStatus === undefined ? undefined : resolveCrmStageReference(configuration.stages, pipelineStatus);
    if (pipelineStatus !== undefined && !requested && pipelineStatus !== current.pipelineStatus)
      throw new CrmConfigurationError('Choose a stage from the saved CRM configuration.', 400);
    const [saved] = await tx.update(crmContactsTable).set({ ...fields, updatedAt: new Date() })
      .where(and(eq(crmContactsTable.id, current.id), eq(crmContactsTable.userId, userId), isNull(crmContactsTable.deletedAt))).returning();
    if (!saved) return null;
    const leadFields = ['firstName', 'lastName', 'email', 'phone', 'company', 'role', 'website', 'linkedinUrl'] as const;
    const leadUpdates = Object.fromEntries(leadFields.filter(key => key in fields).map(key => [key, fields[key]]));
    if ('firstName' in fields || 'lastName' in fields) {
      const name = [saved.firstName, saved.lastName].filter(Boolean).join(' ') || saved.email || null;
      leadUpdates.name = name;
      leadUpdates.fullName = name;
    }
    if (Object.keys(leadUpdates).length && saved.leadId) await tx.update(leadsTable)
      .set({ ...leadUpdates, updatedAt: new Date() }).where(and(eq(leadsTable.id, saved.leadId),
        eq(leadsTable.userId, userId), isNull(leadsTable.deletedAt)));
    let updated = await reconcileContactPhone(tx, userId, saved);
    if (!updated) return null;
    let automationTransitionId: number | undefined;
    let recovery: Record<string, unknown> | undefined;
    let transition: { updated: any; oldStatus: string; stage: CrmConfiguration['stages'][number]; changed: boolean } | undefined;
    if (requested) {
      const oldStatus = updated.pipelineStatus || 'new';
      const oldStage = configuration.stages.find(stage => stage.key === oldStatus);
      const status = crmContactStatusForStage(requested, updated.status);
      const changed = oldStatus !== requested.key;
      if (changed || updated.status !== status) [updated] = await tx.update(crmContactsTable).set({
        pipelineStatus: requested.key, status, lastActivityAt: new Date(), updatedAt: new Date(),
      }).where(and(eq(crmContactsTable.id, updated.id), eq(crmContactsTable.userId, userId),
        eq(crmContactsTable.businessProfileId, scope.businessProfileId), isNull(crmContactsTable.deletedAt))).returning();
      await this.syncStatusToLead(userId, updated.id, status, requested.key, tx, configuration);
      recovery = await this.contactAutomationCheckpoint(tx, current, updated, recoverableAutomation);
      if (changed) {
      const [activity] = await tx.insert(crmActivitiesTable).values({
        userId, businessProfileId: scope.businessProfileId, contactId: updated.id, type: 'pipeline_change',
        subject: `Pipeline: ${oldStage?.label || oldStatus} → ${requested.label}`,
        metadata: { oldStatus, newStatus: requested.key, oldStageName: oldStage?.label || oldStatus,
          newStageName: requested.label, stageType: requested.type, source: 'crm', actorUserId: scope.actorUserId || userId,
          dealValueSnapshot: updated.dealValue, currencySnapshot: updated.currency, ...(recovery ? { automationHandoff: recovery } : {}) },
      }).returning({ id: crmActivitiesTable.id });
      if (recovery) automationTransitionId = activity.id;
      }
      transition = { updated, oldStatus, stage: requested, changed };
    } else if (fields.status) await this.syncStatusToLead(userId, updated.id, updated.status || 'new', updated.pipelineStatus, tx, configuration);
    const changedFields = Object.keys(fields).filter(key => JSON.stringify(current[key]) !== JSON.stringify(fields[key]));
    recovery ||= await this.contactAutomationCheckpoint(tx, current, updated, recoverableAutomation);
    if (changedFields.length) {
    const [activity] = await tx.insert(crmActivitiesTable).values({
      userId, businessProfileId: scope.businessProfileId, contactId: updated.id, type: 'contact_updated',
      subject: 'Contact details updated', metadata: { changedFields, actorUserId: scope.actorUserId || userId, source: 'crm',
        ...(!automationTransitionId && recovery ? { automationHandoff: recovery } : {}) },
    }).returning({ id: crmActivitiesTable.id });
    if (!automationTransitionId && recovery) automationTransitionId = activity.id;
    }
    if (recoverableAutomation && (updates.pipelineStatus !== undefined || updates.status !== undefined))
      automationTransitionId ||= await this.latestContactAutomationTransition(tx, userId, updated);
    return { updated: automationTransitionId ? { ...updated, automationTransitionId } : updated, transition };
  }

  // Recovery intent lives on the protected activity committed with the contact.
  // Migration 314 remains the only durable event outbox after cutover.
  private async contactAutomationCheckpoint(tx: any, before: any, after: any, enabled: boolean | 'pipeline') {
    if (!enabled) return undefined;
    const events: Record<string, unknown> = {};
    for (const [type, field] of [['status_change', 'status'], ['pipeline_status_change', 'pipelineStatus']]) {
      if (enabled === 'pipeline' && type === 'status_change') continue;
      if ((before[field] || 'new') !== (after[field] || 'new')) events[type] = {
        oldValue: before[field] || 'new', newValue: after[field] || 'new', status: 'pending',
      };
    }
    if (!Object.keys(events).length) return undefined;
    const result = await tx.execute(sql`SELECT txid_current()::text AS id`);
    return { version: 1, transactionId: result.rows[0].id, events };
  }

  private async latestContactAutomationTransition(tx: any, userId: number, contact: any): Promise<number | undefined> {
    const scope = requireBusinessScope();
    const result = await tx.execute(sql`SELECT id,metadata FROM crm_activities WHERE user_id=${userId}
      AND business_profile_id=${scope.businessProfileId} AND contact_id=${contact.id}
      AND (type='pipeline_change' OR (type='contact_updated' AND metadata->'changedFields' ? 'status'))
      ORDER BY id DESC LIMIT 1`);
    return result.rows[0]?.metadata?.automationHandoff ? Number(result.rows[0].id) : undefined;
  }

  private async publishContactTransition(userId: number, transition: {
    updated: any; oldStatus: string; stage: CrmConfiguration['stages'][number]; changed: boolean;
  }) {
    if (!transition.changed) return;
    const { updated, oldStatus, stage } = transition;
    const event = { contactId: updated.id, oldStatus, newStatus: stage.key,
      metadata: { stageName: stage.label, stageType: stage.type } };
    const eventTypes = ['status_changed_to', 'status_changed_from'];
    if (stage.key === 'proposal_sent') eventTypes.push('proposal_sent');
    if (stage.key === 'ticket_open') eventTypes.push('ticket_opened');
    if (stage.key === 'ticket_close') eventTypes.push('ticket_closed');
    if (stage.type === 'won') eventTypes.push('deal_won');
    if (stage.type === 'lost') eventTypes.push('deal_lost');
    // An alert failure after commit must never make the client retry a completed edit.
    const events = await Promise.allSettled(eventTypes.map(type => Promise.resolve().then(() => alertService.fireEvent(userId, type as any, event))));
    events.forEach(event => { if (event.status === 'rejected') logger.warn({ err: event.reason, contactId: updated.id }, '[CRMService] Contact saved; alert dispatch failed'); });
  }

  async bulkUpdateContacts(userId: number, action: CrmBulkContactUpdate, options?: { recoverableAutomation?: boolean | 'pipeline' }) {
    const result: Array<NonNullable<Awaited<ReturnType<CRMService['commitContactUpdate']>>>> = await db.transaction(async (tx: any) => {
      const configuration = await getCrmConfiguration(userId, tx, true);
      await validateCrmAssignee(userId, action.assignedTo !== undefined ? action.assignedTo : action.ownerUserId, tx);
      await lockCrmContactResolution(tx, userId);
      const results: Array<NonNullable<Awaited<ReturnType<CRMService['commitContactUpdate']>>>> = [];
      const seen = new Set<number>();
      // Resolve and verify every reference in this transaction; one invalid reference rolls all writes back.
      for (const reference of [...action.contactIds].sort((a,b) => a-b)) {
        const contact = await this.materializeContactReference(userId, reference, 'crm_bulk', tx);
        if (!contact) throw new CrmConfigurationError('One or more selected contacts are no longer available.', 404);
        if (seen.has(contact.id)) continue;
        seen.add(contact.id);
        const tags = [...new Set([...(contact.tags || []).filter((tag: string) => !action.removeTags?.includes(tag)), ...(action.addTags || [])])];
        if (tags.length > 20) throw new CrmConfigurationError('A contact can have at most 20 tags. Narrow the selection or remove tags first.', 400);
        const updates = {
          ...(action.addTags || action.removeTags ? { tags } : {}),
          ...(action.pipelineStatus !== undefined ? { pipelineStatus: action.pipelineStatus } : {}),
          ...(action.assignedTo !== undefined ? { assignedTo: action.assignedTo }
            : action.ownerUserId !== undefined ? { assignedTo: action.ownerUserId } : {}),
        };
        const result = await this.commitContactUpdate(userId, contact.id, updates, tx, configuration, options?.recoverableAutomation);
        if (!result) throw new CrmConfigurationError('One or more selected contacts are no longer available.', 404);
        results.push(result);
      }
      return results;
    });
    for (const row of result) if (row.transition) await this.publishContactTransition(userId, row.transition);
    return { contacts: result.map(row => row.updated), updatedCount: result.length,
      transitions: result.filter(row => row.transition?.changed).map(row => ({ contactId: row.updated.id,
        oldStatus: row.transition!.oldStatus, newStatus: row.transition!.stage.key })) };
  }

  /** Shared by manual/generated lead writes and bulk lead imports. */
  async syncLeadContact(userId: number, leadId: number, changedFields?: Partial<{
    name: string | null; firstName: string | null; lastName: string | null; email: string | null; phone: string | null;
    company: string | null; role: string | null; website: string | null; linkedinUrl: string | null;
    status: string | null; leadStatus: string | null; assignedTo: number | null;
  }>, transaction?: any, savedConfiguration?: CrmConfiguration) {
    const synchronize = async (tx: any) => {
      const configuration = savedConfiguration || await getCrmConfiguration(userId, tx, Boolean(changedFields?.leadStatus || changedFields?.status));
      await validateCrmAssignee(userId, changedFields?.assignedTo, tx);
      await lockCrmContactResolution(tx, userId);
      const [lead] = await tx.select().from(leadsTable).where(and(
        eq(leadsTable.id, leadId), eq(leadsTable.userId, userId), isNull(leadsTable.deletedAt),
      )).limit(1);
      if (!lead || (!changedFields && !normalizedContactPhone(lead.phone))) return null;
      const canonical = await canonicalContactForChannelLead(tx, userId, leadId);
      const [ownContact] = canonical ? [] : await tx.select().from(crmContactsTable).where(and(
        eq(crmContactsTable.leadId, leadId), eq(crmContactsTable.userId, userId), isNull(crmContactsTable.deletedAt),
      )).limit(1);
      const contact = canonical || ownContact;
      if (contact && !changedFields) {
        const missingFields = { ...(!contact.phone && lead.phone ? { phone: lead.phone } : {}),
          ...(!contact.email && lead.email ? { email: lead.email } : {}) };
        if (Object.keys(missingFields).length) changedFields = missingFields;
      }
      if (contact && changedFields) {
        const changes = changedFields;
        const shared = ['firstName', 'lastName', 'phone', 'email', 'company', 'role', 'website', 'linkedinUrl', 'assignedTo'] as const;
        const patch: Record<string, unknown> = Object.fromEntries(shared.filter(key => key in changes).map(key => [key, changes[key]]));
        if (changedFields.name !== undefined && changedFields.firstName === undefined && changedFields.lastName === undefined) {
          const names = (changedFields.name || '').trim().split(/\s+/);
          patch.firstName = names[0] || null;
          patch.lastName = names.slice(1).join(' ') || null;
        }
        const lifecycle = changedFields.leadStatus ?? changedFields.status;
        if (lifecycle) {
          const stage = resolveCrmStageReference(configuration.stages, lifecycle);
          if (stage) patch.pipelineStatus = stage.key;
        }
        const result = await this.commitContactUpdate(userId, contact.id, patch, tx, configuration);
        if (result && patch.pipelineStatus === undefined)
          await this.syncStatusToLead(userId, result.updated.id, result.updated.status, result.updated.pipelineStatus, tx, configuration);
        return result?.updated || null;
      }
      if (contact) {
        const canonical = await reconcileContactPhone(tx, userId, contact);
        if (canonical) await this.syncStatusToLead(userId, canonical.id, canonical.status, canonical.pipelineStatus, tx, configuration);
        return canonical;
      }
      // Ordinary edits of a lead that has no persisted CRM record remain virtual.
      if (changedFields && !normalizedContactPhone(lead.phone)) return null;
      const id = await this.ensureContactForInbound(userId, leadId, { source: lead.source || 'lead', recordReply: false }, tx);
      const created = id ? (await tx.select().from(crmContactsTable).where(and(
        eq(crmContactsTable.id, id), eq(crmContactsTable.userId, userId), isNull(crmContactsTable.deletedAt),
      )).limit(1))[0] : null;
      if (created) await this.syncStatusToLead(userId, created.id, created.status, created.pipelineStatus, tx, configuration);
      return created;
    };
    return transaction ? synchronize(transaction) : db.transaction(synchronize);
  }

  /** Import callers supply their row transaction and locked configuration.
   * Lock configuration before the resolution lock, just like manual/bulk edits. */
  async applyImportedContactUpdate(userId: number, contactId: number, patch: Record<string, unknown>, tx: any, configuration: CrmConfiguration) {
    await validateCrmAssignee(userId, patch.assignedTo as number | null | undefined, tx);
    return this.commitContactUpdate(userId, contactId, patch, tx, configuration);
  }

  async softDeleteContact(userId: number, contactId: number) {
    return db.transaction(async (tx: any) => {
      await lockCrmContactResolution(tx, userId);
      const [deleted] = await tx.update(crmContactsTable)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(crmContactsTable.id, contactId), eq(crmContactsTable.userId, userId)))
        .returning();
      if (deleted) return deleted;

      // The CRM list also displays lead-backed virtual contacts whose id is the
      // lead id. For those rows, create/update a deleted CRM marker so the lead
      // stays available elsewhere but disappears from CRM contacts.
      const leadId = Math.abs(contactId);
      const [lead] = await tx.select().from(leadsTable)
        .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId), isNull(leadsTable.deletedAt)))
        .limit(1);
      if (!lead) return null;

      const now = new Date();
      const [existingMarker] = await tx.select().from(crmContactsTable)
        .where(and(eq(crmContactsTable.userId, userId), eq(crmContactsTable.leadId, lead.id)))
        .limit(1);

      if (existingMarker) {
        const [updatedMarker] = await tx.update(crmContactsTable)
          .set({ deletedAt: now, updatedAt: now })
          .where(eq(crmContactsTable.id, existingMarker.id))
          .returning();
        return updatedMarker || null;
      }

      const [marker] = await tx.insert(crmContactsTable).values({
        userId,
        leadId: lead.id,
        firstName: lead.firstName || null,
        lastName: lead.lastName || null,
        email: lead.email || null,
        phone: lead.phone || null,
        company: lead.company || lead.companyName || null,
        role: lead.role || null,
        linkedinUrl: lead.linkedinUrl || null,
        website: lead.website || null,
        avatarUrl: lead.profilePicture || null,
        businessCategoryId: lead.businessCategoryId || null,
        businessCategoryName: lead.businessCategoryName || null,
        status: 'new',
        priority: 'medium',
        source: 'crm_deleted',
        deletedAt: now,
        updatedAt: now,
      }).returning();

      return marker || null;
    });
  }

  async convertLeadToContact(userId: number, leadId: number) {
    return this.materializeContactReference(userId, -Math.abs(leadId), 'manual_convert');
  }

  async addActivity(
    userId: number,
    contactId: number,
    type: string,
    subject: string | null,
    body: string | null,
    metadata?: Record<string, unknown>,
    task?: { dueAt?: Date | string | null; completedAt?: Date | string | null; priority?: string }
  ) {
    return db.transaction(async (tx: any) => {
      const contact = await this.materializeContactReference(userId, contactId, 'crm_activity', tx);
      if (!contact) return null;

      const [activity] = await tx.insert(crmActivitiesTable).values({
        userId,
        contactId: contact.id,
        type,
        subject,
        body,
        metadata: metadata || {},
        dueAt: this.activityDate(task?.dueAt),
        completedAt: this.activityDate(task?.completedAt),
        ...(task?.priority !== undefined ? { priority: task.priority } : {}),
      }).returning();

      // Update contact lastActivityAt
      await tx.update(crmContactsTable)
        .set({ lastActivityAt: new Date(), updatedAt: new Date() })
        .where(and(eq(crmContactsTable.id, contact.id), eq(crmContactsTable.userId, userId)));

      return activity;
    });
  }

  private activityDate(value: Date | string | null | undefined) {
    if (value === undefined || value === null) return value;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new CrmConfigurationError('Invalid activity date.', 400);
    return date;
  }

  async updateActivity(userId: number, activityId: number, updates: Partial<{
    subject: string;
    body: string;
    type: string;
    dueAt: Date | string | null;
    completedAt: Date | string | null;
    priority: string;
  }>) {
    const allowed = new Set(['subject', 'body', 'type', 'dueAt', 'completedAt', 'priority']);
    if (Object.keys(updates).some(key => !allowed.has(key)))
      throw new CrmConfigurationError('Only note and task fields can be edited.', 400);
    if (updates.type !== undefined && !['note', 'call', 'email', 'meeting', 'task'].includes(updates.type))
      throw new CrmConfigurationError('Choose a note or task activity type.', 400);
    return db.transaction(async (tx: any) => {
      const [current] = await tx.select().from(crmActivitiesTable)
        .where(and(eq(crmActivitiesTable.id, activityId), eq(crmActivitiesTable.userId, userId))).limit(1).for('update');
      if (!current) return null;
      if (!['note', 'call', 'email', 'meeting', 'task'].includes(current.type))
        throw new CrmConfigurationError('System activity records cannot be edited.', 409);
      const [contact] = await tx.select({ id: crmContactsTable.id }).from(crmContactsTable)
        .where(and(eq(crmContactsTable.id, current.contactId), eq(crmContactsTable.userId, userId), isNull(crmContactsTable.deletedAt))).limit(1);
      if (!contact) return null;
      const [updated] = await tx.update(crmActivitiesTable)
        .set({ ...updates, dueAt: this.activityDate(updates.dueAt), completedAt: this.activityDate(updates.completedAt), updatedAt: new Date() })
        .where(and(eq(crmActivitiesTable.id, activityId), eq(crmActivitiesTable.userId, userId)))
        .returning();
      return updated || null;
    });
  }

  async getActivities(userId: number, contactId: number, limit = 50, offset = 0) {
    const contact = await this.getContactById(userId, contactId);
    if (!contact || contact.id < 0) return [];
    return db.select().from(crmActivitiesTable)
      .where(and(eq(crmActivitiesTable.contactId, contact.id), eq(crmActivitiesTable.userId, userId)))
      .orderBy(desc(crmActivitiesTable.createdAt))
      .limit(limit)
      .offset(offset);
  }

  async importContactsFromCSV(
    userId: number,
    rows: Array<Record<string, string>>,
    columnMapping: Record<string, string>,
    fileName: string,
    options?: { updateExisting?: boolean; startIndex?:number; batchSize?:number; phoneCountry?:'IN'|'none' }
  ): Promise<{
    importId: number;
    totalRecords: number;
    successCount: number;
    duplicateCount: number;
    skippedCount: number;
    errorCount: number;
    warningCount: number;
    issues: ImportIssue[];
    importStatus: string | null;
  }> {

    // Resolve business category once for all imported contacts
    const catInfo = await LeadModel.resolveBusinessCategory({ userId });

    const importRecord = await beginCrmImport(userId,rows,columnMapping,fileName,Boolean(options?.updateExisting));

    const start=options?.startIndex ?? 0,end=options?.batchSize ? Math.min(rows.length,start+options.batchSize) : rows.length;
    if(!Number.isSafeInteger(start) || start<0 || start>rows.length || (options?.batchSize!==undefined && (!Number.isSafeInteger(options.batchSize) || options.batchSize<1 || options.batchSize>1000))) throw new Error('Invalid import checkpoint.');
    for (let i = start; i < end; i++) {
      const row = rows[i];
      const rowNumber = i + 2; // Account for the CSV header row.
      const rowWarnings: ImportIssue[] = [];
      let transition: ContactTransition | undefined;
      try {
        await db.transaction(async (tx: any) => {
          const configuration = await getCrmConfiguration(userId, tx, true);
          await lockCrmContactResolution(tx, userId);
          if (await importRowCommitted(tx,importRecord.id,rowNumber)) return;
          const mapped: Record<string, string | null> = {};
          for (const [csvCol, dbCol] of Object.entries(columnMapping)) {
            if (dbCol === 'skip') continue;
            const value = row[csvCol];
            mapped[dbCol] = typeof value === 'string' && value.trim() ? value.trim() : null;
          }

          const missingFields = getMissingContactImportFields(mapped);
          if (missingFields.length > 0) {
            const message = `Missing mandatory ${missingFields.join(', ')}`;
            await saveCrmImportReceipt(tx,{
              importId: importRecord.id,
              rowNumber,
              originalData: row,
              parsedData: mapped,
              status: 'skipped',
              errorMessage: message,
            });
            return;
          }

          mapped.email = mapped.email?.toLowerCase() || null;
          const identity = contactImportIdentity(mapped);
          // Explicit updates retain their email-based edit target. Ordinary
          // imports identify phone recipients independently of shared emails.
          const lookupIdentity = options?.updateExisting && mapped.email
            ? { kind: 'email' as const, value: mapped.email } : identity;
          const scope = requireBusinessScope();
          const leadIdentity = identity.kind === 'phone'
            ? contactImportPhoneMatch(leadsTable,identity.value,options?.phoneCountry)
            : sql`lower(${leadsTable.email}) = ${identity.value}`;

          const requestedStatus = mapped.status?.trim();
          const stage = requestedStatus ? resolveCrmStageReference(configuration.stages,requestedStatus) : undefined;
          const resolvedStage = stage || configuration.stages.find(item => item.type === 'entry') || configuration.stages[0];
          const normalizedStatus = crmContactStatusForStage(resolvedStage);
          const pipelineStatus = resolvedStage.key;
          if (requestedStatus && !stage) rowWarnings.push({ row: rowNumber, type: 'warning',
            message: `Unknown status; imported with configured stage "${resolvedStage.label}"` });
          const dealValue = mapped.dealValue?.trim();
          if (dealValue && !/^\d{1,10}(\.\d{1,2})?$/.test(dealValue)) {
            throw new Error('Deal value must be a non-negative number with at most two decimals');
          }
          const tags = (mapped.tags || '')
            .split(/[,;]/)
            .map((tag) => tag.trim())
            .filter(Boolean);
          if (tags.length > 20 || tags.some((tag) => tag.length > 50)) {
            throw new Error('Tags are limited to 20 values of 50 characters each');
          }

          let resolvedImportContact: {id:number;leadId:number|null}|undefined;
          // Resolve the supplied channel identity within the active business.
          if (mapped.email || mapped.phone) {
            const existing = await tx.select({ id: crmContactsTable.id, leadId: crmContactsTable.leadId })
              .from(crmContactsTable)
              .where(and(
                eq(crmContactsTable.userId, userId),
                eq(crmContactsTable.businessProfileId, scope.businessProfileId),
                lookupIdentity.kind === 'phone'
                  ? contactImportPhoneMatch(crmContactsTable,lookupIdentity.value,options?.phoneCountry)
                  : sql`lower(${crmContactsTable.email}) = ${lookupIdentity.value}`,
                isNull(crmContactsTable.deletedAt)
              ))
              .limit(options?.phoneCountry ? 2 : 1);

            if(options?.phoneCountry && existing.length>1) throw new Error(`Several CRM contacts match this ${lookupIdentity.kind==='phone' ? 'normalized phone' : 'email'}. Resolve the existing duplicate contacts before importing this row.`);
            if(options?.phoneCountry) resolvedImportContact=existing[0];

            if (existing.length > 0 && (options?.updateExisting || (identity.kind === 'email' && !options?.phoneCountry))) {
              let existingId = existing[0].id;
              if (options?.updateExisting) {
                const importPatch = crmImportPatch(mapped, columnMapping, pipelineStatus);
                const result = await this.applyImportedContactUpdate(userId, existingId, importPatch, tx, configuration);
                if (!result) throw new Error('Imported contact is no longer available');
                existingId = result.updated.id;
                transition = result.transition;

                // Updated CRM-only contacts also need a lead to be selectable in
                // an outreach audience. Keep the receipt and link atomic.
                const scope = requireBusinessScope();
                let leadId = result.updated.leadId;
                let createdLeadForContact = false;
                if (!leadId) {
                  const [existingLead] = await tx.select({ id: leadsTable.id }).from(leadsTable).where(and(
                    eq(leadsTable.userId, userId), eq(leadsTable.businessProfileId, scope.businessProfileId),
                    lookupIdentity.kind === 'email' ? sql`lower(${leadsTable.email}) = ${lookupIdentity.value}` : leadIdentity,
                    isNull(leadsTable.deletedAt),
                  )).limit(1);
                  leadId = existingLead?.id;
                  if (!leadId) {
                    const contact = result.updated;
                    const fullName = [contact.firstName, contact.lastName].filter(Boolean).join(' ') || mapped.email || mapped.phone;
                    const currentStage = resolveCrmStageReference(configuration.stages, contact.pipelineStatus || '');
                    const leadStatus = crmLeadStatusForStage(currentStage, contact.status || normalizedStatus);
                    const [createdLead] = await tx.insert(leadsTable).values({
                      userId, source: 'crm_import', name: fullName, fullName,
                      firstName: contact.firstName || null, lastName: contact.lastName || null,
                      email: contact.email || mapped.email, phone: contact.phone || null,
                      company: contact.company || null, role: contact.role || null,
                      website: contact.website || null, linkedinUrl: contact.linkedinUrl || null,
                      status: leadStatus, leadStatus,
                      ...(catInfo.businessCategoryId && { businessCategoryId: catInfo.businessCategoryId, businessCategoryName: catInfo.businessCategoryName }),
                    }).returning({ id: leadsTable.id });
                    leadId = createdLead?.id;
                    createdLeadForContact = true;
                  }
                  if (!leadId) throw new Error('Imported contact lead could not be created');
                  const [linked] = await tx.update(crmContactsTable).set({ leadId }).where(and(
                    eq(crmContactsTable.id, existingId), eq(crmContactsTable.userId, userId),
                    eq(crmContactsTable.businessProfileId, scope.businessProfileId), isNull(crmContactsTable.leadId),
                  )).returning({ id: crmContactsTable.id });
                  if (!linked) throw new Error('Imported contact lead could not be linked');
                }
                if (!existing[0].leadId && !createdLeadForContact && leadId) {
                    // The first contact update occurred before it had a lead.
                    // Apply the same mapped fields that a linked contact update would sync.
                    const fields = ['firstName', 'lastName', 'phone', 'company', 'role', 'website', 'linkedinUrl'] as const;
                    const leadUpdates: Record<string, unknown> = Object.fromEntries(fields.filter(key => key in importPatch).map(key => [key, importPatch[key]]));
                    if ('firstName' in importPatch || 'lastName' in importPatch) {
                      const name = [result.updated.firstName, result.updated.lastName].filter(Boolean).join(' ') || result.updated.email || null;
                      leadUpdates.name = name;
                      leadUpdates.fullName = name;
                    }
                    if (Object.keys(leadUpdates).length) await tx.update(leadsTable).set({ ...leadUpdates, updatedAt: new Date() }).where(and(
                      eq(leadsTable.id, leadId), eq(leadsTable.userId, userId),
                      eq(leadsTable.businessProfileId, scope.businessProfileId), isNull(leadsTable.deletedAt),
                    ));
                    if ('pipelineStatus' in importPatch) await this.syncStatusToLead(userId, existingId,
                      result.updated.status || 'new', result.updated.pipelineStatus, tx, configuration);
                }

                await saveCrmImportReceipt(tx,{
                  importId: importRecord.id,
                  rowNumber,
                  originalData: row,
                  parsedData: mapped,
                  mappedContactData: mapped,
                  status: rowWarnings.length > 0 ? 'warning' : 'success',
                  errorMessage: rowWarnings.map(({ message }) => message).join('; ') || null,
                  createdContactId: existingId,
                });
                return;
              } else {
                const message = 'Duplicate email already exists in CRM';
                await saveCrmImportReceipt(tx,{
                  importId: importRecord.id,
                  rowNumber,
                  originalData: row,
                  parsedData: mapped,
                  status: 'duplicate',
                  errorMessage: message,
                });
                return;
              }
            }
          }

          let linkedLeadId: number | undefined=resolvedImportContact?.leadId || undefined;
          // Phone-only contacts need a lead and import receipt for WhatsApp audiences too.
          if ((mapped.email || mapped.phone) && !linkedLeadId) {
            const { leadsTable } = await import('../models/leads/schema.js');
            const existingLead = await tx.select({ id: leadsTable.id })
              .from(leadsTable)
              .where(and(eq(leadsTable.userId, userId), eq(leadsTable.businessProfileId, scope.businessProfileId), leadIdentity, isNull(leadsTable.deletedAt)))
              .limit(1);
            linkedLeadId = existingLead[0]?.id;
            if (!linkedLeadId) {
              const firstName = mapped.firstName || mapped.first_name || null;
              const lastName = mapped.lastName || mapped.last_name || null;
              const fullName = [firstName, lastName].filter(Boolean).join(' ') || mapped.email || mapped.phone;
              const [createdLead] = await tx.insert(leadsTable).values({
                userId,
                source: 'crm_import',
                name: fullName,
                firstName,
                lastName,
                email: mapped.email,
                phone: mapped.phone || null,
                company: mapped.company || null,
                role: mapped.role || mapped.title || null,
                status: crmLeadStatusForStage(resolvedStage,normalizedStatus),
                ...(catInfo.businessCategoryId && {
                  businessCategoryId: catInfo.businessCategoryId,
                  businessCategoryName: catInfo.businessCategoryName,
                }),
              }).returning({ id: leadsTable.id });
              linkedLeadId = createdLead?.id;
            }
          }

          let contact = resolvedImportContact ? (await tx.select().from(crmContactsTable).where(and(
            eq(crmContactsTable.id,resolvedImportContact.id),eq(crmContactsTable.userId,userId),eq(crmContactsTable.businessProfileId,scope.businessProfileId),isNull(crmContactsTable.deletedAt),
          )).limit(1))[0] : await insertCrmContact(tx, userId, {
            leadId: linkedLeadId,
            userId,
            firstName: mapped.firstName || mapped.first_name || null,
            lastName: mapped.lastName || mapped.last_name || null,
            email: mapped.email || null,
            phone: mapped.phone || null,
            company: mapped.company || null,
            role: mapped.role || mapped.title || null,
            linkedinUrl: mapped.linkedinUrl || mapped.linkedin_url || null,
            website: mapped.website || null,
            status: normalizedStatus,
            pipelineStatus,
            priority: 'medium',
            source: 'csv_import',
            notes: mapped.notes || null,
            dealValue: dealValue || null,
            tags,
            lastActivityAt: new Date(),
            ...(catInfo.businessCategoryId && {
              businessCategoryId: catInfo.businessCategoryId,
              businessCategoryName: catInfo.businessCategoryName,
            }),
          });
          if (!contact) throw new Error('Imported contact could not be resolved');
          // A phone match can resolve to an existing CRM contact without a lead.
          // Attach the imported lead so the receipt remains usable in outreach.
          if (!contact.leadId && linkedLeadId) {
            const [linked] = await tx.update(crmContactsTable).set({ leadId: linkedLeadId })
              .where(and(eq(crmContactsTable.id, contact.id), eq(crmContactsTable.userId, userId), isNull(crmContactsTable.leadId)))
              .returning();
            if (linked) contact = linked;
          }
          // A phone match may already be a mature canonical contact. Importing
          // another channel identity must not reset it when no stage was mapped.
          const importedStage = Object.values(columnMapping).includes('status') && mapped.status
            ? pipelineStatus : contact.pipelineStatus || configuration.stages[0].key;
          const applied = await this.applyImportedContactUpdate(userId, contact.id, { pipelineStatus: importedStage }, tx, configuration);
          if (!applied) throw new Error('Imported contact is no longer available');
          transition = applied.transition;


          await saveCrmImportReceipt(tx,{
            importId: importRecord.id,
            rowNumber,
            originalData: row,
            parsedData: mapped,
            mappedContactData: mapped,
            status: rowWarnings.length > 0 ? 'warning' : 'success',
            errorMessage: rowWarnings.map(({ message }) => message).join('; ') || null,
            createdContactId: contact.id,
          });
        });
        if (transition) await this.publishContactTransition(userId, transition);
      } catch (err) {
        const capacityError = normalizeCapacityError(err);
        const databaseError = err as { code?: string; cause?: { code?: string }; query?: string };
        const state = databaseError?.code || databaseError?.cause?.code;
        const retryable = !capacityError && (err instanceof CrmConfigurationError || ((databaseError?.query || databaseError?.cause || state) && !/^(22|23)/.test(state || '')));
        if (retryable) throw new CrmImportInterruptedError(importRecord.id);
        const message = capacityError ? `${capacityError.message} The import stopped after committed row receipts. Resubmit the same file to resume.`
          : err instanceof Error ? err.message : 'Row rejected';
        try {
          await db.transaction(async (tx: typeof db) => {
            await lockCrmContactResolution(tx,userId);
            if (!await importRowCommitted(tx,importRecord.id,rowNumber)) await saveCrmImportReceipt(tx,{
              importId: importRecord.id,rowNumber,originalData: row,status: capacityError ? 'blocked' : 'failed',errorMessage: message,
            });
          });
        } catch { throw new CrmImportInterruptedError(importRecord.id); }
        if (capacityError) {
          Object.assign(capacityError,{ importId: importRecord.id });
          throw capacityError;
        }
      }
    }

    // Counts/status come from committed receipts, including prior attempts.
    const final = await (options?.batchSize ? readCrmImportProgress(userId,importRecord.id) : this.getImportStatus(userId,importRecord.id)).catch(() => { throw new CrmImportInterruptedError(importRecord.id); });
    if (!final) throw new CrmImportInterruptedError(importRecord.id);
    return { importId: importRecord.id,totalRecords: final.totalRecords,successCount: final.successCount,
      duplicateCount: final.duplicateCount,skippedCount: final.skippedCount,errorCount: final.errorCount,
      warningCount: final.warningCount,issues: final.issues,importStatus: final.importStatus };

  }

  async getImportStatus(userId: number, importId: number) {
    const { crmContactImportsTable } = await import('../models/crmContactImports/schema');
    const { crmContactImportDetailsTable } = await import('../models/crmContactImportDetails/schema');

    const [importRecord] = await db.select().from(crmContactImportsTable)
      .where(and(eq(crmContactImportsTable.id, importId), eq(crmContactImportsTable.userId, userId)));
    if (!importRecord) return null;

    const details = await db.select().from(crmContactImportDetailsTable)
      .where(eq(crmContactImportDetailsTable.importId, importId))
      .orderBy(crmContactImportDetailsTable.rowNumber);

    const issueTypeByStatus: Record<string, ImportIssue['type']> = {
      duplicate: 'duplicate',
      skipped: 'skipped',
      failed: 'error',
      blocked: 'error',
      warning: 'warning',
    };
    type ImportDetail = {
      status: string;
      rowNumber: number;
      errorMessage: string | null;
    };
    const typedDetails = details as ImportDetail[];
    const issues = typedDetails.flatMap((detail) => {
      const type = issueTypeByStatus[detail.status];
      return type && detail.errorMessage
        ? [{ row: detail.rowNumber, type, message: detail.errorMessage }]
        : [];
    });

    const terminal = typedDetails.filter(({ status }) => CRM_IMPORT_TERMINAL_STATUSES.some(terminal => terminal === status));
    const recoveredComplete = terminal.length >= Number(importRecord.totalRecords) && Number(importRecord.totalRecords) > 0;
    return {
      ...importRecord,
      successCount: typedDetails.filter(({ status }) => status === 'success' || status === 'warning').length,
      errorCount: typedDetails.filter(({ status }) => status === 'failed').length,
      skippedCount: typedDetails.filter(({ status }) => status === 'skipped').length,
      processedRecords: terminal.length,
      importStatus: recoveredComplete ? 'completed' : importRecord.importStatus,
      recovery: { canResumeByFingerprint: Boolean(importRecord.requestFingerprint), needsResubmission: !recoveredComplete },
      duplicateCount: typedDetails.filter(({ status }) => status === 'duplicate').length,
      warningCount: typedDetails.filter(({ status }) => status === 'warning').length,
      issues,
      details,
    };
  }

  async getContactCount(userId: number) {
    const configuration = await getCrmConfiguration(userId);
    const result = await db.execute(sql`${crmVisibleContactsCte(userId,configuration)}
      SELECT COUNT(*)::int AS count FROM base`);
    return Number(result.rows[0]?.count || 0);
  }

  async getContactCountByStatus(userId: number) {
    const configuration = await getCrmConfiguration(userId);
    const result = await db.execute(sql`${crmVisibleContactsCte(userId,configuration)}
      SELECT status, COUNT(*)::int AS count FROM base GROUP BY status`);
    return (result.rows || []) as Array<{ status: string; count: number }>;
  }

  async getAnalytics(userId: number) {
    const statusCounts = await this.getContactCountByStatus(userId);
    const totalContacts = statusCounts.reduce((total,item)=>total+item.count,0);

    const wonCount = statusCounts.find((s) => s.status === 'won')?.count || 0;
    const lostCount = statusCounts.find((s) => s.status === 'lost')?.count || 0;
    const closedDeals = wonCount + lostCount;
    const winRate = closedDeals > 0 ? (wonCount / closedDeals) * 100 : 0;

    const pipelineValues = await db.select({
      currency: crmContactsTable.currency,
      total: sql<string>`COALESCE(SUM(${crmContactsTable.dealValue}), 0)`,
    })
      .from(crmContactsTable)
      .where(and(
        eq(crmContactsTable.userId, userId),
        isNull(crmContactsTable.deletedAt),
      ))
      .groupBy(crmContactsTable.currency);

    const pipelineValueByCurrency = Object.fromEntries(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      pipelineValues.map((row: any) => [row.currency || 'USD', row.total || '0']),
    );

    return {
      totalContacts,
      statusDistribution: Object.fromEntries(statusCounts.map((s) => [s.status, s.count])),
      winRate: Math.round(winRate * 100) / 100,
      pipelineValue: Object.values(pipelineValueByCurrency).reduce((sum, value) => sum + Number(value || 0), 0),
      pipelineValueByCurrency,
    };
  }

  // ─── Pipeline Status ─────────────────────────────────────────────────────────

  async updatePipelineStatus(userId: number, contactId: number, pipelineStatus: string,
    options?: { automatic?: boolean; expectedStageType?: CrmStageType; automation?: boolean; recoverableAutomation?: boolean | 'pipeline';
      insightsConversation?: { kind: 'outreach' | 'widget'; id: number } }) {
    const configuration = await getCrmConfiguration(userId);
    const requested = resolveCrmStageReference(configuration.stages, pipelineStatus);
    if (!requested) throw new CrmConfigurationError('Choose a stage from the saved CRM configuration.', 400);
    const contact = await this.materializeContactReference(userId, contactId, 'pipeline_update');
    if (!contact) return null;
    const scope = requireBusinessScope();
    let automationTransitionId: number | undefined;
    const transition = await db.transaction(async (tx: typeof db) => {
      if (options?.automation) await tx.execute(sql`SELECT set_config('app.crm_automation_origin','automation',true)`);
      // Serialize with configuration saves so an assigned stage cannot be
      // deleted, or change type, between validation and the contact write.
      const fresh = await getCrmConfiguration(userId, tx, true);
      const stage = fresh.stages.find(candidate => candidate.key === requested.key);
      if (!stage) throw new CrmConfigurationError('The selected CRM stage is no longer available.', 409);
      const [current] = await tx.select().from(crmContactsTable).where(and(
        eq(crmContactsTable.id, contact.id), eq(crmContactsTable.userId, userId),
        eq(crmContactsTable.businessProfileId, scope.businessProfileId), isNull(crmContactsTable.deletedAt),
      )).limit(1).for('update');
      if (!current) return null;
      const oldStatus = current.pipelineStatus || 'new';
      const oldStage = fresh.stages.find(candidate => candidate.key === oldStatus);
      if (options?.automatic && (((oldStage?.type === 'won' || oldStage?.type === 'lost') && oldStatus !== stage.key)
        || (options.expectedStageType && stage.type !== options.expectedStageType))) {
        return { updated: current, oldStatus, stage: oldStage, changed: false };
      }
      const status = crmContactStatusForStage(stage, current.status);
      const changed = oldStatus !== stage.key;
      if (!changed && current.status === status) {
        await this.syncStatusToLead(userId, current.id, status, stage.key, tx, fresh);
        if (options?.recoverableAutomation) automationTransitionId = await this.latestContactAutomationTransition(tx, userId, current);
        return { updated: current, oldStatus, stage, changed };
      }
      const [updated] = await tx.update(crmContactsTable).set({
        pipelineStatus: stage.key, status, lastActivityAt: new Date(), updatedAt: new Date(),
      }).where(and(eq(crmContactsTable.id, current.id), eq(crmContactsTable.userId, userId),
        eq(crmContactsTable.businessProfileId, scope.businessProfileId), isNull(crmContactsTable.deletedAt))).returning();
      if (!updated) return null;
      await this.syncStatusToLead(userId, updated.id, updated.status, stage.key, tx, fresh);
      const recovery = await this.contactAutomationCheckpoint(tx, current, updated, options?.recoverableAutomation || false);
      if (changed) {
      const [activity] = await tx.insert(crmActivitiesTable).values({
        userId, businessProfileId: scope.businessProfileId, contactId: updated.id, type: 'pipeline_change',
        outreachConversationId: options?.insightsConversation?.kind === 'outreach' ? options.insightsConversation.id : null,
        subject: `Pipeline: ${oldStage?.label || oldStatus} → ${stage.label}`,
        metadata: { oldStatus, newStatus: stage.key, oldStageName: oldStage?.label || oldStatus,
          newStageName: stage.label, stageType: stage.type, source: options?.automatic ? 'support_agent' : 'crm',
          actorUserId: scope.actorUserId || userId, insightsConversation: options?.insightsConversation,
          dealValueSnapshot: updated.dealValue, currencySnapshot: updated.currency, ...(recovery ? { automationHandoff: recovery } : {}) },
      }).returning({ id: crmActivitiesTable.id });
      if (recovery) automationTransitionId = activity.id;
      }
      return { updated, oldStatus, stage, changed };
    });
    if (!transition) return null;
    if (transition.stage) await this.publishContactTransition(userId, { ...transition, stage: transition.stage });
    return automationTransitionId ? { ...transition.updated, automationTransitionId } : transition.updated;
  }

  mapSentimentToPipelineStage(_sentiment: string, currentPipelineStatus: string): string {
    // Sentiment analytics must not advance a sale, close a deal, or mark a
    // customer lost. Business transitions require explicit workflow evidence.
    return currentPipelineStatus;
  }

  /**
   * Map email intent category to CRM pipeline stage.
   * Uses the email intent categories from the sentiment analysis LLM prompt.
   */
  mapIntentToPipelineStage(intentCategory: string, currentPipelineStatus: string): string {
    // Terminal states: won and lost should not be overridden
    if (currentPipelineStatus === 'won' || currentPipelineStatus === 'lost') {
      return currentPipelineStatus;
    }

    switch (intentCategory) {
      case 'interested_lead':
        return 'interested';

      case 'demo_request':
        return 'demo';

      case 'won_lead':
        return 'won';

      case 'negotiation_lead':
        return 'negotiations';

      case 'proposal_needed':
        return 'proposal_sent';

      case 'support_needed':
        return 'ticket_open';

      case 'ticket_closed':
        return 'ticket_close';

      case 'lost_lead':
        return 'lost';

      // Non-actionable intent: don't change pipeline
      case 'general':
      default:
        return currentPipelineStatus;
    }
  }

  async analyzeSentimentAndAdvancePipeline(userId: number, contactId: number, messageText: string) {
    const contact = await this.materializeContactReference(userId, contactId, 'sentiment_analysis');
    if (!contact) return null;
    const resolvedContactId = contact.id;

    const result = await sentimentAnalysisService.analyzeSentiment(userId, messageText);
    const oldPipelineStatus = contact.pipelineStatus || 'new';
    const newPipelineStatus = this.mapSentimentToPipelineStage(result.sentiment, oldPipelineStatus);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = {
      lastSentimentStatus: result.sentiment,
      sentimentScore: result.score,
      lastSentimentAnalysisAt: new Date(),
      lastActivityAt: new Date(),
      updatedAt: new Date(),
    };

    if (newPipelineStatus !== oldPipelineStatus) {
      updates.pipelineStatus = newPipelineStatus;
    }

    const [updated] = await db.update(crmContactsTable)
      .set(updates)
      .where(and(eq(crmContactsTable.id, resolvedContactId), eq(crmContactsTable.userId, userId)))
      .returning();

    if (updated && (updates.pipelineStatus || updates.status)) {
      await this.syncStatusToLead(userId, resolvedContactId, updated.status || 'new', updated.pipelineStatus || undefined);
    }

    if (newPipelineStatus !== oldPipelineStatus) {
      await this.addActivity(userId, resolvedContactId, 'pipeline_change', `AI Sentiment: ${oldPipelineStatus} → ${newPipelineStatus}`, null, {
        oldStatus: oldPipelineStatus,
        newStatus: newPipelineStatus,
        sentiment: result.sentiment,
        sentimentScore: result.score,
        keywords: result.keywords,
        trigger: 'sentiment_analysis',
      });

      // Fire alert events for status change (both IN and OUT)
      alertService.fireEvent(userId, 'status_changed_to', { contactId: resolvedContactId, oldStatus: oldPipelineStatus, newStatus: newPipelineStatus });
      alertService.fireEvent(userId, 'status_changed_from', { contactId: resolvedContactId, oldStatus: oldPipelineStatus, newStatus: newPipelineStatus });
    }

    return {
      contact: updated,
      sentiment: result,
      oldPipelineStatus,
      newPipelineStatus,
      statusChanged: newPipelineStatus !== oldPipelineStatus,
    };
  }

  async getPipelineAnalytics(userId: number, configuration: CrmConfiguration = DEFAULT_CRM_CONFIGURATION, rangeOverrides?: { from: Date | null; to: Date | null }) {
    const preferences = { ...configuration.preferences, platform: crmSelectedPlatforms(configuration.preferences) };
    const bounds = rangeOverrides || crmDateBounds(preferences);
    const since = bounds.from;
    const stuckBefore = new Date(Date.now() - preferences.stuckThreshold * 86_400_000);
    const pipelineResult = await db.execute(sql`
      ${crmVisibleContactsCte(userId, configuration)}
      SELECT base.pipeline_status,base.currency,COUNT(*)::int AS count,
        COUNT(*) FILTER (WHERE base.stage_entered_at < ${stuckBefore})::int AS stuck_count,
        COALESCE(SUM(base.deal_value),0)::text AS total_deal_value
      FROM base WHERE ${since ? sql`base.created_at >= ${since}` : sql`TRUE`}
        AND ${bounds.to ? sql`base.created_at < ${bounds.to}` : sql`TRUE`}
        AND ${preferences.platform.includes('all') ? sql`TRUE` : sql`EXISTS (SELECT 1 FROM outreach_conversations selected
          WHERE selected.user_id=${userId} AND selected.channel=ANY(${sql.param(preferences.platform)}::text[])
            AND (selected.crm_contact_id=base.crm_contact_id OR (selected.crm_contact_id IS NULL AND selected.lead_id=base.lead_id)))`}
      GROUP BY base.pipeline_status,base.currency
    `);

    const stageCounts = (pipelineResult.rows || []) as Array<{ pipeline_status: string; currency: string; count: number; stuck_count: number; total_deal_value: string }>;
    const stages = crmStagesForStatuses(configuration.stages, stageCounts.map(row => row.pipeline_status));
    const stageMap: Record<string, { count: number; stuckCount: number; dealValueByCurrency: Record<string, string> }> = {};
    const totalPipelineValueByCurrency: Record<string, string> = {};
    for (const row of stageCounts) {
      const stage = row.pipeline_status || 'new';
      const currency = row.currency || 'USD';
      const current = stageMap[stage] || { count: 0, stuckCount: 0, dealValueByCurrency: {} };
      current.count += Number(row.count || 0);
      current.stuckCount += Number(row.stuck_count || 0);
      current.dealValueByCurrency[currency] = row.total_deal_value || '0';
      stageMap[stage] = current;
      totalPipelineValueByCurrency[currency] = String(
        Number(totalPipelineValueByCurrency[currency] || 0) + Number(row.total_deal_value || 0),
      );
    }

    const wonCount = stages.filter(stage => stage.type === 'won').reduce((sum, stage) => sum + (stageMap[stage.key]?.count || 0), 0);
    const lostCount = stages.filter(stage => stage.type === 'lost').reduce((sum, stage) => sum + (stageMap[stage.key]?.count || 0), 0);
    const closedDeals = wonCount + lostCount;
    const winRate = closedDeals > 0 ? Math.round((wonCount / closedDeals) * 10000) / 100 : 0;

    const flowKeys = configuration.stages.filter(stage => stage.inFlow).map(stage => stage.key);
    const flowResult = await db.execute(sql`
      SELECT source_stage AS "from", destination_stage AS "to", COUNT(*)::int AS count
      FROM (
        SELECT COALESCE(NULLIF(activity.metadata->>'oldStatus', ''), 'new') AS source_stage,
          activity.metadata->>'newStatus' AS destination_stage
        FROM crm_activities activity JOIN crm_contacts contact ON contact.id = activity.contact_id
        WHERE activity.user_id = ${userId} AND contact.user_id = ${userId} AND contact.deleted_at IS NULL
          AND activity.type = 'pipeline_change'
          AND ${since ? sql`activity.created_at >= ${since}` : sql`TRUE`}
          AND ${bounds.to ? sql`activity.created_at < ${bounds.to}` : sql`TRUE`}
          AND ${preferences.platform.includes('all') ? sql`TRUE` : sql`EXISTS (
            SELECT 1 FROM outreach_conversations platform_conversation
            WHERE platform_conversation.user_id = ${userId} AND platform_conversation.channel = ANY(${sql.param(preferences.platform)}::text[])
              AND (platform_conversation.crm_contact_id = contact.id OR (platform_conversation.crm_contact_id IS NULL AND platform_conversation.lead_id = contact.lead_id))
          )`}
      ) transitions
      WHERE source_stage = ANY(${sql.param(flowKeys)}::text[]) AND destination_stage = ANY(${sql.param(flowKeys)}::text[])
      GROUP BY source_stage, destination_stage HAVING COUNT(*) >= ${preferences.minFlowCount}
      ORDER BY count DESC, source_stage, destination_stage LIMIT ${preferences.topFlows}
    `);

    return {
      stages: stages.map((stage) => ({
        ...stage,
        count: stageMap[stage.key]?.count || 0,
        stuckCount: stage.type === 'entry' || stage.type === 'active' ? stageMap[stage.key]?.stuckCount || 0 : 0,
        dealValue: Object.values(stageMap[stage.key]?.dealValueByCurrency || {}).reduce((sum, value) => sum + Number(value || 0), 0).toFixed(2),
        dealValueByCurrency: stageMap[stage.key]?.dealValueByCurrency || {},
      })),
      preferences,
      totalContacts: stageCounts.reduce((sum,row) => sum + Number(row.count || 0),0),
      wonCount,lostCount,
      flows: flowResult.rows as Array<{ from: string; to: string; count: number }>,
      stuckContacts: stages.filter(stage => stage.type === 'entry' || stage.type === 'active')
        .reduce((sum, stage) => sum + (stageMap[stage.key]?.stuckCount || 0), 0),
      winRate,
      totalPipelineValue: stageCounts.reduce((sum: number, s) => sum + parseFloat(s.total_deal_value || '0'), 0).toFixed(2),
      totalPipelineValueByCurrency,
    };
  }

  /**
   * Ensure a CRM contact exists for an inbound message (reply or new conversation).
   * Creates a reply-stage contact when needed; otherwise records activity and
   * advances early-stage contacts without regressing mature or terminal deals.
   * Called from every channel's inbound webhook handler after lead resolution.
   */
  async ensureContactForInbound(
    userId: number,
    leadId: number,
    options: InboundContactOptions = {},
    transaction?: any,
  ): Promise<number | null> {
    const reconcile = async (tx: any): Promise<number | null> => {
      if (!Number.isSafeInteger(leadId) || leadId <= 0) return null;
      await lockCrmContactResolution(tx, userId);
      const [lead] = await tx.select().from(leadsTable).where(and(
        eq(leadsTable.id, leadId), eq(leadsTable.userId, userId), isNull(leadsTable.deletedAt),
      )).limit(1);
      if (!lead) return null;

      const existing = await tx.select()
        .from(crmContactsTable)
        .where(and(
          eq(crmContactsTable.userId, userId),
          options.contactId ? eq(crmContactsTable.id, options.contactId) : eq(crmContactsTable.leadId, leadId),
          isNull(crmContactsTable.deletedAt),
        ))
        .limit(1);
      // An explicit canonical target is never a license to fall back to another
      // tenant's, deleted, or newly-created contact.
      if (options.contactId && !existing[0]) return null;
      const now = new Date();
      const configuration = await getCrmConfiguration(userId, tx);
      const leadStage = String(lead.status || '').toLowerCase();
      const initialStage = (leadStage === 'converted' || leadStage === 'won'
        ? crmStageForOutcome(configuration.stages, 'won')
        : leadStage === 'lost' || leadStage === 'rejected' ? crmStageForOutcome(configuration.stages, 'lost')
          : resolveCrmStageReference(configuration.stages, leadStage)) || configuration.stages[0];
      // Explicit conversation associations take precedence over historical
      // duplicate CRM rows attached to the temporary provider lead.
      let contact = (!options.contactId && await canonicalContactForChannelLead(tx, userId, leadId)) || existing[0];
      if (!contact) contact = await insertCrmContact(tx, userId, {
        userId,
        leadId,
        firstName: lead.firstName || null,
        lastName: lead.lastName || null,
        email: lead.email || null,
        phone: lead.phone || null,
        company: lead.company || lead.companyName || null,
        role: lead.role || null,
        linkedinUrl: lead.linkedinUrl || null,
        avatarUrl: lead.profilePicture || null,
        businessCategoryId: lead.businessCategoryId || null,
        businessCategoryName: lead.businessCategoryName || null,
        status: crmContactStatusForStage(initialStage, lead.status),
        pipelineStatus: initialStage.key,
        priority: 'medium',
        totalReplies: 0,
        lastActivityAt: options.recordReply === false ? (lead.updatedAt || lead.createdAt || now) : now,
        source: options?.source || options?.channel || lead.source || 'inbound',
      });
      if (!contact) return null;
      contact = await reconcileContactPhone(tx, userId, contact, options.conversationId || null);
      if (!contact) return null;
      if (options.recordReply === false) return contact.id;

      // Receipt and counter commit together. A replay cannot count twice, even
      // when it resolves through another temporary lead or channel worker.
      if (options.messageId || options.providerMessageId) {
        if (!options.conversationId) throw new Error('Inbound receipt requires a conversation');
        const [conversation] = await tx.select({ id: outreachConversationsTable.id }).from(outreachConversationsTable)
          .where(and(eq(outreachConversationsTable.id, options.conversationId),
            eq(outreachConversationsTable.userId, userId), eq(outreachConversationsTable.leadId, leadId))).limit(1);
        if (!conversation) throw new Error('Inbound receipt conversation does not belong to lead');
        const [message] = await tx.select({ id: outreachMessagesTable.id,
          providerMessageId: outreachMessagesTable.providerMessageId,
          externalMessageId: outreachMessagesTable.externalMessageId,
          wabaMessageId: outreachMessagesTable.wabaMessageId,
        }).from(outreachMessagesTable).where(and(
          options.messageId ? eq(outreachMessagesTable.id, options.messageId)
            : or(eq(outreachMessagesTable.providerMessageId, options.providerMessageId!),
              eq(outreachMessagesTable.externalMessageId, options.providerMessageId!),
              eq(outreachMessagesTable.wabaMessageId, options.providerMessageId!)),
          eq(outreachMessagesTable.conversationId, options.conversationId),
          eq(outreachMessagesTable.direction, 'inbound'),
        )).limit(1);
        if (options.messageId && !message) throw new Error('Inbound receipt message does not belong to conversation');
        const providerIds = [...new Set([options.providerMessageId, message?.providerMessageId,
          message?.externalMessageId, message?.wabaMessageId].filter(Boolean))];
        const receiptKeys = [
          ...(message ? [`message:${message.id}`] : []),
          ...providerIds.map(id => `provider:${options.channel || 'inbound'}:${options.conversationId}:${id}`),
        ].map(receipt => `crm-inbound-reply:${createHash('sha256').update(receipt).digest('hex')}`);
        // A provider-only recovery and a later saved-message reconciliation can
        // refer to the same receipt through different IDs. Check both aliases.
        const [previousReceipt] = await tx.select({ id: crmActivitiesTable.id }).from(crmActivitiesTable)
          .where(and(eq(crmActivitiesTable.userId, userId), inArray(crmActivitiesTable.idempotencyKey, receiptKeys))).limit(1);
        if (previousReceipt) return contact.id;
        const idempotencyKey = receiptKeys[0];
        const inserted = await tx.insert(crmActivitiesTable).values({
          userId, contactId: contact.id, type: 'inbound_reply', subject: 'Inbound reply received',
          outreachConversationId: options.conversationId, outreachMessageId: message?.id || null,
          idempotencyKey, metadata: { channel: options.channel || 'inbound' },
        }).onConflictDoNothing().returning({ id: crmActivitiesTable.id });
        if (!inserted.length) return contact.id;
      }
      if (options.conversationId) {
        await pauseProposalFollowupsForInboundReply(tx, userId, options.conversationId);
      }
      const transition = getInboundReplyTransition(contact.status, contact.pipelineStatus, configuration);
      const [updated] = await tx.update(crmContactsTable).set({
        totalReplies: sql`COALESCE(${crmContactsTable.totalReplies}, 0) + 1`,
        lastActivityAt: now, updatedAt: now, ...transition,
      }).where(and(eq(crmContactsTable.id, contact.id), eq(crmContactsTable.userId, userId), isNull(crmContactsTable.deletedAt))).returning();
      if (updated && (transition.status !== contact.status || transition.pipelineStatus !== contact.pipelineStatus)) {
        await this.syncStatusToLead(userId, updated.id, updated.status, updated.pipelineStatus || undefined, tx, configuration);
      }
      return updated?.id || contact.id;
    };
    // Let a supplied transaction roll back on failure, including association or
    // encrypted identity failures. Standalone channel callers stay non-blocking.
    if (transaction) return reconcile(transaction);
    try {
      return await db.transaction(reconcile);
    } catch (err) {
      // Non-blocking — log but don't throw
      logger.warn({ err, userId, leadId }, '[CRMService] ensureContactForInbound failed (non-blocking)');
      return null;
    }
  }

  private async syncStatusToLead(userId: number, contactId: number, status: string, pipelineStatus?: string, transaction?: any, configuration?: CrmConfiguration) {
    const executor = transaction || db;
    try {
      const [contact] = await executor.select({ leadId: crmContactsTable.leadId })
        .from(crmContactsTable)
        .where(and(eq(crmContactsTable.id, contactId), eq(crmContactsTable.userId, userId), isNull(crmContactsTable.deletedAt)))
        .limit(1);

      if (contact) {
        const configured = configuration || await getCrmConfiguration(userId, executor);
        const stage = configured.stages.find(candidate => candidate.key === pipelineStatus);
        const leadStatus = crmLeadStatusForStage(stage, status);
        const profileId = requireBusinessScope().businessProfileId;
        const aliases = await executor.execute(sql`SELECT DISTINCT lead.id FROM leads lead
          WHERE lead.user_id=${userId} AND lead.business_profile_id=${profileId} AND lead.deleted_at IS NULL
            AND lead.id IN (${contactLeadAliasIds(userId,profileId,contactId,contact.leadId ?? null)})`);
        const leadIds = aliases.rows.map((row: { id: number }) => row.id);
        if (!leadIds.length) return;

        await executor.execute(sql`
          UPDATE leads
          SET status = ${leadStatus}, lead_status = ${leadStatus}, updated_at = NOW()
          WHERE id = ANY(${sql.param(leadIds)}::integer[]) AND user_id = ${userId} AND business_profile_id=${profileId} AND deleted_at IS NULL
        `);

        // Campaign/Sequence auto-pause when moving to won, lost, interested, demo, proposal_sent, ticket_open
        const currentStage = pipelineStatus || status;
        const shouldPause = stage && (stage.type === 'won' || stage.type === 'lost'
          || (stage.type === 'active' && !['contacted'].includes(stage.key)));
        if (shouldPause) {
          await executor.execute(sql`
            UPDATE followup_sequences SET completed = true, replied_at = NOW(), updated_at = NOW()
            WHERE lead_id = ANY(${sql.param(leadIds)}::integer[]) AND user_id = ${userId} AND completed = false
          `);
          await executor.execute(sql`
            UPDATE sequence_executions SET status = 'paused', updated_at = NOW()
            WHERE lead_id = ANY(${sql.param(leadIds)}::integer[]) AND status = 'active'
              AND EXISTS (SELECT 1 FROM leads WHERE id = sequence_executions.lead_id AND user_id = ${userId} AND business_profile_id=${profileId} AND deleted_at IS NULL)
          `);
          logger.info({ leadIds, stage: currentStage }, '[CRMService] Paused active campaigns/follow-ups due to stage transition');
        }
      }
    } catch (err) {
      if (transaction) throw err;
      logger.warn({ err, contactId }, '[CRMService] Failed to sync status to lead or pause campaigns');
    }
  }
}

export const crmService = CRMService.getInstance();
