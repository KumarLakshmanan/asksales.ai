import { requireBusinessScope } from '../../tenancy/businessContext.js';
import { platformAIQuotaMessage } from '../../../shared/assistantModelCatalog.js';
import { classifyLLMProviderFailure } from '../agents/LLMProviderErrors.js';
import { auditCompetitors, AUTOMATIC_COMPETITOR_LIMIT } from './CompetitorDiscoveryService.js';
import {
  latestCompletedAudit,
  providerCoverage,
  isProviderAvailabilityFailure,
} from './measurement.js';
import { createHash, randomBytes } from 'node:crypto';
import { and, desc, eq, gt, lte, inArray, isNull, sql, getTableColumns } from 'drizzle-orm';
import { buildSeoSiteSummary, measurementRuleVersion } from './SeoSiteSummary.js';
import { projectSettingsChanged } from './projectSettings.js';
import {
  alertRecommendationIds,
  isWithdrawnGapFix,
  isWithdrawnLegacyRecommendation,
  isWithdrawnLegacyRobotsFinding,
  withoutWithdrawnFixes,
} from './LegacyFindingCorrections.js';
import { SEO_RULE_VERSION } from './SeoEngine.js';
import { db } from '../../models/db.js';
import {
  AI_VISIBILITY_STAGE_KEYS,
  aiVisibilityAeoQuestionsTable,
  aiVisibilityAssetVersionsTable,
  aiVisibilityAlertsTable,
  aiVisibilityAuditStagesTable,
  aiVisibilityAuditsTable,
  aiVisibilityCompetitorsTable,
  aiVisibilityCompetitorSnapshotsTable,
  aiVisibilityCommerceSnapshotsTable,
  aiVisibilityCrawledPagesTable,
  aiVisibilityExtractionCorrectionsTable,
  aiVisibilityGeneratedAssetLinksTable,
  aiVisibilityProjectsTable,
  aiVisibilityPromptRunsTable,
  aiVisibilityPromptsTable,
  aiVisibilityRecommendationsTable,
  aiVisibilityReportDeliveriesTable,
  aiVisibilityReportsTable,
  aiVisibilityReportSharesTable,
  aiVisibilityScoreSnapshotsTable,
  aiVisibilitySeoIssuesTable,
  aiVisibilityWorkspaceMembershipsTable,
  aiVisibilityWorkspacesTable,
  type AiVisibilityProfile,
  type RecommendationStatus,
} from '../../models/aiVisibility/schema.js';
import { brandToolkitsTable } from '../../models/brandToolkits/schema.js';
import { companySettings } from '../../models/companySettings/schema.js';
import { usersTable } from '../../models/users/schema.js';
import { contentAssetsTable } from '../../models/contentAssets/schema.js';
import { getCreditCost } from '../../models/creditPricing/functions.js';
import { getBalance } from '../../models/wallets/functions.js';
import { creditService } from '../CreditService.js';
import { emailService } from '../emailService.js';
import { storageService } from '../StorageService.js';
import { parseAndValidateCommerceFeed } from './CommerceFeedService.js';
import { fetchWooCommerceCatalog, WooCommerceCatalogError } from './WooCommerceCatalogService.js';
import { buildCompetitorSuggestions } from './CompetitorSuggestionService.js';
import {
  analyzeAeoCoverage,
  buildGroundedAeoAsset,
  validateFaqPageJsonLd,
  type AeoAssetType,
} from './AeoCoverageService.js';
import {
  buildCounterContentBrief,
  deriveCompetitorIntelligence,
} from './CompetitorIntelligenceService.js';
import { buildAiVisibilityCsv } from './ReportExportService.js';
import {
  AiVisibilityDomainValidationError,
  normalizeDomain as normalizeDomainValue,
} from './domain.js';
import { shopifyCatalogService } from './ShopifyCatalogService.js';
import {
  providerObservationService,
} from './ProviderObservationService.js';
import { escapeHtmlValue as escapeEmailHtml } from '../../../shared/html.js';
import { type ExtractionCorrection } from '../../../shared/aiVisibilityTypes.js';
export type { ExtractionCorrection };

export { normalizeDomain } from './domain.js';

export class AiVisibilityNotFoundError extends Error {}
export class AiVisibilityValidationError extends Error {}
export class AiVisibilityDeliveryError extends Error {}
export class AiVisibilityConflictError extends Error {}

export interface ProjectInput {
  name: string;
  domain: string;
  brandAliases?: string[];
  category?: string | null;
  scoringProfile?: AiVisibilityProfile;
  country?: string;
  locale?: string;
  targetGeography?: string | null;
  businessProfileId?: number | null;
  brandToolkitId?: number | null;
  geoPrompts?: import('../../models/aiVisibility/schema.js').CustomGeoPrompt[];
}

export interface WebsiteSearchInput {
  website: string;
  name?: string;
  brandAliases?: string[];
  category?: string | null;
  scoringProfile?: AiVisibilityProfile;
  country?: string;
  locale?: string;
  targetGeography?: string | null;
}

export interface AuditEstimate {
  /** Backwards-compatible alias for temporaryHold. */
  reservedCredits: number;
  temporaryHold: number;
  estimatedMaximum: number;
  directBaseCharge: number;
  walletBalance: number;
  expectedActual: number | null;
  expectedActualBasis: 'audit_history' | 'unavailable';
  assumptions: {
    brandPageLimit: number;
    competitorPageLimit: number;
    maxBrandPages: number;
    competitors: number;
    automaticCompetitorLimit: number;
    prompts: number;
    providers: number;
    providerRequests: number;
    extractionRequests: number;
    reportCount: number;
  };
  providerReadiness: Awaited<ReturnType<typeof providerObservationService.readiness>>;
  pricing: Record<string, number>;
  lineItems: Array<{
    key: string;
    units: number;
    creditsPerUnit: number;
    maximumCredits: number;
  }>;
}

function normalizeProjectDomain(value: string): string {
  try {
    return normalizeDomainValue(value);
  } catch (error) {
    if (error instanceof AiVisibilityDomainValidationError) {
      throw new AiVisibilityValidationError(error.message);
    }
    throw error;
  }
}

function cleanAliases(values: string[] | undefined): string[] {
  return [...new Set((values || []).map((value) => value.trim()).filter(Boolean))].slice(0, 20);
}

function preferredName(profile: typeof companySettings.$inferSelect): string {
  return (
    [profile.companyName, profile.businessName, profile.name, profile.ownerName]
      .map((value) => value?.trim())
      .find((value): value is string => Boolean(value)) || 'Business profile'
  );
}

function normalizedProfileWebsite(profile: typeof companySettings.$inferSelect): string | null {
  if (!profile.website?.trim()) return null;
  try {
    return normalizeProjectDomain(profile.website);
  } catch {
    return null;
  }
}

function profileGeography(profile: typeof companySettings.$inferSelect): string | null {
  const direct = [profile.city, profile.state, profile.country]
    .map((value) => value?.trim())
    .filter(Boolean)
    .join(', ');
  if (direct) return direct;
  try {
    const regions = JSON.parse(profile.targetRegions || '[]');
    return Array.isArray(regions)
      ? regions
          .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()))
          .join(', ') || null
      : null;
  } catch {
    return null;
  }
}

function profileCountry(profile: typeof companySettings.$inferSelect): string {
  const raw = profile.country?.trim().toUpperCase();
  const country = raw === 'INDIA' ? 'IN' : raw === 'UNITED STATES' ? 'US' : raw;
  return country && /^[A-Z]{2}$/.test(country) ? country : 'US';
}

function profileValues(profile: typeof companySettings.$inferSelect, toolkitId: number | null) {
  const website = normalizedProfileWebsite(profile);
  if (!website)
    throw new AiVisibilityValidationError(
      'Add a valid public website to this Business Profile before running an AI Visibility audit.',
    );
  return {
    name: preferredName(profile),
    domain: website,
    brandAliases: cleanAliases([
      profile.companyName || '',
      profile.businessName || '',
      profile.name || '',
    ]),
    category:
      profile.subIndustry?.trim() ||
      profile.industry?.trim() ||
      profile.businessCategory?.trim() ||
      null,
    scoringProfile: 'general' as AiVisibilityProfile,
    country: profileCountry(profile),
    locale: profileCountry(profile) === 'IN' ? 'en-IN' : 'en-US',
    targetGeography: profileGeography(profile),
    businessProfileId: profile.id,
    brandToolkitId: toolkitId,
    source: 'business_profile' as const,
  };
}

async function assertRelatedOwnership(
  userId: number,
  businessProfileId?: number | null,
  brandToolkitId?: number | null,
) {
  if (businessProfileId) {
    const [record] = await db
      .select({ id: companySettings.id })
      .from(companySettings)
      .where(and(eq(companySettings.id, businessProfileId), eq(companySettings.userId, userId)))
      .limit(1);
    if (!record)
      throw new AiVisibilityValidationError('Business profile does not belong to this account.');
  }
  if (brandToolkitId) {
    const [record] = await db
      .select({ id: brandToolkitsTable.id })
      .from(brandToolkitsTable)
      .where(and(eq(brandToolkitsTable.id, brandToolkitId), eq(brandToolkitsTable.userId, userId)))
      .limit(1);
    if (!record)
      throw new AiVisibilityValidationError('Brand Toolkit does not belong to this account.');
  }
}

async function createPrivateWorkspace(
  tx: typeof db,
  userId: number,
  name: string,
): Promise<number> {
  const scope = requireBusinessScope();
  if (scope.userId !== userId) throw new AiVisibilityValidationError('Business ownership mismatch.');
  // Serialize adapter creation per business. Website projects share this identity.
  await tx.execute(sql`SELECT id FROM company_settings WHERE id=${scope.businessProfileId} AND user_id=${userId} FOR UPDATE`);
  const [existing] = await tx.select({id:aiVisibilityWorkspacesTable.id}).from(aiVisibilityWorkspacesTable)
    .where(and(eq(aiVisibilityWorkspacesTable.businessProfileId,scope.businessProfileId),
      eq(aiVisibilityWorkspacesTable.ownerUserId,userId),eq(aiVisibilityWorkspacesTable.status,'active'))).limit(1);
  if (existing) return existing.id;
  const [workspace] = await tx
    .insert(aiVisibilityWorkspacesTable)
    .values({
      ownerUserId: userId,
      businessProfileId: scope.businessProfileId,
      name: name.trim() || 'AI Visibility website',
      kind: 'private',
    })
    .returning({ id: aiVisibilityWorkspacesTable.id });
  await tx.insert(aiVisibilityWorkspaceMembershipsTable).values({
    workspaceId: workspace.id,
    userId,
    role: 'owner',
    status: 'active',
    invitedByUserId: userId,
  });
  return workspace.id;
}

export class AiVisibilityService {
  async listProjects(userId: number) {
    return db
      .select()
      .from(aiVisibilityProjectsTable)
      .where(
        and(
          eq(aiVisibilityProjectsTable.userId, userId),
          eq(aiVisibilityProjectsTable.status, 'active'),
        ),
      )
      .orderBy(desc(aiVisibilityProjectsTable.updatedAt));
  }

  async listWebsiteSearches(userId: number) {
    const projects = await this.listProjects(userId);
    const [audits, scores] = await Promise.all([
      db
        .select()
        .from(aiVisibilityAuditsTable)
        .where(eq(aiVisibilityAuditsTable.userId, userId))
        .orderBy(desc(aiVisibilityAuditsTable.createdAt)),
      db
        .select()
        .from(aiVisibilityScoreSnapshotsTable)
        .where(eq(aiVisibilityScoreSnapshotsTable.userId, userId))
        .orderBy(desc(aiVisibilityScoreSnapshotsTable.createdAt)),
    ]);
    return projects.map((project: typeof aiVisibilityProjectsTable.$inferSelect) => {
      const projectAudits = audits.filter(
        (audit: typeof aiVisibilityAuditsTable.$inferSelect) => audit.projectId === project.id,
      );
      const latestAudit = projectAudits[0] || null;
      const latestScore =
        scores.find(
          (score: typeof aiVisibilityScoreSnapshotsTable.$inferSelect) =>
            score.projectId === project.id,
        ) || null;
      return {
        project,
        auditCount: projectAudits.length,
        latestAudit,
        latestScore,
      };
    });
  }

