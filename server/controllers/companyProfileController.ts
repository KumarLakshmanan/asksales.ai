import { businessOwnerUserId } from '../tenancy/businessContext.js';
/**
 * Backward-compatible adapters for the former singular company-profile API.
 * Business profiles in `company_settings` are authoritative; these handlers
 * never read or write the retired `company_profiles` model.
 */
import type { Request, Response } from 'express';
import {
  getCompanySettingsById,
  getCompanySettingsByUserId,
} from '../models/companySettings/functions.js';
import {
  createBusinessProfile,
  updateBusinessProfile,
  deleteBusinessProfile,
} from './businessProfilesController.js';
import { logger } from '../utils/logger.js';

function userIdFrom(req: Request): number | undefined {
  return req.user?.id;
}

export async function getCompanyProfileHandler(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid profile ID' });
  try {
    const profile = await getCompanySettingsById(id);
    if (!profile || profile.userId !== userId) return res.status(404).json({ error: 'Company profile not found' });
    return res.json(profile);
  } catch (error) {
    logger.error({ err: error, userId, profileId: id }, 'Error fetching compatibility company profile');
    return res.status(500).json({ error: 'Unable to retrieve the company profile. Please try again.' });
  }
}

export async function getMyCompanyProfileHandler(req: Request, res: Response) {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const profile = await getCompanySettingsByUserId(userId);
    if (!profile) return res.status(404).json({ error: 'Company profile not found' });
    return res.json(profile);
  } catch (error) {
    logger.error({ err: error, userId }, 'Error fetching compatibility company profile');
    return res.status(500).json({ error: 'Unable to retrieve your company profile. Please try again.' });
  }
}

export async function createCompanyProfileHandler(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const existing = await getCompanySettingsByUserId(userId);
  if (existing) return res.status(409).json({ error: 'A company profile already exists; update the default business profile instead' });
  return createBusinessProfile(req, res);
}

export async function updateCompanyProfileHandler(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const existing = await getCompanySettingsByUserId(userId);
  if (!existing) return res.status(404).json({ error: 'Company profile not found' });
  req.params.id = String(existing.id);
  return updateBusinessProfile(req, res);
}

export async function deleteCompanyProfileHandler(req: Request, res: Response) {
  const userId = userIdFrom(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  const existing = await getCompanySettingsByUserId(userId);
  if (!existing) return res.status(404).json({ error: 'Company profile not found' });
  req.params.id = String(existing.id);
  return deleteBusinessProfile(req, res);
}
