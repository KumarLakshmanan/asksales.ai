import type { z } from 'zod';

/** The first validation message, or a generic one when Zod gives none. */
export function firstIssueMessage(error: z.ZodError) {
  return error.issues[0]?.message || 'Invalid request.';
}
