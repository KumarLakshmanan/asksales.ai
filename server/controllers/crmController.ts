import { savedContactResponse } from '../services/automations/ContactAutomationHandoff.js';
import { CrmImportInterruptedError } from '../services/CrmImportLedger.js';
import { CampaignWorkspaceError } from '../services/CampaignWorkspaceService.js';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { Request, Response } from 'express';
import { logger } from '../utils/logger.js';
import { crmService } from '../services/CRMService.js';
import { automationService } from '../services/AutomationService.js';
import {AutomationConfigurationError} from '../services/automations/AutomationErrors.js';
import { reminderService } from '../services/ReminderService.js';
import { alertService, ALERT_EVENT_TYPES } from '../services/AlertService.js';
import { db } from '../models/db.js';
import { supportTicketsTable } from '../models/supportTickets/schema.js';
import { supportTicketMessagesTable } from '../models/supportTicketMessages/schema.js';
import { leadsTable } from '../models/leads/schema.js';
import { crmContactsTable } from '../models/crmContacts/schema.js';
import { eq, and, desc, inArray, isNull } from 'drizzle-orm';
import { getMissingContactImportMappings } from '../utils/contactImportValidation.js';
import { CrmConfigurationError, getCrmConfiguration } from '../services/CRMConfigurationService.js';
import { crmContactsQuerySchema } from '../utils/crmWorkspaceValidation.js';
import { ZodError } from 'zod';
import { getPaginatedActivities, getPaginatedConversations, getPaginatedTickets } from './crmWorkspaceController.js';

// ─── Contacts ────────────────────────────────────────────────────────────────

export const getContacts = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const result = await crmService.getContacts(userId, crmContactsQuerySchema.parse(req.query));

    return res.json({ success: true, ...result });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ error: 'Invalid contact filters', details: error.issues.map(item => ({ field: item.path.join('.'),message: item.message })) });
    if (error instanceof CampaignWorkspaceError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, 'Failed to get CRM contacts');
    return res.status(500).json({ error: 'Failed to fetch contacts' });
  }
};

export const getContact = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const contact = await crmService.getContactById(userId, Number(req.params.id));
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    return res.json({ success: true, data: contact });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get CRM contact');
    return res.status(500).json({ error: 'Failed to fetch contact' });
  }
};

export const createContact = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const hasIdentity = [req.body.name, req.body.firstName, req.body.lastName, req.body.email, req.body.phone]
      .some((value) => typeof value === 'string' && value.trim().length > 0);
    if (!hasIdentity) {
      return res.status(400).json({ error: 'Provide a name, email address, or phone number' });
    }

    const key = req.headers?.['idempotency-key'];
    if (key !== undefined && (typeof key !== 'string' || !/^[A-Za-z0-9._:-]{8,100}$/.test(key)))
      return res.status(400).json({ error: 'Use an 8–100 character idempotency key.' });
    const created = key ? await crmService.createContact(userId, req.body, { key }) : await crmService.createContact(userId, req.body);
    const { creationReplayed, ...contact } = created;
    if (!creationReplayed) void Promise.resolve().then(() => alertService.fireEvent(userId, 'contact_created', { contactId: contact.id }))
      .catch(error => logger.warn({ err: error, contactId: contact.id }, 'Contact created; alert dispatch failed'));
    if (key) res.setHeader?.('Content-Request-Confirmed', 'true');
    return res.status(201).json({ success: true, data: contact });
  } catch (error) {
    if (error instanceof CampaignWorkspaceError) return res.status(error.status).json({ error: error.message });
    if (error instanceof CrmConfigurationError) return res.status(error.status).json({ error: error.message });
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, 'Failed to create CRM contact');
    return res.status(500).json({ error: 'Failed to create contact' });
  }
};

