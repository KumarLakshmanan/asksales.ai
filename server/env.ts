import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './utils/logger.js';
import { metaAdLibraryFetcher } from './services/ads/creative-intelligence/MetaAdLibraryFetcher.js';

// ESM-friendly __dirname helper
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Determine the environment
const nodeEnv = process.env.NODE_ENV || 'development';
const explicitDatabaseEnvironment = Object.fromEntries(
  [
    'DATABASE_URL',
    'DB_HOST',
    'DB_PORT',
    'DB_USER',
    'DB_PASSWORD',
    'DB_NAME',
    'DB_DATABASE',
    'DB_SSL',
  ]
    .filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]),
);

// Load environment-specific .env file (.env.development or .env.production)
const envFile = nodeEnv === 'production' ? '.env.production' : '.env.development';
const envPath = path.resolve(__dirname, envFile);

const result = dotenv.config({ path: envPath });

// Container deployments inject configuration directly. Missing optional files
// are expected; required values are still validated below.
if (result.error && (result.error as NodeJS.ErrnoException).code !== 'ENOENT') {
  logger.warn({ err: result.error, path: envPath }, '[ENV] Unable to read environment file');
}

// Also load .env (untracked overrides for secrets like JWT_SECRET, API keys).
// Values from .env take precedence over .env.production / .env.development.
const overridePath = path.resolve(__dirname, '.env');
dotenv.config({
  path: overridePath,
  // Tests and isolated local runs must be able to supply a disposable
  // database without rewriting the developer's untracked secrets file.
  // Production keeps the existing `.env`-wins behaviour by default.
  override: process.env.DOTENV_OVERRIDE !== 'false',
});
// An explicitly selected database is an execution boundary, especially for
// migrations and acceptance tests. Keep those values authoritative while
// still loading unrelated secrets from the local override file.
Object.assign(process.env, explicitDatabaseEnvironment);

// ── Required environment variable validation ───────────────────────────────
// Fail fast at startup if critical vars are missing rather than surfacing
// runtime errors that are hard to diagnose.
const REQUIRED_ENV_VARS = [
  'JWT_SECRET',
  'DB_HOST',
  'DB_USER',
  'DB_PASSWORD',
  'CHANNEL_AUTH_ENCRYPTION_KEY',
  'REDIS_URL',
  'RAZORPAY_KEY_SECRET',
] as const;

const missing: string[] = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
if (nodeEnv === 'production' && !process.env.WEBHOOK_SECRET?.trim()) {
  missing.push('WEBHOOK_SECRET');
}
// DB name can be either DB_DATABASE or DB_NAME
const missingDbName = !process.env.DB_DATABASE && !process.env.DB_NAME;
if (missing.length > 0 || missingDbName) {
  const allMissing = [...missing, ...(missingDbName ? ['DB_DATABASE or DB_NAME'] : [])];
  logger.error(
    { missing: allMissing },
    `[ENV] FATAL: Missing required environment variables. Server will not start.`
  );
  process.exit(1);
}

// ── Langfuse observability — optional, non-fatal ───────────────────────────
logger.info({ provider: metaAdLibraryFetcher() }, '[ENV] Meta competitor analysis fetcher configured');

// Set LANGFUSE_ENABLED=true and provide the key pair to activate LLM tracing.
// Supported vars: LANGFUSE_ENABLED, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_HOST
if (process.env.LANGFUSE_ENABLED === 'true') {
  if (!process.env.LANGFUSE_SECRET_KEY || !process.env.LANGFUSE_PUBLIC_KEY) {
    logger.warn(
      '[ENV] LANGFUSE_ENABLED=true but LANGFUSE_SECRET_KEY / LANGFUSE_PUBLIC_KEY are not set. LLM tracing will be disabled.',
    );
  } else {
    logger.info('[ENV] Langfuse LLM observability is enabled');
  }
}
