import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Request, Response } from "express";
import { SentMessageModel } from "../models/sentMessages/functions";
import { logger } from '../utils/logger.js';

import { isFollowUpChannel } from '../../shared/followUpChannels.js';

export const getSentMessages = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    if (req.query.followUps === 'true') {
      const channel = String(req.query.channel || '').toLowerCase();
      if (!isFollowUpChannel(channel)) {
        return res.status(400).json({ error: 'A supported channel is required for follow-up activity' });
      }
      const followUps = await SentMessageModel.findRecentFollowUpsByUser(userId, channel, limit, offset);
      return res.json(followUps);
    }
    const messages = await SentMessageModel.findRecentByUser(userId, limit, offset);
    res.json(messages);
  } catch (error) {
    logger.error({ err: error }, '[sentMessageController] Error fetching sent messages');
    res.status(500).json({ error: "Unable to retrieve sent messages. Please try again." });
  }
};

export const getSentMessagesByLeadId = async (req: Request, res: Response) => {
  try {
    const leadId = parseInt(req.params.leadId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ message: "Authentication required" });
    if (!Number.isInteger(leadId) || leadId <= 0) {
      return res.status(400).json({ message: "A valid lead ID is required" });
    }
    const messages = await SentMessageModel.findByLeadId(leadId, userId);
    res.json(messages);
  } catch (error) {
    logger.error({ err: error }, '[sentMessageController] Error fetching sent messages by lead');
    res.status(500).json({ error: "Unable to retrieve sent messages for this lead. Please try again." });
  }
};
