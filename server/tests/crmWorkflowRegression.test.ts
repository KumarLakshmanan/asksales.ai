import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { Request, Response } from 'express';
import { crmReminderSchema, crmAutomationSchema, crmAlertSchema } from '../middleware/schemas.js';
import { DEFAULT_CRM_CONFIGURATION, type CrmConfiguration } from '../../shared/crmConfiguration.js';

const getContact = jest.fn<any>();
const updatePipeline = jest.fn<any>();
const updateContact = jest.fn<any>();
const evaluate = jest.fn<any>();
const savedResponse=jest.fn<any>();
jest.unstable_mockModule('../services/automations/ContactAutomationHandoff.js',()=>({savedContactResponse:savedResponse,contactAutomationHandoff:jest.fn(),listContactAutomationHandoffs:jest.fn()}));
const materialize = jest.fn<any>();
const createReminder = jest.fn<any>();
const importCSV = jest.fn<any>();
const getConfiguration = jest.fn<(userId: number) => Promise<CrmConfiguration>>();
class CrmConfigurationError extends Error {
  constructor(message: string, public readonly status: number) { super(message); }
}
jest.unstable_mockModule('../services/CRMConfigurationService.js', () => ({ getCrmConfiguration: getConfiguration, CrmConfigurationError }));
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../services/CRMService.js', () => ({ crmService: {
  getContactById: getContact, updatePipelineStatus: updatePipeline, updateContact,
  materializeContactReference: materialize, importContactsFromCSV: importCSV,
} }));
jest.unstable_mockModule('../services/AutomationService.js', () => ({ automationService: { evaluateTriggers: evaluate } }));
jest.unstable_mockModule('../services/ReminderService.js', () => ({ reminderService: { createActivityReminder: createReminder } }));
jest.unstable_mockModule('../services/AlertService.js', () => ({ alertService: {}, ALERT_EVENT_TYPES: [] }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn() } }));
const controller = await import('../controllers/crmController.js');
async function invoke(method: keyof typeof controller, body: unknown, extra = {}) {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  await (controller[method] as (request: Request, response: Response) => unknown)({ user: { id: 9 }, params: { id: '-77' }, body, ...extra } as unknown as Request, res as unknown as Response);
  return res;
}