export const updateContact = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const previous = await crmService.getContactById(userId, Number(req.params.id));
    if (!previous) return res.status(404).json({ error: 'Contact not found' });
    const contact = await crmService.updateContact(userId, Number(req.params.id), req.body, { recoverableAutomation:true });
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    return res.json({ success:true,data:await savedContactResponse(userId,contact) });
  } catch (error) {
    if (error instanceof CrmConfigurationError) return res.status(error.status).json({ error: error.message });
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, 'Failed to update CRM contact');
    return res.status(500).json({ error: 'Failed to update contact' });
  }
};

export const deleteContact = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const deleted = await crmService.softDeleteContact(userId, Number(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Contact not found' });

    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete CRM contact');
    return res.status(500).json({ error: 'Failed to delete contact' });
  }
};

export const convertLeadToContact = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const contact = await crmService.convertLeadToContact(userId, Number(req.params.leadId));
    if (!contact) return res.status(404).json({ error: 'Lead not found' });
    return res.status(201).json({ success: true, data: contact });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, 'Failed to convert lead to contact');
    return res.status(500).json({ error: 'Failed to convert lead' });
  }
};

// ─── Activities ──────────────────────────────────────────────────────────────

export const getActivities = async (req: Request, res: Response) => {
  if (Object.keys(req.query || {}).length) return getPaginatedActivities(req,res);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const activities = await crmService.getActivities(userId, Number(req.params.contactId));
    return res.json({ success: true, data: activities });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get activities');
    return res.status(500).json({ error: 'Failed to fetch activities' });
  }
};

export const addActivity = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { type, subject, body, dueAt, completedAt, priority } = req.body;
    if (!subject?.trim() && !body?.trim()) {
      return res.status(400).json({ error: 'An activity subject or note is required' });
    }
    const activity = await crmService.addActivity(userId, Number(req.params.contactId), type, subject || null, body || null,
      { actorUserId: req.user?.id, source: 'crm' }, { dueAt, completedAt, priority });
    if (!activity) return res.status(404).json({ error: 'Contact not found' });
    return res.status(201).json({ success: true, data: activity });
  } catch (error) {
    if (error instanceof CrmConfigurationError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, 'Failed to add activity');
    return res.status(500).json({ error: 'Failed to add activity' });
  }
};

export const updateActivity = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const activity = await crmService.updateActivity(userId, Number(req.params.id), req.body);
    if (!activity) return res.status(404).json({ error: 'Activity not found' });
    return res.json({ success: true, data: activity });
  } catch (error) {
    if (error instanceof CrmConfigurationError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, 'Failed to update activity');
    return res.status(500).json({ error: 'Failed to update activity' });
  }
};

// ─── CSV Import ──────────────────────────────────────────────────────────────

