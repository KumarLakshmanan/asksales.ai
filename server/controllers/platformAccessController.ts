import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from 'express';
import {
  getEffectiveModuleAccess,
  getMaintenanceSettings,
  getPlatformControls,
  getUserModuleModes,
  replaceUserModuleModes,
  updatePlatformControls,
} from '../models/platformAccess/functions.js';
import { parsePlatformControlsInput, parseUserModuleAccessInput } from '../utils/platformAccessValidation.js';
import { logger } from '../utils/logger.js';
import { subscriptions } from '../services/subscriptions/service.js';

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function getCurrentPlatformAccess(req: Request, res: Response) {
  try {
    const userId = positiveId(businessOwnerUserId(req));
    if (!userId) return res.status(401).json({ success: false, error: 'Authentication is required' });
    const [maintenance, modules, subscription] = await Promise.all([
      getMaintenanceSettings(),
      getEffectiveModuleAccess(userId),
      subscriptions.access(userId),
    ]);
    return res.json({ maintenance, modules, subscription });
  } catch (error) {
    logger.error({ err: error }, 'Failed to load current platform access');
    return res.status(500).json({ success: false, error: 'Failed to load platform access' });
  }
}

export async function getAdminPlatformControls(_req: Request, res: Response) {
  try {
    return res.json(await getPlatformControls());
  } catch (error) {
    logger.error({ err: error }, 'Failed to load platform controls');
    return res.status(500).json({ success: false, error: 'Failed to load platform controls' });
  }
}

export async function updateAdminPlatformControls(req: Request, res: Response) {
  try {
    const adminId = positiveId(req.user?.id);
    if (!adminId) return res.status(401).json({ success: false, error: 'Administrator authentication is required' });
    const input = parsePlatformControlsInput(req.body);
    await updatePlatformControls({ ...input, adminId });
    return res.json(await getPlatformControls());
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update platform controls';
    if (/must|unknown|invalid|duplicate|unsupported|configured|required/i.test(message)) {
      return res.status(400).json({ success: false, error: message });
    }
    logger.error({ err: error }, 'Failed to update platform controls');
    return res.status(500).json({ success: false, error: 'Failed to update platform controls' });
  }
}

export async function getAdminUserModuleAccess(req: Request, res: Response) {
  try {
    const userId = positiveId(req.params.id);
    if (!userId) return res.status(400).json({ success: false, error: 'A valid user ID is required' });
    const access = await getUserModuleModes(userId);
    if (!access) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json(access);
  } catch (error) {
    logger.error({ err: error }, 'Failed to load user module access');
    return res.status(500).json({ success: false, error: 'Failed to load user module access' });
  }
}

export async function updateAdminUserModuleAccess(req: Request, res: Response) {
  try {
    const userId = positiveId(req.params.id);
    const adminId = positiveId(req.user?.id);
    if (!userId) return res.status(400).json({ success: false, error: 'A valid user ID is required' });
    if (!adminId) return res.status(401).json({ success: false, error: 'Administrator authentication is required' });
    const modules = parseUserModuleAccessInput(req.body);
    const updated = await replaceUserModuleModes({ userId, adminId, modules });
    if (!updated) return res.status(404).json({ success: false, error: 'User not found' });
    return res.json(await getUserModuleModes(userId));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to update user module access';
    if (/must|unknown|invalid|duplicate|unsupported|contain/i.test(message)) {
      return res.status(400).json({ success: false, error: message });
    }
    logger.error({ err: error }, 'Failed to update user module access');
    return res.status(500).json({ success: false, error: 'Failed to update user module access' });
  }
}
