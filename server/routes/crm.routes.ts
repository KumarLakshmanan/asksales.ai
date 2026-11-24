import { preserveAsyncContext } from '../middleware/preserveAsyncContext.js';
import {contactWorkbookUpload} from '../middleware/contactWorkbookUpload.js';
import {contactAnalysisOperation} from '../controllers/contactAnalysisController.js';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { authenticateToken } from '../middleware/auth.js';
import { requireModuleAccess } from '../middleware/platformAccess.js';
import { statementTimeout } from '../tenancy/statementTimeout.js';
import { getConfiguration, updateConfiguration } from '../controllers/crmConfigurationController.js';
import {getCatalog,getAutomation,testAutomation,getRuns,getRun} from '../controllers/crmAutomationsController.js';
import { validateBody, validateParams } from '../middleware/validation.js';
import {
  crmContactSchema,
  crmContactCreateSchema,
  crmActivitySchema,
  crmAutomationSchema,
  crmReminderSchema,
  crmAlertSchema,
  crmContactSyncSchema,
} from '../middleware/schemas.js';
import {
  getContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  convertLeadToContact,
  getActivities,
  addActivity,
  updateActivity,
  importContacts,
  getImportStatus,
  getCrmAnalytics,
  getAutomations,
  createAutomation,
  updateAutomation,
  deleteAutomation,
  getAutomationLogs,
  getReminders,
  createReminder,
  updateReminder,
  deleteReminder,
  getPipelineStages,
  updatePipelineStatus,
  analyzeSentimentAndUpdatePipeline,
  getPipelineAnalytics,
  getContactConversations,
  getContactTickets,
  getAlertEventTypes,
  getAlerts,
  createAlert,
  updateAlert,
  deleteAlert,
  getAlertLogs,
  syncContactsToLeads,
  getDuplicateContacts,
  mergeContact,
} from '../controllers/crmController.js';

import { getAssignees, getWorkspaceSummary, getWorkspaceTimeline, getContactConversationMessages,
  getAutomationHandoffs,retryAutomationHandoff,getWork, getReports, exportContacts, bulkUpdateContacts, getBoardSummary } from '../controllers/crmWorkspaceController.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const contactRefParams = z.object({ id: z.coerce.number().int().refine((value) => value !== 0, 'Contact ID cannot be zero') });
const contactActivityParams = z.object({ contactId: z.coerce.number().int().refine((value) => value !== 0, 'Contact ID cannot be zero') });
const positiveIdParams = z.object({ id: z.coerce.number().int().positive() });
const positiveLeadIdParams = z.object({ leadId: z.coerce.number().int().positive() });

router.use(authenticateToken, requireModuleAccess('crm'));
// These dashboard reads scan the whole visible contact set. Bound each
// statement so an abandoned page load cannot pin pool connections for every
// other API request (see tenancy/statementTimeout.ts).
const boundedRead = statementTimeout();
// Board, My work and Reports aggregate the whole visible contact set. Their
// bound is shorter than the general read bound so a slow build answers with a
// retryable timeout before the page's client deadline (see crmWorkspaceController).
export const CRM_HEAVY_READ_TIMEOUT_MS = 12_000;
const heavyCrmRead = statementTimeout(CRM_HEAVY_READ_TIMEOUT_MS);

router.get('/contact-analysis',contactAnalysisOperation);
router.get('/contact-analysis/stored-files',contactAnalysisOperation);
router.post('/contact-analysis/from-files',contactAnalysisOperation);
router.post('/contact-analysis',preserveAsyncContext((req,res,next)=>contactWorkbookUpload(req,res,error=>error ? res.status(400).json({error:error instanceof Error ? error.message : 'Contact files could not be uploaded.'}) : next())),contactAnalysisOperation);
router.get('/contact-analysis/:operationId',contactAnalysisOperation);
router.get('/contact-analysis/:operationId/rows',contactAnalysisOperation);
router.post('/contact-analysis/:operationId/import',contactAnalysisOperation);
router.post('/contact-analysis/:operationId/reanalyze',contactAnalysisOperation);
router.post('/contact-analysis/:operationId/resume',contactAnalysisOperation);

// Configuration belongs to the selected business profile.
router.get('/configuration', getConfiguration);
router.put('/configuration', updateConfiguration);

