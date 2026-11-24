import { threadReporting, threadReportingCrmEnabled } from '../services/ThreadReportingService.js';
import { threadLeadIds } from '../services/threadLeadCohort.js';
import { businessOwnerUserId, requireBusinessScope } from '../tenancy/businessContext.js';
import { isPostgresIntegerId } from '../utils/postgresIntegerId.js';
import type { Request, Response } from "express";
import { logger } from '../utils/logger.js';
import { projectMessageApprovalDecisions } from '../models/chatMessages/approvalProjection.js';
import { sendErrorResponse } from '../utils/response.js';
import {
  getChatMessagesByUserId,
  softDeleteChatMessagesByUserId,
} from "../models/chatMessages/functions";
import {
  getChatThreadById,
  createChatThread,
  softDeleteChatThread,
} from "../models/chatThreads/functions";
import {
  saveChatTabConfig,
  getChatTabConfigs,
  deleteChatTabConfig,
  updateActiveTab,
  replaceChatTabConfigs,
} from "../models/chatTabConfigs/functions";
import { chatHistoryManager } from '../services/ChatHistoryManager';
import {
  getContextWindowForModel,
  LANGGRAPH_CONTEXT_MESSAGE_LIMIT,
} from '../utils/chatConstants';
import { countTokens } from '../utils/tokenCounter';
import { createWorkflowSession } from "../models/workflowSessions/functions";
import { ICPGenerationService } from "../services/ICPGenerationService";

import { db } from "../models/db";
import { sql } from "drizzle-orm";
import { serializeUtcTimestamp } from '../utils/supportTimestamp.js';
import {
  getLatestLeadInputsByThreadId,
  getLatestLeadInputsForUIByThreadId,
} from "../models/leadInputs/functions";
import { getLatestScrapingDetailsByThreadId } from "../models/scrapingDetails/functions";
import { claimRecoverableLeadGenerationProviderRunsForThread } from '../models/leadGenerationProviderRuns/functions.js';
import {
  getApprovedLeadInputSetForLeadInput,
  getLatestConversationWorkflowRun,
} from '../models/conversationWorkflow/functions.js';

const icpService = new ICPGenerationService();
const recoveringLeadThreads = new Set<number>();
const STALE_CHAT_TURN_MS = 3 * 60 * 1000;

type ThreadWorkflowSnapshot = {
  id: number;
  metadata?: unknown;
  [key: string]: unknown;
};

type AuthoritativeWorkflowRun = {
  id: string;
  threadId: number;
  status: string;
  updatedAt: Date;
  completedAt: Date | null;
};

/**
 * Recover a browser after a turn dies between metadata persistence and the
 * final realtime event. Fresh `running` snapshots are preserved so a reload
 * cannot enable concurrent input during legitimate work; only a stale
 * snapshot is reconciled to the durable workflow record.
 */
export function recoverStaleThreadWorkflowSnapshot<T extends ThreadWorkflowSnapshot>(
  thread: T,
  authoritativeRun: AuthoritativeWorkflowRun | undefined,
  now = Date.now(),
): T {
  if (!authoritativeRun) return thread;
  const metadata: Record<string, unknown> = thread.metadata && typeof thread.metadata === 'object'
    ? thread.metadata as Record<string, unknown>
    : {};
  const snapshot = metadata.workflowRun && typeof metadata.workflowRun === 'object'
    ? metadata.workflowRun as Record<string, unknown>
    : {};
  const snapshotStatus = typeof snapshot.status === 'string'
    ? snapshot.status
    : typeof metadata.workflowOutcome === 'string' ? metadata.workflowOutcome : undefined;
  const snapshotUpdatedAt = typeof snapshot.updatedAt === 'string'
    ? Date.parse(snapshot.updatedAt)
    : Number.NaN;
  const isStaleRunningSnapshot = snapshotStatus === 'running'
    && (!Number.isFinite(snapshotUpdatedAt) || now - snapshotUpdatedAt >= STALE_CHAT_TURN_MS);
  if (!isStaleRunningSnapshot || authoritativeRun.status === 'running') return thread;

  const runUpdatedAt = authoritativeRun.updatedAt.toISOString();
  const runContext = metadata.runContext && typeof metadata.runContext === 'object'
    ? metadata.runContext as Record<string, unknown>
    : {};
  return {
    ...thread,
    metadata: {
      ...metadata,
      workflowOutcome: authoritativeRun.status,
      runContext: { ...runContext, runId: authoritativeRun.id, threadId: authoritativeRun.threadId },
      workflowRun: {
        ...snapshot,
        runId: authoritativeRun.id,
        threadId: authoritativeRun.threadId,
        status: authoritativeRun.status,
        updatedAt: runUpdatedAt,
        completedAt: authoritativeRun.completedAt?.toISOString() ?? null,
      },
    },
  };
}

function parsePositiveInteger(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return isPostgresIntegerId(parsed) ? parsed : null;
}

async function userOwnsBusinessProfile(userId: number, businessId: number): Promise<boolean> {
  const result = await db.execute(sql`
    SELECT 1
    FROM company_settings
    WHERE id = ${businessId} AND user_id = ${userId}
    LIMIT 1
  `);
  return result.rows.length > 0;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function removeHeavyFields(obj: any): any {
  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map(removeHeavyFields);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clean: any = {};
  for (const key of Object.keys(obj)) {
    if (
      key === 'websiteContent' ||
      key === 'extractedText' ||
      key === 'contextText' ||
      key === 'imageData' ||
      key === 'videoData'
    ) {
      continue;
    }
    clean[key] = removeHeavyFields(obj[key]);
  }
  return clean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sanitizeMessageMetadata(metadata: any): any {
  return removeHeavyFields(metadata);
}

// Store workflow sessions per thread (in-memory cache) with TTL to prevent memory leak
interface WorkflowCacheEntry {
  workflowId: string;
  createdAt: number;
  lastAccessedAt: number;
}
const threadWorkflowMap = new Map<number, WorkflowCacheEntry>();

// TTL for workflow cache entries (24 hours)
const WORKFLOW_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
// Maximum number of entries in cache
const WORKFLOW_CACHE_MAX_SIZE = 10000;

/**
 * Cleanup expired entries from threadWorkflowMap
 */
function cleanupWorkflowCache(): void {
  const now = Date.now();
  let cleanedCount = 0;

  for (const [threadId, entry] of threadWorkflowMap.entries()) {
    if (now - entry.lastAccessedAt > WORKFLOW_CACHE_TTL_MS) {
      threadWorkflowMap.delete(threadId);
      cleanedCount++;
    }
  }

  if (cleanedCount > 0) {
    logger.info(
      { cleanedCount, remaining: threadWorkflowMap.size },
      '[ChatController] Cleaned up expired workflow cache entries'
    );
  }
}

// Run cleanup every hour
const _cacheCleanupTimer = setInterval(cleanupWorkflowCache, 60 * 60 * 1000);
if (typeof _cacheCleanupTimer === 'object' && 'unref' in _cacheCleanupTimer) {
  _cacheCleanupTimer.unref();
}

/**
 * Get or create workflow session for a thread
 */
async function getOrCreateWorkflowSession(
  userId: number,
  threadId: number
): Promise<string> {
  // Check cache first
  const cached = threadWorkflowMap.get(threadId);
  if (cached) {
    // Update last accessed time
    cached.lastAccessedAt = Date.now();
    return cached.workflowId;
  }

  // Enforce max cache size by removing oldest entries if needed
  if (threadWorkflowMap.size >= WORKFLOW_CACHE_MAX_SIZE) {
    // Find and remove the oldest entry (by lastAccessedAt)
    let oldestThreadId: number | null = null;
    let oldestTime = Date.now();

    for (const [tid, entry] of threadWorkflowMap.entries()) {
      if (entry.lastAccessedAt < oldestTime) {
        oldestTime = entry.lastAccessedAt;
        oldestThreadId = tid;
      }
    }

    if (oldestThreadId !== null) {
      threadWorkflowMap.delete(oldestThreadId);
    }
  }

  // Create new workflow session for this thread
  const workflowSession = await createWorkflowSession({
    userId,
    userPrompt: `Chat thread ${threadId}`,
    stage: "active",
    threadId: threadId,
  });

  // Cache the mapping with timestamps
  const now = Date.now();
  threadWorkflowMap.set(threadId, {
    workflowId: workflowSession.id,
    createdAt: now,
    lastAccessedAt: now,
  });

  return workflowSession.id;
}

export async function getChatMessagesHandler(req: Request, res: Response) {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const limit = req.query.limit ? parseInt(req.query.limit as string) : 100;

    const messages = await getChatMessagesByUserId(userId, limit);
    const sanitizedMessages = messages.map(msg => ({
      ...msg,
      metadata: sanitizeMessageMetadata(msg.metadata),
    }));
    res.json(sanitizedMessages);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching chat messages');
    res.status(500).json({ error: "Unable to retrieve chat messages. Please try again." });
  }
}


export async function clearChatHistoryHandler(req: Request, res: Response) {
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    // Preserve message/widget/attachment referential integrity. Retention
    // workers may hard-delete the graph later in dependency order.
    await softDeleteChatMessagesByUserId(userId);
    res.status(204).send();
  } catch (error) {
    logger.error({ err: error }, 'Error clearing chat history');
    res.status(500).json({ error: "Unable to clear chat history. Please try again." });
  }
}

/**
 * GET /api/chat/agent-suggestions
 * Get recommended next agents based on workflow state
 */
