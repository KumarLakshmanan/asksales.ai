import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from "express";
import { logger } from '../utils/logger.js';
import { createWorkflowSession, getWorkflowSessionById, getWorkflowSessionsByUserId, updateWorkflowSession } from "../models/workflowSessions/functions";
import { StrategyOptionModel } from "../models/strategyOptions/functions";
import { createAgentExecution } from "../models/agentExecutions/functions";

// Analyze marketing goal and generate strategy options
export async function analyzeGoalHandler(req: Request, res: Response) {
  try {
    const { goal, threadId } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    if (!goal || typeof goal !== "string") {
      return res.status(400).json({ error: "Goal is required" });
    }

    // Create workflow session
    const workflow = await createWorkflowSession({
      userId,
      userPrompt: goal,
      stage: "analyzing",
      progress: 10,
      currentTask: "Analyzing your marketing goal...",
      threadId: threadId,
    });

    // Log agent execution
    await createAgentExecution({
      workflowId: workflow.id,
      threadId: workflow.threadId,
      agentType: "orchestrator",
      action: "analyze_goal",
      input: { goal },
      output: { workflowId: workflow.id },
      status: "success",
      durationMs: 100,
    });

    // Generate strategy options (in real app, use AI/NLP)
    const strategies = [
      {
        workflowId: workflow.id,
        title: "Build Lead Database First",
        description: "500+ qualified B2B leads",
        expectedOutcome: "Long-term asset building, Owned audience, Lower acquisition cost",
        agents: ["lead_generation"],
        estimatedTime: "8 minutes",
        successRate: 92,
        expectedImpact: "Very High",
        benefits: ["Long-term asset building", "Owned audience", "Lower acquisition cost"],
        recommended: true,
      },
      {
        workflowId: workflow.id,
        title: "Create Viral Content First",
        description: "Videos, graphics, viral copy",
        expectedOutcome: "Foundation for all campaigns, Highest engagement, Reusable assets",
        agents: ["content_studio"],
        estimatedTime: "5-10 minutes",
        successRate: 88,
        expectedImpact: "High",
        benefits: ["Foundation for all campaigns", "Highest engagement", "Reusable across channels"],
        recommended: false,
      },
      {
        workflowId: workflow.id,
        title: "Launch Paid Ads Campaign",
        description: "Meta & Google campaigns",
        expectedOutcome: "Instant reach amplification, Precise targeting, Measurable ROI",
        agents: ["performance_marketing"],
        estimatedTime: "3-6 minutes",
        successRate: 85,
        expectedImpact: "High",
        benefits: ["Instant reach amplification", "Precise audience targeting", "Measurable ROI"],
        recommended: false,
      },
      {
        workflowId: workflow.id,
        title: "Influencer Outreach Campaign",
        description: "Partner with micro-influencers",
        expectedOutcome: "Authentic social proof, Expanded reach, Community building",
        agents: ["outreach"],
        estimatedTime: "6-8 minutes",
        successRate: 76,
        expectedImpact: "Medium",
        benefits: ["Authentic social proof", "Expanded reach", "Community building"],
        recommended: false,
      },
    ];

    // Save strategies
    const savedStrategies = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      strategies.map((strategy) => StrategyOptionModel.createForUser(userId, strategy as any))
    );

    // Update workflow stage
    await updateWorkflowSession(workflow.id, {
      stage: "strategy_selection",
      progress: 25,
      currentTask: "Review strategy options",
    });

    return res.json({
      workflowId: workflow.id,
      strategies: savedStrategies,
      message: "Strategy options generated successfully",
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error analyzing goal');
    return res.status(500).json({ error: "Unable to analyze the goal. Please try again." });
  }
}

// Get workflow session by ID
export async function getWorkflowHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const workflow = await getWorkflowSessionById(id);

    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }

    if (workflow.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    return res.json(workflow);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error getting workflow');
    return res.status(500).json({ error: "Unable to retrieve the workflow. Please try again." });
  }
}

// Get all workflows for current user
export async function getWorkflowsHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const workflows = await getWorkflowSessionsByUserId(userId);
    return res.json(workflows);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error getting workflows');
    return res.status(500).json({ error: "Unable to retrieve workflows. Please try again." });
  }
}
