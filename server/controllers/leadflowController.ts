import { randomUUID } from 'node:crypto';
import { businessOwnerUserId, currentBusinessScope, currentDatabaseScope, requireBusinessScope } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { Request, Response } from "express";
import { parseIdParam } from '../utils/paramParsers.js';
import { logger } from '../utils/logger.js';
import { getWorkflowById, getWorkflowExecutionById, getWorkflowExecutions, getUserWorkflowExecutions } from "../models/workflows/queries";
import { WorkflowExecutorService } from "../services/WorkflowExecutorService";
import { promises as fsPromises } from "fs";
import path from "path";

function isPlatformAdministrator(req: Request): boolean {
  return currentDatabaseScope()?.kind === 'system' && ['admin', 'super_admin'].includes(req.user?.role || '');
}

function workflowDirectory(req: Request): string {
  const root = path.join(process.cwd(), 'data/workflows');
  if (isPlatformAdministrator(req)) return root;
  const scope = requireBusinessScope();
  businessOwnerUserId(req); // also verifies the actual authenticated actor
  return path.join(root, 'tenants', String(scope.businessProfileId));
}

function ownsWorkflow(req: Request, workflow: { userId?: number; businessProfileId?: number }): boolean {
  if (isPlatformAdministrator(req)) return !workflow.userId;
  const scope = currentBusinessScope();
  return Boolean(scope && workflow.userId === scope.userId && workflow.businessProfileId === scope.businessProfileId);
}

async function dirExists(dir: string): Promise<boolean> {
  try {
    await fsPromises.access(dir);
    return true;
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function readJsonFilesFromDir(dir: string): Promise<Array<{ file: string; data: any }>> {
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const results: Array<{ file: string; data: any }> = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".json")) {
      const filePath = path.join(dir, entry.name);
      const content = await fsPromises.readFile(filePath, "utf-8");
      results.push({ file: entry.name, data: JSON.parse(content) });
    }
  }
  return results;
}

async function findWorkflowFile(workflowsDir: string, workflowId: string): Promise<string | null> {
  if (!(await dirExists(workflowsDir))) return null;
  const entries = await fsPromises.readdir(workflowsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(workflowsDir, entry.name);
    const content = await fsPromises.readFile(filePath, "utf-8");
    const workflow = JSON.parse(content);
    if (workflow.workflow_id === workflowId) return filePath;
  }
  return null;
}

// Workflow CRUD operations
export async function createWorkflowHandler(req: Request, res: Response) {
  try {
    const { name, description, nodes, edges, mappings } = req.body;

    if (typeof name !== 'string' || !name.trim() || name.length > 200 || !Array.isArray(nodes) || !Array.isArray(edges)) {
      return res.status(400).json({ message: "Missing required fields" });
    }

    // Generate workflow ID and filename
    const workflowId = `custom_${randomUUID()}`;
    const fileName = `${workflowId}.json`;
    
    // Strip full schema objects from actor nodes — only keep actorId reference
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sanitizedNodes = nodes.map((n: any) => {
      if (n.type === 'actor' && n.data?.schema) {
        const { schema, ...restData } = n.data;
        return { ...n, data: { ...restData, actorId: schema?.id || restData.actorId } };
      }
      return n;
    });
    
    // Save to data/workflows directory
    const workflowsDir = workflowDirectory(req);
    
    // Ensure directory exists
    if (!(await dirExists(workflowsDir))) {
      await fsPromises.mkdir(workflowsDir, { recursive: true });
    }

    const workflowFilePath = path.join(workflowsDir, fileName);
    
    const workflowData = {
      workflow_id: workflowId,
      title: name,
      description: description || '',
      platform: 'custom',
      nodes: sanitizedNodes,
      edges,
      mappings: mappings || [],
      userId: isPlatformAdministrator(req) ? undefined : businessOwnerUserId(req),
      businessProfileId: currentBusinessScope()?.businessProfileId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    // Write to file
    await fsPromises.writeFile(workflowFilePath, JSON.stringify(workflowData, null, 2), { flag: 'wx', mode: 0o600 });

    res.status(201).json({ 
      workflow: {
        id: workflowId,
        name,
        description,
        nodes: sanitizedNodes,
        edges,
        mappings,
        fileName,
        filePath: `/workflows/${fileName}`,
      }
    });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, 'Create workflow error');
    res.status(500).json({ message: "Unable to create the workflow. Please try again." });
  }
}

