/**
 * Rate Limiting Middleware
 * 
 * Provides multiple rate limiters for different endpoint categories:
 * - Global: 100 req/min per IP
 * - Auth: 10 req/min per IP (login, register)
 * - API: 60 req/min per user
 * - AI/LLM: 20 req/min per user (expensive operations)
 * 
 * Uses Redis store when available, falls back to in-memory.
 */

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import type { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { getRedisConnection } from '../infrastructure/redis.js';
import { currentBusinessScope } from '../tenancy/businessContext.js';

export const demoParseRateLimiter = rateLimit({
  windowMs: 60_000,
  max: 4,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  store: buildStore('demo-parse'),
  keyGenerator: req => String(currentBusinessScope()?.businessProfileId || req.user?.id || ipKeyGenerator(req.ip || 'unknown')),
  message: { error: 'Demo parsing is limited to four requests per minute per business.' },
});
import {
  RATE_LIMIT_WINDOW_MS,
  GLOBAL_RATE_LIMIT,
  AUTH_RATE_LIMIT,
  API_RATE_LIMIT,
  AI_RATE_LIMIT,
  UPLOAD_RATE_LIMIT,
} from '../utils/rateLimitConstants';

// SEC-006: Build a per-prefix Redis store. Falls back to in-memory if Redis is unavailable.
function buildStore(prefix: string): RedisStore | undefined {
  try {
    const client = getRedisConnection();
    return new RedisStore({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sendCommand: (...args: string[]) => (client as any).call(...args),
      prefix: `rl:${prefix}:`,
    });
  } catch (e) {
    logger.warn({ err: (e as Error).message, prefix }, '[RateLimiter] Redis store unavailable, using in-memory');
    return undefined;
  }
}

/**
 * Extract user ID from authenticated request
 */
function getUserId(req: Request): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const user = (req as any).user;
  return user?.id?.toString() || req.ip || 'anonymous';
}

/**
 * Global rate limiter — 200 requests per minute per IP
 */
export const globalRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: GLOBAL_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('global'),
  message: { error: 'Too many requests, please try again later.' },
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || 'unknown'),
  handler: (req: Request, res: Response) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Global rate limit exceeded');
    res.status(429).json({ error: 'Too many requests, please try again later.' });
  },
});

/**
 * Auth rate limiter — 10 requests per minute per IP
 * Applied to login, register, password reset endpoints
 */
export const authRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: AUTH_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('auth'),
  message: { error: 'Too many authentication attempts, please try again later.' },
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip || 'unknown'),
  handler: (req: Request, res: Response) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Auth rate limit exceeded');
    res.status(429).json({ error: 'Too many authentication attempts, please try again later.' });
  },
});

/**
 * API rate limiter — 60 requests per minute per user
 * Applied to general API endpoints
 */
export const apiRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: API_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  store: buildStore('api'),
  message: { error: 'API rate limit exceeded, please slow down.' },
  keyGenerator: getUserId,
  handler: (req: Request, res: Response) => {
    logger.warn({ userId: getUserId(req), path: req.path }, 'API rate limit exceeded');
    res.status(429).json({ error: 'API rate limit exceeded, please slow down.' });
  },
});

/**
 * AI/LLM rate limiter — 20 requests per minute per user
 * Applied to content generation, chat, and other AI-powered endpoints
 */
export const aiRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: AI_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  store: buildStore('ai'),
  message: { error: 'AI request rate limit exceeded, please wait before sending more requests.' },
  keyGenerator: getUserId,
  handler: (req: Request, res: Response) => {
    logger.warn({ userId: getUserId(req), path: req.path }, 'AI request rate limit exceeded');
    res.status(429).json({ error: 'AI request rate limit exceeded, please wait before sending more requests.' });
  },
});

/**
 * Upload rate limiter — 10 uploads per minute per user
 */
export const uploadRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: UPLOAD_RATE_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  store: buildStore('upload'),
  message: { error: 'Upload rate limit exceeded.' },
  keyGenerator: getUserId,
  handler: (req: Request, res: Response) => {
    logger.warn({ userId: getUserId(req), path: req.path }, 'Upload rate limit exceeded');
    res.status(429).json({ error: 'Upload rate limit exceeded.' });
  },
});

/**
 * Credentials rate limiter — 5 saves per minute per user.
 * Applied to all manual-credential save endpoints (Meta, Instagram, Facebook, WhatsApp)
 * to prevent token brute-forcing against the Meta Graph API verify call.
 */
export const credentialsRateLimiter = rateLimit({
  windowMs: RATE_LIMIT_WINDOW_MS,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  validate: { keyGeneratorIpFallback: false },
  store: buildStore('credentials'),
  message: { error: 'Too many credential save attempts, please wait a moment and try again.' },
  keyGenerator: getUserId,
  handler: (req: Request, res: Response) => {
    logger.warn({ userId: getUserId(req), path: req.path }, 'Credentials rate limit exceeded');
    res.status(429).json({ error: 'Too many credential save attempts, please wait a moment and try again.' });
  },
});

/**
 * Public review submission rate limiter (H11) — 5 attempts per 10 minutes per IP.
 * Applied to anonymous /review-public/:token POST endpoints to prevent fake-review
 * spam against unguessable but stolen tokens.
 */
export const publicReviewRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('public-review'),
  message: { error: 'Too many review submissions. Please try again later.' },
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? 'anonymous'),
  handler: (req: Request, res: Response) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Public review rate limit exceeded');
    res.status(429).json({ error: 'Too many review submissions. Please try again later.' });
  },
});

/**
 * Public widget rate limiter (H10) — 10 actions per minute per IP.
 * Applied to anonymous /api/support-widget/* endpoints to slow down lead spam.
 */
export const publicWidgetRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  store: buildStore('public-widget'),
  message: { error: 'Too many requests. Please try again in a moment.' },
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? 'anonymous'),
  handler: (req: Request, res: Response) => {
    logger.warn({ ip: req.ip, path: req.path }, 'Public widget rate limit exceeded');
    res.status(429).json({ error: 'Too many requests. Please try again in a moment.' });
  },
});

// The widget polls history every five seconds. History reads must not consume
// the ten-per-minute chat/download budget or invalidate an otherwise valid chat.
export const publicWidgetReadRateLimiter = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  store: buildStore('public-widget-read'),
  keyGenerator: (req: Request) => ipKeyGenerator(req.ip ?? 'anonymous'),
  message: { error: 'Too many history requests. Please try again in a moment.' },
});
