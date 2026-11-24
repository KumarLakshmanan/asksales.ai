// ─── Lead Enrichment — Standalone Handle Enrichment ──────────────────────────────

import { ApifyService } from '../agents/ApifyService.js';
import { logger } from '../../utils/logger.js';
import { eventBus } from '../../events/EventBus.js';
import { updateEnrichmentRun } from '../../models/enrichmentRuns/functions.js';
import { createEnrichmentStep, updateEnrichmentStep } from '../../models/enrichmentSteps/functions.js';
import { LeadModel } from '../../models/leads/functions.js';
import { WebsiteCrawlerService } from '../WebsiteCrawlerService.js';
import { reserveHandleEnrichment, markHandleProviderDispatch, finishHandleReservation } from './billing.js';

import type { EnrichmentHandle, EnrichmentIterationResult, EnrichmentPlatform } from './types.js';
import { PLATFORM_ACTORS, SECONDARY_ACTORS, queueSecondaryActors, type ActorConfig } from './platformActors.js';
import {
  mergeExtractedInfos,
  llmExtractFromWebContent,
  discoverNewHandles,
  normalizeExtractedInfo,
  aggregateResults,
} from './helpers.js';

const MAX_ITERATIONS = 15;

// ─── enrichByHandle ───────────────────────────────────────────────────────────────

/**
 * Run enrichment starting from a single handle (platform + identifier)
 * without requiring an existing lead record. Creates an enrichment run
 * to track progress and stores results. Runs in the background (fire-and-forget).
 */
