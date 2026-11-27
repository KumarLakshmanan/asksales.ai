// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as crypto from 'crypto';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import * as jsonpath from 'jsonpath';
import Mustache from 'mustache';
import { ApifyClient } from 'apify-client';
import { v4 as uuidv4 } from 'uuid';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../models/db';
import { leadsTable } from '../models/leads/schema';
import { postsTable } from '../models/posts/schema';
import { webSocketEmitter } from './agents/WebSocketEmitter';
import { ActorSchemaRegistry } from './workflow/ActorSchemaRegistry';
import {
  APIFY_ACCOUNTS_UNAVAILABLE_MESSAGE,
  apifyCredentialRefusalNote,
  apifyRefusalReason,
  isApifyAccountWideCapacityError,
  isApifyCredentialCapacityError,
  isRateLimitError,
  handleRateLimitAndGetNextKey,
  ApiKeyResult
} from './apiKeyFallbackService';
import {
  getNextAdminCredentialForActor,
  getNextActiveAdminCredential,
  markAdminCredentialInactive,
  updateAdminCredentialValidation,
} from '../models/adminApiCredentials/functions';
import {
  createWorkflowLog,
  createWorkflowExecution,
  completeExecution,
  cancelExecution,
  failExecution,
  updateWorkflowExecution,
  updateExecutionLeadCounts,
  getExecutionById,
} from '../models/workflowLogs/functions';
import { logger } from '../utils/logger.js';
import { leadSearchFailureMessage } from './leadSearchFailureMessage.js';
import { resolveApifyCredential } from './apifyCredentialResolver.js';
import { trackGeneratedOutput } from './StorageTrackingHooks.js';
import { newUsageContext, withUsageContext } from './insights/UsageContext.js';
import { getRechargeRate, getUsageRate } from '../models/creditPricing/functions.js';
import { getUsdToInrRate } from '../utils/currency.js';
import { LeadModel } from '../models/leads/functions.js';
import {
  classifyProviderDatasetOutcome,
  classifyReviewedProviderOutcome,
  diagnoseEmptyProviderRun,
  isTerminalProviderReceiptStatus,
  partitionProviderDatasetResults,
} from './workflow/providerDatasetResults.js';
import {
  claimLeadGenerationProviderRun,
  getLeadGenerationProviderRunsByExecution,
  updateLeadGenerationProviderRun,
} from '../models/leadGenerationProviderRuns/functions.js';
import type { LeadGenerationProviderRun } from '../models/leadGenerationProviderRuns/schema.js';
import {
  appendLeadSourceReceipt,
  appendLeadSourceRecord,
  applySemanticLeadRelevance,
  evaluateLeadRelevance,
  findDuplicateLead,
  hasStableTwitterProfileIdentity,
  shouldApplyPostProviderRelevanceValidation,
  type ReviewedLeadConstraints,
  type SemanticLeadQualification,
} from './lead-generation/LeadGenerationQualityService.js';
import {
  classifyJevLeadSemanticsBatch,
  JEV_LEAD_BATCH_SIZE,
  JEV_LEAD_MAX_BATCHES,
} from './lead-generation/JevLeadSemanticService.js';
import { normalizeLeadContacts } from './lead-generation/LeadContactNormalization.js';
import { assertLeadActorAvailable, assertLeadWorkflowAvailable } from './workflow/retiredLeadWorkflows.js';

interface WorkflowNode {
  id: string;
  type: 'llm' | 'actor' | 'db_save' | 'dbSave' | 'saveToLeads' | 'saveToPosts';
  data: {
    actorId?: string;
    nodeId?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputMapping?: Record<string, any>;
    finalValues?: Record<string, unknown>;
    reviewableInputFields?: string[];
    requiredInputFields?: string[];
    sourceTargetField?: string;
    sourceLimitField?: string;
    dbSave?: {
      enabled: boolean;
      target_table?: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      field_mapping?: Record<string, any>;
    };
    table?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mapping?: Record<string, any>;
    output_key?: string;
    iterate_over?: string;
    iterate_over_field?: string;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    schema?: any;
  };
}

interface Workflow {
  retired?: boolean;
  workflow_id: string;
  platform: string;
  title: string;
  nodes: WorkflowNode[];
  edges: Array<{ id: string; source: string; target: string }>;
}

interface ExecutionContext {
  executionId: string;
  workflowId: string;
  status: 'running' | 'completed' | 'failed' | 'paused';
  startTime: Date;
  endTime?: Date;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  nodesExecuted: Map<string, any>;
  errors: Array<{ nodeId: string; error: string }>;
  logs: string[];
  threadId?: number;
  platform?: string;
  userId?: number;
  promptId?: number;
  savedLeadIds?: Set<number>; // Track leads saved immediately to prevent duplicates
  customApifyKey?: string; // Explicit Apify API key override (admin use)
  apifyKeyInfo?: ApiKeyResult | null; // Track current Apify key per execution for rate-limit fallback
  apifyCredentialSource?: 'explicit' | 'admin' | 'user' | 'legacy';
  apifyActorId?: string;
  businessCategoryId?: number | null;
  businessCategoryName?: string | null;
  businessSubcategoryId?: number | null;
  businessSubcategoryName?: string | null;
  leadInputId?: number;
  requestedLeadLimit?: number;
  reviewedLeadConstraints?: ReviewedLeadConstraints;
  semanticLeadClassificationBudget: { remainingBatches: number; remainingLeads: number };
  persistedLeadCount: number;
  providerRun?: LeadGenerationProviderRun;
  providerMetrics: Map<number, { persisted: number; duplicates: number; rejected: number; providerErrors?: number; persistenceErrors?: number }>;
  existingReviewedLeads?: Array<Record<string, any>>;
  countedLeadIds: Set<number>;
}

// Track running actor runs for abort capability
const runningActorRuns = new Map<string, { actorRunId: string; client: ApifyClient }>();
const ACTOR_RESULT_LIMIT_FIELDS = [
  'maxItems',
  'maxResults',
  'resultsLimit',
  'limit',
  'maxPosts',
  'maxProfiles',
  'maxCrawledPlacesPerSearch',
] as const;

export class WorkflowExecutorService {
  private static apifyClient: ApifyClient;
  private static schemaRegistry: ActorSchemaRegistry;
  static activeExecutions = new Map<number, string>();

  /**
   * Abort a running workflow's actors
   */
  static async abortWorkflowActors(executionId: string): Promise<void> {
    const runInfo = runningActorRuns.get(executionId);
    if (runInfo) {
      try {
        logger.info({ actorRunId: runInfo.actorRunId, executionId: executionId }, '[WorkflowExecutor] Aborting actor run for execution');
        await runInfo.client.run(runInfo.actorRunId).abort();
        runningActorRuns.delete(executionId);
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (error) {
        logger.error('[WorkflowExecutor] Error aborting actor run');
      }
    }
  }

  private static cleanActorDisplayName(actorId: string): string {
    const cleanId = actorId.split('/').pop() || actorId;
    const nameMap: Record<string, string> = {
      'instagram-post-authors-commenters': 'Instagram Profiles',
      'instagram-post-authors-engagers': 'Instagram Engagers',
      'instagram-post-authors-followers': 'Instagram Followers',
      'instagram-post-authors-likers': 'Instagram Likers',
      'instagram-post-search': 'Instagram Posts',
      'instagram-profile-posts': 'Instagram Profile Posts',
      'instagram-hashtag-followers': 'Instagram Hashtag Followers',
      'instagram-competitor-profiles': 'Instagram Competitors',
      'facebook-post-commenters': 'Facebook Profiles',
      'facebook-post-likers': 'Facebook Likers',
      'facebook-post-search': 'Facebook Posts',
      'facebook-competitor-pages': 'Facebook Competitors',
      'facebook-page-posts': 'Facebook Page Posts',
      'facebook-post-authors': 'Facebook Profiles',
      'facebook-post-authors-followers': 'Facebook Followers',
      'twitter-post-authors': 'Twitter Profiles',
      'twitter-post-authors-followers': 'Twitter Followers',
      'twitter-post-likers': 'Twitter Likers',
      'twitter-post-repliers': 'Twitter Repliers',
      'twitter-post-retweeters': 'Twitter Retweeters',
      'twitter-post-search': 'Twitter Posts',
      'twitter-user-tweets': 'Twitter User Tweets',
      'twitter-competitor-followers': 'Twitter Followers',
      'twitter-competitor-users': 'Twitter Competitors',
      'linkedin-company-search': 'LinkedIn Companies',
      'linkedin-company-employees': 'LinkedIn Employees',
      'linkedin-company-employees-posts': 'LinkedIn Employee Posts',
      'linkedin-company-posts': 'LinkedIn Company Posts',
      'linkedin-post-search': 'LinkedIn Posts',
      'linkedin-posts-commenters': 'LinkedIn Commenters',
      'linkedin-posts-reactors': 'LinkedIn Reactors',
      'linkedin-profile-activity': 'LinkedIn Profile Activity',
      'linkedin-profile-by-name': 'LinkedIn Profile',
      'linkedin-profile-enriched': 'LinkedIn Profile Enrichment',
      'linkedin-profile-posts': 'LinkedIn Profile Posts',
      'google-maps-scraper': 'Google Maps Leads',
    };
    return nameMap[cleanId] || cleanId.replace(/-scraper|-search|-actor/g, '').replace(/-/g, ' ');
  }

  private static async reconcileProviderDatasetOutcome(
    context: ExecutionContext,
    validCount: number,
    rejectedCount: number,
    emptyCount: number = 0,
  ): Promise<void> {
    if (!context.providerRun || (rejectedCount === 0 && emptyCount === 0)) return;

    const run = context.providerRun;
    const current = context.providerMetrics.get(run.id) || { persisted: 0, duplicates: 0, rejected: 0 };
    const metrics = {
      ...current,
      // Replays inspect the same immutable dataset, so this must be idempotent.
      rejected: Math.max(current.rejected, run.rejectedCount, rejectedCount),
      providerErrors: Math.max(current.providerErrors || 0, rejectedCount),
    };
    context.providerMetrics.set(run.id, metrics);

    const status = classifyProviderDatasetOutcome(validCount, metrics.rejected);
    // Derive the count from the immutable partition so replaying the same
    // dataset cannot subtract the empty sentinel more than once.
    const fetchedCount = validCount + rejectedCount;
    const acceptedCount = Math.max(
      run.acceptedCount,
      validCount,
      metrics.persisted + metrics.duplicates,
    );
    const error = metrics.rejected === 0
      ? null
      : status === 'failed'
        ? `Provider returned ${metrics.rejected} error record(s) and no usable leads.`
        : `Provider returned ${metrics.rejected} error record(s); usable results were preserved.`;
    context.providerRun = await updateLeadGenerationProviderRun(run.id, {
      status,
      fetchedCount,
      acceptedCount,
      persistedCount: metrics.persisted,
      duplicateCount: metrics.duplicates,
      rejectedCount: metrics.rejected,
      error,
      heartbeatAt: new Date(),
      completedAt: new Date(),
    });
  }

  /**
   * Get user-friendly step name for a workflow node
   */
  private static getNodeStepName(node: WorkflowNode): string {
    const nodeType = node.type;
    const nodeId = node.id;
    const actorId = node.data?.actorId;

    switch (nodeType) {
      case 'llm':
        return '🧠 Generating search parameters...';
      case 'actor':
        if (actorId) {
          const actorName = this.cleanActorDisplayName(actorId);
          return `🔍 Extracting ${actorName || 'platform'}...`;
        }
        return '🔍 Running scraper...';
      case 'db_save':
      case 'dbSave':
      case 'saveToLeads':
        return '💾 Saving leads to database...';
      case 'saveToPosts':
        return '💾 Saving posts to database...';
      default:
        return `📍 Executing ${nodeId}...`;
    }
  }

  /**
   * Initialize schema registry (call once at startup)
   */
  static async initialize() {
    if (!this.schemaRegistry) {
      this.schemaRegistry = ActorSchemaRegistry.getInstance();
      await this.schemaRegistry.loadSchemas();
      logger.info('✅ ActorSchemaRegistry initialized');
    }
  }

  /**
   * Initialize Apify client with user token (if available)
   * Uses fallback service for rate limit handling
   * If actorId is provided, checks for actor-specific admin keys first
   */
  private static async getApifyClientForUser(userId?: number, actorId?: string, explicitApiKey?: string, context?: ExecutionContext): Promise<ApifyClient> {
    if (context) context.apifyActorId = actorId;
    // If an explicit API key is provided (e.g. from admin panel), use it directly
    if (explicitApiKey) {
      if (context) context.apifyKeyInfo = null;
      if (context) context.apifyCredentialSource = 'explicit';
      logger.info('[WorkflowExecutor] Using explicitly provided Apify API key');
      return new ApifyClient({ token: explicitApiKey });
    }

    // Same lookup the chat uses before offering a search: admin key for the
    // actor, then the user's own key, then the legacy token.
    const resolved = await resolveApifyCredential(userId, actorId);
    if (resolved) {
      if (context) context.apifyKeyInfo = resolved.keyInfo;
      if (context) context.apifyCredentialSource = resolved.source;
      logger.info({ actorId, userId, source: resolved.source, credentialId: resolved.keyInfo?.credentialId }, '[WorkflowExecutor] Using Apify key');
      return new ApifyClient({ token: resolved.apiKey });
    }

    // No API key available
    throw new Error('No Apify API key available. Please add your Apify token in Settings → Integrations → Apify');
  }

  /**
   * Handle Apify rate limit and get next available key
   */
  private static async handleApifyRateLimitAndGetNext(userId: number, context: ExecutionContext): Promise<ApifyClient | null> {
    if (!context.apifyKeyInfo) {
      logger.warn('[WorkflowExecutor] Cannot fallback - no credential tracking available');
      return null;
    }

    const nextKey = await handleRateLimitAndGetNextKey(
      userId,
      'apify',
      context.apifyKeyInfo.credentialId
    );

    if (nextKey) {
      context.apifyKeyInfo = nextKey;
      logger.info({ credentialId: nextKey.credentialId }, '[WorkflowExecutor] Fallback to next Apify key (credential: )');
      return new ApifyClient({ token: nextKey.apiKey });
    }

    return null;
  }

  private static async handleAdminApifyCapacityAndGetNext(
    context: ExecutionContext,
    error: unknown,
  ): Promise<ApifyClient | null> {
    if (context.apifyCredentialSource !== 'admin' || !context.apifyKeyInfo) return null;

    const currentId = context.apifyKeyInfo.credentialId;
    if (isApifyAccountWideCapacityError(error)) {
      // Account-wide billing/suspension conditions do not recover on a short
      // timer. Actor-plan limits are deliberately excluded: disabling that
      // token globally would break unrelated Actors that can still run.
      try {
        await markAdminCredentialInactive(currentId, 'billing_or_account_capacity', apifyRefusalReason(error));
        // Keep Apify's own reason (e.g. "Too many outstanding invoices") on the
        // credential and in its audit trail so an admin knows what to fix.
        await updateAdminCredentialValidation({
          id: currentId, platform: 'apify', status: 'invalid', message: apifyCredentialRefusalNote(error),
        });
      } catch (deactivationError) {
        logger.warn(
          { err: deactivationError, credentialId: currentId },
          '[WorkflowExecutor] Could not deactivate unavailable admin Apify credential',
        );
      }
    }

    const nextCredential = context.apifyActorId
      ? await getNextAdminCredentialForActor(context.apifyActorId, currentId)
      : await getNextActiveAdminCredential('apify', currentId);
    if (!nextCredential) return null;

    context.apifyKeyInfo = {
      apiKey: nextCredential.apiKey,
      credentialId: nextCredential.id,
      platform: 'apify',
    };
    context.apifyCredentialSource = 'admin';
    logger.info(
      { previousCredentialId: currentId, credentialId: nextCredential.id },
      '[WorkflowExecutor] Falling back to next admin Apify credential',
    );
    return new ApifyClient({ token: nextCredential.apiKey });
  }

  /**
   * Check if execution has been cancelled
   */
  private static async isExecutionCancelled(executionId: string): Promise<boolean> {
    try {
      const execution = await getExecutionById(executionId);
      return execution?.status === 'cancelled';
    } catch {
      return false;
    }
  }

  /**
   * Execute Apify actor call with automatic fallback on rate limits
   */
  private static async executeActorWithFallback<T>(
    userId: number | undefined,
    actorId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actorInput: Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getResults: (client: ApifyClient, run: any) => Promise<T>,
    context: ExecutionContext,
    nodeKey: string,
    maxRetries: number = 3
  ): Promise<T> {
    assertLeadActorAvailable(actorId);
    // This provider defaults to expanding followers/following. A save cap
    // cannot bound provider charges: require explicit mode and fetch limits
    // before starting any run, including legacy/custom workflows.
    if (actorId === 'apidojo/twitter-user-scraper') {
      if (!Number.isSafeInteger(actorInput.maxItems) || actorInput.maxItems < 5
        || ['getFollowers', 'getFollowing', 'getRetweeters'].some(field => typeof actorInput[field] !== 'boolean')) {
        throw new Error('Twitter profile lookup requires a positive maxItems of at least 5 and explicit getFollowers, getFollowing, and getRetweeters settings. Review the workflow before retrying.');
      }
    }
    let client = await this.getApifyClientForUser(userId, actorId, context.customApifyKey, context);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let lastError: any;
    let durableRun: LeadGenerationProviderRun | undefined;

    if (userId && context.threadId) {
      const idempotencyKey = `${context.executionId}:${nodeKey}`.slice(0, 255);
      const claimed = await claimLeadGenerationProviderRun({
        userId,
        threadId: context.threadId,
        leadInputId: context.leadInputId,
        executionId: context.executionId,
        idempotencyKey,
        platform: context.platform || 'lead_generation',
        workflowId: context.workflowId,
        nodeKey,
        actorId,
        requestedLeadLimit: context.requestedLeadLimit,
        status: 'pending',
        checkpoint: { actorInput: this.sanitizeForLogging(actorInput) },
      });
      durableRun = claimed.run;
      context.providerRun = durableRun;

      // A completed receipt is an idempotent replay. Read the same immutable
      // dataset; never start another provider campaign for this reviewed row.
      if (durableRun.actorRunId && isTerminalProviderReceiptStatus(durableRun.status)) {
        const reconciled = await client.run(durableRun.actorRunId).get();
        if (!reconciled) throw new Error(`Provider run ${durableRun.actorRunId} could not be reconciled.`);
        runningActorRuns.set(context.executionId, { actorRunId: durableRun.actorRunId, client });
        const replay = await getResults(client, reconciled);
        runningActorRuns.delete(context.executionId);
        return replay;
      }
      if (isTerminalProviderReceiptStatus(durableRun.status)) {
        throw new Error(
          durableRun.error
          || `Provider receipt ${durableRun.id} is already terminal (${durableRun.status}). Regenerate and review inputs to retry.`,
        );
      }
    }

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const attemptStartTime = Date.now();
      // Preserve the exact provider identity through the catch path so failed
      // usage rows and diagnostics reconcile to the durable receipt.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let attemptedRun: any = null;
      let usageTrackingStarted = false;
      try {
        // If a previous process persisted a provider run ID, continue polling
        // that exact run. Otherwise start once and persist the receipt before
        // entering the wait loop.
        let runInfo: any;
        if (durableRun?.actorRunId && durableRun.status === 'syncing') {
          runInfo = await client.run(durableRun.actorRunId).get();
          if (!runInfo) throw new Error(`Provider run ${durableRun.actorRunId} no longer exists.`);
          this.log(context, `♻️ Reconciled provider run ${durableRun.actorRunId} after interruption`);
        } else {
          runInfo = await client.actor(actorId).start(actorInput);
          if (durableRun) {
            durableRun = await updateLeadGenerationProviderRun(durableRun.id, {
              actorRunId: runInfo.id,
              datasetId: runInfo.defaultDatasetId || null,
              status: 'syncing',
              retryCount: attempt,
              error: null,
              startedAt: durableRun.startedAt || new Date(),
              heartbeatAt: new Date(),
              checkpoint: {
                ...(durableRun.checkpoint || {}),
                providerStatus: runInfo.status,
                attempt,
              },
            });
            context.providerRun = durableRun;
          }
        }
        attemptedRun = runInfo;

        // Track the running actor for abort capability
        runningActorRuns.set(context.executionId, { actorRunId: runInfo.id, client });

        // Wait for the actor to finish with periodic cancellation checks
        let run = runInfo;
        const runStartTime = Date.now();
        const maxRunTimeMs = 30 * 60 * 1000; // 30 minutes absolute timeout
        while (run.status === 'RUNNING' || run.status === 'READY') {
          // Check for cancellation every 2 seconds
          await new Promise(resolve => setTimeout(resolve, 2000));

          // Absolute timeout guard — abort if running too long
          if (Date.now() - runStartTime > maxRunTimeMs) {
            this.log(context, `⏰ Actor ${actorId} exceeded 30min timeout — aborting`);
            try {
              await client.run(run.id).abort();
            } catch (abortError) {
              logger.error({ err: abortError }, '[WorkflowExecutor] Error aborting timed-out actor');
            }
            runningActorRuns.delete(context.executionId);
            throw new Error(`Actor ${actorId} timed out after 30 minutes`);
          }

          // Check if execution was cancelled
          if (await this.isExecutionCancelled(context.executionId)) {
            this.log(context, `🛑 Cancellation detected - aborting actor ${actorId}`);
            try {
              await client.run(run.id).abort();
            } catch (abortError) {
              logger.error({ err: abortError }, '[WorkflowExecutor] Error aborting actor');
            }
            runningActorRuns.delete(context.executionId);
            throw new Error('Workflow cancelled by user');
          }

          // Get updated run status
          run = await client.run(run.id).get() as typeof runInfo;
          if (!run) throw new Error(`Provider run ${runInfo.id} disappeared while syncing.`);
          attemptedRun = run;
          if (durableRun) {
            durableRun = await updateLeadGenerationProviderRun(durableRun.id, {
              datasetId: run.defaultDatasetId || durableRun.datasetId,
              status: 'syncing',
              heartbeatAt: new Date(),
              checkpoint: {
                ...(durableRun.checkpoint || {}),
                providerStatus: run.status,
                attempt,
              },
            });
            context.providerRun = durableRun;
          }
        }

        // Clean up tracking
        runningActorRuns.delete(context.executionId);

        // Persist terminal artifacts for both successful and failed actors.
        // A failed provider log is often the only authoritative explanation
        // for a terminal receipt and must survive API/worker restarts.
        if (userId) {
          this.saveActorRunArtifacts(userId, actorId, run, actorInput, client, context).catch(() => {});
        }

        if (run.status !== 'SUCCEEDED') {
          const cancelled = run.status === 'ABORTED';
          if (durableRun) {
            durableRun = await updateLeadGenerationProviderRun(durableRun.id, {
              status: cancelled ? 'cancelled' : 'failed',
              error: cancelled
                ? 'Provider run was cancelled.'
                : `Provider run ended with ${run.status}${run.exitCode ? ` (${run.exitCode})` : ''}.`,
              datasetId: run.defaultDatasetId || durableRun.datasetId,
              providerResult: { status: run.status, exitCode: run.exitCode || null },
              heartbeatAt: new Date(),
              completedAt: new Date(),
            });
            context.providerRun = durableRun;
          }
          throw new Error(cancelled
            ? 'Workflow cancelled by user'
            : `Provider run ${run.id} failed with status ${run.status}${run.exitCode ? ` (${run.exitCode})` : ''}`);
        }

        const result = await getResults(client, run);
        const fetchedCount = Array.isArray(result) ? result.length : 0;

        if (fetchedCount === 0) {
          let providerLog: unknown;
          try {
            providerLog = await client.run(run.id).log().get();
          } catch (error) {
            logger.warn({ err: error, actorId, runId: run.id }, '[WorkflowExecutor] Empty-run diagnostic log unavailable');
          }
          const diagnostic = diagnoseEmptyProviderRun(actorId, providerLog);
          if (diagnostic) throw new Error(diagnostic);
        }

        // Dataset retrieval is the first point where the truthful item count is
        // known. Track usage after it completes so billing, provider receipts,
        // and workflow totals all describe the same run.
        this.trackActorRunUsage(
          userId,
          actorId,
          run,
          actorInput,
          Date.now() - attemptStartTime,
          context,
          fetchedCount,
        ).catch(err => logger.warn({ err }, '[WorkflowExecutor] Failed to track Apify usage'));
        usageTrackingStarted = true;

        if (durableRun) {
          durableRun = await updateLeadGenerationProviderRun(durableRun.id, {
            datasetId: run.defaultDatasetId || durableRun.datasetId,
            status: fetchedCount > 0 ? 'succeeded' : 'succeeded_empty',
            fetchedCount,
            providerResult: {
              status: run.status,
              exitCode: run.exitCode || null,
              datasetId: run.defaultDatasetId || null,
              fetchedCount,
            },
            checkpoint: {
              ...(durableRun.checkpoint || {}),
              providerStatus: run.status,
              datasetOffset: fetchedCount,
            },
            heartbeatAt: new Date(),
            completedAt: new Date(),
          });
          context.providerRun = durableRun;
        }
        return result;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        lastError = error;
        runningActorRuns.delete(context.executionId);

        if (durableRun && durableRun.status !== 'cancelled') {
          durableRun = await updateLeadGenerationProviderRun(durableRun.id, {
            status: error.message === 'Workflow cancelled by user' ? 'cancelled' : 'failed',
            retryCount: attempt,
            error: error.message,
            heartbeatAt: new Date(),
            completedAt: new Date(),
          });
          context.providerRun = durableRun;
        }

        // Track failed run usage (only if not a retry from rate limit)
        if (!isRateLimitError(error) && !usageTrackingStarted) {
          this.trackActorRunUsage(userId, actorId, attemptedRun, actorInput, Date.now() - attemptStartTime, context, 0, error.message).catch(err =>
            logger.warn({ err }, '[WorkflowExecutor] Failed to track Apify failure usage')
          );
        }

        // If cancelled, don't retry
        if (error.message === 'Workflow cancelled by user') {
          throw error;
        }

        if (isApifyCredentialCapacityError(error) && context.apifyCredentialSource === 'admin') {
          // Keep the provider's own reason (billing, plan limit, rate limit) in server logs;
          // the user-facing message stays generic.
          logger.warn({ actorId, attempt: attempt + 1, providerError: String(error?.message || '').slice(0, 300),
            statusCode: error?.statusCode ?? error?.status }, '[WorkflowExecutor] Apify credential refused the run');
          this.log(context, `⚠️ Apify credential unavailable, attempting admin fallback (attempt ${attempt + 1}/${maxRetries})...`);
          const nextClient = await this.handleAdminApifyCapacityAndGetNext(context, error);
          if (nextClient) {
            client = nextClient;
            if (durableRun) {
              durableRun = await updateLeadGenerationProviderRun(durableRun.id, {
                actorRunId: null,
                datasetId: null,
                status: 'pending',
                completedAt: null,
                retryCount: attempt + 1,
              });
            }
            continue;
          }
          throw new Error(APIFY_ACCOUNTS_UNAVAILABLE_MESSAGE);
        }

        if (isRateLimitError(error) && userId && context.apifyKeyInfo) {
          this.log(context, `⚠️ Apify rate limit hit, attempting fallback (attempt ${attempt + 1}/${maxRetries})...`);

          const nextClient = await this.handleApifyRateLimitAndGetNext(userId, context);

          if (nextClient) {
            client = nextClient;
            if (durableRun) {
              durableRun = await updateLeadGenerationProviderRun(durableRun.id, {
                actorRunId: null,
                datasetId: null,
                status: 'pending',
                completedAt: null,
                retryCount: attempt + 1,
              });
            }
            continue; // Retry with new key
          }

          throw new Error('All Apify API keys have hit rate limits. Please add more API keys or wait for rate limits to reset in Settings > Integrations.');
        }

        // Not a rate limit error, throw immediately
        throw error;
      }
    }

    throw lastError || new Error('Max retries reached for Apify API call');
  }

