import { businessProfileColumn } from "../businessProfileColumn.js";
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { usersTable } from '../users/schema.js';
import { companySettings } from '../companySettings/schema.js';
import { brandToolkitsTable } from '../brandToolkits/schema.js';
import { contentAssetsTable } from '../contentAssets/schema.js';
import { apiCredentialsTable } from '../apiCredentials/schema.js';

export type AiVisibilityProfile = 'b2b_saas' | 'ecommerce' | 'local_business' | 'general';
export type AuditStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'completed_with_warnings'
  | 'failed'
  | 'cancelled';
export type StageStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'warning'
  | 'failed'
  | 'skipped'
  | 'cancelled';
// New observation runs are constrained by AI_VISIBILITY_OBSERVATION_PROVIDERS
// in the service layer; 'manual' is kept for older rows.
export type ProviderName = 'openai' | 'gemini' | 'perplexity' | 'claude' | 'manual';
export type ProviderFidelity = 'live_api' | 'manual_capture' | 'simulated';
export type RecommendationStatus = 'open' | 'in_progress' | 'resolved' | 'rejected';
export type PillarStatus = 'scored' | 'not_applicable' | 'unavailable';
export type CmsPlatform = 'wordpress' | 'shopify';
export type CmsPublishAttemptStatus =
  | 'pending'
  | 'sending'
  | 'draft_created'
  | 'retryable_failed'
  | 'ambiguous'
  | 'failed';
export type AiVisibilityWorkspaceRole = 'owner' | 'billing_admin' | 'member' | 'agency_admin' | 'editor' | 'client_reviewer';
export type AiVisibilityWorkspaceKind = 'private' | 'client';

export interface AiVisibilityWhiteLabelDefaults {
  displayName?: string;
  tagline?: string;
  primaryColor?: string;
  accentColor?: string;
}

export interface GscPropertyAccess {
  siteUrl: string;
  permissionLevel: string;
}

export const AI_VISIBILITY_STAGE_KEYS = [
  'intake',
  'brand_crawl',
  'competitor_crawls',
  'seo_analysis',
  'prompt_generation',
  'provider_collection',
  'answer_extraction',
  'competitor_analysis',
  'scoring',
  'fix_generation',
  'report_generation',
  'alert_detection',
  'final_snapshot',
] as const;

export const aiVisibilityOrganizationsTable = pgTable(
  'ai_visibility_organizations',
  {
    id: serial('id').primaryKey(),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    slug: varchar('slug', { length: 100 }).notNull(),
    whiteLabelDefaults: jsonb('white_label_defaults')
      .$type<AiVisibilityWhiteLabelDefaults>()
      .default({})
      .notNull(),
    status: varchar('status', { length: 24 }).default('active').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    ownerIdx: index('ai_visibility_organizations_owner_idx').on(table.ownerUserId, table.updatedAt),
    ownerSlugUq: uniqueIndex('ai_visibility_organizations_owner_slug_uq').on(
      table.ownerUserId,
      table.slug,
    ),
  }),
);

export const aiVisibilityWorkspacesTable = pgTable(
  'ai_visibility_workspaces',
  {
    id: serial('id').primaryKey(),
    businessProfileId: integer('business_profile_id').references(() => companySettings.id, {onDelete:'cascade'}),
    billingOrganizationId: integer('billing_organization_id').notNull().default(sql`app_billing_organization_id()`),
    organizationId: integer('organization_id').references(() => aiVisibilityOrganizationsTable.id, {
      onDelete: 'set null',
    }),
    ownerUserId: integer('owner_user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    kind: varchar('kind', { length: 24 })
      .$type<AiVisibilityWorkspaceKind>()
      .default('private')
      .notNull(),
    whiteLabelDefaults: jsonb('white_label_defaults')
      .$type<AiVisibilityWhiteLabelDefaults>()
      .default({})
      .notNull(),
    status: varchar('status', { length: 24 }).default('active').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    ownerIdx: index('ai_visibility_workspaces_owner_idx').on(table.ownerUserId, table.updatedAt),
    organizationIdx: index('ai_visibility_workspaces_organization_idx').on(
      table.organizationId,
      table.updatedAt,
    ),
  }),
);

