import { createHash } from 'node:crypto';
import { TemplateCreateRequestError } from '../utils/templateCreateRequest.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import type { AuthenticatedRequest } from '../types/express.js';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Request, Response } from 'express';
import * as contentTemplatesFn from '../models/contentTemplates/functions';
import { BrandToolkitModel } from '../models/brandToolkits/functions.js';
import {
  brandContextSnapshot,
  ContentBrandContextError,
  resolveContentBrandContext,
} from '../services/content/ContentBrandContextService.js';
import {
  canonicalizeTemplateVariable,
  extractTemplateVariables,
  sanitizeEmailHtml,
} from '../utils/contentTemplateRendering.js';
import { logger } from '../utils/logger.js';
import { ApprovedTemplateError, resolveApprovedTemplate } from '../services/content/ApprovedTemplateResolver.js';
import { ManagedStorageReferenceError } from '../services/storageReferenceLocks.js';
import { parseDigitsId as parseId } from '../utils/paramParsers.js';

export const getContentTemplateCounts = async (req: Request, res: Response) => {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    return res.json(await contentTemplatesFn.countContentTemplatesByTypeForUser(userId));
  } catch (error) {
    logger.error({ err: error }, '[ContentTemplatesController] Error fetching template counts');
    return res.status(500).json({ error: 'Unable to retrieve saved template counts.' });
  }
};

function parseQueryInteger(
  value: unknown,
  field: string,
  range: { min: number; max?: number },
): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new Error(`Invalid ${field}`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < range.min || (range.max !== undefined && parsed > range.max)) {
    throw new Error(`Invalid ${field}`);
  }
  return parsed;
}

const VALID_TEMPLATE_TYPES = [
  'email',
  'whatsapp',
  'sms',
  'ad_copy',
  'social',
  'social_message',
  'landing_page',
  'blog',
] as const;

function normalizedTemplateVariables(parts: Array<string | null | undefined>): string[] {
  const tokens = parts.flatMap((part) => extractTemplateVariables(part || ''));
  const normalized = new Set<string>();
  for (const token of tokens) {
    const canonical = canonicalizeTemplateVariable(token);
    if (!canonical) {
      throw new Error(`Unsupported template variable: {{${token}}}`);
    }
    normalized.add(`{{${canonical}}}`);
  }
  return [...normalized];
}

function handleKnownTemplateError(error: unknown, res: Response): boolean {
  if (error instanceof ManagedStorageReferenceError) {
    res.status(error.status).json({ error: error.message, code: error.code }); return true;
  }
  if (error instanceof TemplateCreateRequestError) {
    res.status(error.status).json({ error: error.message, code: error.code }); return true;
  }
  if (error instanceof contentTemplatesFn.ContentTemplateVersionConflictError) {
    res.status(409).json({ error: error.message, code: 'TEMPLATE_VERSION_CONFLICT' });
    return true;
  }
  if (error instanceof ContentBrandContextError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  if (error instanceof Error && error.message.startsWith('Unsupported template variable:')) {
    res.status(400).json({ error: error.message, code: 'INVALID_TEMPLATE_VARIABLE' });
    return true;
  }
  return false;
}

// Get all templates for a user
export async function getContentTemplates(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { type, search, brandToolkitId, includePredefined, limit, offset } = req.query;

    const limitNum = parseQueryInteger(limit, 'limit', { min: 1, max: 200 });
    const offsetNum = parseQueryInteger(offset, 'offset', { min: 0, max: 1_000_000 });
    const toolkitId = parseQueryInteger(brandToolkitId, 'brandToolkitId', { min: 1 });
    if (toolkitId) {
      const toolkit = await BrandToolkitModel.findByIdAndUser(toolkitId, userId);
      if (!toolkit) return res.status(404).json({ error: 'Brand toolkit not found' });
    }
    const result = await contentTemplatesFn.listContentTemplates({
      userId,
      type: typeof type === 'string' ? type : undefined,
      search: typeof search === 'string' ? search.trim().slice(0, 255) || undefined : undefined,
      brandToolkitId: toolkitId,
      includePredefined: includePredefined === 'true',
      limit: limitNum,
      offset: offsetNum,
    });

    if (limitNum !== undefined || offsetNum !== undefined) return res.json(result);
    return res.json(result.templates);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid ')) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, 'Error fetching content templates');
    return res.status(500).json({ error: 'Unable to retrieve content templates. Please try again.' });
  }
}

