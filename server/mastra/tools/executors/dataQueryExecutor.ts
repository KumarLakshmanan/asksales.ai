import { db } from '../../../models/db.js';
import {
  leadsTable,
  icpProfilesTable,
  contentAssetsTable,
  outreachCampaignsTable,
  sentMessagesTable
} from '../../../models/index.js';
import { eq, and, or, ilike, sql, isNotNull, ne, desc, inArray } from 'drizzle-orm';
import { logger } from '../../../utils/logger.js';
import type { ToolContext } from '../toolRegistry.js';
import type { ToolResult } from '../../state.js';
import { normalizeContentAssetQuery } from '../contentAssetQuery.js';
import { canonicalLeadPlatform } from './leadSource.js';
import { toNumber } from './executorValues.js';

export async function executeQueryLeads(
  input: {
    query?: string;
    scope?: 'current_campaign' | 'all';
    filters?: {
      platform?: string;
      status?: string;
      has_email?: boolean;
      has_phone?: boolean;
      limit?: number;
      offset?: number;
    };
  },
  context: ToolContext
): Promise<ToolResult> {
  try {
    const userId = toNumber(context.userId);
    const limit = Math.min(input.filters?.limit || 50, 100);
    const offset = input.filters?.offset || 0;

    const conditions = [eq(leadsTable.userId, userId)];
    // Default to this campaign's leads; "all" answers account-wide questions
    // such as "how many leads do I have in total".
    const scope = input.scope === 'all' || !context.threadId ? 'all' : 'current_campaign';

    if (scope === 'current_campaign') {
      const icps = await db
        .select({ id: icpProfilesTable.id })
        .from(icpProfilesTable)
        .where(eq(icpProfilesTable.threadId, toNumber(context.threadId)));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const icpIds = icps.map((i: any) => i.id).filter(Boolean);

      const threadConditions = [
        sql`${leadsTable.campaignData}->>'threadId' = ${String(context.threadId)}`
      ];

      if (icpIds.length > 0) {
        threadConditions.push(inArray(leadsTable.promptId, icpIds));
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      conditions.push(or(...threadConditions) as any);
    }

    let platform = input.filters?.platform;
    let hasEmail = input.filters?.has_email;
    let hasPhone = input.filters?.has_phone;

    if (platform === 'whatsapp') {
      hasPhone = true;
      platform = undefined;
    } else if (platform === 'email') {
      hasEmail = true;
      platform = undefined;
    }

    if (platform) {
      conditions.push(or(eq(leadsTable.platformType, platform), eq(leadsTable.source, platform))!);
    }
    if (input.filters?.status) {
      conditions.push(
        or(
          eq(leadsTable.leadStatus, input.filters.status),
          eq(leadsTable.status, input.filters.status)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any
      );
    }
    if (hasEmail) {
      conditions.push(isNotNull(leadsTable.email));
      conditions.push(ne(leadsTable.email, ''));
    }
    if (hasPhone) {
      conditions.push(isNotNull(leadsTable.phone));
      conditions.push(ne(leadsTable.phone, ''));
    }

    if (input.query) {
      const searchPattern = `%${input.query}%`;
      conditions.push(
        or(
          ilike(leadsTable.fullName, searchPattern),
          ilike(leadsTable.name, searchPattern),
          ilike(leadsTable.companyName, searchPattern),
          ilike(leadsTable.company, searchPattern),
          ilike(leadsTable.role, searchPattern),
          ilike(leadsTable.headline, searchPattern)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any
      );
    }

    const leads = await db
      .select({
        id: leadsTable.id,
        fullName: leadsTable.fullName,
        name: leadsTable.name,
        email: leadsTable.email,
        phone: leadsTable.phone,
        companyName: leadsTable.companyName,
        company: leadsTable.company,
        role: leadsTable.role,
        source: leadsTable.source,
        platformType: leadsTable.platformType,
        leadType: leadsTable.leadType,
        status: leadsTable.status,
        leadStatus: leadsTable.leadStatus,
        createdAt: leadsTable.createdAt
      })
      .from(leadsTable)
      .where(and(...conditions))
      .limit(limit)
      .offset(offset)
      .orderBy(desc(leadsTable.createdAt));

    // Generate stats summary for the AI to understand the dataset easily
    const sourcedLeads = leads.map((lead: { platformType: string | null; source: string }) => ({
      ...lead,
      rawPlatformType: lead.platformType,
      platformType: canonicalLeadPlatform(lead.platformType, lead.source),
    }));
    // Counts cover every matching lead, not just the returned page. A count
    // failure must not hide the leads themselves, so it falls back to the page.
    let counts: { total: number; withEmail: number; withPhone: number } | undefined;
    try {
      [counts] = await db
        .select({
          total: sql<number>`count(*)::int`,
          withEmail: sql<number>`(count(*) filter (where ${leadsTable.email} is not null and ${leadsTable.email} <> ''))::int`,
          withPhone: sql<number>`(count(*) filter (where ${leadsTable.phone} is not null and ${leadsTable.phone} <> ''))::int`,
        })
        .from(leadsTable)
        .where(and(...conditions));
    } catch (countError) {
      logger.warn({ err: countError }, '[dataQueryExecutor] query_leads count failed; using the returned page');
    }
    const pageWithEmail = sourcedLeads.filter((lead: { email?: string | null }) => Boolean(lead.email)).length;
    const pageWithPhone = sourcedLeads.filter((lead: { phone?: string | null }) => Boolean(lead.phone)).length;
    const totalLeads = counts ? Number(counts.total) : sourcedLeads.length;
    const withEmail = counts ? Number(counts.withEmail) : pageWithEmail;
    const withPhone = counts ? Number(counts.withPhone) : pageWithPhone;
    const platformBreakdown: Record<string, number> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sourcedLeads.forEach((l: any) => {
      if (l.platformType) {
        platformBreakdown[l.platformType] = (platformBreakdown[l.platformType] || 0) + 1;
      }
    });

    return {
      success: true,
      toolName: 'query_leads',
      output: {
        summary: `${scope === 'all' ? 'Across the whole account' : 'In this campaign conversation'}: ${totalLeads} matching leads; ${withEmail} have an email address and ${withPhone} have a phone number. Returned ${sourcedLeads.length} of them${sourcedLeads.length < totalLeads ? ` (offset ${offset})` : ''}. Platforms in the returned leads: ${JSON.stringify(platformBreakdown)}.`,
        leads: sourcedLeads,
        scope,
        // Totals then cover only leads matching a search, platform, status or contact filter.
        filtered: Boolean(input.query || platform || input.filters?.status || hasEmail || hasPhone),
        count: sourcedLeads.length,
        total: totalLeads,
        withEmail,
        withPhone,
      }
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[dataQueryExecutor] query_leads error');
    return { success: false, toolName: 'query_leads', error: error.message };
  }
}

export async function executeQueryIcpProfiles(
  input: {
    query?: string;
    filters?: {
      status?: string;
      limit?: number;
    };
  },
  context: ToolContext
): Promise<ToolResult> {
  try {
    const userId = toNumber(context.userId);
    const limit = Math.min(input.filters?.limit || 10, 20);

    const conditions = [eq(icpProfilesTable.userId, userId)];

    if (input.filters?.status) {
      conditions.push(eq(icpProfilesTable.status, input.filters.status));
    }

    if (input.query) {
      const searchPattern = `%${input.query}%`;
      conditions.push(
        or(
          ilike(icpProfilesTable.campaignName, searchPattern),
          ilike(icpProfilesTable.targetAudience, searchPattern),
          ilike(icpProfilesTable.industry, searchPattern)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any
      );
    }

    const profiles = await db
      .select({
        id: icpProfilesTable.id,
        campaignName: icpProfilesTable.campaignName,
        campaignObjective: icpProfilesTable.campaignObjective,
        targetAudience: icpProfilesTable.targetAudience,
        industry: icpProfilesTable.industry,
        subIndustry: icpProfilesTable.subIndustry,
        primaryChannels: icpProfilesTable.primaryChannels,
        primaryRegions: icpProfilesTable.primaryRegions,
        primaryJobTitles: icpProfilesTable.primaryJobTitles,
        fitScore: icpProfilesTable.fitScore,
        createdAt: icpProfilesTable.createdAt
      })
      .from(icpProfilesTable)
      .where(and(...conditions))
      .limit(limit)
      .orderBy(desc(icpProfilesTable.createdAt));

    return {
      success: true,
      toolName: 'query_icp_profiles',
      output: {
        summary: `Retrieved ${profiles.length} ICP profiles.`,
        profiles
      }
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[dataQueryExecutor] query_icp_profiles error');
    return { success: false, toolName: 'query_icp_profiles', error: error.message };
  }
}

export async function executeQueryContentAssets(
  input: {
    scope?: 'current_campaign' | 'all_owned';
    assetIds?: number[];
    query?: string;
    filters?: {
      type?: string;
      channel?: string;
      status?: string;
      limit?: number;
    };
  },
  context: ToolContext
): Promise<ToolResult> {
  try {
    const normalized = normalizeContentAssetQuery(input);
    const userId = toNumber(context.userId);
    const limit = normalized.assetIds?.length ?? normalized.filters?.limit ?? 20;

    const conditions = [eq(contentAssetsTable.userId, userId)];
    if (normalized.assetIds) conditions.push(inArray(contentAssetsTable.id, normalized.assetIds));
    const threadId = toNumber(context.threadId);
    const scope = normalized.scope || (!normalized.assetIds && threadId > 0 ? 'current_campaign' : 'all_owned');
    if (scope === 'current_campaign') {
      if (!Number.isSafeInteger(threadId) || threadId <= 0) throw new Error('Current campaign is required');
      conditions.push(eq(contentAssetsTable.threadId, threadId));
    }

    if (input.filters?.type) {
      conditions.push(eq(contentAssetsTable.type, input.filters.type));
    }
    if (input.filters?.channel) {
      conditions.push(eq(contentAssetsTable.channel, input.filters.channel));
    }
    if (input.filters?.status) {
      conditions.push(eq(contentAssetsTable.status, input.filters.status));
    }

    if (normalized.query) {
      const searchPattern = `%${normalized.query}%`;
      conditions.push(
        or(
          ilike(contentAssetsTable.title, searchPattern),
          ilike(contentAssetsTable.content, searchPattern)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any
      );
    }

    const assets = await db
      .select({
        id: contentAssetsTable.id,
        type: contentAssetsTable.type,
        title: contentAssetsTable.title,
        content: contentAssetsTable.content,
        channel: contentAssetsTable.channel,
        status: contentAssetsTable.status,
        version: contentAssetsTable.version,
        threadId: contentAssetsTable.threadId,
        createdAt: contentAssetsTable.createdAt
      })
      .from(contentAssetsTable)
      .where(and(...conditions))
      .limit(limit)
      .orderBy(desc(contentAssetsTable.createdAt));

    return {
      success: true,
      toolName: 'query_content_assets',
      output: {
        summary: `Retrieved ${assets.length} content assets.`,
        scope,
        ...(scope === 'current_campaign' ? { threadId } : {}),
        // Lets a "none returned" answer say exactly what was searched.
        narrowed: Boolean(normalized.assetIds?.length || input.filters?.type || input.filters?.channel || input.filters?.status),
        filters: Object.fromEntries(Object.entries({ type: input.filters?.type, channel: input.filters?.channel, status: input.filters?.status,
          assetIds: normalized.assetIds?.length ? normalized.assetIds : undefined }).filter(([, value]) => value !== undefined && value !== '')),
        assets
      }
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[dataQueryExecutor] query_content_assets error');
    return { success: false, toolName: 'query_content_assets', error: error.message };
  }
}

export async function executeQueryOutreachCampaigns(
  input: {
    query?: string;
    filters?: {
      status?: string;
      campaign_type?: string;
      limit?: number;
    };
  },
  context: ToolContext
): Promise<ToolResult> {
  try {
    const userId = toNumber(context.userId);
    const limit = Math.min(input.filters?.limit || 10, 20);

    const conditions = [eq(outreachCampaignsTable.userId, userId)];

    if (input.filters?.status) {
      conditions.push(eq(outreachCampaignsTable.status, input.filters.status));
    }
    if (input.filters?.campaign_type) {
      conditions.push(eq(outreachCampaignsTable.campaignType, input.filters.campaign_type));
    }

    if (input.query) {
      const searchPattern = `%${input.query}%`;
      conditions.push(
        or(
          ilike(outreachCampaignsTable.name, searchPattern),
          ilike(outreachCampaignsTable.description, searchPattern)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ) as any
      );
    }

    const campaigns = await db
      .select({
        id: outreachCampaignsTable.id,
        name: outreachCampaignsTable.name,
        description: outreachCampaignsTable.description,
        campaignType: outreachCampaignsTable.campaignType,
        status: outreachCampaignsTable.status,
        totalLeads: outreachCampaignsTable.totalLeads,
        messagesSent: outreachCampaignsTable.messagesSent,
        opens: outreachCampaignsTable.opens,
        clicks: outreachCampaignsTable.clicks,
        replies: outreachCampaignsTable.replies,
        createdAt: outreachCampaignsTable.createdAt
      })
      .from(outreachCampaignsTable)
      .where(and(...conditions))
      .limit(limit)
      .orderBy(desc(outreachCampaignsTable.createdAt));

    // Also get recent sent messages if requested in query or campaign type
    const sentMessages = await db
      .select({
        id: sentMessagesTable.id,
        leadId: sentMessagesTable.leadId,
        channel: sentMessagesTable.channel,
        status: sentMessagesTable.status,
        createdAt: sentMessagesTable.createdAt
      })
      .from(sentMessagesTable)
      .where(eq(sentMessagesTable.userId, userId))
      .limit(20)
      .orderBy(desc(sentMessagesTable.createdAt));

    return {
      success: true,
      toolName: 'query_outreach_campaigns',
      output: {
        summary: `Retrieved ${campaigns.length} outreach campaigns.`,
        campaigns,
        recentSentMessages: sentMessages
      }
    };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[dataQueryExecutor] query_outreach_campaigns error');
    return { success: false, toolName: 'query_outreach_campaigns', error: error.message };
  }
}