export const aiVisibilityWorkspaceMembershipsTable = pgTable(
  'ai_visibility_workspace_memberships',
  {
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => aiVisibilityWorkspacesTable.id, {
        onDelete: 'cascade',
      }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    role: varchar('role', { length: 32 }).$type<AiVisibilityWorkspaceRole>().notNull(),
    status: varchar('status', { length: 24 }).default('active').notNull(),
    invitedByUserId: integer('invited_by_user_id').references(() => usersTable.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    workspaceUserUq: uniqueIndex('ai_visibility_workspace_memberships_workspace_user_uq').on(
      table.workspaceId,
      table.userId,
    ),
    userIdx: index('ai_visibility_workspace_memberships_user_idx').on(table.userId, table.status),
  }),
);

export interface CustomGeoPrompt {
  id: string;
  prompt: string;
  intent: string;
  isGeneric: boolean;
  active: boolean;
}

export const aiVisibilityProjectsTable = pgTable(
  'ai_visibility_projects',
  {
    id: serial('id').primaryKey(),
    configurationRevision: integer('configuration_revision').default(1).notNull(),
    geoPrompts: jsonb('geo_prompts').$type<CustomGeoPrompt[]>().default([]).notNull(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => aiVisibilityWorkspacesTable.id, {
        onDelete: 'restrict',
      }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    businessProfileId: integer('business_profile_id').references(() => companySettings.id, {
      onDelete: 'set null',
    }),
    brandToolkitId: integer('brand_toolkit_id').references(() => brandToolkitsTable.id, {
      onDelete: 'set null',
    }),
    name: varchar('name', { length: 255 }).notNull(),
    domain: text('domain').notNull(),
    brandAliases: jsonb('brand_aliases').$type<string[]>().default([]).notNull(),
    category: varchar('category', { length: 255 }),
    scoringProfile: varchar('scoring_profile', { length: 32 })
      .$type<AiVisibilityProfile>()
      .default('general')
      .notNull(),
    scoringProfileVersion: integer('scoring_profile_version').default(1).notNull(),
    country: varchar('country', { length: 2 }).default('US').notNull(),
    locale: varchar('locale', { length: 16 }).default('en-US').notNull(),
    targetGeography: text('target_geography'),
    monitoringEnabled: boolean('monitoring_enabled').default(false).notNull(),
    monitoringCadence: varchar('monitoring_cadence', { length: 16 }).default('weekly').notNull(),
    monitoringEstimatedCredits: numeric('monitoring_estimated_credits', {
      precision: 12,
      scale: 2,
    })
      .default('0')
      .notNull(),
    nextMonitoringAt: timestamp('next_monitoring_at', { withTimezone: true }),
    source: varchar('source', { length: 24 }).default('legacy').notNull(),
    status: varchar('status', { length: 24 }).default('active').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIdx: index('ai_visibility_projects_user_idx').on(table.userId, table.updatedAt),
    workspaceIdx: index('ai_visibility_projects_workspace_idx').on(
      table.workspaceId,
      table.updatedAt,
    ),
    domainIdx: index('ai_visibility_projects_domain_idx').on(table.domain),
  }),
);

export const aiVisibilityCompetitorsTable = pgTable(
  'ai_visibility_competitors',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    name: varchar('name', { length: 255 }).notNull(),
    domain: text('domain').notNull(),
    aliases: jsonb('aliases').$type<string[]>().default([]).notNull(),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index('ai_visibility_competitors_project_idx').on(table.projectId, table.active),
    projectDomainUq: uniqueIndex('ai_visibility_competitors_project_domain_uq').on(
      table.projectId,
      table.domain,
    ),
  }),
);