  async resolveWebsiteSearch(userId: number, value: string | WebsiteSearchInput) {
    const input = typeof value === 'string' ? { website: value } : value;
    const domain = normalizeProjectDomain(input.website);
    const existing = (await this.listProjects(userId)).find(
      (project: typeof aiVisibilityProjectsTable.$inferSelect) => project.domain === domain,
    );
    if (existing) {
      const editable = existing.source === 'website_search';
      const [updated] = await db
        .update(aiVisibilityProjectsTable)
        .set({
          ...(editable && input.name ? { name: input.name.trim() } : {}),
          ...(editable && input.brandAliases
            ? { brandAliases: cleanAliases(input.brandAliases) }
            : {}),
          ...(editable && input.category !== undefined
            ? { category: input.category?.trim() || null }
            : {}),
          ...(editable && input.scoringProfile ? { scoringProfile: input.scoringProfile } : {}),
          ...(editable && input.country ? { country: input.country.toUpperCase() } : {}),
          ...(editable && input.locale ? { locale: input.locale } : {}),
          ...(editable && input.targetGeography !== undefined
            ? { targetGeography: input.targetGeography?.trim() || null }
            : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityProjectsTable.id, existing.id),
            eq(aiVisibilityProjectsTable.userId, userId),
          ),
        )
        .returning();
      return { project: updated || existing, created: false };
    }
    const hostname = new URL(domain).hostname.replace(/^www\./, '');
    const name =
      input.name?.trim() ||
      hostname
        .split('.')[0]
        ?.replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, (letter) => letter.toUpperCase()) ||
      hostname;
    try {
      const project = await db.transaction(async (tx: typeof db) => {
        const workspaceId = await createPrivateWorkspace(tx, userId, name);
        const [created] = await tx
          .insert(aiVisibilityProjectsTable)
          .values({
            workspaceId,
            userId,
            name,
            domain,
            brandAliases: cleanAliases(
              input.brandAliases?.length ? input.brandAliases : [name, hostname],
            ),
            category: input.category?.trim() || null,
            scoringProfile: input.scoringProfile || 'general',
            country: (input.country || 'US').toUpperCase(),
            locale: input.locale || 'en-US',
            targetGeography: input.targetGeography?.trim() || null,
            source: 'website_search',
          })
          .returning();
        return created;
      });
      return { project, created: true };
    } catch (error) {
      if ((error as { code?: string })?.code === '23505') {
        const [raced] = await db
          .select()
          .from(aiVisibilityProjectsTable)
          .where(
            and(
              eq(aiVisibilityProjectsTable.userId, userId),
              eq(aiVisibilityProjectsTable.domain, domain),
              eq(aiVisibilityProjectsTable.source, 'website_search'),
              eq(aiVisibilityProjectsTable.status, 'active'),
            ),
          )
          .limit(1);
        if (raced) return { project: raced, created: false };
      }
      throw error;
    }
  }

  async getProject(userId: number, projectId: number) {
    const [project] = await db
      .select()
      .from(aiVisibilityProjectsTable)
      .where(
        and(
          eq(aiVisibilityProjectsTable.id, projectId),
          eq(aiVisibilityProjectsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!project) throw new AiVisibilityNotFoundError('AI Visibility project not found.');
    return project;
  }

  async archiveProject(userId: number, projectId: number) {
    const [project] = await db
      .select()
      .from(aiVisibilityProjectsTable)
      .where(
        and(
          eq(aiVisibilityProjectsTable.id, projectId),
          eq(aiVisibilityProjectsTable.userId, userId),
          eq(aiVisibilityProjectsTable.status, 'active'),
        ),
      )
      .limit(1);
    if (!project) throw new AiVisibilityNotFoundError('AI Visibility project not found.');
    if (project.source === 'business_profile' || project.businessProfileId) {
      throw new AiVisibilityValidationError(
        'The Business Profile website cannot be removed from AI Visibility. Update its website in the Business Profile instead.',
      );
    }

    const [archived] = await db
      .update(aiVisibilityProjectsTable)
      .set({
        status: 'archived',
        monitoringEnabled: false,
        nextMonitoringAt: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiVisibilityProjectsTable.id, projectId),
          eq(aiVisibilityProjectsTable.userId, userId),
          eq(aiVisibilityProjectsTable.status, 'active'),
          sql`NOT EXISTS (
        SELECT 1
        FROM ${aiVisibilityAuditsTable}
        WHERE ${aiVisibilityAuditsTable.projectId} = ${projectId}
          AND ${aiVisibilityAuditsTable.userId} = ${userId}
          AND ${aiVisibilityAuditsTable.status} IN ('queued', 'running')
      )`,
        ),
      )
      .returning();
    if (!archived) {
      throw new AiVisibilityValidationError(
        'Cancel or wait for the active analysis before removing this website.',
      );
    }
    return archived;
  }

  async listBusinessProfiles(userId: number) {
    return db
      .select()
      .from(companySettings)
      .where(and(eq(companySettings.userId, userId), eq(companySettings.id, requireBusinessScope().businessProfileId), eq(companySettings.isApproved, true)))
      .orderBy(desc(companySettings.isDefault), desc(companySettings.updatedAt));
  }

  private async matchingToolkit(userId: number, profile: typeof companySettings.$inferSelect) {
    const toolkits = await db
      .select()
      .from(brandToolkitsTable)
      .where(
        and(
          eq(brandToolkitsTable.userId, userId),
          eq(brandToolkitsTable.isActive, true),
          eq(brandToolkitsTable.isApproved, true),
        ),
      )
      .orderBy(desc(brandToolkitsTable.isDefault), desc(brandToolkitsTable.updatedAt));
    const website = normalizedProfileWebsite(profile);
    return (
      toolkits.find(
        (toolkit: typeof brandToolkitsTable.$inferSelect) =>
          website &&
          normalizedProfileWebsite({
            ...profile,
            website: toolkit.website,
          } as typeof profile) === website,
      ) ||
      toolkits.find((toolkit: typeof brandToolkitsTable.$inferSelect) => toolkit.isDefault) ||
      null
    );
  }

  private async refreshProfileProject(
    userId: number,
    project: typeof aiVisibilityProjectsTable.$inferSelect,
  ) {
    if (!project.businessProfileId || project.configurationRevision > 1) return project;
    const [profile] = await db
      .select()
      .from(companySettings)
      .where(
        and(
          eq(companySettings.id, project.businessProfileId),
          eq(companySettings.userId, userId),
          eq(companySettings.isApproved, true),
        ),
      )
      .limit(1);
    if (!profile) return project;
    const toolkit = await this.matchingToolkit(userId, profile);
    const values = profileValues(profile, toolkit?.id || null);
    const [updated] = await db
      .update(aiVisibilityProjectsTable)
      .set({ ...values, updatedAt: new Date() })
      .where(
        and(
          eq(aiVisibilityProjectsTable.id, project.id),
          eq(aiVisibilityProjectsTable.userId, userId),
        ),
      )
      .returning();
    return updated || project;
  }

  /** Resolves one durable workspace from a selected/default Business Profile. */
  async resolveProject(userId: number, requestedBusinessProfileId?: number | null) {
    const profiles = await this.listBusinessProfiles(userId);
    const profile = requestedBusinessProfileId
      ? profiles.find(
          (item: typeof companySettings.$inferSelect) => item.id === requestedBusinessProfileId,
        )
      : profiles[0];
    if (requestedBusinessProfileId && !profile)
      throw new AiVisibilityNotFoundError('Business Profile not found.');
    if (!profile)
      return {
        project: null,
        profile: null,
        toolkit: null,
        provisioned: false,
        missingWebsite: false,
      };
    if (!normalizedProfileWebsite(profile))
      return {
        project: null,
        profile,
        toolkit: null,
        provisioned: false,
        missingWebsite: true,
      };

    const toolkit = await this.matchingToolkit(userId, profile);
    const [linked] = await db
      .select()
      .from(aiVisibilityProjectsTable)
      .where(
        and(
          eq(aiVisibilityProjectsTable.userId, userId),
          eq(aiVisibilityProjectsTable.businessProfileId, profile.id),
          eq(aiVisibilityProjectsTable.status, 'active'),
        ),
      )
      .limit(1);
    if (linked)
      return {
        project: await this.refreshProfileProject(userId, linked),
        profile,
        toolkit,
        provisioned: false,
        missingWebsite: false,
      };

    const website = normalizedProfileWebsite(profile)!;
    const legacy = (
      await db
        .select()
        .from(aiVisibilityProjectsTable)
        .where(
          and(
            eq(aiVisibilityProjectsTable.userId, userId),
            eq(aiVisibilityProjectsTable.status, 'active'),
            sql`${aiVisibilityProjectsTable.businessProfileId} IS NULL`,
          ),
        )
    ).find(
      (candidate: typeof aiVisibilityProjectsTable.$inferSelect) => candidate.domain === website,
    );
    const values = profileValues(profile, toolkit?.id || null);
    if (legacy) {
      const [updated] = await db
        .update(aiVisibilityProjectsTable)
        .set({ ...values, updatedAt: new Date() })
        .where(
          and(
            eq(aiVisibilityProjectsTable.id, legacy.id),
            eq(aiVisibilityProjectsTable.userId, userId),
          ),
        )
        .returning();
      return {
        project: updated,
        profile,
        toolkit,
        provisioned: false,
        missingWebsite: false,
      };
    }
    const project = await db.transaction(async (tx: typeof db) => {
      const workspaceId = await createPrivateWorkspace(tx, userId, values.name);
      const [created] = await tx
        .insert(aiVisibilityProjectsTable)
        .values({ workspaceId, userId, ...values })
        .returning();
      return created;
    });
    return {
      project,
      profile,
      toolkit,
      provisioned: true,
      missingWebsite: false,
    };
  }

  async createProject(userId: number, input: ProjectInput) {
    await assertRelatedOwnership(userId, input.businessProfileId, input.brandToolkitId);
    return db.transaction(async (tx: typeof db) => {
      const name = input.name.trim();
      const workspaceId = await createPrivateWorkspace(tx, userId, name);
      const [project] = await tx
        .insert(aiVisibilityProjectsTable)
        .values({
          workspaceId,
          userId,
          name,
          domain: normalizeProjectDomain(input.domain),
          brandAliases: cleanAliases(input.brandAliases),
          category: input.category?.trim() || null,
          scoringProfile: input.scoringProfile || 'general',
          country: (input.country || 'US').toUpperCase(),
          locale: input.locale || 'en-US',
          targetGeography: input.targetGeography?.trim() || null,
          businessProfileId: input.businessProfileId || null,
          brandToolkitId: input.brandToolkitId || null,
        })
        .returning();
      return project;
    });
  }

  async updateProject(userId: number, projectId: number, input: Partial<ProjectInput>) {
    const current = await this.getProject(userId, projectId);
    await assertRelatedOwnership(userId, input.businessProfileId, input.brandToolkitId);
    const update: Record<string, unknown> = {};
    if (input.geoPrompts !== undefined) update.geoPrompts = input.geoPrompts;
    if (input.name !== undefined) update.name = input.name.trim();
    if (input.domain !== undefined) update.domain = normalizeProjectDomain(input.domain);
    if (input.brandAliases !== undefined) update.brandAliases = cleanAliases(input.brandAliases);
    if (input.category !== undefined) update.category = input.category?.trim() || null;
    if (input.scoringProfile !== undefined) update.scoringProfile = input.scoringProfile;
    if (input.country !== undefined) update.country = input.country.toUpperCase();
    if (input.locale !== undefined) update.locale = input.locale;
    if (input.targetGeography !== undefined)
      update.targetGeography = input.targetGeography?.trim() || null;
    if (input.businessProfileId !== undefined) update.businessProfileId = input.businessProfileId;
    if (input.brandToolkitId !== undefined) update.brandToolkitId = input.brandToolkitId;
    if (!projectSettingsChanged(current, update)) return current;
    const [project] = await db
      .update(aiVisibilityProjectsTable)
      .set({
        ...update,
        updatedAt: new Date(),
        configurationRevision: sql`${aiVisibilityProjectsTable.configurationRevision} + 1`,
      })
      .where(
        and(
          eq(aiVisibilityProjectsTable.id, projectId),
          eq(aiVisibilityProjectsTable.userId, userId),
        ),
      )
      .returning();
    return project;
  }

  async listCompetitors(userId: number, projectId: number) {
    await this.getProject(userId, projectId);
    return db
      .select()
      .from(aiVisibilityCompetitorsTable)
      .where(
        and(
          eq(aiVisibilityCompetitorsTable.projectId, projectId),
          eq(aiVisibilityCompetitorsTable.userId, userId),
        ),
      )
      .orderBy(desc(aiVisibilityCompetitorsTable.active), aiVisibilityCompetitorsTable.name);
  }

  async suggestCompetitors(userId: number, projectId: number) {
    const project = await this.getProject(userId, projectId);
    const [existingCompetitors, profileRows, observations] = await Promise.all([
      this.listCompetitors(userId, projectId),
      project.businessProfileId
        ? db
            .select({ referenceAccounts: companySettings.referenceAccounts })
            .from(companySettings)
            .where(
              and(
                eq(companySettings.id, project.businessProfileId),
                eq(companySettings.userId, userId),
                eq(companySettings.isApproved, true),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
      db
        .select({
          id: aiVisibilityPromptRunsTable.id,
          provider: aiVisibilityPromptRunsTable.provider,
          competitors: aiVisibilityPromptRunsTable.competitors,
          citations: aiVisibilityPromptRunsTable.citations,
          capturedAt: aiVisibilityPromptRunsTable.capturedAt,
        })
        .from(aiVisibilityPromptRunsTable)
        .innerJoin(
          aiVisibilityPromptsTable,
          eq(aiVisibilityPromptsTable.id, aiVisibilityPromptRunsTable.promptId),
        )
        .where(
          and(
            eq(aiVisibilityPromptsTable.projectId, projectId),
            eq(aiVisibilityPromptsTable.userId, userId),
            eq(aiVisibilityPromptRunsTable.userId, userId),
            eq(aiVisibilityPromptRunsTable.status, 'completed'),
            inArray(aiVisibilityPromptRunsTable.extractionStatus, [
              'completed',
              'corrected',
              'cached',
            ]),
          ),
        )
        .orderBy(desc(aiVisibilityPromptRunsTable.capturedAt))
        .limit(250),
    ]);
    const suggestions = buildCompetitorSuggestions({
      referenceAccounts: profileRows[0]?.referenceAccounts,
      observations,
      projectDomain: project.domain,
      projectNames: [project.name, ...project.brandAliases],
      existingCompetitors,
    });
    return {
      suggestions,
      sourcesUsed: [
        ...new Set(
          suggestions.flatMap((suggestion) => suggestion.sources.map((source) => source.type)),
        ),
      ],
      unavailableReason: suggestions.length
        ? null
        : 'No new competitors were found in AI answers or your Business Profile.',
    };
  }

  async competitorIntelligence(userId: number, projectId: number, requestedAuditId?: number) {
    const project = await this.getProject(userId, projectId);
    const configuredCompetitors = await this.listCompetitors(userId, projectId);
    const audit = await this.measurementAudit(userId, projectId, requestedAuditId);
    const competitors = audit
      ? await auditCompetitors(audit, configuredCompetitors)
      : configuredCompetitors.filter((item: { active: boolean }) => item.active);
    if (!audit) {
      return {
        audit: null,
        available: false,
        unavailableReason: competitors.length
          ? 'Complete an analysis to compare the brand with tracked competitors.'
          : 'Add a competitor, then refresh the analysis to create a verified comparison.',
        intelligence: deriveCompetitorIntelligence({
          projectDomain: project.domain,
          competitors,
          pages: [],
          runs: [],
        }),
      };
    }
    const [pages, runs, brandCrawl] = await Promise.all([
      db
        .select()
        .from(aiVisibilityCrawledPagesTable)
        .where(
          and(
            eq(aiVisibilityCrawledPagesTable.auditId, audit.id),
            eq(aiVisibilityCrawledPagesTable.projectId, projectId),
            eq(aiVisibilityCrawledPagesTable.userId, userId),
          ),
        ),
      db
        .select()
        .from(aiVisibilityPromptRunsTable)
        .where(
          and(
            eq(aiVisibilityPromptRunsTable.auditId, audit.id),
            eq(aiVisibilityPromptRunsTable.userId, userId),
            eq(aiVisibilityPromptRunsTable.status, 'completed'),
            inArray(aiVisibilityPromptRunsTable.extractionStatus, [
              'completed',
              'corrected',
              'cached',
            ]),
          ),
        ),
      db
        .select({ output: aiVisibilityAuditStagesTable.output })
        .from(aiVisibilityAuditStagesTable)
        .where(
          and(
            eq(aiVisibilityAuditStagesTable.auditId, audit.id),
            eq(aiVisibilityAuditStagesTable.userId, userId),
            eq(aiVisibilityAuditStagesTable.stageKey, 'brand_crawl'),
          ),
        )
        .limit(1),
    ]);
    const sitemapUrls = (brandCrawl[0]?.output as Record<string, unknown> | undefined)?.sitemapUrls;
    const intelligence = deriveCompetitorIntelligence({
      projectDomain: project.domain,
      competitors,
      pages,
      runs,
      brandKnownUrls: Array.isArray(sitemapUrls)
        ? sitemapUrls.filter((value): value is string => typeof value === 'string')
        : [],
    });
    return {
      audit,
      available: competitors.length > 0,
      unavailableReason: competitors.length
        ? null
        : 'Add a competitor, then refresh the analysis to create a verified comparison.',
      intelligence,
    };
  }

  async generateCompetitorGapBrief(
    userId: number,
    projectId: number,
    competitorId: number,
    gapKey: string,
  ) {
    const project = await this.getProject(userId, projectId);
    const comparison = await this.competitorIntelligence(userId, projectId);
    if (!comparison.audit)
      throw new AiVisibilityValidationError(
        'Complete an analysis before creating a counter-content brief.',
      );
    const competitor = comparison.intelligence.competitors.find(
      (item) => item.competitorId === competitorId,
    );
    if (!competitor)
      throw new AiVisibilityNotFoundError(
        'Competitor comparison not found in the latest analysis.',
      );
    const gap = competitor.contentGaps.find((item) => item.key === gapKey);
    if (!gap)
      throw new AiVisibilityValidationError(
        'The selected content gap is not supported by the latest verified crawl.',
      );
    let draft: ReturnType<typeof buildCounterContentBrief>;
    try {
      draft = buildCounterContentBrief({
        projectName: project.name,
        competitor,
        gap,
      });
    } catch (error) {
      throw new AiVisibilityValidationError(
        error instanceof Error
          ? error.message
          : 'A verified counter-content brief could not be created.',
      );
    }
    const [existing] = await db
      .select({ asset: contentAssetsTable })
      .from(aiVisibilityGeneratedAssetLinksTable)
      .innerJoin(
        contentAssetsTable,
        and(
          eq(aiVisibilityGeneratedAssetLinksTable.contentAssetId, contentAssetsTable.id),
          eq(contentAssetsTable.userId, userId),
        ),
      )
      .where(
        and(
          eq(aiVisibilityGeneratedAssetLinksTable.userId, userId),
          eq(aiVisibilityGeneratedAssetLinksTable.projectId, projectId),
          eq(aiVisibilityGeneratedAssetLinksTable.auditId, comparison.audit.id),
          eq(contentAssetsTable.type, 'content_brief'),
          sql`${contentAssetsTable.metadata}->>'competitorGapKey' = ${gap.key}`,
        ),
      )
      .limit(1);
    if (existing) return existing.asset;
    return db.transaction(async (tx: typeof db) => {
      const [asset] = await tx
        .insert(contentAssetsTable)
        .values({
          userId,
          businessProfileId: project.businessProfileId,
          brandToolkitId: project.brandToolkitId,
          type: 'content_brief',
          title: draft.title,
          content: draft.content,
          channel: 'ai_visibility',
          status: 'draft',
          approvalStatus: 'draft',
          validationSnapshot: draft.validation,
          metadata: {
            source: 'ai_visibility_competitor_gap',
            projectId,
            auditId: comparison.audit.id,
            competitorId,
            competitorGapKey: gap.key,
            pageType: gap.pageType,
            evidenceUrls: gap.evidenceUrls,
          },
        })
        .returning();
      await tx.insert(aiVisibilityGeneratedAssetLinksTable).values({
        userId,
        projectId,
        auditId: comparison.audit.id,
        recommendationId: null,
        contentAssetId: asset.id,
      });
      return asset;
    });
  }

  async addCompetitor(
    userId: number,
    projectId: number,
    input: { name: string; domain: string; aliases?: string[] },
  ) {
    await this.getProject(userId, projectId);
    return db.transaction(async (tx: typeof db) => {
      await tx
        .update(aiVisibilityProjectsTable)
        .set({
          configurationRevision: sql`${aiVisibilityProjectsTable.configurationRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityProjectsTable.id, projectId),
            eq(aiVisibilityProjectsTable.userId, userId),
          ),
        );
      const [competitor] = await tx
        .insert(aiVisibilityCompetitorsTable)
        .values({
          userId,
          projectId,
          name: input.name.trim(),
          domain: normalizeProjectDomain(input.domain),
          aliases: cleanAliases(input.aliases),
        })
        .returning();
      return competitor;
    });
  }

  async updateCompetitor(
    userId: number,
    projectId: number,
    competitorId: number,
    input: {
      name?: string;
      domain?: string;
      aliases?: string[];
      active?: boolean;
    },
  ) {
    await this.getProject(userId, projectId);
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (input.name !== undefined) update.name = input.name.trim();
    if (input.domain !== undefined) update.domain = normalizeProjectDomain(input.domain);
    if (input.aliases !== undefined) update.aliases = cleanAliases(input.aliases);
    if (input.active !== undefined) update.active = input.active;
    return db.transaction(async (tx: typeof db) => {
      await tx
        .update(aiVisibilityProjectsTable)
        .set({
          configurationRevision: sql`${aiVisibilityProjectsTable.configurationRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityProjectsTable.id, projectId),
            eq(aiVisibilityProjectsTable.userId, userId),
          ),
        );
      const [competitor] = await tx
        .update(aiVisibilityCompetitorsTable)
        .set(update)
        .where(
          and(
            eq(aiVisibilityCompetitorsTable.id, competitorId),
            eq(aiVisibilityCompetitorsTable.projectId, projectId),
            eq(aiVisibilityCompetitorsTable.userId, userId),
          ),
        )
        .returning();
      if (!competitor) throw new AiVisibilityNotFoundError('Competitor not found.');
      return competitor;
    });
  }

  async estimateAudit(
    userId: number,
    projectId: number,
    trigger: 'manual' | 'monitoring' = 'manual',
  ): Promise<AuditEstimate> {
    const project = await this.refreshProfileProject(
      userId,
      await this.getProject(userId, projectId),
    );
    const competitors = await this.listCompetitors(userId, projectId);
    const activeCompetitors = competitors.filter(
      (competitor: typeof aiVisibilityCompetitorsTable.$inferSelect) => competitor.active,
    ).length;
    const [
      base,
      crawlPage,
      providerPrompt,
      extraction,
      report,
      monitoringBase,
      walletBalance,
      historical,
    ] = await Promise.all([
      getCreditCost(
        trigger === 'monitoring' ? 'ai_visibility_monitoring_base' : 'ai_visibility_audit_base',
      ),
      getCreditCost('ai_visibility_crawl_page'),
      getCreditCost('ai_visibility_provider_prompt'),
      getCreditCost('ai_visibility_extraction'),
      getCreditCost('ai_visibility_report'),
      getCreditCost('ai_visibility_monitoring_base'),
      getBalance(userId),
      db
        .select({ actualCredits: aiVisibilityAuditsTable.actualCredits })
        .from(aiVisibilityAuditsTable)
        .where(
          and(
            eq(aiVisibilityAuditsTable.projectId, project.id),
            inArray(aiVisibilityAuditsTable.status, ['completed', 'completed_with_warnings']),
            sql`${aiVisibilityAuditsTable.settledAt} IS NOT NULL`,
          ),
        )
        .orderBy(desc(aiVisibilityAuditsTable.completedAt))
        .limit(10),
    ]);
    const brandPageLimit = 25;
    const competitorPageLimit = 8;
    const providerReadiness = await providerObservationService.readiness();
    const promptCount =
      4 +
      (project.geoPrompts || []).filter(
        (prompt: import('../../models/aiVisibility/schema.js').CustomGeoPrompt) => prompt.active,
      ).length;
    const configuredProviders = providerReadiness.filter((provider) => provider.configured).length;
    const providerRequests = promptCount * configuredProviders;
    const totalPageLimit =
      brandPageLimit + (activeCompetitors + AUTOMATIC_COMPETITOR_LIMIT) * competitorPageLimit;
    const lineItems = [
      {
        key:
          trigger === 'monitoring' ? 'ai_visibility_monitoring_base' : 'ai_visibility_audit_base',
        units: 1,
        creditsPerUnit: base,
        maximumCredits: base,
      },
      {
        key: 'ai_visibility_crawl_page',
        units: totalPageLimit,
        creditsPerUnit: crawlPage,
        maximumCredits: totalPageLimit * crawlPage,
      },
      {
        key: 'ai_visibility_provider_prompt',
        units: providerRequests,
        creditsPerUnit: providerPrompt,
        maximumCredits: providerRequests * providerPrompt,
      },
      {
        key: 'ai_visibility_extraction',
        units: providerRequests,
        creditsPerUnit: extraction,
        maximumCredits: providerRequests * extraction,
      },
      {
        key: 'ai_visibility_report',
        units: 1,
        creditsPerUnit: report,
        maximumCredits: report,
      },
    ];
    const estimatedMaximum =
      Math.round(lineItems.reduce((total, item) => total + item.maximumCredits, 0) * 100) / 100;
    const actualValues = historical
      .map((item: { actualCredits: string }) => Number(item.actualCredits))
      .filter(Number.isFinite);
    const expectedActual = actualValues.length
      ? Math.round(
          (actualValues.reduce((total: number, value: number) => total + value, 0) /
            actualValues.length) *
            100,
        ) / 100
      : null;
    return {
      reservedCredits: 0,
      temporaryHold: 0,
      estimatedMaximum,
      directBaseCharge: base,
      walletBalance,
      expectedActual,
      expectedActualBasis: expectedActual === null ? 'unavailable' : 'audit_history',
      assumptions: {
        brandPageLimit,
        competitorPageLimit,
        maxBrandPages: brandPageLimit,
        competitors: activeCompetitors,
        automaticCompetitorLimit: AUTOMATIC_COMPETITOR_LIMIT,
        prompts: promptCount,
        providers: configuredProviders,
        providerRequests,
        extractionRequests: providerRequests,
        reportCount: 1,
      },
      providerReadiness,
      pricing: {
        base,
        crawlPage,
        providerPrompt,
        extraction,
        report,
        monitoring: monitoringBase,
      },
      lineItems,
    };
  }

  async createAudit(
    userId: number,
    projectId: number,
    trigger: 'manual' | 'monitoring' = 'manual',
    monitoringPeriodKey?: string,
  ) {
    const project = await this.refreshProfileProject(
      userId,
      await this.getProject(userId, projectId),
    );
    const periodKey =
      trigger === 'monitoring'
        ? monitoringPeriodKey || new Date().toISOString().slice(0, 10)
        : undefined;
    if (periodKey) {
      const [existing] = await db
        .select()
        .from(aiVisibilityAuditsTable)
        .where(
          and(
            eq(aiVisibilityAuditsTable.projectId, projectId),
            eq(aiVisibilityAuditsTable.trigger, 'monitoring'),
            eq(aiVisibilityAuditsTable.monitoringPeriodKey, periodKey),
          ),
        )
        .limit(1);
      if (existing)
        return {
          success: true,
          resource: existing,
          creditsDeducted: 0,
          balanceAfter: await getBalance(userId),
          alreadyScheduled: true,
        };
    }
    const estimate = await this.estimateAudit(userId, projectId, trigger);
    const inputSnapshot = await db.transaction(async (tx: typeof db) => {
      const [frozenProject] = await tx
        .select()
        .from(aiVisibilityProjectsTable)
        .where(
          and(
            eq(aiVisibilityProjectsTable.id, projectId),
            eq(aiVisibilityProjectsTable.userId, userId),
          ),
        )
        .limit(1)
        .for('share');
      const competitors = await tx
        .select()
        .from(aiVisibilityCompetitorsTable)
        .where(
          and(
            eq(aiVisibilityCompetitorsTable.projectId, projectId),
            eq(aiVisibilityCompetitorsTable.userId, userId),
          ),
        );
      const aeoQuestions = await tx
        .select()
        .from(aiVisibilityAeoQuestionsTable)
        .where(
          and(
            eq(aiVisibilityAeoQuestionsTable.projectId, projectId),
            eq(aiVisibilityAeoQuestionsTable.userId, userId),
          ),
        );
      const [catalog] = await tx
        .select({ id: aiVisibilityCommerceSnapshotsTable.id })
        .from(aiVisibilityCommerceSnapshotsTable)
        .where(
          and(
            eq(aiVisibilityCommerceSnapshotsTable.projectId, projectId),
            eq(aiVisibilityCommerceSnapshotsTable.userId, userId),
          ),
        )
        .orderBy(
          desc(aiVisibilityCommerceSnapshotsTable.createdAt),
          desc(aiVisibilityCommerceSnapshotsTable.id),
        )
        .limit(1);
      return {
        project: frozenProject,
        competitors,
        competitorDiscoveryLimit: AUTOMATIC_COMPETITOR_LIMIT,
        aeoQuestions,
        commerceSnapshotId: catalog?.id || null,
        capturedAt: new Date().toISOString(),
      };
    });
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          projectId,
          domain: project.domain,
          aliases: project.brandAliases,
          profile: project.scoringProfile,
          locale: project.locale,
          targetGeography: project.targetGeography,
          scoringVersion: project.scoringProfileVersion,
        }),
      )
      .digest('hex');

    const charge = await creditService.chargeForResource({
      userId,
      eventKey:
        trigger === 'monitoring' ? 'ai_visibility_monitoring_base' : 'ai_visibility_audit_base',
      overrideAmount: estimate.directBaseCharge,
      description: `${trigger === 'monitoring' ? 'Monitoring' : 'AI Visibility'} audit base charge for ${project.name}`,
      service: 'ai_visibility',
      referenceType: 'ai_visibility_audit',
      metadata: { projectId, estimate, billingMode: 'direct', inputSnapshot },
      createResource: async (tx) => {
        const [audit] = await tx
          .insert(aiVisibilityAuditsTable)
          .values({
            userId,
            projectId,
            trigger,
            status: 'queued',
            reservedCredits: '0',
            actualCredits: estimate.directBaseCharge.toFixed(2),
            billingMode: 'direct',
            inputFingerprint: fingerprint,
            inputSnapshot,
            monitoringPeriodKey: periodKey || null,
          })
          .returning();
        await tx.insert(aiVisibilityAuditStagesTable).values(
          AI_VISIBILITY_STAGE_KEYS.map((stageKey) => ({
            auditId: audit.id,
            userId,
            stageKey,
            status: 'pending' as const,
          })),
        );
        return { resource: audit, referenceId: String(audit.id) };
      },
    });
    if (!charge.success || !charge.resource) {
      if (periodKey) {
        const [existing] = await db
          .select()
          .from(aiVisibilityAuditsTable)
          .where(
            and(
              eq(aiVisibilityAuditsTable.projectId, projectId),
              eq(aiVisibilityAuditsTable.trigger, 'monitoring'),
              eq(aiVisibilityAuditsTable.monitoringPeriodKey, periodKey),
            ),
          )
          .limit(1);
        if (existing)
          return {
            success: true,
            resource: existing,
            creditsDeducted: 0,
            balanceAfter: await getBalance(userId),
            alreadyScheduled: true,
          };
      }
      return charge;
    }
    if (charge.transactionId) {
      const [audit] = await db
        .update(aiVisibilityAuditsTable)
        .set({
          initialChargeTransactionId: charge.transactionId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityAuditsTable.id, charge.resource.id),
            eq(aiVisibilityAuditsTable.userId, userId),
          ),
        )
        .returning();
      charge.resource = audit;
    }
    return charge;
  }

  async listAudits(userId: number, projectId: number) {
    await this.getProject(userId, projectId);
    return db
      .select()
      .from(aiVisibilityAuditsTable)
      .where(
        and(
          eq(aiVisibilityAuditsTable.projectId, projectId),
          eq(aiVisibilityAuditsTable.userId, userId),
        ),
      )
      .orderBy(desc(aiVisibilityAuditsTable.createdAt));
  }

  async getAudit(userId: number, auditId: number) {
    const [audit] = await db
      .select()
      .from(aiVisibilityAuditsTable)
      .where(
        and(eq(aiVisibilityAuditsTable.id, auditId), eq(aiVisibilityAuditsTable.userId, userId)),
      )
      .limit(1);
    if (!audit) throw new AiVisibilityNotFoundError('Audit not found.');
    const stages = await db
      .select()
      .from(aiVisibilityAuditStagesTable)
      .where(
        and(
          eq(aiVisibilityAuditStagesTable.auditId, auditId),
          eq(aiVisibilityAuditStagesTable.userId, userId),
        ),
      )
      .orderBy(aiVisibilityAuditStagesTable.id);
    return { ...audit, stages };
  }

  async cancelAudit(userId: number, auditId: number) {
    const audit = await this.getAudit(userId, auditId);
    if (['completed', 'completed_with_warnings', 'failed', 'cancelled'].includes(audit.status)) {
      throw new AiVisibilityValidationError(`A ${audit.status} audit cannot be cancelled.`);
    }
    const [updated] = await db
      .update(aiVisibilityAuditsTable)
      .set({ cancellationRequested: true, updatedAt: new Date() })
      .where(
        and(
          eq(aiVisibilityAuditsTable.id, auditId),
          eq(aiVisibilityAuditsTable.userId, userId),
          inArray(aiVisibilityAuditsTable.status, ['queued', 'running']),
        ),
      )
      .returning();
    if (!updated) throw new AiVisibilityValidationError('This audit finished before cancellation could be accepted.');
    return updated;
  }

  async markAuditDispatchFailed(userId: number, auditId: number, message: string) {
    await this.getAudit(userId, auditId);
    await db.transaction(async (tx: typeof db) => {
      await tx
        .update(aiVisibilityAuditsTable)
        .set({
          status: 'failed',
          error: message,
          actualCredits: '0',
          completedAt: new Date(),
          settledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(eq(aiVisibilityAuditsTable.id, auditId), eq(aiVisibilityAuditsTable.userId, userId)),
        );
      await tx
        .update(aiVisibilityAuditStagesTable)
        .set({
          status: 'cancelled',
          error: message,
          completedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityAuditStagesTable.auditId, auditId),
            eq(aiVisibilityAuditStagesTable.userId, userId),
            eq(aiVisibilityAuditStagesTable.status, 'pending'),
          ),
        );
    });
  }

  async providerStatus(userId: number, projectId: number) {
    await this.getProject(userId, projectId);
    const readiness = await providerObservationService.readiness();
    const audit = await this.measurementAudit(userId, projectId);
    const runs = audit
      ? await db
          .select()
          .from(aiVisibilityPromptRunsTable)
          .where(
            and(
              eq(aiVisibilityPromptRunsTable.auditId, audit.id),
              eq(aiVisibilityPromptRunsTable.userId, userId),
            ),
          )
      : [];
    return {
      providers: readiness.map((provider) => {
        const observed: (typeof aiVisibilityPromptRunsTable.$inferSelect)[] = runs.filter(
          (run: typeof aiVisibilityPromptRunsTable.$inferSelect) =>
            run.provider === provider.provider,
        );
        const quotaFailed = observed.some(run => run.model === provider.model
          && run.status === 'failed' && classifyLLMProviderFailure(run.error).category === 'insufficient_credits');
        const unavailable =
          provider.configured &&
          !observed.some(
            (run: typeof aiVisibilityPromptRunsTable.$inferSelect) => run.status === 'completed',
          ) &&
          (quotaFailed || observed.some(
            (run: typeof aiVisibilityPromptRunsTable.$inferSelect) =>
              run.model === provider.model && isProviderAvailabilityFailure(run.error || ''),
          ));
        const lastError = observed.find(run => run.error)?.error || null;
        return {
          ...provider,
          status: unavailable ? 'last_run_unavailable' : provider.status,
          reason: unavailable
            ? quotaFailed ? platformAIQuotaMessage() : 'It didn’t answer in the last analysis. The next analysis tries it once and skips the rest of its questions if it still fails.'
            : provider.reason,
          lastAuditId: audit?.id || null,
          lastObservedAt: audit?.completedAt || null,
          successful: observed.filter(
            (run: typeof aiVisibilityPromptRunsTable.$inferSelect) => run.status === 'completed',
          ).length,
          failed: observed.filter(
            (run: typeof aiVisibilityPromptRunsTable.$inferSelect) => run.status === 'failed',
          ).length,
          lastError: lastError && classifyLLMProviderFailure(lastError).category === 'insufficient_credits'
            ? platformAIQuotaMessage() : lastError,
        };
      }),
    };
  }

  async measurementAudit(userId: number, projectId: number, requestedAuditId?: number) {
    const audits = await this.listAudits(userId, projectId);
    if (requestedAuditId !== undefined) {
      const selected = audits.find(
        (audit: typeof aiVisibilityAuditsTable.$inferSelect) => audit.id === requestedAuditId,
      );
      if (!selected || !['completed', 'completed_with_warnings'].includes(selected.status))
        throw new AiVisibilityNotFoundError('Completed analysis not found for this website.');
      return selected;
    }
    return latestCompletedAudit(audits as Array<typeof aiVisibilityAuditsTable.$inferSelect>);
  }

  async overview(userId: number, projectId: number, requestedAuditId?: number) {
    const project = await this.getProject(userId, projectId);
    const audits = await this.listAudits(userId, projectId);
    const measurementAudit = await this.measurementAudit(userId, projectId, requestedAuditId);
    const latestAudit = audits[0] || null;
    const [scoreRows, recommendationRows, runs, pages, scoreHistory] = await Promise.all([
      measurementAudit
        ? db
            .select()
            .from(aiVisibilityScoreSnapshotsTable)
            .where(eq(aiVisibilityScoreSnapshotsTable.auditId, measurementAudit.id))
        : [],
      measurementAudit
        ? db
            .select()
            .from(aiVisibilityRecommendationsTable)
            .where(eq(aiVisibilityRecommendationsTable.auditId, measurementAudit.id))
        : [],
      measurementAudit
        ? db
            .select()
            .from(aiVisibilityPromptRunsTable)
            .where(eq(aiVisibilityPromptRunsTable.auditId, measurementAudit.id))
        : [],
      measurementAudit
        ? db
            .select()
            .from(aiVisibilityCrawledPagesTable)
            .where(
              and(
                eq(aiVisibilityCrawledPagesTable.auditId, measurementAudit.id),
                eq(aiVisibilityCrawledPagesTable.targetType, 'brand'),
              ),
            )
        : [],
      db
        .select({
          score: aiVisibilityScoreSnapshotsTable,
          audit: aiVisibilityAuditsTable,
        })
        .from(aiVisibilityScoreSnapshotsTable)
        .innerJoin(
          aiVisibilityAuditsTable,
          eq(aiVisibilityAuditsTable.id, aiVisibilityScoreSnapshotsTable.auditId),
        )
        .where(
          and(
            eq(aiVisibilityAuditsTable.projectId, projectId),
            eq(aiVisibilityAuditsTable.userId, userId),
            inArray(aiVisibilityAuditsTable.status, ['completed', 'completed_with_warnings']),
          ),
        )
        .orderBy(desc(aiVisibilityAuditsTable.createdAt))
        .limit(30),
    ]);
    const historyAuditIds = scoreHistory.map(
      (row: { audit: { id: number } }) => row.audit.id,
    );
    const seoRuleVersions = await this.seoRuleVersions(
      measurementAudit && !historyAuditIds.includes(measurementAudit.id)
        ? [...historyAuditIds, measurementAudit.id]
        : historyAuditIds,
    );
    const snapshotProject = measurementAudit?.inputSnapshot.project as
      | Partial<typeof project>
      | undefined;
    const withdrawnFixes = await this.withdrawnFixIds(userId, projectId, recommendationRows);
    return {
      project,
      latestAudit,
      measurementAudit: measurementAudit || null,
      latestScore: scoreRows[0] || null,
      openRecommendations: recommendationRows.filter(
        (item: typeof aiVisibilityRecommendationsTable.$inferSelect) =>
          ['open', 'in_progress'].includes(item.status) && !withdrawnFixes.has(item.id),
      ).length,
      coverage: {
        ...providerCoverage(runs),
        checkedPages: pages.length,
        completedPages: pages.filter(
          (page: typeof aiVisibilityCrawledPagesTable.$inferSelect) =>
            page.crawlStatus === 'completed',
        ).length,
        pageLimit: 25,
      },
      configurationChanged: Boolean(
        measurementAudit &&
        (snapshotProject?.configurationRevision || 1) !== project.configurationRevision,
      ),
      // SEO checks change between rule versions, so scores are only comparable within one.
      measurementSeoRuleVersion: measurementAudit
        ? (seoRuleVersions.get(measurementAudit.id) ?? null)
        : null,
      currentSeoRuleVersion: SEO_RULE_VERSION,
      scoreHistory: scoreHistory.map((row: { audit: { id: number } }) => ({
        ...row,
        seoRuleVersion: seoRuleVersions.get(row.audit.id) ?? null,
      })),
    };
  }

  /** SEO rule version per audit: the stored stage value, else the newest version on its issues. */
  private async seoRuleVersions(auditIds: number[]): Promise<Map<number, number>> {
    const versions = new Map<number, number>();
    if (!auditIds.length) return versions;
    const [stages, issueVersions] = await Promise.all([
      db
        .select({
          auditId: aiVisibilityAuditStagesTable.auditId,
          output: aiVisibilityAuditStagesTable.output,
        })
        .from(aiVisibilityAuditStagesTable)
        .where(
          and(
            inArray(aiVisibilityAuditStagesTable.auditId, auditIds),
            eq(aiVisibilityAuditStagesTable.stageKey, 'seo_analysis'),
          ),
        ),
      db
        .select({
          auditId: aiVisibilitySeoIssuesTable.auditId,
          version: sql<number>`max(${aiVisibilitySeoIssuesTable.ruleVersion})`,
        })
        .from(aiVisibilitySeoIssuesTable)
        .where(inArray(aiVisibilitySeoIssuesTable.auditId, auditIds))
        .groupBy(aiVisibilitySeoIssuesTable.auditId),
    ]);
    for (const row of issueVersions as Array<{ auditId: number; version: number | string | null }>)
      if (row.version !== null) versions.set(row.auditId, Number(row.version));
    for (const row of stages as Array<{ auditId: number; output: unknown }>) {
      const version = measurementRuleVersion((row.output as Record<string, unknown>) || {}, []);
      if (version !== null) versions.set(row.auditId, version);
    }
    return versions;
  }

  async seo(userId: number, projectId: number, requestedAuditId?: number) {
    const audit = await this.measurementAudit(userId, projectId, requestedAuditId);
    if (!audit) return { audit: null, issues: [], pages: [], site: null };
    const [issues, pages, stages] = await Promise.all([
      db
        .select()
        .from(aiVisibilitySeoIssuesTable)
        .where(
          and(
            eq(aiVisibilitySeoIssuesTable.auditId, audit.id),
            eq(aiVisibilitySeoIssuesTable.userId, userId),
          ),
        ),
      db
        .select()
        .from(aiVisibilityCrawledPagesTable)
        .where(
          and(
            eq(aiVisibilityCrawledPagesTable.auditId, audit.id),
            eq(aiVisibilityCrawledPagesTable.userId, userId),
            eq(aiVisibilityCrawledPagesTable.targetType, 'brand'),
          ),
        ),
      db
        .select({
          stageKey: aiVisibilityAuditStagesTable.stageKey,
          output: aiVisibilityAuditStagesTable.output,
        })
        .from(aiVisibilityAuditStagesTable)
        .where(
          and(
            eq(aiVisibilityAuditStagesTable.auditId, audit.id),
            eq(aiVisibilityAuditStagesTable.userId, userId),
            inArray(aiVisibilityAuditStagesTable.stageKey, ['brand_crawl', 'seo_analysis']),
          ),
        ),
    ]);
    const output = (key: string): Record<string, unknown> =>
      (stages.find((stage: { stageKey: string }) => stage.stageKey === key)?.output as Record<
        string,
        unknown
      >) || {};
    const site = buildSeoSiteSummary(
      output('brand_crawl'),
      output('seo_analysis'),
      pages,
      issues.map((issue: { ruleVersion: number | null }) => issue.ruleVersion),
    );
    const current = issues.filter(
      (issue: typeof aiVisibilitySeoIssuesTable.$inferSelect) =>
        !isWithdrawnLegacyRobotsFinding(issue.ruleId, issue.affectedUrl, issue.evidence),
    );
    return { audit, issues: current, pages, site, withdrawnFindings: issues.length - current.length };
  }

  async prompts(
    userId: number,
    projectId: number,
    kind?: 'aeo' | 'geo',
    requestedAuditId?: number,
  ) {
    const audit = await this.measurementAudit(userId, projectId, requestedAuditId);
    if (!audit) return { audit: null, prompts: [], runs: [] };
    const conditions = [
      eq(aiVisibilityPromptsTable.auditId, audit.id),
      eq(aiVisibilityPromptsTable.userId, userId),
    ];
    if (kind) conditions.push(eq(aiVisibilityPromptsTable.kind, kind));
    const prompts = await db
      .select()
      .from(aiVisibilityPromptsTable)
      .where(and(...conditions));
    const promptIds = prompts.map(
      (prompt: typeof aiVisibilityPromptsTable.$inferSelect) => prompt.id,
    );
    const runs = promptIds.length
      ? await db
          .select()
          .from(aiVisibilityPromptRunsTable)
          .where(
            and(
              eq(aiVisibilityPromptRunsTable.userId, userId),
              inArray(aiVisibilityPromptRunsTable.promptId, promptIds),
            ),
          )
      : [];
    return { audit, prompts, runs };
  }

  async listAeoQuestions(userId: number, projectId: number) {
    await this.getProject(userId, projectId);
    return db
      .select()
      .from(aiVisibilityAeoQuestionsTable)
      .where(
        and(
          eq(aiVisibilityAeoQuestionsTable.projectId, projectId),
          eq(aiVisibilityAeoQuestionsTable.userId, userId),
        ),
      )
      .orderBy(desc(aiVisibilityAeoQuestionsTable.active), aiVisibilityAeoQuestionsTable.id);
  }

  async createAeoQuestion(
    userId: number,
    projectId: number,
    input: { question: string; intent?: string; targetPage?: string | null },
  ) {
    await this.getProject(userId, projectId);
    return db.transaction(async (tx: typeof db) => {
      await tx
        .update(aiVisibilityProjectsTable)
        .set({
          configurationRevision: sql`${aiVisibilityProjectsTable.configurationRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityProjectsTable.id, projectId),
            eq(aiVisibilityProjectsTable.userId, userId),
          ),
        );
      const [question] = await tx
        .insert(aiVisibilityAeoQuestionsTable)
        .values({
          userId,
          projectId,
          question: input.question.trim(),
          intent: input.intent || 'informational',
          targetPage: input.targetPage?.trim() || null,
        })
        .returning();
      return question;
    });
  }

  async updateAeoQuestion(
    userId: number,
    projectId: number,
    questionId: number,
    input: {
      question?: string;
      intent?: string;
      targetPage?: string | null;
      active?: boolean;
    },
  ) {
    await this.getProject(userId, projectId);
    const update: Record<string, unknown> = { updatedAt: new Date() };
    if (input.question !== undefined) update.question = input.question.trim();
    if (input.intent !== undefined) update.intent = input.intent;
    if (input.targetPage !== undefined) update.targetPage = input.targetPage?.trim() || null;
    if (input.active !== undefined) update.active = input.active;
    return db.transaction(async (tx: typeof db) => {
      await tx
        .update(aiVisibilityProjectsTable)
        .set({
          configurationRevision: sql`${aiVisibilityProjectsTable.configurationRevision} + 1`,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityProjectsTable.id, projectId),
            eq(aiVisibilityProjectsTable.userId, userId),
          ),
        );
      const [question] = await tx
        .update(aiVisibilityAeoQuestionsTable)
        .set(update)
        .where(
          and(
            eq(aiVisibilityAeoQuestionsTable.id, questionId),
            eq(aiVisibilityAeoQuestionsTable.projectId, projectId),
            eq(aiVisibilityAeoQuestionsTable.userId, userId),
          ),
        )
        .returning();
      if (!question) throw new AiVisibilityNotFoundError('AEO question not found.');
      return question;
    });
  }

  async aeoCoverage(userId: number, projectId: number, requestedAuditId?: number) {
    await this.getProject(userId, projectId);
    const questions = await this.listAeoQuestions(userId, projectId);
    const audit = await this.measurementAudit(userId, projectId, requestedAuditId);
    if (!audit) {
      return {
        audit: null,
        available: false,
        unavailableReason:
          'Complete an analysis to check these questions against verified website content.',
        summary: {
          total: questions.length,
          answered: 0,
          partial: 0,
          uncovered: questions.length,
        },
        coverage: analyzeAeoCoverage(questions, []),
      };
    }
    const pages = await db
      .select()
      .from(aiVisibilityCrawledPagesTable)
      .where(
        and(
          eq(aiVisibilityCrawledPagesTable.auditId, audit.id),
          eq(aiVisibilityCrawledPagesTable.projectId, projectId),
          eq(aiVisibilityCrawledPagesTable.userId, userId),
          eq(aiVisibilityCrawledPagesTable.targetType, 'brand'),
        ),
      );
    const coverage = analyzeAeoCoverage(questions, pages);
    const completedPages = pages.filter(
      (page: typeof aiVisibilityCrawledPagesTable.$inferSelect) => page.crawlStatus === 'completed',
    );
    return {
      audit,
      available: completedPages.length > 0,
      unavailableReason: completedPages.length
        ? null
        : 'The latest analysis could not crawl any indexable website pages.',
      summary: {
        total: coverage.length,
        answered: coverage.filter((item) => item.status === 'answered').length,
        partial: coverage.filter((item) => item.status === 'partial').length,
        uncovered: coverage.filter((item) => item.status === 'uncovered').length,
      },
      coverage,
    };
  }

  async generateAeoQuestionAsset(
    userId: number,
    projectId: number,
    questionId: number,
    assetType: AeoAssetType,
  ) {
    const project = await this.getProject(userId, projectId);
    const [question] = await db
      .select()
      .from(aiVisibilityAeoQuestionsTable)
      .where(
        and(
          eq(aiVisibilityAeoQuestionsTable.id, questionId),
          eq(aiVisibilityAeoQuestionsTable.projectId, projectId),
          eq(aiVisibilityAeoQuestionsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!question) throw new AiVisibilityNotFoundError('AEO question not found.');
    const audit = await this.measurementAudit(userId, projectId);
    if (!audit)
      throw new AiVisibilityValidationError(
        'Complete an analysis before creating a grounded AEO asset.',
      );
    const pages = await db
      .select()
      .from(aiVisibilityCrawledPagesTable)
      .where(
        and(
          eq(aiVisibilityCrawledPagesTable.auditId, audit.id),
          eq(aiVisibilityCrawledPagesTable.projectId, projectId),
          eq(aiVisibilityCrawledPagesTable.userId, userId),
          eq(aiVisibilityCrawledPagesTable.targetType, 'brand'),
        ),
      );
    const [coverage] = analyzeAeoCoverage([question], pages);
    let draft: ReturnType<typeof buildGroundedAeoAsset>;
    try {
      draft = buildGroundedAeoAsset(coverage, assetType);
    } catch (error) {
      throw new AiVisibilityValidationError(
        error instanceof Error ? error.message : 'A grounded AEO asset could not be created.',
      );
    }
    const [existing] = await db
      .select({ asset: contentAssetsTable })
      .from(aiVisibilityGeneratedAssetLinksTable)
      .innerJoin(
        contentAssetsTable,
        and(
          eq(aiVisibilityGeneratedAssetLinksTable.contentAssetId, contentAssetsTable.id),
          eq(contentAssetsTable.userId, userId),
        ),
      )
      .where(
        and(
          eq(aiVisibilityGeneratedAssetLinksTable.userId, userId),
          eq(aiVisibilityGeneratedAssetLinksTable.projectId, projectId),
          eq(aiVisibilityGeneratedAssetLinksTable.auditId, audit.id),
          eq(contentAssetsTable.type, draft.type),
          sql`${contentAssetsTable.metadata}->>'aeoQuestionId' = ${String(questionId)}`,
        ),
      )
      .limit(1);
    if (existing) return existing.asset;
    return db.transaction(async (tx: typeof db) => {
      const [asset] = await tx
        .insert(contentAssetsTable)
        .values({
          userId,
          businessProfileId: project.businessProfileId,
          brandToolkitId: project.brandToolkitId,
          type: draft.type,
          title: draft.title,
          content: draft.content,
          channel: 'ai_visibility',
          status: 'draft',
          approvalStatus: 'draft',
          validationSnapshot: draft.validation,
          metadata: {
            source: 'ai_visibility_aeo',
            projectId,
            auditId: audit.id,
            aeoQuestionId: question.id,
            sourcePage: coverage.bestMatch?.url,
            coverageStatus: coverage.status,
            coverageScore: coverage.bestMatch?.score,
          },
        })
        .returning();
      await tx.insert(aiVisibilityGeneratedAssetLinksTable).values({
        userId,
        projectId,
        auditId: audit.id,
        recommendationId: null,
        contentAssetId: asset.id,
      });
      return asset;
    });
  }

  async commerce(userId: number, projectId: number) {
    await this.getProject(userId, projectId);
    const snapshots = await db
      .select({
        ...getTableColumns(aiVisibilityCommerceSnapshotsTable),
        summary: sql<
          Record<string, unknown>
        >`${aiVisibilityCommerceSnapshotsTable.summary} - 'products'`,
      })
      .from(aiVisibilityCommerceSnapshotsTable)
      .where(
        and(
          eq(aiVisibilityCommerceSnapshotsTable.projectId, projectId),
          eq(aiVisibilityCommerceSnapshotsTable.userId, userId),
        ),
      )
      .orderBy(desc(aiVisibilityCommerceSnapshotsTable.createdAt))
      .limit(20);
    return {
      status: snapshots[0] ? 'scored' : 'not_applicable',
      score: snapshots[0] ? Number(snapshots[0].score) : null,
      reason: snapshots[0] ? null : 'No verified product catalog has been ingested.',
      latestSnapshot: snapshots[0] || null,
      snapshots,
    };
  }

  async commerceProducts(
    userId: number,
    projectId: number,
    options: {
      snapshotId?: number;
      query?: string;
      issuesOnly?: boolean;
      offset: number;
      limit: number;
    },
  ) {
    await this.getProject(userId, projectId);
    const [snapshot] = await db
      .select()
      .from(aiVisibilityCommerceSnapshotsTable)
      .where(
        and(
          eq(aiVisibilityCommerceSnapshotsTable.userId, userId),
          eq(aiVisibilityCommerceSnapshotsTable.projectId, projectId),
          options.snapshotId
            ? eq(aiVisibilityCommerceSnapshotsTable.id, options.snapshotId)
            : undefined,
        ),
      )
      .orderBy(desc(aiVisibilityCommerceSnapshotsTable.createdAt))
      .limit(1);
    const products = (
      Array.isArray(snapshot?.summary.products) ? snapshot.summary.products : []
    ) as Array<{
      row: number;
      identifier: string;
      title: string;
      valid: boolean;
      issues: string[];
    }>;
    const query = (options.query || '').toLowerCase();
    const filtered = products.filter(
      (product) =>
        (!options.issuesOnly || product.issues.length > 0) &&
        (!query ||
          `${product.identifier} ${product.title} ${product.issues.join(' ')}`
            .toLowerCase()
            .includes(query)),
    );
    return {
      snapshotId: snapshot?.id || null,
      available: Boolean(snapshot && Array.isArray(snapshot.summary.products)),
      total: filtered.length,
      products: filtered.slice(options.offset, options.offset + options.limit),
    };
  }

  async ingestCommerceFeed(
    userId: number,
    projectId: number,
    file: { buffer: Buffer; originalname: string; mimetype?: string },
    mapping: Record<string, string> = {},
  ) {
    await this.getProject(userId, projectId);
    let validation: ReturnType<typeof parseAndValidateCommerceFeed>;
    try {
      validation = parseAndValidateCommerceFeed(
        file.buffer,
        file.originalname,
        file.mimetype,
        mapping,
      );
    } catch (error) {
      throw new AiVisibilityValidationError(
        error instanceof Error ? error.message : 'Product feed validation failed.',
      );
    }
    const upload = await storageService.upload(file.buffer, {
      userId,
      category: 'document',
      originalName: file.originalname,
      mimeType: file.mimetype,
      referenceType: 'ai_visibility_commerce_feed',
      referenceId: String(projectId),
      metadata: {
        projectId,
        sourceType: validation.sourceType,
        inputFingerprint: validation.inputFingerprint,
      },
    });
    const [snapshot] = await db
      .insert(aiVisibilityCommerceSnapshotsTable)
      .values({
        userId,
        projectId,
        sourceType: validation.sourceType,
        sourceName: file.originalname,
        storageFileId: upload.fileId,
        inputFingerprint: validation.inputFingerprint,
        itemCount: validation.itemCount,
        validItemCount: validation.validItemCount,
        score: validation.score.toFixed(2),
        fieldCoverage: validation.fieldCoverage,
        issues: validation.issues,
        summary: validation.summary,
      })
      .returning();
    const { products: _products, ...summary } = snapshot.summary;
    return { ...snapshot, summary };
  }

  async ingestShopifyCatalog(userId: number, projectId: number) {
    await this.getProject(userId, projectId);
    const catalog = await shopifyCatalogService.fetchForUser(userId);
    const buffer = Buffer.from(JSON.stringify({ products: catalog.products }));
    const parsed = parseAndValidateCommerceFeed(buffer, 'shopify-catalog.json', 'application/json');
    const validation = {
      ...parsed,
      sourceType: 'shopify' as const,
      inputFingerprint: catalog.inputFingerprint,
      issues: catalog.variantTruncatedProducts
        ? [
            ...parsed.issues,
            {
              field: 'variants',
              missing: catalog.variantTruncatedProducts,
              severity: 'medium',
              message: `${catalog.variantTruncatedProducts} product(s) have more than 100 variants; the snapshot includes Shopify's first 100 variants and is labeled incomplete.`,
            },
          ]
        : parsed.issues,
      summary: {
        ...parsed.summary,
        storeDomain: catalog.storeDomain,
        shopName: catalog.shopName,
        currency: catalog.currency,
        pagesFetched: catalog.pagesFetched,
        variantTruncatedProducts: catalog.variantTruncatedProducts,
        apiVersion: catalog.apiVersion,
        sourceFidelity: 'live_api',
      },
    };
    const [existing] = await db
      .select()
      .from(aiVisibilityCommerceSnapshotsTable)
      .where(
        and(
          eq(aiVisibilityCommerceSnapshotsTable.projectId, projectId),
          eq(aiVisibilityCommerceSnapshotsTable.userId, userId),
          eq(aiVisibilityCommerceSnapshotsTable.sourceType, 'shopify'),
          eq(aiVisibilityCommerceSnapshotsTable.inputFingerprint, validation.inputFingerprint),
        ),
      )
      .orderBy(desc(aiVisibilityCommerceSnapshotsTable.createdAt))
      .limit(1);
    if (existing) return existing;

    const sourceName = `shopify-${catalog.storeDomain}-${new Date().toISOString().slice(0, 10)}.json`;
    const upload = await storageService.upload(buffer, {
      userId,
      category: 'document',
      originalName: sourceName,
      mimeType: 'application/json',
      referenceType: 'ai_visibility_commerce_feed',
      referenceId: String(projectId),
      metadata: {
        projectId,
        sourceType: 'shopify',
        inputFingerprint: validation.inputFingerprint,
        storeDomain: catalog.storeDomain,
      },
    });
    const [snapshot] = await db
      .insert(aiVisibilityCommerceSnapshotsTable)
      .values({
        userId,
        projectId,
        sourceType: 'shopify',
        sourceName,
        storageFileId: upload.fileId,
        inputFingerprint: validation.inputFingerprint,
        itemCount: validation.itemCount,
        validItemCount: validation.validItemCount,
        score: validation.score.toFixed(2),
        fieldCoverage: validation.fieldCoverage,
        issues: validation.issues,
        summary: validation.summary,
      })
      .returning();
    return snapshot;
  }

  /** Reads the website's public WooCommerce product list and validates it like a feed. */
  async ingestWooCommerceCatalog(userId: number, projectId: number) {
    const project = await this.getProject(userId, projectId);
    let catalog: Awaited<ReturnType<typeof fetchWooCommerceCatalog>>;
    try {
      catalog = await fetchWooCommerceCatalog(project.domain);
    } catch (error) {
      throw new AiVisibilityValidationError(
        error instanceof WooCommerceCatalogError
          ? error.message
          : 'The WooCommerce product list could not be read. Try again later.',
      );
    }
    const buffer = Buffer.from(JSON.stringify({ products: catalog.products }));
    const parsed = parseAndValidateCommerceFeed(buffer, 'woocommerce-catalog.json', 'application/json');
    const issues = catalog.truncated
      ? [
          ...parsed.issues,
          {
            field: 'products',
            missing: 0,
            severity: 'medium',
            message: 'The store has more than 5,000 products; this snapshot includes the first 5,000.',
          },
        ]
      : parsed.issues;
    const [existing] = await db
      .select()
      .from(aiVisibilityCommerceSnapshotsTable)
      .where(
        and(
          eq(aiVisibilityCommerceSnapshotsTable.projectId, projectId),
          eq(aiVisibilityCommerceSnapshotsTable.userId, userId),
          eq(aiVisibilityCommerceSnapshotsTable.sourceType, 'woocommerce'),
          eq(aiVisibilityCommerceSnapshotsTable.inputFingerprint, catalog.inputFingerprint),
        ),
      )
      .orderBy(desc(aiVisibilityCommerceSnapshotsTable.createdAt))
      .limit(1);
    if (existing) return existing;
    const sourceName = `woocommerce-${catalog.storeDomain}-${new Date().toISOString().slice(0, 10)}.json`;
    const upload = await storageService.upload(buffer, {
      userId,
      category: 'document',
      originalName: sourceName,
      mimeType: 'application/json',
      referenceType: 'ai_visibility_commerce_feed',
      referenceId: String(projectId),
      metadata: {
        projectId,
        sourceType: 'woocommerce',
        inputFingerprint: catalog.inputFingerprint,
        storeDomain: catalog.storeDomain,
      },
    });
    const [snapshot] = await db
      .insert(aiVisibilityCommerceSnapshotsTable)
      .values({
        userId,
        projectId,
        sourceType: 'woocommerce',
        sourceName,
        storageFileId: upload.fileId,
        inputFingerprint: catalog.inputFingerprint,
        itemCount: parsed.itemCount,
        validItemCount: parsed.validItemCount,
        score: parsed.score.toFixed(2),
        fieldCoverage: parsed.fieldCoverage,
        issues,
        summary: {
          ...parsed.summary,
          storeDomain: catalog.storeDomain,
          currency: catalog.currency,
          pagesFetched: catalog.pagesFetched,
          sourceFidelity: 'public_api',
        },
      })
      .returning();
    const { products: _products, ...summary } = snapshot.summary;
    return { ...snapshot, summary };
  }

  /**
   * Fixes that later corrections showed were not needed: robots fixes from the older robots
   * check, and content briefs for competitor gaps the current comparison no longer shows.
   */
  private async withdrawnFixIds(
    userId: number,
    projectId: number,
    rows: Array<typeof aiVisibilityRecommendationsTable.$inferSelect>,
  ): Promise<Set<number>> {
    const withdrawn = new Set<number>(
      rows.filter((item) => isWithdrawnLegacyRecommendation(item)).map((item) => item.id),
    );
    const gapFixes = rows.filter(
      (item) =>
        item.module === 'competitor' &&
        typeof (item.evidence as Record<string, unknown> | null)?.competitorGapKey === 'string',
    );
    for (const auditId of new Set(gapFixes.map((item) => item.auditId))) {
      const comparison = await this.competitorIntelligence(userId, projectId, auditId);
      if (comparison.audit?.id !== auditId) continue;
      const currentGapKeys = new Map(
        comparison.intelligence.competitors.map((item) => [
          item.competitorId,
          new Set(item.contentGaps.map((gap) => gap.key)),
        ]),
      );
      for (const item of gapFixes)
        if (item.auditId === auditId && isWithdrawnGapFix(item, currentGapKeys)) withdrawn.add(item.id);
    }
    return withdrawn;
  }

  async recommendations(userId: number, projectId: number, requestedAuditId?: number) {
    const audit = await this.measurementAudit(userId, projectId, requestedAuditId);
    if (!audit) return [];
    const rows = await db
      .select()
      .from(aiVisibilityRecommendationsTable)
      .where(
        and(
          eq(aiVisibilityRecommendationsTable.auditId, audit.id),
          eq(aiVisibilityRecommendationsTable.projectId, projectId),
          eq(aiVisibilityRecommendationsTable.userId, userId),
        ),
      )
      .orderBy(desc(aiVisibilityRecommendationsTable.createdAt));
    const withdrawn = await this.withdrawnFixIds(userId, projectId, rows);
    return rows.filter(
      (item: typeof aiVisibilityRecommendationsTable.$inferSelect) => !withdrawn.has(item.id),
    );
  }

  async assignees(userId: number, projectId: number) {
    const project = await this.getProject(userId, projectId);
    return db
      .select({
        id: usersTable.id,
        name: usersTable.name,
        email: usersTable.email,
      })
      .from(aiVisibilityWorkspaceMembershipsTable)
      .innerJoin(usersTable, eq(usersTable.id, aiVisibilityWorkspaceMembershipsTable.userId))
      .where(
        and(
          eq(aiVisibilityWorkspaceMembershipsTable.workspaceId, project.workspaceId),
          eq(aiVisibilityWorkspaceMembershipsTable.status, 'active'),
        ),
      );
  }

  async updateRecommendation(
    userId: number,
    projectId: number,
    recommendationId: number,
    input:
      | RecommendationStatus
      | {
          status?: RecommendationStatus;
          assigneeUserId?: number | null;
          dueDate?: string | null;
          resolutionEvidence?: string | null;
        },
  ) {
    const project = await this.getProject(userId, projectId);
    const update = typeof input === 'string' ? { status: input } : input;
    if (update.assigneeUserId) {
      const members = await this.assignees(userId, projectId);
      if (!members.some((member: { id: number }) => member.id === update.assigneeUserId))
        throw new AiVisibilityValidationError('Assign this fix to an active workspace member.');
    }
    const audit = await this.measurementAudit(userId, projectId);
    const [record] = await db
      .update(aiVisibilityRecommendationsTable)
      .set({
        ...update,
        ...(update.status ? { verificationStatus: 'unverified', verifiedAt: null } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiVisibilityRecommendationsTable.id, recommendationId),
          eq(aiVisibilityRecommendationsTable.projectId, project.id),
          eq(aiVisibilityRecommendationsTable.userId, userId),
          eq(aiVisibilityRecommendationsTable.auditId, audit?.id || -1),
        ),
      )
      .returning();
    if (!record)
      throw new AiVisibilityConflictError(
        'This fix belongs to an older analysis. Open the latest results before updating it.',
      );
    return record;
  }

  async generateRecommendationAsset(userId: number, projectId: number, recommendationId: number) {
    const project = await this.getProject(userId, projectId);
    const [recommendation] = await db
      .select()
      .from(aiVisibilityRecommendationsTable)
      .where(
        and(
          eq(aiVisibilityRecommendationsTable.id, recommendationId),
          eq(aiVisibilityRecommendationsTable.projectId, projectId),
          eq(aiVisibilityRecommendationsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!recommendation) throw new AiVisibilityNotFoundError('Recommendation not found.');
    let content =
      recommendation.generatedDraft ||
      [
        `# ${recommendation.title}`,
        '',
        recommendation.description,
        '',
        `Evidence: ${JSON.stringify(recommendation.evidence)}`,
        '',
        'Review checklist:',
        '- Verify every factual claim against a primary source.',
        '- Match the connected Brand Toolkit voice before approval.',
        '- Add an author, review date, and relevant internal links.',
      ].join('\n');
    if (recommendation.assetType === 'metadata') {
      const [page] = await db
        .select()
        .from(aiVisibilityCrawledPagesTable)
        .where(
          and(
            eq(aiVisibilityCrawledPagesTable.auditId, recommendation.auditId),
            eq(aiVisibilityCrawledPagesTable.userId, userId),
            sql`COALESCE(${aiVisibilityCrawledPagesTable.finalUrl}, ${aiVisibilityCrawledPagesTable.url}) = ${recommendation.affectedUrl}`,
          ),
        )
        .limit(1);
      const sourceTitle = page?.headings.h1?.[0] || page?.title || project.name;
      content = JSON.stringify(
        {
          title:
            sourceTitle.length <= 65
              ? sourceTitle
              : sourceTitle.slice(0, 65).replace(/\s+\S*$/, ''),
          description:
            page?.metaDescription ||
            (page?.contentExcerpt || '').replace(/\s+/g, ' ').slice(0, 155),
          sourceUrl: recommendation.affectedUrl,
          reviewRequired: true,
        },
        null,
        2,
      );
    }
    if (recommendation.assetType === 'json_ld') {
      let structured: Record<string, unknown>;
      try {
        structured = JSON.parse(content) as Record<string, unknown>;
      } catch {
        throw new AiVisibilityValidationError('Generated structured data is not valid JSON.');
      }
      if (
        structured['@context'] !== 'https://schema.org' ||
        typeof structured['@type'] !== 'string'
      ) {
        throw new AiVisibilityValidationError(
          'Generated JSON-LD must contain a schema.org @context and @type.',
        );
      }
    }
    const competitorGapKey =
      typeof recommendation.evidence.competitorGapKey === 'string'
        ? recommendation.evidence.competitorGapKey
        : null;
    if (competitorGapKey) {
      const [gapAsset] = await db
        .select({ asset: contentAssetsTable })
        .from(aiVisibilityGeneratedAssetLinksTable)
        .innerJoin(
          contentAssetsTable,
          and(
            eq(aiVisibilityGeneratedAssetLinksTable.contentAssetId, contentAssetsTable.id),
            eq(contentAssetsTable.userId, userId),
          ),
        )
        .where(
          and(
            eq(aiVisibilityGeneratedAssetLinksTable.userId, userId),
            eq(aiVisibilityGeneratedAssetLinksTable.projectId, projectId),
            eq(aiVisibilityGeneratedAssetLinksTable.auditId, recommendation.auditId),
            sql`${contentAssetsTable.metadata}->>'competitorGapKey' = ${competitorGapKey}`,
          ),
        )
        .limit(1);
      if (gapAsset) return gapAsset.asset;
    }
    const existing = await db
      .select({
        link: aiVisibilityGeneratedAssetLinksTable,
        asset: contentAssetsTable,
      })
      .from(aiVisibilityGeneratedAssetLinksTable)
      .innerJoin(
        contentAssetsTable,
        eq(aiVisibilityGeneratedAssetLinksTable.contentAssetId, contentAssetsTable.id),
      )
      .where(
        and(
          eq(aiVisibilityGeneratedAssetLinksTable.recommendationId, recommendationId),
          eq(aiVisibilityGeneratedAssetLinksTable.userId, userId),
        ),
      )
      .limit(1);
    if (existing[0]) return existing[0].asset;
    return db.transaction(async (tx: typeof db) => {
      const [asset] = await tx
        .insert(contentAssetsTable)
        .values({
          userId,
          businessProfileId: project.businessProfileId,
          brandToolkitId: project.brandToolkitId,
          type: recommendation.assetType || 'content_brief',
          title: recommendation.title,
          content,
          channel: 'ai_visibility',
          status: 'draft',
          approvalStatus: 'draft',
          metadata: {
            source: 'ai_visibility',
            projectId,
            auditId: recommendation.auditId,
            recommendationId,
            competitorGapKey,
            evidence: recommendation.evidence,
          },
        })
        .returning();
      await tx.insert(aiVisibilityGeneratedAssetLinksTable).values({
        userId,
        projectId,
        auditId: recommendation.auditId,
        recommendationId,
        contentAssetId: asset.id,
      });
      return asset;
    });
  }

  async correctPromptRun(userId: number, promptRunId: number, correction: ExtractionCorrection) {
    return db.transaction(async (tx: typeof db) => {
      const [run] = await tx
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
            eq(aiVisibilityPromptRunsTable.id, promptRunId),
            eq(aiVisibilityPromptRunsTable.userId, userId),
          ),
        )
        .limit(1)
        .for('update');
      if (!run) throw new AiVisibilityNotFoundError('Provider observation not found.');
      if (run.run.status !== 'completed' || !run.run.answer?.trim())
        throw new AiVisibilityValidationError('Only a collected provider answer can be corrected.');
      const [audit] = await tx
        .select()
        .from(aiVisibilityAuditsTable)
        .where(
          and(
            eq(aiVisibilityAuditsTable.id, run.run.auditId),
            eq(aiVisibilityAuditsTable.userId, userId),
          ),
        )
        .limit(1);
      if (!audit || !['completed', 'completed_with_warnings'].includes(audit.status))
        throw new AiVisibilityValidationError(
          'Wait for this analysis to complete before correcting its evidence.',
        );
      const effectiveCorrection: Record<string, unknown> = {
        brandMentioned:
          correction.brandMentioned !== undefined
            ? correction.brandMentioned
            : run.run.brandMentioned,
        brandRank: correction.brandRank !== undefined ? correction.brandRank : run.run.brandRank,
        sentiment: correction.sentiment !== undefined ? correction.sentiment : run.run.sentiment,
        competitors:
          correction.competitors !== undefined ? correction.competitors : run.run.competitors,
        recommendationReason:
          correction.recommendationReason !== undefined
            ? correction.recommendationReason
            : run.run.recommendationReason,
        exclusionReason:
          correction.exclusionReason !== undefined
            ? correction.exclusionReason
            : run.run.exclusionReason,
      };
      if (effectiveCorrection.brandMentioned === false) effectiveCorrection.brandRank = null;
      const [saved] = await tx
        .insert(aiVisibilityExtractionCorrectionsTable)
        .values({
          promptRunId,
          userId,
          normalizedPrompt: run.prompt.normalizedPrompt,
          provider: run.run.provider,
          correction: effectiveCorrection,
        })
        .onConflictDoUpdate({
          target: [aiVisibilityExtractionCorrectionsTable.businessProfileId,
            aiVisibilityExtractionCorrectionsTable.promptRunId,
            aiVisibilityExtractionCorrectionsTable.userId,
          ],
          set: { correction: effectiveCorrection, updatedAt: new Date() },
        })
        .returning();
      await tx
        .update(aiVisibilityPromptRunsTable)
        .set({
          brandMentioned:
            typeof effectiveCorrection.brandMentioned === 'boolean'
              ? effectiveCorrection.brandMentioned
              : null,
          brandRank:
            typeof effectiveCorrection.brandRank === 'number'
              ? effectiveCorrection.brandRank
              : null,
          sentiment:
            typeof effectiveCorrection.sentiment === 'string'
              ? effectiveCorrection.sentiment
              : null,
          competitors: Array.isArray(effectiveCorrection.competitors)
            ? effectiveCorrection.competitors.filter(
                (value: unknown): value is string => typeof value === 'string',
              )
            : [],
          recommendationReason:
            typeof effectiveCorrection.recommendationReason === 'string'
              ? effectiveCorrection.recommendationReason
              : null,
          exclusionReason:
            typeof effectiveCorrection.exclusionReason === 'string'
              ? effectiveCorrection.exclusionReason
              : null,
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
        .where(
          and(
            eq(aiVisibilityPromptRunsTable.id, promptRunId),
            eq(aiVisibilityPromptRunsTable.userId, userId),
          ),
        );
      await tx
        .update(aiVisibilityAuditsTable)
        .set({
          correctionRevision: sql`${aiVisibilityAuditsTable.correctionRevision} + 1`,
          correctedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityAuditsTable.id, run.run.auditId),
            eq(aiVisibilityAuditsTable.userId, userId),
          ),
        );
      return saved;
    });
  }

  async reports(userId: number, projectId: number) {
    await this.getProject(userId, projectId);
    return db
      .select({
        id: aiVisibilityReportsTable.id,
        auditId: aiVisibilityAuditsTable.id,
        projectId: aiVisibilityAuditsTable.projectId,
        auditStatus: aiVisibilityAuditsTable.status,
        correctionRevision: aiVisibilityAuditsTable.correctionRevision,
        correctedAt: aiVisibilityAuditsTable.correctedAt,
        status: sql<string>`COALESCE(${aiVisibilityReportsTable.status}, 'missing')`,
        error: sql<
          string | null
        >`COALESCE(${aiVisibilityReportsTable.error}, ${aiVisibilityAuditStagesTable.warning}, ${aiVisibilityAuditStagesTable.error})`,
        generationAttempt: aiVisibilityAuditStagesTable.attemptCount,
        generationStatus: aiVisibilityAuditStagesTable.status,
        sizeBytes: aiVisibilityReportsTable.sizeBytes,
        brandingSnapshot: aiVisibilityReportsTable.brandingSnapshot,
        methodology: aiVisibilityReportsTable.methodology,
        completedAt: aiVisibilityReportsTable.completedAt,
        createdAt: aiVisibilityAuditsTable.createdAt,
      })
      .from(aiVisibilityAuditsTable)
      .leftJoin(
        aiVisibilityReportsTable,
        and(
          eq(aiVisibilityReportsTable.auditId, aiVisibilityAuditsTable.id),
          eq(aiVisibilityReportsTable.userId, userId),
        ),
      )
      .leftJoin(
        aiVisibilityAuditStagesTable,
        and(
          eq(aiVisibilityAuditStagesTable.auditId, aiVisibilityAuditsTable.id),
          eq(aiVisibilityAuditStagesTable.stageKey, 'report_generation'),
        ),
      )
      .where(
        and(
          eq(aiVisibilityAuditsTable.projectId, projectId),
          eq(aiVisibilityAuditsTable.userId, userId),
          inArray(aiVisibilityAuditsTable.status, ['completed', 'completed_with_warnings']),
        ),
      )
      .orderBy(desc(aiVisibilityAuditsTable.createdAt));
  }

  async exportAuditCsv(userId: number, auditId: number) {
    const audit = await this.getAudit(userId, auditId);
    if (!['completed', 'completed_with_warnings'].includes(audit.status)) {
      throw new AiVisibilityValidationError(
        'CSV export is available only after an analysis has completed.',
      );
    }
    const project = await this.getProject(userId, audit.projectId);
    const [scoreRows, issues, promptRuns, recommendations, competitorRows] = await Promise.all([
      db
        .select()
        .from(aiVisibilityScoreSnapshotsTable)
        .where(
          and(
            eq(aiVisibilityScoreSnapshotsTable.auditId, auditId),
            eq(aiVisibilityScoreSnapshotsTable.userId, userId),
          ),
        )
        .limit(1),
      db
        .select()
        .from(aiVisibilitySeoIssuesTable)
        .where(
          and(
            eq(aiVisibilitySeoIssuesTable.auditId, auditId),
            eq(aiVisibilitySeoIssuesTable.userId, userId),
          ),
        )
        .orderBy(desc(aiVisibilitySeoIssuesTable.id)),
      db
        .select({
          provider: aiVisibilityPromptRunsTable.provider,
          model: aiVisibilityPromptRunsTable.model,
          status: aiVisibilityPromptRunsTable.status,
          fidelity: aiVisibilityPromptRunsTable.fidelity,
          brandMentioned: aiVisibilityPromptRunsTable.brandMentioned,
          brandRank: aiVisibilityPromptRunsTable.brandRank,
          sentiment: aiVisibilityPromptRunsTable.sentiment,
          citations: aiVisibilityPromptRunsTable.citations,
          extractionStatus: aiVisibilityPromptRunsTable.extractionStatus,
          error: aiVisibilityPromptRunsTable.error,
          extractionError: aiVisibilityPromptRunsTable.extractionError,
          promptText: aiVisibilityPromptsTable.prompt,
          answer: aiVisibilityPromptRunsTable.answer,
        })
        .from(aiVisibilityPromptRunsTable)
        .innerJoin(
          aiVisibilityPromptsTable,
          and(
            eq(aiVisibilityPromptsTable.id, aiVisibilityPromptRunsTable.promptId),
            eq(aiVisibilityPromptsTable.userId, userId),
          ),
        )
        .where(
          and(
            eq(aiVisibilityPromptRunsTable.auditId, auditId),
            eq(aiVisibilityPromptRunsTable.userId, userId),
          ),
        )
        .orderBy(aiVisibilityPromptRunsTable.id),
      db
        .select()
        .from(aiVisibilityRecommendationsTable)
        .where(
          and(
            eq(aiVisibilityRecommendationsTable.auditId, auditId),
            eq(aiVisibilityRecommendationsTable.userId, userId),
          ),
        )
        .orderBy(aiVisibilityRecommendationsTable.id),
      db
        .select({
          name: aiVisibilityCompetitorsTable.name,
          domain: aiVisibilityCompetitorsTable.domain,
          metrics: aiVisibilityCompetitorSnapshotsTable.metrics,
          contentGaps: aiVisibilityCompetitorSnapshotsTable.contentGaps,
        })
        .from(aiVisibilityCompetitorSnapshotsTable)
        .innerJoin(
          aiVisibilityCompetitorsTable,
          and(
            eq(aiVisibilityCompetitorsTable.id, aiVisibilityCompetitorSnapshotsTable.competitorId),
            eq(aiVisibilityCompetitorsTable.userId, userId),
          ),
        )
        .where(
          and(
            eq(aiVisibilityCompetitorSnapshotsTable.auditId, auditId),
            eq(aiVisibilityCompetitorSnapshotsTable.userId, userId),
          ),
        )
        .orderBy(aiVisibilityCompetitorSnapshotsTable.id),
    ]);
    const withdrawnFixes = await this.withdrawnFixIds(userId, audit.projectId, recommendations);
    // Gaps are re-checked with the current page types, as on the Competitors page.
    const comparison = await this.competitorIntelligence(userId, audit.projectId, auditId);
    const currentGaps = new Map(
      comparison.intelligence.competitors.map((item) => [item.domain, item.contentGaps]),
    );
    const competitors = competitorRows.map(
      (row: { domain: string; contentGaps: unknown }) => ({
        ...row,
        contentGaps: currentGaps.get(row.domain) ?? row.contentGaps,
      }),
    );
    return buildAiVisibilityCsv({
      audit,
      project,
      score: scoreRows[0] || null,
      issues: issues.filter(
        (issue: typeof aiVisibilitySeoIssuesTable.$inferSelect) =>
          !isWithdrawnLegacyRobotsFinding(issue.ruleId, issue.affectedUrl, issue.evidence),
      ),
      promptRuns,
      recommendations: recommendations.filter(
        (item: typeof aiVisibilityRecommendationsTable.$inferSelect) =>
          !withdrawnFixes.has(item.id),
      ),
      competitors,
    });
  }

  async exportAuditEvidence(userId: number, auditId: number) {
    const audit = await this.getAudit(userId, auditId);
    if (!['completed', 'completed_with_warnings'].includes(audit.status))
      throw new AiVisibilityValidationError('Evidence export requires a completed analysis.');
    const [overview, seo, aeo, geo, recommendations, competitors, pages, corrections, commerce] =
      await Promise.all([
        this.overview(userId, audit.projectId, auditId),
        this.seo(userId, audit.projectId, auditId),
        this.prompts(userId, audit.projectId, 'aeo', auditId),
        this.prompts(userId, audit.projectId, 'geo', auditId),
        this.recommendations(userId, audit.projectId, auditId),
        this.competitorIntelligence(userId, audit.projectId, auditId),
        db
          .select()
          .from(aiVisibilityCrawledPagesTable)
          .where(
            and(
              eq(aiVisibilityCrawledPagesTable.auditId, auditId),
              eq(aiVisibilityCrawledPagesTable.userId, userId),
            ),
          ),
        db
          .select({ correction: aiVisibilityExtractionCorrectionsTable })
          .from(aiVisibilityExtractionCorrectionsTable)
          .innerJoin(
            aiVisibilityPromptRunsTable,
            eq(aiVisibilityPromptRunsTable.id, aiVisibilityExtractionCorrectionsTable.promptRunId),
          )
          .where(
            and(
              eq(aiVisibilityPromptRunsTable.auditId, auditId),
              eq(aiVisibilityExtractionCorrectionsTable.userId, userId),
            ),
          ),
        db
          .select()
          .from(aiVisibilityCommerceSnapshotsTable)
          .where(
            and(
              eq(aiVisibilityCommerceSnapshotsTable.projectId, audit.projectId),
              eq(aiVisibilityCommerceSnapshotsTable.userId, userId),
              typeof audit.inputSnapshot.commerceSnapshotId === 'number'
                ? eq(aiVisibilityCommerceSnapshotsTable.id, audit.inputSnapshot.commerceSnapshotId)
                : audit.inputSnapshot.commerceSnapshotId === null
                  ? sql`false`
                  : lte(aiVisibilityCommerceSnapshotsTable.createdAt, audit.createdAt),
            ),
          )
          .orderBy(desc(aiVisibilityCommerceSnapshotsTable.createdAt))
          .limit(1),
      ]);
    return {
      exportVersion: 1,
      exportedAt: new Date().toISOString(),
      audit: {
        ...audit,
        stages: audit.stages.map((stage: typeof aiVisibilityAuditStagesTable.$inferSelect) => {
          if (!stage.output) return stage;
          const {
            storageFileId: _fileId,
            storageKey: _key,
            rawHtmlKey: _htmlKey,
            ...output
          } = stage.output;
          return { ...stage, output };
        }),
      },
      correctionPolicy: {
        revision: audit.correctionRevision,
        correctedAt: audit.correctedAt,
        scores:
          'Immutable historical scores from audit completion. Corrected observations below do not recompute those scores.',
        evidence:
          'Raw provider answer text remains unchanged. Structured observation fields include the labeled manual corrections.',
      },
      score: overview.latestScore,
      coverage: overview.coverage,
      analyzedConfiguration: audit.inputSnapshot,
      pages: pages.map(
        ({
          rawHtmlKey: _privateStorageKey,
          ...page
        }: typeof aiVisibilityCrawledPagesTable.$inferSelect) => page,
      ),
      seoIssues: seo.issues,
      aeo,
      geo,
      corrections: corrections.map(
        (item: { correction: typeof aiVisibilityExtractionCorrectionsTable.$inferSelect }) =>
          item.correction,
      ),
      recommendations,
      competitors,
      commerce: commerce.map(
        ({
          storageFileId: _storageFileId,
          ...snapshot
        }: typeof aiVisibilityCommerceSnapshotsTable.$inferSelect) => snapshot,
      ),
    };
  }

  async listReportDeliveries(userId: number, projectId: number) {
    await this.getProject(userId, projectId);
    return db
      .select({
        id: aiVisibilityReportDeliveriesTable.id,
        auditId: aiVisibilityReportDeliveriesTable.auditId,
        recipientEmail: aiVisibilityReportDeliveriesTable.recipientEmail,
        status: aiVisibilityReportDeliveriesTable.status,
        attempts: aiVisibilityReportDeliveriesTable.attempts,
        error: aiVisibilityReportDeliveriesTable.error,
        sentAt: aiVisibilityReportDeliveriesTable.sentAt,
        createdAt: aiVisibilityReportDeliveriesTable.createdAt,
        updatedAt: aiVisibilityReportDeliveriesTable.updatedAt,
      })
      .from(aiVisibilityReportDeliveriesTable)
      .where(
        and(
          eq(aiVisibilityReportDeliveriesTable.projectId, projectId),
          eq(aiVisibilityReportDeliveriesTable.userId, userId),
        ),
      )
      .orderBy(desc(aiVisibilityReportDeliveriesTable.createdAt));
  }

  async sendReportEmail(
    userId: number,
    auditId: number,
    recipientEmail: string,
    idempotencyKey: string,
  ) {
    const report = await this.getReport(userId, auditId);
    if (report.status !== 'completed' || !report.storageFileId) {
      throw new AiVisibilityValidationError(
        'Email delivery is available only for a completed PDF report.',
      );
    }
    const project = await this.getProject(userId, report.projectId);
    const normalizedRecipient = recipientEmail.trim().toLowerCase();
    const [created] = await db
      .insert(aiVisibilityReportDeliveriesTable)
      .values({
        reportId: report.id,
        auditId: report.auditId,
        projectId: report.projectId,
        userId,
        recipientEmail: normalizedRecipient,
        status: 'sending',
        idempotencyKey,
      })
      .onConflictDoNothing({
        target: [aiVisibilityReportDeliveriesTable.businessProfileId,
          aiVisibilityReportDeliveriesTable.userId,
          aiVisibilityReportDeliveriesTable.idempotencyKey,
        ],
      })
      .returning();
    let deliveryRecord = created;
    if (!deliveryRecord) {
      const [existing] = await db
        .select()
        .from(aiVisibilityReportDeliveriesTable)
        .where(
          and(
            eq(aiVisibilityReportDeliveriesTable.userId, userId),
            eq(aiVisibilityReportDeliveriesTable.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (!existing)
        throw new AiVisibilityDeliveryError('The report delivery state could not be reconciled.');
      if (existing.status !== 'failed') return existing;
      const [retrying] = await db
        .update(aiVisibilityReportDeliveriesTable)
        .set({
          status: 'sending',
          attempts: sql`${aiVisibilityReportDeliveriesTable.attempts} + 1`,
          error: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityReportDeliveriesTable.id, existing.id),
            eq(aiVisibilityReportDeliveriesTable.userId, userId),
            eq(aiVisibilityReportDeliveriesTable.status, 'failed'),
          ),
        )
        .returning();
      if (!retrying)
        throw new AiVisibilityDeliveryError('The report delivery is already being retried.');
      deliveryRecord = retrying;
    }

    try {
      const download = await storageService.downloadFile(report.storageFileId, userId);
      if (!download) throw new Error('The completed report file could not be loaded.');
      const { withInternalEmailDelivery } = await import('../InternalEmailDelivery.js');
      const delivery = await withInternalEmailDelivery('operator_report', () => emailService.sendEmailWithUserCredentials(userId, {
        to: normalizedRecipient,
        subject: `${project.name} — AI Visibility Audit #${auditId}`,
        html: `<p>Your AI Visibility audit for <strong>${escapeEmailHtml(project.name)}</strong> is attached.</p><p>Website: ${escapeEmailHtml(project.domain)}<br>Analysis: #${auditId}</p><p>This report preserves provider-fidelity and methodology disclosures.</p>`,
        text: `Your AI Visibility audit for ${project.name} is attached.\nWebsite: ${project.domain}\nAnalysis: #${auditId}`,
        attachments: [
          {
            filename: `ai-visibility-audit-${auditId}.pdf`,
            content: download.buffer,
            contentType: 'application/pdf',
            content_type: 'application/pdf',
          },
        ],
        skipConversationLog: true,
        skipCreditDeduction: true,
        idempotencyKey: `ai-visibility-report-${userId}-${idempotencyKey}`,
      }));
      if (!delivery.success)
        throw new Error(delivery.error || 'The connected email provider rejected the report.');
      const [sent] = await db
        .update(aiVisibilityReportDeliveriesTable)
        .set({
          status: 'sent',
          providerMessageId: delivery.providerMessageId || delivery.messageId || null,
          error: null,
          sentAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(aiVisibilityReportDeliveriesTable.id, deliveryRecord.id),
            eq(aiVisibilityReportDeliveriesTable.userId, userId),
          ),
        )
        .returning();
      return sent;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Report email delivery failed.';
      await db
        .update(aiVisibilityReportDeliveriesTable)
        .set({ status: 'failed', error: message, updatedAt: new Date() })
        .where(
          and(
            eq(aiVisibilityReportDeliveriesTable.id, deliveryRecord.id),
            eq(aiVisibilityReportDeliveriesTable.userId, userId),
          ),
        );
      throw new AiVisibilityDeliveryError(message);
    }
  }

  async listReportShares(userId: number, projectId: number) {
    await this.getProject(userId, projectId);
    const shares = await db
      .select({
        id: aiVisibilityReportSharesTable.id,
        auditId: aiVisibilityReportSharesTable.auditId,
        tokenPrefix: aiVisibilityReportSharesTable.tokenPrefix,
        expiresAt: aiVisibilityReportSharesTable.expiresAt,
        revokedAt: aiVisibilityReportSharesTable.revokedAt,
        lastAccessedAt: aiVisibilityReportSharesTable.lastAccessedAt,
        accessCount: aiVisibilityReportSharesTable.accessCount,
        createdAt: aiVisibilityReportSharesTable.createdAt,
      })
      .from(aiVisibilityReportSharesTable)
      .where(
        and(
          eq(aiVisibilityReportSharesTable.projectId, projectId),
          eq(aiVisibilityReportSharesTable.userId, userId),
        ),
      )
      .orderBy(desc(aiVisibilityReportSharesTable.createdAt));
    const now = Date.now();
    return shares.map(
      (share: {
        id: number;
        auditId: number;
        tokenPrefix: string;
        expiresAt: Date;
        revokedAt: Date | null;
        lastAccessedAt: Date | null;
        accessCount: number;
        createdAt: Date;
      }) => ({
        ...share,
        active: !share.revokedAt && share.expiresAt.getTime() > now,
      }),
    );
  }

  async createReportShare(userId: number, auditId: number, expiresInDays: number) {
    const report = await this.getReport(userId, auditId);
    if (report.status !== 'completed' || !report.storageFileId) {
      throw new AiVisibilityValidationError(
        'A share link can be created only for a completed PDF report.',
      );
    }
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const expiresAt = new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000);
    const [share] = await db
      .insert(aiVisibilityReportSharesTable)
      .values({
        reportId: report.id,
        auditId: report.auditId,
        projectId: report.projectId,
        userId,
        tokenHash,
        tokenPrefix: token.slice(0, 10),
        expiresAt,
      })
      .returning({
        id: aiVisibilityReportSharesTable.id,
        auditId: aiVisibilityReportSharesTable.auditId,
        tokenPrefix: aiVisibilityReportSharesTable.tokenPrefix,
        expiresAt: aiVisibilityReportSharesTable.expiresAt,
        createdAt: aiVisibilityReportSharesTable.createdAt,
      });
    return {
      share: {
        ...share,
        active: true,
        revokedAt: null,
        lastAccessedAt: null,
        accessCount: 0,
      },
      token,
    };
  }

  async revokeReportShare(userId: number, projectId: number, shareId: number) {
    await this.getProject(userId, projectId);
    const [share] = await db
      .update(aiVisibilityReportSharesTable)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(aiVisibilityReportSharesTable.id, shareId),
          eq(aiVisibilityReportSharesTable.projectId, projectId),
          eq(aiVisibilityReportSharesTable.userId, userId),
          isNull(aiVisibilityReportSharesTable.revokedAt),
        ),
      )
      .returning();
    if (share) return { ...share, active: false };
    const [existing] = await db
      .select()
      .from(aiVisibilityReportSharesTable)
      .where(
        and(
          eq(aiVisibilityReportSharesTable.id, shareId),
          eq(aiVisibilityReportSharesTable.projectId, projectId),
          eq(aiVisibilityReportSharesTable.userId, userId),
        ),
      )
      .limit(1);
    if (!existing) throw new AiVisibilityNotFoundError('Report share link not found.');
    return { ...existing, active: false };
  }

  async getSharedReport(token: string) {
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [result] = await db
      .select({
        share: aiVisibilityReportSharesTable,
        report: aiVisibilityReportsTable,
      })
      .from(aiVisibilityReportSharesTable)
      .innerJoin(
        aiVisibilityReportsTable,
        and(
          eq(aiVisibilityReportsTable.id, aiVisibilityReportSharesTable.reportId),
          eq(aiVisibilityReportsTable.auditId, aiVisibilityReportSharesTable.auditId),
          eq(aiVisibilityReportsTable.projectId, aiVisibilityReportSharesTable.projectId),
          eq(aiVisibilityReportsTable.userId, aiVisibilityReportSharesTable.userId),
        ),
      )
      .where(
        and(
          eq(aiVisibilityReportSharesTable.tokenHash, tokenHash),
          isNull(aiVisibilityReportSharesTable.revokedAt),
          gt(aiVisibilityReportSharesTable.expiresAt, new Date()),
          eq(aiVisibilityReportsTable.status, 'completed'),
        ),
      )
      .limit(1);
    if (!result?.report.storageFileId)
      throw new AiVisibilityNotFoundError('Shared report not found or no longer available.');
    await db
      .update(aiVisibilityReportSharesTable)
      .set({
        lastAccessedAt: new Date(),
        accessCount: sql`${aiVisibilityReportSharesTable.accessCount} + 1`,
      })
      .where(eq(aiVisibilityReportSharesTable.id, result.share.id));
    return result.report;
  }

  async getReport(userId: number, auditId: number) {
    await this.getAudit(userId, auditId);
    const [report] = await db
      .select()
      .from(aiVisibilityReportsTable)
      .where(
        and(
          eq(aiVisibilityReportsTable.auditId, auditId),
          eq(aiVisibilityReportsTable.userId, userId),
        ),
      )
      .limit(1);
    if (!report) throw new AiVisibilityNotFoundError('Audit report is not ready.');
    return report;
  }

  async assetVersions(userId: number, projectId: number, generatedAssetLinkId: number) {
    const assets = await this.assets(userId, projectId);
    const asset = assets.find((item: { id: number }) => item.id === generatedAssetLinkId);
    if (!asset) throw new AiVisibilityNotFoundError('Generated asset not found.');
    const versions = await db
      .select()
      .from(aiVisibilityAssetVersionsTable)
      .where(eq(aiVisibilityAssetVersionsTable.generatedAssetLinkId, generatedAssetLinkId))
      .orderBy(desc(aiVisibilityAssetVersionsTable.version));
    return versions.some((item: { version: number }) => item.version === asset.version)
      ? versions
      : [
          {
            generatedAssetLinkId,
            version: asset.version,
            title: asset.title,
            content: asset.content,
            actorUserId: null,
            createdAt: asset.createdAt,
          },
          ...versions,
        ];
  }

  async editAsset(
    userId: number,
    projectId: number,
    generatedAssetLinkId: number,
    actorUserId: number,
    input: { version: number; title: string; content: string },
  ) {
    await this.getProject(userId, projectId);
    return db.transaction(async (tx: typeof db) => {
      const [record] = await tx
        .select({
          asset: contentAssetsTable,
          link: aiVisibilityGeneratedAssetLinksTable,
        })
        .from(aiVisibilityGeneratedAssetLinksTable)
        .innerJoin(
          contentAssetsTable,
          and(
            eq(contentAssetsTable.id, aiVisibilityGeneratedAssetLinksTable.contentAssetId),
            eq(contentAssetsTable.userId, userId),
          ),
        )
        .where(
          and(
            eq(aiVisibilityGeneratedAssetLinksTable.id, generatedAssetLinkId),
            eq(aiVisibilityGeneratedAssetLinksTable.projectId, projectId),
            eq(aiVisibilityGeneratedAssetLinksTable.userId, userId),
          ),
        )
        .limit(1)
        .for('update');
      if (!record) throw new AiVisibilityNotFoundError('Generated asset not found.');
      const asset = record.asset;
      if (asset.version !== input.version)
        throw new AiVisibilityConflictError(
          'This asset changed while you were editing. Reload its latest version.',
        );
      let validationSnapshot: Record<string, unknown> = {
        valid: true,
        validator: 'editorial_draft_v1',
        reviewRequired: true,
      };
      if (['json_ld', 'faq_page', 'metadata'].includes(asset.type)) {
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(input.content);
        } catch {
          throw new AiVisibilityValidationError('Enter valid JSON before saving this asset.');
        }
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object')
          throw new AiVisibilityValidationError('The structured asset must be a JSON object.');
        if (asset.type === 'faq_page') {
          const validation = validateFaqPageJsonLd(parsed);
          if (!validation.valid) throw new AiVisibilityValidationError(validation.error);
        } else if (
          asset.type === 'json_ld' &&
          (parsed['@context'] !== 'https://schema.org' || typeof parsed['@type'] !== 'string')
        ) {
          throw new AiVisibilityValidationError('JSON-LD needs a schema.org context and type.');
        }
        validationSnapshot = {
          valid: true,
          validator: 'edited_structured_asset_v1',
          reviewRequired: true,
        };
      }
      await tx
        .insert(aiVisibilityAssetVersionsTable)
        .values({
          generatedAssetLinkId,
          version: asset.version,
          title: asset.title,
          content: asset.content,
          actorUserId: null,
          createdAt: asset.version === 1 ? asset.createdAt : asset.updatedAt,
        })
        .onConflictDoNothing();
      const [saved] = await tx
        .update(contentAssetsTable)
        .set({
          title: input.title.trim(),
          content: input.content,
          version: asset.version + 1,
          approvalStatus: 'draft',
          approvedBy: null,
          approvedAt: null,
          status: 'draft',
          validationSnapshot,
          updatedAt: new Date(),
        })
        .where(and(eq(contentAssetsTable.id, asset.id), eq(contentAssetsTable.userId, userId)))
        .returning();
      await tx.insert(aiVisibilityAssetVersionsTable).values({
        generatedAssetLinkId,
        version: saved.version,
        title: saved.title,
        content: saved.content,
        actorUserId,
      });
      return saved;
    });
  }

  async assets(userId: number, projectId: number) {
    await this.getProject(userId, projectId);
    return db
      .select({
        id: aiVisibilityGeneratedAssetLinksTable.id,
        auditId: aiVisibilityGeneratedAssetLinksTable.auditId,
        recommendationId: aiVisibilityGeneratedAssetLinksTable.recommendationId,
        contentAssetId: aiVisibilityGeneratedAssetLinksTable.contentAssetId,
        title: contentAssetsTable.title,
        type: contentAssetsTable.type,
        content: contentAssetsTable.content,
        status: contentAssetsTable.status,
        approvalStatus: contentAssetsTable.approvalStatus,
        version: contentAssetsTable.version,
        metadata: contentAssetsTable.metadata,
        validationSnapshot: contentAssetsTable.validationSnapshot,
        createdAt: aiVisibilityGeneratedAssetLinksTable.createdAt,
      })
      .from(aiVisibilityGeneratedAssetLinksTable)
      .innerJoin(
        contentAssetsTable,
        and(
          eq(contentAssetsTable.id, aiVisibilityGeneratedAssetLinksTable.contentAssetId),
          eq(contentAssetsTable.userId, userId),
        ),
      )
      .where(
        and(
          eq(aiVisibilityGeneratedAssetLinksTable.projectId, projectId),
          eq(aiVisibilityGeneratedAssetLinksTable.userId, userId),
        ),
      )
      .orderBy(desc(aiVisibilityGeneratedAssetLinksTable.createdAt));
  }

  async alerts(userId: number, projectId: number) {
    await this.getProject(userId, projectId);
    const alerts = await db
      .select()
      .from(aiVisibilityAlertsTable)
      .where(
        and(
          eq(aiVisibilityAlertsTable.projectId, projectId),
          eq(aiVisibilityAlertsTable.userId, userId),
        ),
      )
      .orderBy(desc(aiVisibilityAlertsTable.createdAt));
    const countedIds = [
      ...new Set<number>(
        alerts.flatMap((alert: typeof aiVisibilityAlertsTable.$inferSelect) => alertRecommendationIds(alert)),
      ),
    ];
    if (!countedIds.length) return alerts;
    const counted = await db
      .select()
      .from(aiVisibilityRecommendationsTable)
      .where(
        and(
          inArray(aiVisibilityRecommendationsTable.id, countedIds),
          eq(aiVisibilityRecommendationsTable.userId, userId),
        ),
      );
    const withdrawn = await this.withdrawnFixIds(userId, projectId, counted);
    return alerts
      .map((alert: typeof aiVisibilityAlertsTable.$inferSelect) => withoutWithdrawnFixes(alert, withdrawn))
      .filter(Boolean);
  }

  async acknowledgeAlert(userId: number, projectId: number, alertId: number) {
    await this.getProject(userId, projectId);
    const [alert] = await db
      .update(aiVisibilityAlertsTable)
      .set({ acknowledgedAt: new Date() })
      .where(
        and(
          eq(aiVisibilityAlertsTable.id, alertId),
          eq(aiVisibilityAlertsTable.projectId, projectId),
          eq(aiVisibilityAlertsTable.userId, userId),
        ),
      )
      .returning();
    if (!alert) throw new AiVisibilityNotFoundError('AI Visibility alert not found.');
    return alert;
  }

  async updateMonitoring(userId: number, projectId: number, enabled: boolean) {
    const project = await this.getProject(userId, projectId);
    const estimatedCredits = enabled
      ? (await this.estimateAudit(userId, projectId, 'monitoring')).estimatedMaximum
      : 0;
    const [updated] = await db
      .update(aiVisibilityProjectsTable)
      .set({
        monitoringEnabled: enabled,
        monitoringEstimatedCredits: estimatedCredits.toFixed(2),
        nextMonitoringAt: enabled ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(aiVisibilityProjectsTable.id, project.id),
          eq(aiVisibilityProjectsTable.userId, userId),
        ),
      )
      .returning();
    return updated;
  }
}

export const aiVisibilityService = new AiVisibilityService();
