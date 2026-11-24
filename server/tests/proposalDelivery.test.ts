import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { ProposalDeliveryDependencies, ProposalDeliveryInput, ProposalDeliveryTarget, DeliveryProposal, ProposalProviderReceipt } from '../services/ProposalDeliveryService.js';
import type { SupportDeliveryOutboxRecord } from '../models/supportOrchestration/schema.js';

jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
const { ProposalDeliveryService, proposalDeliveryDecisionKey } = await import('../services/ProposalDeliveryService.js');
const { proposalApprovalFingerprint } = await import('../services/ProposalWorkspaceService.js');

const target: ProposalDeliveryTarget = {
  channel: 'email', outreachConversationId: 31, leadId: 17,
  recipient: 'customer@example.test', recipientName: 'Customer', recipientEmail: 'customer@example.test',
  providerAccountId: 'seller@example.test', credentialId: 8, providerVariant: 'gmail',
  subject: 'Proposal: Consulting', message: 'Please review the agreed scope.',
};
let proposal: DeliveryProposal;
let actions: Map<string, SupportDeliveryOutboxRecord>;
let deps: ProposalDeliveryDependencies;
const receipt = jest.fn<() => Promise<ProposalProviderReceipt>>();
const reserve = jest.fn<ProposalDeliveryDependencies['reserve']>();
const refund = jest.fn<ProposalDeliveryDependencies['refund']>();
const complete = jest.fn<ProposalDeliveryDependencies['complete']>();
const input: ProposalDeliveryInput = { expectedRevision: 4, idempotencyKey: 'review-request-123' };

beforeEach(() => {
  proposal = {
    id: 2, userId: 9, revision: 4, status: 'draft', title: 'Consulting', proposalNumber: 'PROP-QA-2',
    recipientName: target.recipientName, recipientEmail: target.recipientEmail, currency: 'USD',
    coverNote: 'Deliver the agreed consulting report.', termsAndConditions: 'Pay on completion.',
    lineItems: [{ id: 1, name: 'Consulting', quantity: 1, unitPrice: 100, priceConfirmed: true }],
    metadata: { approvalRequired: true, approvedAt: new Date().toISOString(), deliveryTarget: structuredClone(target) },
  };
  proposal.metadata!.approvalFingerprint = proposalApprovalFingerprint(proposal);
  actions = new Map();
  receipt.mockReset().mockResolvedValue({ success: true, messageId: 'provider-confirmed-1' });
  reserve.mockReset().mockResolvedValue({ success: true, transactionId: 12 });
  refund.mockReset().mockResolvedValue({ success: true });
  complete.mockReset().mockImplementation(async (action, result) => {
    action.status = 'sent'; action.providerMessageId = result.messageId!; proposal.status = 'sent';
  });
  deps = {
    getProposal: async (userId, id) => userId === proposal.userId && id === proposal.id ? structuredClone(proposal) : null,
    resolveTarget: async () => ({ target: structuredClone(target), issues: [] }),
    loadAction: async (userId, key) => actions.get(key)?.userId === userId ? actions.get(key)! : null,
    claim: async (claim) => {
      const previous = actions.get(claim.key);
      if (previous) return { action: previous, created: false };
      if (proposal.status !== 'draft') throw new Error('Already claimed');
      const action = {
        id: 1, userId: proposal.userId, conversationId: 31, channel: target.channel,
        decisionKey: claim.key, status: 'sending',
        payload: { text: 'Frozen customer message and public link', recipient: target.recipient, metadata: {
          proposalId: proposal.id, requestDigest: claim.requestDigest, target: claim.target,
          publicUrl: `https://example.test/proposal/${claim.token}`, dispatchKind: 'proposal_delivery',
        } },
      } as unknown as SupportDeliveryOutboxRecord;
      actions.set(claim.key, action); proposal.status = 'sending';
      return { action, created: true };
    },
    reserve, recordReservation: async () => {}, dispatch: receipt, complete,
    fail: async (action, error, uncertain) => { action.status = uncertain ? 'uncertain' : 'failed'; action.lastError = error; proposal.status = uncertain ? 'delivery_unknown' : 'draft'; },
    refund,
  };
});

