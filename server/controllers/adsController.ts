import type { Request, Response } from "express";
import { z } from 'zod';
import { getAd, getAds, getAdsByCampaignId, createAd, updateAd, deleteAd, userOwnsAdCampaign } from "../models/ads/functions";
import { logger } from '../utils/logger.js';
import { parsePositiveId as parseRecordId } from '../utils/paramParsers.js';
import { businessOwnerIdOrNull as getAuthenticatedUserId } from '../utils/businessOwnerId.js';

const adDateSchema = z.union([z.date(), z.string().max(50)]).transform((value, context) => {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
    return z.NEVER;
  }
  return parsed;
});

function decimalMetricSchema(maximum: number) {
  return z.union([
    z.number().finite(),
    z.string().trim().regex(/^\d+(?:\.\d+)?$/, 'Must be a non-negative decimal number'),
  ])
    .transform(Number)
    .refine((value) => value >= 0 && value <= maximum, `Must be between 0 and ${maximum}`)
    .transform(String);
}

const adMutationSchema = z.object({
  campaignId: z.number().int().positive(),
  platform: z.string().trim().min(1).max(50),
  adName: z.string().trim().min(1).max(500),
  status: z.enum(['active', 'paused', 'completed', 'draft']),
  impressions: z.number().int().min(0).max(2_147_483_647).optional(),
  clicks: z.number().int().min(0).max(2_147_483_647).optional(),
  conversions: z.number().int().min(0).max(2_147_483_647).optional(),
  spend: decimalMetricSchema(1_000_000_000).optional(),
  ctr: decimalMetricSchema(100).optional(),
  cpc: decimalMetricSchema(1_000_000).optional(),
  creativeUrl: z.string().url().max(2000).optional().nullable(),
  targeting: z.string().max(100_000).optional().nullable(),
  startDate: adDateSchema,
  endDate: adDateSchema.optional().nullable(),
}).strict();

const updateAdMutationSchema = adMutationSchema.partial().refine(
  (value) => Object.keys(value).length > 0,
  'At least one ad field is required',
);

function sendAdValidationError(res: Response, error: z.ZodError) {
  return res.status(400).json({
    error: 'Validation failed',
    details: error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
  });
}

export async function getAdHandler(req: Request, res: Response) {
  try {
    const userId = getAuthenticatedUserId(req);
    const id = parseRecordId(req.params.id);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!id) return res.status(400).json({ error: "Invalid ad ID" });
    const ad = await getAd(id, userId);
    
    if (!ad) {
      return res.status(404).json({ error: "Ad not found" });
    }
    
    res.json(ad);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching ad');
    res.status(500).json({ error: "Unable to retrieve the ad details. Please try again." });
  }
}

export async function getAdsHandler(req: Request, res: Response) {
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const ads = await getAds(userId);
    res.json(ads);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching ads');
    res.status(500).json({ error: "Unable to retrieve the ads list. Please try again." });
  }
}

export async function getAdsByCampaignHandler(req: Request, res: Response) {
  try {
    const userId = getAuthenticatedUserId(req);
    const campaignId = parseRecordId(req.params.campaignId);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!campaignId) return res.status(400).json({ error: "Invalid campaign ID" });
    const ads = await getAdsByCampaignId(campaignId, userId);
    res.json(ads);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching campaign ads');
    res.status(500).json({ error: "Unable to retrieve ads for this campaign. Please try again." });
  }
}

export async function createAdHandler(req: Request, res: Response) {
  try {
    const userId = getAuthenticatedUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    const parsed = adMutationSchema.safeParse(req.body);
    if (!parsed.success) return sendAdValidationError(res, parsed.error);
    const campaignId = parsed.data.campaignId;
    if (!(await userOwnsAdCampaign(userId, campaignId))) {
      return res.status(404).json({ error: "Campaign not found" });
    }
    const ad = await createAd(parsed.data);

    // Deduct credits for ad creation
    const { creditService } = await import('../services/CreditService.js');
    const deduction = await creditService.deductForEvent({
      userId,
      eventKey: 'ad_creation',
      description: 'Ad created',
      service: 'AdsController',
      referenceType: 'ad',
      referenceId: ad.id.toString(),
    });
    if (!deduction.success) {
      await deleteAd(ad.id, userId);
      return res.status(deduction.error?.toLowerCase().includes('insufficient') ? 402 : 503).json({
        error: deduction.error || 'Unable to charge for ad creation',
        code: 'AD_CREATION_CHARGE_FAILED',
      });
    }

    res.status(201).json(ad);
  } catch (error) {
    logger.error({ err: error }, 'Error creating ad');
    res.status(500).json({ error: "Unable to create the ad. Please try again." });
  }
}

export async function updateAdHandler(req: Request, res: Response) {
  try {
    const userId = getAuthenticatedUserId(req);
    const id = parseRecordId(req.params.id);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!id) return res.status(400).json({ error: "Invalid ad ID" });
    const parsed = updateAdMutationSchema.safeParse(req.body);
    if (!parsed.success) return sendAdValidationError(res, parsed.error);
    if (parsed.data.campaignId !== undefined) {
      const campaignId = parsed.data.campaignId;
      if (!(await userOwnsAdCampaign(userId, campaignId))) {
        return res.status(404).json({ error: "Campaign not found" });
      }
    }
    const ad = await updateAd(id, userId, parsed.data);
    
    if (!ad) {
      return res.status(404).json({ error: "Ad not found" });
    }
    
    res.json(ad);
  } catch (error) {
    logger.error({ err: error }, 'Error updating ad');
    res.status(500).json({ error: "Unable to update the ad. Please try again." });
  }
}

export async function deleteAdHandler(req: Request, res: Response) {
  try {
    const userId = getAuthenticatedUserId(req);
    const id = parseRecordId(req.params.id);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!id) return res.status(400).json({ error: "Invalid ad ID" });
    const deleted = await deleteAd(id, userId);
    if (!deleted) return res.status(404).json({ error: "Ad not found" });
    res.status(204).send();
  } catch (error) {
    logger.error({ err: error }, 'Error deleting ad');
    res.status(500).json({ error: "Unable to delete the ad. Please try again." });
  }
}

/** Compatibility exports only. Mounted legacy URLs already return these 410s.
 * Campaign drafts and reviewed publishing belong to AutonomousAdsService. */
export async function publishCampaignHandler(_req: Request, res: Response) {
  return res.status(410).json({
    error: "This direct provider workflow is retired. Use POST /api/campaigns/autonomous.",
  });
}

export async function saveCampaignDraftHandler(_req: Request, res: Response) {
  return res.status(410).json({
    error: "This draft workflow is retired. Use POST /api/campaigns/autonomous with publish=false.",
  });
}