export const aiVisibilityAuditsTable = pgTable(
  'ai_visibility_audits',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    correctionRevision: integer('correction_revision').default(0).notNull(),
    correctedAt: timestamp('corrected_at', { withTimezone: true }),
    status: varchar('status', { length: 32 }).$type<AuditStatus>().default('queued').notNull(),
    trigger: varchar('trigger', { length: 24 }).default('manual').notNull(),
    warningCount: integer('warning_count').default(0).notNull(),
    error: text('error'),
    cancellationRequested: boolean('cancellation_requested').default(false).notNull(),
    reservedCredits: numeric('reserved_credits', { precision: 12, scale: 2 })
      .default('0')
      .notNull(),
    actualCredits: numeric('actual_credits', { precision: 12, scale: 2 }).default('0').notNull(),
    reservationTransactionId: integer('reservation_transaction_id'),
    billingMode: varchar('billing_mode', { length: 16 })
      .$type<'reservation' | 'direct'>()
      .default('reservation')
      .notNull(),
    initialChargeTransactionId: integer('initial_charge_transaction_id'),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    inputFingerprint: varchar('input_fingerprint', { length: 64 }),
    inputSnapshot: jsonb('input_snapshot').$type<Record<string, unknown>>().default({}).notNull(),
    monitoringPeriodKey: varchar('monitoring_period_key', { length: 16 }),
    summary: jsonb('summary').$type<Record<string, unknown>>().default({}).notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index('ai_visibility_audits_project_idx').on(table.projectId, table.createdAt),
    userStatusIdx: index('ai_visibility_audits_user_status_idx').on(table.userId, table.status),
  }),
);

export const aiVisibilityAuditStagesTable = pgTable(
  'ai_visibility_audit_stages',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    stageKey: varchar('stage_key', { length: 48 }).notNull(),
    status: varchar('status', { length: 24 }).$type<StageStatus>().default('pending').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    progress: integer('progress').default(0).notNull(),
    outputFingerprint: varchar('output_fingerprint', { length: 64 }),
    output: jsonb('output').$type<Record<string, unknown>>(),
    warning: text('warning'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    auditStageUq: uniqueIndex('ai_visibility_audit_stages_audit_stage_uq').on(
      table.auditId,
      table.stageKey,
    ),
    auditStatusIdx: index('ai_visibility_audit_stages_status_idx').on(table.auditId, table.status),
  }),
);

export const aiVisibilityCrawledPagesTable = pgTable(
  'ai_visibility_crawled_pages',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    competitorId: integer('competitor_id').references(() => aiVisibilityCompetitorsTable.id, {
      onDelete: 'set null',
    }),
    targetType: varchar('target_type', { length: 16 }).default('brand').notNull(),
    url: text('url').notNull(),
    finalUrl: text('final_url'),
    crawlStatus: varchar('crawl_status', { length: 24 }).default('completed').notNull(),
    statusCode: integer('status_code'),
    redirectCount: integer('redirect_count').default(0).notNull(),
    redirectChain: jsonb('redirect_chain')
      .$type<Array<{ url: string; statusCode: number | null; destination: string }>>()
      .default([])
      .notNull(),
    title: text('title'),
    metaDescription: text('meta_description'),
    canonicalUrl: text('canonical_url'),
    robotsDirective: text('robots_directive'),
    indexable: boolean('indexable').default(true).notNull(),
    headings: jsonb('headings').$type<Record<string, string[]>>().default({}).notNull(),
    wordCount: integer('word_count').default(0).notNull(),
    imageCount: integer('image_count').default(0).notNull(),
    imagesMissingAlt: integer('images_missing_alt').default(0).notNull(),
    missingAltElements: jsonb('missing_alt_elements')
      .$type<Array<{ index: number; source: string; html: string }>>()
      .default([])
      .notNull(),
    internalLinks: jsonb('internal_links').$type<string[]>().default([]).notNull(),
    externalLinks: jsonb('external_links').$type<string[]>().default([]).notNull(),
    brokenLinks: jsonb('broken_links').$type<string[]>().default([]).notNull(),
    linkChecks: jsonb('link_checks')
      .$type<
        Array<{
          url: string;
          finalUrl?: string;
          statusCode?: number;
          redirectCount: number;
          redirectChain?: Array<{
            url: string;
            statusCode: number | null;
            destination: string;
          }>;
          status: 'ok' | 'broken' | 'unavailable';
          error?: string;
        }>
      >()
      .default([])
      .notNull(),
    jsonLd: jsonb('json_ld').$type<unknown[]>().default([]).notNull(),
    jsonLdErrors: jsonb('json_ld_errors')
      .$type<Array<{ scriptIndex: number; code: string; message: string }>>()
      .default([])
      .notNull(),
    schemaTypes: jsonb('schema_types').$type<string[]>().default([]).notNull(),
    pageType: varchar('page_type', { length: 48 }),
    contentHash: varchar('content_hash', { length: 64 }),
    contentExcerpt: text('content_excerpt'),
    rawHtmlKey: text('raw_html_key'),
    error: text('error'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    auditTargetIdx: index('ai_visibility_crawled_pages_audit_target_idx').on(
      table.auditId,
      table.targetType,
    ),
    auditUrlUq: uniqueIndex('ai_visibility_crawled_pages_audit_url_uq').on(
      table.auditId,
      table.targetType,
      table.url,
    ),
  }),
);

