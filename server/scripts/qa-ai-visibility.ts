/** Isolated AI Visibility acceptance server. Use a disposable *_ai_visibility_qa_* database. */
import '../env.js';
if (
  !process.env.DB_NAME?.includes('_ai_visibility_qa_') ||
  process.env.REDIS_PORT !== '6411' ||
  process.env.STORAGE_BACKEND !== 'local' ||
  !process.env.LOCAL_STORAGE_PATH?.startsWith('/tmp/ai-visibility-qa')
) {
  throw new Error(
    'QA requires an isolated database, Redis port 6411, and /tmp/ai-visibility-qa storage.',
  );
}
const { default: express } = await import('express');
const { default: cors } = await import('cors');
const { default: bcrypt } = await import('bcryptjs');
const { Worker } = await import('bullmq');
const { pgPool } = await import('../models/db.js');
const { authenticateToken } = await import('../middleware/auth.js');
const { login, getCurrentUser, logout } = await import('../controllers/authController.js');
const { default: visibilityRoutes } = await import('../routes/aiVisibility.routes.js');
const { default: platformRoutes } = await import('../routes/platform.routes.js');
const { default: walletRoutes } = await import('../routes/wallet.routes.js');
const { queueRegistry, QUEUE_NAMES } = await import('../queues/index.js');
const { getRedisConnection } = await import('../infrastructure/redis.js');
const { auditOrchestrator } = await import('../services/aiVisibility/AuditOrchestrator.js');
await pgPool!.query(
  "UPDATE users SET email=$1,password=$2,name='AI Visibility QA',is_verified=true,is_approved=true,is_setup_complete=true WHERE id=1",
  ['visibility-qa@example.test', await bcrypt.hash('Visibility-QA-local-2026!', 10)],
);
await queueRegistry.initialize();
const worker = new Worker(
  QUEUE_NAMES.AI_VISIBILITY_AUDIT,
  async (job) =>
    job.data.retryReport
      ? auditOrchestrator.retryReport(Number(job.data.auditId), Number(job.data.userId))
      : auditOrchestrator.run(Number(job.data.auditId), Number(job.data.userId)),
  { connection: getRedisConnection() as never, concurrency: 1 },
);
worker.on('failed', (_job, error) => console.error('QA audit worker:', error.message));
const app = express();
app.use(cors({ origin: 'http://localhost:5211', credentials: true }));
app.use(express.json());
app.get('/api/auth/csrf-token', (_req, res) => res.json({ ok: true }));
app.post('/api/auth/login', login);
app.post('/api/auth/logout', logout);
app.get('/api/auth/me', authenticateToken, getCurrentUser);
app.use('/api/platform', platformRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/ai-visibility', visibilityRoutes);
app.get('/health', (_req, res) => res.json({ status: 'healthy', scope: 'isolated-ai-visibility' }));
app.listen(8411, '127.0.0.1', () =>
  console.log('AI Visibility QA listening on http://localhost:8411'),
);
