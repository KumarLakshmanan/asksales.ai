import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const getEffectiveModuleAccess = jest.fn<any>();
const prepare = jest.fn<any>();
const send = jest.fn<any>();
const reviewProposalForDelivery = jest.fn<any>();
const generateProposalFromKBAndProfile = jest.fn<any>();
const createProposal = jest.fn<any>();
const getProposalById = jest.fn<any>();
const getCatalogItems = jest.fn<any>();
const suggestProposalDraft = jest.fn<any>();
const updateProposal = jest.fn<any>();
const createRevision = jest.fn<any>();

jest.unstable_mockModule('../models/platformAccess/functions.js', () => ({ getEffectiveModuleAccess }));
jest.unstable_mockModule('../services/ProposalDeliveryService.js', () => ({
  proposalDeliveryService: { prepare, send },
}));
jest.unstable_mockModule('../services/ProposalApprovalService.js', () => ({ reviewProposalForDelivery }));
jest.unstable_mockModule('../services/ProposalService.js', () => ({
  proposalService: {
    generateProposalFromKBAndProfile,
    createProposal,
    getProposalById,
    getCatalogItems,
    suggestProposalDraft,
    updateProposal,
  },
}));
jest.unstable_mockModule('../services/ProposalLifecycleService.js', () => ({
  proposalLifecycleService: { createRevision },
}));

const {
  addProposalCatalogItemsTool,
  createProposalDraftTool,
  createProposalRevisionTool,
  executeApprovedProposalDelivery,
  listProposalCatalogTool,
  listProposalsTool,
  refineProposalDraftTool,
  sendProposalFromChatSchema,
  sendProposalTool,
} = await import('../mastra/tools/proposalTools.js');

const targetFingerprint = 'a'.repeat(64);
const reviewFingerprint = 'b'.repeat(64);

const proposal = (overrides: Record<string, unknown> = {}) => ({
  id: 44,
  userId: 7,
  proposalNumber: 'PROP-0044',
  title: 'Customer growth program',
  status: 'draft',
  revision: 3,
  recipientName: 'Asha Rao',
  recipientEmail: 'asha@example.test',
  leadId: 101,
  currency: 'USD',
  coverNote: 'A focused plan for Asha.',
  termsAndConditions: 'Net 15.',
  signatureRequired: false,
  discountType: null,
  discountValue: 0,
  taxRate: 0,
  lineItems: [{
    id: 1,
    name: 'Growth program',
    description: 'Implementation and enablement',
    quantity: 1,
    unitPrice: 2400,
    billingType: 'one_time',
    priceConfirmed: true,
  }],
  metadata: {
    generatedSections: [
      { heading: 'Approach', body: 'Current approach' },
      { heading: 'Outcomes', body: 'Current outcomes' },
    ],
    requirements: { objectives: 'Increase qualified pipeline' },
    sources: [{ kind: 'campaign', id: 90, label: 'Campaign chat #90' }],
    assumptions: ['Customer supplies product access'],
    commercial: { packageName: 'Growth' },
  },
  readiness: { ready: true, issues: [] },
  ...overrides,
});

const target = (overrides: Record<string, unknown> = {}) => ({
  channel: 'email',
  outreachConversationId: 61,
  leadId: 101,
  recipient: 'asha@example.test',
  recipientName: 'Asha Rao',
  recipientEmail: 'asha@example.test',
  providerAccountId: 'seller@example.test',
  providerVariant: 'gmail',
  subject: 'Proposal: Customer growth program',
  message: 'Please review the agreed scope.',
  ...overrides,
});

const context = (overrides: Record<string, unknown> = {}) => ({
  userId: 7,
  threadId: 90,
  selectedLeadIds: [101],
  runContext: { userId: 7, threadId: 90, runId: 'run-proposal-1', turnId: 'turn-proposal-1' },
  ...overrides,
});

const call = (tool: any, args: Record<string, unknown>, toolContext = context()) =>
  tool.execute(args, { mastra: { __toolContext: toolContext } });

