import { installReadyCustomerDeliveryMock, installReadyCustomerJobMock } from './helpers/readyCustomerDelivery.js';
installReadyCustomerDeliveryMock(); installReadyCustomerJobMock();
import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';
const select = jest.fn<any>();
const values = jest.fn<any>();
const updatePipeline = jest.fn<any>();
const ticket = jest.fn<any>();
jest.unstable_mockModule('../models/db', () => ({ db: { select, insert: () => ({ values }) } }));
jest.unstable_mockModule('../services/CRMService.js', () => ({ crmService: { updatePipelineStatus: updatePipeline } }));
jest.unstable_mockModule('../services/SupportService', () => ({ supportService: { createTicket: ticket } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn() } }));
const { automationService } = await import('../services/AutomationService.js');
const rule = { id: 1, triggerConfig: { fromStatus: 'new', toStatus: 'interested' }, condition: {}, action: 'update_pipeline_status', actionConfig: { pipelineStatus: 'won' } };
const inProfile = <T>(work: () => T) => withBusinessScope({ userId: 9, businessProfileId: 42 }, work);
describe('CRM automation execution', () => {
  beforeEach(() => {
    jest.resetAllMocks();
    select.mockReturnValue({ from: () => ({ where: () => ({ orderBy: async () => [rule] }) }) });
    updatePipeline.mockResolvedValue({ id: 42 });
  });
  it('runs a matching transition through the shared pipeline service and logs success', async () => {
    await inProfile(() => automationService.evaluateTriggers(9, 42, { type: 'pipeline_status_change', oldValue: 'new', newValue: 'interested' }));
    expect(updatePipeline).toHaveBeenCalledWith(9, 42, 'won');
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ userId: 9, contactId: 42, result: 'success' }));
  });
  it('does not run when the source stage does not match', async () => {
    await inProfile(() => automationService.evaluateTriggers(9, 42, { type: 'pipeline_status_change', oldValue: 'contacted', newValue: 'interested' }));
    expect(updatePipeline).not.toHaveBeenCalled();
    expect(values).not.toHaveBeenCalled();
  });
  it('logs a failure when the contact no longer exists', async () => {
    updatePipeline.mockResolvedValue(null);
    await inProfile(() => automationService.evaluateTriggers(9, 42, { type: 'pipeline_status_change', oldValue: 'new', newValue: 'interested' }));
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ result: 'failed', errorMessage: 'Contact not found' }));
  });
  it('rejects a missing or mismatched business scope before running any actions', async () => {
    const event = { type: 'pipeline_status_change', oldValue: 'new', newValue: 'interested' };
    await expect(automationService.evaluateTriggers(9, 42, event)).rejects.toThrow('A business profile is required');
    await expect(inProfile(() => automationService.evaluateTriggers(19, 42, event))).rejects.toThrow('does not match');
    expect(select).not.toHaveBeenCalled();
    expect(updatePipeline).not.toHaveBeenCalled();
  });
});
