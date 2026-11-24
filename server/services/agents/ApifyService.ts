/**
 * Apify Service - Handles Apify actor execution and result fetching
 * Integrates with apify-client SDK for actor runs
 * 
 * NOTE: Uses admin API credentials from admin_api_credentials table.
 * All users share these system-wide credentials.
 */

import { ApifyClient } from 'apify-client';
import type { ApifyStepConfig } from './types';
import { insertApifyUsage } from '../../models/apifyUsages/functions';
import { getAdminApifyKey, updateAdminCredentialUsage } from '../adminCredentialsService';
import { getAdminCredentialForActor } from '../../models/adminApiCredentials/functions';
import { logger } from '../../utils/logger.js';
import { eventBus } from '../../events/EventBus.js';
import { trackGeneratedOutput } from '../StorageTrackingHooks.js';
import { newUsageContext, insightProcess, withUsageContext } from '../insights/UsageContext.js';
import { getRechargeRate, getUsageRate } from '../../models/creditPricing/functions.js';
import { getUsdToInrRate } from '../../utils/currency.js';
import { sleep } from '../../utils/sleep.js';

export interface ApifyRunOptions {
  actorId: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: Record<string, any>;
  timeout?: number;
  memory?: number;
  // Usage tracking context
  userId?: number;
  threadId?: number;
  workflowId?: string;
  purpose?: string;
}

export interface ApifyRunResult {
  success: boolean;
  datasetId?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  items?: any[];
  error?: string;
  runId?: string;
  status?: string;
}

export class ApifyService {
  private client: ApifyClient | null;
  private disabled: boolean = false;
  private maxRetries: number = 2;
  private retryDelay: number = 5000; // 5 seconds
  private circuitBreakerFailures: number = 0;
  private circuitBreakerThreshold: number = 5;
  private circuitBreakerTimeout: number = 300000; // 5 minutes
  private lastFailureTime: number = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private actorHealthMonitor: any;
  private adminCredentialId: number | null = null;

  constructor(apiToken?: string, adminCredentialId?: number) {
    // Initialize health monitor (will be set later if needed)
    this.actorHealthMonitor = null;
    this.adminCredentialId = adminCredentialId || null;

    const token = apiToken;
    if (!token) {
      logger.error('[ApifyService] No API token provided; ApifyService is disabled. Please configure Apify in Admin → Integrations');
      this.disabled = true;
      this.client = null;
      return;
    }

    // Validate token format (basic check)
    if (token.length < 20) {
      logger.error('[ApifyService] API token appears to be invalid (too short)');
      this.disabled = true;
      this.client = null;
      return;
    }

    try {
      this.client = new ApifyClient({ token });
      this.disabled = false;
      logger.info('[ApifyService] Initialized successfully');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[ApifyService] Failed to initialize Apify client');
      this.disabled = true;
      this.client = null;
    }
  }

