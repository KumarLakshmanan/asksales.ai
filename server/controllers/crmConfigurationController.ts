import type { Request, Response } from 'express';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { getCrmConfiguration, saveCrmConfiguration, CrmConfigurationError } from '../services/CRMConfigurationService.js';
import { crmConfigurationSchema } from '../utils/crmConfigurationValidation.js';
import { logger } from '../utils/logger.js';

function handleError(error: unknown, res: Response) {
  if (error instanceof CrmConfigurationError) return res.status(error.status).json({ error: error.message });
  logger.error({ err: error }, 'CRM configuration request failed');
  return res.status(500).json({ error: 'Unable to access CRM configuration. Please try again.' });
}

export async function getConfiguration(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.json({ success: true, data: await getCrmConfiguration(userId) });
  } catch (error) {
    return handleError(error, res);
  }
}

export async function updateConfiguration(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const parsed = crmConfigurationSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid CRM configuration.', details: parsed.error.issues });
  }
  try {
    return res.json({ success: true, data: await saveCrmConfiguration(userId, parsed.data) });
  } catch (error) {
    return handleError(error, res);
  }
}
