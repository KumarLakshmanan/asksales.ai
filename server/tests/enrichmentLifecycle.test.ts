import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const runActor = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const updateRun = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const updateStep = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const updateLead = jest.fn<(...args: unknown[]) => Promise<unknown>>();
const order: string[] = [];
let finish: (phase: string) => void = () => {};
let terminal: Promise<string>;
jest.unstable_mockModule('../services/agents/ApifyService.js', () => ({ ApifyService: { createWithAdminCredentials: async () => ({ runActor }) } }));
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {} }));
jest.unstable_mockModule('../services/WebsiteCrawlerService.js', () => ({ WebsiteCrawlerService: class {} }));
jest.unstable_mockModule('../services/enrichment/billing.js', () => ({
  reserveHandleEnrichment: async () => ({ run: { id: 101, leadId: 7 }, created: true, credits: 0 }),
  markHandleProviderDispatch: async () => {}, finishHandleReservation: async () => {}, finishEnrichmentReservation: async () => {},
}));
jest.unstable_mockModule('../services/enrichment/deepExecution.js', () => ({
  reserveDeepEnrichment: async () => ({run:{id:101},created:true,credits:0}),
  loadDeepEnrichment: async () => ({run:{id:101},created:false,credits:0}),
  claimDeepEnrichment: async () => ({id:101}), deepInputMatches: () => true,
  failedDeepResult: (error: string) => ({success:false,iterations:0,totalHandlesProcessed:0,aggregatedData:{},iterationLog:[],error}),
}));
jest.unstable_mockModule('../services/StorageTrackingHooks.js', () => ({ trackGeneratedOutput: async () => {} }));
jest.unstable_mockModule('../models/icpData/schema.js', () => ({ icpProfilesTable: { id: 'id' } }));
jest.unstable_mockModule('../models/leads/schema.js', () => ({ leadsTable: { id: 'id' } }));
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  insert: () => ({ values: () => ({ returning: async () => [{ id: 7 }] }) }),
  select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ id: 7, userId: 1, twitterHandle: 'qa_subject' }] }) }) }),
} }));
jest.unstable_mockModule('../models/leads/functions.js', () => ({ LeadModel: { update: updateLead } }));
jest.unstable_mockModule('../models/enrichmentRuns/functions.js', () => ({ createEnrichmentRun: async () => ({ id: 101 }), getEnrichmentRunById: async () => ({id:101}), updateEnrichmentRun: updateRun }));
jest.unstable_mockModule('../models/enrichmentSteps/functions.js', () => ({ createEnrichmentStep: async () => ({ id: 201 }), updateEnrichmentStep: updateStep }));
jest.unstable_mockModule('../events/EventBus.js', () => ({ eventBus: { emitToolEvent: async (phase: string, payload: { data?: { runId?: number } }) => {
  order.push(`event:${phase}:${payload.data?.runId}`);
  if (phase === 'completed' || phase === 'failed') finish(phase);
} } }));
const { enrichByHandle } = await import('../services/enrichment/enrichByHandle.js');
const { LeadEnrichmentOrchestrator } = await import('../services/enrichment/orchestrator.js');

describe('enrichment lifecycle with mocked providers and persistence', () => {
  beforeEach(() => {
    order.length = 0;
    terminal = new Promise(resolve => { finish = resolve; });
    runActor.mockReset().mockResolvedValue({ success: true, items: [] });
    updateLead.mockReset().mockResolvedValue(undefined);
    updateStep.mockReset().mockResolvedValue(undefined);
    updateRun.mockReset().mockImplementation(async (_id, update) => { order.push(`save:${(update as { status: string }).status}`); });
  });
  it('saves an empty success before announcing completion and includes the run id', async () => {
    expect(await enrichByHandle(1, 'twitter', 'qa_subject')).toEqual(expect.objectContaining({ runId: 101 }));
    expect(await terminal).toBe('completed');
    expect(order.indexOf('save:completed')).toBeLessThan(order.indexOf('event:completed:101'));
    expect(updateStep).toHaveBeenCalledWith(201, expect.objectContaining({ status: 'completed', itemsCount: 0 }));
  });
  it('does not convert provider failure into an empty successful run', async () => {
    runActor.mockResolvedValue({ success: false, error: 'Provider unavailable', items: [] });
    await enrichByHandle(1, 'twitter', 'qa_subject');
    expect(await terminal).toBe('failed');
    expect(updateStep).toHaveBeenCalledWith(201, expect.objectContaining({ status: 'failed' }));
    expect(order).not.toContain('save:completed');
    expect(order).not.toContain('event:completed:101');
  });
  it('terminates thrown provider errors as failures', async () => {
    runActor.mockRejectedValue(new Error('Network unavailable'));
    await enrichByHandle(1, 'twitter', 'qa_subject');
    expect(await terminal).toBe('failed');
  });
  it('never announces success if the summary could not be saved', async () => {
    updateRun.mockImplementation(async (_id, update) => {
      if ((update as { status: string }).status === 'completed') throw new Error('Database unavailable');
    });
    await enrichByHandle(1, 'twitter', 'qa_subject');
    expect(await terminal).toBe('failed');
    expect(order).not.toContain('event:completed:101');
  });
  it('still reports failure to the UI when status persistence is unavailable', async () => {
    updateRun.mockRejectedValue(new Error('Database unavailable'));
    await enrichByHandle(1, 'twitter', 'qa_subject');
    expect(await terminal).toBe('failed');
    expect(order).not.toContain('event:completed:101');
  });
  it('marks deep enrichment failed when every provider fails', async () => {
    runActor.mockResolvedValue({ success: false, error: 'Provider unavailable', items: [] });
    const result = await new LeadEnrichmentOrchestrator().enrichLead(1, 7);
    expect(result.success).toBe(false);
    expect(await terminal).toBe('failed');
    expect(updateRun).toHaveBeenCalledWith(101, expect.objectContaining({ status: 'failed' }));
    expect(order).not.toContain('event:completed:101');
  });
  it('does not leave the activity running after a lead-update exception', async () => {
    const orchestrator = new LeadEnrichmentOrchestrator();
    jest.spyOn(orchestrator as unknown as { updateLeadWithEnrichment: () => Promise<void> }, 'updateLeadWithEnrichment').mockRejectedValue(new Error('Write unavailable'));
    const result = await orchestrator.enrichLead(1, 7);
    expect(result.success).toBe(false);
    expect(await terminal).toBe('failed');
    expect(updateRun).toHaveBeenCalledWith(101, expect.objectContaining({ status: 'failed' }));
  });
});