export async function getAgentSuggestionsHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { icp_id } = req.query;

    if (!icp_id) {
      return res.status(400).json({ error: "icp_id is required" });
    }

    // Check what agents have been used for this ICP via actual DB queries
    const icpIdNum = Number(icp_id);
    const completedAgents: string[] = [];

    // Check Lead Generation — leads table: promptId references icp_profiles.id
    try {
      const [leadRow] = await db.execute(
        sql`SELECT 1 FROM leads WHERE prompt_id = ${icpIdNum} AND user_id = ${userId} LIMIT 1`
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((leadRow as any[]).length > 0) completedAgents.push("Lead Generation");
    } catch (error) {
      logger.warn(
        { err: error },
        '[getAgentSuggestionsHandler] Could not check leads'
      );
    }

    // Check Content Studio — content_plans table: user_id
    try {
      const [contentRow] = await db.execute(
        sql`SELECT 1 FROM content_plans WHERE user_id = ${userId} AND icp_id = ${icpIdNum} LIMIT 1`
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((contentRow as any[]).length > 0) completedAgents.push("Content Studio");
    } catch (error) {
      // icp_id column may not exist in content_plans; fallback to user-level check
      try {
        const [contentRow2] = await db.execute(
          sql`SELECT 1 FROM content_plans WHERE user_id = ${userId} LIMIT 1`
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if ((contentRow2 as any[]).length > 0) completedAgents.push("Content Studio");
      } catch (_) {
        logger.warn(
          { err: error },
          '[getAgentSuggestionsHandler] Could not check content plans'
        );
      }
    }

    // Check Outreach — outreach_campaigns table: user_id
    try {
      const [outreachRow] = await db.execute(
        sql`SELECT 1 FROM outreach_campaigns WHERE user_id = ${userId} LIMIT 1`
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((outreachRow as any[]).length > 0) completedAgents.push("Outreach");
    } catch (error) {
      logger.warn(
        { err: error },
        '[getAgentSuggestionsHandler] Could not check outreach campaigns'
      );
    }

    // Check Performance Marketing — performance_ad_campaigns table: user_id
    try {
      const [perfRow] = await db.execute(
        sql`SELECT 1 FROM performance_ad_campaigns WHERE user_id = ${userId} LIMIT 1`
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if ((perfRow as any[]).length > 0) completedAgents.push("Performance Marketing");
    } catch (error) {
      logger.warn(
        { err: error },
        '[getAgentSuggestionsHandler] Could not check performance campaigns'
      );
    }

    // Get recommendations based on completion state (replaces legacy OrchestratorAgent)
    const allAgents = [
      { id: 'icp_generation', name: 'Orchestrator', description: 'Creates and refines your Ideal Customer Profile' },
      { id: 'lead_generation', name: 'Lead Generation Specialist', description: 'Discovers qualified leads across multiple platforms' },
      { id: 'content_studio', name: 'Content Studio Director', description: 'Creates engaging marketing content and creative assets' },
      { id: 'outreach', name: 'Outreach Coordinator', description: 'Manages personalized email and SMS outreach campaigns' },
      { id: 'performance_marketing', name: 'Performance Marketing Manager', description: 'Optimizes paid advertising campaigns' },
    ];
    const completedSet = new Set(completedAgents.map(a => a.toLowerCase()));
    const recommendedAgents = allAgents
      .filter(a => !completedSet.has(a.name.toLowerCase()))
      .map(a => ({ id: a.id, name: a.name, description: a.description }));

    const suggestionMessage = recommendedAgents.length > 0
      ? `Based on your progress, I recommend working with: ${recommendedAgents.map(a => a.name).join(', ')}.`
      : 'Great work! All agents have been utilized for this ICP.';

    res.json({
      success: true,
      completed_agents: completedAgents,
      recommended_agents: recommendedAgents,
      suggestion_message: suggestionMessage,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error getting agent suggestions');
    res
      .status(500)
      .json({ error: "Unable to retrieve agent suggestions. Please try again." });
  }
}

/**
 * GET /api/chat/threads
 * Get all chat threads for user with pagination, including business, ICP info, and stats
 */
export async function getChatThreadsHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    const requestedLimit = Number(req.query.limit ?? 20);
    const requestedOffset = Number(req.query.offset ?? 0);
    const requestedBusinessProfileId = req.query.businessProfileId;
    const businessProfileId = requestedBusinessProfileId === undefined
      ? undefined
      : typeof requestedBusinessProfileId === 'string' && /^\d+$/.test(requestedBusinessProfileId)
        ? parsePositiveInteger(requestedBusinessProfileId)
        : null;
    if (requestedBusinessProfileId !== undefined && businessProfileId === null) {
      return res.status(400).json({ error: "Invalid business profile ID" });
    }
    if (businessProfileId && !(await userOwnsBusinessProfile(userId, businessProfileId))) {
      return res.status(404).json({ error: "Business profile not found" });
    }
    const businessScope = businessProfileId === undefined ? sql`` : sql`AND ct.business_id = ${businessProfileId}`;
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 100)
      : 20;
    const offset = Number.isInteger(requestedOffset)
      ? Math.min(Math.max(requestedOffset, 0), 100_000)
      : 0;

    if (req.query.view === 'compact') {
      const { rows } = await db.execute(sql`
        SELECT ct.id, ct.title
        FROM chat_threads ct
        WHERE ct.user_id = ${userId} AND ct.deleted_at IS NULL ${businessScope}
        ORDER BY ct.updated_at DESC, ct.id DESC
        LIMIT ${limit} OFFSET ${offset}
      `);
      return res.json({ threads: rows });
    }

    // Resolve lead membership once for this page. A lead can match through
    // both its ICP profile and legacy campaign metadata, so deduplicate by thread.
    const threadsWithDetails = await db.execute(sql`
      WITH page AS MATERIALIZED (
        SELECT ct.id, ct.title, ct.selected_agent, ct.business_id,
          ct.business_profile_id, ct.created_at, ct.updated_at
        FROM chat_threads ct
        WHERE ct.user_id = ${userId} AND ct.deleted_at IS NULL ${businessScope}
        ORDER BY ct.updated_at DESC, ct.id DESC
        LIMIT ${limit} OFFSET ${offset}
      ), campaign_leads AS MATERIALIZED (
        SELECT p.id AS thread_id, p.business_profile_id, l.id AS lead_id
        FROM page p
        JOIN icp_profiles ip ON ip.thread_id = p.id AND ip.user_id = ${userId}
          AND ip.business_profile_id = p.business_profile_id
        JOIN leads l ON l.prompt_id = ip.id AND l.business_profile_id = p.business_profile_id
          AND l.user_id = ${userId} AND l.deleted_at IS NULL
        UNION
        SELECT p.id, p.business_profile_id, l.id
        FROM page p
        JOIN leads l ON l.legacy_campaign_thread_key = p.id::text AND l.business_profile_id = p.business_profile_id
          AND l.user_id = ${userId} AND l.deleted_at IS NULL
      ), lead_counts AS (
        SELECT thread_id, COUNT(*)::integer AS leads_count
        FROM campaign_leads GROUP BY thread_id
      ), outreach_counts AS (
        SELECT cl.thread_id, COUNT(*)::integer AS outreach_count
        FROM campaign_leads cl
        JOIN sent_messages sm ON sm.lead_id = cl.lead_id AND sm.business_profile_id = cl.business_profile_id
        GROUP BY cl.thread_id
      )
      SELECT
        ct.id,
        ct.title,
        ct.selected_agent AS "selectedAgent",
        ct.business_id AS "businessId",
        ct.created_at AS "createdAt",
        ct.updated_at AS "updatedAt",
        cs.name AS "businessName",
        cs.company_name AS "businessCompanyName",
        cs.industry AS "businessIndustry",
        ip.id AS "icpId",
        ip.campaign_name AS "icpCampaignName",
        ip.target_audience AS "icpTargetAudience",
        ip.industry AS "icpIndustry",
        ip.fit_score AS "icpFitScore",
        lc.leads_count AS "leadsCount",
        oc.outreach_count AS "outreachCount",
        assets.content_count AS "contentCount",
        assets.ad_copy_count AS "adCopyCount",
        assets.image_count AS "imageCount",
        assets.video_count AS "videoCount"
      FROM page ct
      LEFT JOIN company_settings cs ON ct.business_id = cs.id AND cs.user_id = ${userId}
      LEFT JOIN LATERAL (
        SELECT id, campaign_name, target_audience, industry, fit_score
        FROM icp_profiles
        WHERE thread_id = ct.id AND user_id = ${userId}
          AND business_profile_id = ct.business_profile_id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) ip ON TRUE
      LEFT JOIN lead_counts lc ON lc.thread_id = ct.id
      LEFT JOIN outreach_counts oc ON oc.thread_id = ct.id
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::integer AS content_count,
          COUNT(*) FILTER (WHERE type = 'ad_copy')::integer AS ad_copy_count,
          COUNT(*) FILTER (WHERE type = 'image')::integer AS image_count,
          COUNT(*) FILTER (WHERE type = 'video')::integer AS video_count
        FROM content_assets
        WHERE thread_id = ct.id AND user_id = ${userId}
          AND business_profile_id = ct.business_profile_id
      ) assets
      ORDER BY ct.updated_at DESC, ct.id DESC
    `);

    // Get total count for pagination
    const totalResult = await db.execute(sql`
      SELECT COUNT(*) as count
      FROM chat_threads ct
      WHERE ct.user_id = ${userId} AND ct.deleted_at IS NULL ${businessScope}
    `);
    const total = parseInt(totalResult.rows[0]?.count as string) || 0;

    // Map to cleaner response format
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const threads = threadsWithDetails.rows.map((row: any) => ({
      id: row.id,
      title: row.title,
      selectedAgent: row.selectedAgent,
      businessId: row.businessId,
      createdAt: serializeUtcTimestamp(row.createdAt),
      updatedAt: serializeUtcTimestamp(row.updatedAt),
      // Business info
      business: row.businessId ? {
        id: row.businessId,
        name: row.businessName || row.businessCompanyName,
        industry: row.businessIndustry,
      } : null,
      // ICP info
      icp: row.icpId ? {
        id: row.icpId,
        campaignName: row.icpCampaignName,
        targetAudience: row.icpTargetAudience,
        industry: row.icpIndustry,
        fitScore: row.icpFitScore,
      } : null,
      // Stats
      stats: {
        leadsCount: row.leadsCount || 0,
        contentCount: row.contentCount || 0,
        outreachCount: row.outreachCount || 0,
        adCopyCount: row.adCopyCount || 0,
        imageCount: row.imageCount || 0,
        videoCount: row.videoCount || 0,
      },
    }));

    res.json({
      threads,
      total,
      limit,
      offset,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching chat threads');
    res.status(500).json({ error: "Unable to retrieve chat threads. Please try again." });
  }
}

/**
 * GET /api/chat/threads/:id
 * Get a specific chat thread by ID
 */
export async function getChatThreadHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);
    if (isNaN(threadId)) {
      return res.status(400).json({ error: "Invalid thread ID" });
    }

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res
        .status(403)
        .json({ error: "Thread not found or access denied" });
    }

    const metadata = thread.metadata && typeof thread.metadata === 'object'
      ? thread.metadata as Record<string, unknown>
      : {};
    const workflowRun = metadata.workflowRun && typeof metadata.workflowRun === 'object'
      ? metadata.workflowRun as Record<string, unknown>
      : {};
    const snapshotStatus = workflowRun.status || metadata.workflowOutcome;
    const snapshotUpdatedAt = typeof workflowRun.updatedAt === 'string'
      ? Date.parse(workflowRun.updatedAt)
      : Number.NaN;
    const needsRecovery = snapshotStatus === 'running'
      && (!Number.isFinite(snapshotUpdatedAt) || Date.now() - snapshotUpdatedAt >= STALE_CHAT_TURN_MS);
    const latestRun = needsRecovery
      ? await getLatestConversationWorkflowRun(userId, threadId)
      : undefined;

    res.json(recoverStaleThreadWorkflowSnapshot(thread, latestRun));
  } catch (error) {
    logger.error({ err: error }, 'Error fetching chat thread');
    res.status(500).json({ error: "Unable to retrieve the chat thread. Please try again." });
  }
}