export const importContacts = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const file = (req as any).file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });
    if (!/\.csv$/i.test(file.originalname || '')) {
      return res.status(400).json({ error: 'Only CSV files can be imported' });
    }

    const { parse } = await import('csv-parse/sync');
    const csvContent = file.buffer.toString('utf-8');
    let rows: Record<string, string>[];
    try {
      rows = parse(csvContent, {
        columns: (headers: string[]) => {
          if (headers.some(header => !header.trim()) || new Set(headers).size !== headers.length) {
            throw new Error('CSV column headers must be non-empty and unique');
          }
          return headers;
        },
        skip_empty_lines: true,
        trim: true,
        bom: true,
      }) as Record<string, string>[];
    } catch (error) {
      return res.status(400).json({
        error: 'The CSV file could not be parsed',
        details: [error instanceof Error ? error.message : 'Check the CSV formatting and try again'],
      });
    }

    if (!rows.length) return res.status(400).json({ error: 'CSV file is empty' });

    let columnMapping: Record<string, string> = {};
    try {
      columnMapping = req.body.columnMapping ? JSON.parse(req.body.columnMapping) : {};
    } catch {
      return res.status(400).json({ error: 'Column mapping must be valid JSON' });
    }
    if (!columnMapping || typeof columnMapping !== 'object' || Array.isArray(columnMapping)) {
      return res.status(400).json({ error: 'Column mapping must be an object' });
    }
    const headers = new Set(Object.keys(rows[0]));
    if (Object.keys(columnMapping).some(header => !headers.has(header))) {
      return res.status(400).json({ error: 'Column mapping references a missing CSV header' });
    }
    const allowedTargets = new Set(['skip', 'firstName', 'lastName', 'email', 'phone', 'company', 'role', 'status', 'dealValue', 'notes', 'tags', 'linkedinUrl', 'website']);
    const mappedTargets = Object.values(columnMapping).filter((target) => target !== 'skip');
    if (mappedTargets.length === 0) {
      return res.status(400).json({ error: 'Map at least one CSV column before importing' });
    }
    if (mappedTargets.some((target) => !allowedTargets.has(target))) {
      return res.status(400).json({ error: 'Column mapping contains an unsupported contact field' });
    }
    if (new Set(mappedTargets).size !== mappedTargets.length) {
      return res.status(400).json({ error: 'Each contact field can only be mapped once' });
    }
    const missingRequiredTargets = getMissingContactImportMappings(columnMapping);
    if (missingRequiredTargets.length > 0) {
      return res.status(400).json({
        error: `Map all mandatory fields before importing: ${missingRequiredTargets.join(', ')}`,
        missingRequiredFields: missingRequiredTargets,
      });
    }
    const csvHeaders = new Set(Object.keys(rows[0]));
    const unknownMappedColumns = Object.entries(columnMapping)
      .filter(([, target]) => target !== 'skip')
      .map(([source]) => source)
      .filter((source) => !csvHeaders.has(source));
    if (unknownMappedColumns.length > 0) {
      return res.status(400).json({
        error: 'Column mapping references columns that do not exist in the CSV file',
        mappingErrors: unknownMappedColumns,
      });
    }
    if(rows.length>10_000) {
      const {createLargeCsvImport}=await import('../services/operations/DashboardOperations.js');
      const operation=await createLargeCsvImport(rows,columnMapping,file.originalname);
      return res.status(202).json({success:true,data:{operationId:operation.id,importStatus:operation.status,links:operation.links}});
    }
    const result = await crmService.importContactsFromCSV(userId, rows, columnMapping, file.originalname);
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof CrmImportInterruptedError) return res.status(503).json({ error: error.message,importId: error.importId,retryable: true });
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json({ ...capacityError.toJSON(),importId: (error as { importId?: number }).importId });
    logger.error({ err: error }, 'Failed to import contacts');
    return res.status(500).json({ error: 'Failed to import contacts' });
  }
};

export const getImportStatus = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const result = await crmService.getImportStatus(userId, Number(req.params.id));
    if (!result) return res.status(404).json({ error: 'Import not found' });
    return res.json({ success: true, data: result });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get import status');
    return res.status(500).json({ error: 'Failed to fetch import status' });
  }
};

// ─── Analytics ───────────────────────────────────────────────────────────────

export const getCrmAnalytics = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const analytics = await crmService.getAnalytics(userId);
    return res.json({ success: true, data: analytics });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get CRM analytics');
    return res.status(500).json({ error: 'Failed to fetch analytics' });
  }
};

// ─── Automations ─────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function validateAutomationAction(body: Record<string, any>, userId: number): Promise<string | null> {
  if (!body.action) return null;
  const config = body.actionConfig ?? {};
  if (body.action === 'update_pipeline_status') {
    const configuration = await getCrmConfiguration(userId);
    if (!configuration.stages.some(stage => stage.key === config.pipelineStatus)) return 'Select a valid destination pipeline stage';
  }
  if (body.action === 'update_tags') {
    if (!Array.isArray(config.tags) || config.tags.length === 0 || config.tags.length > 20 ||
        config.tags.some((tag: unknown) => typeof tag !== 'string' || !tag.trim() || tag.length > 50)) {
      return 'Provide between 1 and 20 valid tags';
    }
  }
  return null;
}

