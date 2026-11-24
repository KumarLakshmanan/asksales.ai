import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { PostProcessingStage } from '../services/agents/pipeline/stages/PostProcessingStage.js';
import { supportPreviewStore } from '../services/agents/orchestration/SupportPreviewStore.js';
import { playbookEngine } from '../services/agents/orchestration/PlaybookEngine.js';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';

afterEach(() => { jest.restoreAllMocks(); });
describe('brochure information has no journey or business effects', () => {
  it.each(['sent', 'unavailable', 'uncertain', undefined])('advances a menu document only with an acknowledged file, status=%s', async status => {
    const commit = jest.spyOn(playbookEngine, 'commitProposedTransition').mockResolvedValue(true);
    const stage = new PostProcessingStage();
    jest.spyOn(stage as any, 'executeOnce').mockResolvedValue(undefined);
    const ctx = { message: { userId: 9, conversationId: 615, metadata: { executionMode: 'customer' } },
      metadata: { deliveryStatus: 'sent', ownerHandoffPolicy: { mode: 'customer_requests_only' },
        documentDelivery: { status, actionId: 80, providerMessageId: 'wamid.document' },
        playbookDirective: { runId: 323, capability: { name: 'asset.deliver', kind: 'context' } } },
      agentResult: { replyText: 'Document and next-step menu.', effectProposals: [] },
    } as unknown as PipelineContext;
    await stage.execute(ctx);
    if (status === 'sent') {
      expect(commit).toHaveBeenCalledWith(9, 323, expect.objectContaining({ capabilityName: 'asset.deliver', deliveryStatus: 'sent' }));
    } else {
      expect(commit).not.toHaveBeenCalled();
      expect(ctx.metadata!.playbookTransitionReason).toBe('document_delivery_not_confirmed');
    }
  });
  it('does not advance on a document success label without a provider receipt', async () => {
    const commit = jest.spyOn(playbookEngine, 'commitProposedTransition').mockResolvedValue(true);
    const stage = new PostProcessingStage();
    jest.spyOn(stage as any, 'executeOnce').mockResolvedValue(undefined);
    const ctx = { message: { userId: 9, conversationId: 615, metadata: { executionMode: 'customer' } },
      metadata: { deliveryStatus: 'sent', ownerHandoffPolicy: { mode: 'customer_requests_only' }, documentDelivery: { status: 'sent' },
        playbookDirective: { runId: 323, capability: { name: 'asset.deliver', kind: 'context' } } },
      agentResult: { replyText: 'Document and next-step menu.', effectProposals: [] },
    } as unknown as PipelineContext;
    await stage.execute(ctx);
    expect(commit).not.toHaveBeenCalled();
  });
  it('suppresses deferred CRM and reminder effects even without a reconstructed directive', async () => {
    const stage = new PostProcessingStage();
    const effects = jest.spyOn(stage as any, 'executeOnce').mockResolvedValue(undefined);
    const ctx = { message: { userId: 9, conversationId: 68, channel: 'web' },
      metadata: { deliveryStatus: 'sent', suppressBusinessEffects: true },
      agentResult: { replyText: 'Verified information only.', crmPipelineStatus: 'qualified',
        scheduleReminder: { title: 'Must not run' }, effectProposals: [] },
    } as unknown as PipelineContext;
    await stage.execute(ctx);
    expect(effects).not.toHaveBeenCalled();
  });
  it.each(['preview', 'customer'])('does not commit an older pending transition in %s', async executionMode => {
    const preview = jest.spyOn(supportPreviewStore, 'commit').mockResolvedValue(undefined);
    const commit = jest.spyOn(playbookEngine, 'commitProposedTransition').mockResolvedValue(true);
    const stage = new PostProcessingStage();
    const effects = jest.spyOn(stage as any, 'executeOnce').mockResolvedValue(undefined);
    const ctx = { message: { userId: 9, conversationId: 68, rawMessageId: 'brochure-read',
      metadata: { executionMode, dryRun: executionMode === 'preview' } },
      metadata: { deliveryStatus: executionMode === 'preview' ? 'simulated' : 'sent',
        // Even an existing run ID must not let this answer commit a prior proposal.
        playbookDirective: { runId: 308, readOnlyInformation: true, capability: { name: 'knowledge.answer', kind: 'tool' } } },
      agentResult: { replyText: 'Verified information only.', effectProposals: [] },
    } as unknown as PipelineContext;
    expect(await stage.execute(ctx)).toBe(ctx);
    expect(preview).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
    expect(effects).not.toHaveBeenCalled();
  });
});