export const aiVisibilitySeoIssuesTable = pgTable(
  'ai_visibility_seo_issues',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    pageId: integer('page_id').references(() => aiVisibilityCrawledPagesTable.id, {
      onDelete: 'cascade',
    }),
    ruleId: varchar('rule_id', { length: 80 }).notNull(),
    ruleVersion: integer('rule_version').default(1).notNull(),
    group: varchar('group_name', { length: 40 }).notNull(),
    severity: varchar('severity', { length: 16 }).notNull(),
    affectedUrl: text('affected_url'),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().default({}).notNull(),
    recommendation: text('recommendation').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    auditIdx: index('ai_visibility_seo_issues_audit_idx').on(table.auditId, table.severity),
  }),
);

export const aiVisibilityPromptsTable = pgTable(
  'ai_visibility_prompts',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 16 }).notNull(),
    prompt: text('prompt').notNull(),
    normalizedPrompt: text('normalized_prompt').notNull(),
    promptHash: varchar('prompt_hash', { length: 64 }).notNull(),
    intent: varchar('intent', { length: 48 }),
    persona: varchar('persona', { length: 100 }),
    locale: varchar('locale', { length: 16 }).notNull(),
    targetPage: text('target_page'),
    isGeneric: boolean('is_generic').default(false).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    auditIdx: index('ai_visibility_prompts_audit_idx').on(table.auditId, table.kind),
  }),
);

export const aiVisibilityAeoQuestionsTable = pgTable(
  'ai_visibility_aeo_questions',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    question: text('question').notNull(),
    intent: varchar('intent', { length: 48 }).default('informational').notNull(),
    targetPage: text('target_page'),
    active: boolean('active').default(true).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index('ai_visibility_aeo_questions_project_idx').on(table.projectId, table.active),
  }),
);

export const aiVisibilityPromptRunsTable = pgTable(
  'ai_visibility_prompt_runs',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    promptId: integer('prompt_id')
      .notNull()
      .references(() => aiVisibilityPromptsTable.id, { onDelete: 'cascade' }),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    provider: varchar('provider', { length: 24 }).$type<ProviderName>().notNull(),
    model: varchar('model', { length: 100 }).notNull(),
    fidelity: varchar('fidelity', { length: 24 }).$type<ProviderFidelity>().notNull(),
    status: varchar('status', { length: 24 }).default('completed').notNull(),
    answer: text('answer'),
    citations: jsonb('citations')
      .$type<Array<{ url: string; title?: string }>>()
      .default([])
      .notNull(),
    brandMentioned: boolean('brand_mentioned'),
    brandRank: integer('brand_rank'),
    sentiment: varchar('sentiment', { length: 24 }),
    competitors: jsonb('competitors').$type<string[]>().default([]).notNull(),
    recommendationReason: text('recommendation_reason'),
    exclusionReason: text('exclusion_reason'),
    extractionStatus: varchar('extraction_status', { length: 24 }).default('pending').notNull(),
    extractionMethod: varchar('extraction_method', { length: 48 }),
    extractionProvider: varchar('extraction_provider', { length: 24 }),
    extractionModel: varchar('extraction_model', { length: 100 }),
    extractionFidelity: varchar('extraction_fidelity', { length: 24 }),
    extractionError: text('extraction_error'),
    extractionInputTokens: integer('extraction_input_tokens'),
    extractionOutputTokens: integer('extraction_output_tokens'),
    extractionCostCents: numeric('extraction_cost_cents', {
      precision: 12,
      scale: 4,
    })
      .default('0')
      .notNull(),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costCents: numeric('cost_cents', { precision: 12, scale: 4 }).default('0').notNull(),
    cacheKey: varchar('cache_key', { length: 160 }),
    cachedFromRunId: integer('cached_from_run_id'),
    error: text('error'),
    capturedAt: timestamp('captured_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    auditProviderIdx: index('ai_visibility_prompt_runs_audit_provider_idx').on(
      table.auditId,
      table.provider,
    ),
    promptProviderUq: uniqueIndex('ai_visibility_prompt_runs_prompt_provider_uq').on(
      table.promptId,
      table.provider,
    ),
  }),
);

