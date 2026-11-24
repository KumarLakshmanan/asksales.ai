import { dashboardUsage } from '../services/DashboardUsageService.js';
import { dashboardReporting } from '../services/DashboardReportingService.js';
import { dashboardCacheMatchesCrmAccess, dashboardUtcWeekStart } from '../../shared/dashboardReporting.js';
import { getEffectiveModuleAccess } from '../models/platformAccess/functions.js';
import { dashboardMoney } from '../services/ReportingMoneyService.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from "express";
import { logger } from '../utils/logger.js';
import { db } from "../models/db";
import { usersTable } from "../models/users/schema";
import { adminsTable } from "../models/admins/schema";
import { leadsTable } from "../models/leads/schema";
import { campaignsTable } from "../models/campaigns/schema";
import { sentMessagesTable } from "../models/sentMessages/schema";
import { performanceAdCampaignsTable } from "../models/performanceAdCampaigns/schema";
import { eq, count, gt, and, sql, gte, lt, type SQL } from "drizzle-orm";
import { getRedisConnection } from '../infrastructure/redis.js';
import {
  DASHBOARD_CACHE_TTL_SECONDS,
  dashboardCacheKey,
} from '../services/dashboardCache.js';

export { invalidateDashboardCache } from '../services/dashboardCache.js';

// Phase 5.6 / PERF-003: 5-minute Redis cache for the per-user dashboard.
//  - Keyed by `dashboard:user:<id>`. Different users naturally have
//    different keys so cross-user leakage isn't possible.
//  - The cache is invalidated on `wallets`, `credit_event_logs`, and
//    `leads` mutations via `invalidateDashboardCache(userId)`.
// Admin-only dashboard stats
export async function getAdminDashboardStats(req: Request, res: Response) {
  try {
    // Count total users
    const [userCountResult] = await db.select({ count: count() }).from(usersTable);
    const totalUsers = userCountResult.count;

    // Count total admins (from admins table)
    const [adminCountResult] = await db
      .select({ count: count() })
      .from(adminsTable);
    const totalAdmins = adminCountResult.count;

    // Count total leads across all users
    const [leadCountResult] = await db.select({ count: count() }).from(leadsTable);
    const totalLeads = leadCountResult.count;

    // Count active campaigns
    const [campaignCountResult] = await db.select({ count: count() }).from(campaignsTable);
    const totalCampaigns = campaignCountResult.count;

    // System health check
    let systemHealth = "Healthy";
    let serverStatus = "All systems operational";
    try {
      await db.select({ count: count() }).from(usersTable).limit(1);
    } catch {
      systemHealth = "Degraded";
      serverStatus = "Database connection issue";
    }

    // Count active agents (simplified - in real implementation would check running processes)
    const activeAgents = 0; // Would need to implement agent monitoring

    const stats = {
      totalUsers,
      totalAdmins,
      totalLeads,
      totalCampaigns,
      activeAgents,
      systemHealth,
      serverStatus,
    };

    res.json(stats);
  } catch (_error) {
    logger.error({ err: _error }, 'Get admin dashboard stats error');
    res.status(500).json({ message: "Unable to retrieve dashboard statistics. Please try again." });
  }
}

