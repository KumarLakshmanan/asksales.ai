import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const findLead = jest.fn<(...args: any[]) => Promise<any>>();
const resolveCampaign = jest.fn<(...args: any[]) => Promise<any>>();
const generateCampaign = jest.fn<(...args: any[]) => Promise<any>>();
const routeSupport = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../models/leads/functions.js', () => ({ LeadModel: { findByIdForUser: findLead } }));
jest.unstable_mockModule('../services/agents/orchestration/PrivacyVaultService.js', () => ({ redactPiiWithStableTokens: (text: string) => ({ redactedText: text }) }));
jest.unstable_mockModule('../services/agents/AgentRouter.js', () => ({ agentRouter: { handle: routeSupport } }));
jest.unstable_mockModule('../services/outreach/CampaignEmailReplyService.js', () => ({
  conversationCampaignReplyContext: resolveCampaign, generateCampaignEmailReply: generateCampaign,
}));
const { generateConfiguredReplyPreview } = await import('../services/agents/ConfiguredReplyPreviewService.js');
const context = { kind: 'campaign', conversationId: 68, campaignId: 51 };
beforeEach(() => {
  jest.clearAllMocks();
  findLead.mockReset().mockResolvedValue({ id: 12, name: 'Uma', email: 'uma@example.test' });
  resolveCampaign.mockReset().mockResolvedValue(context);
  generateCampaign.mockReset().mockResolvedValue({ body: 'Finance AI reply', subject: 'Re: Finance AI', context });
});
describe('email reply previews preserve conversation ownership', () => {
  it('requires the original thread instead of choosing an assistant or a lead’s newest campaign', async () => {
    await expect(generateConfiguredReplyPreview({ userId: 9, leadId: 12, inboundText: 'Interested' })).rejects.toMatchObject({ status: 409 });
    expect(findLead).not.toHaveBeenCalled();
    expect(routeSupport).not.toHaveBeenCalled();
  });
  it('uses the original campaign for compose, variations and enhancement previews', async () => {
    expect(await generateConfiguredReplyPreview({ userId: 9, leadId: 12, sourceConversationId: 68, inboundText: 'Interested', editingDraft: true }))
      .toMatchObject({ body: 'Finance AI reply', resolvedAssistant: null });
    expect(generateCampaign).toHaveBeenCalledWith(expect.objectContaining({ context, leadId: 12, editingDraft: true }));
    expect(routeSupport).not.toHaveBeenCalled();
  });
  it('fails closed when the original campaign is ambiguous or unavailable', async () => {
    resolveCampaign.mockRejectedValueOnce(new Error('ambiguous original campaign'));
    await expect(generateConfiguredReplyPreview({ userId: 9, leadId: 12, sourceConversationId: 68, inboundText: 'Interested' })).rejects.toThrow('ambiguous');
    expect(routeSupport).not.toHaveBeenCalled();
  });
});
