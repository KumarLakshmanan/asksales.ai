import { oauthBrowserCallback, oauthBrowserFlow } from '../services/OAuthBrowserFlowService.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { reportBusinessScope } from '../middleware/publicBusinessScope.js';
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { authenticateToken } from '../middleware/auth.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import { QUEUE_NAMES, queueRegistry, type AiVisibilityAuditJobPayload } from '../queues/index.js';
import { creditService } from '../services/CreditService.js';
import {
  AiVisibilityDeliveryError,
  AiVisibilityConflictError,
  AiVisibilityNotFoundError,
  AiVisibilityValidationError,
  aiVisibilityService,
  type ProjectInput,
  type WebsiteSearchInput,
} from '../services/aiVisibility/AiVisibilityService.js';
import { logger } from '../utils/logger.js';
import { importBlogForCmsReview } from '../services/aiVisibility/ContentLibraryCmsReviewService.js';
import { storageService } from '../services/StorageService.js';
import {
  CmsPublishingError,
  cmsDraftPublishingService,
  type CmsConnectionInput,
} from '../services/aiVisibility/CmsDraftPublishingService.js';
import {
  GscIntegrationError,
  verifyGscOAuthState,
  googleSearchConsoleService,
} from '../services/aiVisibility/GoogleSearchConsoleService.js';
import { ShopifyCatalogError } from '../services/aiVisibility/ShopifyCatalogService.js';
import { lookupCompetitorWebsite } from '../services/aiVisibility/CompetitorWebsiteLookupService.js';
import {
  AiVisibilityWorkspaceAccessError,
  aiVisibilityWorkspaceService,
  type AiVisibilityProjectAccess,
  type AiVisibilityWorkspaceCapability,
} from '../services/aiVisibility/AiVisibilityWorkspaceService.js';

const router = Router();
const feedUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024, files: 1 },
});

const projectSchema = z.object({
  name: z.string().trim().min(1).max(255),
  domain: z.string().trim().min(3).max(2048),
  brandAliases: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
  category: z.string().trim().max(255).nullable().optional(),
  scoringProfile: z.enum(['b2b_saas', 'ecommerce', 'local_business', 'general']).optional(),
  country: z.string().trim().length(2).optional(),
  locale: z.string().trim().min(2).max(16).optional(),
  targetGeography: z.string().trim().max(255).nullable().optional(),
  businessProfileId: z.number().int().positive().nullable().optional(),
  brandToolkitId: z.number().int().positive().nullable().optional(),
  geoPrompts: z
    .array(
      z.object({
        id: z.string().uuid(),
        prompt: z.string().trim().min(10).max(1000),
        intent: z.string().trim().min(1).max(48),
        isGeneric: z.boolean(),
        active: z.boolean(),
      }),
    )
    .max(30)
    .optional(),
});
const competitorSchema = z.object({
  name: z.string().trim().min(1).max(255),
  domain: z.string().trim().min(3).max(2048),
  aliases: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
});
const websiteSearchSchema = z.object({
  website: z.string().trim().min(3).max(2048),
  name: z.string().trim().min(1).max(255).optional(),
  brandAliases: z.array(z.string().trim().min(1).max(255)).max(20).optional(),
  category: z.string().trim().max(255).nullable().optional(),
  scoringProfile: z.enum(['b2b_saas', 'ecommerce', 'local_business', 'general']).optional(),
  country: z.string().trim().length(2).optional(),
  locale: z.string().trim().min(2).max(16).optional(),
  targetGeography: z.string().trim().max(255).nullable().optional(),
});
const extractionCorrectionSchema = z
  .object({
    brandMentioned: z.boolean().optional(),
    brandRank: z.number().int().positive().nullable().optional(),
    sentiment: z.enum(['positive', 'neutral', 'negative']).nullable().optional(),
    competitors: z.array(z.string().trim().min(1).max(255)).max(50).optional(),
    recommendationReason: z.string().trim().max(4000).nullable().optional(),
    exclusionReason: z.string().trim().max(4000).nullable().optional(),
  })
  .refine(
    (value) => Object.values(value).some((item) => item !== undefined),
    'Correction cannot be empty.',
  );
