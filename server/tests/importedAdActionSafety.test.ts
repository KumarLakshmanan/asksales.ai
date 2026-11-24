import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { db } from '../models/db.js';
import { AutonomousAdsActionProcessor } from '../services/ads/AutonomousAdsActionProcessor.js';

type InternalProcessor = {
  recoverStaleClaims(): Promise<void>;
  processPendingNotifications(limit: number): Promise<void>;
  claim(): Promise<Record<string, unknown> | null>;
  loadCampaign(action: Record<string, unknown>): Promise<Record<string, unknown>>;
  cancelAction(action: Record<string, unknown>, reason: string): Promise<void>;
  processAction(action: Record<string, unknown>): Promise<void>;
  deferAction(action: Record<string, unknown>, reason: string): Promise<void>;
};
const previousGate = process.env.AD_PROVIDER_MUTATIONS_ENABLED;
afterEach(() => {
  jest.restoreAllMocks();
  if (previousGate === undefined) delete process.env.AD_PROVIDER_MUTATIONS_ENABLED;
  else process.env.AD_PROVIDER_MUTATIONS_ENABLED = previousGate;
});

describe('reporting import action boundary', () => {
  function setup(campaign: Record<string, unknown>) {
    // Simulate an execution-enabled server in memory. No network/provider is invoked.
    process.env.AD_PROVIDER_MUTATIONS_ENABLED = 'true';
    const processor = new AutonomousAdsActionProcessor();
    const methods = processor as unknown as InternalProcessor;
    jest.spyOn(methods, 'recoverStaleClaims').mockResolvedValue();
    jest.spyOn(methods, 'processPendingNotifications').mockResolvedValue();
    jest.spyOn(methods, 'claim').mockResolvedValue({ id: 1, user_id: 9, campaign_id: 13, action_type: 'pause', payload: {}, rationale: 'Normalized provider spend reached the stored campaign lifetime cap.' });
    jest.spyOn(methods, 'loadCampaign').mockResolvedValue(campaign);
    const cancel = jest.spyOn(methods, 'cancelAction').mockResolvedValue();
    const execute = jest.spyOn(methods, 'processAction').mockResolvedValue();
    jest.spyOn(db, 'execute').mockResolvedValue({ rows: [{ live_provider_mutations_enabled: true }] });
    return { processor, cancel, execute };
  }
  it.each([
    { budget_type: 'lifetime', settings: { importedProviderCampaign: true } },
    { budget_type: 'daily', settings: {} },
  ])('cancels legacy cap actions that lack lifetime-budget authority: %j', async campaign => {
    const { processor, cancel, execute } = setup(campaign);
    await expect(processor.processBatch(1)).resolves.toEqual({ processed: 0, failed: 0, gated: 0 });
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), expect.stringContaining('do not authorize'));
    expect(execute).not.toHaveBeenCalled();
  });
  it('preserves lifetime-cap protection for campaigns created through the normal publishing flow', async () => {
    const { processor, cancel, execute } = setup({ budget_type: 'lifetime', settings: {} });
    await expect(processor.processBatch(1)).resolves.toEqual({ processed: 1, failed: 0, gated: 0 });
    expect(cancel).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('keeps monitoring active when the environment blocks a pause', async () => {
    delete process.env.AD_PROVIDER_MUTATIONS_ENABLED;
    const processor = new AutonomousAdsActionProcessor();
    const methods = processor as unknown as InternalProcessor;
    jest.spyOn(methods, 'recoverStaleClaims').mockResolvedValue();
    jest.spyOn(methods, 'processPendingNotifications').mockResolvedValue();
    const execute = jest.spyOn(db, 'execute').mockResolvedValue({ rows: [{ id: 1, campaign_id: 13, user_id: 9, action_type: 'pause' }] });
    await expect(processor.processBatch(1)).resolves.toEqual({ processed: 0, failed: 0, gated: 1 });
    // Only the queue is deferred; campaign/allocation delivery state is preserved.
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it('keeps monitoring active when the tenant blocks a claimed pause', async () => {
    const processor = new AutonomousAdsActionProcessor();
    const methods = processor as unknown as InternalProcessor;
    const execute = jest.fn<typeof db.execute>().mockResolvedValue({ rows: [{ id: 1 }] });
    jest.spyOn(db, 'transaction').mockImplementation(async callback =>
      (callback as (tx: typeof db) => Promise<unknown>)({ execute } as typeof db));
    await methods.deferAction({ id: 1, action_type: 'pause', locked_by: 'qa', lease_locked_at: '2026-11-02 00:00:00' }, 'Tenant live provider mutations are disabled');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});