export const aiVisibilityExtractionCorrectionsTable = pgTable(
  'ai_visibility_extraction_corrections',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    promptRunId: integer('prompt_run_id')
      .notNull()
      .references(() => aiVisibilityPromptRunsTable.id, {
        onDelete: 'cascade',
      }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    normalizedPrompt: text('normalized_prompt').notNull(),
    provider: varchar('provider', { length: 24 }).notNull(),
    correction: jsonb('correction').$type<Record<string, unknown>>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    runUserUq: uniqueIndex('ai_visibility_extraction_corrections_run_user_uq').on(table.businessProfileId,
      table.promptRunId,
      table.userId,
    ),
  }),
);

export const aiVisibilityScoreSnapshotsTable = pgTable(
  'ai_visibility_score_snapshots',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    scoringProfile: varchar('scoring_profile', { length: 32 }).notNull(),
    scoringVersion: integer('scoring_version').default(1).notNull(),
    inputFingerprint: varchar('input_fingerprint', { length: 64 }).notNull(),
    overallScore: numeric('overall_score', {
      precision: 6,
      scale: 2,
    }).notNull(),
    seoScore: numeric('seo_score', { precision: 6, scale: 2 }),
    aeoScore: numeric('aeo_score', { precision: 6, scale: 2 }),
    geoScore: numeric('geo_score', { precision: 6, scale: 2 }),
    commerceScore: numeric('commerce_score', { precision: 6, scale: 2 }),
    pillarStatuses: jsonb('pillar_statuses').$type<Record<string, PillarStatus>>().notNull(),
    metrics: jsonb('metrics').$type<Record<string, number | string | null>>().default({}).notNull(),
    subScores: jsonb('sub_scores').$type<Record<string, number>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectCreatedIdx: index('ai_visibility_score_snapshots_project_created_idx').on(
      table.projectId,
      table.createdAt,
    ),
    auditUq: uniqueIndex('ai_visibility_score_snapshots_audit_uq').on(table.auditId),
  }),
);

export const aiVisibilityCompetitorSnapshotsTable = pgTable(
  'ai_visibility_competitor_snapshots',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    competitorId: integer('competitor_id').references(() => aiVisibilityCompetitorsTable.id, {
      onDelete: 'set null',
    }),
    metrics: jsonb('metrics').$type<Record<string, unknown>>().notNull(),
    contentGaps: jsonb('content_gaps').$type<unknown[]>().default([]).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    auditIdx: index('ai_visibility_competitor_snapshots_audit_idx').on(table.auditId),
  }),
);

export const aiVisibilityCommerceSnapshotsTable = pgTable(
  'ai_visibility_commerce_snapshots',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    auditId: integer('audit_id').references(() => aiVisibilityAuditsTable.id, {
      onDelete: 'set null',
    }),
    sourceType: varchar('source_type', { length: 24 }).notNull(),
    sourceName: varchar('source_name', { length: 255 }).notNull(),
    storageFileId: integer('storage_file_id'),
    inputFingerprint: varchar('input_fingerprint', { length: 64 }).notNull(),
    itemCount: integer('item_count').notNull(),
    validItemCount: integer('valid_item_count').notNull(),
    score: numeric('score', { precision: 6, scale: 2 }).notNull(),
    status: varchar('status', { length: 24 }).default('scored').notNull(),
    fieldCoverage: jsonb('field_coverage').$type<Record<string, number>>().notNull(),
    issues: jsonb('issues')
      .$type<
        Array<{
          field: string;
          missing: number;
          invalid?: number;
          code?: string;
          severity: string;
          message: string;
        }>
      >()
      .default([])
      .notNull(),
    summary: jsonb('summary').$type<Record<string, unknown>>().default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectCreatedIdx: index('ai_visibility_commerce_snapshots_project_created_idx').on(
      table.projectId,
      table.createdAt,
    ),
  }),
);