const reportDeliverySchema = z.object({
  recipientEmail: z.string().trim().email().max(320),
  idempotencyKey: z.string().trim().uuid(),
});
const cmsPlatformSchema = z.enum(['wordpress', 'shopify']);
const cmsConnectionSchema = z.discriminatedUnion('platform', [
  z.object({
    platform: z.literal('wordpress'),
    siteUrl: z.string().trim().min(3).max(2048),
    username: z.string().trim().min(1).max(255),
    applicationPassword: z.string().min(1).max(1024),
  }),
  z.object({
    platform: z.literal('shopify'),
    storeDomain: z.string().trim().min(3).max(255),
    accessToken: z.string().min(1).max(1024),
    blogId: z.string().trim().min(1).max(255).optional(),
    authorName: z.string().trim().min(1).max(255).optional(),
  }),
]);
const projectId = (req: Request) => z.coerce.number().int().positive().parse(req.params.projectId);
const auditId = (req: Request) => z.coerce.number().int().positive().parse(req.params.auditId);
const requestedAudit = (req: Request) =>
  req.query.auditId === undefined
    ? undefined
    : z.coerce.number().int().positive().parse(req.query.auditId);
const requestAccess = new WeakMap<Request, AiVisibilityProjectAccess>();
const actorUserId = (req: Request) => {
  if (!req.user?.id) throw new AiVisibilityValidationError('Authentication required.');
  return req.user.id;
};
// Existing AI Visibility services keep durable child rows under the website
// owner's user_id. Shared members are authorized as actors here, then service
// calls use the tenant owner without rewriting historical ownership.
const userId = (req: Request) => requestAccess.get(req)?.ownerUserId || businessOwnerUserId(req);

function handleError(res: Response, error: unknown) {
  const capacityError = normalizeCapacityError(error);
  if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
  if (error instanceof z.ZodError)
    return res.status(400).json({ error: 'Invalid request.', details: error.flatten() });
  if (error instanceof AiVisibilityValidationError)
    return res.status(400).json({ error: error.message });
  if (error instanceof AiVisibilityConflictError)
    return res.status(409).json({ error: error.message });
  if (error instanceof AiVisibilityDeliveryError)
    return res.status(502).json({ error: error.message });
  if (error instanceof AiVisibilityNotFoundError)
    return res.status(404).json({ error: error.message });
  if (error instanceof CmsPublishingError)
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  if (error instanceof GscIntegrationError)
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  if (error instanceof ShopifyCatalogError)
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  if (error instanceof AiVisibilityWorkspaceAccessError)
    return res.status(error.statusCode).json({ error: error.message, code: error.code });
  if ((error as { code?: string })?.code === '23505')
    return res.status(409).json({ error: 'That record already exists.' });
  logger.error({ err: error }, 'AI Visibility route failed');
  return res.status(500).json({ error: 'AI Visibility request failed.' });
}

