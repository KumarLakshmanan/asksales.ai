import { Request, Response } from "express";
import { LeadGenCampaignModel } from "../models/leadGenCampaigns/functions";
import { InsertLeadGenCampaign } from "../models/leadGenCampaigns/schema";
import { logger } from '../utils/logger.js';

export const getLeadGenCampaigns = async (req: Request, res: Response) => {
  try {
    const campaigns = await LeadGenCampaignModel.findAll();
    res.json(campaigns);
  } catch (error) {
    logger.error({ err: error }, '[leadGenCampaignController] Error fetching lead gen campaigns');
    res.status(500).json({ error: "Unable to retrieve lead generation campaigns. Please try again." });
  }
};

export const getLeadGenCampaign = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const campaign = await LeadGenCampaignModel.findById(id);
    if (!campaign) {
      return res.status(404).json({ error: "Lead gen campaign not found" });
    }
    res.json(campaign);
  } catch (error) {
    logger.error({ err: error }, '[leadGenCampaignController] Error fetching lead gen campaign');
    res.status(500).json({ error: "Unable to retrieve the lead generation campaign. Please try again." });
  }
};

export const createLeadGenCampaign = async (req: Request, res: Response) => {
  try {
    const campaignData: InsertLeadGenCampaign = req.body;
    const campaign = await LeadGenCampaignModel.create(campaignData);
    res.status(201).json(campaign);
  } catch (error) {
    logger.error({ err: error }, '[leadGenCampaignController] Error creating lead gen campaign');
    res.status(500).json({ error: "Unable to create the lead generation campaign. Please try again." });
  }
};

export const updateLeadGenCampaign = async (req: Request, res: Response) => {
  try {
    const id = parseInt(req.params.id);
    const campaignData: Partial<InsertLeadGenCampaign> = req.body;
    const campaign = await LeadGenCampaignModel.update(id, campaignData);
    if (!campaign) {
      return res.status(404).json({ error: "Lead gen campaign not found" });
    }
    res.json(campaign);
  } catch (error) {
    logger.error({ err: error }, '[leadGenCampaignController] Error updating lead gen campaign');
    res.status(500).json({ error: "Unable to update the lead generation campaign. Please try again." });
  }
};