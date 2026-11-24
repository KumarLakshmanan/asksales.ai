import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { DEFAULT_CRM_CONFIGURATION, type CrmConfiguration } from '../../shared/crmConfiguration.js';
import { UNCHANGED_CRM_DECISION, type CrmStageDecision } from '../../shared/crmPipeline.js';
import type { ToolOutcome } from '../services/agents/BaseOutreachAgent.js';
import { withBusinessScope } from '../tenancy/businessContext.js';

let configuration: CrmConfiguration;
let contact: { id: number; pipelineStatus: string; status: string };
const getConfiguration = jest.fn<() => Promise<CrmConfiguration>>();
const getContact = jest.fn<() => Promise<typeof contact | null>>();
const updatePipeline = jest.fn<(owner: number, id: number, key: string, options?: unknown) => Promise<typeof contact>>();
const savedResponse = jest.fn<(owner: number, saved: typeof contact) => Promise<typeof contact>>();
const execute = jest.fn<(query: SQL) => Promise<{ rows: Record<string, unknown>[] }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/CRMConfigurationService.js', () => ({ getCrmConfiguration: getConfiguration }));
jest.unstable_mockModule('../services/CRMService.js', () => ({ crmService: { getContactById: getContact, updatePipelineStatus: updatePipeline } }));
jest.unstable_mockModule('../services/automations/ContactAutomationHandoff.js', () => ({ savedContactResponse: savedResponse }));
const { applySupportCrmStage, supportCrmPipelineContext } = await import('../services/agents/orchestration/SupportCRMPipeline.js');
const decision: CrmStageDecision = { stageKey: 'signed', outcome: 'won', evidence: 'explicit_acceptance', confidence: 0.99 };
const tool = (overrides: Partial<ToolOutcome> = {}): ToolOutcome => ({
  name: 'check_payment_status', args: {}, status: 'success', success: true,
  confirmedSideEffect: false, result: { paid: true, booking_id: 77 }, ...overrides,
});
beforeEach(() => {
  jest.resetAllMocks();
  configuration = { stages: [DEFAULT_CRM_CONFIGURATION.stages[0],
    { key: 'discovery', label: 'Discovery call', type: 'active', color: '#8b5cf6', inFlow: true },
    { key: 'signed', label: 'Contract accepted', type: 'won', color: '#10b981', inFlow: false },
    { key: 'declined', label: 'Offer declined', type: 'lost', color: '#f59e0b', inFlow: true }],
    preferences: structuredClone(DEFAULT_CRM_CONFIGURATION.preferences) };
  contact = { id: 12, pipelineStatus: 'discovery', status: 'interested' };
  getConfiguration.mockImplementation(async () => structuredClone(configuration));
  getContact.mockImplementation(async () => ({ ...contact }));
  updatePipeline.mockImplementation(async (_owner, _id, key) => { contact.pipelineStatus = key; return { ...contact }; });
  savedResponse.mockImplementation(async (_owner, saved) => ({ ...saved }));
  execute.mockResolvedValue({ rows: [{ pipeline_status: 'discovery' }] });
});

describe('support agent commits configured CRM stages', () => {
  it('uses the shared saved-response contract and captures only actual automatic stage changes', async () => {
    const result = await applySupportCrmStage(9, 12, { decision });
    expect(result).toMatchObject({ changed: true, stage: { key: 'signed', type: 'won' } });
    expect(updatePipeline).toHaveBeenCalledWith(9, 12, 'signed', { automatic: true, expectedStageType: 'won', recoverableAutomation: 'pipeline' });
    expect(savedResponse).toHaveBeenCalledWith(9, expect.objectContaining({ id: 12, pipelineStatus: 'signed' }));
    await applySupportCrmStage(9, 12, { decision });
    expect(updatePipeline).toHaveBeenLastCalledWith(9, 12, 'signed', { automatic: true, expectedStageType: 'won', recoverableAutomation: false });
  });

  it('revalidates a deferred decision after its stage was removed or changed to Active', async () => {
    configuration.stages = configuration.stages.filter(stage => stage.key !== 'signed');
    expect(await applySupportCrmStage(9, 12, { decision })).toMatchObject({ changed: false });
    configuration.stages.push({ key: 'signed', label: 'Contract accepted', type: 'active', color: '#10b981', inFlow: true });
    expect(await applySupportCrmStage(9, 12, { decision })).toMatchObject({ changed: false });
    expect(updatePipeline).not.toHaveBeenCalled();
    expect(savedResponse).not.toHaveBeenCalled();
  });

  it('uses verified payment evidence with the current configured Won stage', async () => {
    configuration.stages[2].key = 'paid_contract';
    const applied = await applySupportCrmStage(9, 12, { decision: UNCHANGED_CRM_DECISION, tools: [tool()] });
    expect(applied?.contact.pipelineStatus).toBe('paid_contract');
  });
  it.each([
    { name: 'create_booking', result: { booked: true }, key: 'signed' },
    { name: 'cancel_booking', result: { cancelled: true }, key: 'declined' },
  ])('uses a confirmed $name receipt to select the configured outcome', async ({ name, result, key }) => {
    const applied = await applySupportCrmStage(9, 12, {
      decision: UNCHANGED_CRM_DECISION, tools: [tool({ name, result, confirmedSideEffect: true })],
    });
    expect(applied?.contact.pipelineStatus).toBe(key);
  });

  it.each([
    { status: 'failed', success: false }, { status: 'blocked', success: true },
    { status: 'success', success: true, result: { paid: false } },
    { name: 'create_booking', status: 'success', success: true, confirmedSideEffect: false, result: { booked: true, status: 'proposed' } },
  ] as Partial<ToolOutcome>[])('does not close a deal from failed/uncommitted tool evidence: %j', async overrides => {
    await applySupportCrmStage(9, 12, { legacyStage: 'won', tools: [tool(overrides)] });
    expect(updatePipeline).not.toHaveBeenCalled();
  });

  it('preserves a closed custom stage during later support progress', async () => {
    contact.pipelineStatus = 'declined';
    const applied = await applySupportCrmStage(9, 12, { decision: {
      stageKey: 'discovery', outcome: 'active', evidence: 'progress', confidence: 1,
    }, tools: [tool()] });
    expect(applied?.contact.pipelineStatus).toBe('declined');
    expect(updatePipeline).toHaveBeenLastCalledWith(9, 12, 'declined', { automatic: true, expectedStageType: 'lost', recoverableAutomation: false });
  });

  it('passes a bounded catalog and explicitly scopes the conversation to the owner and profile', async () => {
    const result = await withBusinessScope({ userId: 9, businessProfileId: 42, actorUserId: 99 },
      () => supportCrmPipelineContext(9, 21, 7));
    expect(result.currentStageKey).toBe('discovery');
    expect(result.stages[2]).toEqual({ key: 'signed', label: 'Contract accepted', type: 'won' });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain('contact.business_profile_id');
    expect(query.sql).toContain('conversation.business_profile_id');
    expect(query.params).toEqual([9, 42, 21, 9, 42, 21, 7]);
  });

  it('leaves the CRM unchanged when configuration cannot be loaded', async () => {
    getConfiguration.mockRejectedValueOnce(new Error('Profile unavailable'));
    await expect(applySupportCrmStage(9, 12, { decision })).rejects.toThrow('Profile unavailable');
    expect(updatePipeline).not.toHaveBeenCalled();
    expect(savedResponse).not.toHaveBeenCalled();
  });
});