// The random bearer token is the authorization boundary for a deliberately
// shared report. This route must remain before authenticated module routes.
router.get('/shared-reports/:token', reportBusinessScope, async (req, res) => {
  try {
    const parsed = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .safeParse(req.params.token);
    if (!parsed.success)
      return res.status(404).json({ error: 'Shared report not found or no longer available.' });
    const token = parsed.data;
    const report = await aiVisibilityService.getSharedReport(token);
    const download = await storageService.downloadFile(report.storageFileId!, report.userId);
    if (!download)
      return res.status(404).json({ error: 'Shared report not found or no longer available.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="ai-visibility-audit-${report.auditId}.pdf"`,
    );
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res.send(download.buffer);
  } catch (error) {
    return handleError(res, error);
  }
});

// Google redirects here without the application JWT. The signed, expiring
// OAuth state binds the callback to both the user and their owned project.
router.get('/gsc/oauth/callback', oauthBrowserCallback('google_search_console', (res, code) => res.redirect(googleSearchConsoleService.callbackErrorRedirect(new GscIntegrationError('Google sign-in could not be validated.',400,code)))), async (req, res) => {
  const state = typeof req.query.state === 'string' ? verifyGscOAuthState(req.query.state) : null;
  try {
    const error = z.string().optional().parse(req.query.error);
    if (error)
      throw new GscIntegrationError(
        z.string().optional().parse(req.query.error_description) || error,
        400,
        'GOOGLE_OAUTH_REJECTED',
      );
    const code = z.string().min(1).parse(req.query.code);
    const state = z.string().min(1).parse(req.query.state);
    const result = await googleSearchConsoleService.completeOAuth(code, state, oauthBrowserFlow(req));
    return res.redirect(googleSearchConsoleService.callbackRedirect(result));
  } catch (error) {
    logger.warn({ err: error }, 'Search Console OAuth callback failed');
    return res.redirect(googleSearchConsoleService.callbackErrorRedirect(error, state?.projectId));
  }
});

router.use(authenticateToken, requireModuleAccess('ai_visibility'));

router.get('/projects', async (req, res) => {
  try {
    res.json({
      projects: await aiVisibilityWorkspaceService.listAccessibleProjects(actorUserId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

const whiteLabelSchema = z
  .object({
    displayName: z.string().trim().max(255).optional(),
    tagline: z.string().trim().max(500).optional(),
    primaryColor: z
      .union([
        z
          .string()
          .trim()
          .regex(/^#[0-9a-f]{6}$/i),
        z.literal(''),
      ])
      .optional(),
    accentColor: z
      .union([
        z
          .string()
          .trim()
          .regex(/^#[0-9a-f]{6}$/i),
        z.literal(''),
      ])
      .optional(),
  })
  .optional();

router.get('/workspaces', async (req, res) => {
  try {
    res.json({
      workspaces: await aiVisibilityWorkspaceService.listWorkspaces(actorUserId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.all(['/organizations','/organizations/:organizationId','/workspaces/:workspaceId/members','/workspaces/:workspaceId/members/:membershipId'], (_req,res) =>
  res.status(410).json({code:'BUSINESS_PROFILE_IS_WORKSPACE',error:'Manage workspace identity and staff in Business profile settings.'}));

router.patch('/workspaces/:workspaceId', async (req, res) => {
  try {
    const workspaceId = z.coerce.number().int().positive().parse(req.params.workspaceId);
    const input = z
      .object({
        name: z.string().trim().min(1).max(255).optional(),
        organizationId: z.number().int().positive().nullable().optional(),
        kind: z.enum(['private', 'client']).optional(),
        whiteLabelDefaults: whiteLabelSchema,
      })
      .parse(req.body);
    res.json({
      workspace: await aiVisibilityWorkspaceService.updateWorkspace(
        actorUserId(req),
        workspaceId,
        input,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/website-searches', async (req, res) => {
  try {
    res.json({
      websites: await aiVisibilityService.listWebsiteSearches(userId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/website-searches', async (req, res) => {
  try {
    const input = websiteSearchSchema.parse(req.body);
    res
      .status(201)
      .json(
        await aiVisibilityService.resolveWebsiteSearch(userId(req), input as WebsiteSearchInput),
      );
  } catch (error) {
    // Drizzle wraps this existing database conflict. Preserve its rejection and
    // rollback while giving the website search caller the correct HTTP status.
    const cause = (error as { cause?: { code?: string; constraint?: string } })?.cause;
    if (cause?.code === '23505' && cause.constraint === 'ai_visibility_projects_active_profile_uq') {
      return res.status(409).json({
        error: 'This website search conflicts with an existing active workspace.',
      });
    }
    handleError(res, error);
  }
});

router.post('/projects/resolve', async (req, res) => {
  try {
    const input = z
      .object({
        businessProfileId: z.number().int().positive().nullable().optional(),
      })
      .parse(req.body || {});
    res.json(await aiVisibilityService.resolveProject(userId(req), input.businessProfileId));
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/business-profiles', async (req, res) => {
  try {
    res.json({
      profiles: await aiVisibilityService.listBusinessProfiles(userId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects', async (req, res) => {
  try {
    res.status(201).json({
      project: await aiVisibilityService.createProject(
        userId(req),
        projectSchema.parse(req.body) as ProjectInput,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.use('/projects/:projectId', async (req, res, next) => {
  try {
    const access = await aiVisibilityWorkspaceService.projectAccess(
      actorUserId(req),
      projectId(req),
    );
    requestAccess.set(req, access);
    let capability: AiVisibilityWorkspaceCapability = req.method === 'GET' ? 'read' : 'edit';
    if (req.method === 'POST' && req.path === '/suggest-competitors') capability = 'read';
    if (
      req.method !== 'GET' &&
      (/\/gsc(\/|$)/.test(req.path) ||
        /\/cms-(connections|drafts)(\/|$)/.test(req.path) ||
        /\/commerce\/shopify(\/|$)/.test(req.path))
    )
      capability = 'manage_connections';
    if (req.method !== 'GET' && /\/assets\/\d+\/approval$/.test(req.path))
      capability = 'review_assets';
    if (
      (req.method === 'POST' && /\/audits$/.test(req.path)) ||
      (req.method === 'POST' && req.path === '/competitor-website-lookup') ||
      (req.method === 'PATCH' && /\/monitoring$/.test(req.path))
    )
      capability = 'bill_wallet';
    if (req.method === 'DELETE' && req.path === '/') capability = 'delete_project';
    aiVisibilityWorkspaceService.requireCapability(access, capability);
    next();
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId', async (req, res) => {
  try {
    const project = await aiVisibilityService.getProject(userId(req), projectId(req));
    const access = requestAccess.get(req)!;
    res.json({
      project: {
        ...project,
        workspace: {
          workspaceName: access.workspaceName,
          workspaceKind: access.workspaceKind,
          organizationId: access.organizationId,
          role: access.role,
        },
      },
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/projects/:projectId', async (req, res) => {
  try {
    res.json({
      project: await aiVisibilityService.updateProject(
        userId(req),
        projectId(req),
        projectSchema.partial().parse(req.body),
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete('/projects/:projectId', async (req, res) => {
  try {
    res.json({
      project: await aiVisibilityService.archiveProject(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/competitors', async (req, res) => {
  try {
    res.json({
      competitors: await aiVisibilityService.listCompetitors(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/competitor-website-lookup', async (req, res) => {
  try {
    const { name } = z.object({ name: z.string().trim().min(2).max(160) }).parse(req.body);
    const project = await aiVisibilityService.getProject(userId(req), projectId(req));
    res.json(
      await lookupCompetitorWebsite(userId(req), {
        name,
        brandDomain: project.domain,
        category: project.category,
        geography: project.targetGeography,
        country: project.country,
      }),
    );
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/competitors', async (req, res) => {
  try {
    res.status(201).json({
      competitor: await aiVisibilityService.addCompetitor(
        userId(req),
        projectId(req),
        competitorSchema.parse(req.body) as {
          name: string;
          domain: string;
          aliases?: string[];
        },
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/projects/:projectId/competitors/:competitorId', async (req, res) => {
  try {
    const competitorId = z.coerce.number().int().positive().parse(req.params.competitorId);
    const input = competitorSchema
      .partial()
      .extend({ active: z.boolean().optional() })
      .parse(req.body);
    res.json({
      competitor: await aiVisibilityService.updateCompetitor(
        userId(req),
        projectId(req),
        competitorId,
        input,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/suggest-competitors', async (req, res) => {
  try {
    res.json(await aiVisibilityService.suggestCompetitors(userId(req), projectId(req)));
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/competitor-intelligence', async (req, res) => {
  try {
    res.json(
      await aiVisibilityService.competitorIntelligence(
        userId(req),
        projectId(req),
        requestedAudit(req),
      ),
    );
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/competitor-intelligence/briefs', async (req, res) => {
  try {
    const { competitorId, gapKey } = z
      .object({
        competitorId: z.number().int().positive(),
        gapKey: z.string().trim().min(3).max(128),
      })
      .parse(req.body);
    res.status(201).json({
      asset: await aiVisibilityService.generateCompetitorGapBrief(
        userId(req),
        projectId(req),
        competitorId,
        gapKey,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/providers', async (req, res) => {
  try {
    res.json(await aiVisibilityService.providerStatus(userId(req), projectId(req)));
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/audits/estimate', async (req, res) => {
  try {
    res.json({
      estimate: await aiVisibilityService.estimateAudit(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/audits', async (req, res) => {
  let charge: Awaited<ReturnType<typeof aiVisibilityService.createAudit>> | undefined;
  try {
    const uid = userId(req);
    charge = await aiVisibilityService.createAudit(uid, projectId(req));
    if (!charge.success || !charge.resource) {
      const error = 'error' in charge ? charge.error : undefined;
      return res
        .status(error?.includes('Insufficient') ? 402 : 500)
        .json({ error, balance: charge.balanceAfter });
    }
    const audit = charge.resource;
    await queueRegistry.addJob<AiVisibilityAuditJobPayload>(
      QUEUE_NAMES.AI_VISIBILITY_AUDIT,
      'run-audit',
      {
        userId: uid,
        projectId: audit.projectId,
        auditId: audit.id,
        createdAt: new Date().toISOString(),
      },
      { jobId: `ai-visibility-audit-${audit.id}` },
    );
    return res.status(202).json({
      audit,
      creditsCharged: charge.creditsDeducted,
      balanceAfter: charge.balanceAfter,
    });
  } catch (error) {
    if (charge?.success && 'transactionId' in charge && charge.transactionId && charge.resource) {
      await creditService.refundDeduction({
        userId: userId(req),
        transactionId: charge.transactionId,
        description: `Refund for audit ${charge.resource.id}: queue dispatch failed`,
      });
    }
    if (charge?.resource) {
      await aiVisibilityService.markAuditDispatchFailed(
        userId(req),
        charge.resource.id,
        'Audit queue dispatch failed. The base wallet charge was returned.',
      );
    }
    return handleError(res, error);
  }
});

router.get('/projects/:projectId/audits', async (req, res) => {
  try {
    res.json({
      audits: await aiVisibilityService.listAudits(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.use('/audits/:auditId', async (req, res, next) => {
  try {
    const access = await aiVisibilityWorkspaceService.auditAccess(actorUserId(req), auditId(req));
    requestAccess.set(req, access);
    aiVisibilityWorkspaceService.requireCapability(access, req.method === 'GET' ? 'read' : 'edit');
    next();
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/audits/:auditId', async (req, res) => {
  try {
    res.json({
      audit: await aiVisibilityService.getAudit(userId(req), auditId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/audits/:auditId/cancel', async (req, res) => {
  try {
    res.json({
      audit: await aiVisibilityService.cancelAudit(userId(req), auditId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/audits/:auditId/report/retry', async (req, res) => {
  try {
    const uid = userId(req);
    const audit = await aiVisibilityService.getAudit(uid, auditId(req));
    if (!['completed', 'completed_with_warnings'].includes(audit.status))
      return res.status(409).json({
        error: 'A report can be retried only after an audit has completed.',
      });
    await queueRegistry.addJob(
      QUEUE_NAMES.AI_VISIBILITY_AUDIT,
      'retry-audit-report',
      {
        userId: uid,
        projectId: audit.projectId,
        auditId: audit.id,
        retryReport: true,
        createdAt: new Date().toISOString(),
        // A failed BullMQ job remains addressable by its job ID. Give each explicit
        // retry a new queue ID; report generation is still idempotent at the audit
        // record (one report per audit) and never creates a second credit charge.
      },
      { jobId: `ai-visibility-audit-report-${audit.id}-${Date.now()}` },
    );
    return res.status(202).json({ auditId: audit.id, status: 'queued' });
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/projects/:projectId/overview', async (req, res) => {
  try {
    res.json(await aiVisibilityService.overview(userId(req), projectId(req), requestedAudit(req)));
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/seo', async (req, res) => {
  try {
    res.json(await aiVisibilityService.seo(userId(req), projectId(req), requestedAudit(req)));
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/gsc', async (req, res) => {
  try {
    res.json(
      await googleSearchConsoleService.overview(
        userId(req),
        projectId(req),
        req.query.snapshotId
          ? z.coerce.number().int().positive().parse(req.query.snapshotId)
          : undefined,
      ),
    );
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/gsc/auth-url', async (req, res) => {
  try {
    res.json(await googleSearchConsoleService.authorizationUrl(userId(req), projectId(req), req, res));
  } catch (error) {
    handleError(res, error);
  }
});

router.put('/projects/:projectId/gsc/property', async (req, res) => {
  try {
    const { propertyUri } = z
      .object({ propertyUri: z.string().trim().min(3).max(2048) })
      .parse(req.body);
    res.json({
      connection: await googleSearchConsoleService.selectProperty(
        userId(req),
        projectId(req),
        propertyUri,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/gsc/sync', async (req, res) => {
  try {
    res.status(201).json(
      await googleSearchConsoleService.sync(
        userId(req),
        projectId(req),
        req.body.startDate
          ? z
              .object({
                startDate: z.string().date(),
                endDate: z.string().date(),
                compare: z.boolean().optional(),
              })
              .parse(req.body)
          : undefined,
      ),
    );
  } catch (error) {
    handleError(res, error);
  }
});

router.delete('/projects/:projectId/gsc', async (req, res) => {
  try {
    res.json(await googleSearchConsoleService.disconnect(userId(req), projectId(req)));
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/aeo', async (req, res) => {
  try {
    res.json(
      await aiVisibilityService.prompts(userId(req), projectId(req), 'aeo', requestedAudit(req)),
    );
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/aeo/questions', async (req, res) => {
  try {
    res.json({
      questions: await aiVisibilityService.listAeoQuestions(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/aeo/coverage', async (req, res) => {
  try {
    res.json(
      await aiVisibilityService.aeoCoverage(userId(req), projectId(req), requestedAudit(req)),
    );
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/aeo/questions', async (req, res) => {
  try {
    const input = z
      .object({
        question: z.string().trim().min(5).max(1000),
        intent: z.string().trim().min(1).max(48).optional(),
        targetPage: z.string().trim().max(2048).nullable().optional(),
      })
      .parse(req.body);
    res.status(201).json({
      question: await aiVisibilityService.createAeoQuestion(userId(req), projectId(req), input),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/projects/:projectId/aeo/questions/:questionId', async (req, res) => {
  try {
    const questionId = z.coerce.number().int().positive().parse(req.params.questionId);
    const input = z
      .object({
        question: z.string().trim().min(5).max(1000).optional(),
        intent: z.string().trim().min(1).max(48).optional(),
        targetPage: z.string().trim().max(2048).nullable().optional(),
        active: z.boolean().optional(),
      })
      .parse(req.body);
    res.json({
      question: await aiVisibilityService.updateAeoQuestion(
        userId(req),
        projectId(req),
        questionId,
        input,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/aeo/questions/:questionId/assets', async (req, res) => {
  try {
    const questionId = z.coerce.number().int().positive().parse(req.params.questionId);
    const { assetType } = z
      .object({
        assetType: z.enum(['answer_block', 'faq_page', 'research_brief']),
      })
      .parse(req.body);
    res.status(201).json({
      asset: await aiVisibilityService.generateAeoQuestionAsset(
        userId(req),
        projectId(req),
        questionId,
        assetType,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/geo', async (req, res) => {
  try {
    res.json(
      await aiVisibilityService.prompts(userId(req), projectId(req), 'geo', requestedAudit(req)),
    );
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/commerce', async (req, res) => {
  try {
    res.json(await aiVisibilityService.commerce(userId(req), projectId(req)));
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/commerce/products', async (req, res) => {
  try {
    const options = z
      .object({
        snapshotId: z.coerce.number().int().positive().optional(),
        query: z.string().max(200).optional(),
        issuesOnly: z
          .enum(['true', 'false'])
          .optional()
          .transform((value) => value === 'true'),
        offset: z.coerce.number().int().min(0).default(0),
        limit: z.coerce.number().int().min(1).max(100).default(25),
      })
      .parse(req.query);
    res.json(await aiVisibilityService.commerceProducts(userId(req), projectId(req), options));
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/commerce/feeds', feedUpload.single('file'), async (req, res) => {
  try {
    if (!req.file)
      return res.status(400).json({ error: 'A CSV, JSON, or XML feed file is required.' });
    let mapping: unknown = {};
    if (req.body.mapping) {
      try {
        mapping = JSON.parse(req.body.mapping);
      } catch {
        return res.status(400).json({ error: 'Column mapping must be valid JSON.' });
      }
    }
    return res.status(201).json({
      snapshot: await aiVisibilityService.ingestCommerceFeed(
        userId(req),
        projectId(req),
        req.file,
        z.record(z.string().max(100), z.string().max(100)).parse(mapping),
      ),
    });
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/projects/:projectId/commerce/shopify/sync', async (req, res) => {
  try {
    return res.status(201).json({
      snapshot: await aiVisibilityService.ingestShopifyCatalog(userId(req), projectId(req)),
    });
  } catch (error) {
    return handleError(res, error);
  }
});

router.post('/projects/:projectId/commerce/woocommerce/sync', async (req, res) => {
  try {
    return res.status(201).json({
      snapshot: await aiVisibilityService.ingestWooCommerceCatalog(userId(req), projectId(req)),
    });
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/projects/:projectId/recommendations', async (req, res) => {
  try {
    res.json({
      recommendations: await aiVisibilityService.recommendations(
        userId(req),
        projectId(req),
        requestedAudit(req),
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/projects/:projectId/recommendations/:recommendationId', async (req, res) => {
  try {
    const recommendationId = z.coerce.number().int().positive().parse(req.params.recommendationId);
    const input = z
      .object({
        status: z.enum(['open', 'in_progress', 'resolved', 'rejected']).optional(),
        assigneeUserId: z.number().int().positive().nullable().optional(),
        dueDate: z.string().date().nullable().optional(),
        resolutionEvidence: z.string().trim().max(8000).nullable().optional(),
      })
      .refine((value) => Object.keys(value).length > 0)
      .parse(req.body);
    res.json({
      recommendation: await aiVisibilityService.updateRecommendation(
        userId(req),
        projectId(req),
        recommendationId,
        input,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/recommendations/:recommendationId/assets', async (req, res) => {
  try {
    const recommendationId = z.coerce.number().int().positive().parse(req.params.recommendationId);
    res.status(201).json({
      asset: await aiVisibilityService.generateRecommendationAsset(
        userId(req),
        projectId(req),
        recommendationId,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.use('/prompt-runs/:promptRunId', async (req, res, next) => {
  try {
    const runId = z.coerce.number().int().positive().parse(req.params.promptRunId);
    const access = await aiVisibilityWorkspaceService.promptRunAccess(actorUserId(req), runId);
    requestAccess.set(req, access);
    aiVisibilityWorkspaceService.requireCapability(access, req.method === 'GET' ? 'read' : 'edit');
    next();
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/prompt-runs/:promptRunId/corrections', async (req, res) => {
  try {
    const runId = z.coerce.number().int().positive().parse(req.params.promptRunId);
    const correction = extractionCorrectionSchema.parse(req.body);
    res.json({
      correction: await aiVisibilityService.correctPromptRun(userId(req), runId, correction),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/reports', async (req, res) => {
  try {
    res.json({
      reports: await aiVisibilityService.reports(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/report-shares', async (req, res) => {
  try {
    res.json({
      shares: await aiVisibilityService.listReportShares(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/report-deliveries', async (req, res) => {
  try {
    res.json({
      deliveries: await aiVisibilityService.listReportDeliveries(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/audits/:auditId/report-deliveries', async (req, res) => {
  try {
    const input = reportDeliverySchema.parse(req.body);
    res.status(201).json({
      delivery: await aiVisibilityService.sendReportEmail(
        userId(req),
        auditId(req),
        input.recipientEmail,
        input.idempotencyKey,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/audits/:auditId/report-shares', async (req, res) => {
  try {
    const { expiresInDays } = z
      .object({
        expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30)]).default(7),
      })
      .parse(req.body || {});
    res
      .status(201)
      .json(await aiVisibilityService.createReportShare(userId(req), auditId(req), expiresInDays));
  } catch (error) {
    handleError(res, error);
  }
});

router.delete('/projects/:projectId/report-shares/:shareId', async (req, res) => {
  try {
    const shareId = z.coerce.number().int().positive().parse(req.params.shareId);
    res.json({
      share: await aiVisibilityService.revokeReportShare(userId(req), projectId(req), shareId),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/audits/:auditId/export.json', async (req, res) => {
  try {
    const id = auditId(req);
    const evidence = await aiVisibilityService.exportAuditEvidence(userId(req), id);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ai-visibility-audit-${id}-evidence.json"`,
    );
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    return res.json(evidence);
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/audits/:auditId/export.csv', async (req, res) => {
  try {
    const id = auditId(req);
    const csv = await aiVisibilityService.exportAuditCsv(userId(req), id);
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="ai-visibility-audit-${id}.csv"`);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    return res.send(csv);
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/audits/:auditId/report', async (req, res) => {
  try {
    const report = await aiVisibilityService.getReport(userId(req), auditId(req));
    if (report.status !== 'completed' || !report.storageFileId)
      return res.status(409).json({ error: 'Audit report is not ready.' });
    const download = await storageService.downloadFile(report.storageFileId, userId(req));
    if (!download) return res.status(404).json({ error: 'Report file not found.' });
    // A completed metadata row is not proof that the saved bytes are a PDF.
    // Reject obvious storage corruption before claiming a successful PDF read.
    // Full document rendering remains the browser/PDF reader's responsibility.
    if (!download.buffer.subarray(0, 5).equals(Buffer.from('%PDF-')))
      return res.status(502).json({ error: 'Saved report file is not a valid PDF.' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="ai-visibility-audit-${report.auditId}.pdf"`,
    );
    return res.send(download.buffer);
  } catch (error) {
    return handleError(res, error);
  }
});

router.get('/projects/:projectId/assignees', async (req, res) => {
  try {
    res.json({
      members: await aiVisibilityService.assignees(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/assets/:assetId/versions', async (req, res) => {
  try {
    res.json({
      versions: await aiVisibilityService.assetVersions(
        userId(req),
        projectId(req),
        z.coerce.number().int().positive().parse(req.params.assetId),
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/projects/:projectId/assets/:assetId', async (req, res) => {
  try {
    const input = z
      .object({
        version: z.number().int().positive(),
        title: z.string().trim().min(1).max(500),
        content: z.string().trim().min(1).max(200000),
      })
      .parse(req.body);
    res.json({
      asset: await aiVisibilityService.editAsset(
        userId(req),
        projectId(req),
        z.coerce.number().int().positive().parse(req.params.assetId),
        actorUserId(req),
        input,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/assets', async (req, res) => {
  try {
    res.json({
      assets: await aiVisibilityService.assets(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/assets/import-blog', async (req, res) => {
  try {
    const input = z.object({ contentAssetId: z.number().int().positive(), expectedVersion: z.number().int().positive() }).strict().parse(req.body);
    // Access middleware requires edit; import additionally requires owning both records.
    const imported = await importBlogForCmsReview(actorUserId(req), projectId(req), input.contentAssetId, input.expectedVersion);
    res.status(imported.existing ? 200 : 201).json(imported);
  } catch (error) { handleError(res, error); }
});

router.get('/projects/:projectId/asset-approvals', async (req, res) => {
  try {
    res.json({
      decisions: await aiVisibilityWorkspaceService.approvalHistory(
        actorUserId(req),
        projectId(req),
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/projects/:projectId/assets/:generatedAssetLinkId/approval', async (req, res) => {
  try {
    const generatedAssetLinkId = z.coerce
      .number()
      .int()
      .positive()
      .parse(req.params.generatedAssetLinkId);
    const input = z
      .object({
        decision: z.enum(['approved', 'rejected']),
        assetVersion: z.number().int().positive(),
        comment: z.string().trim().max(2000).nullable().optional(),
      })
      .parse(req.body);
    res.json(
      await aiVisibilityWorkspaceService.decideAsset(
        actorUserId(req),
        projectId(req),
        generatedAssetLinkId,
        input,
      ),
    );
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/cms-connections', async (req, res) => {
  try {
    res.json({
      connections: await cmsDraftPublishingService.connections(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.put('/projects/:projectId/cms-connections/:platform', async (req, res) => {
  try {
    const platform = cmsPlatformSchema.parse(req.params.platform);
    const input = cmsConnectionSchema.parse({
      ...req.body,
      platform,
    }) as CmsConnectionInput;
    res.json({
      connection: await cmsDraftPublishingService.saveConnection(
        userId(req),
        projectId(req),
        input,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.delete('/projects/:projectId/cms-connections/:platform', async (req, res) => {
  try {
    const platform = cmsPlatformSchema.parse(req.params.platform);
    res.json({
      connection: await cmsDraftPublishingService.deleteConnection(
        userId(req),
        projectId(req),
        platform,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/cms-publish-attempts', async (req, res) => {
  try {
    res.json({
      attempts: await cmsDraftPublishingService.attempts(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.post('/projects/:projectId/assets/:generatedAssetLinkId/cms-drafts', async (req, res) => {
  try {
    const generatedAssetLinkId = z.coerce
      .number()
      .int()
      .positive()
      .parse(req.params.generatedAssetLinkId);
    const input = z
      .object({
        platform: cmsPlatformSchema,
        idempotencyKey: z.string().uuid(),
        assetVersion: z.number().int().positive(),
        checkOutcomeOnly: z.boolean().optional(),
      })
      .parse(req.body);
    res.status(201).json({
      attempt: await cmsDraftPublishingService.createDraft(
        userId(req),
        projectId(req),
        generatedAssetLinkId,
        input.platform,
        input.idempotencyKey,
        input.assetVersion,
        input.checkOutcomeOnly,
      ),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/alerts', async (req, res) => {
  try {
    res.json({
      alerts: await aiVisibilityService.alerts(userId(req), projectId(req)),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/projects/:projectId/alerts/:alertId', async (req, res) => {
  try {
    const alertId = z.coerce.number().int().positive().parse(req.params.alertId);
    res.json({
      alert: await aiVisibilityService.acknowledgeAlert(userId(req), projectId(req), alertId),
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.get('/projects/:projectId/monitoring', async (req, res) => {
  try {
    const project = await aiVisibilityService.getProject(userId(req), projectId(req));
    res.json({
      enabled: project.monitoringEnabled,
      cadence: project.monitoringCadence,
      estimatedCredits: Number(project.monitoringEstimatedCredits),
      nextRunAt: project.nextMonitoringAt,
    });
  } catch (error) {
    handleError(res, error);
  }
});

router.patch('/projects/:projectId/monitoring', async (req, res) => {
  try {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    res.json({
      project: await aiVisibilityService.updateMonitoring(userId(req), projectId(req), enabled),
    });
  } catch (error) {
    handleError(res, error);
  }
});

export default router;