  /**
   * Track Apify actor run usage and deduct credits
   */
  private static async trackActorRunUsage(
    userId: number | undefined,
    actorId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: any | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: Record<string, any>,
    durationMs: number,
    context: ExecutionContext,
    itemsScraped: number = 0,
    errorMessage?: string
  ): Promise<void> {
    if (!userId) return;
    
    try {
      const { insertApifyUsage } = await import('../models/apifyUsages/functions.js');
      const { deductCreditsForApifyUsage } = await import('./CreditDeductionHooks.js');
      const { getApifyMarginPercentage } = await import('../models/apiPricing/functions.js');
      
      const success = run?.status === 'SUCCEEDED' && !errorMessage;
      const usageTotalUsd = run?.stats?.usageTotalUsd ?? null;
      const computeUnits = run ? (durationMs / 1000 / 60) * 0.25 : 0;
      
      // Calculate cost: prefer actual Apify cost, fallback to CU estimate
      let baseCostCents: number;
      if (usageTotalUsd != null && usageTotalUsd > 0) {
        baseCostCents = usageTotalUsd * 100;
      } else {
        baseCostCents = computeUnits * 25;
      }
      
      const marginPercent = await getApifyMarginPercentage();
      const estimatedCostCents = baseCostCents * (1 + marginPercent / 100);
      const usageContext=newUsageContext({provider:'apify',model:actorId,process:'leads',
        conversation:context.threadId&&context.threadId>0?{kind:'workspace',id:context.threadId}:undefined});
      usageContext.pricing={version:1,capturedAt:new Date().toISOString(),source:usageTotalUsd!=null?'provider_reported':'fixed',
        sourceReference:usageTotalUsd!=null?'apify_usage_total_usd':'apify_compute_units_estimate',model:actorId,provider:'apify',
        marginPercentage:marginPercent,providerCostUsd:(baseCostCents/100).toFixed(10),chargedCostUsd:(estimatedCostCents/100).toFixed(10),
        usdToInr:getUsdToInrRate(),creditsPerInr:await getRechargeRate(),usageCreditsPerInr:await getUsageRate(),minimumCredits:1,rounding:'ceil_whole'};

      await withUsageContext(usageContext, async()=>{
      await insertApifyUsage({
        userId,
        threadId: context.threadId || null,
        workflowId: context.workflowId || null,
        actorId,
        actorName: actorId,
        runId: run?.id || null,
        datasetId: run?.defaultDatasetId || null,
        purpose: 'lead_scraping',
        service: 'apify',
        action: 'run_actor',
        computeUnits: computeUnits.toString(),
        dataTransferGb: null,
        itemsScraped,
        estimatedCostCents,
        inputSummary: input ? JSON.stringify(input).slice(0, 500) : null,
        responseSuccess: success ? 1 : 0,
        errorMessage: errorMessage || null,
        durationMs,
        metadata: { runId: run?.id, datasetId: run?.defaultDatasetId, executionId: context.executionId },
      });
      
      // Deduct credits for runs (always log for tracking)
      if (success) {
        await deductCreditsForApifyUsage(userId, {
          actorName: actorId,
          runId: run?.id,
          itemsScraped,
          estimatedCostCents,
          threadId: context.threadId || null,
        });
      }
      });
      
      logger.info({ actorId, runId: run?.id, estimatedCostCents, success }, '[WorkflowExecutor] Tracked Apify usage');
    } catch (err) {
      logger.error({ err, actorId }, '[WorkflowExecutor] Failed to track Apify actor usage');
    }
  }

  /**
   * Save actor run artifacts (dataset, input, log, KV store) to structured storage
   */
  private static async saveActorRunArtifacts(
    userId: number,
    actorId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    run: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actorInput: Record<string, any>,
    client: ApifyClient,
    context: ExecutionContext
  ): Promise<void> {
    try {
      const safeActorId = actorId.replace(/[^a-zA-Z0-9_-]/g, '_');
      const threadPart = context.threadId ? `thread-${context.threadId}` : 'no-thread';
      const basePath = `${userId}/actor_output/${threadPart}/wf-${context.workflowId}/${safeActorId}/run-${run.id}`;

      // 1. Save dataset items
      if (run.defaultDatasetId) {
        try {
          const dataset = await client.dataset(run.defaultDatasetId).listItems();
          const items = dataset?.items || [];
          if (items.length > 0) {
            const buf = Buffer.from(JSON.stringify(items, null, 2));
            await trackGeneratedOutput({
              userId,
              buffer: buf,
              category: 'actor_output',
              fileName: 'dataset.json',
              referenceType: 'apify_dataset',
              referenceId: run.defaultDatasetId,
              mimeType: 'application/json',
              storageKey: `${basePath}/dataset.json`,
              metadata: { actorId, runId: run.id, itemCount: items.length },
            });
          }
        } catch (e) {
          logger.warn({ err: e, runId: run.id }, '[WorkflowExecutor] Failed to save dataset artifact');
        }
      }

      // 2. Save actor input
      try {
        const inputBuf = Buffer.from(JSON.stringify(actorInput, null, 2));
        await trackGeneratedOutput({
          userId,
          buffer: inputBuf,
          category: 'actor_output',
          fileName: 'input.json',
          referenceType: 'apify_input',
          referenceId: run.id,
          mimeType: 'application/json',
          storageKey: `${basePath}/input.json`,
          metadata: { actorId, runId: run.id },
        });
      } catch (e) {
        logger.warn({ err: e, runId: run.id }, '[WorkflowExecutor] Failed to save input artifact');
      }

      // 3. Save run log
      try {
        const logText = await client.run(run.id).log().get();
        if (logText) {
          const logBuf = Buffer.from(logText);
          await trackGeneratedOutput({
            userId,
            buffer: logBuf,
            category: 'actor_output',
            fileName: 'log.txt',
            referenceType: 'apify_log',
            referenceId: run.id,
            mimeType: 'text/plain',
            storageKey: `${basePath}/log.txt`,
            metadata: { actorId, runId: run.id },
          });
        }
      } catch (e) {
        logger.warn({ err: e, runId: run.id }, '[WorkflowExecutor] Failed to save log artifact');
      }

      // 4. Save key-value store items (limit 20)
      if (run.defaultKeyValueStoreId) {
        try {
          const store = client.keyValueStore(run.defaultKeyValueStoreId);
          const keys = await store.listKeys();
          const kvItems = (keys?.items || []).slice(0, 20);
          for (const item of kvItems) {
            try {
              const record = await store.getRecord(item.key);
              if (record?.value != null) {
                const value = record.value;
                const buf = value instanceof Buffer ? value
                  : typeof value === 'string' ? Buffer.from(value)
                  : Buffer.from(JSON.stringify(value));
                const safeKey = item.key.replace(/[^a-zA-Z0-9._-]/g, '_');
                const ct = record.contentType || 'application/octet-stream';
                await trackGeneratedOutput({
                  userId,
                  buffer: buf,
                  category: 'actor_output',
                  fileName: safeKey,
                  referenceType: 'apify_kv_store',
                  referenceId: run.defaultKeyValueStoreId,
                  mimeType: ct,
                  storageKey: `${basePath}/kv/${safeKey}`,
                  metadata: { actorId, runId: run.id, kvKey: item.key },
                });
              }
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            } catch (kvErr) {
              // skip individual KV item failures
            }
          }
        } catch (e) {
          logger.warn({ err: e, runId: run.id }, '[WorkflowExecutor] Failed to save KV store artifacts');
        }
      }

      logger.info({ actorId, runId: run.id, basePath }, '[WorkflowExecutor] Saved actor run artifacts');
    } catch (err) {
      logger.error({ err, actorId, runId: run?.id }, '[WorkflowExecutor] Failed to save actor run artifacts');
    }
  }