describe('CRM workflow regressions', () => {
  beforeEach(() => { jest.resetAllMocks(); getConfiguration.mockResolvedValue(structuredClone(DEFAULT_CRM_CONFIGURATION)); savedResponse.mockImplementation(async(user:number,contact:any)=>await getContact(user,contact.id)||contact); });
  it('rejects a removed legacy stage and preserves a stage-conflict response', async () => {
    const configuration = structuredClone(DEFAULT_CRM_CONFIGURATION);
    configuration.stages = configuration.stages.filter(stage => stage.key !== 'demo');
    getConfiguration.mockResolvedValue(configuration);
    const removed = await invoke('updatePipelineStatus', { pipelineStatus: 'demo' });
    expect(removed.status).toHaveBeenCalledWith(400);
    expect(updatePipeline).not.toHaveBeenCalled();
    getContact.mockResolvedValue({ id: 42, pipelineStatus: 'new' });
    updatePipeline.mockRejectedValueOnce(new CrmConfigurationError('Stage changed before commit.', 409));
    const conflict = await invoke('updatePipelineStatus', { pipelineStatus: 'contacted' });
    expect(conflict.status).toHaveBeenCalledWith(409);
    expect(conflict.json).toHaveBeenCalledWith({ error: 'Stage changed before commit.' });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('accepts a saved custom stage and keeps pipeline automations running after the move', async () => {
    const configuration = structuredClone(DEFAULT_CRM_CONFIGURATION);
    configuration.stages.push({ key: 'qualified', label: 'Qualified', type: 'active', color: '#ec4899', inFlow: true });
    getConfiguration.mockResolvedValue(configuration);
    getContact.mockResolvedValueOnce({ id: 42, pipelineStatus: 'new' }).mockResolvedValueOnce({ id: 42, pipelineStatus: 'qualified' });
    updatePipeline.mockResolvedValue({ id: 42, pipelineStatus: 'qualified' });
    const res = await invoke('updatePipelineStatus', { pipelineStatus: 'qualified' });
    expect(getConfiguration).toHaveBeenCalledWith(9);
    expect(updatePipeline).toHaveBeenCalledWith(9, -77, 'qualified',{recoverableAutomation:'pipeline'});
    expect(savedResponse).toHaveBeenCalledWith(9,{id:42,pipelineStatus:'qualified'});
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: 42, pipelineStatus: 'qualified' } });
  });
  it('rejects a stage absent from the saved configuration before changing contacts or creating rules', async () => {
    getConfiguration.mockResolvedValue(structuredClone(DEFAULT_CRM_CONFIGURATION));
    const move = await invoke('updatePipelineStatus', { pipelineStatus: 'missing_stage' });
    expect(move.status).toHaveBeenCalledWith(400);
    expect(updatePipeline).not.toHaveBeenCalled();
    const rule = await invoke('createAutomation', { action: 'update_pipeline_status', actionConfig: { pipelineStatus: 'missing_stage' } });
    expect(rule.status).toHaveBeenCalledWith(400);
  });
  it('passes old and new pipeline stages and returns the final automation result', async () => {
    getContact.mockResolvedValueOnce({ id: -77, pipelineStatus: 'new' }).mockResolvedValueOnce({ id: 42, pipelineStatus: 'won' });
    updatePipeline.mockResolvedValue({ id: 42, pipelineStatus: 'interested' });
    const res = await invoke('updatePipelineStatus', { pipelineStatus: 'interested' });
    expect(savedResponse).toHaveBeenCalledWith(9,{id:42,pipelineStatus:'interested'});
    expect(res.json).toHaveBeenCalledWith({ success: true, data: { id: 42, pipelineStatus: 'won' } });
  });
  it('does not run pipeline rules when the stage is unchanged', async () => {
    getContact.mockResolvedValue({ id: 42, pipelineStatus: 'won' });
    updatePipeline.mockResolvedValue({ id: 42, pipelineStatus: 'won' });
    await invoke('updatePipelineStatus', { pipelineStatus: 'won' });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('does not run contact status rules when saving the same status', async () => {
    getContact.mockResolvedValue({ id: 42, status: 'new' });
    updateContact.mockResolvedValue({ id: 42, status: 'new' });
    await invoke('updateContact', { status: 'new' });
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('returns a structured organization limit response through a wrapped database error', async () => {
    getContact.mockResolvedValue({ id: 42, status: 'new' });
    updateContact.mockRejectedValue({ cause: { code: 'P0001', detail: JSON.stringify({
      code: 'PLAN_LIMIT_EXCEEDED', resource: 'contacts', current: 5000,
      requestedIncrease: 1, limit: 5000, organizationId: 7,
    }) } });
    const res = await invoke('updateContact', { status: 'new' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PLAN_LIMIT_EXCEEDED', resource: 'contacts', current: 5000,
      requestedIncrease: 1, limit: 5000, organizationId: 7,
    }));
    expect(evaluate).not.toHaveBeenCalled();
  });
  it('supports general and virtual-contact reminders while rejecting zero references', async () => {
    const fields = { title: 'Follow up', dueDate: '2030-01-02T04:30:00.000Z' };
    expect(crmReminderSchema.safeParse(fields).success).toBe(true);
    expect(crmReminderSchema.safeParse({ ...fields, contactId: -77 }).success).toBe(true);
    expect(crmReminderSchema.safeParse({ ...fields, contactId: 0 }).success).toBe(false);
    materialize.mockResolvedValue({ id: 42 });
    createReminder.mockResolvedValue({ id: 8 });
    await invoke('createReminder', { ...fields, contactId: -77 });
    expect(materialize).toHaveBeenCalledWith(9, -77, 'crm_reminder');
    expect(createReminder).toHaveBeenCalledWith(9, expect.objectContaining({ contactId: 42, reminderDueAt: new Date(fields.dueDate) }));
  });
  it('rejects blank rule names', () => {
    expect(crmAutomationSchema.safeParse({ name: ' ', triggerType: 'status_change', action: 'create_ticket' }).success).toBe(false);
    expect(crmAlertSchema.safeParse({ name: ' ', eventType: 'deal_won' }).success).toBe(false);
  });
  it.each([
    ['email,email\na@example.test,Acme', '{}'],
    ['email,company\na@example.test,Acme', 'null'],
    ['email,company\na@example.test,Acme', '[]'],
    ['email,company\na@example.test,Acme', '{"missing":"email","company":"company"}'],
  ])('rejects unsafe import headers or mapping before persistence', async (csv, mapping) => {
    const res = await invoke('importContacts', { columnMapping: mapping }, { file: { originalname: 'contacts.csv', buffer: Buffer.from(csv) } });
    expect(res.status).toHaveBeenCalledWith(400);
    expect(importCSV).not.toHaveBeenCalled();
  });
  it('passes a phone-only customer import without email or company mappings', async () => {
    importCSV.mockResolvedValue({importId:8,totalRecords:1,successCount:1});
    const res=await invoke('importContacts',{columnMapping:JSON.stringify({Name:'firstName',Mobile:'phone'})},{file:{originalname:'guests.csv',buffer:Buffer.from('Name,Mobile\nGuest,+919876543210\n')}});
    expect(importCSV).toHaveBeenCalledWith(9,[{Name:'Guest',Mobile:'+919876543210'}],{Name:'firstName',Mobile:'phone'},'guests.csv');
    expect(res.json).toHaveBeenCalledWith({success:true,data:{importId:8,totalRecords:1,successCount:1}});
  });
  it('rejects name-only files before starting an import', async () => {
    const res=await invoke('importContacts',{columnMapping:JSON.stringify({Name:'firstName'})},{file:{originalname:'guests.csv',buffer:Buffer.from('Name\nGuest\n')}});
    expect(res.status).toHaveBeenCalledWith(400);
    expect(importCSV).not.toHaveBeenCalled();
  });
});
