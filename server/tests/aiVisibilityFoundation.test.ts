import { describe, expect, it } from '@jest/globals';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AI_VISIBILITY_STAGE_KEYS } from '../models/aiVisibility/schema.js';

// Source contracts ignore formatter-only whitespace, quote style and trailing commas.
const compactSource = (value: string) => value.replace(/\s+/g, '').replace(/["']/g, '').replace(/,([)\]}])/g, '$1');
const projectRoot = resolve(process.cwd(), '..');
const read = (relativePath: string) => relativePath === 'client/src/components/ai-visibility/AiVisibilityWorkspace.tsx' ? readdirSync(resolve(projectRoot, 'client/src/components/ai-visibility')).filter(name => name.endsWith('.tsx')).map(name => readFileSync(resolve(projectRoot, 'client/src/components/ai-visibility', name), 'utf8')).join('\n') : readFileSync(resolve(projectRoot, relativePath), 'utf8');

describe('AI Visibility foundation contracts', () => {
  it('keeps the durable audit stage order stable and complete', () => {
    expect(AI_VISIBILITY_STAGE_KEYS).toEqual([
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
    ]);
    expect(new Set(AI_VISIBILITY_STAGE_KEYS).size).toBe(AI_VISIBILITY_STAGE_KEYS.length);
  });

  it('creates all durable tables and pricing keys behind a disabled-by-default module flag', () => {
    const migration = read('server/migrations/166_create_ai_visibility.js');
    const tables = [
      'projects', 'competitors', 'audits', 'audit_stages', 'crawled_pages', 'seo_issues', 'prompts',
      'aeo_questions', 'prompt_runs', 'extraction_corrections', 'score_snapshots', 'competitor_snapshots',
      'commerce_snapshots', 'recommendations', 'generated_asset_links', 'reports', 'alerts',
    ];
    for (const table of tables) {
      expect(compactSource(migration)).toContain(compactSource(`CREATE TABLE IF NOT EXISTS ai_visibility_${table}`));
    }
    for (const pricingKey of [
      'ai_visibility_audit', 'ai_visibility_crawl_page', 'ai_visibility_provider_prompt',
      'ai_visibility_report', 'ai_visibility_monitoring',
    ]) {
      expect(compactSource(migration)).toContain(compactSource(`'${pricingKey}'`));
    }
    expect(migration).toMatch(/'ai_visibility'.*'AI Visibility'.*'disabled'/s);
  });

  it('mounts authenticated routes and registers retryable audit and monitoring workers', () => {
    const index = read('server/index.ts');
    const routes = read('server/routes/aiVisibility.routes.ts');
    const queues = read('server/queues/index.ts');
    const workers = read('server/workers/index.ts');

    expect(compactSource(index)).toContain(compactSource("app.use('/api/ai-visibility', aiVisibilityRoutes)"));
    expect(compactSource(routes)).toContain(compactSource("router.use(authenticateToken, requireModuleAccess('ai_visibility'))"));
    expect(compactSource(queues)).toContain(compactSource("AI_VISIBILITY_AUDIT: 'ai-visibility-audit'"));
    expect(compactSource(queues)).toContain(compactSource("AI_VISIBILITY_MONITORING: 'ai-visibility-monitoring'"));
    expect(queues).toMatch(/\[QUEUE_NAMES\.AI_VISIBILITY_AUDIT\]:\s*\{\s*attempts:\s*3/s);
    expect(compactSource(workers)).toContain(compactSource("name: 'ai-visibility-audit-worker'"));
    expect(compactSource(workers)).toContain(compactSource("name: 'ai-visibility-monitoring-worker'"));
  });

  it('ships owner-only soft removal with Business Profile and active-analysis safeguards', () => {
    const routes = read('server/routes/aiVisibility.routes.ts');
    const service = read('server/services/aiVisibility/AiVisibilityService.ts');
    const workspaces = read('server/services/aiVisibility/AiVisibilityWorkspaceService.ts');

    expect(compactSource(routes)).toContain(compactSource("router.delete('/projects/:projectId'"));
    expect(compactSource(routes)).toContain(compactSource("capability = 'delete_project'"));
    expect(compactSource(workspaces)).toContain(compactSource("owner: new Set(['read', 'edit', 'manage_members', 'manage_connections', 'bill_wallet', 'review_assets', 'delete_project'])"));
    expect(workspaces).not.toMatch(/editor: new Set\([^\n]*delete_project/);
    expect(compactSource(service)).toContain(compactSource("status: 'archived'"));
    expect(compactSource(service)).toContain(compactSource("project.source === 'business_profile'"));
    expect(compactSource(service)).toContain(compactSource("IN ('queued', 'running')"));
    expect(compactSource(service)).not.toContain(compactSource('delete(aiVisibilityProjectsTable)'));
  });

  it('ships every sidebar destination as a real Next.js route', () => {
    const routeFiles = [
      'page.tsx', 'seo/page.tsx', 'aeo/page.tsx', 'geo/page.tsx', 'commerce/page.tsx',
      'competitors/page.tsx', 'fixes/page.tsx', 'assets/page.tsx', 'reports/page.tsx',
      'audits/[auditId]/page.tsx',
    ];
    const base = 'client/src/app/dashboard/(main)/ai-visibility';
    for (const routeFile of routeFiles) {
      expect(existsSync(resolve(projectRoot, base, routeFile))).toBe(true);
    }
  });

  it('documents provider/API fidelity and forbids silent simulated substitution', () => {
    const orchestrator = read('server/services/aiVisibility/AuditOrchestrator.ts');
    const provider = read('server/services/aiVisibility/ProviderObservationService.ts');
    expect(compactSource(orchestrator)).toContain(compactSource('Only successful observations contribute to the score.'));
    expect(compactSource(orchestrator)).toContain(compactSource('Failed calls remain visible and are never replaced with synthetic values.'));
    expect(compactSource(provider)).toContain(compactSource("fidelity: 'live_api'"));
    expect(compactSource(provider)).not.toContain(compactSource("fidelity: 'simulated'"));
    expect(compactSource(provider)).toContain(compactSource("AI_VISIBILITY_OBSERVATION_PROVIDERS = ['openai', 'gemini', 'perplexity', 'claude']"));
    // Every engine, Perplexity included, is asked through OpenRouter; the retired direct
    // Perplexity integration and the direct OpenAI and Gemini APIs are not called.
    expect(provider).not.toMatch(/api\.perplexity\.ai|api\.openai\.com|generativelanguage\.googleapis\.com/);
    expect(compactSource(orchestrator)).toContain(compactSource('AI_VISIBILITY_OBSERVATION_PROVIDERS'));
  });

  it('retires the removed provider while preserving historical AI Visibility rows', () => {
    const migration = read('server/migrations/242_make_gemini_primary_and_retire_perplexity.js');
    const controller = read('server/controllers/adminIntegrationsNewController.ts');
    expect(compactSource(migration)).toContain(compactSource("platform = 'perplexity'"));
    expect(compactSource(migration)).toContain(compactSource("deactivation_reason = 'provider_removed'"));
    expect(compactSource(migration)).toContain(compactSource("ai_provider = 'google'"));
    expect(compactSource(migration)).toContain(compactSource('anthropic/claude-sonnet-4.6'));
    expect(migration).not.toMatch(/DELETE FROM ai_visibility_prompt_runs/i);
    expect(compactSource(controller)).toContain(compactSource("RETIRED_INTEGRATION_PLATFORMS = new Set(['perplexity'])"));
    expect(compactSource(controller)).toContain(compactSource("res.status(410).json({ error: 'This integration provider has been retired.' })"));
  });

  it('installs and configures a production Chromium executable for PDF reports', () => {
    for (const dockerfile of ['server/Dockerfile', 'server/Dockerfile.worker']) {
      const source = read(dockerfile);
      expect(source).toMatch(/(?:apk add --no-cache|apt-get install -y --no-install-recommends\s*\\)\s+chromium/);
      expect(compactSource(source)).toContain(compactSource('BROWSER_EXECUTABLE_PATH=/usr/bin/chromium'));
    }
    expect(compactSource(read('server/utils/browserAutomation.ts'))).toContain(compactSource('process.env.BROWSER_EXECUTABLE_PATH'));
  });

  it('uses native disclosure controls for sidebar sections so links remain expandable before hydration', () => {
    const dashboard = read('client/src/components/DashboardLayout.tsx');
    const workspaceSection = read('client/src/components/SidebarWorkspaceSection.tsx');
    expect(compactSource(dashboard)).toContain(compactSource('<SidebarWorkspaceSection key={section.section}'));
    expect(compactSource(dashboard)).toContain(compactSource('expanded={sectionOpen(section.section, sectionActive)}'));
    expect(compactSource(workspaceSection)).toContain(compactSource('<details'));
    expect(compactSource(workspaceSection)).toContain(compactSource('<summary'));
    expect(compactSource(workspaceSection)).toContain(compactSource('href={section.collapsedPath}'));
    expect(compactSource(dashboard)).not.toContain(compactSource('onClick={() => toggleSection(section.section)}'));
  });

  it('keeps Business Profiles authoritative and avoids duplicating sidebar navigation inside the workspace', () => {
    const service = read('server/services/aiVisibility/AiVisibilityService.ts');
    const workspace = read('client/src/components/ai-visibility/AiVisibilityWorkspace.tsx');
    const migration = read('server/migrations/186_harden_ai_visibility_profile_wallet_and_monitoring.js');
    expect(compactSource(service)).toContain(compactSource('async resolveProject'));
    expect(compactSource(service)).toContain(compactSource('async listBusinessProfiles'));
    expect(compactSource(workspace)).toContain(compactSource('aiVisibilityApi.resolveProject'));
    expect(compactSource(workspace)).not.toContain(compactSource('const NAV:'));
    expect(compactSource(workspace)).not.toContain(compactSource('Create your first AI Visibility project'));
    expect(compactSource(migration)).toContain(compactSource('ai_visibility_projects_active_profile_uq'));
    expect(compactSource(migration)).toContain(compactSource('ai_visibility_audits_monitoring_period_uq'));
  });

  it('returns generated draft content so assets can be reviewed inside AI Visibility', () => {
    const service = read('server/services/aiVisibility/AiVisibilityService.ts');
    const workspace = read('client/src/components/ai-visibility/AiVisibilityWorkspace.tsx');
    expect(compactSource(service)).toContain(compactSource('content: contentAssetsTable.content'));
    expect(compactSource(workspace)).toContain(compactSource('Exact asset review'));
    expect(compactSource(workspace)).toContain(compactSource('Save new version'));
  });

  it('reconciles report-retry warnings and keeps active fixes scoped to the latest measured audit', () => {
    const orchestrator = read('server/services/aiVisibility/AuditOrchestrator.ts');
    const service = read('server/services/aiVisibility/AiVisibilityService.ts');
    const migration = read('server/migrations/229_reconcile_ai_visibility_warning_counts.js');

    expect(compactSource(orchestrator)).toContain(compactSource('reconcileWarningSummary'));
    expect(compactSource(orchestrator)).toContain(compactSource("eq(aiVisibilityAuditStagesTable.status, 'warning')"));
    expect(compactSource(service)).toContain(compactSource('eq(aiVisibilityRecommendationsTable.auditId, measurementAudit.id)'));
    expect(compactSource(migration)).toContain(compactSource("COUNT(*) FILTER (WHERE status = 'warning')"));
    expect(compactSource(migration)).toContain(compactSource("audit.status IN ('completed', 'completed_with_warnings')"));
  });

  it('supports reusable website searches and direct idempotent wallet billing for new audits', () => {
    const service = read('server/services/aiVisibility/AiVisibilityService.ts');
    const creditService = read('server/services/CreditService.ts');
    const orchestrator = read('server/services/aiVisibility/AuditOrchestrator.ts');
    const migration = read('server/migrations/188_ai_visibility_website_search_and_direct_billing.js');
    const workspace = read('client/src/components/ai-visibility/AiVisibilityWorkspace.tsx');

    expect(compactSource(service)).toContain(compactSource('async resolveWebsiteSearch'));
    expect(compactSource(service)).toContain(compactSource("source: 'website_search'"));
    expect(compactSource(service)).toContain(compactSource('reservedCredits: \'0\''));
    expect(compactSource(service)).toContain(compactSource("billingMode: 'direct'"));
    expect(compactSource(creditService)).toContain(compactSource('async deductOnceForResource'));
    expect(compactSource(orchestrator)).toContain(compactSource("referenceType: 'ai_visibility_audit_usage'"));
    expect(compactSource(migration)).toContain(compactSource('wallet_transactions_ai_visibility_usage_uq'));
    expect(compactSource(migration)).toContain(compactSource('ai_visibility_projects_active_website_domain_uq'));
    expect(compactSource(workspace)).toContain(compactSource('Add website'));
    expect(compactSource(workspace)).toContain(compactSource('Add website & review estimate'));
    expect(compactSource(workspace)).toContain(compactSource('Analyze again'));
    expect(compactSource(workspace)).toContain(compactSource('aiVisibilityApi.resolveWebsiteSearch'));
    expect(compactSource(workspace)).toContain(compactSource('Review the cost estimate, then start its first analysis.'));
    expect(compactSource(workspace)).toContain(compactSource('websiteWorkspacePath(added.id)'));
    expect(compactSource(workspace)).not.toContain(compactSource('Run a production audit'));
    expect(compactSource(workspace)).not.toContain(compactSource('Refresh analysis'));
    expect(compactSource(workspace)).not.toContain(compactSource('Estimated maximum usage'));
    expect(compactSource(workspace)).not.toContain(compactSource('Weekly monitoring'));
    expect(compactSource(workspace)).not.toContain(compactSource("return 'N/A'"));
  });

  it('keeps Search Console owner-scoped, evidence-based, optional, and outside wallet billing', () => {
    const migration = read('server/migrations/196_add_ai_visibility_gsc.js');
    const service = read('server/services/aiVisibility/GoogleSearchConsoleService.ts');
    const routes = read('server/routes/aiVisibility.routes.ts');
    const workspace = read('client/src/components/ai-visibility/AiVisibilityWorkspace.tsx');
    expect(compactSource(migration)).toContain(compactSource('CREATE TABLE IF NOT EXISTS ai_visibility_gsc_connections'));
    expect(compactSource(migration)).toContain(compactSource('CREATE TABLE IF NOT EXISTS ai_visibility_gsc_snapshots'));
    expect(compactSource(migration)).toContain(compactSource('CREATE TABLE IF NOT EXISTS ai_visibility_gsc_query_pages'));
    expect(compactSource(service)).toContain(compactSource("eq(aiVisibilityProjectsTable.userId, userId)"));
    expect(compactSource(service)).toContain(compactSource("dimensions: ['query', 'page']"));
    expect(compactSource(service)).toContain(compactSource('calculateGscOpportunities'));
    expect(service).not.toMatch(/creditService|wallet/i);
    expect(compactSource(routes)).toContain(compactSource("router.get('/projects/:projectId/gsc'"));
    expect(compactSource(workspace)).toContain(compactSource('Connecting and syncing do not use wallet credits.'));
    expect(compactSource(workspace)).not.toContain(compactSource('GSC score'));
  });

  it('persists verified link and JSON-LD evidence in backward-compatible crawl snapshots', () => {
    const schema = read('server/models/aiVisibility/schema.ts');
    const migration = read('server/migrations/189_add_ai_visibility_link_and_schema_evidence.js');
    const orchestrator = read('server/services/aiVisibility/AuditOrchestrator.ts');

    expect(compactSource(schema)).toContain(compactSource("linkChecks: jsonb('link_checks')"));
    expect(compactSource(schema)).toContain(compactSource("jsonLdErrors: jsonb('json_ld_errors')"));
    expect(compactSource(migration)).toContain(compactSource('ADD COLUMN IF NOT EXISTS link_checks'));
    expect(compactSource(migration)).toContain(compactSource('ADD COLUMN IF NOT EXISTS json_ld_errors'));
    expect(compactSource(orchestrator)).toContain(compactSource('linkChecks: page.linkChecks'));
    expect(compactSource(orchestrator)).toContain(compactSource('jsonLdErrors: page.jsonLdErrors'));
  });

  it('persists schema-validated GEO extraction fidelity and prices only successful uncached extraction', () => {
    const schema = read('server/models/aiVisibility/schema.ts');
    const migration = read('server/migrations/190_add_structured_geo_extraction.js');
    const orchestrator = read('server/services/aiVisibility/AuditOrchestrator.ts');
    const extractor = read('server/services/aiVisibility/StructuredAnswerExtractionService.ts');

    expect(compactSource(schema)).toContain(compactSource("extractionStatus: varchar('extraction_status'"));
    expect(compactSource(schema)).toContain(compactSource("extractionError: text('extraction_error')"));
    expect(compactSource(migration)).toContain(compactSource("'ai_visibility_extraction'"));
    expect(compactSource(orchestrator)).toContain(compactSource("eq(aiVisibilityPromptRunsTable.extractionMethod, 'structured_llm_v1')"));
    expect(compactSource(orchestrator)).toContain(compactSource("inArray(aiVisibilityPromptRunsTable.extractionStatus, ['completed', 'corrected', 'cached'])"));
    expect(compactSource(extractor)).toContain(compactSource("type: 'json_schema'"));
    expect(compactSource(extractor)).toContain(compactSource("json_schema: { name: 'ai_visibility_extraction', strict: true, schema: extractionJsonSchema }"));
    expect(extractor).not.toMatch(/best\|leading\|recommended/);
  });

  it('keeps competitor suggestions evidence-based and audit alerts retry-safe', () => {
    const service = read('server/services/aiVisibility/CompetitorSuggestionService.ts');
    const routes = read('server/routes/aiVisibility.routes.ts');
    const workspace = read('client/src/components/ai-visibility/AiVisibilityWorkspace.tsx');
    const migration = read('server/migrations/191_harden_ai_visibility_alerts.js');

    expect(compactSource(service)).toContain(compactSource("'business_profile_reference'"));
    expect(compactSource(service)).toContain(compactSource("'provider_observation'"));
    expect(service).not.toMatch(/invent|generated competitor/i);
    expect(compactSource(routes)).toContain(compactSource('aiVisibilityService.suggestCompetitors'));
    // Each suggestion names where it came from (AI answers or the Business Profile).
    expect(compactSource(workspace)).toContain(
      compactSource('Businesses AI engines named or your Business Profile lists.'),
    );
    expect(compactSource(workspace)).toContain(compactSource('Recent visibility alerts'));
    expect(compactSource(migration)).toContain(compactSource('ai_visibility_alerts_audit_type_uq'));
  });

  it('grounds AEO coverage and draft assets in bounded verified crawl text', () => {
    const schema = read('server/models/aiVisibility/schema.ts');
    const migration = read('server/migrations/192_add_ai_visibility_aeo_evidence.js');
    const crawler = read('server/services/WebsiteCrawlerService.ts');
    const coverage = read('server/services/aiVisibility/AeoCoverageService.ts');
    const service = read('server/services/aiVisibility/AiVisibilityService.ts');

    expect(compactSource(schema)).toContain(compactSource("contentExcerpt: text('content_excerpt')"));
    expect(compactSource(migration)).toContain(compactSource('ADD COLUMN IF NOT EXISTS content_excerpt'));
    expect(compactSource(crawler)).toContain(compactSource('visibleText.slice(0, 12_000)'));
    expect(compactSource(coverage)).toContain(compactSource('No verified crawl passage answers this question.'));
    expect(compactSource(coverage)).toContain(compactSource("'@type': 'FAQPage'"));
    expect(compactSource(service)).toContain(compactSource('async generateAeoQuestionAsset'));
    expect(compactSource(service)).toContain(compactSource("approvalStatus: 'draft'"));
  });

  it('ships secure expiring report shares and spreadsheet-safe CSV exports', () => {
    const schema = read('server/models/aiVisibility/schema.ts');
    const migration = read('server/migrations/193_add_ai_visibility_report_distribution.js');
    const routes = read('server/routes/aiVisibility.routes.ts');
    const service = read('server/services/aiVisibility/AiVisibilityService.ts');
    const exporter = read('server/services/aiVisibility/ReportExportService.ts');

    expect(compactSource(schema)).toContain(compactSource("aiVisibilityReportSharesTable = pgTable('ai_visibility_report_shares'"));
    expect(compactSource(migration)).toContain(compactSource('token_hash VARCHAR(64) NOT NULL'));
    expect(migration).not.toMatch(/raw_token|token_value/i);
    expect(routes.indexOf("router.get('/shared-reports/:token'")).toBeLessThan(routes.indexOf("router.use(authenticateToken"));
    expect(compactSource(routes)).toContain(compactSource("router.get('/audits/:auditId/export.csv'"));
    expect(compactSource(service)).toContain(compactSource("randomBytes(32).toString('base64url')"));
    expect(compactSource(service)).toContain(compactSource("createHash('sha256').update(token).digest('hex')"));
    expect(compactSource(exporter)).toContain(compactSource('safeSpreadsheetText'));
  });

  it('ships approved Brand Toolkit report snapshots and durable email receipts', () => {
    const schema = read('server/models/aiVisibility/schema.ts');
    const migration = read('server/migrations/194_add_ai_visibility_branded_report_delivery.js');
    const orchestrator = read('server/services/aiVisibility/AuditOrchestrator.ts');
    const service = read('server/services/aiVisibility/AiVisibilityService.ts');

    expect(compactSource(schema)).toContain(compactSource("aiVisibilityReportDeliveriesTable = pgTable('ai_visibility_report_deliveries'"));
    expect(compactSource(migration)).toContain(compactSource('branding_snapshot JSONB NOT NULL'));
    expect(compactSource(migration)).toContain(compactSource('ai_visibility_report_deliveries_user_intent_uq'));
    expect(compactSource(orchestrator)).toContain(compactSource('resolveReportBranding'));
    expect(compactSource(service)).toContain(compactSource('sendEmailWithUserCredentials'));
    expect(compactSource(service)).toContain(compactSource('skipCreditDeduction: true'));
  });

  it('ships approval-gated idempotent WordPress and Shopify draft publishing', () => {
    const schema = read('server/models/aiVisibility/schema.ts');
    const migration = read('server/migrations/195_add_ai_visibility_cms_draft_publishing.js');
    const routes = read('server/routes/aiVisibility.routes.ts');
    const service = read('server/services/aiVisibility/CmsDraftPublishingService.ts');

    expect(compactSource(schema)).toContain(compactSource("aiVisibilityCmsPublishAttemptsTable = pgTable('ai_visibility_cms_publish_attempts'"));
    expect(compactSource(migration)).toContain(compactSource('ai_visibility_cms_publish_attempts_user_intent_uq'));
    expect(compactSource(routes)).toContain(compactSource("router.post('/projects/:projectId/assets/:generatedAssetLinkId/cms-drafts'"));
    expect(compactSource(service)).toContain(compactSource('aiVisibilityAssetApprovalDecisionsTable'));
    expect(compactSource(service)).toContain(compactSource('requireExactAiVisibilityAssetApproval'));
    expect(compactSource(service)).toContain(compactSource("status: 'draft'"));
    expect(compactSource(service)).toContain(compactSource('isPublished: false'));
    expect(compactSource(service)).toContain(compactSource('onConflictDoNothing'));
    expect(compactSource(service)).toContain(compactSource('payloadFingerprint !== payloadFingerprint'));
    expect(compactSource(service)).toContain(compactSource('fetchPublicHttpUrl'));
    expect(compactSource(service)).not.toContain(compactSource('skipCreditDeduction'));
  });
});
