import type { Request, Response } from 'express';
import { ZodError } from 'zod';
import { businessOwnerUserId } from '../tenancy/businessContext.js';
import { logger } from '../utils/logger.js';
const workspace = async () => (await import('../services/CRMWorkspaceService.js')).crmWorkspaceService;
import { getCrmAssignees } from '../services/CRMAssigneeService.js';
import { CrmConfigurationError } from '../services/CRMConfigurationService.js';
import { crmService } from '../services/CRMService.js';
import { savedContactResponse, contactAutomationHandoff, listContactAutomationHandoffs } from '../services/automations/ContactAutomationHandoff.js';
import { CampaignWorkspaceError } from '../services/CampaignWorkspaceService.js';
import { normalizeCapacityError } from '../services/billing/entitlements.js';
import { crmBulkContactSchema, crmContactsQuerySchema, crmHistoryQuerySchema, crmReportQuerySchema,
  crmWorkQuerySchema } from '../utils/crmWorkspaceValidation.js';

type Work = (req: Request, userId: number) => Promise<Record<string, unknown>>;
const handler = (work: Work) => async (req: Request, res: Response) => {
  try {
    const userId = businessOwnerUserId(req);
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });
    return res.json({ success: true,...await work(req,userId) });
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ error: 'Invalid request',
      details: error.issues.map(item => ({ field: item.path.join('.'),message: item.message })) });
    if (error instanceof CrmConfigurationError) return res.status(error.status).json({ error: error.message });
    if (error instanceof CampaignWorkspaceError) return res.status(error.status).json({ error: error.message });
    const capacityError = normalizeCapacityError(error);
    if (capacityError) return res.status(capacityError.status).json(capacityError.toJSON());
    logger.error({ err: error,path: req.path }, 'Failed to load CRM workspace');
    // Reads must not claim that a save failed. A statement timeout is replaced
    // by the shared 504 answer (databaseAvailability) before this body is sent.
    const read = req.method === 'GET' || req.method === 'HEAD';
    return res.status(500).json({ error: read ? 'The CRM data could not be loaded. Try again.' : 'The CRM workspace could not be updated. Please try again.' });
  }
};

export const getAssignees = handler(async (_req,userId) => {
  const users = await getCrmAssignees(userId);
  return { data: users };
});
export const getPaginatedActivities = handler(async (req,userId) => (await workspace()).activities(userId,Number(req.params.contactId),crmHistoryQuerySchema.parse(req.query)));
export const getPaginatedConversations = handler(async (req,userId) => (await workspace()).conversations(userId,Number(req.params.id),crmHistoryQuerySchema.parse(req.query)));
export const getPaginatedTickets = handler(async (req,userId) => (await workspace()).tickets(userId,Number(req.params.id),crmHistoryQuerySchema.parse(req.query)));
export const getContactConversationMessages = handler(async (req,userId) => (await workspace()).conversationMessages(userId,Number(req.params.id),Number(req.params.conversationId),crmHistoryQuerySchema.parse(req.query)));
export const getWorkspaceSummary = handler(async (req,userId) => ({ data: await (await workspace()).summary(userId,Number(req.params.id)) }));
export const getWorkspaceTimeline = handler(async (req,userId) => (await workspace()).timeline(userId,Number(req.params.id),crmHistoryQuerySchema.parse(req.query)));
export const getWork = handler(async (req,userId) => (await workspace()).work(userId,crmWorkQuerySchema.parse(req.query)));
export const getReports = handler(async (req,userId) => ({ data: await (await workspace()).reports(userId,crmReportQuerySchema.parse(req.query)) }));
export const exportContacts = handler(async (req,userId) => (await workspace()).exportContacts(userId,crmContactsQuerySchema.parse(req.query)));
export const getBoardSummary = handler(async (req,userId) => {
  const result = await crmService.getContacts(userId,{ ...crmContactsQuerySchema.parse(req.query),page: 1,limit: 1 });
  return { stages: result.stages,total: result.total,dealValueByCurrency: result.dealValueByCurrency };
});
export const bulkUpdateContacts = handler(async (req,userId) => {
  const result = await crmService.bulkUpdateContacts(userId,crmBulkContactSchema.parse(req.body),{recoverableAutomation:'pipeline'});
  const contacts = [];
  for (const contact of result.contacts) contacts.push(await savedContactResponse(userId,contact));
  return { data: { contacts,updatedCount:result.updatedCount,
    refreshRequired:contacts.some(contact=>contact.refreshRequired),
    automationReviewRequired:contacts.some(contact=>contact.automationReviewRequired) } };
});

export const getAutomationHandoffs = handler(async (req,userId) => {
  const query = crmHistoryQuerySchema.parse(req.query);
  const contact = await crmService.getContactById(userId,Number(req.params.id));
  if (!contact) throw new CrmConfigurationError('Contact not found',404);
  return listContactAutomationHandoffs(userId,contact.id,query.page,query.limit);
});
export const retryAutomationHandoff = handler(async (req,userId) => {
  const contact = await crmService.getContactById(userId,Number(req.params.id));
  if (!contact) throw new CrmConfigurationError('Contact not found',404);
  const handoff = await contactAutomationHandoff(userId,contact.id,Number(req.params.transitionId),true);
  if (!handoff) throw new CrmConfigurationError('Automation recovery checkpoint not found',404);
  return {data:handoff};
});