export const aiVisibilityRecommendationsTable = pgTable(
  'ai_visibility_recommendations',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    issueKey: varchar('issue_key', { length: 64 }),
    assigneeUserId: integer('assignee_user_id').references(() => usersTable.id, {
      onDelete: 'set null',
    }),
    dueDate: date('due_date'),
    resolutionEvidence: text('resolution_evidence'),
    verificationStatus: varchar('verification_status', { length: 24 })
      .default('unverified')
      .notNull(),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    module: varchar('module', { length: 24 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    description: text('description').notNull(),
    severity: varchar('severity', { length: 16 }).notNull(),
    impact: varchar('impact', { length: 16 }).notNull(),
    effort: varchar('effort', { length: 16 }).notNull(),
    affectedUrl: text('affected_url'),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().default({}).notNull(),
    confidence: numeric('confidence', { precision: 5, scale: 2 }).default('1').notNull(),
    status: varchar('status', { length: 24 })
      .$type<RecommendationStatus>()
      .default('open')
      .notNull(),
    assetType: varchar('asset_type', { length: 48 }),
    generatedDraft: text('generated_draft'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectStatusIdx: index('ai_visibility_recommendations_project_status_idx').on(
      table.projectId,
      table.status,
    ),
  }),
);

export const aiVisibilityGeneratedAssetLinksTable = pgTable(
  'ai_visibility_generated_asset_links',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    recommendationId: integer('recommendation_id').references(
      () => aiVisibilityRecommendationsTable.id,
      { onDelete: 'set null' },
    ),
    contentAssetId: integer('content_asset_id')
      .notNull()
      .references(() => contentAssetsTable.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    assetUq: uniqueIndex('ai_visibility_generated_asset_links_asset_uq').on(table.contentAssetId),
  }),
);

export const aiVisibilityAssetVersionsTable = pgTable(
  'ai_visibility_asset_versions',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    generatedAssetLinkId: integer('generated_asset_link_id')
      .notNull()
      .references(() => aiVisibilityGeneratedAssetLinksTable.id, {
        onDelete: 'cascade',
      }),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    actorUserId: integer('actor_user_id').references(() => usersTable.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    versionUq: uniqueIndex('ai_visibility_asset_versions_link_version_uq').on(
      table.generatedAssetLinkId,
      table.version,
    ),
  }),
);

export const aiVisibilityAssetApprovalDecisionsTable = pgTable(
  'ai_visibility_asset_approval_decisions',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    workspaceId: integer('workspace_id')
      .notNull()
      .references(() => aiVisibilityWorkspacesTable.id, {
        onDelete: 'cascade',
      }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    generatedAssetLinkId: integer('generated_asset_link_id')
      .notNull()
      .references(() => aiVisibilityGeneratedAssetLinksTable.id, {
        onDelete: 'cascade',
      }),
    contentAssetId: integer('content_asset_id')
      .notNull()
      .references(() => contentAssetsTable.id, { onDelete: 'cascade' }),
    assetVersion: integer('asset_version').notNull(),
    actorUserId: integer('actor_user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'restrict' }),
    decision: varchar('decision', { length: 16 }).$type<'approved' | 'rejected'>().notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index('ai_visibility_asset_approval_decisions_project_idx').on(
      table.projectId,
      table.createdAt,
    ),
    assetVersionUq: uniqueIndex('ai_visibility_asset_approval_decisions_asset_version_uq').on(
      table.contentAssetId,
      table.assetVersion,
    ),
  }),
);

export interface CmsDraftSnapshot {
  platform: CmsPlatform;
  title: string;
  body: string;
  handle: string;
  assetVersion: number;
  approvedBy: number;
  approvedAt: string;
  destination: Record<string, string>;
}

