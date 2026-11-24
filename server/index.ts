// Load environment variables FIRST before any other imports. Keep this the first
// import: modules such as billing/entitlements import models/db.js, which builds the
// database pool from process.env when it is evaluated.
import './env.js';
import { normalizeCapacityError } from './services/billing/entitlements.js';
import fs from 'fs';
import { localStoragePath } from './utils/localStoragePath.js';
// Phase 4.17 / TYPE-005: register Express Request augmentation (user, id)
import './globals.js';

// Import config validation AFTER dotenv is loaded
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { config as appConfig } from './utils/config.js';
import { logger as processLogger } from './utils/logger.js';

// Global handlers to prevent crashes from unhandled rejections (e.g. @google/generative-ai stream parse errors)
process.on('unhandledRejection', (reason: unknown) => {
  processLogger.error({ err: reason }, '[Process] Unhandled promise rejection (not crashing)');
});
process.on('uncaughtException', (err: Error) => {
  processLogger.error({ err }, '[Process] Uncaught exception — exiting');
  process.exit(1);
});

/**
 * Sales & Marketing Automation Server
 * Main entry point with WebSocket support
 * Architecture V2: Queue + Workers + Event Bus + Observability
 */

import express from 'express';
import cors from 'cors';
import { isWidgetInstallationRequest, widgetInstallationCors } from './middleware/widgetInstallationCors.js';
import helmet from 'helmet';
import compression from 'compression';
import { registerRoutes } from './routes.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { db, pgPool } from './models/db.js';
import { readinessHandler } from './infrastructure/readiness.js';
import { WorkflowExecutorService } from './services/WorkflowExecutorService.js';
import { cronService } from './services/cronService.js';
import { ensureUploadDirectories } from './utils/fileStorage.js';

// V2 Infrastructure imports
import { requestId, requestLogger } from './middleware/requestLogger.js';
import { databaseUnavailableResponses } from './tenancy/databaseAvailability.js';
import { requestStatementTimeout } from './tenancy/statementTimeout.js';
import { responseWrapper } from './middleware/responseWrapper.js';
import { maintenanceModeGate, requireModuleAccess } from './middleware/platformAccess.js';
import { authenticateToken } from './middleware/auth.js';

import { initializeRealtimeGateway } from './gateway/RealtimeGateway.js';
import { closeRedisConnections, isRedisAvailable } from './infrastructure/redis.js';
import { queueRegistry } from './queues/index.js';
import { eventBus } from './events/EventBus.js';
import { shutdownLangfuse } from './infrastructure/langfuse.js';
import { shutdownChatWebSocket } from './websocket/ChatWebSocketServer.js';
import { stopOrchestratorBackgroundJobs } from './mastra/orchestrator.js';

const app = express();
const PORT = process.env.PORT || 8080;

// Initialize WorkflowExecutorService and schema registry
await WorkflowExecutorService.initialize();

// Ensure upload directories exist (images, videos, documents, temp)
await ensureUploadDirectories();

// V2: Initialize Redis-based infrastructure (mandatory — throws if unavailable)
const redisAvailable = await isRedisAvailable();
if (!redisAvailable) {
  processLogger.fatal('Redis is not available. Ensure Redis is running and REDIS_HOST/REDIS_PORT are configured correctly. Exiting.');
  process.exit(1);
}
await queueRegistry.initialize();
await eventBus.initialize();
// NOTE: Workers are run in dedicated PM2 processes (salesmarketing-worker-1/2).
// The API server only dispatches jobs — it must NOT also consume them.

// Initialize Realtime Gateway (bridges EventBus → WebSocket)
await initializeRealtimeGateway();

// Security headers (before all other middleware)
app.use(helmet({
  // This is a pure JSON API server (not an HTML page server).
  // Apply a restrictive CSP: no scripts, frames, or embeds allowed.
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'none'"],       // Deny everything by default
      frameAncestors: ["'none'"],   // Prevent clickjacking via iframe
      formAction: ["'none'"],       // No form submissions to external origins
    },
  },
  // Strict HSTS — tell browsers to only use HTTPS for 1 year
  hsts: { maxAge: 31536000, includeSubDomains: true },
  // Prevent MIME type sniffing
  noSniff: true,
  // Disable X-Powered-By
  hidePoweredBy: true,
  // Prevent referrer from leaking sensitive paths
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}));