beforeEach(() => {
  jest.clearAllMocks();
  getEffectiveModuleAccess.mockResolvedValue([{ key: 'proposals', enabled: true }]);
  prepare.mockResolvedValue({
    proposal: proposal(),
    target: target(),
    ready: true,
    issues: [],
    targetFingerprint,
    reviewFingerprint,
  });
  getProposalById.mockImplementation(async (_userId: number, id: number) => proposal({ id, leadId: id >= 100 ? id : 101 }));
  getCatalogItems.mockResolvedValue([
    { id: 301, name: 'Implementation workshop', description: 'Discovery and implementation plan', currency: 'USD', unitPrice: 750, unit: 'workshop', active: true },
    { id: 302, name: 'Managed optimization', description: 'Ongoing optimization', currency: 'USD', unitPrice: 1200, unit: 'month', active: true },
  ]);
  generateProposalFromKBAndProfile.mockImplementation(async (_userId: number, input: { leadId?: number }) => ({ id: input.leadId || 44 }));
  createProposal.mockImplementation(async (_userId: number, input: { leadId?: number }) => ({ id: input.leadId || 44 }));
  createRevision.mockResolvedValue(proposal({ id: 55, status: 'draft', revision: 1 }));
  reviewProposalForDelivery.mockResolvedValue({
    approved: true,
    revision: 4,
    requirement: { required: false, reasons: [], reviewerMemberIds: [] },
  });
  send.mockResolvedValue({
    publicUrl: 'https://seller.example.test/proposals/public-token',
    proposal: proposal({ status: 'sent', revision: 4 }),
    delivery: { state: 'sent', providerMessageId: 'gmail-message-1' },
  });
});

