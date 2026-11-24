import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from "express";
import { StrategyOptionModel } from "../models/strategyOptions/functions";
import { getWorkflowSessionById, updateWorkflowSession } from "../models/workflowSessions/functions";
import { createAgentExecution } from "../models/agentExecutions/functions";
import { logger } from '../utils/logger.js';

// Get strategy recommendations for a workflow
export async function getStrategyRecommendationsHandler(req: Request, res: Response) {
  try {
    const { workflowId } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const workflow = await getWorkflowSessionById(workflowId);
    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }
    if (workflow.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    const strategies = await StrategyOptionModel.findByWorkflowIdForUser(workflowId, userId);
    return res.json(strategies);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error getting strategy recommendations');
    return res.status(500).json({ error: "Unable to retrieve strategies. Please try again." });
  }
}

// Select a strategy option
export async function selectStrategyHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const strategy = await StrategyOptionModel.findByIdForUser(parseInt(id), userId);
    if (!strategy) {
      return res.status(404).json({ error: "Strategy not found" });
    }

    if (!strategy.workflowId) {
      return res.status(400).json({ error: "Strategy not associated with workflow" });
    }

    const workflow = await getWorkflowSessionById(strategy.workflowId);
    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }
    if (workflow.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Determine the next stage based on selected agents
    const agents = (strategy.agents as string[]) || [];
    let nextStage = "icp_building";
    let nextTask = "Building your Ideal Customer Profile...";
    
    if (agents.includes("lead_generation")) {
      nextStage = "icp_building";
      nextTask = "Building your Ideal Customer Profile...";
    } else if (agents.includes("content_studio")) {
      nextStage = "content_creation";
      nextTask = "Generating campaign content assets...";
    } else if (agents.includes("performance_marketing")) {
      nextStage = "campaign_setup";
      nextTask = "Setting up ad campaigns...";
    } else if (agents.includes("outreach")) {
      nextStage = "outreach_setup";
      nextTask = "Preparing outreach sequences...";
    }

    // Update workflow
    await updateWorkflowSession(workflow.id, {
      stage: nextStage,
      progress: 30,
      currentTask: nextTask,
    });

    // Log execution
    await createAgentExecution({
      workflowId: workflow.id,
      threadId: workflow.threadId,
      agentType: "orchestrator",
      action: "strategy_selected",
      input: { strategyId: id, agents },
      output: { nextStage, nextTask },
      status: "success",
      durationMs: 50,
    });

    return res.json({
      message: "Strategy selected successfully",
      workflow: await getWorkflowSessionById(workflow.id),
      nextStage,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error selecting strategy');
    return res.status(500).json({ error: "Unable to select the strategy. Please try again." });
  }
}
