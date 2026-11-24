import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Request, Response } from "express";
import { parseIdParam } from '../utils/paramParsers.js';
import { ContentAssetPreviewModel } from "../models/contentAssetPreviews/functions";
import { InsertContentAssetPreview } from "../models/contentAssetPreviews/schema";
import { LeadModel } from "../models/leads/functions";
import { logger } from '../utils/logger.js';

export const getContentAssetPreviews = async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const leadId = typeof req.query.leadId === 'string' ? Number(req.query.leadId) : undefined;
    if (leadId !== undefined && (!Number.isInteger(leadId) || leadId <= 0)) {
      return res.status(400).json({ error: 'Invalid lead ID' });
    }

    const previews = leadId
      ? await ContentAssetPreviewModel.findByLeadIdForUser(leadId, userId)
      : await ContentAssetPreviewModel.findAllForUser(userId);
    res.json(previews);
  } catch (error) {
    logger.error({ err: error }, '[contentAssetPreviewController] Error fetching content asset previews');
    res.status(500).json({ error: "Unable to retrieve content asset previews. Please try again." });
  }
};

export const createContentAssetPreview = async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const lead = await LeadModel.findByIdForUser(req.body.leadId, userId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const canonicalLeadName = lead.fullName
      || lead.name
      || [lead.firstName, lead.lastName].filter(Boolean).join(' ')
      || `Lead #${lead.id}`;
    const previewData: Omit<InsertContentAssetPreview, 'id' | 'userId' | 'createdAt'> = {
      type: req.body.type,
      message: req.body.message,
      imageUrl: req.body.imageUrl,
      videoUrl: req.body.videoUrl,
      channel: req.body.channel,
      leadId: lead.id,
      leadName: canonicalLeadName,
      status: req.body.status,
    };
    const preview = await ContentAssetPreviewModel.createForUser(userId, previewData);
    res.status(201).json(preview);
  } catch (error) {
    logger.error({ err: error }, '[contentAssetPreviewController] Error creating content asset preview');
    res.status(500).json({ error: "Unable to create the content asset preview. Please try again." });
  }
};

export const updateContentAssetPreview = async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Authentication required' });

    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid ID' });
    const previewData: Partial<Omit<InsertContentAssetPreview, 'id' | 'userId' | 'leadId' | 'leadName' | 'createdAt'>> = {
      ...(req.body.type !== undefined && { type: req.body.type }),
      ...(req.body.message !== undefined && { message: req.body.message }),
      ...(req.body.imageUrl !== undefined && { imageUrl: req.body.imageUrl }),
      ...(req.body.videoUrl !== undefined && { videoUrl: req.body.videoUrl }),
      ...(req.body.channel !== undefined && { channel: req.body.channel }),
      ...(req.body.status !== undefined && { status: req.body.status }),
    };
    const preview = await ContentAssetPreviewModel.updateForUser(id, userId, previewData);
    if (!preview) {
      return res.status(404).json({ error: "Content asset preview not found" });
    }
    res.json(preview);
  } catch (error) {
    logger.error({ err: error }, '[contentAssetPreviewController] Error updating content asset preview');
    res.status(500).json({ error: "Unable to update the content asset preview. Please try again." });
  }
};
