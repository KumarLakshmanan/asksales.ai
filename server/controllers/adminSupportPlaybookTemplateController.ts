import type { Request, Response } from 'express';
import type { PlaybookGraph, PlaybookTemplateAssignment } from '../models/supportOrchestration/schema.js';
import {
  createSupportTemplate,
  listSupportTemplates,
  updateSupportTemplate,
  type SupportTemplateInput,
} from '../services/agents/orchestration/SupportPlaybookTemplateService.js';
import type { SupportAgentType } from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import { logger } from '../utils/logger.js';
import {
  listSupportAgentTemplates,
  updateSupportAgentTemplate,
  type SupportAgentTemplateInput,
} from '../services/agents/orchestration/SupportAgentTemplateService.js';

function adminId(req: Request): number | null {
  return req.user?.id || null;
}

function agentPayload(req: Request, agentType: string): SupportAgentTemplateInput {
  return {
    agentType: agentType as SupportAgentType,
    displayName: String(req.body.displayName || '').trim(),
    description: req.body.description == null ? null : String(req.body.description),
    systemPrompt: String(req.body.systemPrompt || ''),
    toolsEnabled: Array.isArray(req.body.toolsEnabled) ? req.body.toolsEnabled.map(String) : [],
    escalationRules: req.body.escalationRules || {},
    channelScope: Array.isArray(req.body.channelScope) ? req.body.channelScope.map(String) : [],
    priority: Number(req.body.priority),
    metadata: req.body.metadata && typeof req.body.metadata === 'object' ? req.body.metadata : {},
  };
}

export async function listAdminSupportAgentTemplates(_req: Request, res: Response) {
  try {
    return res.json(await listSupportAgentTemplates());
  } catch (error) {
    logger.error({ err: error }, 'Failed to list support agent templates');
    return res.status(500).json({ error: 'Unable to load support agent templates.' });
  }
}

export async function updateAdminSupportAgentTemplate(req: Request, res: Response) {
  const actorId = adminId(req);
  if (!actorId) return res.status(401).json({ error: 'Unauthorized' });
  const agentType = String(req.params.agentType || '');
  try {
    const result = await updateSupportAgentTemplate(agentType, agentPayload(req, agentType), actorId);
    if ('errors' in result) return res.status(400).json({ error: 'Agent template validation failed.', details: result.errors });
    if ('notFound' in result) return res.status(404).json({ error: 'Agent template not found.' });
    return res.json(result);
  } catch (error) {
    logger.error({ err: error, actorId, agentType }, 'Failed to update support agent template');
    return res.status(500).json({ error: 'Unable to update and propagate support agent template.' });
  }
}

function payload(req: Request, templateKey?: string): SupportTemplateInput {
  return {
    templateKey: templateKey || String(req.body.templateKey || '').trim(),
    name: String(req.body.name || '').trim(),
    description: req.body.description == null ? null : String(req.body.description),
    agentType: String(req.body.agentType || '') as SupportAgentType,
    status: req.body.status === 'archived' ? 'archived' : 'published',
    graph: req.body.graph as PlaybookGraph,
    assignments: Array.isArray(req.body.assignments)
      ? req.body.assignments as PlaybookTemplateAssignment[]
      : [],
  };
}

export async function listAdminSupportPlaybookTemplates(req: Request, res: Response) {
  try {
    return res.json(await listSupportTemplates(true));
  } catch (error) {
    logger.error({ err: error }, 'Failed to list support playbook templates');
    return res.status(500).json({ error: 'Unable to load support playbook templates.' });
  }
}

export async function createAdminSupportPlaybookTemplate(req: Request, res: Response) {
  const actorId = adminId(req);
  if (!actorId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const result = await createSupportTemplate(payload(req), actorId);
    if ('errors' in result) return res.status(400).json({ error: 'Template validation failed.', details: result.errors });
    return res.status(201).json(result);
  } catch (error: unknown) {
    if ((error as { code?: string })?.code === '23505') return res.status(409).json({ error: 'That template key already exists.' });
    logger.error({ err: error, actorId }, 'Failed to create support playbook template');
    return res.status(500).json({ error: 'Unable to create support playbook template.' });
  }
}

export async function updateAdminSupportPlaybookTemplate(req: Request, res: Response) {
  const actorId = adminId(req);
  if (!actorId) return res.status(401).json({ error: 'Unauthorized' });
  const templateKey = String(req.params.templateKey || '').trim();
  try {
    const result = await updateSupportTemplate(templateKey, payload(req, templateKey), actorId);
    if ('errors' in result) return res.status(400).json({ error: 'Template validation failed.', details: result.errors });
    if ('notFound' in result) return res.status(404).json({ error: 'Template not found.' });
    return res.json(result);
  } catch (error) {
    logger.error({ err: error, actorId, templateKey }, 'Failed to update support playbook template');
    return res.status(500).json({ error: 'Unable to update and propagate support playbook template.' });
  }
}