  /**
   * Create ApifyService using admin credentials
   * This is the preferred way to create an ApifyService instance
   */
  static async createWithAdminCredentials(actorId?: string): Promise<ApifyService> {
    // If actorId provided, check for actor-specific credential first
    if (actorId) {
      try {
        const actorCred = await getAdminCredentialForActor(actorId);
        if (actorCred && actorCred.isActive) {
          logger.info({ id: actorCred.id, actorId: actorId }, '[ApifyService] Using actor-specific admin credential ID: for actor');
          await updateAdminCredentialUsage(actorCred.id);
          return new ApifyService(actorCred.apiKey, actorCred.id);
        }
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (err) {
        logger.warn({ actorId: actorId }, '[ApifyService] Failed to get actor-specific credential for , falling back');
      }
    }

    const adminCred = await getAdminApifyKey();
    
    if (!adminCred) {
      logger.warn('[ApifyService] No admin Apify credential configured');
      return new ApifyService(undefined);
    }
    
    logger.info({ id: adminCred.id }, '[ApifyService] Creating service with admin credential ID');
    
    // Update last used timestamp
    await updateAdminCredentialUsage(adminCred.id);
    
    return new ApifyService(adminCred.apiKey, adminCred.id);
  }

  /**
   * Check if Apify service is available (has admin credentials)
   */
  static async isAvailable(): Promise<boolean> {
    const adminCred = await getAdminApifyKey();
    return adminCred !== null;
  }

  /**
   * Execute an Apify actor and wait for results
   */
  async runActor(options: ApifyRunOptions): Promise<ApifyRunResult> {
    const { actorId, input, timeout = 600, memory = 4096, userId, threadId, workflowId, purpose } = options;
    const startTime = Date.now();

    try {
      // Check circuit breaker
      if (this.isCircuitBreakerOpen()) {
        const errorMsg = 'Apify service is temporarily unavailable (circuit breaker open)';
        logger.error({ errorMsg: errorMsg }, '[ApifyService]');

        // Record health monitor failure
        if (this.actorHealthMonitor) {
          this.actorHealthMonitor.recordFailure(`apify/${actorId}`, errorMsg);
        }

        // Track failed usage
        await this.trackUsage({
          userId, threadId, workflowId, actorId, purpose,
          success: false, errorMessage: errorMsg, durationMs: Date.now() - startTime,
          input
        });

        return { success: false, error: errorMsg };
      }

      // Check health monitor
      if (this.actorHealthMonitor && !this.actorHealthMonitor.isHealthy(`apify/${actorId}`)) {
        const errorMsg = 'Apify actor is currently unhealthy';
        logger.error({ errorMsg: errorMsg }, '[ApifyService]');

        // Track failed usage
        await this.trackUsage({
          userId, threadId, workflowId, actorId, purpose,
          success: false, errorMessage: errorMsg, durationMs: Date.now() - startTime,
          input
        });

        return { success: false, error: errorMsg };
      }

      if (this.disabled || !this.client) {
        const errorMsg = 'Apify client not configured (missing or invalid APIFY_API_TOKEN)';
        logger.error({ errorMsg: errorMsg }, '[ApifyService]');
        return { success: false, error: errorMsg };
      }

      // Validate actor configuration
      const actorInfo = await this.getActorInfo(actorId);
      if (!actorInfo) {
        const errorMsg = `Actor ${actorId} not found or not accessible`;
        logger.error({ errorMsg: errorMsg }, '[ApifyService]');
        this.recordFailure();

        // Track failed usage
        await this.trackUsage({
          userId, threadId, workflowId, actorId, purpose,
          success: false, errorMessage: errorMsg, durationMs: Date.now() - startTime,
          input
        });

        return { success: false, error: errorMsg };
      }

      logger.info({ actorId, input }, '[ApifyService] Starting actor');

      // Start the actor run
      const run = await this.client!.actor(actorId).call(input, {
        timeout,
        memory,
      });

      logger.info({ status: run.status }, '[ApifyService] Actor run completed with status');

      // Check if run succeeded
      if (run.status !== 'SUCCEEDED') {
        this.recordFailure();

        // Track failed usage
        await this.trackUsage({
          userId, threadId, workflowId, actorId, purpose,
          success: false, errorMessage: `Actor run failed with status: ${run.status}`,
          durationMs: Date.now() - startTime, runId: run.id, input
        });

        return {
          success: false,
          error: `Actor run failed with status: ${run.status}`,
          runId: run.id,
          status: run.status,
        };
      }

      // Get dataset ID
      const datasetId = run.defaultDatasetId;
      if (!datasetId) {
        this.recordFailure();

        // Track failed usage
        await this.trackUsage({
          userId, threadId, workflowId, actorId, purpose,
          success: false, errorMessage: 'No dataset ID returned from actor run',
          durationMs: Date.now() - startTime, runId: run.id, input
        });

        return {
          success: false,
          error: 'No dataset ID returned from actor run',
          runId: run.id,
        };
      }

      // Fetch results from dataset
      const items = await this.fetchDatasetItems(datasetId);

      logger.info({ count: items.length, datasetId: datasetId }, '[ApifyService] Retrieved items from dataset');

      // Reset circuit breaker on success
      this.resetCircuitBreaker();

      // Record health monitor success
      const durationMs = Date.now() - startTime;
      if (this.actorHealthMonitor) {
        this.actorHealthMonitor.recordSuccess(`apify/${actorId}`, durationMs);
      }

      // Track successful usage with actual cost from Apify run stats
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const usageTotalUsd = (run as any).stats?.usageTotalUsd ?? null;
      await this.trackUsage({
        userId, threadId, workflowId, actorId, purpose,
        success: true, durationMs, runId: run.id, datasetId,
        itemsScraped: items.length, input,
        // Estimate compute units based on duration (rough approximation)
        computeUnits: (durationMs / 1000 / 60) * 0.25, // ~0.25 CU per minute for avg actor
        usageTotalUsd,
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (userId) { eventBus.publish({ channel: 'events:scraping:completed' as any, userId, timestamp: new Date().toISOString(), data: { actorId, itemCount: items.length, runId: run.id } }).catch(() => {}); }

      // Save actor output dataset to storage (non-blocking)
      if (userId && items.length > 0) {
        const safeActorId = actorId.replace(/\//g, '-');
        // Build structured base path: {userId}/actor_output/thread-{threadId}/wf-{workflowId}/{actorId}/run-{runId}/
        const pathParts = [`${userId}`, 'actor_output'];
        if (threadId) pathParts.push(`thread-${threadId}`);
        if (workflowId) pathParts.push(`wf-${workflowId}`);
        pathParts.push(safeActorId, `run-${run.id}`);
        const basePath = pathParts.join('/');
        const commonMeta = { actorId, datasetId, runId: run.id, threadId, workflowId };

        // 1. Save dataset items
        const jsonBuffer = Buffer.from(JSON.stringify(items, null, 2), 'utf-8');
        trackGeneratedOutput({
          userId,
          buffer: jsonBuffer,
          fileName: 'dataset.json',
          mimeType: 'application/json',
          category: 'actor_output',
          referenceType: 'apify_dataset',
          referenceId: run.id,
          storageKey: `${basePath}/dataset.json`,
          metadata: { ...commonMeta, itemCount: items.length },
        }).catch(() => {});

        // 2. Save input config
        trackGeneratedOutput({
          userId,
          content: JSON.stringify(input, null, 2),
          fileName: 'input.json',
          mimeType: 'application/json',
          category: 'actor_output',
          referenceType: 'apify_input',
          referenceId: run.id,
          storageKey: `${basePath}/input.json`,
          metadata: commonMeta,
        }).catch(() => {});

        // 3. Save run log (non-blocking)
        this.fetchRunLog(run.id).then((logText) => {
          if (logText) {
            trackGeneratedOutput({
              userId: userId!,
              content: logText,
              fileName: 'log.txt',
              mimeType: 'text/plain',
              category: 'actor_output',
              referenceType: 'apify_log',
              referenceId: run.id,
              storageKey: `${basePath}/log.txt`,
              metadata: commonMeta,
            }).catch(() => {});
          }
        }).catch(() => {});

        // 4. Save key-value store items (non-blocking)
        if (run.defaultKeyValueStoreId) {
          this.fetchKeyValueStoreItems(run.defaultKeyValueStoreId).then((kvItems) => {
            for (const kv of kvItems) {
              const safeKey = kv.key.replace(/[^a-zA-Z0-9._-]/g, '_');
              trackGeneratedOutput({
                userId: userId!,
                buffer: kv.buffer,
                fileName: safeKey,
                mimeType: kv.contentType || 'application/octet-stream',
                category: 'actor_output',
                referenceType: 'apify_kv_store',
                referenceId: `${run.id}:${kv.key}`,
                storageKey: `${basePath}/kv/${safeKey}`,
                metadata: { ...commonMeta, kvKey: kv.key },
              }).catch(() => {});
            }
          }).catch(() => {});
        }
      }

      return {
        success: true,
        datasetId,
        items,
        runId: run.id,
        status: run.status,
      };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ actorId: actorId }, '[ApifyService] Error running actor');
      this.recordFailure();
      return {
        success: false,
        error: error.message || 'Unknown error running actor',
      };
    }
  }

  /**
   * Run actor with retry logic
   */
  async runActorWithRetry(options: ApifyRunOptions): Promise<ApifyRunResult> {
    let lastError: string = '';
    
    if (this.disabled || !this.client) {
      const errorMsg = 'Apify client not configured (missing APIFY_API_TOKEN)';
      logger.error({ errorMsg: errorMsg }, '[ApifyService]');
      return { success: false, error: errorMsg };
    }

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      logger.info({ attempt: attempt, maxRetries: this.maxRetries, actorId: options.actorId }, '[ApifyService] Attempt / for actor');
      
      const result = await this.runActor(options);
      
      if (result.success) {
        return result;
      }
      
      lastError = result.error || 'Unknown error';
      
      // Don't retry on certain errors (auth, invalid input, etc.)
      if (this.isNonRetryableError(lastError)) {
        logger.error({ lastError: lastError }, '[ApifyService] Non-retryable error');
        return result;
      }
      
      // Wait before retry (except on last attempt)
      if (attempt < this.maxRetries) {
        logger.info({ retryDelay: this.retryDelay }, '[ApifyService] Retrying in ms...');
        await sleep(this.retryDelay);
      }
    }
    
    return {
      success: false,
      error: `Failed after ${this.maxRetries} attempts. Last error: ${lastError}`,
    };
  }

  /**
   * Fetch all items from a dataset
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async fetchDatasetItems(datasetId: string): Promise<any[]> {
    try {
      if (this.disabled || !this.client) {
        logger.warn('[ApifyService] fetchDatasetItems called without configured client');
        return [];
      }
      const dataset = this.client!.dataset(datasetId);
      const { items } = await dataset.listItems();
      return items;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ datasetId: datasetId }, '[ApifyService] Error fetching dataset');
      throw error;
    }
  }

  /**
   * Fetch the log text for a specific run
   */
  private async fetchRunLog(runId: string): Promise<string | null> {
    try {
      if (this.disabled || !this.client) return null;
      const log = await this.client!.run(runId).log().get();
      return typeof log === 'string' ? log : null;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      logger.warn({ runId }, '[ApifyService] Failed to fetch run log');
      return null;
    }
  }

  /**
   * Fetch key-value store items for a run
   */
  private async fetchKeyValueStoreItems(storeId: string): Promise<Array<{ key: string; buffer: Buffer; contentType?: string }>> {
    try {
      if (this.disabled || !this.client) return [];
      const store = this.client!.keyValueStore(storeId);
      const { items: keys } = await store.listKeys();
      const results: Array<{ key: string; buffer: Buffer; contentType?: string }> = [];
      for (const keyInfo of keys.slice(0, 20)) { // limit to 20 items to avoid excessive storage
        try {
          const record = await store.getRecord(keyInfo.key);
          if (record && record.value) {
            const buf = Buffer.isBuffer(record.value)
              ? record.value
              : Buffer.from(typeof record.value === 'string' ? record.value : JSON.stringify(record.value, null, 2), 'utf-8');
            results.push({ key: keyInfo.key, buffer: buf, contentType: record.contentType });
          }
        } catch {
          // skip individual items that fail
        }
      }
      return results;
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    } catch (error) {
      logger.warn({ storeId }, '[ApifyService] Failed to fetch key-value store items');
      return [];
    }
  }

  /**
   * Check if an error is non-retryable
   */
  private isNonRetryableError(error: string): boolean {
    const nonRetryableKeywords = [
      'authentication',
      'authorization',
      'invalid input',
      'not found',
      'quota exceeded',
      'rate limit',
    ];

    const lowerError = error.toLowerCase();
    return nonRetryableKeywords.some(keyword => lowerError.includes(keyword));
  }

  /**
   * Circuit breaker methods
   */
  private isCircuitBreakerOpen(): boolean {
    if (this.circuitBreakerFailures >= this.circuitBreakerThreshold) {
      const timeSinceLastFailure = Date.now() - this.lastFailureTime;
      if (timeSinceLastFailure < this.circuitBreakerTimeout) {
        return true;
      } else {
        // Reset after timeout
        this.circuitBreakerFailures = 0;
        return false;
      }
    }
    return false;
  }

  private recordFailure(): void {
    this.circuitBreakerFailures++;
    this.lastFailureTime = Date.now();
  }

  private resetCircuitBreaker(): void {
    this.circuitBreakerFailures = 0;
    this.lastFailureTime = 0;
  }

  /**
   * Validate actor configuration before execution
   */
  validateActorConfig(config: ApifyStepConfig): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!config.actor_id) {
      errors.push('actor_id is required');
    }