// User-specific dashboard stats
export async function getUserDashboardStats(req: Request, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    const crmEnabled = (await getEffectiveModuleAccess(userId)).some(module => module.key === 'crm' && module.enabled);

    // Phase 5.6 / PERF-003: 5-minute Redis cache. Skip on cache hit.
    try {
      const cached = await getRedisConnection().get(dashboardCacheKey(userId));
      const parsed = cached ? JSON.parse(cached) : null;
      if (parsed && parsed.spendByCurrency && parsed.budgetByCurrencyAndType && dashboardCacheMatchesCrmAccess(parsed, crmEnabled)) {
        res.setHeader('X-Cache', 'HIT');
        res.json(parsed);
        return;
      }
    } catch (cacheErr) {
      // Cache failure must not block the response.
      logger.warn({ err: cacheErr, userId }, '[dashboard] cache read failed');
    }
    res.setHeader('X-Cache', 'MISS');

    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const now = new Date();
    const startOfThisWeek = dashboardUtcWeekStart(now);
    const startOfLastWeek = new Date(startOfThisWeek.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Recorded outbound evidence, shared by counts and channel breakdowns.
    const sentEvidence = and(eq(sentMessagesTable.userId, userId), sql`${sentMessagesTable.isReply} IS NOT TRUE`,
      sql`(${sentMessagesTable.status} IN ('sent','delivered','opened','clicked','replied','read','accepted')
        OR ${sentMessagesTable.deliveryStatus} = 'delivered' OR ${sentMessagesTable.deliveredAt} IS NOT NULL)`);
    const email = sql`${sentMessagesTable.channel} IN ('email','gmail','resend')`;
    const replied = sql`(${sentMessagesTable.replyReceivedAt} IS NOT NULL OR ${sentMessagesTable.status} = 'replied')`;
    const counted = (condition: SQL | undefined) => sql<number>`count(*) FILTER (WHERE ${condition})`.mapWith(Number);

    // A cache miss used to run about twenty standalone count queries, each with
    // its own pooled connection and tenant-scope setup. The same counts now come
    // from four grouped statements, run one after another on one connection.
    const { money, reporting, leadCounts, campaignCounts, sentCounts, leadSourcesRaw } = await db.transaction(async (tx: typeof db) => {
      const money = await dashboardMoney(userId, tx);
      const reporting = await dashboardReporting(userId, now, tx, crmEnabled);
      const [leadCounts] = await tx
        .select({
          totalLeads: count(),
          newLeads: counted(gt(leadsTable.createdAt, thirtyDaysAgo)),
          leadsThisWeek: counted(gte(leadsTable.createdAt, startOfThisWeek)),
          leadsLastWeek: counted(and(gte(leadsTable.createdAt, startOfLastWeek), lt(leadsTable.createdAt, startOfThisWeek))),
          // Mutable customer record updates, not immutable conversion events.
          customerUpdatesThisWeek: counted(and(eq(leadsTable.leadType, 'customer'), gte(leadsTable.updatedAt, startOfThisWeek))),
          customerUpdatesLastWeek: counted(and(eq(leadsTable.leadType, 'customer'),
            gte(leadsTable.updatedAt, startOfLastWeek), lt(leadsTable.updatedAt, startOfThisWeek))),
        })
        .from(leadsTable)
        .where(eq(leadsTable.userId, userId));
      const [campaignCounts] = await tx
        .select({
          active: counted(eq(performanceAdCampaignsTable.status, 'active')),
          completed: counted(eq(performanceAdCampaignsTable.status, 'completed')),
        })
        .from(performanceAdCampaignsTable)
        .where(eq(performanceAdCampaignsTable.userId, userId));
      const [sentCounts] = await tx
        .select({
          messagesSent: count(),
          emailSent: counted(email),
          emailOpened: counted(and(email, sql`(${sentMessagesTable.openedAt} IS NOT NULL OR ${sentMessagesTable.openCount} > 0 OR ${sentMessagesTable.status} = 'opened')`)),
          emailClicked: counted(and(email, sql`(${sentMessagesTable.clickedAt} IS NOT NULL OR ${sentMessagesTable.clickCount} > 0 OR ${sentMessagesTable.status} = 'clicked')`)),
          emailReplied: counted(and(email, replied)),
          smsSent: counted(eq(sentMessagesTable.channel, 'sms')),
          smsDelivered: counted(and(eq(sentMessagesTable.channel, 'sms'),
            sql`(${sentMessagesTable.deliveredAt} IS NOT NULL OR ${sentMessagesTable.deliveryStatus} = 'delivered' OR ${sentMessagesTable.status} = 'delivered')`)),
          smsReplied: counted(and(eq(sentMessagesTable.channel, 'sms'), replied)),
          linkedinSent: counted(eq(sentMessagesTable.channel, 'linkedin')),
          linkedinAccepted: counted(and(eq(sentMessagesTable.channel, 'linkedin'), eq(sentMessagesTable.status, 'accepted'))),
          linkedinReplied: counted(and(eq(sentMessagesTable.channel, 'linkedin'), replied)),
          messagesThisWeek: counted(gte(sentMessagesTable.sentAt, startOfThisWeek)),
          messagesLastWeek: counted(and(gte(sentMessagesTable.sentAt, startOfLastWeek), lt(sentMessagesTable.sentAt, startOfThisWeek))),
        })
        .from(sentMessagesTable)
        .innerJoin(leadsTable, eq(sentMessagesTable.leadId, leadsTable.id))
        .where(and(eq(leadsTable.userId, userId), sentEvidence));
      // Lead Sources Distribution
      const leadSourcesRaw = await tx
        .select({
          platformType: leadsTable.platformType,
          count: count()
        })
        .from(leadsTable)
        .where(eq(leadsTable.userId, userId))
        .groupBy(leadsTable.platformType);
      return { money, reporting, leadCounts, campaignCounts, sentCounts, leadSourcesRaw };
    });

    const totalLeads = leadCounts.totalLeads;
    const newLeads = leadCounts.newLeads;
    const activeCampaigns = campaignCounts.active;
    const completedCampaigns = campaignCounts.completed;
    const messagesSent = sentCounts.messagesSent;

    // Compatibility field now uses recorded first wins / canonical CRM contacts.
    const conversionRate = reporting.recordedWins.rate;

    // Channel Performance Analytics
    const channelPerformance = {
      email: {
        sent: sentCounts.emailSent,
        opened: sentCounts.emailOpened,
        clicked: sentCounts.emailClicked,
        replied: sentCounts.emailReplied,
      },
      sms: {
        sent: sentCounts.smsSent,
        delivered: sentCounts.smsDelivered,
        replied: sentCounts.smsReplied,
      },
      linkedin: {
        sent: sentCounts.linkedinSent,
        accepted: sentCounts.linkedinAccepted,
        replied: sentCounts.linkedinReplied,
      },
    };

    const leadSources = leadSourcesRaw.map((source: { platformType: string | null; count: number }) => ({
      source: source.platformType || 'Unknown',
      count: source.count,
      percentage: totalLeads > 0 ? Math.round((source.count / totalLeads) * 100) : 0,
    })).sort((a: { count: number }, b: { count: number }) => b.count - a.count);

    const weeklyTrends = {
      leadsThisWeek: leadCounts.leadsThisWeek,
      leadsLastWeek: leadCounts.leadsLastWeek,
      messagesThisWeek: sentCounts.messagesThisWeek,
      messagesLastWeek: sentCounts.messagesLastWeek,
      customerUpdatesThisWeek: leadCounts.customerUpdatesThisWeek,
      conversionsThisWeek: reporting.recordedWins.thisWeek,
      customerUpdatesLastWeek: leadCounts.customerUpdatesLastWeek,
      conversionsLastWeek: reporting.recordedWins.lastWeek,
    };

    const stats = {
      totalLeads,
      newLeads,
      activeCampaigns,
      completedCampaigns,
      ...money,
      ...reporting,
      messagesSent,
      conversionRate,
      channelPerformance,
      leadSources,
      weeklyTrends,
    };

    // Phase 5.6 / PERF-003: write the computed dashboard to Redis. Fire-and-forget
    // so a slow Redis doesn't block the response.
    void getRedisConnection()
      .set(dashboardCacheKey(userId), JSON.stringify(stats), 'EX', DASHBOARD_CACHE_TTL_SECONDS)
      .catch((err) => logger.warn({ err, userId }, '[dashboard] cache write failed'));

    res.json(stats);
  } catch (_error) {
    logger.error({ err: _error }, 'Get user dashboard stats error');
    res.status(500).json({ message: "Unable to retrieve your dashboard statistics. Please try again." });
  }
}

// Admin usage overview - comprehensive stats across all services
export async function getAdminUsageOverview(req: Request, res: Response) {
  try {
    const { range = '7d' } = req.query;
    
    // Calculate date range
    const now = new Date();
    let startDate: Date;
    
    switch (range) {
      case '24h':
        startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
        break;
      case '7d':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case '30d':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case '90d':
        startDate = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    }

    const stats = await dashboardUsage(startDate);
    res.json({ success: true, stats });
  } catch (error) {
    logger.error({ err: error }, 'Get admin usage overview error');
    res.status(500).json({ message: "Unable to retrieve usage overview. Please try again." });
  }
}
