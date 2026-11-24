import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { Request, Response } from "express";
import { StrategyOptionModel } from "../models/strategyOptions/functions";
import { InsertStrategyOption } from "../models/strategyOptions/schema";
import { logger } from '../utils/logger.js';

export const getStrategyOptions = async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const options = await StrategyOptionModel.findAllForUser(userId);
    res.json(options);
  } catch (error) {
    logger.error({ err: error }, '[strategyOptionController] Error fetching strategy options');
    res.status(500).json({ error: "Unable to retrieve strategy options. Please try again." });
  }
};

export const createStrategyOption = async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const optionData = pickStrategyOptionData(req.body);
    if (!optionData.workflowId) {
      return res.status(400).json({ error: "workflowId is required" });
    }

    const option = await StrategyOptionModel.createForUser(userId, optionData as InsertStrategyOption);
    if (!option) return res.status(404).json({ error: "Workflow not found" });
    res.status(201).json(option);
  } catch (error) {
    logger.error({ err: error }, '[strategyOptionController] Error creating strategy option');
    res.status(500).json({ error: "Unable to create the strategy option. Please try again." });
  }
};

export const updateStrategyOption = async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });

    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Invalid strategy option ID" });
    }

    const optionData = pickStrategyOptionData(req.body);
    const option = await StrategyOptionModel.updateForUser(id, userId, optionData);
    if (!option) {
      return res.status(404).json({ error: "Strategy option not found" });
    }
    res.json(option);
  } catch (error) {
    logger.error({ err: error }, '[strategyOptionController] Error updating strategy option');
    res.status(500).json({ error: "Unable to update the strategy option. Please try again." });
  }
};

function pickStrategyOptionData(value: unknown): Partial<InsertStrategyOption> {
  if (!value || typeof value !== "object") return {};
  const input = value as Record<string, unknown>;
  const allowed = [
    "workflowId",
    "title",
    "description",
    "expectedOutcome",
    "agents",
    "estimatedTime",
    "successRate",
    "expectedImpact",
    "benefits",
    "recommended",
  ] as const;
  const output: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(input, key)) output[key] = input[key];
  }
  return output as Partial<InsertStrategyOption>;
}
