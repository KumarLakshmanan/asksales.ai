import { Response } from 'express';

/**
 * Standardized API response helper.
 * All API routes should use these to ensure consistent response format:
 *
 *   Success: { success: true, data: T, message?: string }
 *   Error:   { success: false, error: string }
 *   List:    { success: true, data: T[], total?: number, page?: number, limit?: number }
 */

export function sendSuccess<T>(res: Response, data: T, statusCode = 200) {
  return res.status(statusCode).json({ success: true, data });
}

export function sendMessage(res: Response, message: string, statusCode = 200) {
  return res.status(statusCode).json({ success: true, message });
}

export function sendError(res: Response, error: string, statusCode = 500) {
  return res.status(statusCode).json({ success: false, error });
}

/**
 * L4: Structured error response with an error code and optional extra data.
 * Use this when the error carries structured metadata the client needs
 * (e.g., idempotency violations, business-rule failures).
 *
 * Shape: `{ success: false, error: string, code: string, [extraFields] }`
 */
export function sendErrorResponse(
  res: Response,
  error: string,
  statusCode: number,
  code: string,
  extra?: Record<string, unknown>
) {
  return res.status(statusCode).json({
    success: false,
    error,
    code,
    ...extra,
  });
}