export async function getWorkflowHandler(req: Request, res: Response) {
  try {
    const file = await findWorkflowFile(workflowDirectory(req), req.params.id);
    if (file) {
      const workflow = JSON.parse(await fsPromises.readFile(file, 'utf8'));
      if (!ownsWorkflow(req, workflow)) return res.status(404).json({ message: 'Workflow not found' });
      return res.json({ workflow: { ...workflow, id: workflow.workflow_id, name: workflow.title } });
    }
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ message: 'Invalid workflow ID' });
    const workflow = await getWorkflowById(id);

    if (!workflow) {
      return res.status(404).json({ message: "Workflow not found" });
    }

    res.json({ workflow });
  } catch (error) {
    logger.error({ err: error }, 'Get workflow error');
    res.status(500).json({ message: "Unable to retrieve the workflow. Please try again." });
  }
}

export async function getUserWorkflowsHandler(req: Request, res: Response) {
  try {
    const workflowsDir = workflowDirectory(req);
    
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workflows: any[] = [];

    if (await dirExists(workflowsDir)) {
      const files = await readJsonFilesFromDir(workflowsDir);

      for (const { file, data: workflow } of files) {
        try {
          // Include workflows created by this user or platform workflows
          if (ownsWorkflow(req, workflow)) {
            workflows.push({
              id: workflow.workflow_id,
              name: workflow.title,
              description: workflow.description,
              platform: workflow.platform,
              nodes: workflow.nodes,
              edges: workflow.edges,
              mappings: workflow.mappings || [],
              fileName: file,
              createdAt: workflow.createdAt,
              updatedAt: workflow.updatedAt,
            });
          }
        } catch (err) {
          logger.error({ err, file }, 'Error parsing workflow file');
        }
      }
    }

    res.json({ workflows });
  } catch (error) {
    logger.error({ err: error }, 'Get user workflows error');
    res.status(500).json({ message: "Unable to retrieve your workflows. Please try again." });
  }
}

export async function updateWorkflowHandler(req: Request, res: Response) {
  try {
    const workflowId = req.params.id;
    const { name, description, nodes, edges, mappings } = req.body;

    // Find and update the workflow file
    const workflowsDir = workflowDirectory(req);
    
    if (!(await dirExists(workflowsDir))) {
      return res.status(404).json({ message: "Workflow not found" });
    }

    const files = await readJsonFilesFromDir(workflowsDir);
    let workflowFilePath: string | null = null;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let existingWorkflow: any = null;

    for (const { file, data: workflow } of files) {
      if (workflow.workflow_id === workflowId && ownsWorkflow(req, workflow)) {
        workflowFilePath = path.join(workflowsDir, file);
        existingWorkflow = workflow;
        break;
      }
    }

    if (!workflowFilePath || !existingWorkflow) {
      return res.status(404).json({ message: "Workflow not found" });
    }

    // Update workflow data
    const sanitizedNodes = nodes
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ? nodes.map((n: any) => {
          if (n.type === 'actor' && n.data?.schema) {
            const { schema, ...restData } = n.data;
            return { ...n, data: { ...restData, actorId: schema?.id || restData.actorId } };
          }
          return n;
        })
      : existingWorkflow.nodes;

    const updatedWorkflow = {
      ...existingWorkflow,
      title: name || existingWorkflow.title,
      description: description || existingWorkflow.description,
      nodes: sanitizedNodes,
      edges: edges ?? existingWorkflow.edges,
      mappings: mappings || existingWorkflow.mappings || [],
      updatedAt: new Date().toISOString(),
    };

    // Write updated workflow to file
    const temporaryPath = `${workflowFilePath}.${randomUUID()}.tmp`;
    try {
      await fsPromises.writeFile(temporaryPath, JSON.stringify(updatedWorkflow, null, 2), { flag: 'wx', mode: 0o600 });
      await fsPromises.rename(temporaryPath, workflowFilePath);
    } finally {
      await fsPromises.unlink(temporaryPath).catch(() => undefined);
    }

    res.json({ 
      workflow: {
        id: updatedWorkflow.workflow_id,
        name: updatedWorkflow.title,
        description: updatedWorkflow.description,
        nodes: updatedWorkflow.nodes,
        edges: updatedWorkflow.edges,
        mappings: updatedWorkflow.mappings,
      }
    });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, 'Update workflow error');
    res.status(500).json({ message: "Unable to update the workflow. Please try again." });
  }
}

