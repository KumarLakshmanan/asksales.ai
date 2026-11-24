/**
 * Request Logging Middleware
 *
 * Logs incoming requests and outgoing responses with structured data.
 * Includes request ID generation, timing, and response status tracking.
 *
 * SEC-008: Sanitizes sensitive query params (token, email, password, etc.) before logging.
 */

import { v4 as uuidv4 } from 'uuid';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

const SENSITIVE_QUERY_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token',
  'email', 'phone', 'password', 'pass', 'pwd', 'secret', 'key', 'apikey', 'api_key',
  'otp', 'code', 'jwt', 'sessionid', 'session_id', 'bullboard_token', 'cookie',
  'authorization', 'auth', 'ssn', 'credit_card', 'card',
]);

function sanitizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl, 'http://placeholder.local');
    let mutated = false;
    for (const k of Array.from(u.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) {
        u.searchParams.set(k, '[REDACTED]');
        mutated = true;
      }
    }
    return mutated ? u.pathname + u.search : rawUrl;
  } catch {
    // rawUrl is a relative path with query — do a string-level scrub
    const idx = rawUrl.indexOf('?');
    if (idx === -1) return rawUrl;
    const path = rawUrl.slice(0, idx);
    const qs = rawUrl.slice(idx + 1);
    const scrubbed = qs
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        const k = eq === -1 ? pair : pair.slice(0, eq);
        if (SENSITIVE_QUERY_KEYS.has(k.toLowerCase())) {
          return `${k}=[REDACTED]`;
        }
        return pair;
      })
      .join('&');
    return `${path}?${scrubbed}`;
  }
}

/**
 * Add request ID to all requests
 */
export function requestId(req: Request, _res: Response, next: NextFunction) {
  req.id = req.headers['x-request-id']?.toString() || uuidv4();
  next();
}

/**
 * Log incoming requests and outgoing responses
 */
export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const startTime = Date.now();
  const requestId = req.id;

  // Log response on finish — only errors and warnings
  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const logData = {
      requestId,
      method: req.method,
      url: sanitizeUrl(req.url),
      statusCode: res.statusCode,
      duration,
      userId: req.user?.id,
    };

    if (res.statusCode >= 500) {
      logger.error(logData, 'Request error');
    } else if (res.statusCode >= 400) {
      logger.warn(logData, 'Request client error');
    }
  });

  next();
}
