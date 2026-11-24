import crypto from 'node:crypto';
import { logger } from './logger.js';

const configuredSecret = process.env.WEBHOOK_SECRET?.trim();

if (!configuredSecret && process.env.NODE_ENV === 'production') {
  throw new Error('WEBHOOK_SECRET must be configured in production');
}

if (!configuredSecret && process.env.NODE_ENV !== 'test') {
  logger.warn('[webhooks] WEBHOOK_SECRET is not configured; using an ephemeral development-only secret');
}

export const webhookSigningSecret = configuredSecret
  || (process.env.NODE_ENV === 'test'
    ? 'test-only-webhook-secret-not-for-production'
    : crypto.randomBytes(48).toString('hex'));
