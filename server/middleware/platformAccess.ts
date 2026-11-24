import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { NextFunction, Request, Response } from 'express';
import { getEffectiveModuleAccess, getMaintenanceSettings } from '../models/platformAccess/functions.js';
import type { PlatformModuleKey } from '../utils/platformModules.js';
import { logger } from '../utils/logger.js';

const MAINTENANCE_EXEMPT_PREFIXES = [
  '/admin',
  '/auth',
  '/subscriptions',
  '/platform/access',
  '/legal',
  '/webhooks',
  '/support-widget/webhook',
];

function isMaintenanceExempt(path: string) {
  if (MAINTENANCE_EXEMPT_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) return true;
  // Provider callbacks/webhooks must remain available so signed events are not lost.
  return /(?:^|\/)webhook(?:s)?(?:\/|$)/i.test(path) || /(?:^|\/)oauth(?:\/|$)/i.test(path);
}

export async function maintenanceModeGate(req: Request, res: Response, next: NextFunction) {
  if (req.method === 'OPTIONS' || isMaintenanceExempt(req.path)) return next();
  try {
    const maintenance = await getMaintenanceSettings();
    if (!maintenance.enabled) return next();
    res.setHeader('Retry-After', '300');
    return res.status(503).json({
      success: false,
      error: maintenance.message,
      code: 'PLATFORM_MAINTENANCE',
      maintenance: true,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to evaluate platform maintenance state');
    // A settings lookup outage must not turn into an accidental platform-wide outage.
    return next();
  }
}

export function requireModuleAccess(moduleKey: PlatformModuleKey) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = businessOwnerUserId(req);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(401).json({ success: false, error: 'Authentication is required' });
      }
      const access = (await getEffectiveModuleAccess(userId)).find((module) => module.key === moduleKey);
      if (access?.enabled) return next();
      const status = access?.status || 'disabled';
      if (status === 'maintenance') res.setHeader('Retry-After', '300');
      return res.status(status === 'maintenance' ? 503 : 403).json({
        success: false,
        error: access?.message || (status === 'maintenance'
          ? `${access?.name || 'This module'} is temporarily under maintenance.`
          : `${access?.name || 'This module'} is not available for this account.`),
        code: status === 'maintenance' ? 'MODULE_MAINTENANCE' : 'MODULE_UNAVAILABLE',
        module: moduleKey,
        status,
      });
    } catch (error) {
      logger.error({ err: error, moduleKey }, 'Failed to evaluate module access');
      return res.status(503).json({
        success: false,
        error: 'Module access could not be verified. Please try again.',
        code: 'MODULE_ACCESS_UNAVAILABLE',
      });
    }
  };
}

export function requireAnyModuleAccess(moduleKeys: PlatformModuleKey[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    try {
      const userId = businessOwnerUserId(req);
      if (!Number.isInteger(userId) || userId <= 0) {
        return res.status(401).json({ success: false, error: 'Authentication is required' });
      }
      const access = await getEffectiveModuleAccess(userId);
      if (access.some((module) => moduleKeys.includes(module.key) && module.enabled)) return next();
      return res.status(403).json({
        success: false,
        error: 'This capability is not available for this account.',
        code: 'MODULE_UNAVAILABLE',
        modules: moduleKeys,
      });
    } catch (error) {
      logger.error({ err: error, moduleKeys }, 'Failed to evaluate shared module access');
      return res.status(503).json({
        success: false,
        error: 'Module access could not be verified. Please try again.',
        code: 'MODULE_ACCESS_UNAVAILABLE',
      });
    }
  };
}