export const getAutomations = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const automations = await automationService.getAutomations(userId);
    return res.json({ success: true, data: automations });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get automations');
    return res.status(500).json({ error: 'Failed to fetch automations' });
  }
};

export const createAutomation = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const validationError = await validateAutomationAction(req.body, userId);
    if (validationError) return res.status(400).json({ error: validationError });

    const automation = await automationService.createAutomation(userId, req.body);
    return res.status(201).json({ success: true, data: automation });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, 'Failed to create automation');
    if (error instanceof AutomationConfigurationError) return res.status(error.status).json({error:error.message});
    return res.status(500).json({ error: 'Failed to create automation' });
  }
};

export const updateAutomation = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const validationError = await validateAutomationAction(req.body, userId);
    if (validationError) return res.status(400).json({ error: validationError });

    const automation = await automationService.updateAutomation(userId, Number(req.params.id), req.body);
    if (!automation) return res.status(404).json({ error: 'Automation not found' });
    return res.json({ success: true, data: automation });
  } catch (error) {
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error }, 'Failed to update automation');
    if (error instanceof AutomationConfigurationError) return res.status(error.status).json({error:error.message});
    return res.status(500).json({ error: 'Failed to update automation' });
  }
};

export const deleteAutomation = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const deleted = await automationService.deleteAutomation(userId, Number(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Automation not found' });
    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete automation');
    return res.status(500).json({ error: 'Failed to delete automation' });
  }
};

export const getAutomationLogs = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const logs = await automationService.getAutomationLogs(userId, req.params.id ? Number(req.params.id) : undefined);
    return res.json({ success: true, data: logs });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get automation logs');
    return res.status(500).json({ error: 'Failed to fetch logs' });
  }
};

// ─── Reminders ───────────────────────────────────────────────────────────────

export const getReminders = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    let contactId: number | undefined;
    if (req.query.contactId !== undefined) {
      const reference = Number(req.query.contactId);
      if (!Number.isSafeInteger(reference) || !reference) return res.status(400).json({ error: 'Invalid contact ID' });
      const contact = await crmService.getContactById(userId,reference);
      if (!contact) return res.status(404).json({ error: 'Contact not found' });
      const id = Number((contact as any).id);
      if (id<0) return res.json({ success: true,data: [] });
      contactId = id;
    }
    const reminders = await reminderService.getActivityRemindersWithContacts(userId,{
      contactId,status: req.query.status as string,
    });
    return res.json({ success: true, data: reminders });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get reminders');
    return res.status(500).json({ error: 'Failed to fetch reminders' });
  }
};

export const createReminder = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { title, description, dueDate, priority, reminderType, contactId, activityId, notifyContact, assignedTo } = req.body;
    const reminderDueAt = dueDate ? new Date(dueDate) : null;
    if (!reminderDueAt || Number.isNaN(reminderDueAt.getTime())) {
      return res.status(400).json({ error: 'A valid due date is required' });
    }
    if (reminderDueAt.getTime() <= Date.now() + 60_000) {
      return res.status(400).json({ error: 'Reminder due date must be at least one minute in the future' });
    }

    const resolvedContact = contactId
      ? await crmService.materializeContactReference(userId, Number(contactId), 'crm_reminder')
      : null;
    if (contactId && !resolvedContact) {
      return res.status(404).json({ error: 'Contact not found' });
    }
    const reminder = await reminderService.createActivityReminder(userId, {
      title,
      description,
      reminderDueAt,
      reminderType: reminderType || 'followup',
      contactId: resolvedContact?.id,
      activityId: activityId ? Number(activityId) : undefined,
      metadata: { priority: priority || 'medium', notifyContact: Boolean(notifyContact),...(assignedTo !== undefined ? { assignedTo } : {}) },
    });
    return res.status(201).json({ success: true, data: reminder });
  } catch (error) {
    if (error instanceof CrmConfigurationError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, 'Failed to create reminder');
    return res.status(500).json({ error: 'Failed to create reminder' });
  }
};

