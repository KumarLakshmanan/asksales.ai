import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DEFAULT_CRM_CONFIGURATION } from '../../shared/crmConfiguration.js';
import { mockAuthRequest, mockRequest, mockResponse } from './helpers/mockHelpers.js';

const service = {
  getContacts: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  getContactById: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  createContact: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  updateContact: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  softDeleteContact: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  convertLeadToContact: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
  updatePipelineStatus: jest.fn<(...args: unknown[]) => Promise<unknown>>(),
};
const trigger = jest.fn<(...args: unknown[]) => Promise<void>>();
const savedResponse=jest.fn<any>();
jest.unstable_mockModule('../services/automations/ContactAutomationHandoff.js',()=>({savedContactResponse:savedResponse,contactAutomationHandoff:jest.fn(),listContactAutomationHandoffs:jest.fn()}));
const fireEvent = jest.fn<(...args: unknown[]) => Promise<void>>();
jest.unstable_mockModule('../services/CRMService.js', () => ({ crmService: service }));
jest.unstable_mockModule('../services/AutomationService.js', () => ({ automationService: { evaluateTriggers: trigger } }));
jest.unstable_mockModule('../services/ReminderService.js', () => ({ reminderService: {} }));
jest.unstable_mockModule('../services/AlertService.js', () => ({ alertService: { fireEvent }, ALERT_EVENT_TYPES: [] }));
jest.unstable_mockModule('../services/CRMConfigurationService.js', () => ({
  getCrmConfiguration: async () => DEFAULT_CRM_CONFIGURATION,
  CrmConfigurationError: class extends Error { constructor(message: string, public status: number) { super(message); } },
}));
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() } }));
const controller = await import('../controllers/crmController.js');
const request = (overrides: Parameters<typeof mockRequest>[0] = {}) => mockAuthRequest(73, { params: { id: '19', leadId: '20' }, ...overrides });

describe('CRM: contact and pipeline controller boundaries', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    for (const mock of Object.values(service)) mock.mockResolvedValue({ id: 19 });
    trigger.mockResolvedValue(undefined);
    savedResponse.mockImplementation(async(_user:number,contact:unknown)=>contact);
    fireEvent.mockResolvedValue(undefined);
  });
  it.each(['getContacts', 'getContact', 'createContact', 'updateContact', 'deleteContact', 'convertLeadToContact', 'updatePipelineStatus'] as const)('%s rejects an unauthenticated request before service access', async (method) => {
    const res = mockResponse();
    await controller[method](request({ user: undefined }), res);
    expect(res._status).toBe(401);
    for (const mock of Object.values(service)) expect(mock).not.toHaveBeenCalled();
  });
  it.each(['0', '-1', '1.5', 'abc', '9007199254740992'])('rejects invalid thread ID %s', async (threadId) => {
    const res = mockResponse();
    await controller.getContacts(request({ query: { threadId } }), res);
    expect(res._status).toBe(400);
    expect(service.getContacts).not.toHaveBeenCalled();
  });
  it('passes the authenticated tenant and parsed filters to contact lookup', async () => {
    const res = mockResponse();
    service.getContacts.mockResolvedValue({ data: [{ id: 19 }], total: 1 });
    await controller.getContacts(request({ query: { threadId: '9', page: '2', limit: '10', search: 'Ada' } }), res);
    expect(service.getContacts).toHaveBeenCalledWith(73, expect.objectContaining({ threadId: 9, page: 2, limit: 10, search: 'Ada' }));
    expect(res._json).toEqual({ success: true, data: [{ id: 19 }], total: 1 });
  });
  it.each([{}, { name: '  ', email: '', phone: '\t' }])('rejects a contact with no usable identity: %j', async (body) => {
    const res = mockResponse();
    await controller.createContact(request({ body }), res);
    expect(res._status).toBe(400);
    expect(service.createContact).not.toHaveBeenCalled();
  });
  it('creates a contact for the authenticated tenant and fires its alert', async () => {
    const res = mockResponse();
    await controller.createContact(request({ body: { email: 'ada@example.test' } }), res);
    expect(res._status).toBe(201);
    expect(service.createContact).toHaveBeenCalledWith(73, { email: 'ada@example.test' });
    expect(fireEvent).toHaveBeenCalledWith(73, 'contact_created', { contactId: 19 });
  });
  it.each([['getContact', 'getContactById'], ['updateContact', 'updateContact'], ['deleteContact', 'softDeleteContact'], ['convertLeadToContact', 'convertLeadToContact']] as const)('%s returns 404 when tenant-scoped lookup misses', async (method, dependency) => {
    service[dependency].mockResolvedValue(null);
    const res = mockResponse();
    await controller[method](request(), res);
    expect(res._status).toBe(404);
    expect(service[dependency].mock.calls[0][0]).toBe(73);
  });
  it('runs automation after a contact status change', async () => {
    const res = mockResponse();
    service.getContactById.mockResolvedValueOnce({ id: 19, status: 'new' });
    service.updateContact.mockResolvedValueOnce({ id: 19, status: 'active', automationTransitionId:7 });
    await controller.updateContact(request({ body: { status: 'active' } }), res);
    expect(res._status).toBe(200);
    expect(service.updateContact).toHaveBeenCalledWith(73,19,{status:'active'},{recoverableAutomation:true});
    expect(savedResponse).toHaveBeenCalledWith(73,{id:19,status:'active',automationTransitionId:7});
  });
  it.each(['', 'invalid', 'WON'])('rejects invalid pipeline status %s without mutation', async (pipelineStatus) => {
    const res = mockResponse();
    await controller.updatePipelineStatus(request({ body: { pipelineStatus } }), res);
    expect(res._status).toBe(400);
    expect(service.updatePipelineStatus).not.toHaveBeenCalled();
  });
  it.each(DEFAULT_CRM_CONFIGURATION.stages.map(stage=>stage.key))('accepts pipeline stage %s and runs automation', async (pipelineStatus) => {
    const res = mockResponse();
    service.getContactById.mockResolvedValueOnce({ id: 19, pipelineStatus: 'new' });
    service.updatePipelineStatus.mockResolvedValueOnce({ id: 19, pipelineStatus });
    await controller.updatePipelineStatus(request({ body: { pipelineStatus } }), res);
    expect(res._status).toBe(200);
    expect(service.updatePipelineStatus).toHaveBeenCalledWith(73, 19, pipelineStatus,{recoverableAutomation:'pipeline'});
    expect(savedResponse).toHaveBeenCalledWith(73,{id:19,pipelineStatus});
  });
  it('returns a generic error when the contact service fails', async () => {
    service.getContacts.mockRejectedValue(new Error('private database detail'));
    const res = mockResponse();
    await controller.getContacts(request(), res);
    expect(res._status).toBe(500);
    expect(JSON.stringify(res._json)).not.toContain('private database detail');
  });
});