    if (!config.input_mapping) {
      errors.push('input_mapping is required');
    }

    // Check required inputs
    if (config.required_inputs) {
      for (const requiredField of config.required_inputs) {
        if (!(requiredField in config.input_mapping)) {
          errors.push(`Required input field missing: ${requiredField}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Get actor information
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getActorInfo(actorId: string): Promise<any> {
    try {
      if (this.disabled || !this.client) {
        throw new Error('Apify client is not configured');
      }
      const actor = await this.client.actor(actorId).get();
      return actor;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ actorId: actorId }, '[ApifyService] Error getting actor info for');
      throw error;
    }
  }

  /**
   * Track Apify usage for analytics
   */
  private async trackUsage(params: {
    userId?: number;
    threadId?: number;
    workflowId?: string;
    actorId: string;
    purpose?: string;
    success: boolean;
    errorMessage?: string;
    durationMs: number;
    runId?: string;
    datasetId?: string;
    itemsScraped?: number;
    computeUnits?: number;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    input?: Record<string, any>;
    usageTotalUsd?: number | null;
  }): Promise<void> {
    const usageOwnerId=params.userId;
    if (!usageOwnerId) {
      logger.info('[ApifyService] Skipping usage tracking - no userId provided');
      return;
    }

    try {
      const computeUnits = params.computeUnits || 0;
      
      // Use actual Apify run cost if available, otherwise estimate from CU
      let baseCostCents: number;
      if (params.usageTotalUsd != null && params.usageTotalUsd > 0) {
        baseCostCents = params.usageTotalUsd * 100;
      } else {
        baseCostCents = computeUnits * 25; // fallback: ~$0.25/CU
      }

      // Apply admin-configured margin percentage
      const { getApifyMarginPercentage } = await import('../../models/apiPricing/functions.js');
      const marginPercent = await getApifyMarginPercentage();
      const estimatedCostCents = baseCostCents * (1 + marginPercent / 100);
      const context=newUsageContext({provider:'apify',model:params.actorId,process:insightProcess(params.purpose||'scraping'),
        conversation:params.threadId&&params.threadId>0?{kind:'workspace',id:params.threadId}:undefined});
      context.pricing={version:1,capturedAt:new Date().toISOString(),source:params.usageTotalUsd!=null?'provider_reported':'fixed',
        sourceReference:params.usageTotalUsd!=null?'apify_usage_total_usd':'apify_compute_units_estimate',model:params.actorId,provider:'apify',
        marginPercentage:marginPercent,providerCostUsd:(baseCostCents/100).toFixed(10),chargedCostUsd:(estimatedCostCents/100).toFixed(10),
        usdToInr:getUsdToInrRate(),creditsPerInr:await getRechargeRate(),usageCreditsPerInr:await getUsageRate(),minimumCredits:1,rounding:'ceil_whole'};

      await withUsageContext(context, async()=>{
      await insertApifyUsage({
        userId: usageOwnerId,
        threadId: params.threadId || null,
        workflowId: params.workflowId || null,
        actorId: params.actorId,
        actorName: params.actorId.includes('/') ? params.actorId.split('/').pop()!.replace(/-/g, ' ') : params.actorId,
        runId: params.runId || null,
        datasetId: params.datasetId || null,
        purpose: params.purpose || 'scraping',
        service: 'apify',
        action: 'run_actor',
        computeUnits: computeUnits.toString(),
        dataTransferGb: null,
        itemsScraped: params.itemsScraped || 0,
        estimatedCostCents,
        inputSummary: params.input ? JSON.stringify(params.input).slice(0, 500) : null,
        responseSuccess: params.success ? 1 : 0,
        errorMessage: params.errorMessage || null,
        durationMs: params.durationMs,
        metadata: { 
          runId: params.runId,
          datasetId: params.datasetId,
          usageTotalUsd: params.usageTotalUsd,
          baseCostCents,
          marginPercent,
          computeUnits,
          threadId: params.threadId,
          workflowId: params.workflowId,
        },
      });

      logger.info({ actorId: params.actorId, runId: params.runId, itemsScraped: params.itemsScraped || 0, computeUnits: computeUnits.toFixed(4), baseCostCents, marginPercent, estimatedCostCents, threadId: params.threadId, purpose: params.purpose, durationMs: params.durationMs }, '[ApifyService] Tracked usage');

      // Deduct credits for this Apify run
      if (usageOwnerId) {
        const { deductCreditsForApifyUsage } = await import('../CreditDeductionHooks.js');
        await deductCreditsForApifyUsage(usageOwnerId, {
          actorName: params.actorId, runId: params.runId,
          itemsScraped: params.itemsScraped, estimatedCostCents,
          threadId: params.threadId,
        });
      }
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      logger.error({ err: error }, '[ApifyService] Failed to track usage');
      // Don't throw - usage tracking should not break the main flow
    }
  }
}