describe('reviewed proposal delivery', () => {
  it('rejects another tenant before creating a send action or reserving credit', async () => {
    await expect(new ProposalDeliveryService(deps).send(18, 2, input)).rejects.toMatchObject({ statusCode: 404 });
    expect(actions.size).toBe(0); expect(reserve).not.toHaveBeenCalled(); expect(receipt).not.toHaveBeenCalled();
  });

  it.each(['revision', 'content', 'recipient', 'account', 'message'] as const)('rejects stale %s before any send', async change => {
    if (change === 'revision') proposal.revision += 1;
    if (change === 'content') proposal.title = 'Changed scope';
    if (change === 'recipient') proposal.recipientEmail = 'other@example.test';
    if (change === 'account' || change === 'message') deps.resolveTarget = async () => ({ target: { ...target, ...(change === 'account' ? { providerAccountId: 'different@example.test' } : { message: 'Changed message' }) }, issues: [] });
    await expect(new ProposalDeliveryService(deps).send(9, 2, input)).rejects.toMatchObject({ statusCode: 409 });
    expect(actions.size).toBe(0); expect(reserve).not.toHaveBeenCalled();
  });

  it('never treats an unapproved or incomplete document as ready to send', async () => {
    proposal.metadata!.approvedAt = null;
    await expect(new ProposalDeliveryService(deps).send(9, 2, input)).rejects.toMatchObject({ statusCode: 409 });
    proposal.lineItems![0].unitPrice = 0;
    const review = await new ProposalDeliveryService(deps).prepare(9, 2, {});
    expect(review.ready).toBe(false);
    expect(review.issues).toEqual(expect.arrayContaining([expect.objectContaining({ field: 'lineItems' })]));
    expect(reserve).not.toHaveBeenCalled();
  });

  it('replays the frozen receipt and link without another credit reservation or provider send', async () => {
    const service = new ProposalDeliveryService(deps);
    const first = await service.send(9, 2, input);
    proposal.revision += 1;
    const replay = await service.send(9, 2, input);
    expect(first.delivery.state).toBe('sent');
    expect(replay.delivery).toEqual(first.delivery);
    expect(replay.publicUrl).toBe(first.publicUrl);
    expect(reserve).toHaveBeenCalledTimes(1); expect(receipt).toHaveBeenCalledTimes(1);
  });

  it('keeps a duplicate request from entering the provider while the first call is in flight', async () => {
    let finish: (value: ProposalProviderReceipt) => void = () => {};
    let entered: () => void = () => {};
    const providerEntered = new Promise<void>(resolve => { entered = resolve; });
    receipt.mockImplementationOnce(async () => { entered(); return new Promise<ProposalProviderReceipt>(resolve => { finish = resolve; }); });
    const service = new ProposalDeliveryService(deps);
    const sending = service.send(9, 2, input);
    await providerEntered;
    const duplicate = await service.send(9, 2, input);
    expect(duplicate.delivery.state).toBe('uncertain');
    finish({ success: true, messageId: 'one-receipt' });
    const sent = await sending;
    expect(sent.publicUrl).toBe(duplicate.publicUrl);
    expect(receipt).toHaveBeenCalledTimes(1); expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of an idempotency key with a changed delivery request', async () => {
    const service = new ProposalDeliveryService(deps);
    await service.send(9, 2, input);
    await expect(service.send(9, 2, { ...input, message: 'Different message' })).rejects.toMatchObject({ code: 'DELIVERY_IDEMPOTENCY_CONFLICT' });
    expect(receipt).toHaveBeenCalledTimes(1);
  });

  it.each([
    { success: false, error: 'timeout', deliveryAttempted: true },
    { success: true },
    { success: true, deliveryAttempted: true, outcomeUncertain: false },
    { success: false, outcomeUncertain: true, error: 'Connection reset after request' },
  ])('retains credit and suppresses a resend when a provider outcome is uncertain: %j', async result => {
    receipt.mockResolvedValueOnce(result);
    const service = new ProposalDeliveryService(deps);
    const first = await service.send(9, 2, input);
    expect(first.delivery.state).toBe('uncertain');
    expect(proposal.status).toBe('delivery_unknown');
    expect((await service.send(9, 2, input)).publicUrl).toBe(first.publicUrl);
    expect(refund).not.toHaveBeenCalled(); expect(receipt).toHaveBeenCalledTimes(1);
  });

  it('refunds a confirmed rejection once, and does not automatically retry it', async () => {
    receipt.mockResolvedValueOnce({ success: false, deliveryAttempted: true, outcomeUncertain: false, error: 'Provider rejected invalid recipient' });
    const service = new ProposalDeliveryService(deps);
    expect((await service.send(9, 2, input)).delivery.state).toBe('failed');
    expect((await service.send(9, 2, input)).delivery.state).toBe('failed');
    expect(refund).toHaveBeenCalledTimes(1); expect(receipt).toHaveBeenCalledTimes(1);
  });

  it('refunds and restores the draft if eligibility changes before entering the provider', async () => {
    let checks = 0;
    deps.resolveTarget = async () => ({ target: structuredClone(target), issues: ++checks > 1 ? [{ code: 'opt_out', field: 'recipient', message: 'Customer opted out', severity: 'error' }] : [] });
    await expect(new ProposalDeliveryService(deps).send(9, 2, input)).rejects.toMatchObject({ code: 'PROPOSAL_DELIVERY_GATED' });
    expect(receipt).not.toHaveBeenCalled(); expect(refund).toHaveBeenCalledTimes(1); expect(proposal.status).toBe('draft');
  });

  it('preserves uncertainty when delivery succeeds but the database receipt cannot commit', async () => {
    complete.mockRejectedValueOnce(new Error('Database unavailable after provider acceptance'));
    expect((await new ProposalDeliveryService(deps).send(9, 2, input)).delivery.state).toBe('uncertain');
    expect(refund).not.toHaveBeenCalled(); expect(receipt).toHaveBeenCalledTimes(1);
  });

  it('uses tenant and proposal identity in durable send keys', () => {
    expect(proposalDeliveryDecisionKey(9, 2, 'stable-key')).not.toBe(proposalDeliveryDecisionKey(10, 2, 'stable-key'));
    expect(proposalDeliveryDecisionKey(9, 2, 'stable-key')).not.toBe(proposalDeliveryDecisionKey(9, 3, 'stable-key'));
  });

  it('keeps an approval valid when PostgreSQL JSONB reorders nested object keys', () => {
    const first = {
      title: 'Consulting', currency: 'USD', total: '100.00',
      metadata: {
        commercial: { selectedPackageId: 'growth', packages: [{ id: 'growth', name: 'Growth' }] },
        deliveryTarget: { channel: 'email', recipient: 'customer@example.test', providerAccountId: 'seller@example.test' },
      },
      lineItems: [{ name: 'Consulting', quantity: 1, unitPrice: 100, priceConfirmed: true }],
    };
    const jsonbRoundTrip = {
      currency: 'USD', title: 'Consulting', total: '100.00',
      metadata: {
        deliveryTarget: { providerAccountId: 'seller@example.test', recipient: 'customer@example.test', channel: 'email' },
        commercial: { packages: [{ name: 'Growth', id: 'growth' }], selectedPackageId: 'growth' },
      },
      lineItems: [{ priceConfirmed: true, unitPrice: 100, quantity: 1, name: 'Consulting' }],
    };
    expect(proposalApprovalFingerprint(first)).toBe(proposalApprovalFingerprint(jsonbRoundTrip));
  });
});