export const updateReminder = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { title, description, dueDate, priority, reminderType, status, snoozedUntil, notifyContact, assignedTo } = req.body;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: Record<string, any> = {};
    if (title !== undefined) updates.title = title;
    if (description !== undefined) updates.description = description;
    if (dueDate) {
      const reminderDueAt = new Date(dueDate);
      if (Number.isNaN(reminderDueAt.getTime()) || reminderDueAt.getTime() <= Date.now() + 60_000) {
        return res.status(400).json({ error: 'Reminder due date must be at least one minute in the future' });
      }
      updates.reminderDueAt = reminderDueAt;
    }
    if (reminderType) updates.reminderType = reminderType;
    if (priority !== undefined || notifyContact !== undefined || assignedTo !== undefined) {
      updates.metadata = {
        ...(priority !== undefined && { priority }),
        ...(notifyContact !== undefined && { notifyContact: Boolean(notifyContact) }),
        ...(assignedTo !== undefined && { assignedTo }),
      };
    }
    if (status) updates.status = status;
    if (snoozedUntil !== undefined) {
      const snoozeDate = snoozedUntil ? new Date(snoozedUntil) : null;
      if (snoozeDate && (Number.isNaN(snoozeDate.getTime()) || snoozeDate.getTime() <= Date.now()+60_000))
        return res.status(400).json({ error: 'Snooze until at least one minute in the future' });
      if (snoozeDate && status && status !== 'snoozed') return res.status(400).json({ error: 'A snoozed reminder cannot be completed at the same time' });
      updates.snoozedUntil = snoozeDate;
    }

    const reminder = await reminderService.updateActivityReminder(userId, Number(req.params.id), updates);
    if (!reminder) return res.status(404).json({ error: 'Reminder not found' });
    return res.json({ success: true, data: reminder });
  } catch (error) {
    if (error instanceof CrmConfigurationError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, 'Failed to update reminder');
    return res.status(500).json({ error: 'Failed to update reminder' });
  }
};

export const deleteReminder = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const deleted = await reminderService.deleteActivityReminder(userId, Number(req.params.id));
    if (!deleted) return res.status(404).json({ error: 'Reminder not found' });
    return res.json({ success: true });
  } catch (error) {
    if (error instanceof CrmConfigurationError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, 'Failed to delete reminder');
    return res.status(500).json({ error: 'Failed to delete reminder' });
  }
};

// ─── Pipeline Status ─────────────────────────────────────────────────────────

export const getPipelineStages = async (req: Request, res: Response) => {
  const userId = businessOwnerUserId(req);
  if (!userId) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const configuration = await getCrmConfiguration(userId);
    return res.json({ success: true, data: configuration.stages });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get pipeline stages');
    return res.status(500).json({ error: 'Failed to fetch pipeline stages' });
  }
};

export const updatePipelineStatus = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const contactId = Number(req.params.id);
    const { pipelineStatus } = req.body;

    if (typeof pipelineStatus !== 'string' || !pipelineStatus) {
      return res.status(400).json({ error: 'Select a valid pipeline stage.' });
    }
    const configuration = await getCrmConfiguration(userId);
    if (!configuration.stages.some(stage => stage.key === pipelineStatus)) {
      return res.status(400).json({ error: 'Select a configured pipeline stage.' });
    }

    const previous = await crmService.getContactById(userId, contactId);
    if (!previous) return res.status(404).json({ error: 'Contact not found' });
    const result = await crmService.updatePipelineStatus(userId, contactId, pipelineStatus, { recoverableAutomation:'pipeline' });
    if (!result) return res.status(404).json({ error: 'Contact not found' });

    return res.json({ success:true,data:await savedContactResponse(userId,result) });
  } catch (error) {
    if (error instanceof CrmConfigurationError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, 'Failed to update pipeline status');
    return res.status(500).json({ error: 'Failed to update pipeline status' });
  }
};