describe('campaign proposal tools', () => {
  it('creates one durable, customer-specific draft for every selected lead', async () => {
    const result = await call(createProposalDraftTool, {
      title: 'Growth program',
      leadIds: [101, 102],
      currency: 'USD',
      generateWithAI: true,
    }, context({ selectedLeadIds: [101, 102] }));

    expect(result).toMatchObject({
      success: true,
      output: {
        status: 'drafts_created',
        createdCount: 2,
        proposals: expect.arrayContaining([expect.objectContaining({
          missingRequirements: ['deliverables', 'timeline', 'responsibilities', 'budget'],
          requirementQuestions: [
            { field: 'deliverables', question: expect.stringContaining('deliverables') },
            { field: 'timeline', question: expect.stringContaining('timeline') },
            { field: 'responsibilities', question: expect.stringContaining('responsibilities') },
            { field: 'budget', question: expect.stringContaining('budget') },
          ],
          sources: [{ kind: 'campaign', id: 90, label: 'Campaign chat #90' }],
          assumptions: ['Customer supplies product access'],
        })]),
      },
    });
    expect(generateProposalFromKBAndProfile).toHaveBeenCalledTimes(2);
    const firstDraft = generateProposalFromKBAndProfile.mock.calls[0][1] as Record<string, unknown>;
    const secondDraft = generateProposalFromKBAndProfile.mock.calls[1][1] as Record<string, unknown>;
    expect(firstDraft).toMatchObject({ leadId: 101, chatThreadId: 90, approvalRequired: true, autoOnboard: true });
    expect(secondDraft).toMatchObject({ leadId: 102, chatThreadId: 90, approvalRequired: true, autoOnboard: true });
    expect(firstDraft.draftKey).not.toBe(secondDraft.draftKey);
  });

  it('lists active tenant catalog services with stable IDs and exact prices', async () => {
    const result = await call(listProposalCatalogTool, {
      currency: 'USD',
      search: 'implementation',
      limit: 20,
    });

    expect(result).toMatchObject({
      success: true,
      output: {
        total: 2,
        items: [
          { id: 301, name: 'Implementation workshop', currency: 'USD', unitPrice: 750, unit: 'workshop' },
          { id: 302, name: 'Managed optimization', currency: 'USD', unitPrice: 1200, unit: 'month' },
        ],
      },
    });
    expect(getCatalogItems).toHaveBeenCalledWith(7, {
      currency: 'USD',
      search: 'implementation',
      activeOnly: true,
      limit: 20,
    });
  });

  it('never creates a proposal for a lead outside the campaign selection', async () => {
    await expect(call(createProposalDraftTool, {
      title: 'Growth program',
      leadId: 999,
      generateWithAI: false,
    })).rejects.toThrow('Use only the lead IDs selected');
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('requires a selected customer and never applies one source across several selected leads', async () => {
    await expect(call(createProposalDraftTool, {
      title: 'Unlinked program',
      generateWithAI: false,
    }, context({ selectedLeadIds: [] }))).rejects.toThrow('Select at least one lead');
    await expect(call(createProposalDraftTool, {
      title: 'Conversation without selected customer',
      outreachConversationId: 61,
      generateWithAI: false,
    }, context({ selectedLeadIds: [] }))).rejects.toThrow('Select at least one lead');
    await expect(call(createProposalDraftTool, {
      title: 'Conversation program',
      outreachConversationId: 61,
      generateWithAI: false,
    }, context({ selectedLeadIds: [101, 102] }))).rejects.toThrow('Choose exactly one selected lead');
    expect(createProposal).not.toHaveBeenCalled();
  });

  it('requires an explicit campaign selection for every proposal-specific action', async () => {
    const noSelection = context({ selectedLeadIds: [] });
    await expect(call(listProposalsTool, { proposalId: 44 }, noSelection)).rejects.toThrow('Select the proposal customer lead');
    await expect(call(refineProposalDraftTool, {
      proposalId: 44,
      expectedRevision: 3,
      instructions: 'Shorten the scope.',
    }, noSelection)).rejects.toThrow('Select the proposal customer lead');
    await expect(call(addProposalCatalogItemsTool, {
      proposalId: 44,
      expectedRevision: 3,
      catalogItemIds: [301],
    }, noSelection)).rejects.toThrow('Select the proposal customer lead');
    await expect(call(createProposalRevisionTool, {
      proposalId: 44,
      expectedRevision: 3,
    }, noSelection)).rejects.toThrow('Select the proposal customer lead');
    await expect(call(sendProposalTool, { proposalId: 44, channel: 'email' }, noSelection)).rejects.toThrow('Select the proposal customer lead');
    expect(updateProposal).not.toHaveBeenCalled();
    expect(createRevision).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('enforces the selected-lead boundary for inspect, refine, and revision actions', async () => {
    getProposalById.mockResolvedValue(proposal({ id: 45, leadId: 102 }));
    await expect(call(listProposalsTool, { proposalId: 45 })).rejects.toThrow('not linked to a lead selected');
    await expect(call(refineProposalDraftTool, {
      proposalId: 45,
      expectedRevision: 3,
      instructions: 'Change another customer proposal.',
    })).rejects.toThrow('not linked to a lead selected');
    await expect(call(addProposalCatalogItemsTool, {
      proposalId: 45,
      expectedRevision: 3,
      catalogItemIds: [301],
    })).rejects.toThrow('not linked to a lead selected');
    await expect(call(createProposalRevisionTool, {
      proposalId: 45,
      expectedRevision: 3,
    })).rejects.toThrow('not linked to a lead selected');
    expect(suggestProposalDraft).not.toHaveBeenCalled();
    expect(createRevision).not.toHaveBeenCalled();
  });

  it('adds exact approved catalog services while preserving every existing line item', async () => {
    updateProposal.mockResolvedValue(proposal({
      revision: 4,
      lineItems: [
        ...proposal().lineItems,
        { catalogId: 301, name: 'Implementation workshop', quantity: 1, unitPrice: 750, unit: 'workshop', priceConfirmed: true, billingPeriod: 'one_time' },
        { catalogId: 302, name: 'Managed optimization', quantity: 1, unitPrice: 1200, unit: 'month', priceConfirmed: true, billingPeriod: 'one_time' },
      ],
    }));

    const result = await call(addProposalCatalogItemsTool, {
      proposalId: 44,
      expectedRevision: 3,
      catalogItemIds: [302, 301],
    });

    expect(result).toMatchObject({
      success: true,
      output: {
        status: 'catalog_items_added',
        preservedLineItemCount: 1,
        addedCatalogItems: [
          { id: 302, name: 'Managed optimization', currency: 'USD', unitPrice: 1200, unit: 'month' },
          { id: 301, name: 'Implementation workshop', currency: 'USD', unitPrice: 750, unit: 'workshop' },
        ],
      },
    });
    expect(getCatalogItems).toHaveBeenCalledWith(7, {
      ids: [302, 301],
      currency: 'USD',
      activeOnly: true,
      limit: 2,
    });
    expect(updateProposal).toHaveBeenCalledWith(7, 44, {
      expectedRevision: 3,
      lineItems: [
        expect.objectContaining({ name: 'Growth program', unitPrice: 2400 }),
        expect.objectContaining({ catalogId: 302, name: 'Managed optimization', unitPrice: 1200, unit: 'month', priceConfirmed: true }),
        expect.objectContaining({ catalogId: 301, name: 'Implementation workshop', unitPrice: 750, unit: 'workshop', priceConfirmed: true }),
      ],
    });
  });

  it('rejects duplicate, stale, and unavailable catalog changes without a partial update', async () => {
    const repeated = await call(addProposalCatalogItemsTool, {
      proposalId: 44,
      expectedRevision: 3,
      catalogItemIds: [302, 302],
    });
    expect(repeated).toMatchObject({ error: true });
    expect(getProposalById).not.toHaveBeenCalled();

    getProposalById.mockResolvedValueOnce(proposal({
      lineItems: [{ ...proposal().lineItems[0], catalogId: 301 }],
    }));
    const duplicate = await call(addProposalCatalogItemsTool, {
      proposalId: 44,
      expectedRevision: 3,
      catalogItemIds: [301],
    });
    expect(duplicate).toMatchObject({ success: false, error: expect.stringContaining('already included') });

    getProposalById.mockResolvedValueOnce(proposal({ revision: 4 }));
    const stale = await call(addProposalCatalogItemsTool, {
      proposalId: 44,
      expectedRevision: 3,
      catalogItemIds: [301],
    });
    expect(stale).toMatchObject({ success: false, error: expect.stringContaining('revision 4') });

    getProposalById.mockResolvedValueOnce(proposal());
    getCatalogItems.mockResolvedValueOnce([
      { id: 301, name: 'Implementation workshop', description: '', currency: 'USD', unitPrice: 750, unit: 'workshop', active: true },
    ]);
    const unavailable = await call(addProposalCatalogItemsTool, {
      proposalId: 44,
      expectedRevision: 3,
      catalogItemIds: [301, 999],
    });
    expect(unavailable).toMatchObject({ success: false, error: expect.stringContaining('999') });
    expect(updateProposal).not.toHaveBeenCalled();
  });

  it('creates a full revision only for a proposal linked to the selected lead', async () => {
    const result = await call(createProposalRevisionTool, {
      proposalId: 44,
      expectedRevision: 3,
      feedbackId: 71,
    });
    expect(result).toMatchObject({ success: true, output: { status: 'revision_created', previousProposalId: 44 } });
    expect(createRevision).toHaveBeenCalledWith(7, 44, {
      expectedRevision: 3,
      feedbackId: 71,
      draftKey: expect.stringMatching(/^campaign-revision-90-/),
    });
  });

  it('refines only selected copy and carries the exact commercial model into AI grounding', async () => {
    suggestProposalDraft.mockResolvedValue({
      generatedSections: [
        { heading: 'Approach', body: 'Refined approach' },
        { heading: 'Outcomes', body: 'Current outcomes' },
      ],
      coverNote: 'A focused plan for Asha.',
      termsAndConditions: 'Net 15.',
    });
    updateProposal.mockResolvedValue(proposal({ revision: 4 }));

    const result = await call(refineProposalDraftTool, {
      proposalId: 44,
      expectedRevision: 3,
      instructions: 'Make the approach more specific.',
      sectionIndexes: [0],
    });

    expect(result).toMatchObject({ success: true, output: { status: 'draft_refined', preservedPricing: true, refinedSectionIndexes: [0] } });
    expect(suggestProposalDraft).toHaveBeenCalledWith(7, expect.objectContaining({
      lineItems: [expect.objectContaining({ name: 'Growth program', unitPrice: 2400 })],
      generatedSections: [
        { heading: 'Approach', body: '' },
        { heading: 'Outcomes', body: 'Current outcomes' },
      ],
      generationMode: 'replace_selected',
      generationSections: [0],
      commercial: { packageName: 'Growth' },
      requirements: { objectives: 'Increase qualified pipeline' },
      assumptions: ['Customer supplies product access'],
    }));
    expect(updateProposal).toHaveBeenCalledWith(7, 44, {
      expectedRevision: 3,
      generatedSections: [
        { heading: 'Approach', body: 'Refined approach' },
        { heading: 'Outcomes', body: 'Current outcomes' },
      ],
    });
  });

  it('prepares an exact frozen delivery review without sending', async () => {
    const result = await call(sendProposalTool, { proposalId: 44, channel: 'email' });

    expect(result).toMatchObject({
      success: true,
      requiresApproval: true,
      output: {
        status: 'approval_pending',
        args: {
          proposalId: 44,
          channel: 'email',
          leadId: 101,
          providerAccountId: 'seller@example.test',
          recipientEmail: 'asha@example.test',
          subject: 'Proposal: Customer growth program',
          message: 'Please review the agreed scope.',
          expectedRevision: 3,
          expectedTargetFingerprint: targetFingerprint,
          expectedReviewFingerprint: reviewFingerprint,
          total: 2400,
        },
      },
    });
    expect((result.output.args as { idempotencyKey: string }).idempotencyKey).toContain('campaign-proposal-send-90-turn-proposal-1');
    expect(send).not.toHaveBeenCalled();
  });

  it('blocks preparation when the resolved customer is outside the selected leads', async () => {
    prepare.mockResolvedValueOnce({
      proposal: proposal({ leadId: 102 }),
      target: target({ leadId: 102 }),
      ready: true,
      issues: [],
      targetFingerprint,
      reviewFingerprint,
    });
    await expect(call(sendProposalTool, { proposalId: 44, channel: 'email' })).rejects.toThrow('not linked to a lead selected');
    expect(send).not.toHaveBeenCalled();
  });

  it('revalidates fingerprints after approval and stops a stale delivery before review or send', async () => {
    prepare.mockResolvedValueOnce({
      proposal: proposal(),
      target: target(),
      ready: true,
      issues: [],
      targetFingerprint: 'c'.repeat(64),
      reviewFingerprint,
    });
    const result = await executeApprovedProposalDelivery({
      proposalId: 44,
      channel: 'email',
      expectedRevision: 3,
      expectedTargetFingerprint: targetFingerprint,
      expectedReviewFingerprint: reviewFingerprint,
      idempotencyKey: 'campaign-proposal-send-90-turn-proposal-1',
    }, context());
    expect(result).toMatchObject({ success: false, output: { status: 'gated', retrySafe: false } });
    expect(reviewProposalForDelivery).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('records seller approval but does not send while assigned team reviews are pending', async () => {
    reviewProposalForDelivery.mockResolvedValueOnce({
      approved: false,
      revision: 4,
      requirement: { required: true, reasons: ['Discount exceeds policy'], reviewerMemberIds: [8, 9] },
    });
    const result = await executeApprovedProposalDelivery({
      proposalId: 44,
      channel: 'email',
      expectedRevision: 3,
      expectedTargetFingerprint: targetFingerprint,
      expectedReviewFingerprint: reviewFingerprint,
      idempotencyKey: 'campaign-proposal-send-90-turn-proposal-1',
      reviewUrl: '/dashboard/proposals/44',
    }, context());
    expect(result).toMatchObject({
      success: true,
      output: { status: 'awaiting_team_review', reviewerMemberIds: [8, 9] },
    });
    expect(send).not.toHaveBeenCalled();
  });

  it('sends the reviewed revision once through the frozen provider target', async () => {
    const result = await executeApprovedProposalDelivery({
      proposalId: 44,
      channel: 'email',
      leadId: 101,
      providerAccountId: 'seller@example.test',
      providerVariant: 'gmail',
      recipientEmail: 'asha@example.test',
      subject: 'Proposal: Customer growth program',
      message: 'Please review the agreed scope.',
      expectedRevision: 3,
      expectedTargetFingerprint: targetFingerprint,
      expectedReviewFingerprint: reviewFingerprint,
      idempotencyKey: 'campaign-proposal-send-90-turn-proposal-1',
    }, context());
    expect(result).toMatchObject({ success: true, output: { status: 'sent', retrySafe: false } });
    expect(reviewProposalForDelivery).toHaveBeenCalledWith(7, 44, expect.objectContaining({
      expectedRevision: 3,
      expectedTargetFingerprint: targetFingerprint,
      expectedReviewFingerprint: reviewFingerprint,
    }));
    expect(send).toHaveBeenCalledWith(7, 44, expect.objectContaining({
      expectedRevision: 4,
      idempotencyKey: 'campaign-proposal-send-90-turn-proposal-1',
      providerAccountId: 'seller@example.test',
      recipientEmail: 'asha@example.test',
    }));
  });

  it('rejects malformed or client-extended frozen approval payloads', () => {
    expect(() => sendProposalFromChatSchema.parse({ proposalId: 44, expectedTargetFingerprint: 'short' })).toThrow();
    expect(() => sendProposalFromChatSchema.parse({ proposalId: 44, inventedRecipient: 'attacker@example.test' })).toThrow();
  });
});
