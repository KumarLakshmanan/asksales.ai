import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { Request, Response } from "express";
import { getApprovalCheckpointById, getApprovalCheckpointsByWorkflowId, updateApprovalCheckpoint } from "../models/approvalCheckpoints/functions";
import { getWorkflowSessionById, updateWorkflowSession } from "../models/workflowSessions/functions";
import { createAgentExecution } from "../models/agentExecutions/functions";
import { logger } from '../utils/logger.js';
import {
  persistAndBroadcastChatMessage,
  persistAndBroadcastLeadWorkflowApproval,
} from '../services/leadWorkflowApprovalMessage.js';

// Get approval checkpoints for workflow
export async function getApprovalsHandler(req: Request, res: Response) {
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

    const approvals = await getApprovalCheckpointsByWorkflowId(workflowId);
    return res.json(approvals);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error getting approvals');
    return res.status(500).json({ error: "Unable to retrieve approvals. Please try again." });
  }
}

// Approve checkpoint
export async function approveCheckpointHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const checkpoint = await getApprovalCheckpointById(id);
    if (!checkpoint) {
      return res.status(404).json({ error: "Checkpoint not found" });
    }

    const workflow = await getWorkflowSessionById(checkpoint.workflowId);
    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }
    if (workflow.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Update checkpoint
    await updateApprovalCheckpoint(id, {
      status: "approved",
      userDecision: "approved",
    });

    // Determine next stage based on approval type
    let nextStage = "executing";
    let nextTask = "Proceeding with execution...";

    if (checkpoint.approvalType === "icp") {
      nextStage = "executing";
      nextTask = "Starting lead scraping...";
    }

    // Update workflow
    await updateWorkflowSession(checkpoint.workflowId, {
      stage: nextStage,
      progress: 50,
      currentTask: nextTask,
    });

    // Log execution
    await createAgentExecution({
      workflowId: checkpoint.workflowId,
      threadId: workflow.threadId,
      agentType: "orchestrator",
      action: "checkpoint_approved",
      input: { actorUserId: req.user!.id, checkpointId: id, approvalType: checkpoint.approvalType },
      output: { nextStage },
      status: "success",
      durationMs: 50,
    });

    return res.json({
      message: "Checkpoint approved",
      workflow: await getWorkflowSessionById(checkpoint.workflowId),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error approving checkpoint');
    return res.status(500).json({ error: "Unable to approve the checkpoint. Please try again." });
  }
}

// Reject checkpoint
export async function rejectCheckpointHandler(req: Request, res: Response) {
  try {
    const { id } = req.params;
    const { reason } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);

    const checkpoint = await getApprovalCheckpointById(id);
    if (!checkpoint) {
      return res.status(404).json({ error: "Checkpoint not found" });
    }

    const workflow = await getWorkflowSessionById(checkpoint.workflowId);
    if (!workflow) {
      return res.status(404).json({ error: "Workflow not found" });
    }
    if (workflow.userId !== userId) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    // Update checkpoint
    await updateApprovalCheckpoint(id, {
      status: "rejected",
      userDecision: "rejected",
    });

    // Update workflow
    await updateWorkflowSession(checkpoint.workflowId, {
      stage: "strategy_selection",
      progress: 25,
      currentTask: "Review and modify strategy",
      error: reason || "User rejected checkpoint",
    });

    // Log execution
    await createAgentExecution({
      workflowId: checkpoint.workflowId,
      threadId: workflow.threadId,
      agentType: "orchestrator",
      action: "checkpoint_rejected",
      input: { actorUserId: req.user!.id, checkpointId: id, reason },
      output: { backToSelection: true },
      status: "rejected",
      durationMs: 50,
    });

    return res.json({
      message: "Checkpoint rejected",
      workflow: await getWorkflowSessionById(checkpoint.workflowId),
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error rejecting checkpoint');
    return res.status(500).json({ error: "Unable to reject the checkpoint. Please try again." });
  }
}

/**
 * Execute lead workflow with selected workflows
 * This is called directly from the frontend when user approves lead generation with specific workflows
 */
export async function executeLeadWorkflowHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    const { threadId, workflowIds, platforms, subWorkflowIds } = req.body;
    
    if (!threadId) {
      return res.status(400).json({ error: "threadId is required" });
    }
    
    // Accept either workflowIds (split workflow names) or platforms (platform names)
    let hasWorkflows = workflowIds && Array.isArray(workflowIds) && workflowIds.length > 0;
    let hasPlatforms = platforms && Array.isArray(platforms) && platforms.length > 0;
    let hasSubWorkflows = subWorkflowIds && Array.isArray(subWorkflowIds) && subWorkflowIds.length > 0;
    
    if (!hasWorkflows && !hasPlatforms) {
      // Auto-fetch platforms from existing lead inputs in DB
      try {
        const { getLatestLeadInputsByThreadId } = await import("../models/leadInputs/functions");
        const dbLeadInputs = await getLatestLeadInputsByThreadId(parseInt(threadId));
        if (dbLeadInputs && dbLeadInputs.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dbPlatforms = dbLeadInputs.map((input: any) => input.platform).filter(Boolean);
          // Collect workflowIds from DB inputs — these are now workflow filenames (e.g., "linkedin_company_search")
          const dbWorkflowIds: string[] = dbLeadInputs
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            .map((input: any) => input.workflowId || input.platform)
            .filter(Boolean);
          if (dbPlatforms.length > 0) {
            req.body.platforms = dbPlatforms;
            // Use workflowIds (which are workflow filenames) for the selected_workflows path
            if (dbWorkflowIds.length > 0) {
              req.body.workflowIds = dbWorkflowIds;
            }
            // Also collect recommended sub-workflows from DB inputs
            const dbSubWorkflowIds: string[] = [];
            for (const input of dbLeadInputs) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const recs = (input as any).recommendedSubWorkflows;
              if (recs && Array.isArray(recs) && recs.length > 0) {
                dbSubWorkflowIds.push(...recs);
              }
            }
            if (dbSubWorkflowIds.length > 0) {
              req.body.subWorkflowIds = dbSubWorkflowIds;
            }
          } else {
            return res.status(400).json({ error: "No lead inputs found for this thread. Please generate lead inputs first." });
          }
        } else {
          return res.status(400).json({ error: "No lead inputs found for this thread. Please generate lead inputs first." });
        }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (fetchErr: any) {
        logger.error({ err: fetchErr }, 'Error fetching lead inputs from DB');
        return res.status(400).json({ error: "Either workflowIds or platforms array is required" });
      }
    }
    
    // Re-evaluate after potential auto-fetch
    hasWorkflows = req.body.workflowIds && Array.isArray(req.body.workflowIds) && req.body.workflowIds.length > 0;
    hasPlatforms = req.body.platforms && Array.isArray(req.body.platforms) && req.body.platforms.length > 0;
    hasSubWorkflows = req.body.subWorkflowIds && Array.isArray(req.body.subWorkflowIds) && req.body.subWorkflowIds.length > 0;
    const resolvedWorkflowIds = (req.body.workflowIds || []) as string[];
    const resolvedPlatforms = (req.body.platforms || []) as string[];
    const resolvedSubWorkflowIds = (req.body.subWorkflowIds || []) as string[];
    
    // Import required functions
    const { executeLeadWorkflow } = await import("../mastra/tools/executors/leadExecutor.js");
    const { getIcpProfilesByUserId } = await import("../models/icpData/functions");
    const { getBrandToolkitsByUserId } = await import("../models/brandToolkits/functions");
    const { createChatMessage } = await import("../models/chatMessages/functions");
    const { webSocketEmitter } = await import("../services/agents/WebSocketEmitter");
    
    // Get ICP and Brand Toolkit
    const icpProfiles = await getIcpProfilesByUserId(userId);
    const icpProfile = icpProfiles?.[0] || null;
    const brandToolkits = await getBrandToolkitsByUserId(userId);
    const brandToolkit = brandToolkits?.[0] || null;
    
    // Build names for user message
    const displayNames = hasWorkflows
      ? resolvedWorkflowIds.map((id: string) => id.replace(/_/g, ' ').replace(/workflow/gi, '').trim()).join(', ')
      : (() => {
          const platformCounts: Record<string, number> = {};
          for (const p of resolvedPlatforms) {
            platformCounts[p] = (platformCounts[p] || 0) + 1;
          }
          return Object.entries(platformCounts)
            .map(([p, count]) => count > 1 ? `${p.replace(/_/g, ' ')} (${count} searches)` : p.replace(/_/g, ' '))
            .join(', ') || 'configured platforms';
        })();
    
    // Create user message in chat
    const userMessageContent = `Approved. Starting lead generation on: ${displayNames}`;
    await persistAndBroadcastLeadWorkflowApproval(
      userId,
      parseInt(threadId),
      userMessageContent,
      {
        persist: createChatMessage,
        emit: (targetUserId, targetThreadId, message) => {
          webSocketEmitter.emitChatMessage(targetUserId, targetThreadId, message);
        },
      },
    );
    
    // Prepare tool context
    // Platform names are now workflow filenames (e.g., "linkedin_company_search"), so they can
    // be used directly as selected_workflows for the specific workflow execution path.
    // Sub-workflow IDs take priority when available.
    const effectiveWorkflows = hasWorkflows
      ? resolvedWorkflowIds
      : (hasSubWorkflows ? resolvedSubWorkflowIds : (hasPlatforms ? resolvedPlatforms : []));
    const effectivePlatforms = hasPlatforms ? resolvedPlatforms : undefined;
    const toolContext = {
      userId,
      threadId: parseInt(threadId),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      icpProfile: icpProfile as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      brandToolkit: brandToolkit as any,
      selectedWorkflows: effectiveWorkflows,
    };
    
    // Execute the workflow
    const result = await executeLeadWorkflow(
      { 
        thread_id: parseInt(threadId), 
        selected_workflows: effectiveWorkflows,
        platforms: effectivePlatforms,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
      toolContext
    );
    
    // Create assistant response message
    const resultMessage = result.output?.message || result.error;
    const assistantMessage = result.success
      ? `Lead generation completed! ${resultMessage || `Found ${result.output?.totalLeads || 0} leads.`}`
      : resultMessage || 'Lead generation failed before any leads were saved.';

    await persistAndBroadcastChatMessage(
      userId,
      parseInt(threadId),
      {
        role: 'assistant',
        content: assistantMessage,
        agentType: 'lead_generation',
      },
      {
        persist: createChatMessage,
        emit: (targetUserId, targetThreadId, message) => {
          webSocketEmitter.emitChatMessage(targetUserId, targetThreadId, message);
        },
      },
    );
    
    return res.json({
      success: result.success,
      message: assistantMessage,
      results: result.output,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Error executing lead workflow');
    return res.status(500).json({ error: "Unable to execute the lead workflow. Please try again." });
  }
}
