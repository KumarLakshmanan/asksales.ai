/**
 * Configuration validation and loading
 */

import { z } from 'zod';
import { logger } from './logger.js';
import { resolveBookingProviderKind } from '../services/booking/providerConfig.js';

// Environment schema validation
const envSchema = z.object({
  // Database
  DB_HOST: z.string().min(1, 'DB_HOST is required'),
  DB_PORT: z.string().transform(Number).refine(port => port > 0 && port <= 65535, 'Invalid DB_PORT'),
  DB_USER: z.string().min(1, 'DB_USER is required'),
  DB_PASSWORD: z.string().default(''),
  DB_NAME: z.preprocess(
    (val) => {
      if (typeof val === 'string' && val.trim().length > 0) {
        return val;
      }
      const legacyDbName = process.env.DB_DATABASE;
      return legacyDbName;
    },
    z.string().min(1, 'DB_NAME (or DB_DATABASE) is required')
  ),
  DB_SSL: z.string().transform(val => val === 'true'),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().min(1, 'JWT_EXPIRES_IN is required'),
  SECRETS_ENCRYPTION_KEY: z.string().min(32, 'SECRETS_ENCRYPTION_KEY must be at least 32 characters').optional(),

  // Email Service
  SENDGRID_API_KEY: z.string().optional(),
  DEFAULT_FROM_EMAIL: z.string().email().optional(),
  DEFAULT_FROM_NAME: z.string().optional(),

  // SMS Service
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_PHONE_NUMBER: z.string().optional(),

  // Enrichment Services
  CLEARBIT_API_KEY: z.string().optional(),

  // Meta Ads
  META_APP_ID: z.string().optional(),
  META_APP_SECRET: z.string().optional(),

  // OpenAI
  OPENAI_API_KEY: z.string().optional(),

  // Server
  PORT: z.string().transform(Number).refine(port => port > 0 && port <= 65535, 'Invalid PORT').prefault('3001'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  CORS_ORIGIN: z.string().url().default('http://localhost:5173'),

  // Redis
  REDIS_URL: z.string().optional(),

  // Logging
  LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
});

export type Config = z.infer<typeof envSchema>;

/**
 * Load and validate environment configuration
 */
export function loadConfig(): Config {
  try {
    const config = envSchema.parse(process.env);
    resolveBookingProviderKind();
    validateConfigDependencies(config);
    return config;
  } catch (error) {
    if (error instanceof z.ZodError) {
      logger.error('Configuration validation failed:');
      error.issues.forEach(err => {
        logger.error({ value: err.path.join('.'), message: err.message }, '-');
      });
      process.exit(1);
    }
    throw error;
  }
}

/**
 * Validate conditional dependencies (e.g., if one Twilio var is set, all must be set)
 */
function validateConfigDependencies(config: Config): void {
  const errors: string[] = [];

  if (config.NODE_ENV === 'production' && !config.SECRETS_ENCRYPTION_KEY) {
    errors.push('SECRETS_ENCRYPTION_KEY is required in production so credential encryption is independent from JWT signing key rotation');
  }

  // Twilio validation
  const twilioVars = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE_NUMBER'];
  const twilioSet = twilioVars.filter(varName => config[varName as keyof Config]);
  if (twilioSet.length > 0 && twilioSet.length !== twilioVars.length) {
    errors.push(`Twilio configuration incomplete. All of ${twilioVars.join(', ')} must be set`);
  }

  // Meta Ads validation
  const metaVars = ['META_APP_ID', 'META_APP_SECRET'];
  const metaSet = metaVars.filter(varName => config[varName as keyof Config]);
  if (metaSet.length > 0 && metaSet.length !== metaVars.length) {
    errors.push(`Meta Ads configuration incomplete. All of ${metaVars.join(', ')} must be set`);
  }

  if (errors.length > 0) {
    logger.error({ errors }, 'Configuration dependency errors');
    process.exit(1);
  }
}

/**
 * Check if a service is configured
 */
export function isServiceConfigured(serviceName: string): boolean {
  const config = loadConfig();

  switch (serviceName) {
    case 'email':
      return !!(config.SENDGRID_API_KEY && config.DEFAULT_FROM_EMAIL);
    case 'sms':
      return !!(config.TWILIO_ACCOUNT_SID && config.TWILIO_AUTH_TOKEN && config.TWILIO_PHONE_NUMBER);
    case 'enrichment':
      return !!config.CLEARBIT_API_KEY;
    case 'meta-ads':
      return !!(config.META_APP_ID && config.META_APP_SECRET);
    case 'openai':
      return !!config.OPENAI_API_KEY;
    default:
      return false;
  }
}

/**
 * Get service status for health checks
 */
export function getServiceStatus(): Record<string, boolean> {
  return {
    email: isServiceConfigured('email'),
    sms: isServiceConfigured('sms'),
    enrichment: isServiceConfigured('enrichment'),
    'meta-ads': isServiceConfigured('meta-ads'),
    openai: isServiceConfigured('openai'),
    database: true, // Would need to test actual DB connection
    redis: !!process.env.REDIS_URL,
  };
}

// Export singleton config
export const config = loadConfig();
