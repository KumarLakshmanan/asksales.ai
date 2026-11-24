/**
 * Rate Limiting & Throttling Constants
 *
 * Rate limiter settings for Express middleware and channel-specific throttling.
 */

// ─── Express Rate Limiter ───────────────────────────────────────────────────────

/** Rate limit window in milliseconds (1 minute) */
export const RATE_LIMIT_WINDOW_MS = 60 * 1000;

/** Global rate limit: requests per window per IP */
export const GLOBAL_RATE_LIMIT = 200;

/** Auth rate limit: login/register attempts per window per IP */
export const AUTH_RATE_LIMIT = 10;

/** API rate limit: requests per window per user */
export const API_RATE_LIMIT = 60;

/** AI/LLM rate limit: requests per window per user */
export const AI_RATE_LIMIT = 20;

/** Upload rate limit: uploads per window per user */
export const UPLOAD_RATE_LIMIT = 10;

// ─── Channel Throttling (SmartThrottlingService) ────────────────────────────────

export interface ChannelThrottleConfig {
  platform: string;
  dailyLimit: number;
  hourlyLimit?: number;
  minuteLimit?: number;
  concurrentRequests?: number;
  minDelayMs?: number;
}

export const CHANNEL_THROTTLE_CONFIGS: Record<string, ChannelThrottleConfig> = {
  linkedin: {
    platform: 'linkedin',
    dailyLimit: 100,
    hourlyLimit: 20,
    minuteLimit: 5,
    minDelayMs: 30_000,
  },
  instagram: {
    platform: 'instagram',
    dailyLimit: 150,
    hourlyLimit: 30,
    minuteLimit: 10,
    minDelayMs: 10_000,
  },
  twitter: {
    platform: 'twitter',
    dailyLimit: 500,
    hourlyLimit: 50,
    minuteLimit: 15,
    minDelayMs: 5_000,
  },
  whatsapp: {
    platform: 'whatsapp',
    dailyLimit: 1000,
    hourlyLimit: 100,
    concurrentRequests: 10,
    minDelayMs: 1_000,
  },
  email: {
    platform: 'email',
    dailyLimit: 5000,
    hourlyLimit: 500,
    minuteLimit: 50,
    minDelayMs: 100,
  },
  facebook: {
    platform: 'facebook',
    dailyLimit: 200,
    hourlyLimit: 40,
    minuteLimit: 10,
    minDelayMs: 15_000,
  },
  sms: {
    platform: 'sms',
    dailyLimit: 1000,
    hourlyLimit: 100,
    minuteLimit: 20,
    minDelayMs: 500,
  },
  gmail: {
    platform: 'gmail',
    dailyLimit: 2000,
    hourlyLimit: 200,
    minuteLimit: 20,
    minDelayMs: 100,
  },
};

/** Throttle stats cleanup interval (ms) */
export const THROTTLE_STATS_CLEANUP_INTERVAL_MS = 60_000;
