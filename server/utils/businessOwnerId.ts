import type { Request } from 'express';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { parsePositiveId } from './paramParsers.js';

/** The business owner's user id as a positive safe integer, or null. */
export function businessOwnerIdOrNull(req: Request): number | null {
  return parsePositiveId(businessOwnerUserId(req));
}
