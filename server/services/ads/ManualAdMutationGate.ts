import type { Request, Response } from 'express';
import { sql } from 'drizzle-orm';
import { db } from '../../models/db.js';
import { businessOwnerUserId } from '../../tenancy/businessContext.js';
import { logger } from '../../utils/logger.js';

/** Manual provider-only controls retain the route's existing actor permissions.
 * Recheck the same gates as durable actions immediately before provider IO.
 * The scoped database enforces current business membership for the settings read.
 */
export async function allowManualAdMutation(req: Request, res: Response): Promise<boolean> {
  let userId: number;
  try { userId = businessOwnerUserId(req); }
  catch {
    res.status(403).json({code:'BUSINESS_ACTOR_MISMATCH',error:'Business authority does not match the authenticated account.'});
    return false;
  }
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    res.status(401).json({error:'Unauthorized'});
    return false;
  }
  if (process.env.AD_PROVIDER_MUTATIONS_ENABLED !== 'true') {
    res.status(403).json({code:'AD_MUTATIONS_GATED',error:'Live provider mutations are disabled.'});
    return false;
  }
  try {
    const result = await db.execute(sql`SELECT live_provider_mutations_enabled FROM ad_settings WHERE user_id=${userId} LIMIT 1`);
    if (process.env.AD_PROVIDER_MUTATIONS_ENABLED !== 'true' || result.rows[0]?.live_provider_mutations_enabled !== true) {
      res.status(403).json({code:'AD_MUTATIONS_GATED',error:'Live provider mutations are disabled for this business.'});
      return false;
    }
    return true;
  } catch (error) {
    logger.error({err:error},'[ManualAdMutationGate] Unable to verify mutation authority');
    res.status(503).json({code:'AD_MUTATION_AUTHORITY_UNAVAILABLE',error:'Live action authority could not be verified. Please try again.'});
    return false;
  }
}
