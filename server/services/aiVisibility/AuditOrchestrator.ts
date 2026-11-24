import { auditCompetitors, discoverAuditCompetitors } from './CompetitorDiscoveryService.js';
import { companySettings } from '../../models/companySettings/schema.js';
import { reconcileRecommendations } from './RecommendationWorkflow.js';
import { isFirstPartyCitation, isProviderAvailabilityFailure } from './measurement.js';
import { platformAIQuotaMessage } from '../../../shared/assistantModelCatalog.js';
import { classifyLLMProviderFailure } from '../agents/LLMProviderErrors.js';
import { createHash } from 'node:crypto';
import { lte, and, asc, desc, eq, gte, inArray, isNull, ne, sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import {
  AI_VISIBILITY_STAGE_KEYS,
  aiVisibilityAlertsTable,
  aiVisibilityAeoQuestionsTable,
  aiVisibilityAuditStagesTable,
  aiVisibilityAuditsTable,
  aiVisibilityCompetitorSnapshotsTable,
  aiVisibilityCommerceSnapshotsTable,
  aiVisibilityCompetitorsTable,
  aiVisibilityCrawledPagesTable,
  aiVisibilityExtractionCorrectionsTable,
  aiVisibilityProjectsTable,
  aiVisibilityPromptRunsTable,
  aiVisibilityPromptsTable,
  aiVisibilityRecommendationsTable,
  aiVisibilityReportsTable,
  aiVisibilityScoreSnapshotsTable,
  aiVisibilitySeoIssuesTable,
  aiVisibilityOrganizationsTable,
  aiVisibilityWorkspacesTable,
  type AiVisibilityAuditRecord,
  type AiVisibilityProjectRecord,
} from '../../models/aiVisibility/schema.js';
import { brandToolkitsTable } from '../../models/brandToolkits/schema.js';
import { getCreditCost } from '../../models/creditPricing/functions.js';
import { creditService } from '../CreditService.js';
import { NotificationService } from '../NotificationService.js';
import { storageService } from '../StorageService.js';
import { WebsiteCrawlerService, type AuditCrawlResult, type AuditSitemapSource } from '../WebsiteCrawlerService.js';
import { webSocketEmitter } from '../agents/WebSocketEmitter.js';
import { logger } from '../../utils/logger.js';
import { analyzeSeo, normalizeAuditUrl, SEO_RULE_VERSION } from './SeoEngine.js';
import { analyzeAeoCoverage } from './AeoCoverageService.js';
import { deriveVisibilityAlerts } from './AlertDetectionService.js';
import {
  buildCounterContentBrief,
  deriveCompetitorIntelligence,
  type CompetitorContentGap,
} from './CompetitorIntelligenceService.js';
import { generateAuditPrompts, buildPrompt } from './PromptEngine.js';
import {
  AI_VISIBILITY_OBSERVATION_PROVIDERS,
  providerObservationService,
} from './ProviderObservationService.js';
import { calculateVisibilityScore } from './ScoringEngine.js';
import { structuredAnswerExtractionService } from './StructuredAnswerExtractionService.js';
import { resolveReportBranding } from './ReportBrandingService.js';
import { buildReportMethodology, reportPillarDisplay } from './ReportMethodologyService.js';
import { escapeHtmlValue as escapeHtml } from '../../../shared/html.js';
import { sha256Json as fingerprint } from '../../utils/sha256.js';

interface AuditContext {
  audit: AiVisibilityAuditRecord;
  project: AiVisibilityProjectRecord;
}

interface StageResult {
  output?: Record<string, unknown>;
  warning?: string;
  status?: 'skipped';
}

type CrawledPageRecord = typeof aiVisibilityCrawledPagesTable.$inferSelect;
type PromptRunRecord = typeof aiVisibilityPromptRunsTable.$inferSelect;
type PromptRecord = typeof aiVisibilityPromptsTable.$inferSelect;
type CompetitorRecord = typeof aiVisibilityCompetitorsTable.$inferSelect;
type SeoIssueRecord = typeof aiVisibilitySeoIssuesTable.$inferSelect;
type RecommendationRecord = typeof aiVisibilityRecommendationsTable.$inferSelect;
type ScoreSnapshotRecord = typeof aiVisibilityScoreSnapshotsTable.$inferSelect;
type Citation = PromptRunRecord['citations'][number];

export class AuditOrchestrator {
  /** Keep one worker per audit without wrapping durable stage writes in a
   * transaction. The guard holds one connection; worker concurrency is bounded.
   * PostgreSQL releases the transaction lock when a crashed worker disconnects. */
  private async withAuditLock<T>(
    auditId: number,
    userId: number,
    work: () => Promise<T>,
    busy: () => Promise<T>,
  ): Promise<T> {
    await this.loadAudit(auditId, userId);
    return db.transaction(async (guard: typeof db) => {
      const lock = await guard.execute(
        sql`SELECT pg_try_advisory_xact_lock(741660, ${auditId}) AS acquired`,
      );
      if (lock.rows[0]?.acquired !== true) return busy();
      return work();
    });
  }

  /** Rebuilds a failed/missing report from durable audit data without charging again. */
  async retryReport(auditId: number, userId: number): Promise<void> {
    return this.withAuditLock(
      auditId,
      userId,
      () => this.retryReportUnlocked(auditId, userId),
      async () => { throw new Error('This audit or report is already being processed.'); },
    );
  }

  private async retryReportUnlocked(auditId: number, userId: number): Promise<void> {
    const context = await this.loadContext(auditId, userId);
    if (!['completed', 'completed_with_warnings'].includes(context.audit.status)) {
      throw new Error('A report can be retried only after an audit has completed.');
    }
    const [existing] = await db
      .select({ id: aiVisibilityReportsTable.id })
      .from(aiVisibilityReportsTable)
      .where(
        and(
          eq(aiVisibilityReportsTable.auditId, auditId),
          eq(aiVisibilityReportsTable.status, 'completed'),
        ),
      )
      .limit(1);
    if (existing) {
      await this.reconcileWarningSummary(auditId, userId);
      return;
    }
    const index = AI_VISIBILITY_STAGE_KEYS.indexOf('report_generation');
    await this.beginStage(auditId, userId, 'report_generation', index);
    try {
      const result = await this.reportGeneration(context);
      await this.finishStage(auditId, userId, 'report_generation', result, index);
      await this.reconcileWarningSummary(auditId, userId);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Report generation failed';
      await this.finishStage(
        auditId,
        userId,
        'report_generation',
        { warning: message, output: { failed: true } },
        index,
      );
      await this.reconcileWarningSummary(auditId, userId);
      throw error;
    }
  }

  private async reconcileWarningSummary(auditId: number, userId: number): Promise<void> {
    const [{ count }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(aiVisibilityAuditStagesTable)
      .where(
        and(
          eq(aiVisibilityAuditStagesTable.auditId, auditId),
          eq(aiVisibilityAuditStagesTable.userId, userId),
          eq(aiVisibilityAuditStagesTable.status, 'warning'),
        ),
      );
    const warnings = Number(count || 0);
    await db
      .update(aiVisibilityAuditsTable)
      .set({
        warningCount: warnings,
        status: warnings > 0 ? 'completed_with_warnings' : 'completed',
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiVisibilityAuditsTable.id, auditId),
          eq(aiVisibilityAuditsTable.userId, userId),
          inArray(aiVisibilityAuditsTable.status, ['completed', 'completed_with_warnings']),
        ),
      );
  }

  async run(auditId: number, userId: number): Promise<{ status: string; warnings: number }> {
    return this.withAuditLock(
      auditId,
      userId,
      () => this.runUnlocked(auditId, userId),
      async () => {
        const audit = await this.loadAudit(auditId, userId);
        return { status: audit.status, warnings: audit.warningCount };
      },
    );
  }

  private async runUnlocked(auditId: number, userId: number): Promise<{ status: string; warnings: number }> {
    const context = await this.loadContext(auditId, userId);
    if (['completed', 'completed_with_warnings', 'cancelled'].includes(context.audit.status)) {
      return {
        status: context.audit.status,
        warnings: context.audit.warningCount,
      };
    }

    const [started] = await db
      .update(aiVisibilityAuditsTable)
      .set({
        status: 'running',
        startedAt: context.audit.startedAt || new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiVisibilityAuditsTable.id, auditId),
          eq(aiVisibilityAuditsTable.userId, userId),
          sql`${aiVisibilityAuditsTable.status} NOT IN ('completed','completed_with_warnings','cancelled')`,
        ),
      ).returning({id:aiVisibilityAuditsTable.id});
    // Billing cleanup can cancel a prepaid audit after loadContext but before
    // this claim. Never resurrect work whose original payment was refunded.
    if (!started) {
      const audit = await this.loadAudit(auditId,userId);
      return {status:audit.status,warnings:audit.warningCount};
    }
    webSocketEmitter.emit(userId, 'ai_visibility_audit_started', {
      auditId,
      projectId: context.project.id,
    });

    try {
      for (let index = 0; index < AI_VISIBILITY_STAGE_KEYS.length; index += 1) {
        const freshAudit = await this.loadAudit(auditId, userId);
        if (freshAudit.cancellationRequested) {
          return this.cancelRun(auditId, userId, freshAudit.warningCount);
        }
        const stageKey = AI_VISIBILITY_STAGE_KEYS[index];
        const [stage] = await db
          .select()
          .from(aiVisibilityAuditStagesTable)
          .where(
            and(
              eq(aiVisibilityAuditStagesTable.auditId, auditId),
              eq(aiVisibilityAuditStagesTable.stageKey, stageKey),
            ),
          )
          .limit(1);
        if (stage && ['completed', 'warning', 'skipped'].includes(stage.status)) continue;
        await this.beginStage(auditId, userId, stageKey, index);
        try {
          const result = await this.executeStage(stageKey, context);
          await this.finishStage(auditId, userId, stageKey, result, index);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Stage failed';
          logger.warn(
            { err: error, auditId, stageKey },
            'AI Visibility stage completed with warning',
          );
          await this.finishStage(
            auditId,
            userId,
            stageKey,
            { warning: message, output: { failed: true } },
            index,
          );
        }
      }

      const [{ count: warningCount }] = await db
        .select({ count: sql<number>`count(*)` })
        .from(aiVisibilityAuditStagesTable)
        .where(
          and(
            eq(aiVisibilityAuditStagesTable.auditId, auditId),
            eq(aiVisibilityAuditStagesTable.status, 'warning'),
          ),
        );
      const warnings = Number(warningCount || 0);
      const status = warnings > 0 ? 'completed_with_warnings' : 'completed';
      const [completed] = await db
        .update(aiVisibilityAuditsTable)
        .set({
          status,
          warningCount: warnings,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityAuditsTable.id, auditId),
            eq(aiVisibilityAuditsTable.userId, userId),
            eq(aiVisibilityAuditsTable.cancellationRequested, false),
            eq(aiVisibilityAuditsTable.status, 'running'),
          ),
        )
        .returning({ id: aiVisibilityAuditsTable.id });
      if (!completed) {
        const freshAudit = await this.loadAudit(auditId, userId);
        if (freshAudit.cancellationRequested) return this.cancelRun(auditId, userId, warnings);
        return { status: freshAudit.status, warnings: freshAudit.warningCount };
      }
      await this.settle(auditId, userId, status);
      webSocketEmitter.emit(userId, 'ai_visibility_audit_completed', {
        auditId,
        projectId: context.project.id,
        status,
        warnings,
      });
      await NotificationService.notify(
        userId,
        'AI Visibility audit complete',
        `${context.project.name} finished${warnings ? ` with ${warnings} warning${warnings === 1 ? '' : 's'}` : ''}.`,
        warnings ? 'warning' : 'success',
        { actionUrl: `/dashboard/ai-visibility/audits/${auditId}` },
      );
      return { status, warnings };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Audit failed';
      await db
        .update(aiVisibilityAuditsTable)
        .set({
          status: 'failed',
          error: message,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(aiVisibilityAuditsTable.id, auditId), eq(aiVisibilityAuditsTable.userId, userId)),
        );
      await this.settle(auditId, userId, 'failed');
      webSocketEmitter.emit(userId, 'ai_visibility_audit_failed', {
        auditId,
        projectId: context.project.id,
        status: 'failed',
        message,
      });
      await NotificationService.notify(
        userId,
        'AI Visibility audit failed',
        `${context.project.name}: ${message}`,
        'error',
        { actionUrl: `/dashboard/ai-visibility/audits/${auditId}` },
      );
      throw error;
    }
  }

  private async loadContext(auditId: number, userId: number): Promise<AuditContext> {
    const [record] = await db
      .select({
        audit: aiVisibilityAuditsTable,
        project: aiVisibilityProjectsTable,
      })
      .from(aiVisibilityAuditsTable)
      .innerJoin(
        aiVisibilityProjectsTable,
        eq(aiVisibilityAuditsTable.projectId, aiVisibilityProjectsTable.id),
      )
      .where(
        and(
          eq(aiVisibilityAuditsTable.id, auditId),
          eq(aiVisibilityAuditsTable.userId, userId),
          eq(aiVisibilityProjectsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!record) throw new Error('Tenant-owned audit was not found.');
    const snapshot = record.audit.inputSnapshot.project as
      | Partial<AiVisibilityProjectRecord>
      | undefined;
    return {
      ...record,
      project: snapshot
        ? {
            ...record.project,
            ...snapshot,
            id: record.project.id,
            userId: record.project.userId,
            workspaceId: record.project.workspaceId,
          }
        : record.project,
    };
  }

  private async loadAudit(auditId: number, userId: number) {
    const [audit] = await db
      .select()
      .from(aiVisibilityAuditsTable)
      .where(
        and(eq(aiVisibilityAuditsTable.id, auditId), eq(aiVisibilityAuditsTable.userId, userId)),
      )
      .limit(1);
    if (!audit) throw new Error('Audit not found.');
    return audit;
  }

  private async cancelRun(auditId: number, userId: number, warnings: number) {
    await this.cancelRemaining(auditId, userId);
    await this.settle(auditId, userId, 'cancelled');
    webSocketEmitter.emit(userId, 'ai_visibility_audit_failed', {
      auditId,
      status: 'cancelled',
      message: 'Audit cancelled by user.',
    });
    return { status: 'cancelled', warnings };
  }

  private async beginStage(auditId: number, userId: number, stageKey: string, index: number) {
    const progress = Math.round((index / AI_VISIBILITY_STAGE_KEYS.length) * 100);
    await db
      .update(aiVisibilityAuditStagesTable)
      .set({
        status: 'running',
        progress,
        attemptCount: sql`${aiVisibilityAuditStagesTable.attemptCount} + 1`,
        startedAt: new Date(),
        error: null,
        warning: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiVisibilityAuditStagesTable.auditId, auditId),
          eq(aiVisibilityAuditStagesTable.stageKey, stageKey),
        ),
      );
    webSocketEmitter.emit(userId, 'ai_visibility_stage_updated', {
      auditId,
      stageKey,
      status: 'running',
      progress,
    });
  }

  private async finishStage(
    auditId: number,
    userId: number,
    stageKey: string,
    result: StageResult,
    index: number,
  ) {
    const progress = Math.round(((index + 1) / AI_VISIBILITY_STAGE_KEYS.length) * 100);
    const status =
      result.status === 'skipped' ? 'skipped' : result.warning ? 'warning' : 'completed';
    const output =
      stageKey === 'competitor_analysis'
        ? { ...(await this.stageOutput(auditId, stageKey)), ...result.output }
        : result.output || {};
    await db
      .update(aiVisibilityAuditStagesTable)
      .set({
        status,
        progress: 100,
        output,
        outputFingerprint: fingerprint(output),
        warning: result.warning || null,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiVisibilityAuditStagesTable.auditId, auditId),
          eq(aiVisibilityAuditStagesTable.stageKey, stageKey),
        ),
      );
    webSocketEmitter.emit(userId, 'ai_visibility_stage_updated', {
      auditId,
      stageKey,
      status,
      progress,
      warning: result.warning,
    });
  }

  private async executeStage(
    stageKey: (typeof AI_VISIBILITY_STAGE_KEYS)[number],
    context: AuditContext,
  ): Promise<StageResult> {
    switch (stageKey) {
      case 'intake':
        return this.intake(context);
      case 'brand_crawl':
        return this.crawlBrand(context);
      case 'competitor_crawls':
        return this.crawlCompetitors(context);
      case 'seo_analysis':
        return this.seoAnalysis(context);
      case 'prompt_generation':
        return this.promptGeneration(context);
      case 'provider_collection':
        return this.providerCollection(context);
      case 'answer_extraction':
        return this.answerExtraction(context);
      case 'competitor_analysis':
        return this.competitorAnalysis(context);
      case 'scoring':
        return this.scoring(context);
      case 'fix_generation':
        return this.fixGeneration(context);
      case 'report_generation':
        return this.reportGeneration(context);
      case 'alert_detection':
        return this.alertDetection(context);
      case 'final_snapshot':
        return this.finalSnapshot(context);
    }
  }

  private async intake({ project }: AuditContext): Promise<StageResult> {
    const url = new URL(project.domain);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Project domain is not HTTP or HTTPS.');
    return {
      output: {
        domain: project.domain,
        profile: project.scoringProfile,
        locale: project.locale,
        scoringVersion: project.scoringProfileVersion,
      },
    };
  }

  private async crawlBrand(context: AuditContext): Promise<StageResult> {
    const crawler = new WebsiteCrawlerService({
      maxPages: 25,
      timeoutMs: 30_000,
    });
    const result = await crawler.crawlForAudit(context.project.domain);
    await this.persistCrawl(context, result, 'brand');
    const successes = result.pages.filter((page) => page.crawlStatus === 'completed').length;
    const failures = result.pages.length - successes;
    return {
      output: {
        pages: result.pages.length,
        successes,
        failures,
        robotsAvailable: result.robots.available,
        robotsDisallow: result.robots.disallow,
        robotsPolicy: result.robots.policy,
        discoveredPages: result.discoveredUrls.length,
        pageLimit: 25,
        robotsError: result.robots.error,
        sitemapAvailable: result.sitemap.available,
        // Keep every sitemap URL that matches a crawled page so sitemap checks stay exact,
        // plus a bounded sample for display, without storing a 5,000-URL list.
        sitemapUrls: (() => {
          const crawled = new Set(
            result.pages.flatMap((page) =>
              [page.url, page.finalUrl].filter((value): value is string => Boolean(value)).map(normalizeAuditUrl),
            ),
          );
          return [
            ...new Set([
              ...result.sitemap.urls.filter((value) => crawled.has(normalizeAuditUrl(value))),
              ...result.sitemap.urls.slice(0, 200),
            ]),
          ];
        })(),
        sitemapUrlCount: result.sitemap.urls.length,
        sitemapComplete: result.sitemap.complete !== false,
        sitemapDeclaredInRobots: result.sitemap.declaredInRobots === true,
        sitemapSources: result.sitemap.sources || [],
        checkedLinks: result.pages.reduce((sum, page) => sum + page.linkChecks.length, 0),
        brokenLinks: result.pages.reduce((sum, page) => sum + page.brokenLinks.length, 0),
        jsonLdErrors: result.pages.reduce((sum, page) => sum + page.jsonLdErrors.length, 0),
      },
      ...(successes === 0
        ? {
            warning: 'The brand website could not be crawled; SEO scoring will be unavailable.',
          }
        : failures
          ? {
              warning: `${failures} brand page${failures === 1 ? '' : 's'} could not be crawled.`,
            }
          : {}),
    };
  }

  private async crawlCompetitors(
    context: AuditContext,
    selected?: CompetitorRecord[],
  ): Promise<StageResult> {
    const competitors: CompetitorRecord[] =
      selected ??
      (Array.isArray(context.audit.inputSnapshot.competitors)
        ? (context.audit.inputSnapshot.competitors as CompetitorRecord[]).filter(
            (item) => item.active,
          )
        : await db
            .select()
            .from(aiVisibilityCompetitorsTable)
            .where(
              and(
                eq(aiVisibilityCompetitorsTable.projectId, context.project.id),
                eq(aiVisibilityCompetitorsTable.userId, context.audit.userId),
                eq(aiVisibilityCompetitorsTable.active, true),
              ),
            ));
    if (!competitors.length)
      return {
        output: { competitors: 0, comparison: 'not_applicable' },
        status: 'skipped',
      };
    const failed: string[] = [];
    for (const competitor of competitors) {
      try {
        const result = await new WebsiteCrawlerService({
          maxPages: 8,
          timeoutMs: 30_000,
        }).crawlForAudit(competitor.domain);
        await this.persistCrawl(context, result, 'competitor', competitor.id);
        if (!result.pages.some((page) => page.crawlStatus === 'completed'))
          failed.push(competitor.name);
      } catch (error) {
        failed.push(competitor.name);
        logger.warn(
          {
            err: error,
            competitorId: competitor.id,
            auditId: context.audit.id,
          },
          'Competitor crawl failed',
        );
      }
    }
    return {
      output: { competitors: competitors.length, failed },
      ...(failed.length ? { warning: `Could not crawl: ${failed.join(', ')}.` } : {}),
    };
  }

  private async persistCrawl(
    context: AuditContext,
    result: AuditCrawlResult,
    targetType: 'brand' | 'competitor',
    competitorId?: number,
  ) {
    await db
      .delete(aiVisibilityCrawledPagesTable)
      .where(
        and(
          eq(aiVisibilityCrawledPagesTable.auditId, context.audit.id),
          eq(aiVisibilityCrawledPagesTable.targetType, targetType),
          competitorId
            ? eq(aiVisibilityCrawledPagesTable.competitorId, competitorId)
            : sql`${aiVisibilityCrawledPagesTable.competitorId} IS NULL`,
        ),
      );
    for (let index = 0; index < result.pages.length; index += 1) {
      const page = result.pages[index];
      let rawHtmlKey: string | null = null;
      if (page.rawHtml) {
        try {
          const upload = await storageService.upload(Buffer.from(page.rawHtml), {
            userId: context.audit.userId,
            category: 'document',
            originalName: `page-${index + 1}.html`,
            mimeType: 'text/html',
            referenceType: 'ai_visibility_audit',
            referenceId: String(context.audit.id),
            storageKey: `${context.audit.userId}/document/ai-visibility/${context.audit.id}/${targetType}-${competitorId || 'brand'}-${index + 1}.html`,
            metadata: {
              sourceUrl: page.finalUrl || page.url,
              projectId: context.project.id,
            },
          });
          rawHtmlKey = upload.storageKey;
        } catch (error) {
          logger.warn(
            { err: error, auditId: context.audit.id, url: page.url },
            'Unable to persist raw crawl artifact',
          );
        }
      }
      await db.insert(aiVisibilityCrawledPagesTable).values({
        auditId: context.audit.id,
        projectId: context.project.id,
        userId: context.audit.userId,
        competitorId: competitorId || null,
        targetType,
        url: page.url,
        finalUrl: page.finalUrl,
        crawlStatus: page.crawlStatus,
        statusCode: page.statusCode,
        redirectCount: page.redirectCount,
        redirectChain: page.redirectChain || [],
        title: page.title,
        metaDescription: page.metaDescription,
        canonicalUrl: page.canonicalUrl,
        robotsDirective: page.robotsDirective,
        indexable: page.indexable,
        headings: page.headings,
        wordCount: page.wordCount,
        imageCount: page.imageCount,
        imagesMissingAlt: page.imagesMissingAlt,
        missingAltElements: page.missingAltElements || [],
        internalLinks: page.internalLinks,
        externalLinks: page.externalLinks,
        brokenLinks: page.brokenLinks,
        linkChecks: page.linkChecks,
        jsonLd: page.jsonLd,
        jsonLdErrors: page.jsonLdErrors,
        schemaTypes: page.schemaTypes,
        pageType: page.pageType,
        contentHash: page.contentHash,
        contentExcerpt: page.contentExcerpt,
        rawHtmlKey,
        error: page.error,
      });
    }
  }

  private async seoAnalysis(context: AuditContext): Promise<StageResult> {
    const pages = await db
      .select()
      .from(aiVisibilityCrawledPagesTable)
      .where(
        and(
          eq(aiVisibilityCrawledPagesTable.auditId, context.audit.id),
          eq(aiVisibilityCrawledPagesTable.targetType, 'brand'),
        ),
      );
    const crawlStage = await this.stageOutput(context.audit.id, 'brand_crawl');
    const analysis = analyzeSeo(
      pages.map((page: CrawledPageRecord) => ({
        url: page.url,
        finalUrl: page.finalUrl || undefined,
        crawlStatus: page.crawlStatus as
          | 'completed'
          | 'blocked'
          | 'timed_out'
          | 'uncrawlable'
          | 'failed',
        statusCode: page.statusCode || undefined,
        redirectCount: page.redirectCount,
        redirectChain: page.redirectChain || [],
        title: page.title || undefined,
        metaDescription: page.metaDescription || undefined,
        canonicalUrl: page.canonicalUrl || undefined,
        robotsDirective: page.robotsDirective || undefined,
        indexable: page.indexable,
        headings: page.headings,
        wordCount: page.wordCount,
        imageCount: page.imageCount,
        imagesMissingAlt: page.imagesMissingAlt,
        missingAltElements: page.missingAltElements || [],
        internalLinks: page.internalLinks,
        externalLinks: page.externalLinks,
        brokenLinks: page.brokenLinks,
        linkChecks: page.linkChecks,
        jsonLd: page.jsonLd,
        jsonLdErrors: page.jsonLdErrors,
        schemaTypes: page.schemaTypes,
        pageType: page.pageType || undefined,
        contentHash: page.contentHash || undefined,
        error: page.error || undefined,
      })),
      {
        robotsAvailable: crawlStage.robotsAvailable === true,
        robotsPolicy: Array.isArray(crawlStage.robotsPolicy)
          ? (crawlStage.robotsPolicy as import('./RobotsPolicy.js').RobotsGroup[])
          : undefined,
        robotsDisallow: Array.isArray(crawlStage.robotsDisallow)
          ? crawlStage.robotsDisallow.filter((value): value is string => typeof value === 'string')
          : [],
        sitemapAvailable: crawlStage.sitemapAvailable === true,
        sitemapUrls: Array.isArray(crawlStage.sitemapUrls)
          ? crawlStage.sitemapUrls.filter((value): value is string => typeof value === 'string')
          : [],
        robotsError: typeof crawlStage.robotsError === 'string' ? crawlStage.robotsError : undefined,
        // Older crawls did not record completeness; they stored at most 500 URLs.
        sitemapComplete:
          typeof crawlStage.sitemapComplete === 'boolean'
            ? crawlStage.sitemapComplete
            : !(Array.isArray(crawlStage.sitemapUrls) && crawlStage.sitemapUrls.length >= 500),
        sitemapDeclaredInRobots:
          typeof crawlStage.sitemapDeclaredInRobots === 'boolean'
            ? crawlStage.sitemapDeclaredInRobots
            : undefined,
        sitemapSources: Array.isArray(crawlStage.sitemapSources)
          ? (crawlStage.sitemapSources as AuditSitemapSource[])
          : undefined,
      },
    );
    await db
      .delete(aiVisibilitySeoIssuesTable)
      .where(eq(aiVisibilitySeoIssuesTable.auditId, context.audit.id));
    if (analysis.issues.length)
      await db.insert(aiVisibilitySeoIssuesTable).values(
        analysis.issues.map((item) => ({
          ...item,
          auditId: context.audit.id,
          projectId: context.project.id,
          userId: context.audit.userId,
        })),
      );
    return {
      output: {
        score: analysis.score,
        scoringVersion: 2,
        ruleVersion: SEO_RULE_VERSION,
        subScores: analysis.subScores,
        issues: analysis.issues.length,
      },
      ...(pages.length === 0 ? { warning: 'SEO analysis has no crawlable brand pages.' } : {}),
    };
  }

  private async promptGeneration(context: AuditContext): Promise<StageResult> {
    const prompts = generateAuditPrompts({
      brandName: context.project.name,
      aliases: context.project.brandAliases,
      category: context.project.category,
      profile: context.project.scoringProfile,
      locale: context.project.locale,
      geography: context.project.targetGeography,
    });
    prompts.push(
      ...(context.project.geoPrompts || [])
        .filter((item) => item.active)
        .map((item) =>
          buildPrompt(
            'geo',
            item.prompt,
            item.intent,
            'configured audience',
            context.project.locale,
            item.isGeneric,
          ),
        ),
    );
    const customQuestions: Array<typeof aiVisibilityAeoQuestionsTable.$inferSelect> = Array.isArray(
      context.audit.inputSnapshot.aeoQuestions,
    )
      ? (
          context.audit.inputSnapshot.aeoQuestions as Array<
            typeof aiVisibilityAeoQuestionsTable.$inferSelect
          >
        ).filter((item) => item.active)
      : await db
          .select()
          .from(aiVisibilityAeoQuestionsTable)
          .where(
            and(
              eq(aiVisibilityAeoQuestionsTable.projectId, context.project.id),
              eq(aiVisibilityAeoQuestionsTable.userId, context.audit.userId),
              eq(aiVisibilityAeoQuestionsTable.active, true),
            ),
          );
    prompts.push(
      ...customQuestions.map((question: typeof aiVisibilityAeoQuestionsTable.$inferSelect) => {
        const normalizedPrompt = question.question.toLowerCase().replace(/\s+/g, ' ').trim();
        return {
          kind: 'aeo' as const,
          prompt: question.question,
          normalizedPrompt,
          promptHash: createHash('sha256').update(normalizedPrompt).digest('hex'),
          intent: question.intent,
          persona: 'configured audience',
          locale: context.project.locale,
          isGeneric: false,
        };
      }),
    );
    await db
      .delete(aiVisibilityPromptsTable)
      .where(eq(aiVisibilityPromptsTable.auditId, context.audit.id));
    await db.insert(aiVisibilityPromptsTable).values(
      prompts.map((prompt) => ({
        ...prompt,
        auditId: context.audit.id,
        projectId: context.project.id,
        userId: context.audit.userId,
      })),
    );
    return {
      output: {
        prompts: prompts.length,
        generic: prompts.filter((prompt) => prompt.isGeneric).length,
        brandSpecific: prompts.filter((prompt) => !prompt.isGeneric).length,
        customAeoQuestions: customQuestions.length,
      },
    };
  }

  private async providerCollection(context: AuditContext): Promise<StageResult> {
    const prompts = await db
      .select()
      .from(aiVisibilityPromptsTable)
      .where(
        and(
          eq(aiVisibilityPromptsTable.auditId, context.audit.id),
          eq(aiVisibilityPromptsTable.kind, 'geo'),
        ),
      )
      .orderBy(asc(aiVisibilityPromptsTable.id));
    const failures: string[] = [];
    const blockedProviders = new Map<string, string>();
    const readiness = await providerObservationService.readiness();
    readiness
      .filter((provider) => !provider.configured)
      .forEach((provider) => blockedProviders.set(provider.provider, provider.reason));
    let skipped = 0;
    const failuresByProvider = new Map<string, number>();
    const failureReasons = new Map<string, string>();
    for (const prompt of prompts) {
      // The engines are asked at the same time; each takes 5 to 20 seconds.
      await Promise.all(AI_VISIBILITY_OBSERVATION_PROVIDERS.map(async (provider) => {
        const [existing] = await db
          .select({ id: aiVisibilityPromptRunsTable.id })
          .from(aiVisibilityPromptRunsTable)
          .where(
            and(
              eq(aiVisibilityPromptRunsTable.promptId, prompt.id),
              eq(aiVisibilityPromptRunsTable.provider, provider),
            ),
          )
          .limit(1);
        if (existing) return;
        const blockedReason = blockedProviders.get(provider);
        if (blockedReason) {
          await db.insert(aiVisibilityPromptRunsTable).values({
            promptId: prompt.id,
            auditId: context.audit.id,
            userId: context.audit.userId,
            provider,
            model: readiness.find((item) => item.provider === provider)?.model || 'unconfigured',
            fidelity: 'live_api',
            status: readiness.find((item) => item.provider === provider)?.configured
              ? 'skipped'
              : 'excluded',
            citations: [],
            costCents: '0',
            error: blockedReason,
          });
          skipped += 1;
          return;
        }
        const configuredModel = prompt.isGeneric
          ? await providerObservationService.getConfiguredModel(provider)
          : null;
        const bucketStart = new Date();
        bucketStart.setUTCHours(0, 0, 0, 0);
        if (prompt.isGeneric && configuredModel) {
          const [cached] = await db
            .select({
              run: aiVisibilityPromptRunsTable,
              inputSnapshot: aiVisibilityAuditsTable.inputSnapshot,
            })
            .from(aiVisibilityPromptRunsTable)
            .innerJoin(
              aiVisibilityPromptsTable,
              eq(aiVisibilityPromptRunsTable.promptId, aiVisibilityPromptsTable.id),
            )
            .innerJoin(
              aiVisibilityAuditsTable,
              eq(aiVisibilityPromptRunsTable.auditId, aiVisibilityAuditsTable.id),
            )
            .where(
              and(
                eq(aiVisibilityPromptsTable.promptHash, prompt.promptHash),
                eq(aiVisibilityPromptsTable.projectId, context.project.id),
                eq(aiVisibilityPromptRunsTable.userId, context.audit.userId),
                eq(aiVisibilityPromptsTable.locale, prompt.locale),
                eq(aiVisibilityPromptRunsTable.provider, provider),
                eq(aiVisibilityPromptRunsTable.model, configuredModel),
                eq(aiVisibilityPromptRunsTable.status, 'completed'),
                gte(aiVisibilityPromptRunsTable.capturedAt, bucketStart),
                ne(aiVisibilityPromptRunsTable.auditId, context.audit.id),
              ),
            )
            .orderBy(desc(aiVisibilityPromptRunsTable.capturedAt))
            .limit(1);
          if (cached) {
            const cacheKey = `${provider}:${configuredModel}:${prompt.locale}:${prompt.promptHash}:${bucketStart.toISOString().slice(0, 10)}`;
            const cachedProject = cached.inputSnapshot?.project as
              | Partial<typeof context.project>
              | undefined;
            const reusableExtraction =
              ['completed', 'corrected', 'cached'].includes(cached.run.extractionStatus) &&
              cachedProject?.configurationRevision === context.project.configurationRevision &&
              cachedProject?.name === context.project.name &&
              JSON.stringify(cachedProject?.brandAliases) ===
                JSON.stringify(context.project.brandAliases);
            await db.insert(aiVisibilityPromptRunsTable).values({
              promptId: prompt.id,
              auditId: context.audit.id,
              userId: context.audit.userId,
              provider,
              model: cached.run.model,
              fidelity: cached.run.fidelity,
              status: 'completed',
              answer: cached.run.answer,
              citations: cached.run.citations,
              brandMentioned: reusableExtraction ? cached.run.brandMentioned : null,
              brandRank: reusableExtraction ? cached.run.brandRank : null,
              sentiment: reusableExtraction ? cached.run.sentiment : null,
              competitors: reusableExtraction ? cached.run.competitors : [],
              recommendationReason: reusableExtraction ? cached.run.recommendationReason : null,
              exclusionReason: reusableExtraction ? cached.run.exclusionReason : null,
              extractionStatus: reusableExtraction ? 'cached' : 'pending',
              extractionMethod: reusableExtraction
                ? `cached_${cached.run.extractionMethod || 'structured_llm_v1'}`
                : null,
              extractionProvider: reusableExtraction ? cached.run.extractionProvider : null,
              extractionModel: reusableExtraction ? cached.run.extractionModel : null,
              extractionFidelity: reusableExtraction ? cached.run.extractionFidelity : null,
              extractionInputTokens: 0,
              extractionOutputTokens: 0,
              extractionCostCents: '0',
              inputTokens: 0,
              outputTokens: 0,
              costCents: '0',
              cacheKey,
              cachedFromRunId: cached.run.id,
            });
            return;
          }
        }
        const observation = await providerObservationService.collect(
          provider,
          prompt.prompt,
          prompt.locale,
          { userId: context.audit.userId, auditId: context.audit.id },
        );
        await db.insert(aiVisibilityPromptRunsTable).values({
          promptId: prompt.id,
          auditId: context.audit.id,
          userId: context.audit.userId,
          provider,
          model: observation.model,
          fidelity: observation.fidelity,
          status: observation.status,
          answer: observation.answer,
          citations: observation.citations,
          inputTokens: observation.inputTokens,
          outputTokens: observation.outputTokens,
          costCents: observation.costCents.toFixed(8),
          cacheKey:
            prompt.isGeneric && observation.status === 'completed'
              ? `${provider}:${observation.model}:${prompt.locale}:${prompt.promptHash}:${bucketStart.toISOString().slice(0, 10)}`
              : null,
          error: observation.error,
        });
        if (observation.status === 'failed') {
          failures.push(`${provider}: ${observation.error}`);
          const quotaFailure = classifyLLMProviderFailure(observation.error).category === 'insufficient_credits';
          if (quotaFailure || isProviderAvailabilityFailure(observation.error || ''))
            blockedProviders.set(
              provider,
              quotaFailure ? platformAIQuotaMessage() : 'Remaining requests skipped after a provider-wide availability failure. Resolve credentials or quota, then run a new analysis.',
            );
          failuresByProvider.set(provider, (failuresByProvider.get(provider) || 0) + 1);
          if (!failureReasons.has(provider))
            failureReasons.set(provider, quotaFailure ? platformAIQuotaMessage() : (observation.error || 'request failed').slice(0, 180));
        }
      }));
    }
    const providerDetails = [...failuresByProvider.entries()]
      .map(
        ([provider, count]) =>
          `${provider} (${count}: ${failureReasons.get(provider) || 'request failed'})`,
      )
      .join('; ');
    const noProviderConfigured = readiness.every(item => !item.configured);
    const quotaNotice = readiness.find(item => item.quotaBlocked)?.reason;
    return {
      output: {
        requests: prompts.length * readiness.filter((item) => item.configured).length,
        excluded: prompts.length * readiness.filter((item) => !item.configured).length,
        failures: failures.length,
        skipped,
        providerReadiness: readiness,
        failuresByProvider: Object.fromEntries(failuresByProvider),
        failureReasons: Object.fromEntries(failureReasons),
      },
      ...(failures.length || skipped
        ? {
            warning: noProviderConfigured
              ? quotaNotice ? `AI visibility measurements were skipped. ${quotaNotice}`
                : 'No AI engine could be asked, so no requests were sent. An AskSales administrator needs to add an OpenRouter API key, then run a new analysis.'
              : `${failures.length} failed and ${skipped} skipped or excluded provider observations. ${providerDetails || 'Unconfigured providers were excluded.'} Only successful observations contribute to the score. Failed calls remain visible and are never replaced with synthetic values.`,
          }
        : {}),
    };
  }

  private async answerExtraction(context: AuditContext): Promise<StageResult> {
    const runs = await db
      .select({
        run: aiVisibilityPromptRunsTable,
        prompt: aiVisibilityPromptsTable,
      })
      .from(aiVisibilityPromptRunsTable)
      .innerJoin(
        aiVisibilityPromptsTable,
        eq(aiVisibilityPromptRunsTable.promptId, aiVisibilityPromptsTable.id),
      )
      .where(
        and(
          eq(aiVisibilityPromptRunsTable.auditId, context.audit.id),
          eq(aiVisibilityPromptRunsTable.status, 'completed'),
        ),
      );
    const competitors: CompetitorRecord[] = Array.isArray(context.audit.inputSnapshot.competitors)
      ? (context.audit.inputSnapshot.competitors as CompetitorRecord[]).filter(
          (item) => item.active,
        )
      : await db
          .select()
          .from(aiVisibilityCompetitorsTable)
          .where(
            and(
              eq(aiVisibilityCompetitorsTable.projectId, context.project.id),
              eq(aiVisibilityCompetitorsTable.userId, context.audit.userId),
              eq(aiVisibilityCompetitorsTable.active, true),
            ),
          );
    const outcomes: string[] = [];
    // Each answer takes about 2 seconds to read; 8 at a time keeps 16 answers under 10 seconds.
    for (let index = 0; index < runs.length; index += 8) {
      outcomes.push(
        ...(await Promise.all(
          runs
            .slice(index, index + 8)
            .map((record: { run: PromptRunRecord; prompt: PromptRecord }) =>
              this.extractProviderRun(record, context, competitors),
            ),
        )),
      );
    }
    const extracted = outcomes.filter((outcome) =>
      ['completed', 'corrected', 'cached'].includes(outcome),
    ).length;
    const failed = outcomes.filter((outcome) => outcome === 'failed').length;
    return {
      output: {
        extracted,
        failed,
        method: 'structured_llm_v1',
        correctionsApplied: outcomes.filter((outcome) => outcome === 'corrected').length,
      },
      ...(runs.length === 0
        ? {
            warning: 'No successful provider answers were available to extract.',
          }
        : failed
          ? {
              warning: `${failed} provider answer${failed === 1 ? '' : 's'} could not be schema-validated. Raw answers were preserved and derived metrics remain unavailable.`,
            }
          : {}),
    };
  }

  private async extractProviderRun(
    record: { run: PromptRunRecord; prompt: PromptRecord },
    context: AuditContext,
    competitors: CompetitorRecord[],
  ): Promise<string> {
    if (['completed', 'corrected', 'cached'].includes(record.run.extractionStatus))
      return record.run.extractionStatus;
    const [correction] = await db
      .select()
      .from(aiVisibilityExtractionCorrectionsTable)
      .where(
        and(
          eq(aiVisibilityExtractionCorrectionsTable.userId, context.audit.userId),
          eq(aiVisibilityExtractionCorrectionsTable.promptRunId, record.run.id),
          eq(aiVisibilityExtractionCorrectionsTable.provider, record.run.provider),
        ),
      )
      .orderBy(desc(aiVisibilityExtractionCorrectionsTable.updatedAt))
      .limit(1);
    if (correction) {
      const extraction = correction.correction;
      await db
        .update(aiVisibilityPromptRunsTable)
        .set({
          brandMentioned:
            typeof extraction.brandMentioned === 'boolean' ? extraction.brandMentioned : null,
          brandRank: typeof extraction.brandRank === 'number' ? extraction.brandRank : null,
          sentiment: typeof extraction.sentiment === 'string' ? extraction.sentiment : null,
          competitors: Array.isArray(extraction.competitors)
            ? extraction.competitors.filter(
                (value: unknown): value is string => typeof value === 'string',
              )
            : [],
          recommendationReason:
            typeof extraction.recommendationReason === 'string'
              ? extraction.recommendationReason
              : null,
          exclusionReason:
            typeof extraction.exclusionReason === 'string' ? extraction.exclusionReason : null,
          extractionStatus: 'corrected',
          extractionMethod: 'manual_correction',
          extractionProvider: 'manual',
          extractionModel: 'user_correction',
          extractionFidelity: 'manual_capture',
          extractionError: null,
          extractionInputTokens: 0,
          extractionOutputTokens: 0,
          extractionCostCents: '0',
        })
        .where(eq(aiVisibilityPromptRunsTable.id, record.run.id));
      return 'corrected';
    }

    const result = await structuredAnswerExtractionService.extract(
      {
        prompt: record.prompt.prompt,
        answer: record.run.answer || '',
        brandName: context.project.name,
        brandAliases: context.project.brandAliases,
        knownCompetitors: competitors.map((competitor) => ({
          name: competitor.name,
          aliases: competitor.aliases,
        })),
      },
      {
        userId: context.audit.userId,
        auditId: context.audit.id,
        promptRunId: record.run.id,
      },
    );
    if (result.status === 'failed' || !result.extraction) {
      await db
        .update(aiVisibilityPromptRunsTable)
        .set({
          brandMentioned: null,
          brandRank: null,
          sentiment: null,
          competitors: [],
          recommendationReason: null,
          exclusionReason: null,
          extractionStatus: 'failed',
          extractionMethod: result.method,
          extractionProvider: result.provider,
          extractionModel: result.model,
          extractionFidelity: result.fidelity,
          extractionError: result.error,
          extractionInputTokens: result.inputTokens,
          extractionOutputTokens: result.outputTokens,
          extractionCostCents: result.costCents.toFixed(8),
        })
        .where(eq(aiVisibilityPromptRunsTable.id, record.run.id));
      return 'failed';
    }
    await db
      .update(aiVisibilityPromptRunsTable)
      .set({
        ...result.extraction,
        extractionStatus: 'completed',
        extractionMethod: result.method,
        extractionProvider: result.provider,
        extractionModel: result.model,
        extractionFidelity: result.fidelity,
        extractionError: null,
        extractionInputTokens: result.inputTokens,
        extractionOutputTokens: result.outputTokens,
        extractionCostCents: result.costCents.toFixed(8),
      })
      .where(eq(aiVisibilityPromptRunsTable.id, record.run.id));
    return 'completed';
  }

  private async competitorAnalysis(context: AuditContext): Promise<StageResult> {
    await db
      .delete(aiVisibilityCompetitorSnapshotsTable)
      .where(eq(aiVisibilityCompetitorSnapshotsTable.auditId, context.audit.id));
    const observations: PromptRunRecord[] = await db
      .select()
      .from(aiVisibilityPromptRunsTable)
      .where(
        and(
          eq(aiVisibilityPromptRunsTable.auditId, context.audit.id),
          eq(aiVisibilityPromptRunsTable.userId, context.audit.userId),
          eq(aiVisibilityPromptRunsTable.status, 'completed'),
          inArray(aiVisibilityPromptRunsTable.extractionStatus, [
            'completed',
            'corrected',
            'cached',
          ]),
        ),
      );
    const [profile] = context.project.businessProfileId
      ? await db
          .select({ referenceAccounts: companySettings.referenceAccounts })
          .from(companySettings)
          .where(
            and(
              eq(companySettings.id, context.project.businessProfileId),
              eq(companySettings.userId, context.audit.userId),
              eq(companySettings.isApproved, true),
            ),
          )
          .limit(1)
      : [];
    const discovery = await discoverAuditCompetitors({
      audit: context.audit,
      project: context.project,
      referenceAccounts: profile?.referenceAccounts,
      observations,
    });
    const configured: CompetitorRecord[] = await db
      .select()
      .from(aiVisibilityCompetitorsTable)
      .where(
        and(
          eq(aiVisibilityCompetitorsTable.projectId, context.project.id),
          eq(aiVisibilityCompetitorsTable.userId, context.audit.userId),
        ),
      );
    const competitors = await auditCompetitors(context.audit, configured);
    const discovered = discovery.discoveredCompetitors as CompetitorRecord[];
    const crawl = discovered.length ? await this.crawlCompetitors(context, discovered) : undefined;
    if (!competitors.length)
      return {
        output: { ...discovery, competitors: 0, comparison: 'no_verified_candidates' },
        warning:
          'No competitors with evidenced websites were discovered. Configure an AI provider or add competitors manually, then analyze again.',
      };
    const [runs, pages] = await Promise.all([
      db
        .select()
        .from(aiVisibilityPromptRunsTable)
        .where(
          and(
            eq(aiVisibilityPromptRunsTable.auditId, context.audit.id),
            eq(aiVisibilityPromptRunsTable.status, 'completed'),
            inArray(aiVisibilityPromptRunsTable.extractionStatus, [
              'completed',
              'corrected',
              'cached',
            ]),
          ),
        ),
      db
        .select()
        .from(aiVisibilityCrawledPagesTable)
        .where(
          and(
            eq(aiVisibilityCrawledPagesTable.auditId, context.audit.id),
            eq(aiVisibilityCrawledPagesTable.userId, context.audit.userId),
          ),
        ),
    ]);
    const brandCrawl = await this.stageOutput(context.audit.id, 'brand_crawl');
    const intelligence = deriveCompetitorIntelligence({
      projectDomain: context.project.domain,
      competitors,
      pages,
      runs,
      brandKnownUrls: Array.isArray(brandCrawl.sitemapUrls)
        ? brandCrawl.sitemapUrls.filter((value): value is string => typeof value === 'string')
        : [],
    });
    for (const competitor of intelligence.competitors) {
      await db.insert(aiVisibilityCompetitorSnapshotsTable).values({
        auditId: context.audit.id,
        projectId: context.project.id,
        userId: context.audit.userId,
        competitorId: competitor.competitorId,
        metrics: {
          ...competitor.metrics,
          brand: intelligence.brand,
          promptCount: intelligence.promptCount,
          totalMentionEvents: intelligence.totalMentionEvents,
          totalCitations: intelligence.totalCitations,
          citedDomains: intelligence.citedDomains,
        },
        contentGaps: competitor.contentGaps,
      });
    }
    return {
      ...(crawl?.warning ? { warning: crawl.warning } : {}),
      output: {
        ...discovery,
        competitors: competitors.length,
        providerAnswers: runs.length,
        brandShareOfVoice: intelligence.brand.shareOfVoice,
        verifiedContentGaps: intelligence.competitors.reduce(
          (sum, competitor) => sum + competitor.contentGaps.length,
          0,
        ),
      },
    };
  }

  private async scoring(context: AuditContext): Promise<StageResult> {
    const seoStage = await this.stageOutput(context.audit.id, 'seo_analysis');
    const pages = await db
      .select()
      .from(aiVisibilityCrawledPagesTable)
      .where(
        and(
          eq(aiVisibilityCrawledPagesTable.auditId, context.audit.id),
          eq(aiVisibilityCrawledPagesTable.targetType, 'brand'),
          eq(aiVisibilityCrawledPagesTable.crawlStatus, 'completed'),
        ),
      );
    const aeoQuestions: Array<typeof aiVisibilityAeoQuestionsTable.$inferSelect> = Array.isArray(
      context.audit.inputSnapshot.aeoQuestions,
    )
      ? (
          context.audit.inputSnapshot.aeoQuestions as Array<
            typeof aiVisibilityAeoQuestionsTable.$inferSelect
          >
        ).filter((item) => item.active)
      : await db
          .select()
          .from(aiVisibilityAeoQuestionsTable)
          .where(
            and(
              eq(aiVisibilityAeoQuestionsTable.projectId, context.project.id),
              eq(aiVisibilityAeoQuestionsTable.userId, context.audit.userId),
              eq(aiVisibilityAeoQuestionsTable.active, true),
            ),
          );
    const runs = await db
      .select()
      .from(aiVisibilityPromptRunsTable)
      .where(
        and(
          eq(aiVisibilityPromptRunsTable.auditId, context.audit.id),
          eq(aiVisibilityPromptRunsTable.status, 'completed'),
        ),
      );
    const metricRuns = runs.filter((run: PromptRunRecord) =>
      ['completed', 'corrected', 'cached'].includes(run.extractionStatus),
    );
    const [commerceSnapshot] = await db
      .select()
      .from(aiVisibilityCommerceSnapshotsTable)
      .where(
        and(
          eq(aiVisibilityCommerceSnapshotsTable.projectId, context.project.id),
          eq(aiVisibilityCommerceSnapshotsTable.userId, context.audit.userId),
          typeof context.audit.inputSnapshot.commerceSnapshotId === 'number'
            ? eq(
                aiVisibilityCommerceSnapshotsTable.id,
                context.audit.inputSnapshot.commerceSnapshotId,
              )
            : context.audit.inputSnapshot.commerceSnapshotId === null
              ? sql`false`
              : lte(aiVisibilityCommerceSnapshotsTable.createdAt, context.audit.createdAt),
        ),
      )
      .orderBy(desc(aiVisibilityCommerceSnapshotsTable.createdAt))
      .limit(1);
    const seoScore = typeof seoStage.score === 'number' && pages.length ? seoStage.score : null;
    const answerReady = pages.filter(
      (page: CrawledPageRecord) =>
        (page.headings.h2 || []).some((heading: string) =>
          /\?|how|what|why|when|which/i.test(heading),
        ) || page.schemaTypes.some((type: string) => /FAQPage|HowTo|QAPage/i.test(type)),
    ).length;
    const structuralAeoScore = pages.length
      ? Math.min(
          100,
          Math.round(
            (answerReady / pages.length) * 70 +
              (pages.filter((page: CrawledPageRecord) => page.wordCount >= 200).length /
                pages.length) *
                30,
          ),
        )
      : null;
    const aeoCoverage = analyzeAeoCoverage(aeoQuestions, pages);
    const coveredQuestionScore = aeoCoverage.length
      ? Math.round(
          (aeoCoverage.reduce(
            (sum, item) =>
              sum + (item.status === 'answered' ? 1 : item.status === 'partial' ? 0.5 : 0),
            0,
          ) /
            aeoCoverage.length) *
            100,
        )
      : null;
    const aeoScore =
      structuralAeoScore === null
        ? null
        : coveredQuestionScore === null
          ? structuralAeoScore
          : Math.round(coveredQuestionScore * 0.7 + structuralAeoScore * 0.3);
    const mentioned = metricRuns.filter((run: PromptRunRecord) => run.brandMentioned).length;
    const topThree = metricRuns.filter(
      (run: PromptRunRecord) => run.brandRank && run.brandRank <= 3,
    ).length;
    const cited = metricRuns.filter((run: PromptRunRecord) =>
      run.citations.some((citation: Citation) => {
        return isFirstPartyCitation(citation.url, context.project.domain);
      }),
    ).length;
    const geoScore = metricRuns.length
      ? Math.round(
          ((mentioned / metricRuns.length) * 0.6 +
            (topThree / metricRuns.length) * 0.25 +
            (cited / metricRuns.length) * 0.15) *
            100,
        )
      : null;
    const pillars = {
      seo: {
        score: seoScore,
        status: seoScore === null ? ('unavailable' as const) : ('scored' as const),
      },
      aeo: {
        score: aeoScore,
        status: aeoScore === null ? ('unavailable' as const) : ('scored' as const),
      },
      geo: {
        score: geoScore,
        status: geoScore === null ? ('unavailable' as const) : ('scored' as const),
      },
      commerce: commerceSnapshot
        ? { score: Number(commerceSnapshot.score), status: 'scored' as const }
        : { score: null, status: 'not_applicable' as const },
    };
    const score = calculateVisibilityScore(context.project.scoringProfile, pillars);
    await db
      .insert(aiVisibilityScoreSnapshotsTable)
      .values({
        auditId: context.audit.id,
        projectId: context.project.id,
        userId: context.audit.userId,
        scoringProfile: context.project.scoringProfile,
        scoringVersion: score.version,
        inputFingerprint: score.inputFingerprint,
        overallScore: score.overallScore.toFixed(2),
        seoScore: seoScore?.toFixed(2),
        aeoScore: aeoScore?.toFixed(2),
        geoScore: geoScore?.toFixed(2),
        commerceScore: commerceSnapshot ? Number(commerceSnapshot.score).toFixed(2) : null,
        pillarStatuses: Object.fromEntries(
          Object.entries(pillars).map(([key, value]) => [key, value.status]),
        ),
        metrics: {
          mentionRate: metricRuns.length ? mentioned / metricRuns.length : null,
          topThreeRate: metricRuns.length ? topThree / metricRuns.length : null,
          citationShare: metricRuns.length ? cited / metricRuns.length : null,
          providerAnswers: runs.length,
          extractedAnswers: metricRuns.length,
          aeoQuestions: aeoCoverage.length,
          aeoAnswered: aeoCoverage.filter((item) => item.status === 'answered').length,
          aeoPartial: aeoCoverage.filter((item) => item.status === 'partial').length,
          aeoUncovered: aeoCoverage.filter((item) => item.status === 'uncovered').length,
        },
        subScores: (seoStage.subScores || {}) as Record<string, number>,
      })
      .onConflictDoUpdate({
        target: aiVisibilityScoreSnapshotsTable.auditId,
        set: {
          overallScore: score.overallScore.toFixed(2),
          seoScore: seoScore?.toFixed(2),
          aeoScore: aeoScore?.toFixed(2),
          geoScore: geoScore?.toFixed(2),
          commerceScore: commerceSnapshot ? Number(commerceSnapshot.score).toFixed(2) : null,
          pillarStatuses: Object.fromEntries(
            Object.entries(pillars).map(([key, value]) => [key, value.status]),
          ),
          metrics: {
            mentionRate: metricRuns.length ? mentioned / metricRuns.length : null,
            topThreeRate: metricRuns.length ? topThree / metricRuns.length : null,
            citationShare: metricRuns.length ? cited / metricRuns.length : null,
            providerAnswers: runs.length,
            extractedAnswers: metricRuns.length,
            aeoQuestions: aeoCoverage.length,
            aeoAnswered: aeoCoverage.filter((item) => item.status === 'answered').length,
            aeoPartial: aeoCoverage.filter((item) => item.status === 'partial').length,
            aeoUncovered: aeoCoverage.filter((item) => item.status === 'uncovered').length,
          },
          subScores: (seoStage.subScores || {}) as Record<string, number>,
          inputFingerprint: score.inputFingerprint,
        },
      });
    return {
      output: {
        overallScore: score.overallScore,
        pillars,
        normalizedWeights: score.normalizedWeights,
        inputFingerprint: score.inputFingerprint,
      },
      ...(!runs.length
        ? {
            warning: 'GEO score is unavailable because no provider observations succeeded.',
          }
        : !metricRuns.length
          ? {
              warning:
                'GEO score is unavailable because successful provider answers could not be schema-validated.',
            }
          : {}),
    };
  }

  private async fixGeneration(context: AuditContext): Promise<StageResult> {
    await db
      .delete(aiVisibilityRecommendationsTable)
      .where(eq(aiVisibilityRecommendationsTable.auditId, context.audit.id));
    const issues = await db
      .select()
      .from(aiVisibilitySeoIssuesTable)
      .where(eq(aiVisibilitySeoIssuesTable.auditId, context.audit.id))
      .orderBy(asc(aiVisibilitySeoIssuesTable.id));
    const recommendations = issues.map((issue: SeoIssueRecord) => ({
      auditId: context.audit.id,
      projectId: context.project.id,
      userId: context.audit.userId,
      module: 'seo',
      title: issue.ruleId
        .split('.')
        .map((part: string) => part.replace(/_/g, ' '))
        .join(' · '),
      description: issue.recommendation,
      severity: issue.severity,
      impact: ['critical', 'high'].includes(issue.severity)
        ? 'high'
        : issue.severity === 'medium'
          ? 'medium'
          : 'low',
      effort: ['schema.missing', 'content.thin', 'content.duplicate'].includes(issue.ruleId)
        ? 'medium'
        : 'low',
      affectedUrl: issue.affectedUrl,
      evidence: { ...issue.evidence, ruleId: issue.ruleId },
      confidence: '1.00',
      assetType:
        issue.ruleId === 'schema.missing'
          ? 'json_ld'
          : issue.ruleId.includes('schema')
            ? 'content_brief'
            : issue.ruleId.includes('metadata')
              ? 'metadata'
              : issue.ruleId.includes('content')
                ? 'content_brief'
                : null,
      generatedDraft:
        issue.ruleId === 'schema.missing'
          ? JSON.stringify(
              {
                '@context': 'https://schema.org',
                '@type':
                  context.project.scoringProfile === 'local_business'
                    ? 'LocalBusiness'
                    : 'Organization',
                name: context.project.name,
                url: context.project.domain,
              },
              null,
              2,
            )
          : null,
    }));
    const promptRows = await db
      .select()
      .from(aiVisibilityPromptsTable)
      .where(eq(aiVisibilityPromptsTable.auditId, context.audit.id));
    const absentRuns = await db
      .select()
      .from(aiVisibilityPromptRunsTable)
      .where(
        and(
          eq(aiVisibilityPromptRunsTable.auditId, context.audit.id),
          eq(aiVisibilityPromptRunsTable.status, 'completed'),
          inArray(aiVisibilityPromptRunsTable.extractionStatus, [
            'completed',
            'corrected',
            'cached',
          ]),
          eq(aiVisibilityPromptRunsTable.brandMentioned, false),
        ),
      );
    for (const run of absentRuns)
      recommendations.push({
        auditId: context.audit.id,
        projectId: context.project.id,
        userId: context.audit.userId,
        module: 'geo',
        title: `Close a verified AI-answer coverage gap`,
        description:
          run.exclusionReason || 'Create source-worthy content that directly answers this prompt.',
        severity: 'medium',
        impact: 'medium',
        effort: 'medium',
        affectedUrl: null,
        evidence: {
          promptRunId: run.id,
          prompt: promptRows.find((prompt: PromptRecord) => prompt.id === run.promptId)?.prompt,
          provider: run.provider,
          citations: run.citations,
        },
        confidence: '0.75',
        assetType: 'content_brief',
        generatedDraft: `Create an evidence-backed page that directly answers the observed question. Include a concise answer, verifiable claims, comparison criteria, author/date details, and links to primary sources.`,
      });
    const snapshotRows = await db
      .select({
        snapshot: aiVisibilityCompetitorSnapshotsTable,
        competitor: aiVisibilityCompetitorsTable,
      })
      .from(aiVisibilityCompetitorSnapshotsTable)
      .innerJoin(
        aiVisibilityCompetitorsTable,
        and(
          eq(aiVisibilityCompetitorsTable.id, aiVisibilityCompetitorSnapshotsTable.competitorId),
          eq(aiVisibilityCompetitorsTable.userId, context.audit.userId),
        ),
      )
      .where(
        and(
          eq(aiVisibilityCompetitorSnapshotsTable.auditId, context.audit.id),
          eq(aiVisibilityCompetitorSnapshotsTable.userId, context.audit.userId),
        ),
      );
    for (const row of snapshotRows) {
      for (const value of row.snapshot.contentGaps) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
        const gap = value as Partial<CompetitorContentGap>;
        if (
          typeof gap.key !== 'string' ||
          typeof gap.pageType !== 'string' ||
          typeof gap.label !== 'string' ||
          !Array.isArray(gap.evidenceUrls) ||
          !gap.evidenceUrls.every((url) => typeof url === 'string') ||
          typeof gap.competitorPageCount !== 'number' ||
          gap.competitorPageCount < 1 ||
          gap.brandPageCount !== 0
        )
          continue;
        const verifiedGap = gap as CompetitorContentGap;
        const draft = buildCounterContentBrief({
          projectName: context.project.name,
          competitor: {
            competitorId: row.competitor.id,
            name: row.competitor.name,
          },
          gap: verifiedGap,
        });
        recommendations.push({
          auditId: context.audit.id,
          projectId: context.project.id,
          userId: context.audit.userId,
          module: 'competitor',
          title: draft.title,
          description: `${row.competitor.name} has verified ${verifiedGap.label.toLowerCase()} coverage that the brand crawl did not find.`,
          severity: 'medium',
          impact: verifiedGap.competitorPageCount > 1 ? 'high' : 'medium',
          effort: 'medium',
          affectedUrl: verifiedGap.evidenceUrls[0] || null,
          evidence: {
            competitorId: row.competitor.id,
            competitorName: row.competitor.name,
            competitorDomain: row.competitor.domain,
            competitorGapKey: verifiedGap.key,
            ...verifiedGap,
          },
          confidence: '1.00',
          assetType: 'content_brief',
          generatedDraft: draft.content,
        });
      }
    }
    const [previousAudit] = await db
      .select()
      .from(aiVisibilityAuditsTable)
      .where(
        and(
          eq(aiVisibilityAuditsTable.projectId, context.project.id),
          eq(aiVisibilityAuditsTable.userId, context.audit.userId),
          ne(aiVisibilityAuditsTable.id, context.audit.id),
          inArray(aiVisibilityAuditsTable.status, ['completed', 'completed_with_warnings']),
        ),
      )
      .orderBy(desc(aiVisibilityAuditsTable.createdAt))
      .limit(1);
    const previous = previousAudit
      ? await db
          .select()
          .from(aiVisibilityRecommendationsTable)
          .where(eq(aiVisibilityRecommendationsTable.auditId, previousAudit.id))
      : [];
    const pages = await db
      .select()
      .from(aiVisibilityCrawledPagesTable)
      .where(
        and(
          eq(aiVisibilityCrawledPagesTable.auditId, context.audit.id),
          eq(aiVisibilityCrawledPagesTable.targetType, 'brand'),
        ),
      );
    const seoStage = await this.stageOutput(context.audit.id, 'seo_analysis');
    const reconciled = reconcileRecommendations(recommendations, previous, {
      auditId: context.audit.id,
      completedUrls:
        typeof seoStage.score === 'number'
          ? pages
              .filter((page: CrawledPageRecord) => page.crawlStatus === 'completed')
              .map((page: CrawledPageRecord) => page.finalUrl || page.url)
          : [],
      pageEvidence: pages.filter((page: CrawledPageRecord) => page.crawlStatus === 'completed'),
      siteChecksComplete:
        typeof seoStage.score === 'number' &&
        pages.length > 0 &&
        pages.every((page: CrawledPageRecord) => page.crawlStatus === 'completed'),
    });
    if (reconciled.length) await db.insert(aiVisibilityRecommendationsTable).values(reconciled);
    return {
      output: {
        recommendations: recommendations.length,
        generatedDrafts: recommendations.filter(
          (item: { generatedDraft: string | null }) => item.generatedDraft,
        ).length,
      },
    };
  }

  private async reportGeneration(context: AuditContext): Promise<StageResult> {
    const [score] = await db
      .select()
      .from(aiVisibilityScoreSnapshotsTable)
      .where(eq(aiVisibilityScoreSnapshotsTable.auditId, context.audit.id))
      .limit(1);
    if (!score) throw new Error('A score snapshot is required before report generation.');
    const issues = await db
      .select()
      .from(aiVisibilitySeoIssuesTable)
      .where(eq(aiVisibilitySeoIssuesTable.auditId, context.audit.id));
    const runs = await db
      .select()
      .from(aiVisibilityPromptRunsTable)
      .where(eq(aiVisibilityPromptRunsTable.auditId, context.audit.id));
    const recommendations = await db
      .select()
      .from(aiVisibilityRecommendationsTable)
      .where(eq(aiVisibilityRecommendationsTable.auditId, context.audit.id));
    const [pages, aeoQuestions, trackedCompetitors, competitorSnapshots, commerceSnapshots] =
      await Promise.all([
        db
          .select()
          .from(aiVisibilityCrawledPagesTable)
          .where(
            and(
              eq(aiVisibilityCrawledPagesTable.auditId, context.audit.id),
              eq(aiVisibilityCrawledPagesTable.userId, context.audit.userId),
              eq(aiVisibilityCrawledPagesTable.targetType, 'brand'),
            ),
          ),
        db
          .select()
          .from(aiVisibilityAeoQuestionsTable)
          .where(
            and(
              eq(aiVisibilityAeoQuestionsTable.projectId, context.project.id),
              eq(aiVisibilityAeoQuestionsTable.userId, context.audit.userId),
              eq(aiVisibilityAeoQuestionsTable.active, true),
            ),
          ),
        db
          .select()
          .from(aiVisibilityCompetitorsTable)
          .where(
            and(
              eq(aiVisibilityCompetitorsTable.projectId, context.project.id),
              eq(aiVisibilityCompetitorsTable.userId, context.audit.userId),
              eq(aiVisibilityCompetitorsTable.active, true),
            ),
          ),
        db
          .select()
          .from(aiVisibilityCompetitorSnapshotsTable)
          .where(
            and(
              eq(aiVisibilityCompetitorSnapshotsTable.auditId, context.audit.id),
              eq(aiVisibilityCompetitorSnapshotsTable.userId, context.audit.userId),
            ),
          ),
        db
          .select()
          .from(aiVisibilityCommerceSnapshotsTable)
          .where(
            and(
              eq(aiVisibilityCommerceSnapshotsTable.projectId, context.project.id),
              eq(aiVisibilityCommerceSnapshotsTable.userId, context.audit.userId),
              typeof context.audit.inputSnapshot.commerceSnapshotId === 'number'
                ? eq(
                    aiVisibilityCommerceSnapshotsTable.id,
                    context.audit.inputSnapshot.commerceSnapshotId,
                  )
                : context.audit.inputSnapshot.commerceSnapshotId === null
                  ? sql`false`
                  : lte(aiVisibilityCommerceSnapshotsTable.createdAt, context.audit.createdAt),
            ),
          )
          .orderBy(desc(aiVisibilityCommerceSnapshotsTable.createdAt))
          .limit(1),
      ]);
    const [toolkit] = context.project.brandToolkitId
      ? await db
          .select()
          .from(brandToolkitsTable)
          .where(
            and(
              eq(brandToolkitsTable.id, context.project.brandToolkitId),
              eq(brandToolkitsTable.userId, context.audit.userId),
            ),
          )
          .limit(1)
      : [];
    const [workspace] = await db
      .select({
        workspaceDefaults: aiVisibilityWorkspacesTable.whiteLabelDefaults,
        organizationDefaults: aiVisibilityOrganizationsTable.whiteLabelDefaults,
      })
      .from(aiVisibilityWorkspacesTable)
      .leftJoin(
        aiVisibilityOrganizationsTable,
        eq(aiVisibilityOrganizationsTable.id, aiVisibilityWorkspacesTable.organizationId),
      )
      .where(eq(aiVisibilityWorkspacesTable.id, context.project.workspaceId))
      .limit(1);
    const branding = resolveReportBranding(
      toolkit,
      context.project.name,
      workspace?.workspaceDefaults,
      workspace?.organizationDefaults,
    );
    const citations = runs.flatMap((run: PromptRunRecord): Citation[] => run.citations);
    const citedUrls: Citation[] = [
      ...new Map<string, Citation>(
        citations.map((citation: Citation): [string, Citation] => [citation.url, citation]),
      ).values(),
    ];
    const mentionedCompetitors = [
      ...new Set(runs.flatMap((run: PromptRunRecord) => run.competitors)),
    ];
    const scoringStage = await this.stageOutput(context.audit.id, 'scoring');
    const methodology = buildReportMethodology({
      correctionRevision: context.audit.correctionRevision,
      correctedAt: context.audit.correctedAt,
      scoringProfile: score.scoringProfile,
      scoringVersion: score.scoringVersion,
      inputFingerprint: score.inputFingerprint,
      overallScore: Number(score.overallScore),
      pillarStatuses: score.pillarStatuses,
      pillarScores: {
        seo: score.seoScore === null ? null : Number(score.seoScore),
        aeo: score.aeoScore === null ? null : Number(score.aeoScore),
        geo: score.geoScore === null ? null : Number(score.geoScore),
        commerce: score.commerceScore === null ? null : Number(score.commerceScore),
      },
      normalizedWeights:
        scoringStage.normalizedWeights &&
        typeof scoringStage.normalizedWeights === 'object' &&
        !Array.isArray(scoringStage.normalizedWeights)
          ? (scoringStage.normalizedWeights as Record<string, number>)
          : {},
      completedBrandPages: pages.filter(
        (page: CrawledPageRecord) => page.crawlStatus === 'completed',
      ).length,
      failedBrandPages: pages.filter((page: CrawledPageRecord) => page.crawlStatus !== 'completed')
        .length,
      seoIssues: issues.length,
      aeoQuestions: Array.isArray(context.audit.inputSnapshot.aeoQuestions)
        ? (
            context.audit.inputSnapshot.aeoQuestions as Array<{
              active: boolean;
            }>
          ).filter((item) => item.active).length
        : aeoQuestions.length,
      providerRuns: runs.map((run: PromptRunRecord) => ({
        provider: run.provider,
        model: run.model,
        fidelity: run.fidelity,
        status: run.status,
        citations: run.citations,
        brandMentioned: run.brandMentioned,
        extractionStatus: run.extractionStatus,
        error: run.error,
        extractionError: run.extractionError,
      })),
      trackedCompetitors: (await auditCompetitors(context.audit, trackedCompetitors)).length,
      competitorSnapshots: competitorSnapshots.length,
      commerceSnapshot: commerceSnapshots[0]
        ? {
            sourceType: commerceSnapshots[0].sourceType,
            sourceName: commerceSnapshots[0].sourceName,
            itemCount: commerceSnapshots[0].itemCount,
            validItemCount: commerceSnapshots[0].validItemCount,
            inputFingerprint: commerceSnapshots[0].inputFingerprint,
          }
        : null,
    });
    const providerRows = methodology.providers.length
      ? methodology.providers
          .map(
            (provider) =>
              `<tr><td>${escapeHtml(provider.provider)}</td><td>${escapeHtml(provider.models.join(', ') || 'No model')}</td><td>${escapeHtml(provider.fidelity.join(', ') || 'live_api')}</td><td>${provider.successful}</td><td>${provider.failed}</td><td>${provider.extracted}</td><td>${provider.citations}</td><td>${escapeHtml(provider.failureReasons.join(' | ') || 'None')}</td></tr>`,
          )
          .join('')
      : '<tr><td colspan="8">No provider observations were attempted.</td></tr>';
    const pillarCards = methodology.pillars
      .map(
        (pillar) =>
          `<div class="score">${escapeHtml(pillar.label)}<strong>${escapeHtml(reportPillarDisplay(pillar))}</strong><small>${escapeHtml(pillar.status.replaceAll('_', ' '))}</small></div>`,
      )
      .join('');
    const pillarRows = methodology.pillars
      .map(
        (pillar) =>
          `<tr><td>${escapeHtml(pillar.label)}</td><td>${escapeHtml(pillar.status.replaceAll('_', ' '))}</td><td>${escapeHtml(reportPillarDisplay(pillar))}</td><td>${escapeHtml(pillar.reason)}</td><td>${escapeHtml(pillar.formula)}</td></tr>`,
      )
      .join('');
    const weightSummary =
      Object.entries(methodology.scoring.normalizedWeights)
        .map(([pillar, weight]) => `${pillar.toUpperCase()} ${Math.round(Number(weight) * 100)}%`)
        .join(', ') || 'No scored pillar weights';
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>:root{--brand-primary:${branding.primaryColor};--brand-accent:${branding.accentColor}}body{font-family:Arial,sans-serif;color:#172033;padding:36px;font-size:12px;border-top:8px solid var(--brand-primary)}h1{font-size:28px;color:var(--brand-accent);margin-bottom:4px}.tagline{color:#5b6475;margin-top:0}h2{margin-top:28px;border-bottom:2px solid var(--brand-primary);padding-bottom:6px}.scores{display:flex;flex-wrap:wrap;gap:12px}.score{border:1px solid #dfe4ec;border-radius:10px;padding:16px;min-width:110px}.score strong{display:block;font-size:22px;color:var(--brand-primary);margin:4px 0}.score small{color:#697386;text-transform:capitalize}table{width:100%;border-collapse:collapse}td,th{border:1px solid #dfe4ec;padding:7px;text-align:left;vertical-align:top}.note{background:#f4f7fb;padding:12px;border-radius:8px}.url{word-break:break-all}li, tr{break-inside:avoid}thead{display:table-header-group}.footer{margin-top:30px;color:#697386;font-size:10px}</style></head><body><h1>${escapeHtml(branding.displayName)} — AI Visibility Audit</h1>${branding.tagline ? `<p class="tagline">${escapeHtml(branding.tagline)}</p>` : ''}<p>${escapeHtml(context.project.domain)} · Measured ${context.audit.createdAt.toISOString()} · PDF generated ${new Date().toISOString()}</p><div class="scores"><div class="score">Overall<strong>${escapeHtml(score.overallScore)}</strong><small>available pillars</small></div>${pillarCards}</div><h2>Measurement coverage</h2><p>Completed brand pages: ${methodology.coverage.completedBrandPages}; failed brand pages: ${methodology.coverage.failedBrandPages}; provider observations: ${methodology.coverage.providerObservations}; successful answers: ${methodology.coverage.successfulProviderAnswers}; schema-validated answers: ${methodology.coverage.extractedProviderAnswers}; citations: ${methodology.coverage.citations}; tracked competitors: ${methodology.coverage.trackedCompetitors}; competitor comparisons: ${methodology.coverage.competitorSnapshots}.</p><h2>Provider/API fidelity</h2><p class="note">${escapeHtml(methodology.disclosures.join(' '))}</p><table><thead><tr><th>Provider</th><th>Model(s)</th><th>Fidelity</th><th>Successful</th><th>Failed</th><th>Extracted</th><th>Citations</th><th>Failure reasons</th></tr></thead><tbody>${providerRows}</tbody></table><h2>Competitor measurement</h2><p><strong>${escapeHtml(methodology.competitors.status.replaceAll('_', ' '))}.</strong> ${escapeHtml(methodology.competitors.reason)}</p><p>${mentionedCompetitors.length ? `Organizations extracted from provider answers: ${mentionedCompetitors.map(escapeHtml).join(', ')}.` : 'No competitor organization was extracted from a schema-validated provider answer.'}</p><h2>Observed citations</h2><ol>${citedUrls.length ? citedUrls.map((citation: Citation) => `<li>${escapeHtml(citation.title || 'Source')}<br><span class="url">${escapeHtml(citation.url)}</span></li>`).join('') : '<li>No citation was returned by a successful live provider/API observation.</li>'}</ol><h2>Commerce measurement</h2><p><strong>${escapeHtml(methodology.commerce.status.replaceAll('_', ' '))}.</strong> ${escapeHtml(methodology.commerce.reason)}${methodology.commerce.status === 'measured' ? ` Source: ${escapeHtml(methodology.commerce.sourceType)} (${escapeHtml(methodology.commerce.sourceName)}), ${methodology.commerce.validItemCount} of ${methodology.commerce.itemCount} fully valid products.` : ''}</p><h2>SEO findings</h2><p>${issues.length} issue(s): ${issues.filter((item: SeoIssueRecord) => ['critical', 'high'].includes(item.severity)).length} high impact.</p><ol>${issues.map((item: SeoIssueRecord) => `<li><strong>${escapeHtml(item.ruleId)}</strong> — ${escapeHtml(item.recommendation)}<br><small>${escapeHtml(item.affectedUrl || 'Site-wide')}</small></li>`).join('')}</ol><h2>30-day action plan</h2><ol>${recommendations.map((item: RecommendationRecord) => `<li><strong>${escapeHtml(item.title)}</strong> (${escapeHtml(item.impact)} impact / ${escapeHtml(item.effort)} effort)<br>${escapeHtml(item.description)}</li>`).join('')}</ol><h2>Scoring methodology</h2><p>Scoring profile ${escapeHtml(methodology.scoring.profile)} v${methodology.scoring.version}. Effective weights after unavailable/not-applicable re-normalization: ${escapeHtml(weightSummary)}. Immutable input fingerprint: ${escapeHtml(methodology.scoring.inputFingerprint)}.</p><table><thead><tr><th>Pillar</th><th>Status</th><th>Result</th><th>Status reason</th><th>Formula and verified inputs</th></tr></thead><tbody>${pillarRows}</tbody></table><p class="footer">Prepared for ${escapeHtml(branding.displayName)}. Measurement methodology and provider-fidelity disclosures remain unchanged by report branding.</p></body></html>`;
    const { launchSystemChromium } = await import('../../utils/browserAutomation.js');
    const browser = await launchSystemChromium();
    let pdf: Uint8Array;
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle' });
      pdf = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: { top: '18mm', right: '15mm', bottom: '18mm', left: '15mm' },
      });
    } finally {
      await browser.close();
    }
    let upload: Awaited<ReturnType<typeof storageService.upload>>;
    try {
      upload = await storageService.upload(Buffer.from(pdf), {
        userId: context.audit.userId,
        category: 'document',
        originalName: `ai-visibility-audit-${context.audit.id}.pdf`,
        mimeType: 'application/pdf',
        referenceType: 'ai_visibility_report',
        referenceId: String(context.audit.id),
        storageKey: `${context.audit.userId}/document/ai-visibility/${context.audit.id}/report.pdf`,
        metadata: { projectId: context.project.id, auditId: context.audit.id },
      });
    } catch (error) {
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code || '')
          : '';
      if (code === 'EACCES') {
        throw new Error(
          'AI Visibility report storage is not writable. Run the upload-init service to repair the persistent uploads volume, then retry the PDF report.',
        );
      }
      throw error;
    }
    await db
      .insert(aiVisibilityReportsTable)
      .values({
        auditId: context.audit.id,
        projectId: context.project.id,
        userId: context.audit.userId,
        status: 'completed',
        storageKey: upload.storageKey,
        storageFileId: upload.fileId,
        sizeBytes: upload.fileSizeBytes,
        brandingSnapshot: branding,
        methodology,
        completedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: aiVisibilityReportsTable.auditId,
        set: {
          status: 'completed',
          storageKey: upload.storageKey,
          storageFileId: upload.fileId,
          sizeBytes: upload.fileSizeBytes,
          brandingSnapshot: branding,
          methodology,
          completedAt: new Date(),
          error: null,
        },
      });
    return {
      output: {
        reportId: context.audit.id,
        storageFileId: upload.fileId,
        sizeBytes: upload.fileSizeBytes,
      },
    };
  }

  private async alertDetection(context: AuditContext): Promise<StageResult> {
    const created: string[] = [];
    const insertAlert = async (alert: {
      type: string;
      severity: string;
      title: string;
      message: string;
      evidence: Record<string, unknown>;
    }) => {
      const [inserted] = await db
        .insert(aiVisibilityAlertsTable)
        .values({
          projectId: context.project.id,
          auditId: context.audit.id,
          userId: context.audit.userId,
          ...alert,
        })
        .onConflictDoNothing()
        .returning({ type: aiVisibilityAlertsTable.type });
      if (inserted) created.push(inserted.type);
    };
    const [previousAudit] = await db
      .select()
      .from(aiVisibilityAuditsTable)
      .where(
        and(
          eq(aiVisibilityAuditsTable.projectId, context.project.id),
          eq(aiVisibilityAuditsTable.userId, context.audit.userId),
          ne(aiVisibilityAuditsTable.id, context.audit.id),
          inArray(aiVisibilityAuditsTable.status, ['completed', 'completed_with_warnings']),
        ),
      )
      .orderBy(desc(aiVisibilityAuditsTable.createdAt))
      .limit(1);
    const [currentScore, currentRuns, currentIssues, highImpactRecommendations] = await Promise.all(
      [
        db
          .select()
          .from(aiVisibilityScoreSnapshotsTable)
          .where(
            and(
              eq(aiVisibilityScoreSnapshotsTable.auditId, context.audit.id),
              eq(aiVisibilityScoreSnapshotsTable.userId, context.audit.userId),
            ),
          )
          .limit(1)
          .then((rows: ScoreSnapshotRecord[]) => rows[0]),
        db
          .select()
          .from(aiVisibilityPromptRunsTable)
          .where(
            and(
              eq(aiVisibilityPromptRunsTable.auditId, context.audit.id),
              eq(aiVisibilityPromptRunsTable.status, 'completed'),
              inArray(aiVisibilityPromptRunsTable.extractionStatus, [
                'completed',
                'corrected',
                'cached',
              ]),
            ),
          ),
        db
          .select()
          .from(aiVisibilitySeoIssuesTable)
          .where(
            and(
              eq(aiVisibilitySeoIssuesTable.auditId, context.audit.id),
              eq(aiVisibilitySeoIssuesTable.userId, context.audit.userId),
            ),
          ),
        db
          .select()
          .from(aiVisibilityRecommendationsTable)
          .where(
            and(
              eq(aiVisibilityRecommendationsTable.auditId, context.audit.id),
              eq(aiVisibilityRecommendationsTable.userId, context.audit.userId),
              eq(aiVisibilityRecommendationsTable.impact, 'high'),
              inArray(aiVisibilityRecommendationsTable.status, ['open', 'in_progress']),
            ),
          ),
      ],
    );
    let previousScore: ScoreSnapshotRecord | undefined;
    let previousRuns: PromptRunRecord[] = [];
    let previousIssues: SeoIssueRecord[] = [];
    if (previousAudit) {
      [previousScore, previousRuns, previousIssues] = await Promise.all([
        db
          .select()
          .from(aiVisibilityScoreSnapshotsTable)
          .where(
            and(
              eq(aiVisibilityScoreSnapshotsTable.auditId, previousAudit.id),
              eq(aiVisibilityScoreSnapshotsTable.userId, context.audit.userId),
            ),
          )
          .limit(1)
          .then((rows: ScoreSnapshotRecord[]) => rows[0]),
        db
          .select()
          .from(aiVisibilityPromptRunsTable)
          .where(
            and(
              eq(aiVisibilityPromptRunsTable.auditId, previousAudit.id),
              eq(aiVisibilityPromptRunsTable.status, 'completed'),
              inArray(aiVisibilityPromptRunsTable.extractionStatus, [
                'completed',
                'corrected',
                'cached',
              ]),
            ),
          ),
        db
          .select()
          .from(aiVisibilitySeoIssuesTable)
          .where(
            and(
              eq(aiVisibilitySeoIssuesTable.auditId, previousAudit.id),
              eq(aiVisibilitySeoIssuesTable.userId, context.audit.userId),
            ),
          ),
      ]);
    }
    const brandPageUrls = async (auditId: number) =>
      (
        await db
          .select({
            url: aiVisibilityCrawledPagesTable.url,
            finalUrl: aiVisibilityCrawledPagesTable.finalUrl,
          })
          .from(aiVisibilityCrawledPagesTable)
          .where(
            and(
              eq(aiVisibilityCrawledPagesTable.auditId, auditId),
              eq(aiVisibilityCrawledPagesTable.userId, context.audit.userId),
              eq(aiVisibilityCrawledPagesTable.targetType, 'brand'),
              eq(aiVisibilityCrawledPagesTable.crawlStatus, 'completed'),
            ),
          )
      ).map((page: { url: string; finalUrl: string | null }) => page.finalUrl || page.url);
    const [currentPageUrls, previousPageUrls] = await Promise.all([
      brandPageUrls(context.audit.id),
      previousAudit ? brandPageUrls(previousAudit.id) : Promise.resolve([] as string[]),
    ]);
    const alertCandidates = deriveVisibilityAlerts({
      currentScore: currentScore ? Number(currentScore.overallScore) : null,
      previousScore: previousScore ? Number(previousScore.overallScore) : null,
      currentRuns,
      previousRuns,
      currentIssues,
      previousIssues,
      highImpactRecommendations,
      auditedNames: [context.project.name, ...context.project.brandAliases],
      hasPreviousAudit: Boolean(previousAudit),
      currentPageUrls,
      previousPageUrls,
    });
    for (const alert of alertCandidates) {
      await insertAlert(alert);
    }
    return { output: { alerts: created } };
  }

  private async finalSnapshot(context: AuditContext): Promise<StageResult> {
    const [score] = await db
      .select()
      .from(aiVisibilityScoreSnapshotsTable)
      .where(eq(aiVisibilityScoreSnapshotsTable.auditId, context.audit.id))
      .limit(1);
    const [{ count: issues }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(aiVisibilitySeoIssuesTable)
      .where(eq(aiVisibilitySeoIssuesTable.auditId, context.audit.id));
    const [{ count: recommendations }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(aiVisibilityRecommendationsTable)
      .where(eq(aiVisibilityRecommendationsTable.auditId, context.audit.id));
    const summary = {
      overallScore: score ? Number(score.overallScore) : null,
      seoScore: score?.seoScore ? Number(score.seoScore) : null,
      aeoScore: score?.aeoScore ? Number(score.aeoScore) : null,
      geoScore: score?.geoScore ? Number(score.geoScore) : null,
      commerceStatus: score?.pillarStatuses.commerce || 'not_applicable',
      issues: Number(issues || 0),
      recommendations: Number(recommendations || 0),
    };
    await db
      .update(aiVisibilityAuditsTable)
      .set({ summary, updatedAt: new Date() })
      .where(eq(aiVisibilityAuditsTable.id, context.audit.id));
    return { output: summary };
  }

  private async stageOutput(auditId: number, stageKey: string): Promise<Record<string, unknown>> {
    const [stage] = await db
      .select({ output: aiVisibilityAuditStagesTable.output })
      .from(aiVisibilityAuditStagesTable)
      .where(
        and(
          eq(aiVisibilityAuditStagesTable.auditId, auditId),
          eq(aiVisibilityAuditStagesTable.stageKey, stageKey),
        ),
      )
      .limit(1);
    return stage?.output || {};
  }

  private async cancelRemaining(auditId: number, userId: number) {
    await db
      .update(aiVisibilityAuditStagesTable)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiVisibilityAuditStagesTable.auditId, auditId),
          inArray(aiVisibilityAuditStagesTable.status, ['pending', 'running']),
        ),
      );
    await db
      .update(aiVisibilityAuditsTable)
      .set({
        status: 'cancelled',
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(eq(aiVisibilityAuditsTable.id, auditId), eq(aiVisibilityAuditsTable.userId, userId)),
      );
  }

  private async settle(auditId: number, userId: number, status: string) {
    const audit = await this.loadAudit(auditId, userId);
    if (audit.settledAt) return;
    const [{ count: pages }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(aiVisibilityCrawledPagesTable)
      .where(eq(aiVisibilityCrawledPagesTable.auditId, auditId));
    const [{ count: prompts }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(aiVisibilityPromptRunsTable)
      .where(
        and(
          eq(aiVisibilityPromptRunsTable.auditId, auditId),
          eq(aiVisibilityPromptRunsTable.status, 'completed'),
          isNull(aiVisibilityPromptRunsTable.cachedFromRunId),
        ),
      );
    const [{ count: extractions }] = await db
      .select({ count: sql<number>`count(*)` })
      .from(aiVisibilityPromptRunsTable)
      .where(
        and(
          eq(aiVisibilityPromptRunsTable.auditId, auditId),
          eq(aiVisibilityPromptRunsTable.extractionStatus, 'completed'),
          eq(aiVisibilityPromptRunsTable.extractionMethod, 'structured_llm_v1'),
        ),
      );
    const [report] = await db
      .select({ id: aiVisibilityReportsTable.id })
      .from(aiVisibilityReportsTable)
      .where(
        and(
          eq(aiVisibilityReportsTable.auditId, auditId),
          eq(aiVisibilityReportsTable.status, 'completed'),
        ),
      )
      .limit(1);
    const [baseCost, crawlCost, promptCost, extractionCost, reportCost] = await Promise.all([
      getCreditCost(
        audit.trigger === 'monitoring'
          ? 'ai_visibility_monitoring_base'
          : 'ai_visibility_audit_base',
      ),
      getCreditCost('ai_visibility_crawl_page'),
      getCreditCost('ai_visibility_provider_prompt'),
      getCreditCost('ai_visibility_extraction'),
      getCreditCost('ai_visibility_report'),
    ]);
    const consumedWork =
      Number(pages) > 0 || Number(prompts) > 0 || Number(extractions) > 0 || Boolean(report);
    const calculatedCredits =
      !consumedWork && ['failed', 'cancelled'].includes(status)
        ? 0
        : Math.round(
            (baseCost +
              Number(pages) * crawlCost +
              Number(prompts) * promptCost +
              Number(extractions) * extractionCost +
              (report ? reportCost : 0)) *
              100,
          ) / 100;
    if (audit.billingMode === 'reservation' && audit.reservationTransactionId) {
      const actualCredits = Math.min(Number(audit.reservedCredits), calculatedCredits);
      const settlement = await creditService.settleReservation({
        userId,
        transactionId: audit.reservationTransactionId,
        actualCredits,
        description: `AI Visibility audit ${auditId} credit settlement`,
      });
      if (!settlement.success) throw new Error(settlement.error || 'Credit settlement failed.');
      await db
        .update(aiVisibilityAuditsTable)
        .set({
          actualCredits: actualCredits.toFixed(2),
          settledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityAuditsTable.id, auditId),
            eq(aiVisibilityAuditsTable.userId, userId),
            sql`${aiVisibilityAuditsTable.settledAt} IS NULL`,
          ),
        );
      return;
    }

    if (
      !consumedWork &&
      ['failed', 'cancelled'].includes(status) &&
      audit.initialChargeTransactionId
    ) {
      const refund = await creditService.refundDeduction({
        userId,
        transactionId: audit.initialChargeTransactionId,
        description: `AI Visibility audit ${auditId} did not consume billable work`,
      });
      if (!refund.success) throw new Error(refund.error || 'Credit refund failed.');
    } else {
      const alreadyCharged = Number(audit.actualCredits);
      const additionalCredits = Math.max(
        0,
        Math.round((calculatedCredits - alreadyCharged) * 100) / 100,
      );
      if (additionalCredits > 0) {
        const deduction = await creditService.deductOnceForResource({
          userId,
          eventKey: 'ai_visibility_audit_usage',
          overrideAmount: additionalCredits,
          // The audit work has run: bill the remainder even on a low balance.
          allowOverdraft: true,
          description: `AI Visibility audit ${auditId} completed usage`,
          service: 'ai_visibility',
          referenceType: 'ai_visibility_audit_usage',
          referenceId: String(auditId),
          metadata: {
            auditId,
            pages: Number(pages),
            providerRequests: Number(prompts),
            extractionRequests: Number(extractions),
            reportGenerated: Boolean(report),
          },
        });
        if (!deduction.success)
          throw new Error(deduction.error || 'Direct wallet usage charge failed.');
      }
    }
    await db
      .update(aiVisibilityAuditsTable)
      .set({
        actualCredits: calculatedCredits.toFixed(2),
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiVisibilityAuditsTable.id, auditId),
          eq(aiVisibilityAuditsTable.userId, userId),
          sql`${aiVisibilityAuditsTable.settledAt} IS NULL`,
        ),
      );
  }
}

export const auditOrchestrator = new AuditOrchestrator();