export const aiVisibilityCmsPublishAttemptsTable = pgTable(
  'ai_visibility_cms_publish_attempts',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    generatedAssetLinkId: integer('generated_asset_link_id')
      .notNull()
      .references(() => aiVisibilityGeneratedAssetLinksTable.id, {
        onDelete: 'cascade',
      }),
    contentAssetId: integer('content_asset_id')
      .notNull()
      .references(() => contentAssetsTable.id, { onDelete: 'cascade' }),
    credentialId: integer('credential_id').references(() => apiCredentialsTable.id, {
      onDelete: 'set null',
    }),
    platform: varchar('platform', { length: 24 }).$type<CmsPlatform>().notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 80 }).notNull(),
    assetVersion: integer('asset_version').notNull(),
    payloadFingerprint: varchar('payload_fingerprint', {
      length: 64,
    }).notNull(),
    reviewedPayload: jsonb('reviewed_payload').$type<CmsDraftSnapshot>().notNull(),
    status: varchar('status', { length: 32 })
      .$type<CmsPublishAttemptStatus>()
      .default('pending')
      .notNull(),
    destinationId: text('destination_id'),
    destinationUrl: text('destination_url'),
    attemptCount: integer('attempt_count').default(0).notNull(),
    reconciliationCount: integer('reconciliation_count').default(0).notNull(),
    errorCode: varchar('error_code', { length: 100 }),
    errorMessage: text('error_message'),
    lastReconciledAt: timestamp('last_reconciled_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIntentUq: uniqueIndex('ai_visibility_cms_publish_attempts_user_intent_uq').on(table.businessProfileId,
      table.userId,
      table.idempotencyKey,
    ),
    projectIdx: index('ai_visibility_cms_publish_attempts_project_idx').on(
      table.projectId,
      table.createdAt,
    ),
    assetIdx: index('ai_visibility_cms_publish_attempts_asset_idx').on(
      table.userId,
      table.contentAssetId,
      table.createdAt,
    ),
  }),
);

export const aiVisibilityGscConnectionsTable = pgTable(
  'ai_visibility_gsc_connections',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    credentialId: integer('credential_id').references(() => apiCredentialsTable.id, {
      onDelete: 'set null',
    }),
    selectedProperty: text('selected_property'),
    permissionLevel: varchar('permission_level', { length: 32 }),
    availableProperties: jsonb('available_properties')
      .$type<GscPropertyAccess[]>()
      .default([])
      .notNull(),
    status: varchar('status', { length: 24 }).default('connected').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastSyncError: text('last_sync_error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectUq: uniqueIndex('ai_visibility_gsc_connections_project_uq').on(table.projectId),
    userIdx: index('ai_visibility_gsc_connections_user_idx').on(table.userId, table.updatedAt),
  }),
);

export const aiVisibilityGscSnapshotsTable = pgTable(
  'ai_visibility_gsc_snapshots',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    connectionId: integer('connection_id')
      .notNull()
      .references(() => aiVisibilityGscConnectionsTable.id, {
        onDelete: 'cascade',
      }),
    propertyUri: text('property_uri').notNull(),
    startDate: date('start_date', { mode: 'string' }).notNull(),
    endDate: date('end_date', { mode: 'string' }).notNull(),
    rowCount: integer('row_count').notNull(),
    inputFingerprint: varchar('input_fingerprint', { length: 64 }).notNull(),
    responseAggregationType: varchar('response_aggregation_type', {
      length: 32,
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index('ai_visibility_gsc_snapshots_project_idx').on(
      table.projectId,
      table.createdAt,
    ),
  }),
);

