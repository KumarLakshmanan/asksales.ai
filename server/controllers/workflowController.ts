import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { logger } from '../utils/logger.js';
import { resolveWorkflowsDir } from '../utils/dataPathResolver.js';

interface Workflow {
  workflow_id: string;
  platform: string;
  title: string;
  description: string;
  version: string;
}

// This is a shared application catalog, not a directory of tenant uploads.
// Keep every read in its canonical flat root; a valid ID alone does not make a
// symlink or a replaced/non-regular file a catalog-owned entry.
function readCatalogWorkflow(root: string, fileName: string): Record<string, unknown> | undefined {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.json$/.test(fileName)) return undefined;
  const filePath = path.resolve(root,fileName);
  if (path.dirname(filePath) !== root) return undefined;
  let descriptor: number | undefined;
  try {
    const entry = fs.lstatSync(filePath);
    if (!entry.isFile() || path.dirname(fs.realpathSync(filePath)) !== root) return undefined;
    descriptor = fs.openSync(filePath,fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino) return undefined;
    const workflow: unknown = JSON.parse(fs.readFileSync(descriptor,'utf8'));
    if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) return undefined;
    const definition = workflow as Record<string, unknown>;
    return definition.userId || definition.businessProfileId || definition.platform === 'custom' ? undefined : definition;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (['ENOENT','ENOTDIR','ELOOP','ENAMETOOLONG'].includes(code || '') || error instanceof SyntaxError) return undefined;
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

/**
 * GET /api/workflows
 * List available workflows, optionally filtered by platform
 */
export async function listWorkflows(req: Request, res: Response) {
  try {
    const { platform } = req.query;
    
    const workflowsDir = resolveWorkflowsDir();
    const workflows: Workflow[] = [];
    
    if (fs.existsSync(workflowsDir)) {
      const root = fs.realpathSync(workflowsDir);
      const files = fs.readdirSync(root).filter(f => f.endsWith('.json') && !f.startsWith('.'));
      
      for (const file of files) {
        try {
          const workflow = readCatalogWorkflow(root,file);
          
          if (workflow && typeof workflow.workflow_id === 'string' && workflow.workflow_id && typeof workflow.platform === 'string' && workflow.platform && typeof workflow.title === 'string' && workflow.title) {
            workflows.push({
              workflow_id: workflow.workflow_id,
              platform: workflow.platform,
              title: workflow.title,
              description: typeof workflow.description === 'string' ? workflow.description : '',
              version: typeof workflow.version === 'string' && workflow.version ? workflow.version : '1.0'
            });
          }
        } catch (err) {
          logger.warn({ err, file }, 'Failed to parse workflow file');
        }
      }
    }
    
    // Filter by platform if specified
    if (platform && typeof platform === 'string') {
      const filtered = workflows.filter(w => w.platform === platform);
      return res.json(filtered);
    }
    
    res.json(workflows);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WorkflowController] Error listing workflows');
    res.status(500).json({ error: 'Unable to list available workflows. Please try again.' });
  }
}

/**
 * GET /api/workflows/sub-workflows
 * List variant workflows grouped by base platform, read from data/workflows/
 */
export async function listSubWorkflows(req: Request, res: Response) {
  try {
    const workflowsDir = resolveWorkflowsDir();
    const result: Record<string, Array<{ id: string; title: string; description: string }>> = {};
    
    if (!fs.existsSync(workflowsDir)) {
      return res.json(result);
    }
    
    const root = fs.realpathSync(workflowsDir);
    const files = fs.readdirSync(root).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    
    for (const file of files) {
      try {
        const workflow = readCatalogWorkflow(root,file);
        
        if (workflow && typeof workflow.workflow_id === 'string' && workflow.workflow_id && typeof workflow.title === 'string' && workflow.title) {
          // Determine base platform from file name (e.g., "instagram" from "instagram_post_authors.json")
          const basePlatform = file.replace('.json', '').split('_')[0];
          
          if (!result[basePlatform]) {
            result[basePlatform] = [];
          }
          
          result[basePlatform].push({
            id: workflow.workflow_id,
            title: workflow.title,
            description: typeof workflow.description === 'string' ? workflow.description : '',
          });
        }
      } catch (err) {
        logger.warn({ err, file }, 'Failed to parse workflow file');
      }
    }
    
    res.json(result);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WorkflowController] Error listing workflows');
    res.status(500).json({ error: 'Unable to list workflows. Please try again.' });
  }
}

/**
 * GET /api/workflows/:workflowId
 * Get a specific workflow by ID
 */
export async function getWorkflow(req: Request, res: Response) {
  try {
    const { workflowId } = req.params;
    // Express already decodes route parameters. Reject separators, dot paths,
    // nulls and remaining percent escapes instead of decoding a second time.
    if (typeof workflowId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/.test(workflowId)) {
      return res.status(400).json({error:'Invalid workflow ID'});
    }
    const root = fs.realpathSync(resolveWorkflowsDir());
    
    // Try different possible filename formats in root
    const possibleNames = [
      `${workflowId}.json`,
      `${workflowId}_workflow.json`,
    ];
    
    for (const fileName of possibleNames) {
      const workflow = readCatalogWorkflow(root,fileName);
      if (workflow) return res.json(workflow);
    }
    
    // Also try matching by workflow_id in all files
    const allFiles = fs.readdirSync(root).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    for (const file of allFiles) {
      try {
        const workflow = readCatalogWorkflow(root,file);
        if (workflow?.workflow_id === workflowId) {
          return res.json(workflow);
        }
      } catch {
        // skip invalid files
      }
    }
    
    res.status(404).json({ error: 'Workflow not found' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } catch (error: any) {
    logger.error({ err: error }, '[WorkflowController] Error getting workflow');
    res.status(500).json({ error: 'Unable to retrieve the workflow details. Please try again.' });
  }
}
