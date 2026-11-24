/**
 * Request Validation Middleware
 * 
 * Validates request bodies, query params, and path params using Zod schemas.
 * Provides consistent error responses for invalid requests.
 */

import { z, ZodSchema, ZodError } from 'zod';
import type { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger.js';

/**
 * Validate request body against a Zod schema.
 *
 * Options:
 *   - `strict` (default `true`): reject unknown keys with 400. Pass
 *     `false` for legacy routes that intentionally accept extra fields
 *     (e.g. free-form metadata blobs that get persisted as-is). The
 *     Zod-native way to do this is `z.object({...}).strict()` vs
 *     `.passthrough()` vs the default `.strip()`; this option lets the
 *     caller toggle behaviour without editing the schema.
 *
 * Phase 9.8 / MID-005: this was always wanted, but we shipped with
 * the default and never re-visited. The previous behaviour (always
 * strict) is preserved when `strict` is omitted.
 */
export function validateBody<T extends ZodSchema>(
  schema: T,
  options: { strict?: boolean } = {},
) {
  const { strict = true } = options;
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      // If `strict: false`, clone the schema with `.passthrough()` so
      // unknown keys are preserved instead of stripped. We only do this
      // when the underlying schema is a ZodObject — for unions/refined
      // schemas the option has no effect.
      let effectiveSchema = schema;
      if (schema instanceof z.ZodObject) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        effectiveSchema = (strict ? schema.strict() : schema.passthrough()) as any;
      }
      const parsed = effectiveSchema.parse(req.body);
      req.body = parsed;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));

        logger.warn({ path: req.path, errors }, 'Request validation failed');

        return res.status(400).json({
          error: 'Validation failed',
          details: errors,
        });
      }
      next(error);
    }
  };
}

/**
 * Validate query parameters against a Zod schema
 */
export function validateQuery<T extends ZodSchema>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(req.query);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (req as any).validatedQuery = parsed;
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));

        return res.status(400).json({
          error: 'Invalid query parameters',
          details: errors,
        });
      }
      next(error);
    }
  };
}

/**
 * Validate path parameters against a Zod schema
 */
export function validateParams<T extends ZodSchema>(schema: T) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = schema.parse(req.params);
      req.params = parsed as Request['params'];
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        const errors = error.issues.map((e) => ({
          field: e.path.join('.'),
          message: e.message,
        }));

        return res.status(400).json({
          error: 'Invalid path parameters',
          details: errors,
        });
      }
      next(error);
    }
  };
}

/**
 * Common validation schemas
 */
export const commonSchemas = {
  id: z.object({
    id: z.string().regex(/^\d+$/, 'ID must be a number').transform(Number),
  }),
  pagination: z.object({
    page: z.string().optional().transform((v) => (v ? parseInt(v) : 1)),
    limit: z.string().optional().transform((v) => (v ? parseInt(v) : 20)),
    sortBy: z.string().optional(),
    sortOrder: z.enum(['asc', 'desc']).optional().default('desc'),
  }),
  search: z.object({
    q: z.string().optional(),
    page: z.string().optional().transform((v) => (v ? parseInt(v) : 1)),
    limit: z.string().optional().transform((v) => (v ? parseInt(v) : 20)),
  }),
};