export const analyzeSentimentAndUpdatePipeline = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const contactId = Number(req.params.id);
    const { messageText } = req.body;

    if (!messageText) return res.status(400).json({ error: 'messageText is required' });

    const result = await crmService.analyzeSentimentAndAdvancePipeline(userId, contactId, messageText);
    if (!result) return res.status(404).json({ error: 'Contact not found' });

    return res.json({ success: true, data: result });
  } catch (error) {
    logger.error({ err: error }, 'Failed to analyze sentiment');
    return res.status(500).json({ error: 'Failed to analyze sentiment' });
  }
};

export const getPipelineAnalytics = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const configuration = await getCrmConfiguration(userId);
    const analytics = await crmService.getPipelineAnalytics(userId, configuration);
    return res.json({ success: true, data: analytics });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get pipeline analytics');
    return res.status(500).json({ error: 'Failed to fetch pipeline analytics' });
  }
};

/**
 * GET /api/crm/contacts/:id/conversations
 * Get all outreach conversations (across all channels) and sent messages for a contact
 */
export const getContactConversations = async (req: Request, res: Response) => {
  // Redaction and private-field projection must not depend on query parameters.
  const contactId = Number(req.params.id);
  if (!Number.isSafeInteger(contactId) || contactId === 0) return res.status(400).json({ error: 'Invalid contact ID' });
  return getPaginatedConversations(req, res);
};

/**
 * GET /api/crm/contacts/:id/tickets
 * Get all support tickets linked to a CRM contact
 */
export const getContactTickets = async (req: Request, res: Response) => {
  if (Object.keys(req.query || {}).length) return getPaginatedTickets(req,res);
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const contactId = Number(req.params.id);
    if (isNaN(contactId)) return res.status(400).json({ error: 'Invalid contact ID' });

    // Verify contact ownership
    const contact = await crmService.getContactById(userId, contactId);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });

    // A virtual lead cannot have ticket foreign keys until it is materialized.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const resolvedContactId = Number((contact as any).crm_contact_id || (contact as any).id);
    if (resolvedContactId < 0) {
      return res.json({ success: true, tickets: [] });
    }

    // Fetch tickets linked to this persisted contact
    const tickets = await db
      .select()
      .from(supportTicketsTable)
      .where(
        and(
          eq(supportTicketsTable.userId, userId),
          eq(supportTicketsTable.contactId, resolvedContactId)
        )
      )
      .orderBy(desc(supportTicketsTable.createdAt))
      .limit(100);

    // Fetch messages for each ticket
    const ticketsWithMessages = await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      tickets.map(async (ticket: any) => {
        const messages = await db
          .select()
          .from(supportTicketMessagesTable)
          .where(eq(supportTicketMessagesTable.ticketId, ticket.id))
          .orderBy(desc(supportTicketMessagesTable.createdAt))
          .limit(20);

        // Compute SLA status
        let slaStatus: 'breached' | 'at_risk' | 'healthy' | 'no_sla' = 'no_sla';
        let hoursRemaining: number | null = null;
        if (ticket.slaDeadline) {
          const now = new Date();
          const deadline = new Date(ticket.slaDeadline);
          const diffMs = deadline.getTime() - now.getTime();
          hoursRemaining = Math.round(diffMs / (1000 * 60 * 60) * 10) / 10;
          if (ticket.status === 'resolved' || ticket.status === 'closed') {
            slaStatus = ticket.resolvedAt && new Date(ticket.resolvedAt) <= deadline ? 'healthy' : 'breached';
          } else if (diffMs < 0) {
            slaStatus = 'breached';
          } else if (hoursRemaining < 4) {
            slaStatus = 'at_risk';
          } else {
            slaStatus = 'healthy';
          }
        }

        return { ...ticket, messages, slaStatus, hoursRemaining };
      })
    );

    return res.json({ success: true, tickets: ticketsWithMessages });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get contact tickets');
    return res.status(500).json({ error: 'Failed to fetch tickets' });
  }
};