/**
 * GET /api/chat/threads/:id/stats
 * Get stats for a specific chat thread (leads count, avg ICP score, message count)
 */
export async function getChatThreadStatsHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);
    if (isNaN(threadId)) {
      return res.status(400).json({ error: "Invalid thread ID" });
    }

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res
        .status(403)
        .json({ error: "Thread not found or access denied" });
    }

    // Lead stats and message count in one statement: each standalone query
    // costs a pooled connection plus the tenant-scope setup round trips.
    const business = requireBusinessScope().businessProfileId;
    const stats = await db.execute(sql`
      SELECT lead_stats."leadsCount", lead_stats."avgIcpScore", message_stats."messageCount"
      FROM (
        SELECT
          COUNT(*)::integer as "leadsCount",
          ROUND(AVG(COALESCE(fit_score, 0)))::integer as "avgIcpScore"
        FROM leads
        WHERE user_id = ${userId} AND business_profile_id = ${business}
        AND deleted_at IS NULL
        AND id IN (${threadLeadIds(userId, business, threadId)})
      ) lead_stats, (
        SELECT COUNT(*)::integer as "messageCount"
        FROM chat_messages
        WHERE thread_id = ${threadId} AND user_id = ${userId} AND deleted_at IS NULL
      ) message_stats
    `);

    const leadsResult = stats.rows[0] || { leadsCount: 0, avgIcpScore: 0 };
    const messageResult = stats.rows[0] || { messageCount: 0 };

    res.json({
      leadsCount: leadsResult.leadsCount || 0,
      avgIcpScore: leadsResult.avgIcpScore || 0,
      messageCount: messageResult.messageCount || 0,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching chat thread stats');
    res.status(500).json({ error: "Unable to retrieve chat thread statistics. Please try again." });
  }
}

/**
 * GET /api/chat/threads/:id/details
 * Get detailed info for a specific chat thread including outreaches, content assets, and ads
 */