export async function deleteWorkflowHandler(req: Request, res: Response) {
  try {
    const workflowId = req.params.id;

    // Find and delete the workflow file
    const workflowsDir = workflowDirectory(req);
    
    if (!(await dirExists(workflowsDir))) {
      return res.status(404).json({ message: "Workflow not found" });
    }

    const files = await readJsonFilesFromDir(workflowsDir);
    let workflowFilePath: string | null = null;

    for (const { file, data: workflow } of files) {
      if (workflow.workflow_id === workflowId && ownsWorkflow(req, workflow)) {
        workflowFilePath = path.join(workflowsDir, file);
        break;
      }
    }

    if (!workflowFilePath) {
      return res.status(404).json({ message: "Workflow not found" });
    }

    // Delete the file
    await fsPromises.unlink(workflowFilePath);

    res.json({ message: "Workflow deleted successfully" });
  } catch (error) {
    logger.error({ err: error }, 'Delete workflow error');
    res.status(500).json({ message: "Unable to delete the workflow. Please try again." });
  }
}

// Workflow Execution operations
export async function executeWorkflowHandler(_req: Request, res: Response) {
  return res.status(410).json({
    code: 'WORKFLOW_APPROVAL_REQUIRED',
    message: 'Run lead workflows through the conversation approval flow.',
  });
}

export async function getExecutionHandler(req: Request, res: Response) {
  try {
    const id = parseIdParam(req.params.id);
    if (!id) return res.status(400).json({ message: 'Invalid execution ID' });
    const execution = await getWorkflowExecutionById(id);

    if (!execution) {
      return res.status(404).json({ message: "Execution not found" });
    }

    res.json({ execution });
  } catch (error) {
    logger.error({ err: error }, 'Get execution error');
    res.status(500).json({ message: "Unable to retrieve the execution details. Please try again." });
  }
}

export async function getWorkflowExecutionsHandler(req: Request, res: Response) {
  try {
    const workflowId = parseIdParam(req.params.id);
    if (!workflowId) return res.status(400).json({ message: 'Invalid workflow ID' });
    const executions = await getWorkflowExecutions(workflowId);
    res.json({ executions });
  } catch (error) {
    logger.error({ err: error }, 'Get workflow executions error');
    res.status(500).json({ message: "Unable to retrieve the execution history. Please try again." });
  }
}

export async function getUserExecutionsHandler(req: Request, res: Response) {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const user = (req as any).user;
    const executions = await getUserWorkflowExecutions(user.id);
    res.json({ executions });
  } catch (error) {
    logger.error({ err: error }, 'Get user executions error');
    res.status(500).json({ message: "Unable to retrieve your execution history. Please try again." });
  }
}

// New endpoints for JSON-based workflows

/**
 * GET /api/workflows/catalog/list
 * List all available workflow JSON files from data/workflows
 */