// Enable gzip compression for all responses
app.use(compression({
  // Only compress responses larger than 1KB
  threshold: 1024,
  // Compress all response types
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

// V2 Middleware: Request ID, logging, rate limiting
app.use(requestId);
app.use(requestLogger);
// A request that could not reach the database answers 503 + Retry-After
// instead of a handler's generic 500, so clients know to retry.
app.use('/api', databaseUnavailableResponses);

// Middleware
const allowedOrigins = [
  process.env.CLIENT_URL,
  process.env.FRONTEND_URL,
  process.env.ADMIN_URL,
  'http://localhost:5173',  // Client dev
  'http://localhost:3000',  // Admin dev
  'http://localhost:3001',  // Alternative admin port
  'http://localhost:3030',  // Alternative admin port
  // Production domains (asksales.ai)
  'https://asksales.ai',
  'https://admin.asksales.ai',
  'https://asksales.ai',
].filter(Boolean);

const workspaceCors = cors({
  origin: function(origin, callback) {
    // Allow requests with no origin (like mobile apps, curl, etc.)
    if (!origin) return callback(null, true);
    
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    
    // Also allow any localhost origin in development
    if (process.env.NODE_ENV !== 'production' && origin.includes('localhost')) {
      return callback(null, true);
    }
    
    // Allow any asksales.ai subdomain in production
    if (origin.endsWith('.asksales.ai') || origin === 'https://asksales.ai') {
      return callback(null, true);
    }
    
    processLogger.warn({ data: origin }, '[CORS] Blocked origin:');
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  exposedHeaders: ['Content-Request-Confirmed', 'Idempotency-Replayed'],
});
app.use((req, res, next) => {
  if (isWidgetInstallationRequest(req)) return widgetInstallationCors(req, res, next);
  return workspaceCors(req, res, next);
});
// Phase 4.8 / SEC-010: CSRF double-submit-cookie protection (skipped for Bearer-auth)
import { csrfProtection } from './middleware/csrf.js';
import {createJsonBodyParser} from './middleware/jsonBody.js';
app.use(csrfProtection);
app.use(createJsonBodyParser());
app.use(express.urlencoded({
  extended: true,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  verify: (req: any, _res, buf) => {
    // Capture urlencoded bodies too (fallback for non-JSON Meta requests)
    if (!req.rawBody) req.rawBody = buf;
  },
}));

// Standardize all /api/* JSON responses to { success, data/message/error }
app.use('/api', responseWrapper);

// Every /api statement runs with a 25 s limit (120 s for the listed exports,
// imports and bulk edits) so slow reads cannot hold the pool and starve
// authentication and health checks. Mounted after the body parsers so the
// bound survives into the handlers. See tenancy/statementTimeout.ts.
app.use('/api', requestStatementTimeout());

// Serve public uploads from the same directory used by the storage backend.
const uploadsPath = localStoragePath();
if (!fs.existsSync(uploadsPath)) {
  fs.mkdirSync(uploadsPath, { recursive: true });
}

// Add both /uploads and /api/uploads routes for nginx compatibility
const publicTrackedCategories = new Set(['image', 'video', 'audio', 'brand_asset', 'content_asset']);
const protectPrivateTrackedUpload = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const segments = req.path.split('/').filter(Boolean);
  // Tracked tenant paths are private by default. Only media categories that
  // are designed for provider/CDN delivery retain direct static access.
  if (/^\d+$/.test(segments[0] || '') && !publicTrackedCategories.has(segments[1] || '')) {
    return res.status(404).end();
  }
  return next();
};
app.use('/uploads', protectPrivateTrackedUpload, express.static(uploadsPath));
app.use('/api/uploads', protectPrivateTrackedUpload, express.static(uploadsPath));

// Liveness is process-only; deployment readiness requires both durable stores.
let isShuttingDown = false;
app.get('/live', (_req, res) => { res.status(200).json({ status: 'alive' }); });
const ready = readinessHandler([
  isRedisAvailable,
  async () => {
    if (process.env.NODE_ENV !== 'production') return true;
    if (!pgPool) return false;
    const query = { text: 'SELECT EXISTS(SELECT 1 FROM admins) AS initialized', query_timeout: 1_500 };
    const initialized = await pgPool.query<{ initialized: boolean }>(query);
    return initialized.rows[0]?.initialized === true;
  },
  async () => {
    if (!pgPool) return false;
    const query = { text: 'SELECT 1', query_timeout: 1_500 };
    await pgPool.query(query);
    return true;
  },
], () => isShuttingDown);
app.get('/health', ready);
app.get('/ready', ready);

// Maintenance is enforced before both modular and legacy API routes. Admin,
// authentication, access-status, OAuth, and signed webhook paths remain live.
app.use('/api', maintenanceModeGate);

// V2 Architecture: Modular route modules (take priority over monolithic routes.ts)
import {
  authRoutes,
  leadsRoutes,
  enrichmentsRoutes,
  contentRoutes,
  chatRoutes,
  outreachRoutes,
  campaignsRoutes,
  settingsRoutes,
  adminRoutes,
  walletRoutes,
  embeddingsRoutes,
  crmRoutes,
  supportRoutes,
  supportMemberRoutes,
  supportWidgetRoutes,
  supportMediaDeliveryRoutes,
  proposalsRoutes,
  legalRoutes,
  platformRoutes,
  aiVisibilityRoutes,
  providerVerificationRoutes,
} from './routes/index.js';
import { insightsRoutes } from './routes/insights.routes.js';

// Mount modular routes (domain-specific, with their own auth + rate limiting middleware)
import { subscriptionRoutes, subscriptionAdminRoutes, subscriptionWebhook } from './routes/subscriptions.routes.js';
import { organizationRoutes } from './routes/organizations.routes.js';
app.use('/api/organizations', organizationRoutes);
app.use('/api/subscriptions', subscriptionRoutes);
app.use('/api/admin/subscriptions', subscriptionAdminRoutes);
app.post('/api/webhooks/razorpay/subscriptions/:credentialId', subscriptionWebhook);
app.use('/api/auth', authRoutes);
app.use('/api/platform', platformRoutes);
app.use('/api/leads', leadsRoutes);
app.use('/api/enrichments', enrichmentsRoutes);
app.use('/api/content', contentRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/outreach', outreachRoutes);
app.use('/api/campaigns', campaignsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/insights', insightsRoutes);
app.use('/api/embeddings', embeddingsRoutes);
app.use('/api/crm', crmRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/support-portal', supportMemberRoutes);
app.use('/api/support-widget', supportWidgetRoutes);
app.use('/support-media-delivery', supportMediaDeliveryRoutes);
app.use('/api/proposals', proposalsRoutes);
app.use('/api/legal', legalRoutes);
app.use('/api/ai-visibility', aiVisibilityRoutes);
app.use('/api/integration-readiness', providerVerificationRoutes);

// Legacy domain endpoints registered by routes.ts share the same authoritative
// module checks as their modular counterparts.
app.use('/api/ads', authenticateToken, requireModuleAccess('performance_marketing'));
app.use('/api/knowledge-base', authenticateToken, requireModuleAccess('knowledge_base'));
app.use('/api/integrations', authenticateToken, requireModuleAccess('integrations'));
app.use('/api/outreach-agent', authenticateToken, requireModuleAccess('outreach'));
app.use('/api/outreach-channel', authenticateToken, requireModuleAccess('outreach'));
app.use('/api/outreach-conversations', authenticateToken, requireModuleAccess('outreach'));
app.use('/api/storage', authenticateToken, requireModuleAccess('storage'));

// API Routes and WebSocket server setup (monolithic routes.ts — serves remaining routes + WebSocket)
const httpServer = await registerRoutes(app);

// Error middleware must be registered after every modular and legacy route.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const capacity = normalizeCapacityError(err);
  if(capacity && !res.headersSent) return res.status(capacity.status).json(capacity.toJSON());
  if (err?.name === 'MulterError') {
    const isTooLarge = err.code === 'LIMIT_FILE_SIZE';
    processLogger.warn({ code: err.code, path: req.path, method: req.method }, 'Upload rejected');
    return res.status(isTooLarge ? 413 : 400).json({
      success: false,
      error: isTooLarge ? 'The uploaded file exceeds the allowed size' : 'The upload request is invalid',
    });
  }
  if (err?.type === 'entity.too.large') {
    return res.status(413).json({ success: false, error: 'The request body exceeds the allowed size' });
  }
  if (err?.type === 'entity.parse.failed' || (err instanceof SyntaxError && 'body' in err)) {
    return res.status(400).json({ success: false, error: 'The request body is not valid JSON' });
  }
  processLogger.error({ err, path: req.path, method: req.method }, 'Global error handler');
  if (res.headersSent) return;
  res.status(500).json({
    success: false,
    error: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
  });
});

let embeddedMediaWorkersStarted = false;

// Start server
httpServer.listen(PORT, async () => {
  processLogger.info({ port: PORT }, '🚀 Server started');
  
  // Seed default credit pricing if not exists
  try {
    const { seedDefaultPricing } = await import('./models/creditPricing/functions.js');
    await seedDefaultPricing();
  } catch (err) {
    processLogger.warn({ err }, 'Failed to seed credit pricing defaults');
  }

  // Start cron jobs (BullMQ repeatable jobs — Redis is required)
  if (process.env.DISABLE_BACKGROUND_JOBS === 'true') {
    processLogger.info('[Server] Background scheduling disabled for this local session');
  } else {
    await cronService.start();
  }

  // Local development runs as one process. Consume only media queues here so
  // generated images/videos do not remain stuck in "waiting" indefinitely.
  if (process.env.NODE_ENV === 'development' && process.env.DISABLE_BACKGROUND_JOBS !== 'true'
    && process.env.START_EMBEDDED_MEDIA_WORKERS !== 'false') {
    try {
      const { startMediaWorkers } = await import('./workers/index.js');
      await startMediaWorkers();
      embeddedMediaWorkersStarted = true;
      processLogger.info('[Server] Embedded image/video workers started');
    } catch (err) {
      processLogger.error({ err }, '[Server] Failed to start embedded image/video workers');
    }
  }
});

// Graceful shutdown — flush any buffered Langfuse traces before process exits
async function gracefulShutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  processLogger.info({ signal }, '[Server] Graceful shutdown initiated');
  const failures: unknown[] = [];
  cronService.stop();
  stopOrchestratorBackgroundJobs();

  if (embeddedMediaWorkersStarted) {
    try {
      const { stopAllWorkers } = await import('./workers/index.js');
      await stopAllWorkers();
    } catch (err) {
      failures.push(err);
      processLogger.warn({ err }, '[Server] Embedded media worker shutdown failed');
    }
  }

  const httpClose = new Promise<void>((resolve) => {
    const forceTimer = setTimeout(() => {
      httpServer.closeAllConnections();
      resolve();
    }, 10_000);
    forceTimer.unref?.();
    httpServer.close((error) => {
      clearTimeout(forceTimer);
      if (error) failures.push(error);
      resolve();
    });
  });
  try {
    await shutdownChatWebSocket();
  } catch (err) {
    failures.push(err);
    processLogger.warn({ err }, '[Server] WebSocket shutdown failed');
  }
  await httpClose;

  // Phase 4.13: stop periodic timers in long-lived singletons.
  try {
    const { ChannelAuthManager } = await import('./services/ChannelAuthManager.js');
    ChannelAuthManager.getInstance().destroy();
  } catch (err) {
    processLogger.warn({ err }, '[Server] ChannelAuthManager dispose failed (skipped)');
  }
  try {
    const { actorHealthMonitor } = await import('./services/ActorHealthMonitor.js');
    actorHealthMonitor.destroy();
  } catch (err) {
    processLogger.warn({ err }, '[Server] ActorHealthMonitor dispose failed (skipped)');
  }
  const infrastructureResults = await Promise.allSettled([
    eventBus.close(),
    queueRegistry.close(),
    shutdownLangfuse(),
  ]);
  for (const result of infrastructureResults) {
    if (result.status === 'rejected') failures.push(result.reason);
  }
  try {
    await closeRedisConnections();
  } catch (err) {
    failures.push(err);
    processLogger.warn({ err }, '[Server] Redis shutdown failed');
  }
  processLogger.info({ clean: failures.length === 0 }, '[Server] Graceful shutdown completed');
  await pgPool?.end();
  process.exitCode = failures.length === 0 ? 0 : 1;
}
process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM').catch((err) => {
    processLogger.error({ err }, '[Server] Graceful shutdown crashed');
    process.exitCode = 1;
  });
});
process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT').catch((err) => {
    processLogger.error({ err }, '[Server] Graceful shutdown crashed');
    process.exitCode = 1;
  });
});