  /**
   * Initialize Apify client (legacy - for backward compatibility)
   * Now throws error since we no longer use env vars
   */
  private static getApifyClient(): ApifyClient {
    if (!this.apifyClient) {
      throw new Error('Apify client not initialized. Please use getApifyClientForUser() with a userId to get user-specific credentials from Settings → Integrations');
    }
    return this.apifyClient;
  }
  /**
   * Execute a complete workflow
   */
  static async executeWorkflow(
    workflow: Workflow,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputParams: Record<string, any>,
    userId: string,
    threadId?: number,
    customExecutionId?: string,
    /** Approved ICP profile ID used by leads/posts and workflow events. */
    promptId?: number,
    /** Optional chat message ID used only by scraping-details rows. */
    messageId?: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{
    executionId: string;
    status: 'succeeded' | 'succeeded_empty' | 'partial_success';
    results: any;
    errors?: any[];
  }> {
    assertLeadWorkflowAvailable(workflow);
    const executionId = customExecutionId || uuidv4();
    const userIdNum = parseInt(userId) || undefined;
    
    if (threadId) {
      WorkflowExecutorService.activeExecutions.set(threadId, executionId);
    }

    const context: ExecutionContext = {
      executionId,
      workflowId: workflow.workflow_id,
      status: 'running',
      startTime: new Date(),
      nodesExecuted: new Map(),
      errors: [],
      logs: [],
      threadId,
      platform: workflow.platform,
      userId: userIdNum,
      promptId,
      customApifyKey: inputParams.apifyApiKey || inputParams._apifyApiKey || undefined,
      leadInputId: Number.isSafeInteger(Number(inputParams.__leadInputId)) ? Number(inputParams.__leadInputId) : undefined,
      requestedLeadLimit: Number.isSafeInteger(Number(inputParams.__requestedLeadLimit)) && Number(inputParams.__requestedLeadLimit) > 0
        ? Number(inputParams.__requestedLeadLimit)
        : undefined,
      reviewedLeadConstraints: inputParams.__leadReviewConstraints || undefined,
      semanticLeadClassificationBudget: {
        remainingBatches: JEV_LEAD_MAX_BATCHES,
        remainingLeads: JEV_LEAD_BATCH_SIZE * JEV_LEAD_MAX_BATCHES,
      },
      persistedLeadCount: 0,
      providerMetrics: new Map(),
      countedLeadIds: new Set(),
    };

    const previousExecution = userIdNum ? await getExecutionById(executionId) : null;
    const previousWorkflowResults = previousExecution?.result?.workflowResults;
    const previousProviderRuns = threadId
      ? await getLeadGenerationProviderRunsByExecution(executionId)
      : [];
    const latestProviderRun = previousProviderRuns[0];
    const hasRecoverableProviderRun = previousProviderRuns.some((run) => (
      ['pending', 'syncing'].includes(run.status)
      || (
        run.id === latestProviderRun?.id
        &&
        ['succeeded', 'partial_success'].includes(run.status)
        && run.fetchedCount > 0
        && run.persistedCount === 0
      )
    ));
    if (
      previousExecution?.status === 'completed'
      && previousWorkflowResults
      && !hasRecoverableProviderRun
    ) {
      logger.info({ executionId }, '[WorkflowExecutor] Returning persisted idempotent workflow result');
      if (threadId) WorkflowExecutorService.activeExecutions.delete(threadId);
      return {
        executionId,
        status: previousExecution.result?.status || 'succeeded',
        results: previousWorkflowResults,
        errors: Array.isArray(previousExecution.result?.errors) ? previousExecution.result.errors : undefined,
      };
    }

    // Resolve business category from ICP profile / user for lead tagging
    try {
      const catInfo = await LeadModel.resolveBusinessCategory({ promptId: promptId, userId: userIdNum });
      context.businessCategoryId = catInfo.businessCategoryId;
      context.businessCategoryName = catInfo.businessCategoryName;
      context.businessSubcategoryId = catInfo.businessSubcategoryId;
      context.businessSubcategoryName = catInfo.businessSubcategoryName;
    } catch { /* non-blocking */ }

    try {
      // Create workflow execution record in database
      if (userIdNum) {
        try {
          if (previousExecution) {
            await updateWorkflowExecution(executionId, {
              status: 'running',
              completedAt: null,
              errorMessage: null,
              inputParams: this.sanitizeForLogging(inputParams),
            });
          } else {
            await createWorkflowExecution({
              userId: userIdNum,
              executionId,
              threadId: threadId || null,
              workflowName: workflow.title || workflow.workflow_id,
              status: 'running',
              platforms: workflow.platform ? [workflow.platform] : [],
              totalLeadsExpected: context.requestedLeadLimit || inputParams.leadsPerPlatform || inputParams.limit || 10,
              inputParams: this.sanitizeForLogging(inputParams),
            });
          }

          // Log workflow start
          await createWorkflowLog({
            userId: userIdNum,
            executionId,
            threadId: threadId || null,
            logType: 'workflow_start',
            status: 'running',
            platform: workflow.platform || null,
            message: `Starting workflow: ${workflow.title}`,
            details: {
              workflowId: workflow.workflow_id,
              inputParams: this.sanitizeForLogging(inputParams),
              nodeCount: workflow.nodes.length,
            },
          });

          // Emit workflow_started websocket event for real-time UI updates
          webSocketEmitter.emitWorkflowStarted(
            userIdNum,
            workflow.platform || 'unknown',
            `Starting workflow: ${workflow.title}`,
            promptId,
            executionId,
            threadId
          );

          // Scraping details belong to a chat message. Keep that identity
          // separate from promptId, which is the approved ICP profile ID.
          let finalMessageId = messageId;
          if (!finalMessageId && threadId) {
            try {
              const { chatMessagesTable } = await import('../models/chatMessages/schema');
              const { db } = await import('../models/db');
              const { eq, desc } = await import('drizzle-orm');
              const latestMessages = await db.select({ id: chatMessagesTable.id })
                .from(chatMessagesTable)
                .where(eq(chatMessagesTable.threadId, threadId))
                .orderBy(desc(chatMessagesTable.createdAt))
                .limit(1);
              if (latestMessages.length > 0) {
                finalMessageId = latestMessages[0].id;
              }
            } catch { /* ignore fallback error */ }
          }

          if (finalMessageId) {
            try {
              const { createScrapingDetail } = await import('../models/scrapingDetails/functions');
              const { getScrapingDetailsByExecutionId, updateScrapingDetailByExecutionAndPlatform } = await import('../models/scrapingDetails/functions');
              const existingDetails = await getScrapingDetailsByExecutionId(executionId);
              if (existingDetails.some((detail) => detail.platform === (workflow.platform || 'Lead Generation'))) {
                await updateScrapingDetailByExecutionAndPlatform(executionId, workflow.platform || 'Lead Generation', {
                  totalLeadsNeeded: context.requestedLeadLimit || inputParams.leadsPerPlatform || inputParams.limit || 10,
                  status: 'running',
                  error: null,
                  completedAt: null,
                  startedAt: existingDetails[0]?.startedAt || new Date(),
                });
              } else {
                await createScrapingDetail({
                  messageId: finalMessageId,
                  threadId: threadId || 0,
                  userId: userIdNum,
                  executionId,
                  platform: workflow.platform || 'Lead Generation',
                  totalLeadsNeeded: context.requestedLeadLimit || inputParams.leadsPerPlatform || inputParams.limit || 10,
                  status: 'running',
                  startedAt: new Date(),
                });
              }
            } catch (scrapingErr) {
              logger.error({ err: scrapingErr }, '[WorkflowExecutor] Error creating scraping detail record');
            }
          }
        } catch (dbError) {
          logger.error({ err: dbError }, '[WorkflowExecutor] Error creating workflow log');
          // Continue execution even if logging fails
        }
      }

      this.log(context, `🚀 Starting workflow execution: ${workflow.title}`);
      this.log(context, `📊 Input Parameters (sanitized): ${this.safeStringify(inputParams, 2)}`);

      // Execute nodes in dependency order
      const executionOrder = this.getExecutionOrder(workflow);

      for (const nodeId of executionOrder) {
        const node = workflow.nodes.find((n) => n.id === nodeId);
        if (!node) {
          this.log(context, `⚠️  Node ${nodeId} not found`);
          continue;
        }

        try {
          await this.executeNode(node, workflow, context, inputParams, threadId);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
          this.log(context, `❌ Error executing node ${nodeId}: ${error.message}`);
          context.errors.push({ nodeId, error: error.message });

          // Log node error to database
          if (userIdNum) {
            try {
              await createWorkflowLog({
                userId: userIdNum,
                executionId,
                threadId: threadId || null,
                logType: node.type === 'actor' ? 'actor_error' : 'step',
                status: 'error',
                platform: workflow.platform || null,
                actorId: node.data.actorId || null,
                message: `Error in node ${nodeId}: ${error.message}`,
                errorMessage: error.message,
                details: { nodeId, nodeType: node.type },
              });
            } catch (logError) {
              logger.error({ err: logError }, '[WorkflowExecutor] Error logging node error');
            }
          }

          // Detect fatal API usage / quota limit errors — stop the entire workflow immediately.
          // If the monthly plan limit is reached, subsequent actor nodes will also fail,
          // so continuing is wasteful and confusing for the user.
          const isFatalApiLimit = /monthly usage hard limit|usage hard limit exceeded|monthly limit exceeded|quota.*exceeded|exceeded.*quota|plan.*not.*support/i.test(error.message);
          if (isFatalApiLimit) {
            const limitMsg = `⛔ API limit reached: ${error.message}. Halting workflow — remaining actors will not run until the plan is upgraded or the limit resets.`;
            this.log(context, limitMsg);
            if (userIdNum) {
              try {
                await createWorkflowLog({
                  userId: userIdNum,
                  executionId,
                  threadId: threadId || null,
                  logType: 'workflow_error',
                  status: 'error',
                  platform: workflow.platform || null,
                  message: limitMsg,
                  errorMessage: error.message,
                  details: { nodeId, nodeType: node.type, fatalApiLimit: true },
                });
              } catch { /* non-blocking */ }
              webSocketEmitter.emitWorkflowError(
                userIdNum,
                workflow.platform || 'unknown',
                '⛔ API Usage Limit Reached',
                error.message,
                promptId,
                threadId
              );
            }
            throw error; // Throw error to trigger the outer catch block and mark status as failed
          }

          // For non-fatal errors, continue with next node
        }
      }

      const savedLeadCount = this.getPersistedLeadCount(context);
      const providerRuns = await getLeadGenerationProviderRunsByExecution(executionId);
      const providerFailed = providerRuns.some((run) => run.status === 'failed');
      const providerCancelled = providerRuns.some((run) => run.status === 'cancelled');
      const providerPartial = providerRuns.some((run) => run.status === 'partial_success');
      if ((context.errors.length > 0 || providerFailed || providerCancelled) && savedLeadCount === 0) {
        const firstError = context.errors[0];
        if (!providerCancelled && firstError) {
          // Node IDs and provider errors are for admins; the user sees a plain reason.
          logger.warn({ executionId, nodeId: firstError.nodeId, error: firstError.error }, '[WorkflowExecutor] Lead search failed before saving leads');
        }
        throw new Error(providerCancelled ? 'Workflow cancelled by user' : leadSearchFailureMessage(firstError?.error));
      }

      const workflowOutcome = context.errors.length > 0 || providerFailed || providerCancelled || providerPartial
        ? 'partial_success'
        : savedLeadCount === 0 && providerRuns.length > 0
          ? 'succeeded_empty'
          : 'succeeded';
      const workflowResults = Array.from(context.nodesExecuted.entries()).reduce(
        (acc, [key, val]) => ({ ...acc, [key]: val }),
        {} as Record<string, any>,
      );

      // Mark execution as completed
      context.status = 'completed';
      context.endTime = new Date();

      // Complete execution in database
      if (userIdNum) {
        try {
          const leadsCount = savedLeadCount;

          await completeExecution(executionId, {
            status: workflowOutcome,
            nodesExecuted: executionOrder.length,
            errors: context.errors,
            duration: this.getElapsedTime(context),
            workflowResults,
            providerRuns: providerRuns.map((run) => ({
              id: run.id,
              platform: run.platform,
              actorId: run.actorId,
              actorRunId: run.actorRunId,
              datasetId: run.datasetId,
              status: run.status,
              requestedLeadLimit: run.requestedLeadLimit,
              fetchedCount: run.fetchedCount,
              acceptedCount: run.acceptedCount,
              persistedCount: run.persistedCount,
              duplicateCount: run.duplicateCount,
              rejectedCount: run.rejectedCount,
              error: run.error,
            })),
          }, leadsCount);

          // Keep the displayed total equal to the exact number of persisted IDs.
          try {
            const { updateScrapingDetailByExecutionAndPlatform } = await import('../models/scrapingDetails/functions');
            await updateScrapingDetailByExecutionAndPlatform(executionId, workflow.platform || 'Lead Generation', {
              status: workflowOutcome,
              totalLeadsFound: leadsCount,
              error: workflowOutcome === 'partial_success' ? (context.errors[0]?.error || providerRuns.find(run => run.error)?.error || null) : null,
              completedAt: new Date(),
              progress: '100.00',
            });
          } catch (scrapingErr) {
            logger.error({ err: scrapingErr }, '[WorkflowExecutor] Error completing scraping detail');
          }

          // Log workflow completion
          await createWorkflowLog({
            userId: userIdNum,
            executionId,
            threadId: threadId || null,
            logType: 'workflow_complete',
            status: 'completed',
            platform: workflow.platform || null,
            message: `Workflow ${workflowOutcome}: ${workflow.title}`,
            leadsCount,
            details: {
              duration: this.getElapsedTime(context),
              nodesExecuted: executionOrder.length,
              errors: context.errors.length,
              outcome: workflowOutcome,
            },
          });
        } catch (dbError) {
          logger.error({ err: dbError }, '[WorkflowExecutor] Error completing workflow log');
        }
      }

      this.log(context, `✅ Workflow execution completed in ${this.getElapsedTime(context)}`);

      return {
        executionId,
        status: workflowOutcome,
        results: workflowResults,
        errors: context.errors.length > 0 ? context.errors : undefined,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      context.status = 'failed';
      context.endTime = new Date();

      // Log workflow failure to database
      const userIdNum = context.userId;
      if (userIdNum) {
        try {
          const isCancelled = error.message?.includes('cancelled') || error.message?.includes('aborted') || error.message?.includes('stopped');
          if (isCancelled) await cancelExecution(executionId);
          else await failExecution(executionId, error.message);

          // Update scraping details with the same truthful terminal status.
          try {
            const { updateScrapingDetailByExecutionAndPlatform } = await import('../models/scrapingDetails/functions');
            await updateScrapingDetailByExecutionAndPlatform(executionId, workflow.platform || 'Lead Generation', {
              status: isCancelled ? 'cancelled' : 'failed',
              error: error.message,
              completedAt: new Date(),
            });
          } catch (scrapingErr) {
            logger.error({ err: scrapingErr }, '[WorkflowExecutor] Error updating scraping detail on failure');
          }

          await createWorkflowLog({
            userId: userIdNum,
            executionId,
            threadId: threadId || null,
            logType: 'workflow_error',
            status: 'error',
            platform: workflow.platform || null,
            message: `Workflow failed: ${workflow.title}`,
            errorMessage: error.message,
            details: {
              stack: error.stack,
              errors: context.errors,
            },
          });
        } catch (dbError) {
          logger.error({ err: dbError }, '[WorkflowExecutor] Error logging workflow failure');
        }
      }

      this.log(context, `❌ Workflow execution failed: ${error.message}`);

      throw error;
    } finally {
      if (threadId) {
        WorkflowExecutorService.activeExecutions.delete(threadId);
      }
    }
  }

  /**
   * Execute a single node
   */
  private static async executeNode(
    node: WorkflowNode,
    workflow: Workflow,
    context: ExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputParams: Record<string, any>,
    threadId?: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    // Check if ALL incoming source actor nodes produced empty/no data — skip this node
    const incomingEdges = workflow.edges.filter(e => e.target === node.id);
    if (incomingEdges.length > 0) {
      const sourceActorNodes = incomingEdges
        .map(e => workflow.nodes.find(n => n.id === e.source))
        .filter(n => n && n.type === 'actor');

      if (sourceActorNodes.length > 0) {
        const allSourcesEmpty = sourceActorNodes.every(srcNode => {
          const outputKey = srcNode!.data.output_key || `${srcNode!.data.actorId}_output`;
          const srcData = context.nodesExecuted.get(outputKey);
          return !srcData || (Array.isArray(srcData) && srcData.length === 0);
        });

        if (allSourcesEmpty) {
          this.log(context, `⏭️  Skipping node ${node.id}: all source actor nodes produced no data`);
          // Store empty result so downstream nodes can also skip
          if (node.type === 'actor' && node.data.output_key) {
            context.nodesExecuted.set(node.data.output_key, []);
          }
          return null;
        }
      }
    }

    this.log(context, `📍 Executing node: ${node.id} (type: ${node.type})`);

    // Emit workflow step event for real-time progress updates
    const userId = context.userId;
    if (userId) {
      const stepName = this.getNodeStepName(node);
      webSocketEmitter.emitWorkflowStep(
        userId,
        workflow.platform || 'Lead Generation',
        node.id,
        stepName,
        undefined,
        { nodeType: node.type, nodeId: node.id },
        threadId
      );

      // Log step start to database
      try {
        const logType = node.type === 'actor' ? 'actor_start' : 'step';
        await createWorkflowLog({
          userId,
          executionId: context.executionId,
          threadId: threadId || null,
          logType,
          status: 'running',
          platform: workflow.platform || null,
          actorId: node.data.actorId || null,
          message: stepName,
          details: { nodeId: node.id, nodeType: node.type },
        });
      } catch (logError) {
        logger.error({ err: logError }, '[WorkflowExecutor] Error logging step start');
      }
    }

    if (node.type === 'llm') {
      return await this.executeLLMNode(node, context, inputParams);
    } else if (node.type === 'actor') {
      return await this.executeActorNode(node, context, inputParams, threadId, workflow);
    } else if (node.type === 'db_save' || node.type === 'dbSave' || node.type === 'saveToLeads' || node.type === 'saveToPosts') {
      // Normalize save nodes to common dbSave format for execution
      if (node.type === 'saveToLeads' || node.type === 'saveToPosts') {
        const target_table = node.type === 'saveToLeads' ? 'leads' : 'posts';
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nodeDataAny: any = node.data as any;
        node.data.dbSave = {
          enabled: true,
          target_table,
          field_mapping: nodeDataAny.field_mapping || nodeDataAny.mapping || {},
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      }
      return await this.executeDbSaveNode(node, workflow, context, threadId);
    }

    throw new Error(`Unknown node type: ${node.type}`);
  }

  /**
   * Execute LLM node - generates input parameters
   */
  private static async executeLLMNode(
    node: WorkflowNode,
    context: ExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputParams: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    // For now, pass through the input params
    // In production, would call OpenAI API to generate optimized search queries
    const llmInputs = {
      query: inputParams.query || inputParams.searchQuery || '',
      hashtags: inputParams.hashtags || [],
      filters: inputParams.filters || {},
      searchQuery: inputParams.searchQuery || '',
      location: inputParams.location || '',
      ...inputParams, // Ensure inputParams override defaults
    };

    context.nodesExecuted.set(node.data.output_key || 'llm_inputs', llmInputs);
    this.log(context, `✅ LLM node generated inputs: ${JSON.stringify(llmInputs)}`);

    return llmInputs;
  }

  /**
   * Execute actor node - calls Apify actor via apify-client
   */
  private static async executeActorNode(
    node: WorkflowNode,
    context: ExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputParams: Record<string, any>,
    threadId?: number,
    workflow?: Workflow,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    if (!node.data.actorId) {
      throw new Error(`Actor node ${node.id} missing actorId`);
    }

    const actorId = node.data.actorId;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeData = node.data as any;

    // Check if this node should iterate over results from a previous node
    const iterateOver = node.data.iterate_over;

    // If this node depends on iterate_over data but the source key doesn't exist
    // in context (parent node failed/errored), skip this node entirely
    if (iterateOver && !context.nodesExecuted.has(iterateOver)) {
      this.log(context, `⏭️  Skipping node ${node.id}: source data '${iterateOver}' not available (parent node may have failed)`);
      const outputKey = node.data.output_key || `${actorId}_output`;
      context.nodesExecuted.set(outputKey, []);
      return [];
    }

    if (iterateOver && context.nodesExecuted.has(iterateOver)) {
      const itemsToIterate = context.nodesExecuted.get(iterateOver);

      // NEW: Check if batch_collect mode is enabled - collect all values and make single API call
      if (nodeData.batch_collect?.enabled) {
        return await this.executeActorNodeBatched(node, context, inputParams, threadId, workflow, itemsToIterate);
      }
      
      this.log(context, `🔄 Iterating over results from: ${iterateOver}`);

      // Validate iteration field exists in source actor output
      const iterateOverField = node.data.iterate_over_field;
      if (iterateOverField && this.schemaRegistry && workflow) {
        // Find the source node that produced iterateOver results
        const sourceNode = workflow.nodes.find((n: WorkflowNode) => (n.data.output_key || `${n.data.actorId}_output`) === iterateOver);
        if (sourceNode && sourceNode.data.actorId) {
          const validationResult = this.schemaRegistry.validateIteration(
            sourceNode.data.actorId,
            actorId,
            iterateOverField
          );

          if (!validationResult.valid) {
            this.log(context, `⚠️ Schema validation warnings for iteration:`);
            validationResult.warnings.forEach(warning => {
              this.log(context, `  ⚠️ ${warning}`);
            });
          } else {
            this.log(context, `✅ Schema validation passed for iteration over ${iterateOverField}`);
          }
        }
      }

      if (!Array.isArray(itemsToIterate) || itemsToIterate.length === 0) {
        this.log(context, `⚠️  No items to iterate over in ${iterateOver}`);
        // Store empty result so downstream nodes can find it
        const outputKey = node.data.output_key || `${actorId}_output`;
        context.nodesExecuted.set(outputKey, []);
        return [];
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const allResults: any[] = [];
      let iterationFailures = 0;
      const outputKey = node.data.output_key || `${actorId}_output`;
      const configuredProfileNode = nodeData.immediateEnrichment?.enabled
        ? workflow?.nodes.find((candidate: WorkflowNode) => candidate.id === nodeData.immediateEnrichment?.profileNodeId)
        : undefined;
      const immediateSaveSource = configuredProfileNode
        ? (configuredProfileNode.data.output_key || `${configuredProfileNode.data.actorId}_output`)
        : outputKey;
      const canPersistEachIteration = workflow?.nodes.some((candidate: WorkflowNode) => {
        if (!['saveToLeads', 'db_save', 'dbSave'].includes(candidate.type)) return false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const candidateData = candidate.data as any;
        return (candidateData.iterate_over || candidateData.source_array) === immediateSaveSource;
      }) === true;

      // Execute the actor for each item
      for (let i = 0; i < itemsToIterate.length; i++) {
        if (context.requestedLeadLimit !== undefined) {
          const remaining = Math.max(0, context.requestedLeadLimit - context.persistedLeadCount);
          if (remaining === 0 || (!canPersistEachIteration && allResults.length >= remaining)) {
            this.log(context, `⏭️  Stopping ${node.id} iterations: reviewed lead cap ${remaining === 0 ? 'was filled' : 'candidate budget reached'}`);
            break;
          }
        }

        // Check for cancellation before each iteration
        if (await this.isExecutionCancelled(context.executionId)) {
          this.log(context, `🛑 Workflow cancelled by user - stopping at iteration ${i + 1}/${itemsToIterate.length}`);
          context.status = 'failed';

          // Emit WebSocket event for cancellation
          if (context.userId) {
            webSocketEmitter.emit(context.userId, 'workflow_cancelled', {
              executionId: context.executionId,
              message: `Workflow stopped by user at iteration ${i + 1}/${itemsToIterate.length}`,
              platform: workflow?.platform,
              resultsCollected: allResults.length,
            });
          }

          // Return whatever results we've collected so far
          const outputKey = node.data.output_key || `${actorId}_output`;
          context.nodesExecuted.set(outputKey, allResults);
          return allResults;
        }

        const currentItem = itemsToIterate[i];
        this.log(context, `🔄 Processing item ${i + 1}/${itemsToIterate.length}`);

        // Create a temporary context with _current_item
        const itemContext = {
          ...inputParams,
          ...Object.fromEntries(context.nodesExecuted),
          _current_item: currentItem,
        };

        this.log(context, `🎬 Calling Apify actor: ${actorId} (iteration ${i + 1})`);
        this.log(context, `📋 Current item keys: ${Object.keys(currentItem).join(', ')}`);
        this.log(context, `📋 Item context has _current_item: ${!!itemContext._current_item}`);

        // Use the same reviewed-input preparation as non-iterated actors so
        // downstream calls also honor the workflow-wide result cap.
        const actorInput = this.buildActorInput(node, context, itemContext, workflow);

        this.log(context, `📤 Actor input (sanitized): ${this.safeStringify(actorInput)}`);

        // Validate actor inputs
        const validation = this.validateActorInput(actorId, actorInput, node);
        if (!validation.valid) {
          this.log(context, `⚠️  Skipping item ${i + 1} due to validation errors: ${validation.errors.join(', ')}`);
          continue;
        }

        // Emit WebSocket event for sub-actor start
        const userId = context.userId;
        if (userId) {
          const actorDisplayName = this.cleanActorDisplayName(actorId);
          const itemLabel = currentItem.name || currentItem.title || currentItem.username || currentItem.query || `Item ${i + 1}`;

          webSocketEmitter.emitWorkflowStep(
            userId,
            workflow?.platform || 'Lead Generation',
            `${node.id}_iteration_${i + 1}`,
            `🔍 Extracting ${actorDisplayName} for: ${itemLabel}`,
            undefined,
            {
              nodeType: 'sub-actor',
              nodeId: node.id,
              iteration: i + 1,
              totalIterations: itemsToIterate.length,
              actorId: actorId,
              actorInput: this.sanitizeForLogging(actorInput),
            },
            threadId
          );

          // Log sub-actor start to database
          try {
            await createWorkflowLog({
              userId,
              executionId: context.executionId,
              threadId: threadId || null,
              logType: 'actor_start',
              status: 'running',
              platform: workflow?.platform || null,
              actorId: actorId,
              message: `Sub-actor ${i + 1}/${itemsToIterate.length}: Extracting ${actorDisplayName} for ${itemLabel}`,
              details: {
                nodeId: node.id,
                iteration: i + 1,
                totalIterations: itemsToIterate.length,
                actorInput: this.sanitizeForLogging(actorInput),
                currentItem: this.sanitizeForLogging(currentItem),
              },
            });
          } catch (logError) {
            logger.error({ err: logError }, '[WorkflowExecutor] Error logging sub-actor start');
          }
        }

        try {
          // Call actor using apify-client with fallback support
          const rawResults = await this.executeActorWithFallback(
            context.userId,
            actorId,
            actorInput,
            async (client, run) => {
              this.log(context, `✅ Actor execution completed: ${run.id}`);

              // Handle aborted actors gracefully
              if (run.status === 'ABORTED') {
                this.log(context, `⚠️  Actor was aborted, treating as completion with 0 results`);
                return [];
              }

              // Get results from the actor's default dataset
              const dataset = await client.dataset(run.defaultDatasetId).listItems();
              return dataset.items;
            },
            context,
            `${node.id}:iteration:${i + 1}`,
          );

          const { validResults, rejectedResults, emptyResults } = partitionProviderDatasetResults(rawResults);
          const sourcePostUrl = currentItem.postUrl
            || currentItem.post_url
            || currentItem.link_post
            || currentItem.inputUrl
            || ((currentItem.shortCode || currentItem.postId || currentItem.post_id) ? currentItem.url : undefined);
          const sourcePostText = currentItem.message
            || currentItem.text
            || currentItem.caption
            || currentItem.description;
          const results = validResults.map((result) => {
            const evidence: Record<string, unknown> = {};
            if (
              typeof sourcePostUrl === 'string'
              && sourcePostUrl.trim()
              && !result.postUrl
              && !result.post_url
              && !result.link_post
            ) {
              evidence.postUrl = sourcePostUrl;
              evidence.sourcePostUrls = [sourcePostUrl];
            }
            if (typeof sourcePostUrl === 'string' && sourcePostUrl.trim()
              && typeof sourcePostText === 'string' && sourcePostText.trim()
              && !result.sourcePostText) {
              evidence.sourcePostText = sourcePostText;
            }
            if (context.platform === 'twitter_competitor_followers') {
              const sourceProfileUsername = currentItem.userName || currentItem.screen_name || currentItem.username;
              const sourceProfileUrl = currentItem.twitterUrl || currentItem.profileUrl || currentItem.profile_url;
              if (typeof sourceProfileUsername === 'string' && sourceProfileUsername.trim() && !result.sourceProfileUsername) {
                evidence.sourceProfileUsername = sourceProfileUsername;
              }
              if (typeof sourceProfileUrl === 'string' && sourceProfileUrl.trim() && !result.sourceProfileUrl) {
                evidence.sourceProfileUrl = sourceProfileUrl;
              }
            }
            return Object.keys(evidence).length > 0 ? { ...result, ...evidence } : result;
          });
          await this.reconcileProviderDatasetOutcome(context, results.length, rejectedResults.length, emptyResults.length);
          if (rejectedResults.length > 0) {
            this.log(context, `⚠️ Rejected ${rejectedResults.length} provider error record(s) for item ${i + 1}`);
          }
          if (emptyResults.length > 0) {
            this.log(context, `ℹ️ Provider returned ${emptyResults.length} empty-result signal(s) for item ${i + 1}`);
          }
          if (rejectedResults.length > 0 && results.length === 0) {
            throw new Error(`Provider returned ${rejectedResults.length} error record(s) and no usable leads`);
          }

          this.log(context, `✅ Actor returned ${results.length} results for item ${i + 1}`);
          allResults.push(...results);

          // IMMEDIATE LEAD SAVING: Find and execute saveToLeads node for this iteration's results
          if (results.length > 0 && workflow) {
            await this.saveLeadsImmediately(results, node, workflow, context, threadId, i + 1, itemsToIterate.length);
          }

          // Emit WebSocket event for sub-actor completion
          if (userId) {
            const actorDisplayName = this.cleanActorDisplayName(actorId);
            const itemLabel = currentItem.name || currentItem.title || currentItem.username || currentItem.query || `Item ${i + 1}`;

            webSocketEmitter.emitWorkflowStep(
              userId,
              workflow?.platform || 'Lead Generation',
              `${node.id}_iteration_${i + 1}_complete`,
              `✅ Extracted ${results.length} leads from ${actorDisplayName} for: ${itemLabel}`,
              undefined,
              {
                nodeType: 'sub-actor-complete',
                nodeId: node.id,
                iteration: i + 1,
                totalIterations: itemsToIterate.length,
                actorId: actorId,
                resultsCount: results.length,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                sampleOutput: results.slice(0, 2).map((item: any) => this.sanitizeForLogging(item)),
              },
              threadId
            );

            // Log sub-actor completion to database
            try {
              await createWorkflowLog({
                userId,
                executionId: context.executionId,
                threadId: threadId || null,
                logType: 'actor_complete',
                status: 'completed',
                platform: workflow?.platform || null,
                actorId: actorId,
                message: `Sub-actor ${i + 1}/${itemsToIterate.length}: Extracted ${results.length} leads from ${actorDisplayName}`,
                leadsCount: results.length,
                details: {
                  nodeId: node.id,
                  iteration: i + 1,
                  totalIterations: itemsToIterate.length,
                  resultsCount: results.length,
                  sampleFields: results.length > 0 ? Object.keys(results[0]).slice(0, 15) : [],
                  // eslint-disable-next-line @typescript-eslint/no-explicit-any
                  sampleOutput: results.slice(0, 2).map((item: any) => this.sanitizeForLogging(item)),
                },
              });
            } catch (logError) {
              logger.error({ err: logError }, '[WorkflowExecutor] Error logging sub-actor completion');
            }
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
          iterationFailures++;
          this.log(context, `⚠️  Error processing item ${i + 1}: ${error.message}`);

          // Emit WebSocket event for sub-actor error
          if (userId) {
            const actorDisplayName = this.cleanActorDisplayName(actorId);
            const itemLabel = currentItem.name || currentItem.title || currentItem.username || currentItem.query || `Item ${i + 1}`;

            webSocketEmitter.emitWorkflowStep(
              userId,
              workflow?.platform || 'Lead Generation',
              `${node.id}_iteration_${i + 1}_error`,
              `❌ Error extracting ${actorDisplayName} for: ${itemLabel}`,
              undefined,
              {
                nodeType: 'sub-actor-error',
                nodeId: node.id,
                iteration: i + 1,
                totalIterations: itemsToIterate.length,
                actorId: actorId,
                error: error.message,
              },
              threadId
            );

            // Log sub-actor error to database
            try {
              await createWorkflowLog({
                userId,
                executionId: context.executionId,
                threadId: threadId || null,
                logType: 'actor_error',
                status: 'error',
                platform: workflow?.platform || null,
                actorId: actorId,
                message: `Sub-actor ${i + 1}/${itemsToIterate.length}: Error extracting ${actorDisplayName}`,
                errorMessage: error.message,
                details: {
                  nodeId: node.id,
                  iteration: i + 1,
                  totalIterations: itemsToIterate.length,
                },
              });
            } catch (logError) {
              logger.error({ err: logError }, '[WorkflowExecutor] Error logging sub-actor error');
            }
          }
          // Continue with next item instead of failing entire workflow
        }
      }

      if (iterationFailures > 0 && allResults.length === 0) {
        throw new Error(`All ${iterationFailures} provider iteration(s) failed; no usable leads were returned`);
      }

      context.nodesExecuted.set(outputKey, allResults);

      this.log(context, `✅ Iteration complete: ${allResults.length} total results from ${itemsToIterate.length} items`);

      // Log iteration completion to database
      if (context.userId) {
        try {
          await createWorkflowLog({
            userId: context.userId,
            executionId: context.executionId,
            threadId: threadId || null,
            logType: 'actor_complete',
            status: 'completed',
            platform: workflow?.platform || null,
            actorId: actorId,
            message: `Actor iteration completed: ${actorId.split('/').pop() || actorId}`,
            leadsCount: allResults.length,
            details: {
              outputKey,
              iterationCount: itemsToIterate.length,
              totalResults: allResults.length,
              iterateOver,
            },
          });
        } catch (logError) {
          logger.error({ err: logError }, '[WorkflowExecutor] Error logging iteration completion');
        }
      }

      // Handle database save if configured on the actor node
      if (node.data.dbSave?.enabled && allResults.length > 0) {
        this.log(context, `💾 Processing database save for actor node...`);
        const dbResult = await this.saveActorResultsToDb(
          allResults,
          node.data.dbSave,
          context,
          threadId
        );
        // Accumulate db_save_results across multiple save operations
        const prev1 = context.nodesExecuted.get('db_save_results') || { leadsCount: 0, postsCount: 0, saved: 0 };
        context.nodesExecuted.set('db_save_results', {
          leadsCount: (prev1.leadsCount || 0) + (dbResult.leadsCount || 0),
          postsCount: (prev1.postsCount || 0) + (dbResult.postsCount || 0),
          saved: (prev1.saved || 0) + (dbResult.saved || 0),
          leadIds: [...new Set([...(prev1.leadIds || []), ...(dbResult.leadIds || [])])],
        });
      }

      return allResults;
    }

    // Normal execution without iteration
    this.log(context, `🎬 Calling Apify actor: ${actorId}`);

    // Validate input compatibility with previous actor (if any)
    if (this.schemaRegistry && workflow && workflow.edges) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const incomingEdges = workflow.edges.filter((e: any) => e.target === node.id);
      if (incomingEdges.length > 0) {
        for (const edge of incomingEdges) {
          const sourceNode = workflow.nodes.find((n: WorkflowNode) => n.id === edge.source);
          if (sourceNode && sourceNode.type === 'actor' && sourceNode.data.actorId) {
            const validationResult = this.schemaRegistry.validateActorChain(
              sourceNode.data.actorId,
              actorId,
              node.data.inputMapping || {}
            );

            if (!validationResult.valid) {
              this.log(context, `⚠️ Schema validation warnings between ${sourceNode.data.actorId} → ${actorId}:`);
              validationResult.warnings.forEach(warning => {
                this.log(context, `  ⚠️ ${warning}`);
              });

              // Show suggested mappings if available
              if (validationResult.suggestions && validationResult.suggestions.length > 0) {
                this.log(context, `💡 Suggested field mappings:`);
                validationResult.suggestions.forEach(suggestion => {
                  this.log(context, `  💡 ${suggestion}`);
                });
              }
            } else {
              this.log(context, `✅ Schema validation passed for ${sourceNode.data.actorId} → ${actorId}`);
            }
          }
        }
      }
    }

    // Prepare actor input by mapping from context
    const actorInput = this.buildActorInput(node, context, inputParams, workflow);

    this.log(context, `📤 Actor input: ${JSON.stringify(actorInput)}`);

    // Validate actor inputs
    const validation = this.validateActorInput(actorId, actorInput, node);
    if (!validation.valid) {
      // For follower scraper with missing sessionid, skip gracefully instead of throwing
      if (actorId.includes('followers') && validation.errors.some(e => e.includes('sessionid'))) {
        this.log(context, `⚠️  Skipping ${node.id}: ${validation.errors.join(', ')}`);
        const outputKey = node.data.output_key || `${actorId}_output`;
        context.nodesExecuted.set(outputKey, []);

        // Emit WebSocket warning
        const userId = context.userId;
        if (userId) {
          webSocketEmitter.emitWorkflowStep(
            userId,
            workflow?.platform || 'Lead Generation',
            node.id,
            `⚠️  Skipped follower extraction - Instagram session ID not configured`,
            undefined,
            { warning: true, message: validation.errors.join(', ') },
          );
        }
        return [];
      }
      throw new Error(`Invalid actor input: ${validation.errors.join(', ')}`);
    }

    try {
      // Call actor using apify-client with fallback support
      const rawResults = await this.executeActorWithFallback(
        context.userId,
        actorId,
        actorInput,
        async (client, run) => {
          this.log(context, `✅ Actor execution completed: ${run.id}`);
          this.log(context, `   Status: ${run.status}`);
          this.log(context, `   Exit code: ${run.exitCode}`);

          // Handle aborted actors gracefully
          if (run.status === 'ABORTED') {
            this.log(context, `⚠️  Actor was aborted, returning empty results`);
            return [];
          }

          // Get results from the actor's default dataset
          const dataset = await client.dataset(run.defaultDatasetId).listItems();
          return dataset.items;
        },
        context,
        node.id,
      );

      const { validResults, rejectedResults, emptyResults } = partitionProviderDatasetResults(rawResults);
      // Keep the complete provider candidate pool through relevance validation.
      // The reviewed cap is enforced while persisting accepted leads below; slicing
      // here can discard a valid in-region candidate merely because an earlier
      // provider row failed the reviewed geography or ICP constraints.
      const results = validResults;
      await this.reconcileProviderDatasetOutcome(context, results.length, rejectedResults.length, emptyResults.length);
      if (rejectedResults.length > 0) {
        this.log(context, `⚠️ Rejected ${rejectedResults.length} provider error record(s) from ${actorId}`);
      }
      if (emptyResults.length > 0) {
        this.log(context, `ℹ️ Provider returned ${emptyResults.length} empty-result signal(s) from ${actorId}`);
      }
      if (rejectedResults.length > 0 && results.length === 0) {
        throw new Error(`Provider returned ${rejectedResults.length} error record(s) and no usable leads`);
      }

      const outputKey = node.data.output_key || `${actorId}_output`;
      context.nodesExecuted.set(outputKey, results);

      this.log(context, `✅ Actor returned ${results.length} results`);

      // Log actor completion to database with detailed input/output
      if (context.userId) {
        try {
          // Get sample output data (limit to first 3 items, sanitized)
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sampleOutput = results.slice(0, 3).map((item: any) => {
            const sanitized = this.sanitizeForLogging(item);
            // Limit field count to prevent huge logs
            const keys = Object.keys(sanitized).slice(0, 15);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return keys.reduce((acc: Record<string, any>, key: string) => {
              acc[key] = sanitized[key];
              return acc;
            }, {});
          });

          await createWorkflowLog({
            userId: context.userId,
            executionId: context.executionId,
            threadId: threadId || null,
            logType: 'actor_complete',
            status: 'completed',
            platform: workflow?.platform || null,
            actorId: actorId,
            message: `Actor completed: ${actorId.split('/').pop() || actorId}`,
            leadsCount: results.length,
            details: {
              outputKey,
              resultCount: results.length,
              sampleFields: results.length > 0 ? Object.keys(results[0]).slice(0, 15) : [],
              actorInput: this.sanitizeForLogging(actorInput),
              sampleOutput,
            },
          });
        } catch (logError) {
          logger.error({ err: logError }, '[WorkflowExecutor] Error logging actor completion');
        }
      }

      // Handle database save if configured on the actor node
      if (node.data.dbSave?.enabled) {
        this.log(context, `💾 Processing database save for actor node...`);
        const dbResult = await this.saveActorResultsToDb(
          results,
          node.data.dbSave,
          context,
          threadId
        );
        // Accumulate db_save_results across multiple save operations
        const prev2 = context.nodesExecuted.get('db_save_results') || { leadsCount: 0, postsCount: 0, saved: 0 };
        context.nodesExecuted.set('db_save_results', {
          leadsCount: (prev2.leadsCount || 0) + (dbResult.leadsCount || 0),
          postsCount: (prev2.postsCount || 0) + (dbResult.postsCount || 0),
          saved: (prev2.saved || 0) + (dbResult.saved || 0),
          leadIds: [...new Set([...(prev2.leadIds || []), ...(dbResult.leadIds || [])])],
        });
      }

      return results;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      let errorMessage = `Actor execution failed: ${error.message}`;

      // Add more context for common errors
      if (error.message?.includes('must be array')) {
        errorMessage += ` (Hint: Check that array fields like locations, currentJobTitles, etc. are passed as arrays, not strings)`;
      } else if (error.message?.includes('Input is not valid')) {
        errorMessage += ` (Check the actor input schema in the workflow JSON)`;
      }

      this.log(context, `❌ ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }

  /**
   * Execute actor node in batched mode - collects all values first and makes single API call
   * This is more efficient than iterating one-by-one for actors that accept arrays (like instagram-profile-scraper)
   */
  private static async executeActorNodeBatched(
    node: WorkflowNode,
    context: ExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputParams: Record<string, any>,
    threadId?: number,
    workflow?: Workflow,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    itemsToIterate?: any[]
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    const actorId = node.data.actorId!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const nodeData = node.data as any;
    const batchConfig = nodeData.batch_collect;
    
    this.log(context, `📦 Batch collection mode enabled for: ${actorId}`);
    
    if (!Array.isArray(itemsToIterate) || itemsToIterate.length === 0) {
      this.log(context, `⚠️  No items to batch process in ${nodeData.iterate_over}`);
      const outputKey = node.data.output_key || `${actorId}_output`;
      context.nodesExecuted.set(outputKey, []);
      return [];
    }
    
    // Extract unique values from the source field
    const sourceField = batchConfig.source_field; // e.g., "ownerUsername"
    const targetField = batchConfig.target_field; // e.g., "usernames"
    
    if (!sourceField || !targetField) {
      this.log(context, `⚠️  batch_collect requires source_field and target_field`);
      throw new Error(`batch_collect configuration incomplete for node ${node.id}`);
    }
    
    // Collect all unique values from source items, filtering out errors/empty
    const uniqueValues = new Set<string>();
    const sourcePostUrlsByValue = new Map<string, string[]>();
    let skippedCount = 0;
    
    for (const item of itemsToIterate) {
      // Skip items that have errors
      if (item.error || item.errorDescription || item.requestErrorMessages?.length > 0) {
        skippedCount++;
        continue;
      }
      
      const value = this.getNested(item, sourceField);
      if (value && typeof value === 'string' && value.trim()) {
        // Sanitize: remove @ prefix if present
        const cleanValue = value.replace(/^@/, '').trim();
        if (cleanValue) {
          uniqueValues.add(cleanValue);
          // Profile scrapers return a fresh profile record and otherwise lose
          // the source post that produced a derived author/commenter/liker.
          // Preserve that relationship by the exact collected identity.
          const sourcePostUrl = sourceField === 'ownerUsername'
            ? item.postUrl || item.post_url || item.url
            : item.postUrl || item.post_url || item.link_post;
          if (typeof sourcePostUrl === 'string' && sourcePostUrl.trim()) {
            const existing = sourcePostUrlsByValue.get(cleanValue.toLowerCase()) || [];
            if (!existing.includes(sourcePostUrl)) existing.push(sourcePostUrl);
            sourcePostUrlsByValue.set(cleanValue.toLowerCase(), existing);
          }
        }
      }
    }
    
    if (uniqueValues.size === 0) {
      this.log(context, `⚠️  No valid ${sourceField} values found (${skippedCount} items had errors)`);
      const outputKey = node.data.output_key || `${actorId}_output`;
      context.nodesExecuted.set(outputKey, []);
      return [];
    }
    
    let batchValues = Array.from(uniqueValues);
    if (context.requestedLeadLimit !== undefined) {
      const remaining = Math.max(0, context.requestedLeadLimit - context.persistedLeadCount);
      if (remaining === 0) {
        this.log(context, `⏭️  Skipping batch actor ${actorId}: reviewed lead cap already reached`);
        const outputKey = node.data.output_key || `${actorId}_output`;
        context.nodesExecuted.set(outputKey, []);
        return [];
      }
      if (batchValues.length > remaining) {
        this.log(context, `✂️  Limiting batched ${sourceField} values from ${batchValues.length} to ${remaining} remaining reviewed leads`);
        batchValues = batchValues.slice(0, remaining);
      }
    }
    this.log(context, `📦 Collected ${batchValues.length} unique ${sourceField} values (skipped ${skippedCount} errors)`);
    
    // Build actor input with batched values
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let actorInput: Record<string, any> = {};
    
    // Start with any static input mappings (excluding the iterated field)
    const inputMapping = nodeData.inputMapping || {};
    for (const [key, value] of Object.entries(inputMapping)) {
      if (key === targetField) continue; // Skip the batched field, we'll add it separately
      
      // Resolve any template values
      const resolvedValue = this.resolveTemplatesRecursively(value, {
        ...inputParams,
        ...Object.fromEntries(context.nodesExecuted),
        settings: {
          max_results_per_platform: inputParams.max_results_per_platform || 20,
          instagram_session_id: inputParams.instagram_session_id || '',
        },
      }, context);
      actorInput[key] = resolvedValue;
    }
    
    // Add the batched values
    actorInput[targetField] = batchValues;
    
    // Sanitize actor inputs
    actorInput = this.sanitizeActorInputs(actorId, actorInput);
    
    this.log(context, `📤 Batched actor input: ${targetField}=[${batchValues.length} items], other keys: ${Object.keys(actorInput).filter(k => k !== targetField).join(', ')}`);
    
    // Emit WebSocket event for batched actor start
    const userId = context.userId;
    const actorDisplayName = this.cleanActorDisplayName(actorId);
    if (userId) {
      webSocketEmitter.emitWorkflowStep(
        userId,
        workflow?.platform || 'Lead Generation',
        `${node.id}_batch`,
        `📦 Extracting ${actorDisplayName} for ${batchValues.length} profiles...`,
        undefined,
        { 
          nodeType: 'batch-actor',
          nodeId: node.id,
          actorId: actorId,
          batchSize: batchValues.length,
        },
        threadId
      );
      
      // Log batch start to database
      try {
        await createWorkflowLog({
          userId,
          executionId: context.executionId,
          threadId: threadId || null,
          logType: 'actor_start',
          status: 'running',
          platform: workflow?.platform || null,
          actorId: actorId,
          message: `Batch actor: Extracting ${actorDisplayName} for ${batchValues.length} profiles`,
          details: { 
            nodeId: node.id, 
            batchSize: batchValues.length,
            sampleValues: batchValues.slice(0, 5),
          },
        });
      } catch (logError) {
        logger.error({ err: logError }, '[WorkflowExecutor] Error logging batch actor start');
      }
    }
    
    try {
      // Call actor with batched input
      const rawResults = await this.executeActorWithFallback(
        context.userId,
        actorId,
        actorInput,
        async (client, run) => {
          this.log(context, `✅ Batch actor execution completed: ${run.id}`);
          this.log(context, `   Status: ${run.status}`);
          this.log(context, `   Exit code: ${run.exitCode}`);
          
          if (run.status === 'ABORTED') {
            this.log(context, `⚠️  Batch actor was aborted, returning empty results`);
            return [];
          }
          
          const dataset = await client.dataset(run.defaultDatasetId).listItems();
          return dataset.items;
        },
        context,
        `${node.id}:batch`,
      );

      const { validResults, rejectedResults, emptyResults } = partitionProviderDatasetResults(rawResults);
      const results = validResults.map(result => {
        const resultValue = this.getNested(result, 'username')
          || this.getNested(result, sourceField)
          || this.getNested(result, 'input.username');
        const sourcePostUrls = typeof resultValue === 'string'
          ? sourcePostUrlsByValue.get(resultValue.replace(/^@/, '').trim().toLowerCase())
          : undefined;
        if (!sourcePostUrls?.length) return result;
        return {
          ...result,
          postUrl: result.postUrl || result.post_url || result.link_post || sourcePostUrls[0],
          sourcePostUrls,
        };
      });
      await this.reconcileProviderDatasetOutcome(context, results.length, rejectedResults.length, emptyResults.length);
      if (rejectedResults.length > 0) {
        this.log(context, `⚠️ Rejected ${rejectedResults.length} provider error record(s) from batched actor ${actorId}`);
      }
      if (emptyResults.length > 0) {
        this.log(context, `ℹ️ Provider returned ${emptyResults.length} empty-result signal(s) from batched actor ${actorId}`);
      }
      if (rejectedResults.length > 0 && results.length === 0) {
        throw new Error(`Provider returned ${rejectedResults.length} error record(s) and no usable leads`);
      }
      
      const outputKey = node.data.output_key || `${actorId}_output`;
      context.nodesExecuted.set(outputKey, results);
      
      this.log(context, `✅ Batch actor returned ${results.length} results for ${batchValues.length} profiles`);
      
      // Emit WebSocket event for batch completion
      if (userId) {
        webSocketEmitter.emitWorkflowStep(
          userId,
          workflow?.platform || 'Lead Generation',
          `${node.id}_batch_complete`,
          `✅ Extracted ${results.length} leads from ${actorDisplayName}`,
          undefined,
          { 
            nodeType: 'batch-actor-complete',
            nodeId: node.id,
            actorId: actorId,
            batchSize: batchValues.length,
            resultsCount: results.length,
          },
          threadId
        );
      }
      
      // Log batch completion to database
      if (context.userId) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const sampleOutput = results.slice(0, 3).map((item: any) => {
            const sanitized = this.sanitizeForLogging(item);
            const keys = Object.keys(sanitized).slice(0, 15);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return keys.reduce((acc: Record<string, any>, key: string) => {
              acc[key] = sanitized[key];
              return acc;
            }, {});
          });
          
          await createWorkflowLog({
            userId: context.userId,
            executionId: context.executionId,
            threadId: threadId || null,
            logType: 'actor_complete',
            status: 'completed',
            platform: workflow?.platform || null,
            actorId: actorId,
            message: `Batch actor completed: ${actorDisplayName}`,
            leadsCount: results.length,
            details: {
              outputKey,
              batchSize: batchValues.length,
              resultCount: results.length,
              sampleFields: results.length > 0 ? Object.keys(results[0]).slice(0, 15) : [],
              sampleOutput,
            },
          });
        } catch (logError) {
          logger.error({ err: logError }, '[WorkflowExecutor] Error logging batch actor completion');
        }
      }
      
      // Handle database save if configured on the actor node
      if (node.data.dbSave?.enabled) {
        this.log(context, `💾 Processing database save for batch actor node...`);
        const dbResult = await this.saveActorResultsToDb(
          results,
          node.data.dbSave,
          context,
          threadId
        );
        // Accumulate db_save_results across multiple save operations
        const prev3 = context.nodesExecuted.get('db_save_results') || { leadsCount: 0, postsCount: 0, saved: 0 };
        context.nodesExecuted.set('db_save_results', {
          leadsCount: (prev3.leadsCount || 0) + (dbResult.leadsCount || 0),
          postsCount: (prev3.postsCount || 0) + (dbResult.postsCount || 0),
          saved: (prev3.saved || 0) + (dbResult.saved || 0),
          leadIds: [...new Set([...(prev3.leadIds || []), ...(dbResult.leadIds || [])])],
        });
      }
      
      return results;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      const errorMessage = `Batch actor execution failed: ${error.message}`;
      this.log(context, `❌ ${errorMessage}`);
      
      // Emit error event
      if (userId) {
        const actorDisplayName = this.cleanActorDisplayName(actorId);
        webSocketEmitter.emitWorkflowStep(
          userId,
          workflow?.platform || 'Lead Generation',
          `${node.id}_batch_error`,
          `❌ Batch ${actorDisplayName} failed: ${error.message}`,
          undefined,
          { 
            nodeType: 'batch-actor-error',
            nodeId: node.id,
            error: error.message,
          },
          threadId
        );
      }
      
      throw new Error(errorMessage);
    }
  }

  /**
   * Utility: Slugify a string
   */
  private static slugify(text: string): string {
    return text
      .toLowerCase()
      .trim()
      .replace(/[^\w\s-]/g, '')
      .replace(/[\s_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .substring(0, 50);
  }

  /**
   * Utility: Extract city from address
   */
  private static extractCity(address: string): string {
    if (!address) return '';
    const parts = address.split(',');
    return parts.length >= 2 ? parts[parts.length - 2].trim() : '';
  }

  private static async loadExistingReviewedLeads(
    context: ExecutionContext,
    threadId?: number,
  ): Promise<Array<Record<string, any>>> {
    if (context.existingReviewedLeads) return context.existingReviewedLeads;
    if (!context.userId) return [];

    const predicates = [eq(leadsTable.userId, context.userId), isNull(leadsTable.deletedAt)];
    if (threadId) {
      predicates.push(sql`(${leadsTable.campaignData}->>'threadId')::int = ${threadId}` as any);
    }
    const existingReviewedLeads = await db.select()
      .from(leadsTable)
      .where(and(...predicates));
    context.existingReviewedLeads = existingReviewedLeads;
    return existingReviewedLeads;
  }

  private static async persistReviewedLeadRecords(
    records: Array<Record<string, any>>,
    context: ExecutionContext,
    threadId?: number,
  ): Promise<{
    savedLeads: Array<Record<string, any>>;
    recoveredLeads: Array<Record<string, any>>;
    duplicateLeads: Array<Record<string, any>>;
    rejectedCount: number;
  }> {
    const existingLeads = await this.loadExistingReviewedLeads(context, threadId);
    const savedLeads: Array<Record<string, any>> = [];
    const recoveredLeads: Array<Record<string, any>> = [];
    const duplicateLeads: Array<Record<string, any>> = [];
    let rejectedCount = 0;
    let persistenceErrors = 0;

    const usesRelevanceValidation = (record: Record<string, any>) => shouldApplyPostProviderRelevanceValidation(
      context.platform || record.platformType || record.source || '',
      context.providerRun?.actorId,
    );
    const relevanceByIndex = new Map<number, ReturnType<typeof evaluateLeadRelevance>>();
    const semanticByIndex = new Map<number, SemanticLeadQualification>();
    if (context.userId && context.reviewedLeadConstraints) {
      const softReasons = new Set(['industry_mismatch', 'industry_missing']);
      const eligibleIndices = records.flatMap((record, index) => {
        if (!usesRelevanceValidation(record)) return [];
        if (context.platform === 'twitter_competitor_followers'
          || context.platform === 'twitter_competitor_users') {
          if (!hasStableTwitterProfileIdentity(record)) return [];
        }
        const relevance = evaluateLeadRelevance(
          record,
          context.reviewedLeadConstraints,
          context.platform || record.platformType || record.source || '',
        );
        relevanceByIndex.set(index, relevance);
        return relevance.reasons.length > 0
          && relevance.reasons.every((reason) => softReasons.has(reason))
          ? [index]
          : [];
      });
      const budget = context.semanticLeadClassificationBudget;
      const remainingLeadLimit = context.requestedLeadLimit === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, context.requestedLeadLimit - context.persistedLeadCount);
      const selectedIndices = eligibleIndices.slice(
        0,
        Math.max(0, Math.min(budget.remainingLeads, remainingLeadLimit)),
      );
      for (let offset = 0; offset < selectedIndices.length && budget.remainingBatches > 0; offset += JEV_LEAD_BATCH_SIZE) {
        const batchIndices = selectedIndices.slice(offset, offset + JEV_LEAD_BATCH_SIZE);
        budget.remainingBatches--;
        budget.remainingLeads = Math.max(0, budget.remainingLeads - batchIndices.length);
        const decisions = await classifyJevLeadSemanticsBatch(
          context.userId,
          batchIndices.map((index) => records[index]),
          context.reviewedLeadConstraints,
        );
        for (const [batchIndex, semantic] of decisions) {
          const recordIndex = batchIndices[batchIndex];
          if (recordIndex !== undefined) semanticByIndex.set(recordIndex, semantic);
        }
      }
    }

    for (let recordIndex = 0; recordIndex < records.length; recordIndex++) {
      const record = records[recordIndex];
      const remaining = context.requestedLeadLimit === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, context.requestedLeadLimit - context.persistedLeadCount);
      if (remaining <= 0) break;

      const platform = context.platform || record.platformType || record.source || '';
      if (context.platform === 'twitter_competitor_followers'
        || context.platform === 'twitter_competitor_users') {
        if (!hasStableTwitterProfileIdentity(record)) {
          rejectedCount++;
          this.log(context, '⛔ Rejected Twitter profile without a stable public handle');
          continue;
        }
      }
      if (usesRelevanceValidation(record)) {
        const deterministicRelevance = relevanceByIndex.get(recordIndex) || evaluateLeadRelevance(
          record,
          context.reviewedLeadConstraints,
          platform,
        );
        const semantic = semanticByIndex.get(recordIndex);
        const relevance = applySemanticLeadRelevance(deterministicRelevance, semantic);
        if (!relevance.accepted) {
          rejectedCount++;
          this.log(context, `⛔ Rejected provider lead: ${relevance.reasons.join(', ')}`);
          continue;
        }
        if (semantic && relevance !== deterministicRelevance) {
          this.log(context, `✅ Accepted provider lead with validated semantic ${semantic.band} evidence`);
        }
      } else {
        this.log(context, '✅ Accepted provider lead using the reviewed provider-input targeting');
      }

      const sourceRecord = {
        platform: context.platform || record.platformType || record.source || 'workflow',
        actorId: context.providerRun?.actorId || record.actorId || null,
        actorRunId: context.providerRun?.actorRunId || null,
        datasetId: context.providerRun?.datasetId || null,
        executionId: context.executionId,
        raw: record.rawData || null,
      };
      const duplicate = findDuplicateLead(record, existingLeads);
      if (duplicate) {
        const existingCampaignData = duplicate.campaignData && typeof duplicate.campaignData === 'object'
          ? duplicate.campaignData
          : {};
        const existingSources = Array.isArray(existingCampaignData.sourceReceipts)
          ? existingCampaignData.sourceReceipts
          : [];
        const alreadyPersistedForExecution = existingSources.some((value: unknown) => (
          value
          && typeof value === 'object'
          && (value as Record<string, unknown>).executionId === context.executionId
        ));
        const receipt = {
          platform: sourceRecord.platform,
          actorRunId: sourceRecord.actorRunId,
          datasetId: sourceRecord.datasetId,
          executionId: sourceRecord.executionId,
        };
        const sourceReceipts = appendLeadSourceReceipt(existingSources, receipt);
        const { LeadModel } = await import('../models/leads/functions.js');
        const merged = await LeadModel.update(Number(duplicate.id), {
            email: duplicate.email || record.email || null,
            phone: duplicate.phone || record.phone || null,
            companyPhone: duplicate.companyPhone || record.companyPhone || null,
            website: duplicate.website || record.website || null,
            rawData: appendLeadSourceRecord(duplicate.rawData, sourceRecord),
            campaignData: { ...existingCampaignData, sourceReceipts },
            updatedAt: new Date(),
          });
        const mergedLead = merged || duplicate;
        Object.assign(duplicate, mergedLead);
        const mergedLeadId = Number(mergedLead.id);
        if (alreadyPersistedForExecution && !context.countedLeadIds.has(mergedLeadId)) {
          recoveredLeads.push(mergedLead);
          context.countedLeadIds.add(mergedLeadId);
          context.persistedLeadCount++;
        } else {
          duplicateLeads.push(mergedLead);
        }
        continue;
      }

      try {
        const campaignData = record.campaignData && typeof record.campaignData === 'object'
          ? record.campaignData
          : {};
        const { LeadModel } = await import('../models/leads/functions.js');
        const saved = await LeadModel.create({
          ...record,
          source: String(record.source || context.platform || 'workflow'),
          status: String(record.status || 'new'),
          rawData: appendLeadSourceRecord(record.rawData, sourceRecord),
          campaignData: {
            ...campaignData,
            ...(threadId ? { threadId } : {}),
            sourceReceipts: [{
              platform: sourceRecord.platform,
              actorRunId: sourceRecord.actorRunId,
              datasetId: sourceRecord.datasetId,
              executionId: sourceRecord.executionId,
            }],
          },
        });
        if (saved) {
          savedLeads.push(saved);
          existingLeads.push(saved);
          context.countedLeadIds.add(Number(saved.id));
          context.persistedLeadCount++;
        }
      } catch (error: any) {
        rejectedCount++;
        persistenceErrors++;
        this.log(context, `⚠️ Rejected lead during persistence: ${error.message}`);
      }
    }

    if (context.providerRun) {
      const current = context.providerMetrics.get(context.providerRun.id) || { persisted: 0, duplicates: 0, rejected: 0 };
      const metrics = {
        ...current,
        persisted: current.persisted + savedLeads.length + recoveredLeads.length,
        duplicates: current.duplicates + duplicateLeads.length,
        rejected: current.rejected + rejectedCount,
        persistenceErrors: (current.persistenceErrors || 0) + persistenceErrors,
      };
      context.providerMetrics.set(context.providerRun.id, metrics);
      const acceptedCount = metrics.persisted + metrics.duplicates;
      // An out-of-ICP candidate is a successful filtering decision, not an
      // actor failure. Only actual provider/persistence errors mean failure.
      const status = classifyReviewedProviderOutcome(metrics);
      context.providerRun = await updateLeadGenerationProviderRun(context.providerRun.id, {
        status,
        acceptedCount,
        persistedCount: metrics.persisted,
        duplicateCount: metrics.duplicates,
        rejectedCount: metrics.rejected,
        error: metrics.persistenceErrors > 0
          ? `${metrics.persistenceErrors} lead record(s) could not be saved.`
          : (metrics.providerErrors || 0) > 0 ? context.providerRun.error : null,
        heartbeatAt: new Date(),
        completedAt: new Date(),
      });
    }

    if (context.providerRun && context.platform) {
      const { updateScrapingDetailByExecutionAndPlatform } = await import('../models/scrapingDetails/functions');
      await updateScrapingDetailByExecutionAndPlatform(context.executionId, context.platform, {
        totalLeadsFound: context.persistedLeadCount,
        // This is an incremental save inside a potentially multi-actor run.
        // executeWorkflow owns the final platform status after all nodes end.
        status: 'running',
        error: null,
        completedAt: null,
      });
    }

    return { savedLeads, recoveredLeads, duplicateLeads, rejectedCount };
  }

  /**
   * Save leads immediately after each sub-actor iteration completes
   * This finds the saveToLeads node that depends on this actor's output and executes it
   * Optionally enriches leads with profile data if a profile scraper node is configured
   */
  private static async saveLeadsImmediately(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    results: any[],
    actorNode: WorkflowNode,
    workflow: Workflow,
    context: ExecutionContext,
    threadId?: number,
    iteration?: number,
    totalIterations?: number
  ): Promise<void> {
    const outputKey = actorNode.data.output_key || `${actorNode.data.actorId}_output`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const actorNodeData = actorNode.data as any;

    // Check if this actor node has immediate enrichment configured
    // This is controlled by the workflow JSON's immediateEnrichment property
    const immediateEnrichment = actorNodeData.immediateEnrichment;

    // Find profile enrichment node based on workflow configuration
    let profileEnrichmentNode: WorkflowNode | undefined;
    if (immediateEnrichment?.enabled && immediateEnrichment?.profileNodeId) {
      // Use explicitly configured profile node
      profileEnrichmentNode = workflow.nodes.find((n: WorkflowNode) => n.id === immediateEnrichment.profileNodeId);
    } else if (immediateEnrichment?.enabled) {
      // Find profile enrichment node that depends on this actor's output
      profileEnrichmentNode = workflow.nodes.find((n: WorkflowNode) => {
        if (n.type !== 'actor') return false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const nodeData = n.data as any;
        return nodeData.iterate_over === outputKey && nodeData.isProfileEnrichment === true;
      });
    }

    // Find the saveToLeads node - it could depend on the profile enrichment output or directly on current output
    const saveNode = workflow.nodes.find((n: WorkflowNode) => {
      if (n.type !== 'saveToLeads' && n.type !== 'db_save' && n.type !== 'dbSave') return false;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodeData = n.data as any;
      // Check if it depends on profile enrichment output
      if (profileEnrichmentNode) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const profileOutputKey = (profileEnrichmentNode.data as any).output_key || `${(profileEnrichmentNode.data as any).actorId}_output`;
        if (nodeData.iterate_over === profileOutputKey || nodeData.source_array === profileOutputKey) {
          return true;
        }
      }
      // Or directly on current actor output
      return nodeData.iterate_over === outputKey || nodeData.source_array === outputKey;
    });

    if (!saveNode) {
      this.log(context, `📝 No immediate saveToLeads node found for ${outputKey}, will save at end`);
      return;
    }

    this.log(context, `📝 Saving ${results.length} leads immediately from iteration ${iteration}/${totalIterations}`);

    // If there's a profile enrichment node configured for immediate enrichment, call it
    let enrichedResults = results;
    if (profileEnrichmentNode && context.userId) {
      // Get the username field from immediateEnrichment config
      const usernameFieldFromConfig = immediateEnrichment?.usernameField;
      enrichedResults = await this.enrichWithProfileData(
        results,
        profileEnrichmentNode,
        workflow,
        context,
        iteration,
        totalIterations,
        usernameFieldFromConfig
      );
    }

    try {
      // Temporarily set the enriched results in context for the save operation
      const previousResults = context.nodesExecuted.get(outputKey) || [];
      // Use enriched results if available, which may have profile enrichment output key
      const profileOutputKey = profileEnrichmentNode
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? ((profileEnrichmentNode.data as any).output_key || `${(profileEnrichmentNode.data as any).actorId}_output`)
        : outputKey;
      context.nodesExecuted.set(profileOutputKey, enrichedResults);
      context.nodesExecuted.set(outputKey, results); // Keep original for reference

      // Normalize save node config
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const saveNodeData = saveNode.data as any;
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const target_table = saveNode.type === 'saveToLeads' ? 'leads' : (saveNodeData.target_table || 'leads');
      const field_mapping = saveNodeData.field_mapping || saveNodeData.mapping || {};

      // Get the items to save - prefer enriched results
      const iterateOver = saveNodeData.iterate_over || profileOutputKey || outputKey;
      let itemsToSave = context.nodesExecuted.get(iterateOver);

      // If no items from iterate_over, use enriched results directly
      if (!itemsToSave || !Array.isArray(itemsToSave) || itemsToSave.length === 0) {
        itemsToSave = enrichedResults;
      }

      if (!itemsToSave || !Array.isArray(itemsToSave) || itemsToSave.length === 0) {
        this.log(context, `⚠️ No items to save for immediate save operation`);
        // Restore previous results
        context.nodesExecuted.set(outputKey, previousResults);
        return;
      }

      // Save to database
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const leadRecords = itemsToSave.map((item: any) => {
        const mappedRecord = this.mapActorResultToLead(item, field_mapping, context);

        // Add thread ID if available - store in campaignData for thread filtering
        if (threadId) {
          mappedRecord.campaignData = { ...(mappedRecord.campaignData || {}), threadId: threadId };
        }

        // Add promptId if available in context for ICP relationship
        if (context.promptId) {
          mappedRecord.promptId = context.promptId;
        }

        return mappedRecord;
      });

      // Resolve sourcePostId from previously saved posts in this workflow
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const immPostUrlToIdMap: Record<string, number> = (context as any).postUrlToIdMap || {};
      if (Object.keys(immPostUrlToIdMap).length > 0) {
        for (let i = 0; i < leadRecords.length; i++) {
          const rec = leadRecords[i];
          if (!rec.sourcePostId) {
            const item = itemsToSave[i];
            const postRef = item?.postUrl || item?.post_url || item?.url || item?.link_post || item?.inputUrl;
            if (postRef && immPostUrlToIdMap[postRef]) {
              rec.sourcePostId = immPostUrlToIdMap[postRef];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } else if ((context as any).savedPostIds?.length === 1) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              rec.sourcePostId = (context as any).savedPostIds[0];
            }
          }
        }
      }

      const { savedLeads, recoveredLeads, duplicateLeads, rejectedCount } = await this.persistReviewedLeadRecords(
        leadRecords,
        context,
        threadId,
      );
      this.log(
        context,
        `✅ Immediately persisted ${savedLeads.length} new and recovered ${recoveredLeads.length} existing lead IDs from iteration ${iteration} (${duplicateLeads.length} cross-provider duplicates merged, ${rejectedCount} rejected)`,
      );

      // Track saved leads to prevent duplicate saves at the end
      if (!context.savedLeadIds) {
        context.savedLeadIds = new Set<number>();
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      savedLeads.forEach((lead: any) => context.savedLeadIds!.add(lead.id));
      recoveredLeads.forEach((lead: any) => context.savedLeadIds!.add(lead.id));

      // Track which save node IDs have been handled by immediate save (per-node, not global)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (!(context as any).__immediatelySavedNodeIds) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (context as any).__immediatelySavedNodeIds = new Set<string>();
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (context as any).__immediatelySavedNodeIds.add(saveNode.id);

      // Accumulate db_save_results (leadsCount) across all immediate saves
      const prevDbSave = context.nodesExecuted.get('db_save_results') || { leadsCount: 0, postsCount: 0, saved: 0 };
      context.nodesExecuted.set('db_save_results', {
        leadsCount: (prevDbSave.leadsCount || 0) + savedLeads.length + recoveredLeads.length,
        postsCount: prevDbSave.postsCount || 0,
        saved: (prevDbSave.saved || 0) + savedLeads.length + recoveredLeads.length,
        leadIds: [...new Set([
          ...(prevDbSave.leadIds || []),
          ...savedLeads.map((lead: Record<string, unknown>) => Number(lead.id)),
          ...recoveredLeads.map((lead: Record<string, unknown>) => Number(lead.id)),
        ])],
      });

      // Emit WebSocket batch event for all saved leads at once
      if (context.userId && savedLeads.length > 0) {
        webSocketEmitter.emit(context.userId, 'leads_batch_saved', {
          leads: savedLeads,
          count: savedLeads.length,
          threadId,
          platform: workflow.platform,
          iteration,
          totalIterations,
        });
      }

      // Restore previous results (they will be accumulated in allResults)
      context.nodesExecuted.set(outputKey, previousResults);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      this.log(context, `⚠️ Error in immediate lead save: ${error.message}`);
    }
  }

  /**
   * Enrich results with profile data by calling the profile scraper actor
   * This is used for immediate enrichment during sub-actor iterations
   */
  private static async enrichWithProfileData(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    results: any[],
    profileNode: WorkflowNode,
    workflow: Workflow,
    context: ExecutionContext,
    iteration?: number,
    totalIterations?: number,
    configUsernameField?: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any[]> {
    const actorId = profileNode.data.actorId;
    if (!actorId) {
      this.log(context, `⚠️ Profile enrichment node has no actorId, skipping enrichment`);
      return results;
    }

    // Extract usernames from results based on profile node's input mapping or config
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputMapping = (profileNode.data as any).inputMapping || {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const fieldMapping = (profileNode.data as any).field_mapping || {};

    // Use the username field from config if provided, otherwise try to figure it out
    // eslint-disable-next-line no-constant-binary-expression
    const usernameField = configUsernameField ||
      fieldMapping.usernames ||
      inputMapping.usernames?.[0]?.replace('{_current_item.', '').replace('}', '') ||
      'user.username' ||
      'username';

    // Extract usernames from results
    const usernames: string[] = [];
    for (const item of results) {
      const username = this.getNested(item, usernameField);
      if (username && typeof username === 'string') {
        usernames.push(username.replace('@', ''));
      }
    }

    if (usernames.length === 0) {
      this.log(context, `⚠️ No usernames found in results for profile enrichment`);
      return results;
    }

    this.log(context, `🔄 Enriching ${usernames.length} leads with profile data (iteration ${iteration}/${totalIterations})`);

    // Emit WebSocket event for profile enrichment start
    if (context.userId) {
      webSocketEmitter.emitWorkflowStep(
        context.userId,
        workflow?.platform || 'Lead Generation',
        `profile_enrichment_${iteration}`,
        `🔄 Enriching ${usernames.length} profiles...`,
        undefined,
        {
          nodeType: 'profile-enrichment',
          iteration,
          totalIterations,
          usernameCount: usernames.length,
        }
      );
    }

    try {
      // Call the profile scraper actor with all usernames at once (batch call)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const actorInput: Record<string, any> = {};

      const uniqueUsernames = Array.from(new Set(usernames));

      const isFacebookPageScraper = actorId === 'apify/facebook-pages-scraper' || 
                                    actorId.includes('facebook-pages-scraper') || 
                                    actorId.includes('facebook-page-scraper');

      if (isFacebookPageScraper) {
        actorInput.startUrls = uniqueUsernames.map((url: string) => {
          let fullUrl = url;
          if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
            fullUrl = `https://www.facebook.com/${url}`;
          }
          return { url: fullUrl };
        });
      } else {
        actorInput.usernames = uniqueUsernames;
      }

      // Add any additional config from profile node
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const nodeConfig = (profileNode.data as any).config || {};
      if (nodeConfig.timeout) actorInput.timeout = nodeConfig.timeout;

      const profileResults = await this.executeActorWithFallback(
        context.userId,
        actorId,
        actorInput,
        async (client, run) => {
          this.log(context, `✅ Profile enrichment completed: ${run.id}`);

          if (run.status === 'ABORTED') {
            this.log(context, `⚠️ Profile enrichment was aborted`);
            return [];
          }

          const dataset = await client.dataset(run.defaultDatasetId).listItems();
          return dataset.items;
        },
        context,
        `${profileNode.id}:profile-enrichment:${iteration}`,
      );

      this.log(context, `✅ Got ${profileResults.length} enriched profiles`);

      // Emit WebSocket event for profile enrichment complete
      if (context.userId) {
        webSocketEmitter.emitWorkflowStep(
          context.userId,
          workflow?.platform || 'Lead Generation',
          `profile_enrichment_${iteration}_complete`,
          `✅ Enriched ${profileResults.length} profiles`,
          undefined,
          {
            nodeType: 'profile-enrichment-complete',
            iteration,
            totalIterations,
            profileCount: profileResults.length,
          }
        );
      }

      // Return enriched profiles (these will be used for saving)
      // If profile data was returned, use it; otherwise fall back to original results
      if (profileResults.length > 0) {
        return profileResults;
      }

      return results;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      this.log(context, `⚠️ Profile enrichment failed: ${error.message}`);
      // Return original results on error
      return results;
    }
  }

  /**
   * Convert camelCase to snake_case for database columns
   */
  private static toSnakeCase(str: string): string {
    return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
  }

  /**
   * Normalize lead field names from workflow mappings to match leadsTable keys
   * Accepts camelCase or snake_case, and fixes common misnamed fields.
   */
  private static normalizeLeadFieldName(fieldName: string): string {
    if (!fieldName) return fieldName;
    const lower = fieldName.toLowerCase();

    const directMap: Record<string, string> = {
      platform: 'platformType',
      platform_type: 'platformType',
      lead_type: 'leadType',
      full_name: 'fullName',
      first_name: 'firstName',
      last_name: 'lastName',
      middle_name: 'middleName',
      preferred_name: 'preferredName',
      profile_url: 'profileUrl',
      post_url: 'postUrl',
      profile_picture: 'profilePicture',
      twitter_url: 'twitterUrl',
      twitter_handle: 'twitterHandle',
      twitter_username: 'twitterUsername',
      twitter_followers: 'twitterFollowers',
      facebook_url: 'facebookUrl',
      instagram_url: 'instagramUrl',
      instagram_handle: 'instagramHandle',
      followers_count: 'followersCount',
      following_count: 'followingCount',
      connections_count: 'connectionsCount',
      posts_count: 'postsCount',
      view_count: 'viewCount',
      like_count: 'likeCount',
      retweet_count: 'retweetCount',
      reply_count: 'replyCount',
      quote_count: 'quoteCount',
      video_duration: 'videoDuration',
      company_name: 'companyName',
      company_phone: 'companyPhone',
      company_revenue: 'companyRevenue',
      company_domain: 'companyDomain',
      company_linkedin: 'companyLinkedin',
    };

    if (directMap[lower]) return directMap[lower];

    if (fieldName.includes('_')) {
      return fieldName.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    }

    return fieldName;
  }

  /**
   * Evaluate field expression for lead mapping
   * Uses alias system for better cross-platform compatibility
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static evaluateFieldExpression(expr: string, item: any): any {
    if (!expr) return undefined;

    // Handle literal strings: 'instagram' or "'instagram'"
    if ((expr.startsWith("'") && expr.endsWith("'")) || (expr.startsWith('"') && expr.endsWith('"'))) {
      return expr.slice(1, -1);
    }

    // Handle numeric literals (e.g., "0", "100", "3.5")
    if (/^-?\d+(\.\d+)?$/.test(expr)) {
      return expr.includes('.') ? parseFloat(expr) : parseInt(expr, 10);
    }

    // Handle concatenation: 'https://instagram.com/' + username
    if (expr.includes(' + ')) {
      const parts = expr.split(' + ').map(p => p.trim());
      return parts.map(p => {
        if ((p.startsWith("'") && p.endsWith("'")) || (p.startsWith('"') && p.endsWith('"'))) {
          return p.slice(1, -1);
        }
        // Use alias system for field resolution
        return this.getWithAliases(item, p) || '';
      }).join('');
    }

    // Handle simple field reference - use alias system
    return this.getWithAliases(item, expr);
  }

  /**
   * Extract field mappings from workflow JSON mappings array
   * Converts from workflow JSON format to simple key-value format
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static extractFieldMappings(workflow: any, sourceNodeId: string, targetNodeId: string): Record<string, string> {
    const mappings: Record<string, string> = {};

    // Look for mappings in workflow.mappings array
    if (workflow.mappings && Array.isArray(workflow.mappings)) {
      const relevantMapping = workflow.mappings.find(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (m: any) => m.sourceNodeId === sourceNodeId && m.targetNodeId === targetNodeId
      );

      if (relevantMapping && relevantMapping.fieldMappings) {
        for (const fieldMapping of relevantMapping.fieldMappings) {
          if (fieldMapping.targetFieldPath && fieldMapping.sourceFieldPath) {
            mappings[fieldMapping.targetFieldPath] = fieldMapping.sourceFieldPath;
          }
        }
      }
    }

    return mappings;
  }

  /** Resolve the data-producing edge for a save node. Ordering-only edges may
   * also enter the same save node, so the first JSON edge is not authoritative. */
  private static findSaveSourceNode(node: WorkflowNode, workflow: Workflow): WorkflowNode | undefined {
    const incomingEdges = workflow.edges.filter(edge => edge.target === node.id);
    const expectedOutputKey = (node.data as any).iterate_over || (node.data as any).source_array;
    const dataEdge = expectedOutputKey
      ? incomingEdges.find((edge) => {
          const candidate = workflow.nodes.find(item => item.id === edge.source);
          const outputKey = candidate?.data.output_key
            || (candidate?.data.actorId ? `${candidate.data.actorId}_output` : undefined);
          return outputKey === expectedOutputKey;
        })
      : undefined;
    const selectedEdge = dataEdge || incomingEdges[0];
    return selectedEdge ? workflow.nodes.find(item => item.id === selectedEdge.source) : undefined;
  }

  /**
   * Execute database save node
   */
  private static async executeDbSaveNode(
    node: WorkflowNode,
    workflow: Workflow,
    context: ExecutionContext,
    threadId?: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    // Check if THIS specific save node was already handled by immediate save during iterate_over
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const immediatelySavedNodeIds = (context as any).__immediatelySavedNodeIds as Set<string> | undefined;
    if (immediatelySavedNodeIds?.has(node.id)) {
      const savedCount = context.savedLeadIds?.size || 0;
      this.log(context, `⏭️  Skipping save node '${node.id}' - its data was already saved immediately during iterations (${savedCount} leads total)`);
      return {
        saved: true,
        count: savedCount,
        leadsCount: savedCount,
        table: 'leads',
        skipped: true,
        reason: 'Leads were saved immediately during iterations'
      };
    }

    // Support both embedded dbSave config and separate dbSave node
    const dbConfig = node.data.dbSave || {
      enabled: true,
      target_table: node.data.table,
      field_mapping: node.data.mapping,
    };

    if (!dbConfig?.enabled || !dbConfig.target_table) {
      this.log(context, `⏭️  Database save disabled for node ${node.id}`);
      return null;
    }

    try {
      this.log(context, `💾 Saving data to table: ${dbConfig.target_table}`);

      // Select the edge whose actor output matches iterate_over. Additional
      // incoming edges may express persistence ordering only.
      const incomingEdges = workflow.edges.filter(e => e.target === node.id);
      if (incomingEdges.length === 0) {
        this.log(context, `⚠️  No incoming edge found for dbSave node ${node.id}`);
        return { saved: false, reason: 'No incoming edge found' };
      }

      // Get the output from the source node
      const sourceNode = this.findSaveSourceNode(node, workflow);
      if (!sourceNode) {
        this.log(context, `⚠️  Source node not found for dbSave node ${node.id}`);
        return { saved: false, reason: 'Source node not found' };
      }

      const outputKey = sourceNode.data.output_key;
      const actorResults = outputKey ? context.nodesExecuted.get(outputKey) : null;

      if (!actorResults || !Array.isArray(actorResults) || actorResults.length === 0) {
        this.log(context, `⚠️  No data found from source node ${sourceNode.id}`);
        return { saved: false, reason: 'No data from source node' };
      }

      // Extract field mappings from workflow JSON if not provided in dbConfig
      let fieldMapping = dbConfig.field_mapping || {};
      if (Object.keys(fieldMapping).length === 0) {
        fieldMapping = this.extractFieldMappings(workflow, sourceNode.id, node.id);
        this.log(context, `📋 Extracted ${Object.keys(fieldMapping).length} field mappings from workflow JSON`);
      }

      // Map actor results based on target table
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const postUrlToIdMap: Record<string, number> = (context as any).postUrlToIdMap || {};
      const recordsToInsert = actorResults.map((result, index) => {
        try {
          let mapped;
          if (dbConfig.target_table === 'posts') {
            mapped = this.mapActorResultToPost(result, fieldMapping, context);
          } else {
            mapped = this.mapActorResultToLead(result, fieldMapping, context);
            // Resolve sourcePostId from previously saved posts in this workflow
            if (!mapped.sourcePostId && Object.keys(postUrlToIdMap).length > 0) {
              const postRef = result.postUrl || result.post_url || result.url || result.link_post || result.inputUrl;
              if (postRef && postUrlToIdMap[postRef]) {
                mapped.sourcePostId = postUrlToIdMap[postRef];
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } else if ((context as any).savedPostIds?.length === 1) {
                // If there's only one saved post, link all leads to it
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                mapped.sourcePostId = (context as any).savedPostIds[0];
              }
            }
          }
          // Include threadId in campaignData for thread filtering
          if (threadId) {
            mapped.campaignData = { ...(mapped.campaignData || {}), threadId: threadId };
          }
          // Add promptId if available for ICP relationship
          if (context?.promptId && !mapped.promptId) {
            mapped.promptId = context.promptId;
          }
          return mapped;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (error: any) {
          this.log(context, `❌ Error mapping result ${index}: ${error.message}`);
          this.log(context, `   Result data: ${JSON.stringify(result).substring(0, 200)}...`);
          this.log(context, `   Field mapping: ${JSON.stringify(fieldMapping).substring(0, 200)}...`);
          throw error;
        }
      });

      // Save to database
      if (dbConfig.target_table === 'leads') {
        const { savedLeads, recoveredLeads, duplicateLeads, rejectedCount } = await this.persistReviewedLeadRecords(
          recordsToInsert,
          context,
          threadId,
        );
        this.log(
          context,
          `✅ Persisted ${savedLeads.length} new and recovered ${recoveredLeads.length} existing lead IDs (${duplicateLeads.length} cross-provider duplicates merged, ${rejectedCount} rejected) with threadId: ${threadId || 'none'}`,
        );
        const persistedLeads = [...savedLeads, ...recoveredLeads];

        // Log lead save to database with sample lead data
        if (context.userId) {
          try {
            // Get sample saved leads (first 3, key fields only)
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sampleLeads = persistedLeads.slice(0, 3).map((lead: any) => ({
              id: lead.id,
              name: lead.name,
              email: '[REDACTED]',
              company: lead.company,
              role: lead.role,
              source: lead.source,
              platformType: lead.platformType,
              location: lead.location,
            }));

            await createWorkflowLog({
              userId: context.userId,
              executionId: context.executionId,
              threadId: threadId || null,
              logType: 'lead_saved',
              status: 'completed',
              platform: workflow.platform || null,
              message: `Persisted ${persistedLeads.length} exact lead IDs`,
              leadsCount: persistedLeads.length,
              details: {
                table: dbConfig.target_table,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                leadIds: persistedLeads.slice(0, 10).map((l: any) => l.id),
                totalSaved: persistedLeads.length,
                fieldMapping: Object.keys(fieldMapping),
                sampleLeads,
              },
            });

            // Update execution lead counts
            await updateExecutionLeadCounts(context.executionId, persistedLeads.length);
          } catch (logError) {
            logger.error({ err: logError }, '[WorkflowExecutor] Error logging lead save');
          }
        }

        // Emit a single batch WebSocket event for newly-created leads only.
        if (workflow.platform && savedLeads.length > 0) {
          const userId = savedLeads[0]?.userId;
          if (userId) {
            webSocketEmitter.emit(userId, 'leads_batch_saved', {
              leads: savedLeads,
              count: savedLeads.length,
              platform: workflow.platform,
              executionId: context.executionId,
              threadId: context.threadId,
            });
          }
        }

        // Accumulate db_save_results across multiple save nodes
        const prevLeadsSave = context.nodesExecuted.get('db_save_results') || { leadsCount: 0, postsCount: 0, saved: 0 };
        context.nodesExecuted.set('db_save_results', {
          saved: (prevLeadsSave.saved || 0) + persistedLeads.length,
          leadsCount: (prevLeadsSave.leadsCount || 0) + persistedLeads.length,
          postsCount: prevLeadsSave.postsCount || 0,
          leadIds: [...new Set([
            ...(prevLeadsSave.leadIds || []),
            ...persistedLeads.map((lead: Record<string, unknown>) => Number(lead.id)),
          ])],
        });
        return {
          saved: true,
          count: persistedLeads.length,
          leadsCount: persistedLeads.length,
          leadIds: persistedLeads.map((lead: Record<string, unknown>) => Number(lead.id)),
          duplicateCount: duplicateLeads.length,
          rejectedCount,
          table: dbConfig.target_table,
        };
      } else if (dbConfig.target_table === 'posts') {
        const { posts: savedPosts, newCount, duplicateCount } = await this.persistPostRecords(recordsToInsert);
        this.log(context, `✅ Persisted ${savedPosts.length} post identities (${newCount} new, ${duplicateCount} existing) with threadId: ${threadId || 'none'}`);

        // Log post save to database
        if (context.userId) {
          try {
            await createWorkflowLog({
              userId: context.userId,
              executionId: context.executionId,
              threadId: threadId || null,
              logType: 'post_saved',
              status: 'completed',
              platform: workflow.platform || null,
              message: `Saved ${savedPosts.length} posts to database`,
              details: {
                table: dbConfig.target_table,
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                postIds: savedPosts.slice(0, 10).map((p: any) => p.id),
                totalSaved: savedPosts.length,
                newCount,
                duplicateCount,
                fieldMapping: Object.keys(fieldMapping),
              },
            });
          } catch (logError) {
            logger.error({ err: logError }, '[WorkflowExecutor] Error logging post save');
          }
        }

        // Emit WebSocket events for saved posts
        for (const post of savedPosts) {
          if (workflow.platform && context.userId) {
            webSocketEmitter.emit(context.userId, 'post_saved', {
              post: post,
              platform: workflow.platform,
              executionId: context.executionId,
              threadId: context.threadId,
            });
          }
        }

        // Store saved post IDs in context for sourcePostId linking when leads are saved later
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existingSavedPostIds: number[] = (context as any).savedPostIds || [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (context as any).savedPostIds = [...existingSavedPostIds, ...savedPosts.map((p: any) => p.id)];

        // Also store a postUrl→postId lookup map for sourcePostId resolution
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const postUrlToIdMap: Record<string, number> = (context as any).postUrlToIdMap || {};
        for (const post of savedPosts) {
          if (post.postUrl) postUrlToIdMap[post.postUrl] = post.id;
          if (post.postId) postUrlToIdMap[post.postId] = post.id;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (context as any).postUrlToIdMap = postUrlToIdMap;

        // Accumulate db_save_results across multiple save nodes
        const prevPostsSave = context.nodesExecuted.get('db_save_results') || { leadsCount: 0, postsCount: 0, saved: 0 };
        context.nodesExecuted.set('db_save_results', {
          saved: (prevPostsSave.saved || 0) + savedPosts.length,
          leadsCount: prevPostsSave.leadsCount || 0,
          postsCount: (prevPostsSave.postsCount || 0) + savedPosts.length,
          leadIds: [...new Set(prevPostsSave.leadIds || [])],
        });
        return { saved: true, count: savedPosts.length, postsCount: savedPosts.length, table: dbConfig.target_table };
      } else {
        this.log(context, `⚠️  Unsupported table: ${dbConfig.target_table}`);
        return { saved: false, reason: `Unsupported table: ${dbConfig.target_table}` };
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      const errorMessage = `Database save failed: ${error.message}`;
      this.log(context, `❌ ${errorMessage}`);
      throw new Error(errorMessage);
    }
  }

  /**
   * Map actor result (Google Maps place) to lead record
   */
  private static mapActorResultToLead(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actorResult: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fieldMapping: Record<string, any>,
    context?: ExecutionContext
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Record<string, any> {
    // Helper to truncate to max length for database fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const truncate = (value: any, maxLength: number): any => {
      if (value == null) return null;
      if (typeof value !== 'string') return value;
      return value.length > maxLength ? value.substring(0, maxLength) : value;
    };

    // Extract full name with safe fallback - using aliases for better compatibility
    // For business leads (JustDial, Google Maps, etc.), use company/business name instead of 'Unknown'
    const mappedLeadType = typeof fieldMapping?.leadType === 'string'
      ? this.resolveSourceValue(fieldMapping.leadType, actorResult)
      : undefined;
    const isPersonProfile = mappedLeadType === 'profile'
      || String(context?.platform || '').startsWith('linkedin_profile');
    const companyOrBusinessName = actorResult.title || actorResult.name || actorResult.pageName || actorResult.companyName;
    const defaultCompanyName = isPersonProfile
      ? (actorResult.company || actorResult.companyName || null)
      : companyOrBusinessName;
    const fullName = this.getWithAliases(actorResult, 'fullName') || 
                     this.getWithAliases(actorResult, 'name') || 
                     actorResult.title || companyOrBusinessName || null;
    const nameParts = (fullName || '').split(' ');
    const firstName = nameParts[0] || null;
    const lastName = nameParts.length > 1 ? nameParts.slice(1).join(' ') : '';

    // If no email is available, store null instead of a placeholder
    // Placeholder emails like no-email-xxx@placeholder.lead are not useful

    // Extract location from various possible sources
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const extractLocation = (result: any): { address?: string; city?: string; state?: string; country?: string } => {
      const location: { address?: string; city?: string; state?: string; country?: string } = {};

      // Try to get from 'about' object (Instagram profile scraper)
      if (result.about?.country) {
        location.country = result.about.country;
      }
      // Try direct location field
      const locationValue = this.getWithAliases(result, 'location');
      if (locationValue) {
        if (typeof locationValue === 'string') {
          location.address = locationValue;
          // Try to parse city from location string
          const parts = locationValue.split(',').map((p: string) => p.trim());
          if (parts.length >= 1) location.city = parts[0];
          if (parts.length >= 2) location.state = parts[parts.length - 2] || parts[1];
          if (parts.length >= 3) location.country = parts[parts.length - 1];
        } else if (typeof locationValue === 'object') {
          location.address = locationValue.address;
          location.city = locationValue.city;
          location.state = locationValue.state;
          location.country = locationValue.country;
        }
      }
      // Try direct address
      if (result.address) {
        location.address = result.address;
        if (!location.city) location.city = this.extractCity(result.address);
      }
      // Try Facebook-specific fields
      if (result.CURRENT_CITY && !location.city) {
        location.city = result.CURRENT_CITY;
      }
      if (result.current_city && !location.city) {
        location.city = result.current_city;
      }
      // Try country directly
      if (result.country) {
        location.country = result.country;
      }
      // Try city directly  
      if (result.city) {
        location.city = result.city;
      }
      // Try state directly
      if (result.state) {
        location.state = result.state;
      }

      return location;
    };
    
    // Get common fields using aliases for cross-platform compatibility
    const username = this.getWithAliases(actorResult, 'username');
    const bio = this.getWithAliases(actorResult, 'bio');
    const profilePic = this.getWithAliases(actorResult, 'profilePicture');
    const website = this.getWithAliases(actorResult, 'website');
    const followers = this.getWithAliases(actorResult, 'followersCount');
    const following = this.getWithAliases(actorResult, 'followingCount');
    const verified = this.getWithAliases(actorResult, 'verified');
    const profileUrl = this.getWithAliases(actorResult, 'profileUrl');

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lead: Record<string, any> = {
      source: actorResult.source || context?.platform || actorResult.platform || 'workflow',
      platformType: actorResult.platformType || context?.platform || actorResult.platform || undefined,
      leadType: actorResult.leadType || actorResult.type || undefined,
      actorId: actorResult.actorId || undefined,
      status: 'new',
      email: actorResult.email || null,
      emailStatus: actorResult.email ? 'unverified' : 'unavailable',
      name: fullName || companyOrBusinessName || null,
      fullName: fullName || companyOrBusinessName || null,
      firstName: truncate(firstName, 255),
      lastName: truncate(lastName, 255) || null,
      company: defaultCompanyName,
      companyName: defaultCompanyName,
      companyPhone: actorResult.phone || null,
      website: website,
      phone: actorResult.phone || null,
      location: extractLocation(actorResult),
      headline: bio ? bio.substring(0, 200) : (fullName ? `Profile: ${fullName}` : null),
      bio: bio || '',
      createdAt: new Date(),
      updatedAt: new Date(),
      rawData: actorResult, // Store complete raw response for future re-mapping
      // Store platform-specific identifiers using aliases
      placeId: actorResult.place_id || actorResult.placeId || null,
      instagramHandle: username || actorResult.instagramHandle || null,
      twitterHandle: username || actorResult.twitterHandle || actorResult.screen_name || null,
      twitterUsername: username || actorResult.userName || actorResult.screen_name || null,
      linkedinUrl: actorResult.linkedinUrl || actorResult.linkedin || null,
      facebookUrl: actorResult.facebookUrl || actorResult.pageUrl || actorResult.url || null,
      profileUrl: profileUrl || null,
      profilePicture: profilePic || null,
      followersCount: followers || null,
      followingCount: following || null,
      verified: verified || false,
    };

    // Apply field mappings if provided (fieldMapping format: targetField -> sourcePath)
    if (fieldMapping && Object.keys(fieldMapping).length > 0) {
      for (const [targetField, sourcePath] of Object.entries(fieldMapping)) {
        if (!targetField || !sourcePath) continue;
        // Skip rawData field in mapping
        if (targetField === 'rawData' || targetField === 'raw_data') continue;

        const normalizedTarget = this.normalizeLeadFieldName(targetField);
        const value = this.resolveSourceValue(sourcePath as string, actorResult);
        if (value !== undefined) {
          // Convert timestamps
          const convertedValue = this.convertTimestamps(value);

          // Define max lengths for varchar fields based on schema
          const fieldMaxLengths: Record<string, number> = {
            // varchar(255) fields
            firstName: 255, lastName: 255, middleName: 255, preferredName: 255,
            source: 255, actorId: 255, profileId: 255, publicId: 255,
            timezone: 255, twitterHandle: 255, instagramHandle: 255,
            department: 255, function: 255, companyRevenue: 255,
            totalFunding: 255, valuation: 255, budgetRange: 255,
            placeId: 255, assignedTeam: 255, aiSource: 255,
            // varchar(100) fields
            seniority: 100, companySize: 100, fundingStage: 100,
            // varchar(50) fields
            gender: 50, language: 100, leadType: 100, platformType: 100, tier: 50
          };

          const maxLength = fieldMaxLengths[normalizedTarget];
          if (maxLength && typeof convertedValue === 'string') {
            lead[normalizedTarget] = truncate(convertedValue, maxLength);
          } else {
            lead[normalizedTarget] = convertedValue;
          }
        }
      }
    }

    // Try to extract additional fields from flattened object
    const flattened = this.flattenObject(actorResult);
    for (const [flatKey, value] of Object.entries(flattened)) {
      // Skip if already mapped or if it's a reserved field
      if (lead[flatKey] !== undefined || flatKey === 'rawData') continue;

      // Only add if the field exists in the leads schema
      // This is a simple check - you might want to be more selective
      const convertedValue = this.convertTimestamps(value);

      // Auto-map common fields that might not be in explicit mapping
      if (flatKey === 'linkedin' || flatKey === 'linkedinUrl') {
        lead.linkedin = convertedValue;
      } else if (flatKey === 'twitter' || flatKey === 'twitterUrl') {
        lead.twitter = convertedValue;
      } else if (flatKey === 'company_website') {
        lead.website = lead.website || convertedValue;
      }
      // Add more auto-mapping logic as needed
    }

    // NOTE: Don't set executionId here as it references agent_executions.id which may not exist
    // The workflow executionId is a local UUID, not an agent execution ID
    // Use importBatchId for tracking workflow executions instead
    if (context?.executionId) {
      // Store the workflow execution ID in importBatchId for tracking
      lead.importBatchId = context.executionId;
    }

    // Set userId and promptId from context
    if (context?.userId) {
      lead.userId = context.userId;
    }
    if (context?.promptId) {
      lead.promptId = context.promptId;
    }

    // Inject business category from execution context
    if (context?.businessCategoryId) {
      lead.businessCategoryId = context.businessCategoryId;
      lead.businessCategoryName = context.businessCategoryName || null;
    }
    if (context?.businessSubcategoryId) {
      lead.businessSubcategoryId = context.businessSubcategoryId;
      lead.businessSubcategoryName = context.businessSubcategoryName || null;
    }

    // Harvest LinkedIn profiles may omit currentPosition while retaining an
    // explicitly current experience entry. Never treat an ended role as current.
    if (String(lead.platformType || lead.source).startsWith('linkedin') && lead.leadType === 'profile') {
      const positions = Array.isArray(actorResult.currentPosition) && actorResult.currentPosition.length
        ? actorResult.currentPosition
        : (Array.isArray(actorResult.currentPositions) ? actorResult.currentPositions : []);
      const experience = Array.isArray(actorResult.experience) ? actorResult.experience : [];
      const current = positions[0] || experience.find((entry: any) =>
        entry?.isCurrent === true || /^present$/i.test(String(entry?.endDate?.text || '').trim()));
      if (current?.companyName) {
        lead.company = lead.company || current.companyName;
        lead.companyName = lead.companyName || current.companyName;
      }
      if (current?.position || current?.title) lead.role = current.position || current.title;
      const shortPosition = typeof actorResult.position === 'string'
        && !/^(?:-+|n\/?a|null|unknown)$/i.test(actorResult.position.trim())
        ? actorResult.position.trim()
        : null;
      if (!current && shortPosition) {
        lead.role = shortPosition;
        lead.jobTitle = shortPosition;
        lead.title = shortPosition;
        lead.headline = shortPosition;
      } else if (!shortPosition && typeof actorResult.position === 'string') {
        for (const field of ['role', 'jobTitle', 'title', 'headline']) {
          if (lead[field] === actorResult.position) lead[field] = null;
        }
      }
      if (!lead.bio && typeof actorResult.summary === 'string') lead.bio = actorResult.summary;
      const parsed = actorResult.location?.parsed;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        lead.location = {
          city: parsed.city || undefined,
          state: parsed.state || undefined,
          country: parsed.country || parsed.countryFull || undefined,
          address: actorResult.location.linkedinText || parsed.text || undefined,
        };
      } else if (typeof actorResult.location?.linkedinText === 'string') {
        // Short employee profiles expose only an unparsed display location.
        lead.location = { address: actorResult.location.linkedinText };
      }
      if (typeof actorResult.pictureUrl === 'string' && actorResult.pictureUrl.trim()) lead.profilePicture = actorResult.pictureUrl;
      if (actorResult.photo && typeof actorResult.photo === 'object') {
        lead.profilePicture = typeof actorResult.photo.url === 'string' && actorResult.photo.url.trim()
          ? actorResult.photo.url : null;
      }
    }

    // A nullable upper employee bound means an open-ended range, not a dangling
    // hyphen. Preserve valid closed ranges and omit unavailable bounds.
    if (String(lead.platformType || lead.source).startsWith('linkedin') && lead.leadType === 'company'
      && typeof fieldMapping.companySize === 'string' && fieldMapping.companySize.includes('employeeCountRange')) {
      const range = actorResult.employeeCountRange;
      const start = typeof range?.start === 'number' && Number.isSafeInteger(range.start) && range.start >= 0 ? range.start : undefined;
      const end = typeof range?.end === 'number' && Number.isSafeInteger(range.end) && range.end >= 0 ? range.end : undefined;
      lead.companySize = start !== undefined
        ? (end !== undefined ? (end >= start ? `${start}-${end}` : null) : `${start}+`)
        : (end !== undefined ? `Up to ${end}` : null);
    }

    // Coerce field types to match database column types (prevents batch insert failures)
    this.coerceLeadFieldTypes(lead);
    normalizeLeadContacts(lead, actorResult);

    // The Facebook Likes actor uses `facebookUrl` for the source post, and its
    // legacy `facebookId` has also been observed to equal a post ID. Only the
    // actor's explicit, public `profileUrl` is a stable liker identity. Apply
    // this after generic social normalization so aliases cannot turn source-
    // post fields back into a person profile.
    if (context?.platform === 'facebook_post_likers') {
      const rawProfileUrl = typeof actorResult.profileUrl === 'string'
        ? actorResult.profileUrl.trim()
        : '';
      let publicProfileUrl: string | null = null;
      if (rawProfileUrl) {
        try {
          const parsed = new URL(rawProfileUrl);
          const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
          if ((parsed.protocol === 'https:' || parsed.protocol === 'http:')
            && (hostname === 'facebook.com' || hostname.endsWith('.facebook.com'))) {
            publicProfileUrl = rawProfileUrl;
          }
        } catch {
          publicProfileUrl = null;
        }
      }
      lead.profileId = null;
      lead.profileUrl = publicProfileUrl;
      lead.facebookUrl = publicProfileUrl;
    }

    // Enrich location jsonb from individually mapped address field
    if (lead.location && typeof lead.location === 'object' && lead.address && !lead.location.address) {
      lead.location.address = String(lead.address);
    }

    return lead;
  }

  /**
   * Coerce lead field values to match their database column types.
   * Prevents PostgreSQL type-cast errors that would abort entire batch inserts.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static coerceLeadFieldTypes(lead: Record<string, any>): void {
    const integerFields = [
      'score', 'leadScore', 'icpScore', 'reviewCount', 'followersCount', 'followingCount',
      'connectionsCount', 'postsCount', 'viewCount', 'likeCount',
      'retweetCount', 'replyCount', 'quoteCount', 'intentScore',
      'fitScore', 'yearsOfExperience', 'companyFoundedYear',
      'twitterFollowers', 'linkedinFollowerCount', 'relevanceScore', 'qualityScore',
      'websiteVisits', 'adClicks', 'searchRank',
    ];
    for (const field of integerFields) {
      if (lead[field] != null && typeof lead[field] !== 'number') {
        const parsed = parseInt(String(lead[field]), 10);
        lead[field] = isNaN(parsed) ? null : parsed;
      }
    }

    const decimalFields = ['rating', 'engagementRate', 'aiConfidenceScore'];
    for (const field of decimalFields) {
      if (lead[field] != null && typeof lead[field] !== 'number') {
        const parsed = parseFloat(String(lead[field]));
        lead[field] = isNaN(parsed) ? null : parsed;
      }
    }

    const jsonbArrayFields = ['categories', 'tags', 'skills', 'hashtags'];
    for (const field of jsonbArrayFields) {
      if (lead[field] != null && typeof lead[field] === 'string') {
        if (field === 'categories' && /^(?:none|null|n\/?a|unknown)$/i.test(lead[field].trim())) {
          lead[field] = null;
          continue;
        }
        try {
          const parsed = JSON.parse(lead[field]);
          lead[field] = Array.isArray(parsed) ? parsed : [lead[field]];
        } catch {
          lead[field] = (lead[field] as string).split(',').map((s: string) => s.trim()).filter(Boolean);
        }
      }
    }

    const booleanFields = ['verified', 'permanentlyClosed', 'temporarilyClosed'];
    for (const field of booleanFields) {
      if (lead[field] != null && typeof lead[field] !== 'boolean') {
        const s = String(lead[field]).toLowerCase();
        lead[field] = s === 'true' || s === '1' || s === 'yes';
      }
    }

    // Sanitize text fields that may contain objects (e.g. phone/whatsapp as {})
    const textFields = [
      'phone', 'companyPhone', 'secondaryPhone', 'whatsapp',
      'email', 'fullName', 'firstName', 'lastName', 'company', 'companyName',
      'headline', 'bio', 'website', 'address',
    ];
    for (const field of textFields) {
      if (lead[field] != null) {
        if (Array.isArray(lead[field])) {
          // If it's an array (e.g. from scrapers returning emails/phones as lists), extract first non-empty string
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const firstVal = lead[field].find((x: any) => x && typeof x === 'string' && x.trim() !== '');
          lead[field] = firstVal ? String(firstVal).trim() : null;
        } else if (typeof lead[field] === 'object') {
          // Objects like {} or {key: val} should be null
          lead[field] = null;
        } else if (typeof lead[field] === 'string') {
          const trimmed = lead[field].trim();
          // Empty strings, '{}', or placeholder emails should be null
          if (trimmed === '' || trimmed === '{}' || trimmed === '[]' || trimmed.includes('@placeholder.lead')) {
            lead[field] = null;
          } else {
            lead[field] = trimmed;
          }
        } else {
          lead[field] = String(lead[field]).trim();
        }
      }
    }
  }

  /**
   * Coerce post field values to match their database column types.
   * Prevents PostgreSQL type-cast errors that would abort entire batch inserts.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static coercePostFieldTypes(post: Record<string, any>): void {
    // Drizzle's timestamp columns require Date instances.  Several social
    // providers (including Twitter) return RFC-2822 strings such as
    // "Mon Aug 24 10:41:35 +0000 2026", which the generic timestamp helper
    // intentionally leaves untouched.  Normalize every timestamp field at
    // the persistence boundary so one provider-specific format cannot abort
    // an otherwise valid batch insert.
    const timestampFields = ['createdAt', 'timestamp', 'scrapedAt', 'createdAtDb', 'updatedAt'];
    for (const field of timestampFields) {
      const value = post[field];
      if (value == null) continue;
      if (value instanceof Date) {
        if (!Number.isFinite(value.getTime())) post[field] = null;
        continue;
      }

      let parsed: Date | null = null;
      if (typeof value === 'number') {
        const converted = this.convertTimestamps(value);
        parsed = converted instanceof Date ? converted : null;
      } else if (typeof value === 'string') {
        const date = new Date(value);
        if (Number.isFinite(date.getTime())) parsed = date;
      } else if (typeof value === 'object') {
        // A few providers wrap dates in `{ date: ... }` or `{ timestamp: ... }`.
        const nested = (value as Record<string, unknown>).date
          ?? (value as Record<string, unknown>).timestamp
          ?? (value as Record<string, unknown>).value;
        if (typeof nested === 'string' || typeof nested === 'number') {
          const converted = this.convertTimestamps(nested);
          if (converted instanceof Date) parsed = converted;
          else if (typeof nested === 'string') {
            const date = new Date(nested);
            if (Number.isFinite(date.getTime())) parsed = date;
          }
        }
      }
      post[field] = parsed;
    }

    const integerFields = [
      'likesCount', 'commentsCount', 'sharesCount', 'retweetCount', 'replyCount',
      'quoteCount', 'bookmarkCount', 'viewCount', 'reactionCount',
      'videoViewCount', 'videoPlayCount', 'carouselMediaCount', 'leadExtractionAttempts',
    ];
    for (const field of integerFields) {
      if (post[field] != null && typeof post[field] !== 'number') {
        const parsed = parseInt(String(post[field]), 10);
        post[field] = isNaN(parsed) ? null : parsed;
      }
    }

    const booleanFields = ['isReply', 'isRetweet', 'isQuote', 'processedForLeads'];
    for (const field of booleanFields) {
      if (post[field] != null && typeof post[field] !== 'boolean') {
        const s = String(post[field]).toLowerCase();
        post[field] = s === 'true' || s === '1' || s === 'yes';
      }
    }

    // Ensure JSON array fields are stored as strings
    const jsonArrayFields = ['hashtags', 'mentions', 'mediaUrls', 'mediaTypes', 'topReactions'];
    for (const field of jsonArrayFields) {
      if (post[field] != null && typeof post[field] !== 'string') {
        post[field] = JSON.stringify(post[field]);
      }
    }
  }

  /**
   * Resolve a source path or expression from actor result
   * Now uses field aliases for better cross-platform compatibility
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static resolveSourceValue(path: string, actorResult: any): any {
    if (path == null) return undefined;
    const s = String(path).trim();
    // literal expression
    if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
      return s.substring(1, s.length - 1);
    }
    // numeric literal (e.g., "0", "100", "3.5")
    if (/^-?\d+(\.\d+)?$/.test(s)) {
      return s.includes('.') ? parseFloat(s) : parseInt(s, 10);
    }
    // concatenation expression like 'https://twitter.com/' + author.username
    if (s.includes('+')) {
      const parts = s.split('+').map(p => p.trim());
      let out = '';
      for (const part of parts) {
        if ((part.startsWith("'") && part.endsWith("'")) || (part.startsWith('"') && part.endsWith('"'))) {
          out += part.substring(1, part.length - 1);
        } else {
          // Use getWithAliases for better field resolution
          const val = this.getWithAliases(actorResult, part);
          out += (val !== undefined && val !== null) ? String(val) : '';
        }
      }
      return out;
    }
    // fallback to nested path resolution with aliases
    return this.getWithAliases(actorResult, s);
  }

  /**
   * Common field aliases for cross-platform compatibility
   * Maps common variations to standard names
   */
  private static FIELD_ALIASES: Record<string, string[]> = {
    // Name fields
    'fullName': ['full_name', 'fullname', 'name', 'displayName', 'display_name', 'pageName', 'title', 'profileName', 'authorName', 'author.name'],
    'full_name': ['fullName', 'fullname', 'name', 'displayName', 'display_name', 'pageName', 'title', 'profileName', 'authorName', 'author.name'],
    'name': ['fullName', 'full_name', 'fullname', 'displayName', 'display_name', 'pageName', 'title', 'profileName', 'authorName', 'author.name'],
    'username': ['userName', 'user_name', 'screen_name', 'screenName', 'handle'],
    'userName': ['username', 'user_name', 'screen_name', 'screenName', 'handle'],
    
    // Profile fields
    'profilePicture': ['profile_pic_url', 'profilePicUrl', 'profile_picture', 'avatar', 'avatarUrl', 'profilePhoto', 'profilePictureUrl', 'image', 'photo'],
    'profile_pic_url': ['profilePicture', 'profilePicUrl', 'profile_picture', 'avatar', 'avatarUrl', 'profilePhoto', 'profilePictureUrl', 'image', 'photo'],
    'profileUrl': ['profile_url', 'url', 'pageUrl', 'profileLink', 'link', 'facebookUrl', 'profileUrl', 'authorProfileUrl', 'author.url'],
    'bio': ['biography', 'description', 'about', 'intro', 'summary'],
    'biography': ['bio', 'description', 'about', 'intro', 'summary'],
    'description': ['bio', 'biography', 'about', 'intro', 'summary'],
    
    // Social metrics
    'followersCount': ['followers_count', 'followers', 'followerCount', 'numFollowers'],
    'followers': ['followersCount', 'followers_count', 'followerCount', 'numFollowers'],
    'followingCount': ['following_count', 'following', 'followsCount', 'follows_count', 'numFollowing'],
    'following': ['followingCount', 'following_count', 'followsCount', 'follows_count'],
    'followsCount': ['followingCount', 'following_count', 'following', 'numFollowing'],
    
    // Verification
    'verified': ['isVerified', 'is_verified', 'isBlueVerified', 'blue_verified'],
    'isVerified': ['verified', 'is_verified', 'isBlueVerified', 'blue_verified'],
    'is_verified': ['verified', 'isVerified', 'isBlueVerified', 'blue_verified'],
    
    // Privacy
    'isPrivate': ['is_private', 'private', 'protected'],
    'is_private': ['isPrivate', 'private', 'protected'],
    
    // IDs
    'userId': ['user_id', 'id', 'profileId', 'profile_id', 'facebookId', 'pageId', 'authorId', 'author.id'],
    'user_id': ['userId', 'id', 'profileId', 'profile_id', 'facebookId', 'pageId', 'authorId', 'author.id'],
    'profileId': ['profile_id', 'id', 'userId', 'user_id', 'facebookId', 'pageId', 'authorId', 'author.id'],
    'pageId': ['facebookId', 'profileId', 'profile_id', 'id'],
    'facebookId': ['pageId', 'profileId', 'profile_id', 'id'],
    'title': ['pageName', 'name', 'fullName', 'full_name'],
    'pageName': ['title', 'name', 'fullName', 'full_name'],
    'profilePictureUrl': ['profilePhoto', 'profilePicture', 'profile_pic_url', 'image', 'photo'],
    
    // Timestamps
    'createdAt': ['created_at', 'timestamp', 'scrapedAt', 'scraped_at'],
    'created_at': ['createdAt', 'timestamp', 'scrapedAt', 'scraped_at'],
    
    // Contact
    'email': ['email_address', 'emailAddress', 'emails'],
    'phone': ['phoneNumber', 'phone_number', 'phones', 'contactNumber', 'contact_number'],
    // Generic url/link fields are provider profile URLs, not business websites.
    'website': ['externalUrl', 'external_url', 'websites', 'websiteUrl', 'website_url'],
    'externalUrl': ['website', 'external_url', 'websiteUrl', 'website_url'],
    
    // Location
    'location': ['city', 'country', 'address', 'current_city', 'CURRENT_CITY', 'formatted_address'],
    
    // Metrics
    'rating': ['totalScore', 'ratingOverall', 'stars', 'rating'],
    'reviewCount': ['reviewsCount', 'ratingCount', 'reviewCount'],

    // Platform-specific mappings
    'twitterUrl': ['url', 'profileUrl', 'profile_url'],
    'instagramUrl': ['url', 'profileUrl', 'profile_url'],
    'facebookUrl': ['url', 'pageUrl', 'page_url', 'profileUrl', 'facebookUrl'],
    // LinkedIn post search currently emits publicIdentifier while older
    // payloads and workflow mappings use universalName.
    'author.universalName': ['author.publicIdentifier'],
    'author.publicIdentifier': ['author.universalName'],
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static getNested(obj: any, path: string): any {
    if (!path || typeof path !== 'string') return undefined;

    // First, try to find the exact key with dots (e.g., "user.username" as a literal key)
    // This handles flattened objects where nested keys become "user.username" instead of user: { username }
    if (obj != null && Object.prototype.hasOwnProperty.call(obj, path)) {
      return obj[path];
    }

    // Also try case-insensitive match for literal dotted keys
    if (obj != null) {
      const literalKey = Object.keys(obj).find(k => k && k.toLowerCase() === path.toLowerCase());
      if (literalKey) {
        return obj[literalKey];
      }
    }

    // Standard nested object traversal
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length; i++) {
      let p = parts[i];
      if (!p || cur == null) return undefined;
      
      let arrayIndex: number | null = null;
      // eslint-disable-next-line no-useless-escape
      const bracketMatch = p.match(/^([^\[]+)\[(\d+)\]$/);
      if (bracketMatch) {
        p = bracketMatch[1];
        arrayIndex = parseInt(bracketMatch[2], 10);
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let resolvedValue: any = undefined;
      let found = false;

      // Try exact match first
      if (Object.prototype.hasOwnProperty.call(cur, p)) {
        resolvedValue = cur[p];
        found = true;
      } else {
        // Try case-insensitive match
        const curKeys = Object.keys(cur);
        const altKey = curKeys.find(k => k && p && k.toLowerCase() === p.toLowerCase());
        if (altKey) {
          resolvedValue = cur[altKey];
          found = true;
        } else {
          // Try field aliases if no match found
          const aliases = this.FIELD_ALIASES[p] || [];
          for (const alias of aliases) {
            const aliasKey = curKeys.find(k => k && k.toLowerCase() === alias.toLowerCase());
            if (aliasKey) {
              resolvedValue = cur[aliasKey];
              found = true;
              break;
            }
          }
        }
      }

      if (found) {
        if (arrayIndex !== null) {
          if (Array.isArray(resolvedValue)) {
            cur = resolvedValue[arrayIndex];
          } else {
            cur = undefined;
          }
        } else {
          cur = resolvedValue;
        }
      } else {
        // Try to find a literal key that matches the remaining path
        const curKeys = Object.keys(cur);
        const remainingPath = parts.slice(i).join('.');
        if (Object.prototype.hasOwnProperty.call(cur, remainingPath)) {
          return cur[remainingPath];
        }
        const remainingAltKey = curKeys.find(k => k && k.toLowerCase() === remainingPath.toLowerCase());
        if (remainingAltKey) {
          return cur[remainingAltKey];
        }
        return undefined;
      }
    }
    return cur;
  }
  
  /**
   * Try to find a field value using the primary path or any of its aliases
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static getWithAliases(obj: any, primaryPath: string): any {
    // Try primary path first
    const primaryValue = this.getNested(obj, primaryPath);
    if (primaryValue !== undefined && primaryValue !== null) {
      return primaryValue;
    }
    
    // Try aliases
    const aliases = this.FIELD_ALIASES[primaryPath] || [];
    for (const alias of aliases) {
      const aliasValue = this.getNested(obj, alias);
      if (aliasValue !== undefined && aliasValue !== null) {
        return aliasValue;
      }
    }
    
    return undefined;
  }

  private static mapActorResultToPost(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actorResult: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fieldMapping: Record<string, any>,
    context?: ExecutionContext,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const post: Record<string, any> = {
      source: 'unknown',
      actorId: null,
      platform: null,
      postId: null,
      postUrl: null,
      authorId: null,
      authorUsername: null,
      authorName: null,
      authorProfileUrl: null,
      text: null,
      createdAt: new Date(),
      rawData: actorResult, // Store complete raw response for future re-mapping
    };

    // Pre-populate base fields from common actor result patterns using aliases
    const platform = actorResult.platform || actorResult.source;
    if (platform) post.platform = platform;
    if (actorResult.actorId) post.actorId = actorResult.actorId;

    if (fieldMapping && Object.keys(fieldMapping).length > 0) {
      for (const [targetField, sourcePath] of Object.entries(fieldMapping)) {
        // Skip rawData field in mapping
        if (targetField === 'rawData' || targetField === 'raw_data') continue;

        const value = this.resolveSourceValue(sourcePath as string, actorResult);
        if (value !== undefined) {
          // Convert timestamps
          const convertedValue = this.convertTimestamps(value);
          post[targetField] = convertedValue;
        }
      }
    }

    // Comprehensive auto-mapping from flattened actor result for fields not already set
    const flattened = this.flattenObject(actorResult);
    for (const [flatKey, value] of Object.entries(flattened)) {
      if (flatKey === 'rawData') continue;
      const convertedValue = this.convertTimestamps(value);
      const lk = flatKey.toLowerCase();

      // Post identification
      if (!post.postId && (lk === 'post_id' || lk === 'postid' || lk === 'tweet_id' || lk === 'tweetid' || (lk === 'id' && !post.postId))) {
        post.postId = String(convertedValue);
      }
      if (!post.postUrl && (lk === 'post_url' || lk === 'posturl' || lk === 'url' || lk === 'link')) {
        post.postUrl = String(convertedValue);
      }

      // Author fields
      if (!post.authorId && (lk === 'author_id' || lk === 'authorid' || lk === 'user_id' || lk === 'userid' || lk === 'ownerid' || lk === 'owner_id')) {
        post.authorId = String(convertedValue);
      }
      if (!post.authorUsername && (lk === 'author_username' || lk === 'authorusername' || lk === 'screen_name' || lk === 'screenname' || lk === 'username' || lk === 'ownerusername' || lk === 'owner_username')) {
        post.authorUsername = String(convertedValue);
      }
      if (!post.authorName && (lk === 'author_name' || lk === 'authorname' || lk === 'user_name' || lk === 'ownerfullname' || lk === 'owner_full_name')) {
        post.authorName = String(convertedValue);
      }

      // Content fields
      if (!post.text && (lk === 'text' || lk === 'message' || lk === 'content' || lk === 'caption' || lk === 'body')) {
        post.text = String(convertedValue);
      }
      if (!post.caption && (lk === 'caption')) {
        post.caption = String(convertedValue);
      }
      if (!post.postType && (lk === 'type' || lk === 'post_type' || lk === 'posttype' || lk === 'media_type')) {
        post.postType = String(convertedValue);
      }

      // Engagement metrics
      if (post.likesCount == null && (lk === 'likescount' || lk === 'likes_count' || lk === 'favorites' || lk === 'like_count')) {
        post.likesCount = parseInt(String(convertedValue), 10) || 0;
      }
      if (post.commentsCount == null && (lk === 'commentscount' || lk === 'comments_count' || lk === 'comment_count')) {
        post.commentsCount = parseInt(String(convertedValue), 10) || 0;
      }
      if (post.sharesCount == null && (lk === 'sharescount' || lk === 'shares_count' || lk === 'reshare_count' || lk === 'resharecount')) {
        post.sharesCount = parseInt(String(convertedValue), 10) || 0;
      }
      if (post.retweetCount == null && (lk === 'retweetcount' || lk === 'retweet_count' || lk === 'retweets')) {
        post.retweetCount = parseInt(String(convertedValue), 10) || 0;
      }
      if (post.replyCount == null && (lk === 'replycount' || lk === 'reply_count' || lk === 'replies')) {
        post.replyCount = parseInt(String(convertedValue), 10) || 0;
      }
      if (post.quoteCount == null && (lk === 'quotecount' || lk === 'quote_count' || lk === 'quotes')) {
        post.quoteCount = parseInt(String(convertedValue), 10) || 0;
      }
      if (post.viewCount == null && (lk === 'viewcount' || lk === 'view_count' || lk === 'views')) {
        post.viewCount = parseInt(String(convertedValue), 10) || 0;
      }
      if (post.bookmarkCount == null && (lk === 'bookmarkcount' || lk === 'bookmark_count' || lk === 'bookmarks')) {
        post.bookmarkCount = parseInt(String(convertedValue), 10) || 0;
      }
      if (post.reactionCount == null && (lk === 'reactioncount' || lk === 'reaction_count' || lk === 'reactions_count' || lk === 'reactionscount')) {
        post.reactionCount = parseInt(String(convertedValue), 10) || 0;
      }

      // Video metrics
      if (post.videoViewCount == null && (lk === 'videoviewcount' || lk === 'video_view_count')) {
        post.videoViewCount = parseInt(String(convertedValue), 10) || 0;
      }
      if (post.videoPlayCount == null && (lk === 'videoplaycount' || lk === 'video_play_count')) {
        post.videoPlayCount = parseInt(String(convertedValue), 10) || 0;
      }

      // Array fields (hashtags, mentions, media)
      if (!post.hashtags && (lk === 'hashtags')) {
        post.hashtags = typeof convertedValue === 'string' ? convertedValue : JSON.stringify(convertedValue);
      }
      if (!post.mentions && (lk === 'mentions')) {
        post.mentions = typeof convertedValue === 'string' ? convertedValue : JSON.stringify(convertedValue);
      }
      if (!post.mediaUrls && (lk === 'mediaurls' || lk === 'media_urls' || lk === 'displayurl' || lk === 'display_url' || lk === 'image')) {
        const v = convertedValue;
        post.mediaUrls = typeof v === 'string' ? v : JSON.stringify(v);
      }

      // Twitter-specific booleans
      if (post.isReply == null && (lk === 'isreply' || lk === 'is_reply')) {
        post.isReply = !!convertedValue;
      }
      if (post.isRetweet == null && (lk === 'isretweet' || lk === 'is_retweet')) {
        post.isRetweet = !!convertedValue;
      }
      if (post.isQuote == null && (lk === 'isquote' || lk === 'is_quote')) {
        post.isQuote = !!convertedValue;
      }

      // Language and source
      if (!post.lang && (lk === 'lang' || lk === 'language')) {
        post.lang = String(convertedValue);
      }
      if (!post.sourceApp && (lk === 'sourceapp' || lk === 'source_app')) {
        post.sourceApp = String(convertedValue);
      }

      // Instagram-specific
      if (!post.ownerFullName && (lk === 'ownerfullname' || lk === 'owner_full_name')) {
        post.ownerFullName = String(convertedValue);
      }
      if (!post.ownerId && (lk === 'ownerid' || lk === 'owner_id')) {
        post.ownerId = String(convertedValue);
      }
      if (post.carouselMediaCount == null && (lk === 'carouselmediacount' || lk === 'carousel_media_count')) {
        post.carouselMediaCount = parseInt(String(convertedValue), 10) || 0;
      }

      // Location
      if (!post.locationName && (lk === 'locationname' || lk === 'location_name')) {
        post.locationName = String(convertedValue);
      }
      if (!post.locationLat && (lk === 'locationlat' || lk === 'location_lat' || lk === 'latitude' || lk === 'lat')) {
        post.locationLat = String(convertedValue);
      }
      if (!post.locationLng && (lk === 'locationlng' || lk === 'location_lng' || lk === 'longitude' || lk === 'lng')) {
        post.locationLng = String(convertedValue);
      }
    }

    if (context?.userId) {
      post.userId = context.userId;
    }
    if (context?.promptId && !post.promptId) {
      post.promptId = context.promptId;
    }

    // Coerce post field types to match database column types
    this.coercePostFieldTypes(post);

    return post;
  }

  /**
   * Persist unique post identities and return existing rows on a repeated
   * provider result. The posts table predates a composite unique constraint,
   * so the application must not blindly append the same platform post.
   * Unexpected insert errors are allowed to fail the save node instead of
   * being reported as a successful zero-post save.
   */
  private static async persistPostRecords(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    records: Record<string, any>[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ posts: any[]; newCount: number; duplicateCount: number }> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const posts: any[] = [];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byIdentity = new Map<string, any>();
    let newCount = 0;
    let duplicateCount = 0;

    for (const record of records) {
      const hasIdentity = Number.isSafeInteger(Number(record.userId))
        && Number(record.userId) > 0
        && typeof record.platform === 'string'
        && record.platform.length > 0
        && record.postId != null
        && String(record.postId).length > 0;
      const identity = hasIdentity
        ? `${Number(record.userId)}:${record.platform}:${String(record.postId)}`
        : undefined;

      if (identity && byIdentity.has(identity)) {
        duplicateCount += 1;
        continue;
      }

      if (identity) {
        const existing = await db.select()
          .from(postsTable)
          .where(and(
            eq(postsTable.userId, Number(record.userId)),
            eq(postsTable.platform, record.platform),
            eq(postsTable.postId, String(record.postId)),
          ))
          .limit(1);
        if (existing[0]) {
          byIdentity.set(identity, existing[0]);
          posts.push(existing[0]);
          duplicateCount += 1;
          continue;
        }
      }

      const [saved] = await db.insert(postsTable).values(record).returning();
      if (!saved) {
        throw new Error('Post insert returned no durable row identity.');
      }
      posts.push(saved);
      newCount += 1;
      if (identity) byIdentity.set(identity, saved);
    }

    return { posts, newCount, duplicateCount };
  }

  /**
   * Save actor results to database
   */
  private static async saveActorResultsToDb(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    results: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dbConfig: { enabled: boolean; target_table?: string; field_mapping?: Record<string, any> },
    context: ExecutionContext,
    threadId?: number,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<any> {
    if (!dbConfig?.enabled || !dbConfig.target_table) {
      this.log(context, `⏭️  Database save disabled`);
      return { saved: false, reason: 'Database save disabled' };
    }

    if (!Array.isArray(results) || results.length === 0) {
      this.log(context, `⚠️  No results to save`);
      return { saved: false, reason: 'No results to save', count: 0 };
    }

    try {
      this.log(context, `💾 Saving ${results.length} results to table: ${dbConfig.target_table}`);

      // Map actor results to database records
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sarPostUrlToIdMap: Record<string, number> = (context as any).postUrlToIdMap || {};
      const recordsToInsert = results.map((result) => {
        let mapped;
        if (dbConfig.target_table === 'leads') {
          mapped = this.mapActorResultToLead(result, dbConfig.field_mapping || {}, context);
          // Resolve sourcePostId from previously saved posts
          if (!mapped.sourcePostId && Object.keys(sarPostUrlToIdMap).length > 0) {
            const postRef = result.postUrl || result.post_url || result.url || result.link_post || result.inputUrl;
            if (postRef && sarPostUrlToIdMap[postRef]) {
              mapped.sourcePostId = sarPostUrlToIdMap[postRef];
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } else if ((context as any).savedPostIds?.length === 1) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              mapped.sourcePostId = (context as any).savedPostIds[0];
            }
          }
        } else if (dbConfig.target_table === 'posts') {
          mapped = this.mapActorResultToPost(result, dbConfig.field_mapping || {}, context);
        } else {
          mapped = this.mapActorResultToLead(result, dbConfig.field_mapping || {}, context);
        }

        // Include threadId in campaignData for thread filtering
        if (threadId) {
          mapped.campaignData = { ...(mapped.campaignData || {}), threadId: threadId };
        }
        // Add promptId if available for ICP relationship
        if (context?.promptId && !mapped.promptId) {
          mapped.promptId = context.promptId;
        }

        return mapped;
      });

      // Save to database based on target table
      if (dbConfig.target_table === 'leads') {
        const { savedLeads, recoveredLeads, duplicateLeads, rejectedCount } = await this.persistReviewedLeadRecords(
          recordsToInsert,
          context,
          threadId,
        );

        this.log(
          context,
          `✅ Persisted ${savedLeads.length} new and recovered ${recoveredLeads.length} existing lead IDs (${duplicateLeads.length} cross-provider duplicates merged, ${rejectedCount} rejected) with threadId: ${threadId || 'none'}`,
        );
        const persistedLeads = [...savedLeads, ...recoveredLeads];
        if (savedLeads.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.log(context, `   Lead IDs: ${savedLeads.map((l: any) => l.id).join(', ')}`);
        }
        // Emit a single batch WebSocket event for newly-created leads only.
        if (context && context.platform && savedLeads.length > 0) {
          const userId = savedLeads[0]?.userId;
          if (userId) {
            webSocketEmitter.emit(userId, 'leads_batch_saved', {
              leads: savedLeads,
              count: savedLeads.length,
              platform: context.platform,
              executionId: context.executionId,
              threadId: context.threadId,
            });
          }
        }

        return {
          saved: true,
          count: persistedLeads.length,
          leadsCount: persistedLeads.length,
          duplicateCount: duplicateLeads.length,
          rejectedCount,
          table: dbConfig.target_table,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ids: persistedLeads.map((l: any) => l.id)
        };
      } else if (dbConfig.target_table === 'posts') {
        const { posts: savedPosts, newCount, duplicateCount } = await this.persistPostRecords(recordsToInsert);
        this.log(context, `✅ Persisted ${savedPosts.length} post identities (${newCount} new, ${duplicateCount} existing) with threadId: ${threadId || 'none'}`);
        if (savedPosts.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          this.log(context, `   Post IDs: ${savedPosts.map((p: any) => p.id).join(', ')}`);
        }

        // Store saved post IDs in context for sourcePostId linking
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const existingSavedPostIds2: number[] = (context as any).savedPostIds || [];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (context as any).savedPostIds = [...existingSavedPostIds2, ...savedPosts.map((p: any) => p.id)];
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const postUrlToIdMap2: Record<string, number> = (context as any).postUrlToIdMap || {};
        for (const post of savedPosts) {
          if (post.postUrl) postUrlToIdMap2[post.postUrl] = post.id;
          if (post.postId) postUrlToIdMap2[post.postId] = post.id;
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (context as any).postUrlToIdMap = postUrlToIdMap2;

        return {
          saved: true,
          count: savedPosts.length,
          postsCount: savedPosts.length,
          table: dbConfig.target_table,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ids: savedPosts.map((p: any) => p.id)
        };
      } else {
        this.log(context, `⚠️  Unsupported target table: ${dbConfig.target_table}`);
        return {
          saved: false,
          reason: `Unsupported target table: ${dbConfig.target_table}`
        };
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      const errorMessage = `Database save error: ${error.message}`;
      this.log(context, `❌ ${errorMessage}`);
      // Return failed status instead of throwing to allow workflow to continue
      return {
        saved: false,
        error: errorMessage,
        reason: 'Database save failed'
      };
    }
  }

  /**
   * Sanitize hashtags by removing # symbol and special characters
   * Instagram API requires hashtags matching regex: ^[^!?.,:;\-+=*&%$#@/\~^|<>()[\]{}"'\`\s]+$
   */
  private static sanitizeHashtags(hashtags: string[]): string[] {
    if (!Array.isArray(hashtags)) return hashtags;

    return hashtags
      .map(tag => {
        if (typeof tag !== 'string') return null;
        // Remove # symbol and trim whitespace
        let cleaned = tag.replace(/^#+/, '').trim();
        // Remove special characters that Instagram doesn't allow
        // eslint-disable-next-line no-useless-escape
        cleaned = cleaned.replace(/[!?.,:;\-+=*&%$#@/\\~^|<>()[\]{}"'\`\s]/g, '');
        return cleaned;
      })
      .filter((tag): tag is string => tag !== null && tag.length > 0);
  }

  /**
   * Sanitize usernames by removing @ symbol
   */
  private static sanitizeUsernames(usernames: string[]): string[] {
    if (!Array.isArray(usernames)) return usernames;

    return usernames
      .map(username => {
        if (typeof username !== 'string') return null;
        // Remove @ symbol and trim whitespace
        return username.replace(/^@+/, '').trim();
      })
      .filter((username): username is string => username !== null && username.length > 0);
  }

  /**
   * Sanitize actor inputs based on actor type
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static sanitizeActorInputs(actorId: string, input: Record<string, any>): Record<string, any> {
    const sanitized = { ...input };

    // Coerce known array fields from strings to arrays
    // Some Mustache resolution or LLM generation may produce strings instead of arrays
    const knownArrayFields = [
      'searchQueries', 'locations', 'currentJobTitles', 'pastJobTitles',
      'seniorityLevelIds', 'currentCompanies', 'pastCompanies', 'schools',
      'industryIds', 'functionIds', 'companySize', 'targetUrls', 'posts',
      'queries', 'usernames', 'hashtags', 'username', 'startUrls',
      'directUrls',
      'searchStringsArray', 'authorUrls', 'authorsCompanies', 'authorKeywords',
      'companies', 'searches', 'yearsOfExperienceIds', 'yearsAtCurrentCompanyIds',
    ];

    for (const field of knownArrayFields) {
      if (field in sanitized && typeof sanitized[field] === 'string') {
        const strVal = sanitized[field].trim();
        if (strVal) {
          // Try JSON parse first (e.g., '["item1","item2"]')
          try {
            const parsed = JSON.parse(strVal);
            if (Array.isArray(parsed)) {
              sanitized[field] = parsed;
              continue;
            }
          // eslint-disable-next-line no-empty
          } catch {}
          // Split by comma as fallback
          sanitized[field] = strVal.split(',').map((s: string) => s.trim()).filter(Boolean);
        } else {
          // Empty string - remove the field entirely
          delete sanitized[field];
        }
      }
    }

    // LinkedIn filter IDs are string enums ("120"). Inputs reviewed before
    // generation coerced item types may hold numbers; send what the actor accepts.
    if (actorId.toLowerCase().includes('linkedin')) {
      for (const field of [
        'seniorityLevelIds', 'excludeSeniorityLevelIds', 'functionIds', 'excludeFunctionIds',
        'yearsOfExperienceIds', 'yearsAtCurrentCompanyIds',
      ]) {
        if (Array.isArray(sanitized[field])) {
          sanitized[field] = sanitized[field].map((item: unknown) => typeof item === 'number' ? String(item) : item);
        }
      }
    }

    // Instagram-specific sanitization
    if (actorId.includes('instagram')) {
      // Sanitize hashtags
      if ('hashtags' in sanitized && Array.isArray(sanitized.hashtags)) {
        // Keyword searches use this same field but must retain phrase boundaries.
        sanitized.hashtags = sanitized.keywordSearch === true
          ? sanitized.hashtags.filter((term: unknown): term is string => typeof term === 'string')
            .map((term: string) => term.trim()).filter(Boolean)
          : this.sanitizeHashtags(sanitized.hashtags);
      }
      // Sanitize usernames
      if ('usernames' in sanitized && Array.isArray(sanitized.usernames)) {
        sanitized.usernames = this.sanitizeUsernames(sanitized.usernames);
      }
    }

    // Twitter/X-specific sanitization
    if (actorId.includes('twitter') || actorId.includes('/x-')) {
      if ('hashtags' in sanitized && Array.isArray(sanitized.hashtags)) {
        sanitized.hashtags = this.sanitizeHashtags(sanitized.hashtags);
      }
      if ('usernames' in sanitized && Array.isArray(sanitized.usernames)) {
        sanitized.usernames = this.sanitizeUsernames(sanitized.usernames);
      }
    }

    // Clean up empty arrays and empty strings/whitespace to prevent Apify validation errors (e.g. "Field input.locations array must not be empty")
    for (const key of Object.keys(sanitized)) {
      const val = sanitized[key];
      if (val === null || val === undefined || (Array.isArray(val) && val.length === 0)) {
        delete sanitized[key];
      } else if (typeof val === 'string' && val.trim() === '') {
        delete sanitized[key];
      }
    }

    return sanitized;
  }

  /**
   * Validate actor inputs based on schema and common patterns
   */
  private static validateActorInput(
    actorId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input: Record<string, any>,
    node: WorkflowNode,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const schema = node.data.schema || this.schemaRegistry?.getSchema(actorId);

    // Get required inputs from schema if available
    const requiredInputs = Array.from(new Set([
      ...(schema?.inputSchema?.required || []),
      ...(node.data.requiredInputFields || []),
    ]));

    // Check required fields
    for (const field of requiredInputs) {
      const value = input[field];
      // Check if field is missing, undefined, or null
      if (!(field in input) || value === undefined || value === null
        || (typeof value === 'string' && !value.trim())
        || (Array.isArray(value) && value.length === 0)) {
        errors.push(`Required field '${field}' is missing`);
      }
    }

    // Validate based on actor type and schema
    if (actorId.includes('linkedin')) {
      // LinkedIn-specific validation
      if ('locations' in input) {
        if (!Array.isArray(input.locations)) {
          errors.push('Field input.locations must be array');
        } else if (input.locations.length === 0) {
          errors.push('Field input.locations array must not be empty');
        }
      }
      if ('currentJobTitles' in input && !Array.isArray(input.currentJobTitles)) {
        errors.push('Field input.currentJobTitles must be array');
      }
      // searchQuery can be empty if currentJobTitles or other filters are provided
      if ('searchQuery' in input && (!input.searchQuery || input.searchQuery.trim() === '')) {
        const hasFilters = (Array.isArray(input.currentJobTitles) && input.currentJobTitles.length > 0)
          || (Array.isArray(input.locations) && input.locations.length > 0)
          || (Array.isArray(input.seniorityLevelIds) && input.seniorityLevelIds.length > 0);
        if (!hasFilters) {
          errors.push('Field input.searchQuery must not be empty (unless currentJobTitles, locations, or seniorityLevelIds are provided)');
        }
      }
      // searchQueries (for post search) must be an array
      if ('searchQueries' in input) {
        if (!Array.isArray(input.searchQueries)) {
          // Auto-convert string to array
          if (typeof input.searchQueries === 'string' && input.searchQueries.trim()) {
            input.searchQueries = [input.searchQueries];
          } else {
            errors.push('Field input.searchQueries must be array (Hint: Check that array fields like locations, currentJobTitles, etc. are passed as arrays, not strings)');
          }
        } else if (input.searchQueries.length === 0) {
          errors.push('Field input.searchQueries must not be empty');
        }
      }
    } else if (actorId.includes('google-places') || actorId.includes('crawler-google-places') || actorId.includes('google-maps-places')) {
      // Google Maps-specific validation
      const hasSearchTarget = ['searchStringsArray', 'categoryFilterWords', 'startUrls', 'placeIds']
        .some(key => Array.isArray(input[key]) && input[key].length > 0)
        || input.allPlacesNoSearchAction === true;
      if (!hasSearchTarget) {
        errors.push('Google Maps requires search terms, place categories, place IDs, or start URLs');
      }
      if ('searchStringsArray' in input) {
        if (!Array.isArray(input.searchStringsArray)) {
          errors.push('Field input.searchStringsArray must be array');
        } else if (input.searchStringsArray.length === 0) {
          errors.push('Field input.searchStringsArray must not be empty');
        }
      }
      if ('locationQuery' in input) {
        // locationQuery can be a string or an array
        if (typeof input.locationQuery === 'string' && input.locationQuery.trim() === '') {
          errors.push('Field input.locationQuery must not be empty');
        } else if (Array.isArray(input.locationQuery) && input.locationQuery.length === 0) {
          errors.push('Field input.locationQuery must not be empty');
        }
      }
    } else if (actorId.includes('justdial')) {
      // JustDial-specific validation
      const hasUrls = Array.isArray(input.startUrls) && input.startUrls.some((value: unknown) => typeof value === 'string' && value.trim());
      const hasCitySearch = typeof (input.city || input.location) === 'string' && (input.city || input.location).trim()
        && typeof input.search === 'string' && input.search.trim();
      if (!hasUrls && !hasCitySearch) errors.push('JustDial requires city and search, or verified startUrls');
      if ('location' in input) {
        if (typeof input.location !== 'string' || input.location.trim() === '') {
          errors.push('Field input.location must be a non-empty string');
        }
      }
      if (!hasUrls && 'search' in input) {
        if (typeof input.search !== 'string' || input.search.trim() === '') {
          errors.push('Field input.search must be a non-empty string');
        }
      }
      if ('maxItems' in input) {
        const maxItems = Number(input.maxItems);
        if (isNaN(maxItems) || maxItems < 1 || maxItems > 1000) {
          errors.push('Field input.maxItems must be a number between 1 and 1000');
        }
      }
    } else if (actorId.includes('instagram')) {
      // Instagram-specific validation
      if ('usernames' in input) {
        if (!Array.isArray(input.usernames)) {
          errors.push('Field input.usernames must be array');
        } else if (input.usernames.length === 0) {
          errors.push('Field input.usernames must not be empty');
        }
      }
      // Follower scraper uses 'username' (singular) as array
      if ('username' in input) {
        if (!Array.isArray(input.username)) {
          errors.push('Field input.username must be array');
        } else if (input.username.length === 0) {
          errors.push('Field input.username must not be empty');
        }
      }
      // Check for sessionid in follower scraper
      if (actorId.includes('followers') && 'sessionid' in input) {
        const sessionId = input.sessionid;
        if (!sessionId ||
          sessionId === '' ||
          sessionId.includes('your_') ||
          sessionId.includes('placeholder') ||
          sessionId.length < 20) {
          errors.push('Instagram follower scraper requires a valid sessionid. Please configure your Instagram session ID in environment settings (INSTAGRAM_SESSION_ID).');
        }
      }
    } else if (actorId.includes('twitter')) {
      // Twitter-specific validation
      if ('searchQuery' in input && (!input.searchQuery || input.searchQuery.trim() === '')) {
        errors.push('Field input.searchQuery must not be empty');
      }
    } else if (actorId.includes('facebook')) {
      // Facebook-specific validation
      if ('query' in input) {
        const queryValue = input.query;
        // Allow default value but check it's a valid string
        if (queryValue === null || queryValue === undefined) {
          errors.push('Field input.query is required');
        } else if (typeof queryValue !== 'string') {
          errors.push(`Field input.query must be string (got ${typeof queryValue})`);
        }
      }
      if ('startUrls' in input) {
        if (!Array.isArray(input.startUrls)) {
          errors.push('Field input.startUrls must be array');
        } else if (input.startUrls.length === 0) {
          errors.push('Field input.startUrls must not be empty');
        } else {
          // Nullable iteration targets must skip cleanly. Never turn an
          // unresolved author URL into a request for a generic placeholder.
          for (let i = 0; i < input.startUrls.length; i++) {
            const item = input.startUrls[i];
            const rawUrl = typeof item === 'string'
              ? item
              : (item && typeof item === 'object' ? item.url : undefined);
            if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
              errors.push(`Field input.startUrls[${i}].url must be a non-empty Facebook URL`);
              continue;
            }
            try {
              const parsed = new URL(rawUrl.trim());
              const hostname = parsed.hostname.toLowerCase().replace(/^www\./, '');
              if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
                || (hostname !== 'facebook.com' && !hostname.endsWith('.facebook.com'))) {
                errors.push(`Field input.startUrls[${i}].url must be a valid Facebook URL`);
              }
            } catch {
              errors.push(`Field input.startUrls[${i}].url must be a valid Facebook URL`);
            }
          }
        }
      }
    }

    // Generic validation from schema
    if (schema?.inputSchema?.properties) {
      for (const [field, fieldSchema] of Object.entries(schema.inputSchema.properties)) {
        if (field in input && input[field] !== undefined && input[field] !== null) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const fieldDef = fieldSchema as any;

          // Type validation
          if (fieldDef.type === 'array' && !Array.isArray(input[field])) {
            errors.push(`Field input.${field} must be array (got ${typeof input[field]})`);
          } else if (fieldDef.type === 'string' && typeof input[field] !== 'string') {
            errors.push(`Field input.${field} must be string (got ${typeof input[field]})`);
          } else if (fieldDef.type === 'number' && typeof input[field] !== 'number') {
            errors.push(`Field input.${field} must be number (got ${typeof input[field]})`);
          } else if (fieldDef.type === 'integer' && !Number.isInteger(input[field])) {
            errors.push(`Field input.${field} must be integer (got ${typeof input[field]})`);
          } else if (fieldDef.type === 'boolean' && typeof input[field] !== 'boolean') {
            errors.push(`Field input.${field} must be boolean (got ${typeof input[field]})`);
          }

          if (typeof input[field] === 'number') {
            if (fieldDef.minimum !== undefined && input[field] < fieldDef.minimum) {
              errors.push(`Field input.${field} must be at least ${fieldDef.minimum}`);
            }
            if (fieldDef.maximum !== undefined && input[field] > fieldDef.maximum) {
              errors.push(`Field input.${field} must be at most ${fieldDef.maximum}`);
            }
          }

          // Array validation - check if empty
          if (fieldDef.type === 'array' && Array.isArray(input[field])) {
            if (fieldDef.minItems && input[field].length < fieldDef.minItems) {
              errors.push(`Field input.${field} must have at least ${fieldDef.minItems} items`);
            }
            if (fieldDef.items?.type === 'object') {
              input[field].forEach((item: unknown, index: number) => {
                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                  errors.push(`Field input.${field}[${index}] must be object`);
                  return;
                }
                for (const requiredItemField of fieldDef.items.required || []) {
                  const value = (item as Record<string, unknown>)[requiredItemField];
                  if (value === undefined || value === null || value === '') {
                    errors.push(`Field input.${field}[${index}].${requiredItemField} is required`);
                  }
                }
              });
            }
          }

          // String validation - check if empty when required
          if (fieldDef.type === 'string' && typeof input[field] === 'string') {
            if (fieldDef.minLength && input[field].length < fieldDef.minLength) {
              errors.push(`Field input.${field} must be at least ${fieldDef.minLength} characters`);
            }
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Recursively resolve template variables in any data structure
   * Handles: strings, arrays, objects, and nested combinations
   */
  private static resolveTemplatesRecursively(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contextData: Record<string, any>,
    context: ExecutionContext
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): any {
    // Handle null/undefined
    if (value === null || value === undefined) {
      return value;
    }

    // Handle strings with single-brace templates {variable}
    if (typeof value === 'string' && value.includes('{') && value.includes('}')) {
      // Single-brace pattern: {variable} or {_current_item.field}
      const singleBraceMatch = value.match(/^{([^{}]+)}$/);
      if (singleBraceMatch) {
        const path = singleBraceMatch[1].trim();
        const resolved = this.getNested(contextData, path);

        if (resolved !== undefined && resolved !== null && resolved !== '') {
          const displayValue = typeof resolved === 'object'
            ? JSON.stringify(resolved).substring(0, 100)
            : resolved;
          this.log(context, `  ✅ Resolved {${path}} → ${displayValue}`);
          return resolved;
        } else {
          this.log(context, `  ⚠️  Path '${path}' not found in contextData, using placeholder URL`);
          // For URL-like templates, return a valid placeholder URL instead of keeping the template
          return 'https://example.com';
        }
      }

      // Interpolated templates: "prefix/{var}/suffix"
      if (value.includes('{') && !value.match(/^{[^{}]+}$/) && !value.includes('{{')) {
        let resolved = value;
        const patterns = [...value.matchAll(/{([^{}]+)}/g)];
        let hasReplacements = false;
        let hasUnresolvedTemplates = false;

        for (const match of patterns) {
          const path = match[1].trim();
          const replacementValue = this.getNested(contextData, path);

          if (replacementValue !== undefined && replacementValue !== null && replacementValue !== '') {
            const stringValue = typeof replacementValue === 'string'
              ? replacementValue
              : JSON.stringify(replacementValue);
            resolved = resolved.replace(match[0], stringValue);
            this.log(context, `  ✅ Interpolated {${path}} → ${stringValue}`);
            hasReplacements = true;
          } else {
            // Keep track of unresolved templates
            hasUnresolvedTemplates = true;
            this.log(context, `  ⚠️  Unresolved template in interpolation: {${path}}`);
          }
        }

        // If there are unresolved templates, return the original value with remaining templates
        if (hasUnresolvedTemplates && !hasReplacements) {
          this.log(context, `  Using placeholder for unresolved interpolation: ${value}`);
          return 'https://example.com'; // Safe placeholder for URL-like fields
        }
        
        return resolved;
      }

      // Return original if no template resolution
      return value;
    }

    // Handle arrays - recursively process each element
    if (Array.isArray(value)) {
      return value.map(item => this.resolveTemplatesRecursively(item, contextData, context));
    }

    // Handle objects - recursively process each property
    if (typeof value === 'object') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result: Record<string, any> = {};
      for (const [key, val] of Object.entries(value)) {
        result[key] = this.resolveTemplatesRecursively(val, contextData, context);
      }
      return result;
    }

    // Return primitives as-is (numbers, booleans, etc.)
    return value;
  }

  private static buildActorInput(
    node: WorkflowNode,
    context: ExecutionContext,
    initialParams: Record<string, any>,
    workflow?: Workflow,
  ): Record<string, any> {
    const actorId = node.data.actorId || '';
    const input = this.applyInputMapping(node.data.inputMapping || {}, context, initialParams);
    const firstActor = workflow?.nodes.find(candidate => candidate.type === 'actor');
    if (context.leadInputId && firstActor?.id === node.id && !initialParams._current_item) {
      // Missing reviewed aliases are not permission to invent fallback queries.
      // For example, URL-only JustDial input must not gain "business opportunities".
      for (const [key, mapping] of Object.entries(node.data.inputMapping || {})) {
        const sourcePath = typeof mapping === 'string' ? mapping.match(/^\{\{\s*([\w.[\]]+)\s*\}\}$/)?.[1] : undefined;
        if (sourcePath && this.getNested(initialParams, sourcePath) == null) delete input[key];
      }
      // The review UI exposes the actor schema, not just the legacy mapping.
      // Canonical approved values win over missing-alias defaults. Only the
      // first actor may consume this snapshot; downstream inputs remain mapped.
      const schema = this.schemaRegistry?.getSchema(actorId) || node.data.schema;
      const reviewableInputFields = Array.isArray(node.data.reviewableInputFields)
        ? node.data.reviewableInputFields
        : Object.keys(schema?.inputSchema?.properties || {});
      const allowed = new Set([
        ...reviewableInputFields,
        ...Object.keys(node.data.inputMapping || {}),
        ...Object.keys(node.data.finalValues || {}),
      ]);
      for (const key of allowed) {
        if (!key.startsWith('_') && Object.hasOwn(initialParams, key)) {
          input[key] = initialParams[key];
        }
      }
      // finalValues are already part of the approved snapshot. Do not replace
      // them with potentially changed template values after approval.
    }
    const sanitized = this.sanitizeActorInputs(actorId, input);
    const actorSchema = this.schemaRegistry?.getSchema(actorId) || node.data.schema;
    for (const field of ACTOR_RESULT_LIMIT_FIELDS) {
      const value = Number(sanitized[field]);
      const minimum = Number(actorSchema?.inputSchema?.properties?.[field]?.minimum);
      if (Number.isSafeInteger(value) && Number.isFinite(minimum) && value < minimum) {
        sanitized[field] = minimum;
      }
    }
    if (context.requestedLeadLimit !== undefined) {
      const remaining = Math.max(0, context.requestedLeadLimit - context.persistedLeadCount);
      if (remaining > 0) {
        for (const field of ACTOR_RESULT_LIMIT_FIELDS) {
          const value = Number(sanitized[field]);
          if (!Number.isSafeInteger(value) || value <= remaining) continue;
          const minimum = Number(actorSchema?.inputSchema?.properties?.[field]?.minimum);
          const providerCompatibleCap = Number.isFinite(minimum) && minimum > remaining
            ? minimum
            : remaining;
          if (value > providerCompatibleCap) sanitized[field] = providerCompatibleCap;
        }
      }
    }
    const sourceTargetField = node.data.sourceTargetField;
    const sourceLimitField = node.data.sourceLimitField;
    if (sourceTargetField && sourceLimitField && Array.isArray(sanitized[sourceTargetField])) {
      const targetCount = sanitized[sourceTargetField].length;
      const currentLimit = Number(sanitized[sourceLimitField]);
      if (targetCount > 0 && (!Number.isSafeInteger(currentLimit) || currentLimit < targetCount)) {
        sanitized[sourceLimitField] = targetCount;
      }
    }
    return sanitized;
  }

  private static applyInputMapping(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputMapping: Record<string, any>,
    context: ExecutionContext,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    initialParams: Record<string, any>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Record<string, any> {
    // Build contextData with _current_item having higher priority
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contextData: Record<string, any> = {
      ...initialParams,
      ...Object.fromEntries(context.nodesExecuted),
      settings: {
        max_results_per_platform: initialParams.max_results_per_platform || 20,
        instagram_session_id: initialParams.instagram_session_id || '',
      },
    };

    // Ensure _current_item is preserved if it exists in initialParams
    if (initialParams._current_item) {
      contextData._current_item = initialParams._current_item;
    }

    this.log(context, `🔍 applyInputMapping Debug - contextData keys: ${Object.keys(contextData).join(', ')}`);
    if (contextData._current_item) {
      this.log(context, `🔍 _current_item is present with keys: ${Object.keys(contextData._current_item).join(', ')}`);
    }

    // NEW APPROACH: Use recursive template resolution for the entire inputMapping
    // This handles all patterns: strings, arrays, nested objects, etc.
    const resolvedMapping = this.resolveTemplatesRecursively(inputMapping, contextData, context);

    // Handle Mustache {{var}} syntax for backward compatibility
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(resolvedMapping)) {
      if (typeof value === 'string' && value.includes('{{') && value.includes('}}')) {
        // Simple Mustache variable reference like {{varName}}
        const simpleVarMatch = value.match(/^\{\{([^}]+)\}\}$/);
        if (simpleVarMatch) {
          const varName = simpleVarMatch[1].trim();
          if (varName in contextData) {
            const resolvedValue = contextData[varName];
            result[key] = resolvedValue;
            this.log(context, `  ✅ Mustache {{${varName}}} → ${typeof resolvedValue} (value: ${resolvedValue})`);
            continue;
          } else {
            // Variable not found in context - use sensible default
            const defaultValue = this.getDefaultValueForField(key);
            result[key] = defaultValue;
            this.log(context, `  ⚠️  Mustache variable {{${varName}}} not found, using default: ${defaultValue}`);
            continue;
          }
        }

        // Complex Mustache template
        try {
          const rendered = Mustache.render(value, contextData);
          if (!rendered.includes('{')) {
            // If rendered value is empty, use a sensible default
            if (rendered === '' || rendered === undefined || rendered === null) {
              const defaultValue = this.getDefaultValueForField(key);
              result[key] = defaultValue;
              this.log(context, `Mustache template rendered to empty value, using default: ${defaultValue}`);
              continue;
            }

            // Try to parse as JSON or number - but be careful about type coercion
            try {
              result[key] = JSON.parse(rendered);
            } catch {
              // Only convert to number if it looks like a valid number
              if (/^-?\d+(\.\d+)?$/.test(rendered.trim())) {
                result[key] = Number(rendered);
              } else {
                result[key] = rendered;
              }
            }
            continue;
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          this.log(context, `  ERROR rendering Mustache template: ${e.message}`);
          // Use default value on error
          const defaultValue = this.getDefaultValueForField(key);
          result[key] = defaultValue;
          continue;
        }
      }

      // Use the resolved value as-is (from recursive resolution)
      result[key] = value;
    }

    // Clean up: remove empty string values and placeholder URLs that won't produce useful results
    // This prevents sending empty fields to actors (e.g., companySize: "", searchQuery: "")
    for (const [key, value] of Object.entries(result)) {
      if (typeof value === 'string' && (value === '' || value === 'https://example.com')) {
        this.log(context, `  🧹 Removing empty/placeholder field: ${key}`);
        delete result[key];
      }
    }

    return result;
  }

  /**
   * Provide sensible default values for common actor input fields
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static getDefaultValueForField(fieldName: string): any {
    const lowerName = fieldName.toLowerCase();
    
    // Search/query fields
    if (lowerName.includes('query') || lowerName.includes('search')) {
      return 'business opportunities'; // Generic but valid search term
    }
    if (lowerName.includes('keyword')) {
      return 'business growth';
    }
    if (lowerName.includes('username') || lowerName.includes('user')) {
      return ['username']; // Default array for username fields
    }
    if (lowerName.includes('location')) {
      return '';  // Omit → let actor search globally (cleaned up by empty-string removal below)
    }
    if (lowerName.includes('hashtag') || lowerName.includes('tag')) {
      return ['business'];
    }
    
    // Number fields
    if (lowerName.includes('max') || lowerName.includes('limit') || lowerName.includes('result')) {
      return 10;
    }
    
    // URL/Link fields
    if (lowerName.includes('url') || lowerName.includes('link')) {
      return 'https://example.com';
    }
    
    // Boolean fields
    if (lowerName.includes('recent') || lowerName.includes('verified')) {
      return true;
    }
    
    // Default: return empty string for text, empty array for lists
    return '';
  }

  /** Count only durable lead rows. Post persistence must never turn a failed
   * downstream lead stage into a nominal partial success. */
  private static getPersistedLeadCount(context: ExecutionContext): number {
    return context.persistedLeadCount;
  }

  /**
   * Determine execution order based on edges
   */
  private static getExecutionOrder(workflow: Workflow): string[] {
    const order: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const dfs = (nodeId: string) => {
      if (visited.has(nodeId)) return;
      if (visiting.has(nodeId)) {
        throw new Error(`Circular dependency detected in workflow: ${nodeId}`);
      }

      visiting.add(nodeId);

      // Find all edges where this node is the source
      const outgoing = workflow.edges.filter((e) => e.source === nodeId);
      for (const edge of outgoing) {
        dfs(edge.target);
      }

      visiting.delete(nodeId);
      visited.add(nodeId);
      order.push(nodeId);
    };

    // Start from all nodes with no incoming edges
    const allNodeIds = new Set(workflow.nodes.map((n) => n.id));
    const nodesWithIncoming = new Set(workflow.edges.map((e) => e.target));
    const startNodes = workflow.nodes.filter((n) => !nodesWithIncoming.has(n.id));

    for (const node of startNodes) {
      dfs(node.id);
    }

    // Add any remaining nodes
    for (const nodeId of allNodeIds) {
      dfs(nodeId);
    }

    // Return order where sources are executed before targets
    return order.reverse();
  }

  /**
   * Flatten nested objects for database storage
   * Converts {author: {name: "John"}} to {author_name: "John"}
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static flattenObject(obj: any, prefix: string = '', maxDepth: number = 3, currentDepth: number = 0): Record<string, any> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result: Record<string, any> = {};

    if (currentDepth >= maxDepth || obj === null || obj === undefined) {
      return result;
    }

    for (const [key, value] of Object.entries(obj)) {
      const newKey = prefix ? `${prefix}_${key}` : key;

      if (value === null || value === undefined) {
        result[newKey] = value;
      } else if (Array.isArray(value)) {
        // Store arrays as JSON strings
        result[newKey] = JSON.stringify(value);
      } else if (typeof value === 'object' && !(value instanceof Date)) {
        // Recursively flatten nested objects
        const nested = this.flattenObject(value, newKey, maxDepth, currentDepth + 1);
        Object.assign(result, nested);
      } else {
        result[newKey] = value;
      }
    }

    return result;
  }

  /**
   * Convert Unix timestamps to ISO date strings
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static convertTimestamps(obj: any): any {
    if (obj === null || obj === undefined) {
      return obj;
    }

    // Check for Unix timestamp (10-digit number for seconds, 13-digit for milliseconds)
    if (typeof obj === 'number') {
      // If it's a reasonable timestamp (between year 2000 and 2100)
      const year2000 = 946684800; // 2000-01-01 in seconds
      const year2100 = 4102444800; // 2100-01-01 in seconds
      const year2000Ms = 946684800000; // 2000-01-01 in milliseconds
      const year2100Ms = 4102444800000; // 2100-01-01 in milliseconds

      if (obj >= year2000 && obj <= year2100) {
        // Seconds timestamp
        return new Date(obj * 1000);
      } else if (obj >= year2000Ms && obj <= year2100Ms) {
        // Milliseconds timestamp
        return new Date(obj);
      }
    }

    // Try to parse ISO date strings
    if (typeof obj === 'string') {
      const datePattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
      if (datePattern.test(obj)) {
        const date = new Date(obj);
        if (!isNaN(date.getTime())) {
          return date;
        }
      }
    }

    return obj;
  }

  /**
   * Extract and map as much data as possible from actor result
   */
  private static extractAllFields(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    actorResult: any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    fieldMapping: Record<string, any>,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    targetTable: 'leads' | 'posts'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Record<string, any> {
    const flattened = this.flattenObject(actorResult);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mapped: Record<string, any> = {};

    // Apply explicit field mappings first
    for (const [targetField, sourcePath] of Object.entries(fieldMapping)) {
      if (!targetField || !sourcePath) continue;
      const value = this.resolveSourceValue(sourcePath as string, actorResult);
      if (value !== undefined) {
        mapped[targetField] = this.convertTimestamps(value);
      }
    }

    // Try to auto-map remaining fields based on flattened result
    for (const [flatKey, value] of Object.entries(flattened)) {
      // Skip if already mapped
      if (mapped[flatKey] !== undefined) continue;

      // Convert timestamps
      const convertedValue = this.convertTimestamps(value);

      // Try to match to known database fields
      // This is a simple heuristic - you can make it smarter
      if (flatKey.toLowerCase().includes('email')) {
        mapped.email = mapped.email || convertedValue;
      } else if (flatKey.toLowerCase().includes('name')) {
        mapped.fullName = mapped.fullName || convertedValue;
      } else if (flatKey.toLowerCase().includes('phone')) {
        mapped.phone = mapped.phone || convertedValue;
      }
      // Add more field matching logic as needed
    }

    return mapped;
  }

  /**
   * Logging utility
   */
  private static log(context: ExecutionContext, message: string) {
    const timestamp = new Date().toISOString();
    const logMessage = `[${timestamp}] ${message}`;
    context.logs.push(logMessage);
    logger.info(logMessage);
  }

  /**
   * Sanitize object for logging - removes sensitive PII data
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static sanitizeForLogging(obj: any): any {
    if (!obj || typeof obj !== 'object') return obj;

    const sensitiveKeys = [
      'email', 'phone', 'password', 'token', 'apikey', 'api_key', 'secret',
      'firstName', 'lastName', 'first_name', 'last_name', 'full_name', 'fullName',
      'address', 'ssn', 'creditCard', 'credit_card', 'cvv', 'cardNumber',
      'instagram', 'twitter', 'linkedin', 'facebook', 'socialUrl',
      'ip', 'ipAddress', 'ip_address', 'session', 'cookie', 'auth'
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sanitized: any = Array.isArray(obj) ? [] : {};

    for (const key of Object.keys(obj)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = sensitiveKeys.some(sk => lowerKey.includes(sk.toLowerCase()));

      if (isSensitive) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof obj[key] === 'object' && obj[key] !== null) {
        sanitized[key] = this.sanitizeForLogging(obj[key]);
      } else {
        sanitized[key] = obj[key];
      }
    }

    return sanitized;
  }

  /**
   * Safe stringify for logging - sanitizes sensitive data
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private static safeStringify(obj: any, indent?: number): string {
    return JSON.stringify(this.sanitizeForLogging(obj), null, indent);
  }

  /**
   * Calculate elapsed time
   */
  private static getElapsedTime(context: ExecutionContext): string {
    if (!context.endTime) return 'N/A';
    const elapsed = context.endTime.getTime() - context.startTime.getTime();
    return `${(elapsed / 1000).toFixed(2)}s`;
  }
}