// Get a single template by ID
export async function getContentTemplateById(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const templateId = parseId(req.params.id);
    if (!templateId) return res.status(400).json({ error: 'Invalid template ID' });
    const template = await contentTemplatesFn.getContentTemplateById(templateId);

    if (!template) {
      return res.status(404).json({ error: 'Template not found' });
    }

    // Verify ownership (predefined templates can be viewed by anyone)
    if (template.userId !== userId && !(template.isPredefined && template.isApproved)) {
      return res.status(403).json({ error: 'Access denied' });
    }

    return res.json(template);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching content template');
    return res.status(500).json({ error: 'Unable to retrieve the content template. Please try again.' });
  }
}

// Create a new template
export async function createContentTemplate(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const key = req.headers['idempotency-key'];
    if (key !== undefined && (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{8,200}$/.test(key))) return res.status(400).json({ error: 'Invalid template request key.' });
    const request = typeof key === 'string' ? { key, hash: createHash('sha256').update(JSON.stringify({ action: 'template-create', actor: req.user!.id, body: req.body })).digest('hex') } : undefined;
    const { name, type, content, subject, variables, category, tags, brandToolkitId, htmlContent, description } = req.body;

    if (!name || !type || !content) {
      return res.status(400).json({ error: 'Name, type, and content are required' });
    }

    if (!VALID_TEMPLATE_TYPES.includes(type)) {
      return res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_TEMPLATE_TYPES.join(', ')}` });
    }
    if (htmlContent && type !== 'email') {
      return res.status(400).json({ error: 'HTML content is supported only for email templates' });
    }
    const context = await resolveContentBrandContext(userId, {
      businessProfileId: req.body.businessProfileId,
      brandToolkitId,
    });
    const sanitizedHtml = htmlContent ? sanitizeEmailHtml(htmlContent) : null;
    const detectedVariables = normalizedTemplateVariables([subject, content, sanitizedHtml]);

    const data = {
      userId,
      name,
      type,
      content,
      subject,
      htmlContent: sanitizedHtml,
      description: description || null,
      variables: [...new Set([...(variables || []).map((value: string) => {
        const canonical = canonicalizeTemplateVariable(value.replace(/^\{\{|\}\}$/g, ''));
        if (!canonical) throw new Error(`Unsupported template variable: ${value}`);
        return `{{${canonical}}}`;
      }), ...detectedVariables])],
      category,
      tags: tags || [],
      brandToolkitId: context.brandToolkit.id,
      businessProfileId: context.businessProfile.id,
      brandContextSnapshot: brandContextSnapshot(context),
      isApproved: true,
      approvedBy: req.user!.id,
      approvedAt: new Date(),
    };
    const template = request ? await contentTemplatesFn.createContentTemplate(data, request) : await contentTemplatesFn.createContentTemplate(data);
    if (request) res.setHeader('Content-Request-Confirmed', 'true');

    return res.status(201).json(template);
  } catch (error) {
    if (handleKnownTemplateError(error, res)) return;
    logger.error({ err: error }, 'Error creating content template');
    return res.status(500).json({ error: 'Unable to create the content template. Please try again.' });
  }
}

// Update a template
export async function updateContentTemplate(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const templateId = parseId(req.params.id);
    if (!templateId) return res.status(400).json({ error: 'Invalid template ID' });

    // Verify ownership
    const existing = await contentTemplatesFn.getContentTemplateById(templateId);
    if (!existing) {
      return res.status(404).json({ error: 'Template not found' });
    }
    if (existing.userId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const { name, type, content, subject, variables, category, tags, brandToolkitId, htmlContent, description } = req.body;

    // Validate type if provided
    if (type) {
      if (!VALID_TEMPLATE_TYPES.includes(type)) {
        return res.status(400).json({ error: `Invalid type. Must be one of: ${VALID_TEMPLATE_TYPES.join(', ')}` });
      }
    }
    const resultingType = type || existing.type;
    const updatedSubject = existing.type === 'email' && resultingType !== 'email' ? null : subject;
    if (htmlContent && resultingType !== 'email') {
      return res.status(400).json({ error: 'HTML content is supported only for email templates' });
    }
    const context = await resolveContentBrandContext(userId, {
      businessProfileId: req.body.businessProfileId ?? existing.businessProfileId,
      brandToolkitId: brandToolkitId ?? existing.brandToolkitId,
    });
    const sanitizedHtml = resultingType !== 'email'
      ? null
      : htmlContent === undefined
      ? undefined
      : htmlContent
        ? sanitizeEmailHtml(htmlContent)
        : htmlContent;
    const resultingSubject = updatedSubject === undefined ? existing.subject : updatedSubject;
    const resultingContent = content === undefined ? existing.content : content;
    const resultingHtml = sanitizedHtml === undefined ? existing.htmlContent : sanitizedHtml;
    const detectedVariables = normalizedTemplateVariables([
      resultingSubject,
      resultingContent,
      resultingHtml,
    ]);
    const normalizedDeclaredVariables = variables?.map((value: string) => {
      const canonical = canonicalizeTemplateVariable(value.replace(/^\{\{|\}\}$/g, ''));
      if (!canonical) throw new Error(`Unsupported template variable: ${value}`);
      return `{{${canonical}}}`;
    });

    const template = await contentTemplatesFn.updateContentTemplateForUser(templateId, userId, {
      name,
      type,
      content,
      subject: updatedSubject,
      htmlContent: sanitizedHtml,
      description,
      variables: normalizedDeclaredVariables
        ? [...new Set([...normalizedDeclaredVariables, ...detectedVariables])]
        : detectedVariables,
      category,
      tags,
      brandToolkitId: context.brandToolkit.id,
      businessProfileId: context.businessProfile.id,
      brandContextSnapshot: brandContextSnapshot(context),
      isApproved: true,
      approvedBy: req.user!.id,
      approvedAt: new Date(),
    }, existing.version);

    if (!template) return res.status(404).json({ error: 'Template not found' });

    return res.json(template);
  } catch (error) {
    if (handleKnownTemplateError(error, res)) return;
    logger.error({ err: error }, 'Error updating content template');
    return res.status(500).json({ error: 'Unable to update the content template. Please try again.' });
  }
}

// Delete a template
export async function deleteContentTemplate(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const templateId = parseId(req.params.id);
    if (!templateId) return res.status(400).json({ error: 'Invalid template ID' });

    // Verify ownership
    const existing = await contentTemplatesFn.getContentTemplateById(templateId);
    if (!existing) {
      return res.status(404).json({ error: 'Template not found' });
    }
    if (existing.userId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const deleted = await contentTemplatesFn.deleteContentTemplateForUser(templateId, userId);
    if (!deleted) return res.status(404).json({ error: 'Template not found' });

    return res.json({ success: true, message: 'Template deleted successfully' });
  } catch (error) {
    logger.error({ err: error }, 'Error deleting content template');
    return res.status(500).json({ error: 'Unable to delete the content template. Please try again.' });
  }
}

// Duplicate a template
export async function duplicateContentTemplate(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const templateId = parseId(req.params.id);
    if (!templateId) return res.status(400).json({ error: 'Invalid template ID' });

    // Verify ownership
    const existing = await contentTemplatesFn.getContentTemplateById(templateId);
    if (!existing) {
      return res.status(404).json({ error: 'Template not found' });
    }
    if (existing.userId !== userId) {
      return res.status(403).json({ error: 'Access denied' });
    }

    const duplicate = await contentTemplatesFn.duplicateContentTemplate(templateId, userId);

    if (!duplicate) {
      return res.status(500).json({ error: 'Unable to duplicate the template. Please try again.' });
    }

    return res.status(201).json(duplicate);
  } catch (error) {
    logger.error({ err: error }, 'Error duplicating content template');
    return res.status(500).json({ error: 'Unable to duplicate the content template. Please try again.' });
  }
}

// Increment usage count (when a template is used)
export async function useTemplate(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const templateId = parseId(req.params.id);
    if (!templateId) return res.status(400).json({ error: 'Invalid template ID' });

    const values = req.body?.variables ?? req.body?.values ?? {};
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      return res.status(400).json({ error: 'Template variables must be an object' });
    }
    const resolved = await resolveApprovedTemplate(userId, templateId, values, undefined,
      req.body?.leadId !== undefined ? { leadId: req.body.leadId, channel: typeof req.body.channel === 'string' ? req.body.channel : undefined } : undefined);
    await contentTemplatesFn.incrementTemplateUsage(templateId);
    const { type: _type, ...result } = resolved;
    return res.json(result);
  } catch (error) {
    if (error instanceof ApprovedTemplateError) return res.status(error.status).json({
      error: error.message, code: error.code, ...(error.unresolved ? { unresolved: error.unresolved } : {}),
    });
    if (handleKnownTemplateError(error, res)) return;
    logger.error({ err: error }, 'Error recording template usage');
    return res.status(500).json({ error: 'Unable to record template usage. Please try again.' });
  }
}

// Get most used templates
export async function getMostUsedTemplates(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const limit = parseQueryInteger(req.query.limit, 'limit', { min: 1, max: 100 }) ?? 10;
    const templates = await contentTemplatesFn.getMostUsedTemplates(userId, limit);

    return res.json(templates);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Invalid ')) {
      return res.status(400).json({ error: error.message });
    }
    logger.error({ err: error }, 'Error fetching most used templates');
    return res.status(500).json({ error: 'Unable to retrieve most used templates. Please try again.' });
  }
}

// Get predefined templates (admin-created, available to all users)
export async function getPredefinedTemplates(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { type } = req.query;
    const templates = await contentTemplatesFn.getPredefinedTemplates(
      type && typeof type === 'string' ? type : undefined
    );

    return res.json(templates);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching predefined templates');
    return res.status(500).json({ error: 'Unable to retrieve predefined templates. Please try again.' });
  }
}

// Import a predefined template as user's own copy
export async function importPredefinedTemplate(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const templateId = parseId(req.params.id);
    if (!templateId) return res.status(400).json({ error: 'Invalid template ID' });

    const original = await contentTemplatesFn.getContentTemplateById(templateId);
    if (!original || !original.isPredefined || !original.isApproved) {
      return res.status(404).json({ error: 'Predefined template not found' });
    }

    const context = await resolveContentBrandContext(userId);
    const duplicate = await contentTemplatesFn.duplicateContentTemplate(templateId, userId, {
      brandToolkitId: context.brandToolkit.id,
      businessProfileId: context.businessProfile.id,
      brandContextSnapshot: brandContextSnapshot(context),
    });
    if (!duplicate) {
      return res.status(500).json({ error: 'Unable to import template. Please try again.' });
    }

    await contentTemplatesFn.incrementTemplateUsage(templateId);

    return res.status(201).json(duplicate);
  } catch (error) {
    if (handleKnownTemplateError(error, res)) return;
    logger.error({ err: error }, 'Error importing predefined template');
    return res.status(500).json({ error: 'Unable to import the template. Please try again.' });
  }
}

export async function getContentTemplateVersions(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const templateId = parseId(req.params.id);
    if (!templateId) return res.status(400).json({ error: 'Invalid template ID' });
    const versions = await contentTemplatesFn.getContentTemplateVersionsForUser(templateId, userId);
    if (versions.length === 0) return res.status(404).json({ error: 'Template not found' });
    return res.json(versions);
  } catch (error) {
    logger.error({ err: error }, 'Error fetching content template versions');
    return res.status(500).json({ error: 'Unable to retrieve template versions. Please try again.' });
  }
}

export async function approveContentTemplate(req: AuthenticatedRequest, res: Response) {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const templateId = parseId(req.params.id);
    if (!templateId) return res.status(400).json({ error: 'Invalid template ID' });
    const existing = await contentTemplatesFn.getContentTemplateById(templateId);
    if (!existing || existing.userId !== userId) {
      return res.status(404).json({ error: 'Template not found' });
    }
    if (req.body?.expectedVersion !== undefined && (!Number.isSafeInteger(req.body.expectedVersion) || req.body.expectedVersion !== existing.version)) {
      return res.status(409).json({ error: 'This template changed after you opened the review. Close and reopen it before approving.' });
    }
    const context = await resolveContentBrandContext(userId, {
      businessProfileId: existing.businessProfileId,
      brandToolkitId: existing.brandToolkitId,
    });
    normalizedTemplateVariables([existing.subject, existing.content, existing.htmlContent]);
    const template = await contentTemplatesFn.approveContentTemplateForUser(templateId, userId, {
      businessProfileId: context.businessProfile.id,
      brandToolkitId: context.brandToolkit.id,
      brandContextSnapshot: brandContextSnapshot(context),
    }, existing.version);
    if (!template) return res.status(404).json({ error: 'Template not found' });
    return res.json(template);
  } catch (error) {
    if (handleKnownTemplateError(error, res)) return;
    logger.error({ err: error }, 'Error approving content template');
    return res.status(500).json({ error: 'Unable to approve the template. Please try again.' });
  }
}