export async function getChatThreadDetailsHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = Number(req.params.id);
    const business = requireBusinessScope().businessProfileId;
    if (!isPostgresIntegerId(req.params.id)) {
      return res.status(400).json({ error: "Invalid thread ID" });
    }

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId || thread.businessProfileId !== business) {
      return res
        .status(403)
        .json({ error: "Thread not found or access denied" });
    }

    // Resolve module access first: it uses its own pooled connections and must
    // not run while the transaction below holds one.
    const crmEnabled = await threadReportingCrmEnabled(userId);
    const cohort = threadLeadIds(userId, business, threadId);
    // Every read below runs sequentially on one connection, so a page load
    // takes one pooled connection and one tenant-scope setup.
    const { leadsResult, outreachResult, contentAssetsResult, icpResult, summary } = await db.transaction(async (tx: typeof db) => {
    // Get leads for this thread
    const leadsResult = await tx.execute(sql`
      SELECT l.id, l.name, l.email, l.company, l.role as title, l.fit_score, l.source, COALESCE(NULLIF(l.lead_status,''),l.status) AS status, l.phone AS phone_no
      FROM leads l
      WHERE l.user_id = ${userId} AND l.business_profile_id=${business}
      AND l.deleted_at IS NULL
      AND l.id IN (${cohort})
      ORDER BY l.created_at DESC
      LIMIT 50
    `);

    // Get outreach messages (sent messages) for leads in this thread
    const outreachResult = await tx.execute(sql`
      SELECT sm.id, sm.lead_id, sm.lead_name, sm.channel, sm.message, sm.status, sm.sent_at,
             sm.image_url, sm.video_url
      FROM sent_messages sm
      JOIN leads l ON l.id = sm.lead_id AND l.user_id=sm.user_id AND l.business_profile_id=sm.business_profile_id
      WHERE l.user_id = ${userId} AND l.business_profile_id=${business}
      AND l.deleted_at IS NULL
      AND l.id IN (${cohort})
      AND sm.is_reply IS NOT TRUE
      ORDER BY sm.sent_at DESC
      LIMIT 50
    `);

    // Get content assets (ad templates) for this specific thread
    const contentAssetsResult = await tx.execute(sql`
      SELECT ca.id, ca.type, ca.title, ca.content, ca.channel, ca.status, ca.performance, ca.created_at
      FROM content_assets ca
      WHERE ca.thread_id = ${threadId}
      AND ca.user_id = ${userId} AND ca.business_profile_id=${business}
      ORDER BY ca.created_at DESC
      LIMIT 100
    `);

    // Get ICP profile for this thread
    const icpResult = await tx.execute(sql`
      SELECT id, campaign_name, target_audience, industry, fit_score, primary_regions, 
             primary_job_titles, target_business_model as business_model, primary_channels
      FROM icp_profiles
      WHERE thread_id = ${threadId} AND user_id = ${userId} AND business_profile_id=${business}
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const summary = await threadReporting(userId, threadId, tx, crmEnabled);
    return { leadsResult, outreachResult, contentAssetsResult, icpResult, summary };
    });
    const outreachStats = { total: summary.messages, sent: summary.sent, pending: summary.pending, byChannel: summary.byChannel };

    // Group content assets by type
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contentAssetsByType: Record<string, any[]> = {
      image: [],
      video: [],
      email: [],
      sms: [],
      social: [],
      ad_copy: [],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contentAssetsResult.rows.forEach((asset: any) => {
      const type = asset.type?.toLowerCase() || "other";
      if (contentAssetsByType[type]) {
        contentAssetsByType[type].push(asset);
      } else {
        // Handle 'social_post' or other variations
        if (type.includes("social")) {
          contentAssetsByType.social.push(asset);
        } else if (type.includes("email")) {
          contentAssetsByType.email.push(asset);
        } else if (type.includes("sms")) {
          contentAssetsByType.sms.push(asset);
        } else if (type.includes("ad") || type.includes("copy")) {
          contentAssetsByType.ad_copy.push(asset);
        } else if (type.includes("image")) {
          contentAssetsByType.image.push(asset);
        } else if (type.includes("video")) {
          contentAssetsByType.video.push(asset);
        }
      }
    });

    res.json({
      summary,
      thread: {
        id: thread.id,
        title: thread.title,
        agentType: thread.selectedAgent,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      },
      icp: icpResult.rows[0] || null,
      leads: {
        total: summary.leads,
        displayed: leadsResult.rows.length,
        hasMore: summary.leads > leadsResult.rows.length,
        items: leadsResult.rows,
      },
      outreaches: {
        stats: outreachStats,
        displayed: outreachResult.rows.length,
        hasMore: summary.messages > outreachResult.rows.length,
        items: outreachResult.rows,
      },
      contentAssets: {
        total: summary.contentAssets,
        displayed: contentAssetsResult.rows.length,
        hasMore: summary.contentAssets > contentAssetsResult.rows.length,
        items: contentAssetsResult.rows,
        byType: contentAssetsByType,
      },
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching chat thread details');
    res.status(500).json({ error: "Unable to retrieve chat thread details. Please try again." });
  }
}

/**
 * GET /api/chat/threads/:id/overview
 * Get a unified timeline overview for a thread: agent executions, ICP data, content assets,
 * leads generated, workflow logs, tool approvals, and active agents.
 */
export async function getChatThreadOverviewHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);
    if (isNaN(threadId)) {
      return res.status(400).json({ error: "Invalid thread ID" });
    }

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res.status(403).json({ error: "Thread not found or access denied" });
    }

    const business = requireBusinessScope().businessProfileId;
    const cohort = threadLeadIds(userId, business, threadId);
    // Run the reads one after another in one transaction: in parallel they could
    // take every pooled connection for a single page load, and each standalone
    // query repeats the tenant-scope setup round trips.
    const [
      agentExecResult,
      icpResult,
      icpAgentExecResult,
      leadsCountResult,
      contentResult,
      workflowLogResult,
      toolApprovalResult,
      threadStatsResult,
      workflowExecResult,
      outreachResult,
      scrapingResult,
      leadInputsResult,
    ] = await db.transaction(async (tx: typeof db) => {
      const queries = [
      // Agent executions for this thread
      () => tx.execute(sql`
        SELECT id, agent_type, action, status, duration_ms, created_at
        FROM agent_executions
        WHERE thread_id = ${threadId}
        ORDER BY created_at DESC
        LIMIT 50
      `),
      // ICP profile
      () => tx.execute(sql`
        SELECT id, campaign_name, target_audience, industry, fit_score, status, approved, created_at,
               primary_regions, primary_job_titles, primary_channels
        FROM icp_profiles
        WHERE thread_id = ${threadId} AND user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT 1
      `),
      // ICP agent executions (to track all ICP generation/update events with changes)
      () => tx.execute(sql`
        SELECT id, action, status, output, duration_ms, created_at
        FROM agent_executions
        WHERE thread_id = ${threadId}
        AND agent_type = 'icp_generation'
        ORDER BY created_at DESC
        LIMIT 20
      `),
      // Leads count
      () => tx.execute(sql`
        SELECT COUNT(*)::integer as count, MAX(created_at) as latest_at
        FROM leads
        WHERE user_id = ${userId}
        AND deleted_at IS NULL
        AND business_profile_id = ${business}
        AND id IN (${cohort})
      `),
      // Content assets summary
      () => tx.execute(sql`
        SELECT type, COUNT(*)::integer as count, MAX(created_at) as latest_at
        FROM content_assets
        WHERE thread_id = ${threadId} AND user_id = ${userId}
        GROUP BY type
        ORDER BY MAX(created_at) DESC
      `),
      // Workflow logs (key milestones only)
      () => tx.execute(sql`
        SELECT id, log_type, status, platform, actor_name, message, leads_count, total_leads,
               progress_percent, created_at
        FROM workflow_logs
        WHERE thread_id = ${threadId} AND user_id = ${userId}
        AND log_type IN ('workflow_start', 'workflow_complete', 'workflow_error', 'actor_start', 'actor_complete', 'actor_error', 'lead_saved', 'post_saved')
        ORDER BY created_at DESC
        LIMIT 50
      `),
      // Tool approvals
      () => tx.execute(sql`
        SELECT id, tool_name, agent_type, status, created_at, decided_at
        FROM tool_approvals
        WHERE thread_id = ${threadId} AND user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT 20
      `),
      // Thread stats (messages count)
      () => tx.execute(sql`
        SELECT COUNT(*)::integer as "messageCount"
        FROM chat_messages
        WHERE thread_id = ${threadId} AND user_id = ${userId} AND deleted_at IS NULL
      `),
      // Workflow activity executions
      () => tx.execute(sql`
        SELECT id, workflow_name, platforms, status, total_leads_expected, total_leads_generated,
               platforms_completed, platforms_total, is_paused, started_at, completed_at
        FROM workflow_activity_executions
        WHERE thread_id = ${threadId} AND user_id = ${userId}
        ORDER BY started_at DESC
        LIMIT 10
      `),
      // Outreach / sent messages for leads in this thread
      () => tx.execute(sql`
        SELECT sm.channel, COUNT(*)::integer as count, 
               COUNT(*) FILTER (WHERE sm.status = 'sent')::integer as sent_count,
               COUNT(*) FILTER (WHERE sm.status = 'delivered')::integer as delivered_count,
               COUNT(*) FILTER (WHERE sm.status = 'failed')::integer as failed_count,
               MAX(sm.sent_at) as latest_at
        FROM sent_messages sm
        JOIN leads l ON l.id = sm.lead_id
        WHERE l.user_id = ${userId}
        AND l.deleted_at IS NULL
        AND l.business_profile_id = ${business}
        AND l.id IN (${cohort})
        GROUP BY sm.channel
      `),
      // Scraping details for this thread
      () => tx.execute(sql`
        SELECT id, platform, status, total_leads_found, progress, started_at, completed_at, created_at
        FROM scraping_details
        WHERE thread_id = ${threadId} AND user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT 20
      `),
      // Lead inputs (search parameters configured per platform)
      () => tx.execute(sql`
        SELECT id, platform, inputs, actor_name, created_at
        FROM lead_inputs
        WHERE thread_id = ${threadId} AND user_id = ${userId}
        ORDER BY created_at DESC
        LIMIT 20
      `),
      ];
      const results: Awaited<ReturnType<typeof tx.execute>>[] = [];
      for (const query of queries) results.push(await query());
      return results;
    });

    // Build unified timeline events from all sources
    const timelineEvents: Array<{
      id: string;
      type: string;
      title: string;
      description: string;
      status?: string;
      agentType?: string;
      timestamp: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      metadata?: Record<string, any>;
    }> = [];

    // Add agent execution events (exclude icp_generation since they're handled separately)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of agentExecResult.rows as any[]) {
      if (row.agent_type === 'icp_generation') continue;
      timelineEvents.push({
        id: `agent-${row.id}`,
        type: 'agent_execution',
        title: `${formatAgentName(row.agent_type)} Agent`,
        description: row.action || 'Executed task',
        status: row.status,
        agentType: row.agent_type,
        timestamp: row.created_at,
        metadata: { durationMs: row.duration_ms },
      });
    }

    // Add ICP events from agent executions (shows all generate/update events with changes)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const icpProfile = (icpResult.rows as any[])[0];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const icpAgentExecs = icpAgentExecResult.rows as any[];
    if (icpAgentExecs.length > 0) {
      for (const row of icpAgentExecs) {
        const output = row.output || {};
        const isUpdate = output.isUpdate === true;
        const changes = output.changes || [];
        timelineEvents.push({
          id: `icp-exec-${row.id}`,
          type: isUpdate ? 'icp_updated' : 'icp_generated',
          title: isUpdate ? 'ICP Profile Updated' : 'ICP Profile Generated',
          description: isUpdate && changes.length > 0
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ? `${changes.length} field(s) updated: ${changes.map((c: any) => c.field).join(', ')}`
            : icpProfile?.campaign_name || icpProfile?.target_audience || 'Ideal Customer Profile created',
          status: row.status,
          agentType: 'icp_generation',
          timestamp: row.created_at,
          metadata: {
            durationMs: row.duration_ms,
            fitScore: output.fitScore,
            isUpdate,
            changes,
            ...(icpProfile ? {
              industry: icpProfile.industry,
              regions: icpProfile.primary_regions,
              channels: icpProfile.primary_channels,
            } : {}),
          },
        });
      }
    } else if (icpProfile) {
      // Fallback: if no agent executions exist yet, still show the ICP profile
      timelineEvents.push({
        id: `icp-${icpProfile.id}`,
        type: 'icp_generated',
        title: 'ICP Profile Generated',
        description: icpProfile.campaign_name || icpProfile.target_audience || 'Ideal Customer Profile created',
        status: icpProfile.approved ? 'approved' : icpProfile.status || 'generated',
        agentType: 'icp_generation',
        timestamp: icpProfile.created_at,
        metadata: {
          fitScore: icpProfile.fit_score,
          industry: icpProfile.industry,
          regions: icpProfile.primary_regions,
          channels: icpProfile.primary_channels,
        },
      });
    }

    // Add leads events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const leadsData = (leadsCountResult.rows as any[])[0];
    if (leadsData && leadsData.count > 0) {
      timelineEvents.push({
        id: `leads-summary`,
        type: 'leads_generated',
        title: 'Leads Generated',
        description: `${leadsData.count} leads collected`,
        status: 'completed',
        agentType: 'lead_generation',
        timestamp: leadsData.latest_at,
        metadata: { count: leadsData.count },
      });
    }

    // Add content asset events (grouped by type)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of contentResult.rows as any[]) {
      timelineEvents.push({
        id: `content-${row.type}`,
        type: 'content_created',
        title: `${formatContentType(row.type)} Created`,
        description: `${row.count} ${formatContentType(row.type).toLowerCase()}(s) generated`,
        status: 'completed',
        agentType: 'content_studio',
        timestamp: row.latest_at,
        metadata: { contentType: row.type, count: row.count },
      });
    }

    // Add workflow log events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of workflowLogResult.rows as any[]) {
      timelineEvents.push({
        id: `wf-${row.id}`,
        type: 'workflow_event',
        title: formatWorkflowLogType(row.log_type),
        description: row.message,
        status: row.status,
        timestamp: row.created_at,
        metadata: {
          platform: row.platform,
          actorName: row.actor_name,
          leadsCount: row.leads_count,
          totalLeads: row.total_leads,
          progressPercent: row.progress_percent,
        },
      });
    }

    // Add tool approval events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of toolApprovalResult.rows as any[]) {
      timelineEvents.push({
        id: `approval-${row.id}`,
        type: 'tool_approval',
        title: `Approval: ${formatToolName(row.tool_name)}`,
        description: `${row.status === 'approved' ? 'Approved' : row.status === 'rejected' ? 'Rejected' : 'Pending approval'}`,
        status: row.status,
        agentType: row.agent_type,
        timestamp: row.decided_at || row.created_at,
      });
    }

    // Add outreach events (grouped by channel)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of outreachResult.rows as any[]) {
      timelineEvents.push({
        id: `outreach-${row.channel}`,
        type: 'outreach_sent',
        title: `${formatChannelName(row.channel)} Outreach`,
        description: `${row.count} messages (${row.sent_count} sent, ${row.delivered_count} delivered${row.failed_count > 0 ? `, ${row.failed_count} failed` : ''})`,
        status: row.failed_count > 0 ? 'partial' : 'completed',
        agentType: 'outreach',
        timestamp: row.latest_at,
        metadata: { channel: row.channel, total: row.count, sent: row.sent_count, delivered: row.delivered_count, failed: row.failed_count },
      });
    }

    // Add scraping events
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of scrapingResult.rows as any[]) {
      timelineEvents.push({
        id: `scraping-${row.id}`,
        type: 'scraping_event',
        title: `${formatChannelName(row.platform)} Scraping`,
        description: `${row.total_leads_found || 0} leads found${row.progress != null ? ` · Execution progress: ${row.progress}%` : ''}`,
        status: row.status,
        agentType: 'lead_generation',
        timestamp: row.started_at || row.created_at,
        metadata: { platform: row.platform, totalLeadsFound: row.total_leads_found, progress: row.progress },
      });
    }

    // Add lead input events (search parameters configured per platform)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of leadInputsResult.rows as any[]) {
      const inputs = row.inputs || {};
      const platform = row.platform;
      const summary = formatLeadInputSummary(platform, inputs);
      timelineEvents.push({
        id: `lead-input-${row.id}`,
        type: 'lead_inputs_generated',
        title: `${formatPlatformName(platform)} Search Configured`,
        description: summary,
        status: 'completed',
        agentType: 'lead_generation',
        timestamp: row.created_at,
        metadata: { platform, actorName: row.actor_name, inputs },
      });
    }

    // Sort timeline by timestamp descending
    timelineEvents.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Build active agents list from recent executions
    const activeAgents = new Map<string, { agentType: string; lastAction: string; lastAt: string; status: string }>();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const row of agentExecResult.rows as any[]) {
      if (!activeAgents.has(row.agent_type)) {
        activeAgents.set(row.agent_type, {
          agentType: row.agent_type,
          lastAction: row.action || 'Task executed',
          lastAt: row.created_at,
          status: row.status,
        });
      }
    }

    res.json({
      thread: {
        id: thread.id,
        title: thread.title,
        createdAt: thread.createdAt,
        updatedAt: thread.updatedAt,
      },
      stats: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messageCount: (threadStatsResult.rows as any[])[0]?.messageCount || 0,
        leadsCount: leadsData?.count || 0,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        contentAssetsCount: (contentResult.rows as any[]).reduce((sum: number, r: any) => sum + (r.count || 0), 0),
        agentExecutionsCount: agentExecResult.rows.length,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        outreachCount: (outreachResult.rows as any[]).reduce((sum: number, r: any) => sum + (r.count || 0), 0),
        scrapingCount: scrapingResult.rows.length,
      },
      icp: icpProfile || null,
      activeAgents: Array.from(activeAgents.values()),
      workflowExecutions: workflowExecResult.rows,
      timeline: timelineEvents,
    });
  } catch (error) {
    logger.error({ err: error }, 'Error fetching chat thread overview');
    res.status(500).json({ error: "Unable to retrieve thread overview. Please try again." });
  }
}

// Helper formatters for timeline
function formatAgentName(agentType: string): string {
  const names: Record<string, string> = {
    orchestrator: 'Orchestrator',
    icp_generation: 'ICP Generation',
    lead_generation: 'Lead Generation',
    content_studio: 'Content Studio',
    outreach: 'Outreach',
    performance_marketing: 'Performance Marketing',
    analytics: 'Analytics',
  };
  return names[agentType] || agentType?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Unknown';
}

function formatContentType(type: string): string {
  const names: Record<string, string> = {
    image: 'Image',
    video: 'Video',
    email: 'Email',
    sms: 'SMS',
    social: 'Social Post',
    social_post: 'Social Post',
    ad_copy: 'Ad Copy',
    blog: 'Blog Post',
  };
  return names[type] || type?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Content';
}

function formatWorkflowLogType(logType: string): string {
  const names: Record<string, string> = {
    workflow_start: 'Workflow Started',
    workflow_complete: 'Workflow Completed',
    workflow_error: 'Workflow Error',
    actor_start: 'Scraping Started',
    actor_complete: 'Scraping Completed',
    actor_error: 'Scraping Error',
    lead_saved: 'Lead Saved',
    post_saved: 'Post Saved',
  };
  return names[logType] || logType?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Event';
}

function formatToolName(toolName: string): string {
  return toolName?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Tool';
}

function formatChannelName(channel: string): string {
  const names: Record<string, string> = {
    email: 'Email',
    sms: 'SMS',
    instagram: 'Instagram',
    whatsapp: 'WhatsApp',
    gmail: 'Gmail',
    linkedin: 'LinkedIn',
    facebook: 'Facebook',
    google_maps: 'Google Maps',
    justdial: 'JustDial',
    indiamart: 'IndiaMart',
    tradeindia: 'TradeIndia',
  };
  return names[channel?.toLowerCase()] || channel?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Channel';
}

function formatPlatformName(platform: string): string {
  const names: Record<string, string> = {
    linkedin: 'LinkedIn',
    google_maps: 'Google Maps',
    instagram: 'Instagram',
    twitter: 'Twitter',
    facebook: 'Facebook',
    justdial: 'JustDial',
    indiamart: 'IndiaMart',
    tradeindia: 'TradeIndia',
  };
  return names[platform] || platform?.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) || 'Unknown';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatLeadInputSummary(platform: string, inputs: Record<string, any>): string {
  const parts: string[] = [];
  const searchQuery = inputs.searchQuery || inputs.query || inputs.search;
  const searchArray = inputs.searchStringsArray || inputs.hashtags;
  const maxItems = inputs.maxItems || inputs.maxResults || inputs.maxCrawledPlacesPerSearch || inputs.resultsLimit || inputs.maxTweets;
  const location = inputs.locationQuery || inputs.location;
  const locations = inputs.locations;

  if (searchQuery) parts.push(`Query: "${searchQuery}"`);
  if (searchArray && Array.isArray(searchArray)) parts.push(`Search: ${searchArray.join(', ')}`);
  if (location) parts.push(`Location: ${location}`);
  if (locations && Array.isArray(locations)) parts.push(`Locations: ${locations.join(', ')}`);
  if (maxItems) parts.push(`Max: ${maxItems} results`);

  return parts.length > 0 ? parts.join(' · ') : 'Search parameters configured';
}

/**
 * POST /api/chat/threads
 * Create a new chat thread
 */
export async function createChatThreadHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Authentication required" });
    const { title, businessProfileId } = req.body;
    const businessId = businessProfileId === undefined
      ? undefined
      : parsePositiveInteger(businessProfileId);

    if (businessProfileId !== undefined && businessId === null) {
      return res.status(400).json({ error: "Invalid business profile ID" });
    }
    if (businessId && !(await userOwnsBusinessProfile(userId, businessId))) {
      return res.status(404).json({ error: "Business profile not found" });
    }

    const normalizedTitle = typeof title === 'string' ? title.trim() : undefined;
    if (normalizedTitle !== undefined && (normalizedTitle.length === 0 || normalizedTitle.length > 255)) {
      return res.status(400).json({ error: "Title must be between 1 and 255 characters" });
    }

    const thread = await createChatThread(userId, normalizedTitle, businessId ?? undefined);
    res.status(201).json(thread);
  } catch (error) {
    logger.error({ err: error }, 'Error creating chat thread');
    res.status(500).json({ error: "Unable to create the chat thread. Please try again." });
  }
}

/**
 * PATCH /api/chat/threads/:id
 * PUT /api/chat/threads/:id
 * Update chat thread (title, businessId, etc.)
 */
export async function updateChatThreadHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parsePositiveInteger(req.params.id);
    const { title, businessId } = req.body;

    if (threadId === null) {
      return res.status(400).json({ error: "Invalid thread ID" });
    }

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res
        .status(404)
        .json({ error: "Thread not found" });
    }

    // Validate the whole edit before persisting any part of it.
    if (title !== undefined) {
      if (typeof title !== 'string' || title.trim().length === 0 || title.trim().length > 255) {
        return res.status(400).json({ error: "Title must be between 1 and 255 characters" });
      }
    }
    let parsedBusinessId: number | null = null;
    if (businessId !== undefined) {
      parsedBusinessId = businessId === null ? null : parsePositiveInteger(businessId);
      if (businessId !== null && parsedBusinessId === null) {
        return res.status(400).json({ error: "Invalid business profile ID" });
      }
      if (parsedBusinessId && !(await userOwnsBusinessProfile(userId, parsedBusinessId))) {
        return res.status(404).json({ error: "Business profile not found" });
      }
    }

    // One statement is an atomic persistence boundary. CASE retains the current
    // database value for omitted fields, including edits made in another tab.
    if (title !== undefined || businessId !== undefined) {
      await db.execute(sql`
        UPDATE chat_threads
        SET title = CASE WHEN ${title !== undefined} THEN ${typeof title === 'string' ? title.trim() : null} ELSE title END,
            business_id = CASE WHEN ${businessId !== undefined} THEN ${parsedBusinessId} ELSE business_id END,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ${threadId} AND user_id = ${userId}
      `);
    }
    
    // Fetch and return updated thread
    const updatedThread = await getChatThreadById(threadId);
    res.json(updatedThread);
  } catch (error) {
    logger.error({ err: error }, 'Error updating chat thread');
    res.status(500).json({ error: "Unable to update the chat thread. Please try again." });
  }
}

/**
 * DELETE /api/chat/threads/:id
 * Delete chat thread and all its messages
 */
export async function deleteChatThreadHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);

    // The model checks owned rows, including a prior successful tombstone,
    // under the same lock/transaction as both soft-delete updates.
    if (!await softDeleteChatThread(threadId, userId)) {
      return res
        .status(403)
        .json({ error: "Thread not found or access denied" });
    }

    res.status(204).send();
  } catch (error) {
    logger.error({ err: error }, 'Error deleting chat thread');
    res.status(500).json({ error: "Unable to delete the chat thread. Please try again." });
  }
}

/**
 * GET /api/chat/threads/:id/messages
 * Get messages for a specific thread
 *
 * M5: Supports cursor-based pagination for infinite scroll.
 *   - ?limit=50 (default, max 200)
 *   - ?cursor=<messageId> (cursor = last message id from previous page; omit for first page)
 *
 * M1: Supports fetching missed messages after reconnect.
 *   - ?since=<ISO timestamp> (returns all messages after this timestamp, max 100)
 *
 * Returns { messages, nextCursor, hasMore } for pagination,
 * or { messages, missedCount } when `since` is used.
 */
export async function getChatThreadMessagesHandler(
  req: Request,
  res: Response
) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parsePositiveInteger(req.params.id);
    if (threadId === null) return res.status(400).json({ error: 'Invalid thread ID' });
    const sinceParam = req.query.since as string | undefined;
    const rawCursor = sinceParam ? req.query.sinceId : req.query.cursor;
    const requestedCursor = rawCursor === undefined ? undefined : Number(rawCursor);
    if (requestedCursor !== undefined && !isPostgresIntegerId(requestedCursor)) {
      return res.status(400).json({ error: sinceParam ? "Invalid 'sinceId' cursor" : 'Invalid message cursor' });
    }

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res
        .status(403)
        .json({ error: "Thread not found or access denied" });
    }

    // M1: Fetch missed messages since a given timestamp (used on WS reconnect).
    if (sinceParam) {
      const sinceDate = new Date(sinceParam);
      if (isNaN(sinceDate.getTime())) {
        return res.status(400).json({ error: "Invalid 'since' timestamp" });
      }
      // Import here to avoid circular deps at module load time
      const { db } = await import('../models/db.js');
      const { chatMessagesTable } = await import('../models/chatMessages/schema.js');
      const { eq, and, isNull, gt, asc } = await import('drizzle-orm');
      const NOT_DELETED = isNull(chatMessagesTable.deletedAt);
      const sinceIdParam = requestedCursor;
      const afterCursor = sinceIdParam
        // Resolve the durable anchor in PostgreSQL so reconnect pagination
        // retains its microseconds. The client ISO timestamp has only millis.
        // A soft-deleted anchor still defines the previously received boundary.
        ? sql`(${chatMessagesTable.createdAt}, ${chatMessagesTable.id}) > (
            SELECT ${chatMessagesTable.createdAt}, ${chatMessagesTable.id}
            FROM ${chatMessagesTable}
            WHERE ${chatMessagesTable.threadId} = ${threadId}
              AND ${chatMessagesTable.userId} = ${userId}
              AND ${chatMessagesTable.id} = ${sinceIdParam}
          )`
        : gt(chatMessagesTable.createdAt, sinceDate);
      const missedMessages = await db.select()
        .from(chatMessagesTable)
        .where(
          and(
            eq(chatMessagesTable.threadId, threadId),
            eq(chatMessagesTable.userId, userId),
            NOT_DELETED,
            afterCursor,
          )
        )
        .orderBy(asc(chatMessagesTable.createdAt), asc(chatMessagesTable.id))
        .limit(101);
      const hasMore = missedMessages.length > 100;
      const pageMessages = missedMessages.slice(0, 100);
      const projectedMessages = await projectMessageApprovalDecisions(userId, threadId, pageMessages);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sanitizedMissed = projectedMessages.map((msg: any) => ({
        ...msg,
        metadata: sanitizeMessageMetadata(msg.metadata),
      }));
      const lastMessage = pageMessages.at(-1);
      return res.json({
        messages: sanitizedMissed,
        missedCount: pageMessages.length,
        hasMore,
        nextSince: lastMessage?.createdAt?.toISOString?.() || null,
        nextSinceId: lastMessage?.id || null,
      });
    }

    // M5: Cursor-based pagination
    const requestedLimit = Number(req.query.limit ?? 50);
    const limit = Number.isInteger(requestedLimit)
      ? Math.min(Math.max(requestedLimit, 1), 200)
      : 50;
    const cursor = requestedCursor as number | undefined;

    const { getChatMessagesByThreadIdCursor } = await import('../models/chatMessages/functions.js');
    const result = await getChatMessagesByThreadIdCursor(threadId, limit, cursor);
    result.messages = await projectMessageApprovalDecisions(userId, threadId, result.messages);
    if (result.messages && Array.isArray(result.messages)) {
      result.messages = result.messages.map(msg => ({
        ...msg,
        metadata: sanitizeMessageMetadata(msg.metadata),
      }));
    }
    res.json(result);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching thread messages');
    res.status(500).json({ error: "Unable to retrieve thread messages. Please try again." });
  }
}

/**
 * POST /api/chat/threads/:id/generate-icp
 * Manually generate ICP from conversation thread
 */
export async function generateICPFromThreadHandler(
  req: Request,
  res: Response
) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res
        .status(403)
        .json({ error: "Thread not found or access denied" });
    }

    // Get conversation history
    const messages = await chatHistoryManager.getMessages(threadId, 'icp_generation');
    const conversationHistory = messages
      .filter((msg) => msg.role === "user")
      .map((msg) => ({
        role: msg.role,
        content: msg.content,
      }));

    if (conversationHistory.length === 0) {
      return res
        .status(400)
        .json({ error: "No user messages in thread to generate ICP from" });
    }

    // Generate ICP from conversation
    const lastUserMessage =
      conversationHistory[conversationHistory.length - 1].content;

    // Get or create workflow session
    const workflowId = await getOrCreateWorkflowSession(userId, threadId);
    logger.info(
      { workflowId },
      '[ChatController] Workflow session for handleLeadAgentRun'
    );

    const icpResult = await icpService.generateICP({
      userMessage: lastUserMessage,
      conversationHistory,
      userId,
      threadId,
      workflowId,
    });

    if (!icpResult.success) {
      return sendErrorResponse(res, icpResult.error || 'The ICP could not be generated. Your conversation is kept; please try again.', icpResult.errorStatus ?? 500, icpResult.errorCode ?? 'ICP_GENERATION_FAILED');
    }

    // Check if ICP needs more information
    if (
      icpResult.needsMoreClarificationFields &&
      icpResult.needsMoreClarificationFields.length > 0
    ) {
      return res.status(200).json({
        success: false,
        needsClarification: true,
        clarificationMessage: icpResult.clarificationMessage,
        missingFields: icpResult.needsMoreClarificationFields,
        partialICP: icpResult.icp,
      });
    }

    // Save ICP
    const icpId = await icpService.saveICP(userId, icpResult.icp!, threadId);
    const recommendedAgents = icpService.getRecommendedAgents(icpResult.icp!);
    const fitScore = icpResult.icp!.fitScore || 0;
    const shouldShowAgents = fitScore >= 90;

    res.json({
      success: true,
      icp: icpResult.icp,
      icpId,
      fitScore,
      recommendedAgents: shouldShowAgents ? recommendedAgents : [],
      showAgentSuggestions: shouldShowAgents,
      message: `ICP generated from conversation with ${fitScore}% fit score`,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error generating ICP from thread');
    res
      .status(500)
      .json({ error: "Unable to generate ICP from thread. Please try again." });
  }
}

/**
 * POST /api/chat/threads/:id/tabs
 * Save a tab configuration for a chat thread
 *
 * M4: tabType is validated against the shared TAB_TYPES whitelist before
 * persisting. Unknown tab types are rejected with HTTP 400 and the attempt
 * is logged for abuse monitoring.
 */
export async function saveChatTabConfigHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);
    const { tabId, tabType, tabLabel, tabOrder, isActive, tabData } = req.body;

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res
        .status(403)
        .json({ error: "Thread not found or access denied" });
    }

    // Validate required fields
    if (!tabType || !tabLabel) {
      return res
        .status(400)
        .json({ error: "tabType and tabLabel are required" });
    }

    // M4: Validate tabType against the shared TAB_TYPES whitelist.
    // Import the same whitelist used by the LangGraph agent layer.
    const { TAB_TYPES } = await import('../shared/agents/tabConfig.js');
    const validTabTypes = new Set(Object.values(TAB_TYPES));
    if (!validTabTypes.has(tabType)) {
      logger.warn({ userId, threadId, tabType }, '[ChatController] Invalid tabType rejected');
      return res
        .status(400)
        .json({ error: `Invalid tabType: "${tabType}". Must be one of: ${[...validTabTypes].join(', ')}` });
    }

    const tabConfig = await saveChatTabConfig(
      threadId,
      tabId,
      tabType,
      tabLabel,
      tabOrder || 0,
      isActive || false,
      tabData || {},
    );

    res.status(201).json(tabConfig);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error saving chat tab config');
    res
      .status(500)
      .json({ error: "Unable to save chat tab configuration. Please try again." });
  }
}

/**
 * GET /api/chat/threads/:id/tabs
 * Get all tab configurations for a chat thread
 */
export async function getChatTabConfigsHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res
        .status(403)
        .json({ error: "Thread not found or access denied" });
    }

    const tabConfigs = await getChatTabConfigs(threadId);
    res.json(tabConfigs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error fetching chat tab configs');
    res
      .status(500)
      .json({ error: "Unable to retrieve chat tab configurations. Please try again." });
  }
}

/**
 * DELETE /api/chat/threads/:id/tabs/:tabId
 * Delete a tab configuration for a chat thread
 */
export async function deleteChatTabConfigHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);
    const tabId = req.params.tabId;

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res
        .status(403)
        .json({ error: "Thread not found or access denied" });
    }

    await deleteChatTabConfig(threadId, tabId);
    res.status(204).send();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error deleting chat tab config');
    res
      .status(500)
      .json({ error: "Unable to delete the chat tab configuration. Please try again." });
  }
}

/**
 * PUT /api/chat/threads/:id/tabs
 * Replace all tab configurations for a chat thread
 */
export async function replaceChatTabConfigsHandler(
  req: Request,
  res: Response
) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);
    const { tabs } = req.body;

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res
        .status(403)
        .json({ error: "Thread not found or access denied" });
    }

    // Validate tabs array
    if (!Array.isArray(tabs)) {
      return res.status(400).json({ error: "tabs must be an array" });
    }
    if (tabs.length > 50) {
      return res.status(400).json({ error: "A thread can have at most 50 tabs" });
    }

    // Validate each tab has required fields
    const { TAB_TYPES } = await import('../shared/agents/tabConfig.js');
    const validTabTypes = new Set<string>(Object.values(TAB_TYPES));
    const seenTabIds = new Set<string>();
    for (const tab of tabs) {
      if (!tab.tabId || !tab.tabType || !tab.tabLabel) {
        return res
          .status(400)
          .json({ error: "Each tab must have tabId, tabType, and tabLabel" });
      }
      if (
        typeof tab.tabId !== 'string' || tab.tabId.length > 100 ||
        typeof tab.tabLabel !== 'string' || tab.tabLabel.length > 255 ||
        !validTabTypes.has(tab.tabType)
      ) {
        return res.status(400).json({ error: "One or more tab configurations are invalid" });
      }
      if (seenTabIds.has(tab.tabId)) {
        return res.status(400).json({ error: "Tab IDs must be unique" });
      }
      seenTabIds.add(tab.tabId);
    }

    const tabConfigs = await replaceChatTabConfigs(threadId, tabs);
    res.status(200).json(tabConfigs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error replacing chat tab configs');
    res
      .status(500)
      .json({ error: "Unable to replace chat tab configurations. Please try again." });
  }
}

/**
 * GET /api/chat/threads/:id/tabs-loaded
 * Get all tab configurations for a chat thread at startup
 */
export async function getChatTabsForLoadingHandler(
  req: Request,
  res: Response
) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res
        .status(403)
        .json({ error: "Thread not found or access denied" });
    }

    const tabConfigs = await getChatTabConfigs(threadId);
    res.json({ tabs: tabConfigs || [] });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error fetching chat tabs for loading');
    res
      .status(500)
      .json({ error: "Unable to retrieve chat tabs. Please try again.", tabs: [] });
  }
}

/**
 * GET /api/workflows/existing-inputs/:threadId
 * Check if lead inputs already exist for this thread
 */
export async function getExistingLeadInputsHandler(
  req: Request,
  res: Response
) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parsePositiveInteger(req.params.threadId);

    if (threadId === null) {
      return res.status(400).json({ error: "Invalid thread ID" });
    }

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res
        .status(404)
        .json({ error: "Thread not found" });
    }

    const result = await getLatestLeadInputsForUIByThreadId(threadId);
    res.json(result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error(
      { err: error },
      '[ChatController] Error getting existing lead inputs'
    );
    res
      .status(500)
      .json({ error: "Unable to retrieve existing lead inputs. Please try again." });
  }
}

/**
 * PUT /api/chat/threads/:id/active-tab
 * Update the active tab for a chat thread
 */
export async function updateActiveTabHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);
    const { activeTabId } = req.body;

    // Verify thread belongs to user
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res
        .status(403)
        .json({ error: "Thread not found or access denied" });
    }

    if (!activeTabId) {
      return res.status(400).json({ error: "activeTabId is required" });
    }

    const updated = await updateActiveTab(threadId, activeTabId);
    if (!updated) {
      return res.status(404).json({ error: "Tab not found" });
    }
    res.status(200).json({ message: "Active tab updated successfully" });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error updating active tab');
    res
      .status(500)
      .json({ error: "Unable to update the active tab. Please try again." });
  }
}

/**
 * Get latest lead inputs by thread ID
 */
export async function getLatestLeadInputsHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const threadId = parsePositiveInteger(req.params.threadId);

    if (threadId === null) {
      return res.status(400).json({ error: "Invalid thread ID" });
    }
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res.status(404).json({ error: "Thread not found" });
    }

    const leadInputs = await getLatestLeadInputsByThreadId(threadId);

    return res.status(200).json(leadInputs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ChatController] Error fetching lead inputs');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

/**
 * Get latest scraping details by thread ID
 */
export async function getLatestScrapingDetailsHandler(
  req: Request,
  res: Response
) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    const threadId = parsePositiveInteger(req.params.threadId);

    if (threadId === null) {
      return res.status(400).json({ error: "Invalid thread ID" });
    }
    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res.status(404).json({ error: "Thread not found" });
    }

    const scrapingDetails = await getLatestScrapingDetailsByThreadId(threadId);

    // A provider heartbeat is updated every poll while a process owns it. If
    // it is stale after a reload/restart, lease it once and resume the exact
    // persisted actor run in the background. The deterministic execution IDs
    // and provider receipts make this safe across repeated page reloads.
    if (!recoveringLeadThreads.has(threadId)) {
      const staleBefore = new Date(Date.now() - 30_000);
      const recoverableRuns = await claimRecoverableLeadGenerationProviderRunsForThread(
        threadId,
        Number(userId),
        staleBefore,
      );
      if (recoverableRuns.length > 0) {
        const leadInputId = Number(recoverableRuns[0]?.leadInputId);
        const oneReviewedInput = Number.isInteger(leadInputId) && leadInputId > 0
          && recoverableRuns.every(run => run.leadInputId === leadInputId);
        const approvedInputSet = oneReviewedInput
          ? await getApprovedLeadInputSetForLeadInput({
              leadInputId,
              userId: Number(userId),
              threadId,
            })
          : undefined;

        if (!approvedInputSet) {
          logger.error(
            { threadId, providerRunIds: recoverableRuns.map(run => run.id) },
            '[ChatController] Refusing lead recovery without an exact approved input revision',
          );
        } else {
          recoveringLeadThreads.add(threadId);
          void import('../mastra/tools/executors/leadExecutor.js')
            .then(({ executeLeadWorkflow }) => executeLeadWorkflow(
              {
                thread_id: threadId,
                workflowRunId: approvedInputSet.runId,
                leadInputSetId: approvedInputSet.id,
                leadInputSetRevision: approvedInputSet.revision,
              },
              { userId: Number(userId), threadId },
            ))
            .catch((recoveryError) => {
              logger.error({ err: recoveryError, threadId }, '[ChatController] Interrupted lead workflow recovery failed');
            })
            .finally(() => recoveringLeadThreads.delete(threadId));
        }
      }
    }

    return res.status(200).json(scrapingDetails);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ChatController] Error fetching scraping details');
    return res.status(500).json({ error: 'An unexpected error occurred. Please try again.' });
  }
}

/**
 * Update lead inputs for a specific platform
 */
export async function updateLeadInputsHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { threadId } = req.params;
    const { id, platform, inputs, recommendedSubWorkflows } = req.body;

    if (!platform && !id) {
      return res
        .status(400)
        .json({ error: "Platform or id is required" });
    }
    if (!inputs && !recommendedSubWorkflows) {
      return res
        .status(400)
        .json({ error: "inputs or recommendedSubWorkflows are required" });
    }

    const threadIdNum = parsePositiveInteger(threadId);
    if (threadIdNum === null) {
      return res.status(400).json({ error: "Invalid threadId" });
    }
    const thread = await getChatThreadById(threadIdNum);
    if (!thread || thread.userId !== userId) {
      return res.status(404).json({ error: "Thread not found" });
    }

    // ID-based update (for multi-search: update a specific record)
    if (id) {
      const { updateLeadInputById } = await import(
        "../models/leadInputs/functions"
      );
      const leadInputId = parsePositiveInteger(id);
      if (leadInputId === null) {
        return res.status(400).json({ error: "Invalid lead input ID" });
      }
      const updated = await updateLeadInputById(
        leadInputId,
        threadIdNum,
        userId,
        inputs || undefined,
        recommendedSubWorkflows || undefined
      );
      if (!updated) {
        return res.status(404).json({ error: "Lead input not found" });
      }
      return res.json({
        success: true,
        message: "Lead inputs updated successfully",
        updated: { id: updated.id, platform: updated.platform, inputs: updated.inputs, updatedAt: updated.createdAt },
      });
    }

    logger.info(
      { threadId: threadIdNum, platform },
      '[ChatController] Updating lead inputs'
    );

    const { updateLeadInputByThreadAndPlatform } = await import(
      "../models/leadInputs/functions"
    );
    const updated = await updateLeadInputByThreadAndPlatform(
      threadIdNum,
      userId,
      platform,
      inputs || undefined,
      recommendedSubWorkflows || undefined
    );

    if (!updated) {
      return res
        .status(404)
        .json({ error: "Lead inputs not found for this thread and platform" });
    }

    res.json({
      success: true,
      message: "Lead inputs updated successfully",
      updated: {
        platform: updated.platform,
        inputs: updated.inputs,
        updatedAt: updated.createdAt,
      },
    });
  } catch (error: unknown) {
    logger.error({ err: error }, '[ChatController] Error updating lead inputs');
    res.status(500).json({ error: "Unable to update lead inputs. Please try again." });
  }
}

export async function deleteLeadInputsHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { threadId, platform } = req.params;

    if (!platform) {
      return res.status(400).json({ error: "Platform is required" });
    }

    const threadIdNum = parsePositiveInteger(threadId);
    if (threadIdNum === null) {
      return res.status(400).json({ error: "Invalid threadId" });
    }
    const thread = await getChatThreadById(threadIdNum);
    if (!thread || thread.userId !== userId) {
      return res.status(404).json({ error: "Thread not found" });
    }

    // Numeric param → ID-based delete (targets one specific record from multi-search)
    const numericId = parseInt(platform, 10);
    if (!isNaN(numericId) && String(numericId) === platform) {
      const { deleteLeadInputById } = await import(
        "../models/leadInputs/functions"
      );
      const deleted = await deleteLeadInputById(numericId, threadIdNum, userId);
      if (!deleted) {
        return res.status(404).json({ error: "Lead input not found" });
      }
      return res.json({ success: true, message: "Lead input deleted successfully", id: numericId });
    }

    logger.info(
      { threadId: threadIdNum, platform },
      '[ChatController] Deleting lead inputs'
    );

    const { deleteLeadInputByThreadAndPlatform } = await import(
      "../models/leadInputs/functions"
    );
    const deleted = await deleteLeadInputByThreadAndPlatform(
      threadIdNum,
      userId,
      platform
    );

    if (!deleted) {
      return res
        .status(404)
        .json({ error: "Lead inputs not found for this thread and platform" });
    }

    res.json({
      success: true,
      message: "Lead inputs deleted successfully",
      platform,
    });
  } catch (error: unknown) {
    logger.error({ err: error }, '[ChatController] Error deleting lead inputs');
    res.status(500).json({ error: "Unable to delete lead inputs. Please try again." });
  }
}

// ─── Context Window / Compaction Endpoints ──────────────────────────────────────

/**
 * GET /api/chat/threads/:id/context-window
 * Returns the context window info: token usage, latest summary, message counts.
 *
 * Context calculation (like Claude Code / GitHub Copilot):
 * - Uses the promptTokens from the most recent LLM call as "current context usage"
 *   because promptTokens = system prompt + tools + conversation history = actual window usage.
 * - Falls back to word-count estimation when no usage records exist yet.
 */
export async function getContextWindowHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);
    if (isNaN(threadId)) return res.status(400).json({ error: "Invalid thread ID" });

    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res.status(404).json({ error: "Thread not found" });
    }

    const contextData = await computeContextWindowData(threadId);

    res.json(contextData);
  } catch (error) {
    logger.error({ err: error }, '[ChatController] Error getting context window');
    res.status(500).json({ error: "Unable to retrieve context window info." });
  }
}

/**
 * Compute context window data for a thread.
 * Shared between the REST endpoint and the WebSocket context_update emitter.
 */
export async function computeContextWindowData(threadId: number) {
  // ─── Configurable overheads for breakdown ─────────────────────────────
  const SYSTEM_INSTRUCTIONS_TOKENS = 1800;  // System prompt + persona
  const TOOL_DEFINITIONS_TOKENS = 1200;     // Tool schemas sent per call

  // Get message count
  const allMessages = await chatHistoryManager.getMessages(threadId, 'all');
  const messageCount = allMessages.length;

  // Get token usage records for this thread (ordered DESC by created_at)
  const { getOpenAIUsagesByThreadId } = await import("../models/openaiUsages/functions");
  const usages = await getOpenAIUsagesByThreadId(threadId);
  const totalTokens = usages.reduce((sum, u) => sum + (u.totalTokens || 0), 0);
  const promptTokens = usages.reduce((sum, u) => sum + (u.promptTokens || 0), 0);
  const completionTokens = usages.reduce((sum, u) => sum + (u.completionTokens || 0), 0);

  // Determine the model used most recently
  const lastUsage = usages[0]; // Already ordered DESC
  const modelName = lastUsage?.model || 'gpt-4o';
  const maxContextTokens = getContextWindowForModel(modelName);

  // ─── Compute per-category token estimates from recent messages ────────
  const recentMessages = allMessages.slice(0, LANGGRAPH_CONTEXT_MESSAGE_LIMIT);
  let userMessageTokens = 0;
  let assistantMessageTokens = 0;
  let toolCallTokens = 0;
  let toolResultTokens = 0;
  let summaryTokens = 0;

  for (const m of recentMessages) {
    let tokens = countTokens(m.content || '');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const meta = m.metadata as any;

    if (meta?.isToolCall) {
      // Include tool arguments in token estimate — they're sent to the LLM
      if (meta.toolArgs) {
        const argsStr = typeof meta.toolArgs === 'string' ? meta.toolArgs : JSON.stringify(meta.toolArgs);
        tokens += countTokens(argsStr);
      }
      toolCallTokens += tokens;
    } else if (meta?.isToolResult) {
      // Include tool output in token estimate — it's part of the context
      if (meta.toolOutput) {
        const outputStr = typeof meta.toolOutput === 'string' ? meta.toolOutput : JSON.stringify(meta.toolOutput);
        tokens += countTokens(outputStr);
      }
      toolResultTokens += tokens;
    } else if (m.role === 'user') {
      userMessageTokens += tokens;
    } else {
      assistantMessageTokens += tokens;
    }
  }

  // Check for compaction summary included in context
  let latestSummary = null;
  try {
    const { getLatestSummaryByThreadId } = await import("../models/chatSummaries/functions");
    latestSummary = await getLatestSummaryByThreadId(threadId);
    if (latestSummary?.summaryText) {
      summaryTokens = countTokens(latestSummary.summaryText);
    }
  } catch (err) {
    logger.warn({ err, threadId }, '[ChatController] Could not load summary');
  }

  // ─── Current context usage ────────────────────────────────────────────
  // Use ACTUAL prompt tokens from the most recent LLM call when available.
  // promptTokens in the last call = everything sent to the model.
  // Some providers (e.g. Gemini) may report unrealistically low token counts;
  // fall back to estimation if the reported value seems implausible.
  let estimatedCurrentContextTokens: number;
  let hasActualUsage = false;

  // Estimate from message text + system prompt overhead
  const estimatedFromMessages = SYSTEM_INSTRUCTIONS_TOKENS + TOOL_DEFINITIONS_TOKENS
    + userMessageTokens + assistantMessageTokens + toolCallTokens + toolResultTokens + summaryTokens;

  // Minimum plausible prompt tokens: at least half the message-based estimate
  // (e.g. 57 tokens for 71 messages / 70K history is clearly wrong)
  const minPlausibleTokens = Math.max(500, Math.round(estimatedFromMessages * 0.5));

  if (lastUsage?.promptTokens && lastUsage.promptTokens >= minPlausibleTokens) {
    estimatedCurrentContextTokens = lastUsage.promptTokens;
    hasActualUsage = true;

    // Scale the estimated breakdown to match the actual total.
    if (estimatedFromMessages > 0) {
      const scale = estimatedCurrentContextTokens / estimatedFromMessages;
      userMessageTokens = Math.round(userMessageTokens * scale);
      assistantMessageTokens = Math.round(assistantMessageTokens * scale);
      toolCallTokens = Math.round(toolCallTokens * scale);
      toolResultTokens = Math.round(toolResultTokens * scale);
      summaryTokens = Math.round(summaryTokens * scale);
    }
  } else {
    // Fallback: use message-based estimation
    estimatedCurrentContextTokens = estimatedFromMessages;
  }

  // Get thread metadata for compaction info
  const thread = await getChatThreadById(threadId);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const meta = (thread?.metadata as any) || {};

  const usagePercent = Math.min(100, Math.round((estimatedCurrentContextTokens / maxContextTokens) * 100));

  return {
    threadId,
    messageCount,
    tokenUsage: {
      totalTokens,
      promptTokens,
      completionTokens,
      estimatedCurrentContextTokens,
      maxContextTokens,
      modelName,
      usagePercent,
    },
    contextBreakdown: {
      systemInstructions: SYSTEM_INSTRUCTIONS_TOKENS,
      toolDefinitions: TOOL_DEFINITIONS_TOKENS,
      userMessages: userMessageTokens,
      assistantMessages: assistantMessageTokens,
      toolCalls: toolCallTokens,
      toolResults: toolResultTokens,
      summary: summaryTokens,
      hasActualUsage,
    },
    summary: latestSummary ? {
      id: latestSummary.id,
      text: latestSummary.summaryText,
      keyEntities: latestSummary.keyEntities,
      timeline: latestSummary.timeline,
      version: latestSummary.version,
      messageCount: latestSummary.messageCount,
      createdAt: latestSummary.createdAt,
    } : null,
    lastCompactedAt: meta.lastCompactedAt || null,
    canCompact: messageCount > 1,
  };
}

/**
 * POST /api/chat/threads/:id/compact
 * Trigger conversation compaction for a thread.
 */
export async function compactThreadHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);
    if (isNaN(threadId)) return res.status(400).json({ error: "Invalid thread ID" });

    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res.status(404).json({ error: "Thread not found" });
    }

    const { conversationCompactionService } = await import("../services/ConversationCompactionService");
    const result = await conversationCompactionService.compact(userId, threadId);

    res.json({
      success: true,
      summary: {
        id: result.summaryId,
        text: result.summaryText,
        keyEntities: result.keyEntities,
        timeline: result.timeline,
        version: result.version,
        messageCount: result.messageCount,
        tokenCounts: result.tokenCounts,
      },
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[ChatController] Error compacting thread');
    res.status(500).json({ error: "Unable to compact conversation." });
  }
}

/**
 * GET /api/chat/threads/:id/summary
 * Get the latest compaction summary for a thread.
 */
export async function getThreadSummaryHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const threadId = parseInt(req.params.id);
    if (isNaN(threadId)) return res.status(400).json({ error: "Invalid thread ID" });

    const thread = await getChatThreadById(threadId);
    if (!thread || thread.userId !== userId) {
      return res.status(404).json({ error: "Thread not found" });
    }

    const { getLatestSummaryByThreadId, getSummariesByThreadId } = await import("../models/chatSummaries/functions");
    const latest = await getLatestSummaryByThreadId(threadId);
    const allSummaries = await getSummariesByThreadId(threadId);

    if (!latest) {
      return res.json({ summary: null, history: [] });
    }

    res.json({
      summary: {
        id: latest.id,
        text: latest.summaryText,
        keyEntities: latest.keyEntities,
        timeline: latest.timeline,
        version: latest.version,
        messageCount: latest.messageCount,
        fromMessageId: latest.fromMessageId,
        toMessageId: latest.toMessageId,
        createdAt: latest.createdAt,
      },
      history: allSummaries.map(s => ({
        id: s.id,
        version: s.version,
        messageCount: s.messageCount,
        createdAt: s.createdAt,
      })),
    });
  } catch (error) {
    logger.error({ err: error }, '[ChatController] Error getting thread summary');
    res.status(500).json({ error: "Unable to retrieve thread summary." });
  }
}
