// ─── Lead Enrichment — Main Orchestrator ─────────────────────────────────────────

import { db } from '../../models/db.js';
import { eq } from 'drizzle-orm';
import { leadsTable } from '../../models/leads/schema.js';
import { icpProfilesTable } from '../../models/icpData/schema.js';
import { ApifyService } from '../agents/ApifyService.js';
import { LLMProviderFactory } from '../agents/LLMProviderFactory.js';
import { logger } from '../../utils/logger.js';
import { eventBus } from '../../events/EventBus.js';
import { getEnrichmentRunById, updateEnrichmentRun } from '../../models/enrichmentRuns/functions.js';
import { createEnrichmentStep, updateEnrichmentStep } from '../../models/enrichmentSteps/functions.js';
import { reserveDeepEnrichment, loadDeepEnrichment, claimDeepEnrichment, deepInputMatches, failedDeepResult } from './deepExecution.js';
import { finishEnrichmentReservation } from './billing.js';
import { trackGeneratedOutput } from '../StorageTrackingHooks.js';

import type { EnrichmentHandle, EnrichmentIterationResult, EnrichmentResult, AggregatedEnrichmentData, ExtractedInfo } from './types.js';
import { PLATFORM_ACTORS, SECONDARY_ACTORS, queueSecondaryActors, type ActorConfig } from './platformActors.js';
import { normalizeSocialProfile, sanitizeSocialProfiles } from './textExtractors.js';
import {
  mergeExtractedInfos,
  llmExtractFromWebContent,
  buildInitialHandles,
  discoverNewHandles,
  normalizeExtractedInfo,
  aggregateResults,
  emptyAggregation,
  deepCrawlWebsite,
  isBlockedWebsiteUrl,
} from './helpers.js';

// ─── Main Orchestrator Class ──────────────────────────────────────────────────────

export class LeadEnrichmentOrchestrator {
  private static readonly MAX_ITERATIONS = 15;

  /**
   * Run deep enrichment on a lead.
   * Chains across platforms to discover all available data.
   */
  async enrichLead(userId: number, leadId: number, options?: { threadId?: number; runId?: number; requestKey?: string }): Promise<EnrichmentResult> {
    const reservation = options?.runId
      ? await loadDeepEnrichment(userId, leadId, options.runId)
      : await reserveDeepEnrichment(userId, leadId, options?.requestKey);
    const cached = reservation.run.executionResult as EnrichmentResult | null;
    if (cached) return cached;
    if (!await claimDeepEnrichment(reservation)) {
      const saved = await getEnrichmentRunById(reservation.run.id);
      if (saved?.executionResult) return saved.executionResult as EnrichmentResult;
      return failedDeepResult('This enrichment is already running or its outcome needs review. Provider work was not restarted.');
    }
    const attempt = { providerAttempted: false, uncertain: false };
    try {
      const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
      if (!lead || !deepInputMatches(reservation, leadId, lead)) throw new Error('Lead enrichment inputs changed after this request was saved');
      const result = await this.executeLead(userId, leadId, reservation.run.id, attempt, options);
      await finishEnrichmentReservation(userId, reservation, result.success ? 'completed'
        : !attempt.providerAttempted ? 'not_dispatched' : attempt.uncertain ? 'uncertain' : 'definitive_failure');
      await updateEnrichmentRun(reservation.run.id, { status: result.success ? 'completed' : 'failed', completedAt: new Date(), executionResult: result });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Enrichment needs review';
      // Provider IO may already have occurred. A retry must never refund or
      // redispatch a completed/ambiguous effect merely because saving failed.
      try { await finishEnrichmentReservation(userId, reservation, attempt.providerAttempted ? 'uncertain' : 'not_dispatched'); }
      catch (settlementError) { logger.error({ settlementError, runId: reservation.run.id }, '[EnrichmentOrchestrator] Reservation needs review'); }
      const result = failedDeepResult(message);
      try { await updateEnrichmentRun(reservation.run.id, { status: 'failed', completedAt: new Date(), errorMessage: message, executionResult: result }); }
      catch (saveError) { logger.error({ saveError, runId: reservation.run.id }, '[EnrichmentOrchestrator] Outcome needs review'); }
      return result;
    }
  }