export async function enrichByHandle(
  userId: number,
  platform: EnrichmentPlatform,
  identifier: string,
  options?: { requestKey?: string },
): Promise<{ runId: number; replayed: boolean; status: string }> {
  const handle: EnrichmentHandle = { platform, identifier, source: 'manual_input' };

  // Validate platform has an actor
  if (!PLATFORM_ACTORS[platform]) {
    throw new Error(`Unsupported platform: ${platform}`);
  }

  // The stub, durable request receipt and configured fixed fee commit together.
  // Replays reopen the same receipt and never dispatch another provider call.
  const reservation = await reserveHandleEnrichment(userId, platform, identifier, options?.requestKey);
  const run = reservation.run;
  if (!reservation.created) return { runId: run.id, replayed: true, status: run.status };
  const leadId = run.leadId ?? undefined;

  // Fire-and-forget the orchestration in the background
  (async () => {
    const processedHandles = new Set<string>();
    const allResults: EnrichmentIterationResult[] = [];
    const handleQueue: EnrichmentHandle[] = [handle];
    let iteration = 0;
    let stepCounter = 0;
    let successfulSources = 0;
    let failedSources = 0;
    let providerAttempted = false;
    let uncertainProviderOutcome = false;
    let billingFinalized = false;

    try {
      const apifyService = await ApifyService.createWithAdminCredentials();
      await eventBus.emitToolEvent('started', {
        userId,
        toolName: 'handle_enrichment',
        executionId: `enrich-handle-${run.id}`,
        data: { runId: run.id, platform, identifier },
      });

      while (iteration < MAX_ITERATIONS && handleQueue.length > 0) {
        iteration++;
        const h = handleQueue.shift()!;
        const normalizedHId = h.platform === 'website'
          ? h.identifier.replace(/\/$/, '').toLowerCase()
          : h.identifier.toLowerCase();
        const key = `${h.platform}:${h.subType || 'primary'}:${normalizedHId}`;
        if (processedHandles.has(key)) continue;
        processedHandles.add(key);

        await eventBus.emitToolEvent('progress', {
          userId,
          toolName: 'handle_enrichment',
          executionId: `enrich-handle-${run.id}`,
          data: { runId: run.id, iteration, platform: h.platform, identifier: h.identifier, total: handleQueue.length + processedHandles.size },
        });

        const iterStart = Date.now();
        const actorConfig: ActorConfig = h.subType
          ? SECONDARY_ACTORS[`${h.platform}:${h.subType}`]
          : PLATFORM_ACTORS[h.platform];
        if (!actorConfig) continue;

        stepCounter++;
        let stepId: number | null = null;
        try {
          const stepActorId = h.platform === 'website' ? 'internal/website-crawler' : actorConfig.actorId;
          const step = await createEnrichmentStep({
            runId: run.id,
            stepNumber: stepCounter,
            stepType: 'actor_run',
            platform: h.platform,
            actorId: stepActorId,
            subType: h.subType || 'primary',
            identifier: h.identifier,
            input: { actorId: stepActorId },
          });
          stepId = step.id;
        } catch { /* non-blocking */ }

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let result: { success: boolean; items?: any[]; combinedContent?: string; error?: string; runId?: string; datasetId?: string; status?: string };
          if (!providerAttempted) await markHandleProviderDispatch(reservation);
          providerAttempted = true;
          if (h.platform === 'website') {
            const url = h.identifier.startsWith('http') ? h.identifier : `https://${h.identifier}`;
            try {
              const crawler = new WebsiteCrawlerService({ maxPages: 5 });
              const crawlResult = await crawler.crawl(url);
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const items = crawlResult.pages.filter((r: any) => r.success);
              result = {
                success: items.length > 0,
                items,
                combinedContent: crawlResult.combinedContent,
                error: items.length === 0 ? 'No pages crawled' : undefined,
              };
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (crawlErr: any) {
              result = { success: false, items: [], error: crawlErr.message };
            }
          } else {
            result = await apifyService.runActor({
              actorId: actorConfig.actorId,
              input: actorConfig.buildInput(h.identifier),
              timeout: 120,
              memory: 2048,
              userId,
              purpose: `handle_enrichment_${h.platform}`,
            });
          }

          const providerReceipt = { actorRunId: result.runId ?? null, datasetId: result.datasetId ?? null };
          if (!result.success && (!result.runId || !['FAILED', 'ABORTED', 'TIMED-OUT'].includes(result.status || ''))) uncertainProviderOutcome = true;
          if (!result.success || !result.items?.length) {
            if (result.success) successfulSources++; else failedSources++;
            if (stepId) try { await updateEnrichmentStep(stepId, { status: result.success ? 'completed' : 'failed', itemsCount: 0, durationMs: Date.now() - iterStart, errorMessage: result.success ? undefined : result.error || 'Source unavailable', output: { ...providerReceipt, message: result.error || 'No results' } }); } catch { /* */ }
            continue;
          }

          if (stepId) try { await updateEnrichmentStep(stepId, { status: 'completed', itemsCount: result.items.length, durationMs: Date.now() - iterStart, output: { ...providerReceipt, itemsCount: result.items.length } }); } catch { /* */ }

          let extracted = actorConfig.extractFromResult(result.items);

          // For website platform, augment with LLM extraction
          if (h.platform === 'website' && result.combinedContent) {
            try {
              const llmWebInfo = await llmExtractFromWebContent(userId, result.combinedContent);
              extracted = mergeExtractedInfos(extracted, llmWebInfo);
              stepCounter++;
              try {
                const llmWebStep = await createEnrichmentStep({
                  runId: run.id,
                  stepNumber: stepCounter,
                  stepType: 'llm_extraction',
                  platform: 'website',
                  identifier: h.identifier,
                  input: { purpose: 'website_content_extraction' },
                });
                await updateEnrichmentStep(llmWebStep.id, {
                  status: 'completed',
                  output: {
                    emailsFound: llmWebInfo.emails?.length || 0,
                    socialsFound: Object.keys(llmWebInfo.socialProfiles || {}).length,
                  },
                });
              } catch { /* non-blocking */ }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } catch (llmErr: any) {
              logger.warn({ err: llmErr.message, identifier: h.identifier }, '[enrichByHandle] LLM web content extraction failed, using regex only');
            }
          }

          allResults.push({ isSubject: h.source === 'manual_input', platform: h.platform, identifier: h.identifier, rawData: result.items, extractedInfo: normalizeExtractedInfo(extracted) });
          successfulSources++;

          const extractedCompany = extracted.company || {};
          // @ts-expect-error -- Intentional compatibility boundary; runtime behavior is validated separately.
          const extractedDomain = extractedCompany.domain || extractedCompany.website || undefined;
          const extractedName = extractedCompany.name || undefined;
          const newHandles = discoverNewHandles(extracted, h.platform, processedHandles, {
            companyDomain: extractedDomain,
            companyName: extractedName,
          });
          let secondaryHandles: EnrichmentHandle[] = [];
          if (!h.subType) secondaryHandles = queueSecondaryActors(h.platform, h.identifier, extracted, processedHandles);
          handleQueue.push(...newHandles, ...secondaryHandles);

          if (newHandles.length > 0 || secondaryHandles.length > 0) {
            stepCounter++;
            try {
              const disc = await createEnrichmentStep({ runId: run.id, stepNumber: stepCounter, stepType: 'handle_discovery', platform: h.platform, identifier: h.identifier, input: { newHandles: newHandles.map(nh => `${nh.platform}:${nh.identifier}`), secondaryActors: secondaryHandles.map(sh => `${sh.platform}:${sh.subType}:${sh.identifier}`) } });
              await updateEnrichmentStep(disc.id, { status: 'completed', itemsCount: newHandles.length + secondaryHandles.length, output: { newPlatformHandles: newHandles.length, secondaryActors: secondaryHandles.length } });
            } catch { /* */ }
          }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (err: any) {
          if (providerAttempted) uncertainProviderOutcome = true;
          failedSources++;
          if (stepId) try { await updateEnrichmentStep(stepId, { status: 'failed', durationMs: Date.now() - iterStart, errorMessage: err.message }); } catch { /* */ }
        }
      }

      if (!successfulSources && failedSources) throw new Error('All enrichment sources failed. No enrichment results were obtained.');
      const aggregated = aggregateResults(allResults);

      // ── Compute lead score (outreach strength 0–100) ──────────────────────────
      const leadScore = computeLeadScore(aggregated);

      await finishHandleReservation(userId, reservation, 'completed');
      billingFinalized = true;
      await updateEnrichmentRun(run.id, {
        status: 'completed',
        completedAt: new Date(),
        totalHandlesProcessed: processedHandles.size,
        totalIterations: iteration,
        emailsFound: aggregated.emails.length,
        phonesFound: aggregated.phones.length,
        websitesFound: aggregated.websites.length,
        summary: {
          identityScoped: true,
          failedSources,
          socialProfiles: aggregated.socialProfiles,
          company: aggregated.company,
          person: aggregated.person,
          socialStats: aggregated.socialStats,
          emails: aggregated.emails,
          phones: aggregated.phones,
          websites: aggregated.websites,
          leadScore,
        },
      });

      // Announce completion only after readers can retrieve the saved summary.
      await eventBus.emitToolEvent('completed', {
        userId, toolName: 'handle_enrichment', executionId: `enrich-handle-${run.id}`,
        data: { runId: run.id, iterations: iteration, totalHandles: processedHandles.size, emails: aggregated.emails.length },
      });

      // Update the linked lead with enriched data + score
      if (leadId) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const leadUpdate: Record<string, any> = { leadScore };
          // Keep unverified contact candidates in the run summary for review;
          // employer/footer contacts must not become personal outreach fields.
          if (aggregated.person?.fullName) {
            leadUpdate.fullName = aggregated.person.fullName;
            leadUpdate.name = aggregated.person.fullName;
            const parts = aggregated.person.fullName.trim().split(/\s+/);
            if (parts.length >= 2) { leadUpdate.firstName = parts[0]; leadUpdate.lastName = parts.slice(1).join(' '); }
          }
          if (aggregated.person?.title) { leadUpdate.role = aggregated.person.title; }
          if (aggregated.person?.location) { leadUpdate.location = aggregated.person.location; }
          if (aggregated.person?.bio) { leadUpdate.bio = aggregated.person.bio; }
          if (aggregated.company?.name) { leadUpdate.company = aggregated.company.name; }
          if (aggregated.company?.domain) { leadUpdate.companyDomain = aggregated.company.domain; }
          if (aggregated.socialProfiles?.linkedin) { leadUpdate.linkedinUrl = aggregated.socialProfiles.linkedin; }
          if (aggregated.socialProfiles?.twitter) { leadUpdate.twitterHandle = aggregated.socialProfiles.twitter; }
          if (aggregated.socialProfiles?.instagram) { leadUpdate.instagramHandle = aggregated.socialProfiles.instagram; }
          if (aggregated.socialProfiles?.facebook) { leadUpdate.facebookUrl = aggregated.socialProfiles.facebook; }
          await LeadModel.update(leadId, leadUpdate);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          logger.warn({ err: e.message, leadId }, '[enrichByHandle] Failed to update lead with enrichment data (non-blocking)');
        }
      }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (err: any) {
      logger.error({ err: err.message, runId: run.id }, '[enrichByHandle] Failed');
      if (!billingFinalized) {
        try {
          await finishHandleReservation(userId, reservation, !providerAttempted ? 'not_dispatched' : uncertainProviderOutcome || successfulSources > 0 ? 'uncertain' : 'definitive_failure');
        } catch (settlementError) { logger.error({ settlementError, runId: run.id }, '[enrichByHandle] Credit settlement needs review'); }
      }
      try { await updateEnrichmentRun(run.id, { status: 'failed', completedAt: new Date(), errorMessage: err.message }); }
      catch (saveError) { logger.error({ saveError, runId: run.id }, '[enrichByHandle] Could not save failed status'); }
      await eventBus.emitToolEvent('failed', {
        userId,
        toolName: 'handle_enrichment',
        executionId: `enrich-handle-${run.id}`,
        data: { runId: run.id, error: err.message },
      });
    }
  })().catch(error => logger.error({ error, runId: run.id }, '[enrichByHandle] Could not publish terminal activity'));

  return { runId: run.id, replayed: false, status: 'pending' };
}

