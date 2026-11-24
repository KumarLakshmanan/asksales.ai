import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from "express";
import { logger } from '../utils/logger.js';
import { 
  createMultipleScrapingProgress, 
  getScrapingProgressByWorkflowId, 
  updateScrapingProgressByWorkflowAndChannel 
} from "../models/scrapingProgress/functions";
import { getWorkflowSessionById, updateWorkflowSession } from "../models/workflowSessions/functions";
import { createAgentExecution } from "../models/agentExecutions/functions";
import { getIcpDataByWorkflowId } from "../models/icpData/functions";

// Start scraping for a workflow
export async function startScrapingHandler(req: Request, res: Response) {
  try {
    const { workflowId } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const workflow = await getWorkflowSessionById(workflowId);
    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }
    if (workflow.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Get ICP to determine B2B or B2C
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const icp = await getIcpDataByWorkflowId(workflowId);
    const isB2B = true; // In real app, analyze ICP data

    // Initialize channels based on B2B/B2C
    const channels = isB2B
      ? [
          { workflowId, channelName: "LinkedIn", status: "pending", progress: 0, leadsFound: 0, estimatedLeads: 250 },
          { workflowId, channelName: "Google Maps", status: "pending", progress: 0, leadsFound: 0, estimatedLeads: 150 },
          { workflowId, channelName: "JustDial", status: "pending", progress: 0, leadsFound: 0, estimatedLeads: 100 },
        ]
      : [
          { workflowId, channelName: "Instagram", status: "pending", progress: 0, leadsFound: 0, estimatedLeads: 180 },
          { workflowId, channelName: "Facebook", status: "pending", progress: 0, leadsFound: 0, estimatedLeads: 170 },
          { workflowId, channelName: "Twitter", status: "pending", progress: 0, leadsFound: 0, estimatedLeads: 120 },
        ];

    // Create scraping progress records
    const progress = await createMultipleScrapingProgress(channels);

    // Log execution
    await createAgentExecution({
      workflowId,
      threadId: workflow.threadId,
      agentType: "lead_generation",
      action: "start_scraping",
      input: { channels: channels.map(c => c.channelName) },
      output: { progressIds: progress.map(p => p.id) },
      status: "in_progress",
      durationMs: 100,
    });

    return res.json({
      message: "Scraping started",
      progress,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error starting scraping');
    return res.status(500).json({ error: "Unable to start the scraping job. Please try again." });
  }
}

// Get scraping progress for workflow
export async function getScrapingProgressHandler(req: Request, res: Response) {
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

    const progress = await getScrapingProgressByWorkflowId(workflowId);
    return res.json(progress);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error getting scraping progress');
    return res.status(500).json({ error: "Unable to retrieve scraping progress. Please try again." });
  }
}

// Update scraping progress (for simulation/real updates)
export async function updateScrapingProgressHandler(req: Request, res: Response) {
  try {
    const { workflowId, channelName, progress: progressValue, leadsFound, status } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const workflow = await getWorkflowSessionById(workflowId);
    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }
    if (workflow.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Update progress
    const updated = await updateScrapingProgressByWorkflowAndChannel(workflowId, channelName, {
      progress: progressValue,
      leadsFound,
      status,
    });

    // Check if all channels completed
    const allProgress = await getScrapingProgressByWorkflowId(workflowId);
    const allCompleted = allProgress.every(p => p.status === "completed");

    if (allCompleted) {
      const totalLeads = allProgress.reduce((sum, p) => sum + (p.leadsFound || 0), 0);
      
      await updateWorkflowSession(workflowId, {
        stage: "completed",
        progress: 100,
        currentTask: `Lead generation complete - ${totalLeads} leads found`,
      });

      await createAgentExecution({
        workflowId,
        threadId: workflow.threadId,
        agentType: "lead_generation",
        action: "scraping_completed",
        input: { channels: allProgress.length },
        output: { totalLeads },
        status: "success",
        durationMs: 300000, // ~5 minutes
      });
    }

    return res.json({
      message: "Progress updated",
      progress: updated,
      allCompleted,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error updating scraping progress');
    return res.status(500).json({ error: "Unable to update scraping progress. Please try again." });
  }
}
