import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';

const assignees = jest.fn<any>();
const bulk = jest.fn<any>();
const getContacts = jest.fn<any>();
const exportContacts = jest.fn<any>();
const work = jest.fn<any>();
const evaluateTriggers = jest.fn<any>();
const savedResponse=jest.fn<any>();
jest.unstable_mockModule('../services/automations/ContactAutomationHandoff.js',()=>({savedContactResponse:savedResponse,contactAutomationHandoff:jest.fn(),listContactAutomationHandoffs:jest.fn()}));
class CrmConfigurationError extends Error {
  constructor(message: string,public readonly status: number) { super(message); }
}
jest.unstable_mockModule('../models/db.js',()=>({ db: {} }));
jest.unstable_mockModule('../services/CRMConfigurationService.js',()=>({ CrmConfigurationError }));
jest.unstable_mockModule('../services/CRMAssigneeService.js',()=>({ getCrmAssignees: assignees }));
jest.unstable_mockModule('../services/CRMService.js',()=>({ crmService: { bulkUpdateContacts: bulk,getContacts } }));
jest.unstable_mockModule('../services/CRMWorkspaceService.js',()=>({ crmWorkspaceService: { exportContacts,work } }));
jest.unstable_mockModule('../services/AutomationService.js',()=>({ automationService: { evaluateTriggers } }));
jest.unstable_mockModule('../utils/logger.js',()=>({ logger: { error: jest.fn(),warn: jest.fn() } }));
const controller = await import('../controllers/crmWorkspaceController.js');
const { CampaignWorkspaceError } = await import('../services/CampaignWorkspaceService.js');
async function invoke(method: keyof typeof controller,body: unknown={},query: Record<string,unknown>={}) {
  const res = { status: jest.fn(),json: jest.fn() };
  res.status.mockReturnValue(res);
  await controller[method]({ user: { id: 9 },params: {},body,query,path: '/api/crm/contacts' } as unknown as Request,res as unknown as Response);
  return res;
}

describe('CRM workspace controller contracts',()=>{
  beforeEach(()=>{ jest.resetAllMocks(); });
  it('returns a bare-array-compatible assignee envelope',async()=>{
    const members = [{ id: 9,name: 'Owner',email: 'owner@example.test',role: 'owner' }];
    assignees.mockResolvedValue(members);
    const response = await invoke('getAssignees');
    expect(response.json).toHaveBeenCalledWith({ success: true,data: members });
  });
  it('preserves a wrapped plan-limit error when a bulk virtual contact cannot materialize',async()=>{
    bulk.mockRejectedValue({ cause: { code: 'P0001',detail: JSON.stringify({ code: 'PLAN_LIMIT_EXCEEDED',resource: 'contacts',
      current: 5000,requestedIncrease: 1,limit: 5000,organizationId: 7 }) } });
    const response = await invoke('bulkUpdateContacts',{ contactIds: [-30],assignedTo: null });
    expect(response.status).toHaveBeenCalledWith(403);
    expect(response.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'PLAN_LIMIT_EXCEEDED',resource: 'contacts',current: 5000 }));
    expect(evaluateTriggers).not.toHaveBeenCalled();
  });
  it('preserves campaign ownership errors on export and board summary',async()=>{
    const error = new CampaignWorkspaceError('Campaign workspace not found.');
    exportContacts.mockRejectedValue(error); getContacts.mockRejectedValue(error);
    for (const method of ['exportContacts','getBoardSummary'] as const) {
      const response = await invoke(method,{}, { threadId: '82' });
      expect(response.status).toHaveBeenCalledWith(404);
      expect(response.json).toHaveBeenCalledWith({ error: error.message });
    }
  });
  it('reports a failed read as a load failure, never as a save failure',async()=>{
    work.mockRejectedValue(new Error('boom'));
    const res = { status: jest.fn(),json: jest.fn() };
    res.status.mockReturnValue(res);
    await controller.getWork({ method: 'GET',user: { id: 9 },params: {},body: {},query: {},path: '/api/crm/work' } as unknown as Request,res as unknown as Response);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: 'The CRM data could not be loaded. Try again.' });
  });
  it('does not misreport committed bulk edits as failures when automation dispatch fails',async()=>{
    const contacts = [{ id: 1,pipelineStatus: 'won' }];
    bulk.mockResolvedValue({ contacts,updatedCount: 1,transitions: [{ contactId: 1,oldStatus: 'new',newStatus: 'won' }] });
    savedResponse.mockResolvedValue({...contacts[0],automationReviewRequired:true});
    const response = await invoke('bulkUpdateContacts',{ contactIds: [1],pipelineStatus: 'won' });
    expect(response.status).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({ success: true,data: { contacts:[{...contacts[0],automationReviewRequired:true}],updatedCount: 1,refreshRequired:false,automationReviewRequired:true } });
    expect(savedResponse).toHaveBeenCalledWith(9,contacts[0]);
    expect(bulk).toHaveBeenCalledWith(9,{contactIds:[1],pipelineStatus:'won'},{recoverableAutomation:'pipeline'});
  });
});