  private async executeLead(
    userId: number, leadId: number, enrichmentRunId: number,
    attempt: { providerAttempted: boolean; uncertain: boolean },
    options?: { threadId?: number },
  ): Promise<EnrichmentResult> {
    const startTime = Date.now();
    const threadId = options?.threadId;

    logger.info({ userId, leadId }, '[EnrichmentOrchestrator] Starting deep enrichment');

    // 1. Fetch the lead
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
    if (!lead) {
      return { success: false, iterations: 0, totalHandlesProcessed: 0, aggregatedData: emptyAggregation(), iterationLog: [], error: 'Lead not found' };
    }

    // Check ownership
    if (lead.userId !== userId) {
      return { success: false, iterations: 0, totalHandlesProcessed: 0, aggregatedData: emptyAggregation(), iterationLog: [], error: 'Unauthorized' };
    }

    // 2. Build initial handle queue from the lead's existing data
    const handleQueue: EnrichmentHandle[] = buildInitialHandles(lead);

    if (handleQueue.length === 0) {
      logger.warn({ leadId }, '[EnrichmentOrchestrator] No handles/URLs found on lead to enrich');
      return { success: false, iterations: 0, totalHandlesProcessed: 0, aggregatedData: emptyAggregation(), iterationLog: [], error: 'No social handles, URLs, or identifiers found on this lead to enrich from' };
    }

    // 4. Track processed handles to avoid re-scraping
    const processedHandles = new Set<string>();
    const allResults: EnrichmentIterationResult[] = [];
    const iterationLog: EnrichmentResult['iterationLog'] = [];
    let iteration = 0;
    let stepCounter = 0;
    let successfulSources = 0;
    let failedSources = 0;

    try {
    // Provider initialization happens after the run is persisted so missing
    // credentials or provider outages produce a visible failed activity record.
    let apifyService: ApifyService;
    try {
      apifyService = await ApifyService.createWithAdminCredentials();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Enrichment provider unavailable';
      if (enrichmentRunId) {
        await updateEnrichmentRun(enrichmentRunId, { status: 'failed', completedAt: new Date(), errorMessage: message });
      }
      await eventBus.emitToolEvent('failed', {
        userId,
        threadId,
        toolName: 'deep_enrichment',
        executionId: `enrich-${leadId}`,
        data: { runId: enrichmentRunId, error: message },
      });
      return { success: false, iterations: 0, totalHandlesProcessed: 0, aggregatedData: emptyAggregation(), iterationLog: [], error: message };
    }

    // Emit start event
    await eventBus.emitToolEvent('started', { userId, threadId, toolName: 'deep_enrichment', executionId: `enrich-${leadId}`, data: { runId: enrichmentRunId } });

    // 5. The enrichment loop
    //
    // Phase 5.7 / PERF-004 (DEFERRED): the loop is still strictly sequential.
    // A parallel batch refactor (Promise.all over up to PARALLEL_PLATFORMS
    // handles) was started but requires non-trivial shared-state
    // synchronization (processedHandles, stepCounter, allResults, handleQueue).
    // The estimate is 1.5d for a correct implementation. Tracking in
    // IMPLEMENTATION_PLAN.md as debt.
    while (iteration < LeadEnrichmentOrchestrator.MAX_ITERATIONS && handleQueue.length > 0) {
      iteration++;
      const handle = handleQueue.shift()!;
      // Normalize website identifiers to prevent trailing-slash duplicates
      const normalizedHandleId = handle.platform === 'website'
        ? handle.identifier.replace(/\/$/, '').toLowerCase()
        : handle.identifier.toLowerCase();
      const handleKey = `${handle.platform}:${handle.subType || 'primary'}:${normalizedHandleId}`;

      if (processedHandles.has(handleKey)) {
        logger.info({ iteration, handleKey }, '[EnrichmentOrchestrator] Skipping already processed handle');
        continue;
      }
      processedHandles.add(handleKey);

      const iterStart = Date.now();
      logger.info({ iteration, platform: handle.platform, identifier: handle.identifier, source: handle.source }, '[EnrichmentOrchestrator] Processing handle');

      // Emit progress
      await eventBus.emitToolEvent('progress', {
        userId, threadId,
        toolName: 'deep_enrichment',
        executionId: `enrich-${leadId}`,
        data: { runId: enrichmentRunId, iteration, platform: handle.platform, identifier: handle.identifier, total: handleQueue.length + processedHandles.size },
      });

      try {
        // Select the correct actor config: secondary if subType is set, otherwise primary
        const actorConfig: ActorConfig = handle.subType
          ? SECONDARY_ACTORS[`${handle.platform}:${handle.subType}`]
          : PLATFORM_ACTORS[handle.platform];

        if (!actorConfig) {
          logger.warn({ platform: handle.platform, subType: handle.subType }, '[EnrichmentOrchestrator] No actor config found');
          iterationLog.push({ iteration, platform: handle.platform, identifier: handle.identifier, newHandlesFound: 0, duration: Date.now() - iterStart });
          continue;
        }

        const input = actorConfig.buildInput(handle.identifier);

        // Log step: actor run starting
        stepCounter++;
        let stepId: number | null = null;
        if (enrichmentRunId) {
          try {
            const stepActorId = handle.platform === 'website' ? 'internal/website-crawler' : actorConfig.actorId;
            const step = await createEnrichmentStep({
              runId: enrichmentRunId,
              stepNumber: stepCounter,
              stepType: 'actor_run',
              platform: handle.platform,
              actorId: stepActorId,
              subType: handle.subType || 'primary',
              identifier: handle.identifier,
              input: { actorId: stepActorId, inputKeys: Object.keys(input) },
            });
            stepId = step.id;
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (e) { /* non-blocking */ }
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let result: { success: boolean; items?: any[]; combinedContent?: string; socialLinksFromHtml?: Record<string, string>; error?: string; runId?: string; datasetId?: string; status?: string };
        if (!attempt.providerAttempted) await updateEnrichmentRun(enrichmentRunId, { providerDispatchStartedAt: new Date() });
        attempt.providerAttempted = true;
        if (handle.platform === 'website') {
          const url = handle.identifier.startsWith('http') ? handle.identifier : `https://${handle.identifier}`;

          // Special handler: Play Store developer pages — extract developer info + app support pages
          if (url.includes('play.google.com/store/apps/dev')) {
            try {
              const { extractPlayStoreDeveloperInfo } = await import('./helpers.js');
              const devInfo = await extractPlayStoreDeveloperInfo(url);
              result = {
                success: true,
                items: [devInfo],
                combinedContent: JSON.stringify(devInfo),
              };
              // Directly merge extracted info so new websites get queued
              const extracted = actorConfig.extractFromResult([]);
              Object.assign(extracted, {
                emails: devInfo.emails,
                phones: devInfo.phones,
                websites: devInfo.websites,
                person: devInfo.person,
              });
              // Store as iteration result (will be aggregated later)
              allResults.push({
                platform: handle.platform,
                identifier: handle.identifier,
                rawData: [devInfo],
                extractedInfo: normalizeExtractedInfo(extracted),
              });
              successfulSources++;
              // Discover new handles from Play Store extracted data (e.g., developer website)
              const extractedCompany2 = extracted.company || {};
              const newHandles = discoverNewHandles(extracted, handle.platform, processedHandles, {
                // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
                companyDomain: lead.companyDomain || extractedCompany2.domain || extractedCompany2.website || undefined,
                companyName: lead.companyName || extractedCompany2.name || undefined,
              });
              for (const h of newHandles) handleQueue.push(h);
              iterationLog.push({ iteration, platform: handle.platform, identifier: handle.identifier, newHandlesFound: newHandles.length, duration: Date.now() - iterStart });
              continue;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (psErr: any) {
              logger.warn({ err: psErr.message, url }, '[EnrichmentOrchestrator] Play Store extraction failed');
              result = { success: false, items: [], error: psErr.message };
            }
          } else {
            try {
              // Use LLM-guided deep crawl (like analyzeWebsite) for comprehensive extraction
              const crawlResult = await deepCrawlWebsite(url, userId);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const items = crawlResult.pages.filter((r: any) => r.success);
              result = {
                success: items.length > 0,
                items,
                combinedContent: crawlResult.combinedContent,
                socialLinksFromHtml: crawlResult.socialLinksFromHtml,
                error: items.length === 0 ? 'No pages crawled' : undefined,
              };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (crawlErr: any) {
              result = { success: false, items: [], error: crawlErr.message };
            }
          }
        } else {
          result = await apifyService.runActor({
            actorId: actorConfig.actorId,
            input,
            timeout: 120,
            memory: 2048,
            userId,
            threadId,
            purpose: `lead_enrichment_${handle.platform}`,
          });
        }

        const providerReceipt = { actorRunId: result.runId ?? null, datasetId: result.datasetId ?? null };
        if (!result.success && (!result.runId || !['FAILED', 'ABORTED', 'TIMED-OUT'].includes(result.status || ''))) attempt.uncertain = true;
        if (!result.success || !result.items?.length) {
          if (result.success) successfulSources++; else failedSources++;
          logger.warn({ iteration, platform: handle.platform, error: result.error }, '[EnrichmentOrchestrator] Actor returned no results');
          if (stepId) {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            try { await updateEnrichmentStep(stepId, { status: result.success ? 'completed' : 'failed', itemsCount: 0, durationMs: Date.now() - iterStart, errorMessage: result.success ? undefined : result.error || 'Source unavailable', output: { ...providerReceipt, message: result.error || 'No results' } }); } catch (e) { /* non-blocking */ }
          }
          iterationLog.push({ iteration, platform: handle.platform, identifier: handle.identifier, newHandlesFound: 0, duration: Date.now() - iterStart });
          continue;
        }

        // Update step with results
        if (stepId) {
          try {
            await updateEnrichmentStep(stepId, {
              status: 'completed',
              itemsCount: result.items.length,
              durationMs: Date.now() - iterStart,
              output: { ...providerReceipt, itemsCount: result.items.length, sampleKeys: result.items[0] ? Object.keys(result.items[0]).slice(0, 10) : [] },
            });
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (e) { /* non-blocking */ }
        }

        // Extract structured info from raw results (regex-based)
        let extractedInfo = actorConfig.extractFromResult(result.items);

        // For website platform, augment regex extraction with LLM parsing of the full combined content
        if (handle.platform === 'website' && result.combinedContent) {
          stepCounter++;
          let llmWebStepId: number | null = null;
          if (enrichmentRunId) {
            try {
              const llmWebStep = await createEnrichmentStep({
                runId: enrichmentRunId,
                stepNumber: stepCounter,
                stepType: 'llm_extraction',
                platform: 'website',
                identifier: handle.identifier,
                input: { purpose: 'website_content_extraction' },
              });
              llmWebStepId = llmWebStep.id;
            } catch { /* non-blocking */ }
          }
          try {
            const llmWebInfo = await llmExtractFromWebContent(userId, result.combinedContent);
            extractedInfo = mergeExtractedInfos(extractedInfo, llmWebInfo);
            if (llmWebStepId) {
              try {
                await updateEnrichmentStep(llmWebStepId, {
                  status: 'completed',
                  output: {
                    emailsFound: llmWebInfo.emails?.length || 0,
                    socialsFound: Object.keys(llmWebInfo.socialProfiles || {}).length,
                    fieldsExtracted: Object.values(llmWebInfo).filter(v => v && (Array.isArray(v) ? v.length > 0 : Object.keys(v as object).length > 0)).length,
                  },
                });
              } catch { /* non-blocking */ }
            }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (llmErr: any) {
            logger.warn({ err: llmErr.message, identifier: handle.identifier }, '[EnrichmentOrchestrator] LLM web content extraction failed, using regex only');
            if (llmWebStepId) {
              try { await updateEnrichmentStep(llmWebStepId, { status: 'failed', errorMessage: llmErr.message }); } catch { /* */ }
            }
          }

          // Merge social links extracted directly from HTML anchors (catches footer/header links LLM may miss)
          if (result.socialLinksFromHtml && Object.keys(result.socialLinksFromHtml).length > 0) {
            const htmlSocials: Partial<ExtractedInfo> = { socialProfiles: result.socialLinksFromHtml };
            extractedInfo = mergeExtractedInfos(extractedInfo, htmlSocials);
            logger.info({ htmlSocialsFound: Object.keys(result.socialLinksFromHtml) }, '[EnrichmentOrchestrator] Merged HTML-extracted social links');
          }

          // Store crawled content as embeddings for semantic search
          try {
            const { storeEnrichmentEmbeddings } = await import('./helpers.js');
            await storeEnrichmentEmbeddings(userId, leadId, result.combinedContent, handle.identifier);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } catch (embErr: any) {
            logger.warn({ err: embErr.message, leadId }, '[EnrichmentOrchestrator] Embedding storage failed (non-blocking)');
          }
        }

        allResults.push({
          isSubject: !handle.subType && handle.platform !== 'website' && ['lead_record', 'profile_url'].includes(handle.source),
          platform: handle.platform,
          identifier: handle.identifier,
          rawData: result.items,
          extractedInfo: normalizeExtractedInfo(extractedInfo),
        });
        successfulSources++;

        // Stage 2: Discover new handles from extracted data (with relevance filtering)
        // Use extracted company info as fallback context for handle relevance
        const extractedCompany = extractedInfo.company || {};
        // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
        const extractedDomain = extractedCompany.domain || extractedCompany.website || undefined;
        const extractedName = extractedCompany.name || undefined;
        const newHandles = discoverNewHandles(extractedInfo, handle.platform, processedHandles, {
          companyDomain: lead.companyDomain || extractedDomain,
          companyName: lead.companyName || extractedName,
        });

        // Stage 3: Queue secondary actors for deeper scraping
        let secondaryHandles: EnrichmentHandle[] = [];
        if (!handle.subType) {
          secondaryHandles = queueSecondaryActors(handle.platform, handle.identifier, extractedInfo, processedHandles);
        }

        logger.info({
          iteration,
          newHandlesFound: newHandles.length,
          secondaryActorsQueued: secondaryHandles.length,
          handles: newHandles.map(h => `${h.platform}:${h.identifier}`),
          secondary: secondaryHandles.map(h => `${h.platform}:${h.subType}:${h.identifier}`),
        }, '[EnrichmentOrchestrator] New handles and secondary actors discovered');

        handleQueue.push(...newHandles, ...secondaryHandles);

        // Log step: handle discovery
        if (enrichmentRunId && (newHandles.length > 0 || secondaryHandles.length > 0)) {
          stepCounter++;
          try {
            await createEnrichmentStep({
              runId: enrichmentRunId,
              stepNumber: stepCounter,
              stepType: 'handle_discovery',
              platform: handle.platform,
              identifier: handle.identifier,
              input: { newHandles: newHandles.map(h => `${h.platform}:${h.identifier}`), secondaryActors: secondaryHandles.map(h => `${h.platform}:${h.subType}:${h.identifier}`) },
            }).then(step => updateEnrichmentStep(step.id, {
              status: 'completed',
              itemsCount: newHandles.length + secondaryHandles.length,
              output: { newPlatformHandles: newHandles.length, secondaryActors: secondaryHandles.length },
            }));
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (e) { /* non-blocking */ }
        }

        iterationLog.push({
          iteration,
          platform: handle.platform,
          identifier: handle.identifier,
          newHandlesFound: newHandles.length + secondaryHandles.length,
          duration: Date.now() - iterStart,
        });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (err: any) {
        if (attempt.providerAttempted) attempt.uncertain = true;
        failedSources++;
        logger.error({ iteration, platform: handle.platform, err: err.message }, '[EnrichmentOrchestrator] Error during scraping');
        if (enrichmentRunId) {
          stepCounter++;
          try {
            const step = await createEnrichmentStep({
              runId: enrichmentRunId,
              stepNumber: stepCounter,
              stepType: 'actor_run',
              platform: handle.platform,
              identifier: handle.identifier,
            });
            await updateEnrichmentStep(step.id, { status: 'failed', durationMs: Date.now() - iterStart, errorMessage: err.message });
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          } catch (e) { /* non-blocking */ }
        }
        iterationLog.push({ iteration, platform: handle.platform, identifier: handle.identifier, newHandlesFound: 0, duration: Date.now() - iterStart });
      }
    }

    if (!successfulSources && failedSources) {
      const error = 'All enrichment sources failed. No enrichment results were obtained.';
      if (enrichmentRunId) await updateEnrichmentRun(enrichmentRunId, { status: 'failed', completedAt: new Date(), errorMessage: error });
      await eventBus.emitToolEvent('failed', { userId, threadId, toolName: 'deep_enrichment', executionId: `enrich-${leadId}`, data: { runId: enrichmentRunId, error } });
      return { success: false, iterations: iteration, totalHandlesProcessed: processedHandles.size, aggregatedData: emptyAggregation(), iterationLog, error };
    }

    // 6. Aggregate all results
    const aggregatedData = aggregateResults(allResults);

    // 6b. Semantic search over stored embeddings to fill gaps
    try {
      const { searchEnrichmentEmbeddings } = await import('./helpers.js');
      const gaps: string[] = [];
      if (aggregatedData.emails.length === 0) gaps.push('email address contact email');
      if (!aggregatedData.socialProfiles.linkedin) gaps.push('linkedin profile URL');
      if (!aggregatedData.socialProfiles.twitter) gaps.push('twitter handle X profile');
      if (!aggregatedData.socialProfiles.instagram) gaps.push('instagram handle profile');
      if (!aggregatedData.company?.name) gaps.push('company name organization');
      if (aggregatedData.phones.length === 0) gaps.push('phone number telephone');

      if (gaps.length > 0) {
        const query = `${lead.fullName || lead.firstName || ''} ${lead.companyName || ''} ${gaps.join(' ')}`;
        const relevantChunks = await searchEnrichmentEmbeddings(userId, leadId, query, 8);
        if (relevantChunks.length > 0) {
          const combinedChunks = relevantChunks.join('\n\n');
          const semanticInfo = await llmExtractFromWebContent(userId, combinedChunks);
          // Merge any newly found data
          const merged = mergeExtractedInfos(aggregatedData, semanticInfo);
          // Cross-source semantic matches are candidates, not subject identity.
          Object.assign(aggregatedData, { emails: merged.emails, phones: merged.phones, websites: merged.websites });
          logger.info({ leadId, chunksUsed: relevantChunks.length, gaps }, '[EnrichmentOrchestrator] Semantic search filled gaps');
        }
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (embSearchErr: any) {
      logger.warn({ err: embSearchErr.message, leadId }, '[EnrichmentOrchestrator] Semantic search enrichment failed (non-blocking)');
    }

    // 7. Use LLM to extract any additional structured fields
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let llmEnriched: Record<string, any> = {};
    try {
      stepCounter++;
      let llmStepId: number | null = null;
      if (enrichmentRunId) {
        try {
          const step = await createEnrichmentStep({
            runId: enrichmentRunId,
            stepNumber: stepCounter,
            stepType: 'llm_extraction',
            input: { purpose: 'extract_structured_fields' },
          });
          llmStepId = step.id;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (e) { /* non-blocking */ }
      }

      const llmStart = Date.now();
      llmEnriched = await this.llmExtractFields(userId, lead, aggregatedData);

      if (llmStepId) {
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        try { await updateEnrichmentStep(llmStepId, { status: 'completed', durationMs: Date.now() - llmStart, output: { fieldsExtracted: Object.keys(llmEnriched).length } }); } catch (e) { /* non-blocking */ }
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.warn({ leadId, err: err.message }, '[EnrichmentOrchestrator] LLM extraction failed, using raw data only');
    }

    // 8. Update the lead record
    await this.updateLeadWithEnrichment(leadId, aggregatedData, llmEnriched);

    // 9. Auto-score the lead after enrichment
    try {
      const { leadScoringService } = await import('../LeadScoringService.js');
      const { ICPGenerationService } = await import('../ICPGenerationService.js');
      const icpService = new ICPGenerationService();
      const icpProfile = lead.promptId
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ? await db.select().from(icpProfilesTable).where(eq(icpProfilesTable.id, lead.promptId)).then((r: any) => r[0] || null)
        : await icpService.getLatestICPForUser(userId);

      const [freshLead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
      if (freshLead) {
        const leadData = {
          id: freshLead.id,
          name: freshLead.name || freshLead.fullName || null,
          email: freshLead.email,
          company: freshLead.company || freshLead.companyName || null,
          role: freshLead.role || null,
          headline: freshLead.headline || null,
          industry: freshLead.industry || null,
          companySize: freshLead.companySize || null,
          location: freshLead.location || null,
          bio: freshLead.bio || null,
          skills: freshLead.skills || null,
          seniority: freshLead.seniority || null,
          website: freshLead.website || null,
          linkedin: freshLead.linkedin || null,
          source: freshLead.source || null,
        };
        const scoreResult = await leadScoringService.scoreLead(userId, leadData, icpProfile);
        const newScore = Math.min(100, Math.max(0, Math.round(scoreResult.score || 0)));
        await db.update(leadsTable).set({
          score: newScore,
          fitScore: newScore,
          aiConfidenceScore: 0.85,
          aiExtractedFields: {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ...(freshLead.aiExtractedFields as Record<string, any> || {}),
            llmScore: scoreResult.llmScore || null,
            scoreReasoning: scoreResult.llmScore?.reasoning || '',
            scoredAt: new Date().toISOString(),
            icpId: icpProfile?.id,
          },
          updatedAt: new Date(),
        }).where(eq(leadsTable.id, leadId));
        logger.info({ leadId, newScore }, '[EnrichmentOrchestrator] Auto-scored lead after enrichment');
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (scoreErr: any) {
      logger.warn({ leadId, err: scoreErr.message }, '[EnrichmentOrchestrator] Auto-scoring failed (non-blocking)');
    }

    // Log lead update step
    if (enrichmentRunId) {
      stepCounter++;
      try {
        const step = await createEnrichmentStep({
          runId: enrichmentRunId,
          stepNumber: stepCounter,
          stepType: 'lead_update',
          input: { leadId },
        });
        await updateEnrichmentStep(step.id, {
          status: 'completed',
          output: {
            emailsFound: aggregatedData.emails.length,
            phonesFound: aggregatedData.phones.length,
            websitesFound: aggregatedData.websites.length,
            socialProfiles: Object.keys(aggregatedData.socialProfiles).length,
          },
        });
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (e) { /* non-blocking */ }
    }

    // Store enrichment output
    try {
      await trackGeneratedOutput({
        userId,
        category: 'actor_output',
        fileName: `enrichment_lead_${leadId}_${Date.now()}.json`,
        content: JSON.stringify(aggregatedData, null, 2),
        mimeType: 'application/json',
        referenceType: 'enrichment_run',
        referenceId: enrichmentRunId?.toString(),
        metadata: {
          leadId,
          enrichmentRunId,
          iterations: iteration,
          handlesProcessed: processedHandles.size,
          emailsFound: aggregatedData.emails.length,
          phonesFound: aggregatedData.phones.length,
        },
      });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.warn({ err: err.message, leadId }, '[EnrichmentOrchestrator] Failed to store enrichment output (non-blocking)');
    }

    // Complete the enrichment run record
    if (enrichmentRunId) {
      try {
        // Only include social profiles that were actually scraped (in processedHandles)
        const scrapedProfiles: Record<string, string> = {};
        for (const [platform, url] of Object.entries(aggregatedData.socialProfiles)) {
          const handle = (url || '').replace(/^https?:\/\/[^/]+\//, '').replace(/\/+$/, '').replace(/^@/, '');
          const wasScraped = [...processedHandles].some(h =>
            h.toLowerCase().includes(`${platform}:`) && h.toLowerCase().includes(handle.toLowerCase())
          );
          if (wasScraped) scrapedProfiles[platform] = url;
        }

        await updateEnrichmentRun(enrichmentRunId, {
          status: 'completed',
          completedAt: new Date(),
          totalHandlesProcessed: processedHandles.size,
          totalIterations: iteration,
          emailsFound: aggregatedData.emails.length,
          phonesFound: aggregatedData.phones.length,
          websitesFound: aggregatedData.websites.length,
          summary: {
            identityScoped: true,
            failedSources,
            socialProfiles: scrapedProfiles,
            company: aggregatedData.company,
            person: aggregatedData.person,
            socialStats: aggregatedData.socialStats,
            emails: aggregatedData.emails,
            phones: aggregatedData.phones,
            websites: aggregatedData.websites,
          },
        });
      } catch (error) {
        logger.error({ error, enrichmentRunId }, '[EnrichmentOrchestrator] Could not persist completion');
        const message = 'Enrichment finished, but its results could not be saved. Please refresh before retrying.';
        await eventBus.emitToolEvent('failed', { userId, threadId, toolName: 'deep_enrichment', executionId: `enrich-${leadId}`, data: { runId: enrichmentRunId, error: message } });
        return { success: false, iterations: iteration, totalHandlesProcessed: processedHandles.size, aggregatedData, iterationLog, error: message };
      }
    }

    await eventBus.emitToolEvent('completed', {
      userId, threadId, toolName: 'deep_enrichment', executionId: `enrich-${leadId}`,
      data: { runId: enrichmentRunId, iterations: iteration, totalHandles: processedHandles.size, emails: aggregatedData.emails.length },
    }).catch(error => logger.warn({ error, enrichmentRunId }, '[EnrichmentOrchestrator] Saved completion event could not be published'));

    const totalDuration = Date.now() - startTime;
    logger.info({ leadId, iterations: iteration, handles: processedHandles.size, duration: totalDuration }, '[EnrichmentOrchestrator] Deep enrichment completed');

    return {
      success: true,
      iterations: iteration,
      totalHandlesProcessed: processedHandles.size,
      aggregatedData,
      iterationLog,
    };
    } catch (error) {
      logger.error({ error, enrichmentRunId, leadId }, '[EnrichmentOrchestrator] Enrichment interrupted');
      const message = 'Enrichment could not finish. Refresh its status before retrying.';
      if (enrichmentRunId) {
        try { await updateEnrichmentRun(enrichmentRunId, { status: 'failed', completedAt: new Date(), errorMessage: message }); }
        catch (saveError) { logger.error({ saveError, enrichmentRunId }, '[EnrichmentOrchestrator] Could not save failed status'); }
      }
      await eventBus.emitToolEvent('failed', { userId, threadId, toolName: 'deep_enrichment', executionId: `enrich-${leadId}`, data: { runId: enrichmentRunId, error: message } });
      return { success: false, iterations: iteration, totalHandlesProcessed: processedHandles.size, aggregatedData: emptyAggregation(), iterationLog, error: message };
    }
  }

  /**
   * Use LLM to extract structured fields from aggregated raw data.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async llmExtractFields(userId: number, lead: any, aggregated: AggregatedEnrichmentData): Promise<Record<string, any>> {
    // Early exit if no meaningful data to extract from
    const hasData = aggregated.emails.length > 0 || aggregated.phones.length > 0 ||
      aggregated.websites.length > 0 || Object.keys(aggregated.socialProfiles).length > 0 ||
      Object.keys(aggregated.company).length > 0 || Object.keys(aggregated.person).length > 0;
    if (!hasData) return {};

    const provider = await LLMProviderFactory.createProviderForUser(userId);

    const dataSnippet = JSON.stringify({
      emails: aggregated.emails,
      phones: aggregated.phones,
      websites: aggregated.websites,
      socialProfiles: aggregated.socialProfiles,
      company: aggregated.company,
      person: aggregated.person,
    }, null, 2).slice(0, 3000);

    const systemPrompt = `You are a data extraction assistant. Given enrichment data scraped from multiple platforms for a lead, extract and normalize the most accurate structured information.

Return a JSON object with these fields (omit any field you cannot determine):
{
  "email": "best primary email",
  "phone": "best phone number",
  "website": "personal or company website",
  "companyName": "company name",
  "companyDomain": "company website domain",
  "industry": "industry category",
  "companySize": "employee count range",
  "companyDescription": "brief company description",
  "jobTitle": "current job title",
  "headline": "professional headline",
  "location": "city, state/country",
  "linkedin": "LinkedIn profile URL (ONLY if it clearly belongs to the person/company, NOT links shared in posts)",
  "twitter": "Twitter handle or URL (ONLY if it clearly belongs to the person/company, NOT links shared in posts)",
  "instagram": "Instagram handle (ONLY if it clearly belongs to the person/company, NOT links shared in posts)",
  "facebook": "Facebook page URL (ONLY if it clearly belongs to the person/company, NOT links shared in posts)",
  "bio": "professional bio/summary"
}

IMPORTANT: Only extract social media profiles that clearly belong to the person or company being enriched.
DO NOT extract social media links that appear in post captions, descriptions, or comments - those are links the user shared, not their own profiles.
For example, if an Instagram post contains a YouTube link, that is NOT the user's YouTube channel.
Only extract profiles from the person's bio, about section, or website footer/header.

The lead's existing data:
Name: ${lead.fullName || lead.name || 'Unknown'}
Email: ${lead.email || 'Unknown'}
Company: ${lead.company || lead.companyName || 'Unknown'}`;

    const response = await provider.createChatCompletion({
      model: provider.defaultModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Enrichment data:\n${dataSnippet}` },
      ],
      temperature: 0.1,
      max_tokens: 800,
      loggingContext: { userId, purpose: 'lead_enrichment_extraction', service: 'LeadEnrichmentOrchestrator' },
    });

    if (!response.success || !response.content) return {};

    try {
      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) return JSON.parse(jsonMatch[0]);
    } catch {
      logger.warn('[EnrichmentOrchestrator] Failed to parse LLM response as JSON');
    }

    return {};
  }

  /**
   * Update lead record with all enriched data.
   */
  private async updateLeadWithEnrichment(
    leadId: number,
    aggregated: AggregatedEnrichmentData,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    llmFields: Record<string, any>
  ): Promise<void> {
    // Fetch existing lead to avoid overwriting existing data
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, leadId)).limit(1);
    if (!lead) return;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = { updatedAt: new Date() };

    // Contact info — only set if lead doesn't already have it
    // Scraped/LLM candidates have no ownership verification. Keep them in
    // enrichedData for review, never promote them to outreach contact columns.

    // Person info
    if (aggregated.person.title && !lead.role) updates.role = aggregated.person.title;
    if (aggregated.person.headline && !lead.headline) updates.headline = aggregated.person.headline;
    if (aggregated.person.bio && !lead.bio) updates.bio = aggregated.person.bio;
    if (aggregated.person.location && !lead.location) updates.location = { city: aggregated.person.location };

    // Company info
    if (llmFields.companyName && !lead.companyName) updates.companyName = llmFields.companyName;
    if (llmFields.companyDomain && !isBlockedWebsiteUrl(llmFields.companyDomain) && !lead.companyDomain) updates.companyDomain = llmFields.companyDomain;
    if (llmFields.industry && !lead.industry) updates.industry = llmFields.industry;
    if (llmFields.companySize && !lead.companySize) updates.companySize = llmFields.companySize;
    if (llmFields.companyDescription && !lead.companyDescription) updates.companyDescription = llmFields.companyDescription;

    // Social profiles — validate and only set if lead doesn't already have it
    // Validation: ensure each social value matches its expected platform and is normalized
    const validateSocialValue = (platform: string, value: string | undefined): string | undefined => {
      if (!value) return undefined;
      const v = value.trim();
      if (!v) return undefined;
      
      const normalized = normalizeSocialProfile(platform, v);
      if (!normalized) return undefined;

      // Reject if it looks like an email
      if (normalized.includes('@') && normalized.includes('.') && !normalized.startsWith('http')) return undefined;
      // Reject if it's a non-social domain (e.g., google maps, generic sites)
      const INVALID_SOCIAL_PATTERNS = [
        'maps.google', 'google.com/maps', 'goo.gl/maps',
        'google.com', 'bing.com', 'yahoo.com', 'outlook.com',
        'gmail.com', 'hotmail.com', 'protonmail.com',
        'sentry.io', 'cloudflare.com', 'amazonaws',
        'play.google.com', 'apps.apple.com',
      ];
      if (INVALID_SOCIAL_PATTERNS.some(p => normalized.toLowerCase().includes(p))) return undefined;
      
      return normalized;
    };

    if (llmFields.linkedin || aggregated.socialProfiles.linkedin) {
      const val = validateSocialValue('linkedin', aggregated.socialProfiles.linkedin);
      if (val) {
        if (!lead.linkedin) updates.linkedin = val;
        if (!lead.linkedinUrl) updates.linkedinUrl = val;
      }
    }
    if (llmFields.twitter || aggregated.socialProfiles.twitter) {
      const val = validateSocialValue('twitter', aggregated.socialProfiles.twitter);
      if (val) {
        if (!lead.twitter) updates.twitter = val;
        if (!lead.twitterUrl) updates.twitterUrl = val;
      }
    }
    if (llmFields.instagram || aggregated.socialProfiles.instagram) {
      const val = validateSocialValue('instagram', aggregated.socialProfiles.instagram);
      if (val) {
        if (!lead.instagram) updates.instagram = val;
        if (!lead.instagramUrl) updates.instagramUrl = val;
      }
    }
    if (llmFields.facebook || aggregated.socialProfiles.facebook) {
      const val = validateSocialValue('facebook', aggregated.socialProfiles.facebook);
      if (val) {
        if (!lead.facebook) updates.facebook = val;
        if (!lead.facebookUrl) updates.facebookUrl = val;
      }
    }
    const validGithub = validateSocialValue('github', aggregated.socialProfiles.github);
    if (validGithub && !lead.github) updates.github = validGithub;
    const validYoutube = validateSocialValue('youtube', aggregated.socialProfiles.youtube);
    if (validYoutube) {
      if (!lead.youtube) updates.youtube = validYoutube;
      if (!lead.youtubeUrl) updates.youtubeUrl = validYoutube;
    }

    // Social stats → individual lead columns
    if (aggregated.socialStats) {
      if (aggregated.socialStats.followersCount != null && !lead.followersCount) updates.followersCount = aggregated.socialStats.followersCount;
      if (aggregated.socialStats.followingCount != null && !lead.followingCount) updates.followingCount = aggregated.socialStats.followingCount;
      if (aggregated.socialStats.postsCount != null && !lead.postsCount) updates.postsCount = aggregated.socialStats.postsCount;
    }

    // Sanitize social profiles and websites before saving
    const sanitizedSocialProfiles = sanitizeSocialProfiles(aggregated.socialProfiles);
    const sanitizedWebsites = aggregated.websites.filter(w => !isBlockedWebsiteUrl(w));

    // Store full enrichment data (always overwrite with latest)
    updates.enrichedData = {
      deepEnrichment: true,
      enrichedAt: new Date().toISOString(),
      emails: aggregated.emails,
      phones: aggregated.phones,
      websites: sanitizedWebsites,
      socialProfiles: sanitizedSocialProfiles,
      company: aggregated.company,
      person: aggregated.person,
      socialStats: aggregated.socialStats,
      llmExtracted: llmFields,
    };

    updates.rawScrapeData = aggregated.rawScrapedData;
    updates.aiExtractedFields = llmFields;

    const { crmService, lockCrmContactResolution } = await import('../CRMService.js');
    await db.transaction(async (tx: any) => {
      await lockCrmContactResolution(tx, lead.userId);
      await tx.update(leadsTable).set(updates).where(eq(leadsTable.id, leadId));
      if (updates.phone !== undefined || updates.email !== undefined) await crmService.syncLeadContact(lead.userId, leadId, {
        ...(updates.phone !== undefined ? { phone: updates.phone } : {}),
        ...(updates.email !== undefined ? { email: updates.email } : {}),
      }, tx);
    });

    logger.info({ leadId, fieldsUpdated: Object.keys(updates).length }, '[EnrichmentOrchestrator] Lead updated with enrichment data');
  }
}

// ─── Singleton Export ─────────────────────────────────────────────────────────────

export const leadEnrichmentOrchestrator = new LeadEnrichmentOrchestrator();