export const aiVisibilityGscQueryPagesTable = pgTable(
  'ai_visibility_gsc_query_pages',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    snapshotId: integer('snapshot_id')
      .notNull()
      .references(() => aiVisibilityGscSnapshotsTable.id, {
        onDelete: 'cascade',
      }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    page: text('page').notNull(),
    clicks: numeric('clicks', { precision: 14, scale: 4 }).notNull(),
    impressions: numeric('impressions', { precision: 14, scale: 4 }).notNull(),
    ctr: numeric('ctr', { precision: 10, scale: 8 }).notNull(),
    position: numeric('position', { precision: 10, scale: 4 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    snapshotIdx: index('ai_visibility_gsc_query_pages_snapshot_idx').on(table.snapshotId),
    projectIdx: index('ai_visibility_gsc_query_pages_project_idx').on(
      table.projectId,
      table.impressions,
    ),
  }),
);

export const aiVisibilityReportsTable = pgTable(
  'ai_visibility_reports',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    status: varchar('status', { length: 24 }).default('pending').notNull(),
    storageKey: text('storage_key'),
    storageFileId: integer('storage_file_id'),
    mimeType: varchar('mime_type', { length: 100 }).default('application/pdf').notNull(),
    sizeBytes: integer('size_bytes'),
    brandingSnapshot: jsonb('branding_snapshot')
      .$type<
        Partial<{
          toolkitId: number | null;
          displayName: string;
          tagline: string | null;
          primaryColor: string;
          accentColor: string;
        }>
      >()
      .default({})
      .notNull(),
    methodology: jsonb('methodology').$type<Record<string, unknown>>().default({}).notNull(),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => ({
    auditUq: uniqueIndex('ai_visibility_reports_audit_uq').on(table.auditId),
  }),
);

export const aiVisibilityReportSharesTable = pgTable(
  'ai_visibility_report_shares',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    reportId: integer('report_id')
      .notNull()
      .references(() => aiVisibilityReportsTable.id, { onDelete: 'cascade' }),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    tokenHash: varchar('token_hash', { length: 64 }).notNull(),
    tokenPrefix: varchar('token_prefix', { length: 12 }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    lastAccessedAt: timestamp('last_accessed_at', { withTimezone: true }),
    accessCount: integer('access_count').default(0).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    tokenUq: uniqueIndex('ai_visibility_report_shares_token_uq').on(table.tokenHash),
    projectIdx: index('ai_visibility_report_shares_project_idx').on(
      table.projectId,
      table.createdAt,
    ),
    expiryIdx: index('ai_visibility_report_shares_expiry_idx').on(table.expiresAt),
  }),
);

export const aiVisibilityReportDeliveriesTable = pgTable(
  'ai_visibility_report_deliveries',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    reportId: integer('report_id')
      .notNull()
      .references(() => aiVisibilityReportsTable.id, { onDelete: 'cascade' }),
    auditId: integer('audit_id')
      .notNull()
      .references(() => aiVisibilityAuditsTable.id, { onDelete: 'cascade' }),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    recipientEmail: varchar('recipient_email', { length: 320 }).notNull(),
    status: varchar('status', { length: 24 }).default('sending').notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 80 }).notNull(),
    providerMessageId: text('provider_message_id'),
    attempts: integer('attempts').default(1).notNull(),
    error: text('error'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    userIntentUq: uniqueIndex('ai_visibility_report_deliveries_user_intent_uq').on(table.businessProfileId,
      table.userId,
      table.idempotencyKey,
    ),
    projectIdx: index('ai_visibility_report_deliveries_project_idx').on(
      table.projectId,
      table.createdAt,
    ),
  }),
);

export const aiVisibilityAlertsTable = pgTable(
  'ai_visibility_alerts',
  {
  businessProfileId: businessProfileColumn(),
    id: serial('id').primaryKey(),
    projectId: integer('project_id')
      .notNull()
      .references(() => aiVisibilityProjectsTable.id, { onDelete: 'cascade' }),
    auditId: integer('audit_id').references(() => aiVisibilityAuditsTable.id, {
      onDelete: 'cascade',
    }),
    userId: integer('user_id')
      .notNull()
      .references(() => usersTable.id, { onDelete: 'cascade' }),
    type: varchar('type', { length: 48 }).notNull(),
    severity: varchar('severity', { length: 16 }).notNull(),
    title: varchar('title', { length: 255 }).notNull(),
    message: text('message').notNull(),
    evidence: jsonb('evidence').$type<Record<string, unknown>>().default({}).notNull(),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => ({
    projectIdx: index('ai_visibility_alerts_project_idx').on(table.projectId, table.createdAt),
    auditTypeUq: uniqueIndex('ai_visibility_alerts_audit_type_uq')
      .on(table.auditId, table.type)
      .where(sql`${table.auditId} IS NOT NULL`),
  }),
);

export type AiVisibilityProjectRecord = typeof aiVisibilityProjectsTable.$inferSelect;
export type AiVisibilityAuditRecord = typeof aiVisibilityAuditsTable.$inferSelect;
export type AiVisibilityCrawledPageRecord = typeof aiVisibilityCrawledPagesTable.$inferSelect;
export type AiVisibilityPromptRunRecord = typeof aiVisibilityPromptRunsTable.$inferSelect;
