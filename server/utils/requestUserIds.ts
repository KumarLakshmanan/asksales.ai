import type { Request } from 'express';
import { parsePositiveIdOrUndefined } from './paramParsers.js';

/** The signed-in admin's user id as a positive safe integer, or undefined. */
export function adminActorId(req: Request): number | undefined {
  return parsePositiveIdOrUndefined(req.user?.id);
}

/** The signed-in admin's user id as a positive integer, or null (not limited to the safe-integer range). */
export function adminActorIdOrNull(req: Request): number | null {
  const id = Number(req.user?.id);
  return Number.isInteger(id) && id > 0 ? id : null;
}