// ─── Alerts ──────────────────────────────────────────────────────────────────

export const getAlertEventTypes = async (_req: Request, res: Response) => {
  return res.json({ success: true, data: ALERT_EVENT_TYPES });
};

export const getAlerts = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const alerts = await alertService.getAlerts(userId);
    return res.json({ success: true, data: alerts });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get alerts');
    return res.status(500).json({ error: 'Failed to fetch alerts' });
  }
};

export const createAlert = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { name, description, eventType, conditions, notifyUser, notifyContact } = req.body;
    if (!name || !eventType) return res.status(400).json({ error: 'Name and event type are required' });

    const alert = await alertService.createAlert(userId, {
      name, description, eventType, conditions, notifyUser, notifyContact,
    });
    return res.status(201).json({ success: true, data: alert });
  } catch (error) {
    logger.error({ err: error }, 'Failed to create alert');
    return res.status(500).json({ error: 'Failed to create alert' });
  }
};

export const updateAlert = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const alertId = Number(req.params.id);
    if (isNaN(alertId)) return res.status(400).json({ error: 'Invalid alert ID' });

    const updated = await alertService.updateAlert(userId, alertId, req.body);
    if (!updated) return res.status(404).json({ error: 'Alert not found' });
    return res.json({ success: true, data: updated });
  } catch (error) {
    logger.error({ err: error }, 'Failed to update alert');
    return res.status(500).json({ error: 'Failed to update alert' });
  }
};

export const deleteAlert = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const alertId = Number(req.params.id);
    if (isNaN(alertId)) return res.status(400).json({ error: 'Invalid alert ID' });

    const deleted = await alertService.deleteAlert(userId, alertId);
    if (!deleted) return res.status(404).json({ error: 'Alert not found' });
    return res.json({ success: true });
  } catch (error) {
    logger.error({ err: error }, 'Failed to delete alert');
    return res.status(500).json({ error: 'Failed to delete alert' });
  }
};

export const getAlertLogs = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const alertId = req.params.id ? Number(req.params.id) : undefined;
    const logs = await alertService.getAlertLogs(userId, alertId);
    return res.json({ success: true, data: logs });
  } catch (error) {
    logger.error({ err: error }, 'Failed to get alert logs');
    return res.status(500).json({ error: 'Failed to fetch alert logs' });
  }
};

// ─── Sync Contacts → Email Outreach Leads ────────────────────────────────────

/**
 * POST /api/crm/contacts/sync-to-leads
 * Copies selected CRM contacts into the leads table so they appear in Email Outreach.
 * Skips contacts whose email already exists as a lead for this user.
 */