export async function listAvailableWorkflowsHandler(req: Request, res: Response) {
  try {
    const workflowsDir = path.join(process.cwd(), "data/workflows");
    
    if (!(await dirExists(workflowsDir))) {
      return res.json({ workflows: [] });
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workflows: any[] = [];

    // Read root-level workflows (comprehensive reactflow ones)
    const files = await readJsonFilesFromDir(workflowsDir);
    for (const { file, data: workflow } of files) {
      if (workflow.userId || workflow.businessProfileId) continue;
      workflows.push({
        id: workflow.workflow_id,
        title: workflow.title,
        platform: workflow.platform,
        description: workflow.description,
        nodeCount: workflow.nodes?.length || 0,
        edgeCount: workflow.edges?.length || 0,
        fileName: file,
      });
    }

    res.json({ workflows });
  } catch (error) {
    logger.error({ err: error }, 'List workflows error');
    res.status(500).json({ message: "Unable to list available workflows. Please try again." });
  }
}

/**
 * GET /api/workflows/catalog/:workflowId
 * Get a specific workflow JSON file by ID
 */
export async function getAvailableWorkflowHandler(req: Request, res: Response) {
  try {
    const { workflowId } = req.params;
    const workflowsDir = path.join(process.cwd(), "data/workflows");
    
    // Find matching workflow file
    const workflowPath = await findWorkflowFile(workflowsDir, workflowId);

    if (!workflowPath) {
      return res.status(404).json({ message: "Workflow not found" });
    }

    const content = await fsPromises.readFile(workflowPath, "utf-8");
    const workflow = JSON.parse(content);
    if (workflow.userId || workflow.businessProfileId) return res.status(404).json({ message: 'Workflow not found' });

    res.json({ workflow });
  } catch (error) {
    logger.error({ err: error }, 'Get workflow error');
    res.status(500).json({ message: "Unable to retrieve the workflow. Please try again." });
  }
}

/**
 * POST /api/workflows/catalog/:workflowId/execute
 * Retired like executeWorkflowHandler: lead workflows run through the conversation approval flow.
 */
export const executeAvailableWorkflowHandler = executeWorkflowHandler;

export async function getExecutionStatusHandler(req: Request, res: Response) {
  try {
    const { executionId } = req.params;
    const execution = await getWorkflowExecutionById(parseInt(executionId));

    if (!execution) {
      return res.status(404).json({ message: "Execution not found" });
    }

    res.json({
      executionId: execution.id,
      workflowId: execution.workflowId,
      status: execution.status,
      startedAt: execution.startedAt,
      endedAt: execution.completedAt,
      results: execution.results,
      logs: execution.logs,
      errorMessage: execution.error,
    });
  } catch (error) {
    logger.error({ err: error }, 'Get execution status error');
    res.status(500).json({ message: "Unable to retrieve the execution status. Please try again." });
  }
}

// Admin-scoped: return ALL workflows (no userId filter)
export async function executeAdminWorkflowHandler(req: Request, res: Response) {
  try {
    const workflowId = req.params.id;
    const { nodes, edges, mappings, apifyCredentialId, inputParameters } = req.body;

    // Load workflow from file
    const workflowsDir = path.join(process.cwd(), "data/workflows");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let workflow: any = null;

    if (await dirExists(workflowsDir)) {
      const files = await readJsonFilesFromDir(workflowsDir);

      for (const { data: w } of files) {
        if (w.workflow_id === workflowId) {
          workflow = w;
          break;
        }
      }
    }

    if (!workflow) {
      return res.status(404).json({ message: "Workflow not found" });
    }

    // Use canvas nodes/edges if provided (current unsaved state)
    if (nodes) workflow.nodes = nodes;
    if (edges) workflow.edges = edges;
    if (mappings) workflow.mappings = mappings;

    let apifyApiKey: string | undefined;
    if (apifyCredentialId !== undefined) {
      const credentialId = Number(apifyCredentialId);
      if (!Number.isInteger(credentialId) || credentialId <= 0) {
        return res.status(400).json({ message: 'Invalid Apify credential' });
      }
      const { getAdminCredentialById } = await import('../models/adminApiCredentials/functions.js');
      const credential = await getAdminCredentialById(credentialId);
      if (!credential || credential.platform !== 'apify' || !credential.isActive) {
        return res.status(404).json({ message: 'Active Apify credential not found' });
      }
      apifyApiKey = credential.apiKey;
    }

    // Resolve credentials on the server; secret values never travel through the browser.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const inputParams: Record<string, any> = {
      ...(inputParameters || {}),
      ...(apifyApiKey ? { apifyApiKey } : {}),
    };

    // Execute workflow — use "0" as userId so DB logging is skipped; admin doesn't need a user record
    const result = await WorkflowExecutorService.executeWorkflow(workflow, inputParams, "0");

    return res.json({
      executionId: result.executionId,
      status: "completed",
      results: result.results,
      errors: result.errors,
    });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, 'Execute admin workflow error');
    return res.status(500).json({
      message: "The workflow could not be executed. Please check your inputs and try again.",
      error: error.message,
    });
  }
}

export async function getAdminWorkflowsHandler(req: Request, res: Response) {
  try {
    const workflowsDir = path.join(process.cwd(), "data/workflows");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const workflows: any[] = [];

    if (await dirExists(workflowsDir)) {
      const files = await readJsonFilesFromDir(workflowsDir);
      for (const { file, data: workflow } of files) {
        try {
          workflows.push({
            id: workflow.workflow_id,
            name: workflow.title,
            description: workflow.description,
            platform: workflow.platform,
            nodes: workflow.nodes,
            edges: workflow.edges,
            mappings: workflow.mappings || [],
            fileName: file,
            createdAt: workflow.createdAt,
            updatedAt: workflow.updatedAt,
          });
        } catch (err) {
          logger.error({ err, file }, 'Error parsing workflow file');
        }
      }
    }

    res.json({ workflows });
  } catch (error) {
    logger.error({ err: error }, 'Get admin workflows error');
    res.status(500).json({ message: "Unable to retrieve workflows. Please try again." });
  }
}