// ─── Lead Score Computation ───────────────────────────────────────────────────────
/**
 * Compute an outreach-strength score (0–100) based on how much enriched data was found.
 * Higher = more contact channels available = stronger outreach potential.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function computeLeadScore(aggregated: { emails: string[]; phones: string[]; websites: string[]; socialProfiles: Record<string, string | undefined>; person?: Record<string, any>; company?: Record<string, any> }): number {
  let score = 0;

  // Contact channels (most important for outreach)
  if (aggregated.emails.length > 0) score += 30;          // Email is the primary channel
  if (aggregated.emails.length > 1) score += 5;           // Extra emails = more options
  if (aggregated.phones.length > 0) score += 20;          // Phone = high-touch channel
  if (aggregated.phones.length > 1) score += 5;

  // Social profiles (each working channel adds reach)
  const socials = Object.values(aggregated.socialProfiles || {}).filter(Boolean);
  score += Math.min(socials.length * 6, 24);              // Up to 4 social profiles = 24pts

  // Website (validates legitimacy and enables web outreach)
  if (aggregated.websites.length > 0) score += 8;

  // Persona richness (well-known person = easier to personalise outreach)
  const person = aggregated.person || {};
  if (person.fullName) score += 3;
  if (person.title || person.headline) score += 2;
  if (person.bio) score += 2;
  if (person.location) score += 1;

  // Company info
  const company = aggregated.company || {};
  if (company.name) score += 3;
  if (company.industry) score += 2;

  return Math.min(Math.round(score), 100);
}
