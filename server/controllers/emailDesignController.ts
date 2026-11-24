import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/express.js';
import { businessOwnerUserId, isBusinessOwner, currentBusinessScope } from '../tenancy/businessContext.js';
import { getEmailDesignPreferences, saveEmailDesignPreferences } from '../services/EmailDesignService.js';
import { getBrandInfo, savedBrandToolkitId } from '../utils/emailTemplates.js';
import { EMAIL_DESIGNS, isEmailDesignId } from '../../shared/emailDesigns.js';
import { logger } from '../utils/logger.js';
export async function getEmailDesignSettings(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    // Preview with the brand the workflow will send with (owner/business-bound in getBrandInfo).
    const brandToolkitId = savedBrandToolkitId(req.query?.brandToolkitId);
    const [preferences, brand] = await Promise.all([getEmailDesignPreferences(userId), getBrandInfo(userId, brandToolkitId)]);
    return res.json({ preferences, brand, designs: EMAIL_DESIGNS, canManage: isBusinessOwner(req) || currentBusinessScope()?.role === 'billing_admin' });
  } catch (error) { logger.error({ err: error }, '[EmailDesign] Load failed'); return res.status(503).json({ error: 'Email designs could not be loaded. Please retry.' }); }
}
export async function updateEmailDesignSettings(req: AuthenticatedRequest, res: Response) {
  const { outreach, assistant, revision } = req.body ?? {};
  if (!isEmailDesignId(outreach) || !isEmailDesignId(assistant) || typeof revision !== 'string' || revision.length > 100) return res.status(400).json({ error: 'Choose valid email designs and reload the latest settings.' });
  try {
    const preferences = await saveEmailDesignPreferences(businessOwnerUserId(req), { outreach, assistant, revision });
    return preferences ? res.json({ preferences }) : res.status(409).json({ error: 'Email designs changed in another session. Reload and review before saving.' });
  } catch (error) { logger.error({ err: error }, '[EmailDesign] Save failed'); return res.status(503).json({ error: 'Email design defaults could not be saved.' }); }
}