// Workspace collections and literal paths must precede :id routes.
router.get('/assignees', getAssignees);
router.get('/work', heavyCrmRead, getWork);
router.get('/reports', heavyCrmRead, getReports);
router.get('/contacts/export', exportContacts);
router.get('/contacts/duplicates', boundedRead, getDuplicateContacts);
router.post('/contacts/:id/merge', validateParams(positiveIdParams), validateBody(z.object({ intoContactId: z.coerce.number().int().positive() })), mergeContact);
router.post('/contacts/bulk', bulkUpdateContacts);
router.get('/contacts/:id/automation-handoffs', validateParams(contactRefParams), getAutomationHandoffs);
router.post('/contacts/:id/automation-handoffs/:transitionId/retry', validateParams(contactRefParams.extend({ transitionId:z.coerce.number().int().positive().max(2147483647) })), retryAutomationHandoff);
router.get('/contacts/:id/workspace-summary', validateParams(contactRefParams), getWorkspaceSummary);
router.get('/contacts/:id/timeline', validateParams(contactRefParams), getWorkspaceTimeline);
router.get('/contacts/:id/conversations/:conversationId/messages', validateParams(contactRefParams.extend({ conversationId: z.coerce.number().int().positive() })), getContactConversationMessages);

// Contacts
router.get('/contacts', boundedRead, getContacts);
router.get('/contacts/:id', validateParams(contactRefParams), getContact);
router.post('/contacts', validateBody(crmContactCreateSchema), createContact);
router.put('/contacts/:id', validateParams(contactRefParams), validateBody(crmContactSchema.partial()), updateContact);
router.delete('/contacts/:id', validateParams(contactRefParams), deleteContact);
router.post('/contacts/from-lead/:leadId', validateParams(positiveLeadIdParams), convertLeadToContact);
router.post('/contacts/sync-to-leads', validateBody(crmContactSyncSchema), syncContactsToLeads);

// CSV Import
router.post('/contacts/import', preserveAsyncContext(upload.single('file')), importContacts);
router.get('/imports/:id', validateParams(positiveIdParams), getImportStatus);

// Conversations (all channels)
router.get('/contacts/:id/conversations', validateParams(contactRefParams), getContactConversations);

// Support tickets
router.get('/contacts/:id/tickets', validateParams(contactRefParams), getContactTickets);

// Activities
router.get('/contacts/:contactId/activities', validateParams(contactActivityParams), getActivities);
router.post('/contacts/:contactId/activities', validateParams(contactActivityParams), validateBody(crmActivitySchema), addActivity);
router.patch('/activities/:id', validateParams(positiveIdParams), validateBody(crmActivitySchema.partial()), updateActivity);

// Analytics
router.get('/analytics', boundedRead, getCrmAnalytics);

// Automations
router.get('/automations', getAutomations);
router.get('/automations/catalog',getCatalog);
router.post('/automations/test',testAutomation);
router.get('/automations/runs/:runId',validateParams(z.object({runId:z.coerce.number().int().positive()})),getRun);
router.get('/automations/:id/runs',validateParams(positiveIdParams),getRuns);
router.post('/automations', validateBody(crmAutomationSchema), createAutomation);
router.put('/automations/:id', validateParams(positiveIdParams), validateBody(crmAutomationSchema.partial()), updateAutomation);
router.delete('/automations/:id', validateParams(positiveIdParams), deleteAutomation);
router.get('/automations/logs', getAutomationLogs);
router.get('/automations/:id/logs', validateParams(positiveIdParams), getAutomationLogs);
router.get('/automations/:id',validateParams(positiveIdParams),getAutomation);

// Reminders
router.get('/reminders', getReminders);
router.post('/reminders', validateBody(crmReminderSchema), createReminder);
router.put('/reminders/:id', validateParams(positiveIdParams), validateBody(crmReminderSchema.partial()), updateReminder);
router.delete('/reminders/:id', validateParams(positiveIdParams), deleteReminder);

// Pipeline
router.get('/pipeline/stages', getPipelineStages);
router.get('/pipeline/summary', heavyCrmRead, getBoardSummary);
router.get('/pipeline/analytics', heavyCrmRead, getPipelineAnalytics);
router.patch('/contacts/:id/pipeline-status', validateParams(contactRefParams), updatePipelineStatus);
router.post('/contacts/:id/analyze-sentiment', validateParams(contactRefParams), analyzeSentimentAndUpdatePipeline);

// Alerts
router.get('/alerts/event-types', getAlertEventTypes);
router.get('/alerts', getAlerts);
router.post('/alerts', validateBody(crmAlertSchema), createAlert);
router.put('/alerts/:id', validateParams(positiveIdParams), validateBody(crmAlertSchema.partial()), updateAlert);
router.delete('/alerts/:id', validateParams(positiveIdParams), deleteAlert);
router.get('/alerts/logs', getAlertLogs);
router.get('/alerts/:id/logs', validateParams(positiveIdParams), getAlertLogs);

export default router;
