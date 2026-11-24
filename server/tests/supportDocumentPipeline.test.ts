import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import type { ApprovedSupportDocument } from '../services/supportDocuments/ApprovedSupportDocuments.js';

const doc: ApprovedSupportDocument = { id: 20, userId: 9, storageFileId: 250, businessProfileId: null,
  title: 'Day outing brochure', service: 'day_outing', checksum: 'a'.repeat(64) };
const find = jest.fn<any>(async () => doc);
const deliver = jest.fn<any>(async () => ({ status: 'sent', actionId: 80, providerMessageId: 'wamid.document' }));
const sendText = jest.fn<any>();
const claim = jest.fn<any>();
jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../models/aiAgentConfigs/functions.js', () => ({
  getActiveAiAgentConfig:async()=>({enabled:true,channelScope:['whatsapp'],metadata:{platformAutoReplies:{whatsapp:true}}}),
}));
jest.unstable_mockModule('../services/StorageService.js', () => ({ storageService: {} }));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: { sendText } }));
jest.unstable_mockModule('../services/agents/orchestration/DeliveryOutboxService.js', () => ({ deliveryOutboxService: { claim } }));
// This suite exercises the enabled document path; assistant freshness is covered separately.
jest.unstable_mockModule('../services/agents/orchestration/SupportAutoReplyService.js', () => ({
  automaticSupportReplyAllowed: async () => true,
  socialDraftChannel: (channel: string) => ['whatsapp','instagram','facebook'].includes(channel.replace(/_comment$/, '')),
}));
jest.unstable_mockModule('../services/supportDocuments/SupportDocumentDelivery.js', () => ({ supportDocumentDelivery: { deliver } }));
const { approvedSupportDocuments } = await import('../services/supportDocuments/ApprovedSupportDocuments.js');
jest.spyOn(approvedSupportDocuments,'candidates').mockImplementation(async (...args: any[]) => {
  const document = await find(...args);
  return document ? [{ document, description: 'Approved document for the requested topic', libraryId: 1 }] : [];
});
jest.spyOn(approvedSupportDocuments,'revalidate').mockResolvedValue(true);
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({ LLMProviderFactory: {
  createChatCompletionWithFallback: async () => ({ content: '{"documentId":20,"confidence":0.99}' }),
} }));
const { DocumentRetrievalStage } = await import('../services/agents/pipeline/stages/DocumentRetrievalStage.js');
const { DeliveryStage } = await import('../services/agents/pipeline/stages/DeliveryStage.js');
const retrieval = new DocumentRetrievalStage(); const delivery = new DeliveryStage();
const context = (): PipelineContext => ({
  message: { userId: 9, conversationId: 615, channel: 'whatsapp', senderIdentifier: 'qa-recipient', inboundText: 'Synthetic paraphrase', rawMessageId: 'inbound-1' },
  metadata: { conversationMode: 'ai_active', playbookDirective: { runId: 0, readOnlyInformation: true } },
  nlu: { semanticRequest: { action: 'document', service: 'day_outing', explicit: true, topicSwitch: true,
    pricingRequested: false, media: 'none', confidence: 0.99 } } as PipelineContext['nlu'],
  agentResult: { replyText: 'Please see the requested document for the published details.', escalated: false, confidence: 1 },
  confidence: 1, policyViolations: [],
});
beforeEach(() => {
  jest.clearAllMocks(); find.mockResolvedValue(doc);
  deliver.mockResolvedValue({ status: 'sent', actionId: 80, providerMessageId: 'wamid.document' });
});
describe('document retrieval and channel pipeline integration', () => {
  it('selects PDFs for authenticated customer webchat but not an owner preview', async () => {
    const ctx = context(); ctx.message.channel = 'web'; ctx.message.conversationId = -21;
    ctx.message.metadata = { conversationKind:'support_widget',widgetSession:{id:21,token:'private-session'} };
    await retrieval.execute(ctx); expect(ctx.approvedDocument).toEqual(doc);
    find.mockClear(); ctx.message.metadata = { executionMode:'preview',widgetSession:{id:21,token:'private-session'} };
    await retrieval.execute(ctx); expect(find).not.toHaveBeenCalled(); expect(ctx.approvedDocument).toBeUndefined();
  });
  it.each(['resort', 'day_outing'])('delivers the approved %s PDF from a published menu selection, without a document keyword', async service => {
    const ctx = context(); ctx.message.inboundText = service === 'resort' ? '1' : '4';
    ctx.nlu!.semanticRequest = undefined;
    ctx.metadata!.playbookDirective = { runId: 323, nodeType: 'capability',
      documentService: service, capability: { name: 'asset.deliver', kind: 'context' } };
    const selected = { ...doc, service }; find.mockResolvedValue(selected);
    ctx.agentResult!.replyText = 'Please see the brochure for the published details.\n\nWhat would you like next?\n1. More information\n2. Callback';
    await retrieval.execute(ctx); await delivery.execute(ctx);
    expect(find).toHaveBeenCalledWith(9,null,service);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ document: selected, caption: expect.stringContaining('2. Callback') }));
    expect(ctx.metadata!.documentDelivery.status).toBe('sent');
    expect(sendText).not.toHaveBeenCalled();
  });
  it.each(['web', 'instagram', 'facebook'])('does not advertise WhatsApp-only menu delivery on %s', async channel => {
    const ctx = context(); ctx.message.channel = channel as any; ctx.nlu!.semanticRequest = undefined;
    ctx.metadata!.playbookDirective = { documentService: 'resort', capability: { name: 'asset.deliver', kind: 'context' } };
    await retrieval.execute(ctx); expect(find).not.toHaveBeenCalled(); expect(ctx.approvedDocument).toBeUndefined();
  });
  it.each(['human_owned', 'approval_pending', 'opted_out'])('keeps menu PDFs suppressed in %s', async mode => {
    const ctx = context(); ctx.metadata!.conversationMode = mode;
    ctx.metadata!.playbookDirective = { documentService: 'resort', capability: { name: 'asset.deliver', kind: 'context' } };
    await retrieval.execute(ctx); expect(find).not.toHaveBeenCalled();
  });
  it('looks up the exact AI-classified topic and sends a single PDF with the verified caption', async () => {
    const ctx = context(); await retrieval.execute(ctx); await delivery.execute(ctx);
    expect(find).toHaveBeenCalledWith(9,null,'day_outing');
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ document: doc, caption: ctx.agentResult!.replyText, inboundProviderMessageId: 'inbound-1' }));
    expect(ctx.metadata!.deliveryStatus).toBe('sent');
    expect(ctx.metadata!.externalMessageId).toBe('wamid.document');
    expect(sendText).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
  });
  it('does not substitute a resort or day-outing PDF for a corporate request', async () => {
    const ctx = context(); ctx.nlu!.semanticRequest!.service = 'corporate'; find.mockResolvedValue(null);
    await retrieval.execute(ctx);
    expect(find).toHaveBeenCalledWith(9,null,'corporate'); expect(ctx.approvedDocument).toBeUndefined();
  });
  it('does not replace an invalid published document selector with a model-selected topic', async () => {
    const ctx = context();
    ctx.metadata!.playbookDirective = { documentService: 'invented_service',
      capability: { name: 'asset.deliver', kind: 'context', validationErrors: ['Invalid configured service'] } };
    await retrieval.execute(ctx); expect(find).not.toHaveBeenCalled(); expect(ctx.approvedDocument).toBeUndefined();
  });
  it.each(['human_owned','approval_pending','opted_out'])('does not select documents in %s mode', async mode => {
    const ctx = context(); ctx.metadata!.conversationMode = mode; ctx.approvedDocument = doc;
    await retrieval.execute(ctx); expect(ctx.approvedDocument).toBeUndefined(); expect(find).not.toHaveBeenCalled();
  });
  it('never sends on a preview/dry run', async () => {
    const ctx = context(); ctx.message.metadata = { executionMode: 'preview', dryRun: true }; ctx.approvedDocument = doc;
    await delivery.execute(ctx); expect(deliver).not.toHaveBeenCalled(); expect(sendText).not.toHaveBeenCalled();
    expect(ctx.metadata!.deliveryStatus).toBe('simulated');
  });
  it('does not advertise an automatic attachment on a forced-manual-approval turn', async () => {
    const ctx = context(); ctx.message.metadata = { forceApproval: true };
    await retrieval.execute(ctx); expect(ctx.approvedDocument).toBeUndefined(); expect(find).not.toHaveBeenCalled();
  });
  it.each(['unavailable','uncertain'])('does not report success or send a second reply after %s document delivery', async status => {
    const ctx = context(); ctx.approvedDocument = doc; deliver.mockResolvedValue({ status, actionId: 80 });
    await expect(delivery.execute(ctx)).rejects.toMatchObject({ outcome: 'blocked' });
    expect(ctx.metadata!.deliveryStatus).toBe(status); expect(sendText).not.toHaveBeenCalled(); expect(claim).not.toHaveBeenCalled();
  });
  it('fails closed if document lookup is unavailable', async () => {
    find.mockRejectedValue(new Error('Registry unavailable'));
    const ctx = context(); await retrieval.execute(ctx); expect(ctx.approvedDocument).toBeUndefined();
  });
});