export const syncContactsToLeads = async (req: Request, res: Response) => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const { contactIds } = req.body as { contactIds?: number[] };

    // Fetch contacts with email addresses (not soft-deleted)
    const baseConditions = [eq(crmContactsTable.userId, userId), isNull(crmContactsTable.deletedAt)];
    if (contactIds?.length) {
      baseConditions.push(inArray(crmContactsTable.id, contactIds));
    }
    const contacts = await db
      .select({
        id: crmContactsTable.id,
        leadId: crmContactsTable.leadId,
        firstName: crmContactsTable.firstName,
        lastName: crmContactsTable.lastName,
        email: crmContactsTable.email,
        phone: crmContactsTable.phone,
        company: crmContactsTable.company,
        role: crmContactsTable.role,
      })
      .from(crmContactsTable)
      .where(and(...baseConditions))
      .limit(500);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withEmail = contacts.filter((c: any) => c.email);
    if (!withEmail.length) {
      return res.json({ success: true, synced: 0, skipped: contacts.length, message: 'No contacts with email addresses to sync' });
    }

    // Find emails that already exist as leads for this user
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const emails = withEmail.map((c: any) => c.email as string);
    const existing = await db
      .select({ id: leadsTable.id, email: leadsTable.email })
      .from(leadsTable)
      .where(and(eq(leadsTable.userId, userId), inArray(leadsTable.email, emails)));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const leadByEmail = new Map<string, number>(existing.filter((r: any) => r.email).map((r: any) => [r.email as string, r.id as number]));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toInsert = withEmail.filter((c: any) => !leadByEmail.has(c.email!));
    let synced = 0;
    if (toInsert.length) {
      const inserted = await db.insert(leadsTable).values(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toInsert.map((c: any) => ({
          userId,
          source: 'crm_sync',
          firstName: c.firstName || null,
          lastName: c.lastName || null,
          fullName: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
          email: c.email!,
          phone: c.phone || null,
          company: c.company || null,
          companyName: c.company || null,
          role: c.role || null,
          status: 'new',
        }))
      ).returning({ id: leadsTable.id, email: leadsTable.email });

      for (const lead of inserted) {
        if (lead.email) leadByEmail.set(lead.email, lead.id);
      }
      synced = toInsert.length;
    }

    // For existing leads (including already outreached contacts), update details to sync with CRM Contact details
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existingEmails = withEmail.filter((c: any) => leadByEmail.has(c.email!));
    for (const c of existingEmails) {
      const leadId = leadByEmail.get(c.email!);
      if (leadId) {
        await db
          .update(leadsTable)
          .set({
            firstName: c.firstName || null,
            lastName: c.lastName || null,
            fullName: [c.firstName, c.lastName].filter(Boolean).join(' ') || null,
            phone: c.phone || null,
            company: c.company || null,
            companyName: c.company || null,
            role: c.role || null,
            updatedAt: new Date(),
          })
          .where(and(eq(leadsTable.id, leadId), eq(leadsTable.userId, userId)));
      }
    }

    const linkedLeads: Array<{ contactId: number; leadId: number; email: string }> = [];
    for (const contact of withEmail) {
      const leadId = contact.email ? leadByEmail.get(contact.email) : undefined;
      if (!leadId) continue;

      linkedLeads.push({ contactId: contact.id, leadId, email: contact.email! });

      if (contact.leadId !== leadId) {
        await db
          .update(crmContactsTable)
          .set({ leadId, updatedAt: new Date() })
          .where(and(eq(crmContactsTable.id, contact.id), eq(crmContactsTable.userId, userId)));
      }
    }

    const skipped = contacts.length - synced;
    return res.json({
      success: true,
      synced,
      skipped,
      leads: linkedLeads,
      message: `${synced} contact${synced !== 1 ? 's' : ''} added to Email Outreach${skipped ? `, ${skipped} already existed or had no email` : ''}`,
    });
  } catch (error) {
    logger.error({ err: error }, 'Failed to sync contacts to leads');
    return res.status(500).json({ error: 'Failed to sync contacts to Email Outreach' });
  }
};

/** Contacts that share a phone or email, for the owner to review and merge. */
export const getDuplicateContacts = async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const { listDuplicateContacts } = await import('../services/CRMDuplicateContactsService.js');
    return res.json({ success: true, data: await listDuplicateContacts(userId) });
  } catch (error) {
    logger.error({ err: error }, 'Failed to list duplicate CRM contacts');
    return res.status(500).json({ error: 'Possible duplicates could not be loaded.' });
  }
};

/** Merge contact :id into body.intoContactId, which is kept. */
export const mergeContact = async (req: Request, res: Response) => {
  const { ContactMergeError, mergeDuplicateContact } = await import('../services/CRMDuplicateContactsService.js');
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    const result = await mergeDuplicateContact(userId, Number(req.params.id), Number(req.body?.intoContactId));
    return res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ContactMergeError) return res.status(error.status).json({ error: error.message });
    logger.error({ err: error }, 'Failed to merge CRM contacts');
    return res.status(500).json({ error: 'The contacts could not be merged. Nothing was changed.' });
  }
};
