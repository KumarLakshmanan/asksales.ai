import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';
import { prepareHandoffOffer } from '../services/agents/orchestration/HandoffConsent.js';
import {
  buildMetaQuickReplies,
  buildWhatsAppInteractive,
  createSupportChoiceManifest,
  matchExactPlaybookChoice,
  normalizeWhatsAppInboundText,
} from '../services/agents/orchestration/SupportChoiceDelivery.js';
import { INDUSTRY_SUPPORT_PLAYBOOKS } from '../services/agents/orchestration/DefaultSupportConfiguration.js';
import {
  collectJourneyFields,
  initializeJourneyState,
} from '../services/agents/orchestration/SupportJourneyRuntime.js';

const choice = createSupportChoiceManifest({
  runId: 42,
  nodeId: 'collect-purpose',
  field: {
    key: 'journey.type',
    type: 'single_select',
    required: true,
    pii: 'none',
    prompt: 'How can I help?',
    options: [
      { value: 'stay', label: 'Leisure stay' },
      { value: 'event', label: 'Wedding or celebration', shortLabel: 'Wedding / event' },
      { value: 'info', label: 'Resort details and information', shortLabel: 'Resort information' },
      { value: 'other', label: 'Another enquiry' },
    ],
  },
  preface: 'Welcome.',
})!;

describe('support native choices', () => {
  it('builds a WhatsApp list for four governed options without exposing field values in IDs', () => {
    const interactive = buildWhatsAppInteractive(choice) as any;
    expect(interactive.type).toBe('list');
    expect(interactive.body.text).toBe('Welcome.\nHow can I help?');
    expect(interactive.action.sections[0].rows).toHaveLength(4);
    expect(interactive.action.sections[0].rows[1].title).toBe('Wedding / event');
    expect(interactive.action.sections[0].rows[0].id).not.toContain('stay');
  });

  it('preserves a verified delivery preface in the WhatsApp interactive body', () => {
    const body = `Here are the images you requested.\n\n${choice.fallbackText}`;
    const interactive = buildWhatsAppInteractive(choice, body) as any;
    expect(interactive.body.text).toBe(body);
    expect(interactive.action.sections[0].rows).toHaveLength(4);
  });

  it('uses WhatsApp reply buttons for boolean and up-to-three-option questions', () => {
    const booleanChoice = createSupportChoiceManifest({
      runId: 7,
      nodeId: 'confirm',
      field: { key: 'confirmed', type: 'boolean', required: true, pii: 'none', prompt: 'Continue?' },
    })!;
    const interactive = buildWhatsAppInteractive(booleanChoice) as any;
    expect(interactive.type).toBe('button');
    expect(interactive.action.buttons.map((item: any) => item.reply.title)).toEqual(['Yes', 'No']);
  });

  it('builds Instagram and Facebook quick replies within Meta limits', () => {
    const replies = buildMetaQuickReplies(choice)!;
    expect(replies).toHaveLength(4);
    expect(replies[2]).toEqual(expect.objectContaining({
      content_type: 'text',
      title: 'Resort information',
    }));
  });

  it('falls back to numbered text rather than truncating an unsafe native label', () => {
    const invalid = createSupportChoiceManifest({
      runId: 1,
      nodeId: 'collect',
      field: {
        key: 'choice', type: 'single_select', required: true, pii: 'none', prompt: 'Choose',
        options: [{ value: 'long', label: 'This label is intentionally much too long' }],
      },
    })!;
    expect(buildWhatsAppInteractive(invalid)).toBeUndefined();
    expect(buildMetaQuickReplies(invalid)).toBeUndefined();
    expect(invalid.fallbackText).toContain('1. This label is intentionally much too long');
  });

  it('normalizes WhatsApp button and list replies to their displayed, allowlisted title', () => {
    expect(normalizeWhatsAppInboundText({
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'choice_v1_opaque', title: 'Yes' } },
    })).toEqual({ text: 'Yes', selection: { kind: 'button_reply', id: 'choice_v1_opaque', title: 'Yes' } });
    expect(normalizeWhatsAppInboundText({
      type: 'interactive',
      interactive: { type: 'list_reply', list_reply: { id: 'choice_v1_opaque', title: 'Resort information' } },
    }).text).toBe('Resort information');
  });

  it('keeps every hospitality selection provider-safe through configured short labels', () => {
    const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!.graph;
    for (const field of graph.fields || []) {
      if (field.type !== 'single_select') continue;
      const manifest = createSupportChoiceManifest({ runId: 1, nodeId: 'test', field });
      expect(manifest).toBeDefined();
      expect(manifest!.options.every((option) => option.shortLabel.length <= 20)).toBe(true);
      expect(buildMetaQuickReplies(manifest!)).toBeDefined();
      expect(buildWhatsAppInteractive(manifest!)).toBeDefined();
    }
  });

  it('accepts a provider short label through the same allowlisted playbook field parser', () => {
    const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!.graph;
    const node = graph.nodes.find((item) => item.id === 'collect-purpose')!;
    const state = collectJourneyFields(graph, node, initializeJourneyState(graph), {
      inboundText: 'Wedding / event',
      entities: {},
    });
    expect(state.fields['journey.type']).toEqual(expect.objectContaining({
      value: 'celebration',
      status: 'collected',
    }));
  });

  it('matches exact published choices but not negated callback phrases', () => {
    const field = {
      key: 'next', type: 'single_select' as const, required: true, pii: 'none' as const, prompt: 'Next?',
      options: [
        { value: 'book', label: 'Book now' },
        { value: 'callback', label: 'Request a callback' },
      ],
    };
    expect(matchExactPlaybookChoice(field, 'Request a callback')).toEqual({
      value: 'callback', label: 'Request a callback',
    });
    expect(matchExactPlaybookChoice(field, '2')).toEqual({
      value: 'callback', label: 'Request a callback',
    });
    expect(matchExactPlaybookChoice(field, 'Do not request a callback')).toBeUndefined();
  });
});

const mockSendText = jest.fn<any>();
const mockSendChoice = jest.fn<any>();
const mockSendCtaUrl = jest.fn<any>();
const mockOutboxClaim = jest.fn<any>();
const mockCompleteClaimedAction = jest.fn<any>();
const mockDbExecute = jest.fn<any>();
const mockDeliverDirect = jest.fn<any>();
const mockSendInstagramDM = jest.fn<any>();
const mockSendFacebookDM = jest.fn<any>();

const autoReplyAllowed = jest.fn<() => Promise<boolean>>();
const draftDelivery = jest.fn<(...args: unknown[]) => Promise<{ id: number }>>();
jest.unstable_mockModule('../services/agents/orchestration/SupportAutoReplyService.js', () => ({
  automaticSupportReplyAllowed: autoReplyAllowed,
  socialDraftChannel: (channel: string) => ['whatsapp', 'instagram', 'facebook'].includes(channel.replace(/_comment$/, '')),
}));
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: mockDbExecute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../utils/messageFormatter.js', () => ({ formatMessageForChannel: (text: string) => text }));
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({
  whatsappApiService: { sendText: mockSendText, sendChoice: mockSendChoice, sendCtaUrl: mockSendCtaUrl },
}));
jest.unstable_mockModule('../services/agents/orchestration/DeliveryOutboxService.js', () => ({
  deliveryOutboxService: {
    draft: draftDelivery,
    holdIfDisabled: async () => false,
    claim: mockOutboxClaim,
    completeClaimedAction: mockCompleteClaimedAction,
    markFailed: jest.fn(),
  },
}));
jest.unstable_mockModule('../services/supportMedia/SupportMediaDeliveryService.js', () => ({
  supportMediaDeliveryService: { deliverDirect: mockDeliverDirect },
}));
jest.unstable_mockModule('../services/instagramService.js', () => ({
  sendInstagramDM: mockSendInstagramDM,
}));
jest.unstable_mockModule('../services/FacebookMessengerService.js', () => ({
  sendFacebookDM: mockSendFacebookDM,
}));

const { DeliveryStage } = await import('../services/agents/pipeline/stages/DeliveryStage.js');
const { ActivePlaybookSelectionStage } = await import('../services/agents/pipeline/stages/ActivePlaybookSelectionStage.js');
const { PostClassificationPolicyStage } = await import('../services/agents/pipeline/stages/PostClassificationPolicyStage.js');
const { CanAIHandleGate } = await import('../services/agents/pipeline/stages/CanAIHandleGate.js');
const { ConfidenceGate } = await import('../services/agents/pipeline/stages/ConfidenceGate.js');

describe('native choice delivery stage', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    autoReplyAllowed.mockResolvedValue(true); draftDelivery.mockResolvedValue({ id: 902 });
    mockSendText.mockResolvedValue({ messages: [{ id: 'wamid.text' }] });
    mockSendChoice.mockResolvedValue({ messages: [{ id: 'wamid.choice' }] });
    mockSendCtaUrl.mockResolvedValue({ messages: [{ id: 'wamid.cta' }] });
    mockSendInstagramDM.mockResolvedValue({ success: true, externalMessageId: 'ig.booking' });
    mockSendFacebookDM.mockResolvedValue({ success: true, externalMessageId: 'fb.booking' });
    mockDeliverDirect.mockResolvedValue({ status: 'sent', sent: 1, failed: 0 });
    mockOutboxClaim.mockImplementation(async (_identity: unknown, payload: unknown) => ({
      state: 'claimed',
      action: {
        id: 901,
        userId: 9,
        conversationId: 68,
        channel: 'whatsapp',
        status: 'sending',
        payload,
      },
    }));
  });

  it('drafts the reply without provider dispatch when automatic replies are disabled', async () => {
    autoReplyAllowed.mockResolvedValue(false);
    const result = await new DeliveryStage().execute({
      message: { userId: 9, conversationId: 68, channel: 'whatsapp', senderIdentifier: 'recipient', inboundText: 'Hello', rawMessageId: 'inbound', messageId: 100, phoneNumberId: 'phone-id', metadata: {} },
      agentResult: { replyText: 'Governed reply', escalated: false }, confidence: 1, policyViolations: [], metadata: {},
    } as PipelineContext);
    expect(draftDelivery).toHaveBeenCalledTimes(1);
    expect(mockOutboxClaim).not.toHaveBeenCalled();
    expect(mockSendChoice).not.toHaveBeenCalled(); expect(mockSendText).not.toHaveBeenCalled();
    expect(result.metadata?.deliveryStatus).toBe('drafted');
  });

  it('delivers a deterministic playbook choice through WhatsApp and persists its text fallback', async () => {
    const ctx = {
      message: {
        userId: 9,
        conversationId: 68,
        channel: 'whatsapp',
        senderIdentifier: '917337877475',
        inboundText: 'Hello',
        rawMessageId: 'wamid.inbound',
        messageId: 100,
        phoneNumberId: 'phone-id',
        metadata: {},
      },
      agentResult: { replyText: 'Model-authored numbered menu must not control provider payload.' },
      confidence: 1,
      policyViolations: [],
      metadata: { playbookDirective: { runId: 42, nodeId: 'collect-purpose', choice } },
    } as any;

    const result = await new DeliveryStage().execute(ctx);

    expect(mockSendChoice).toHaveBeenCalledWith(expect.objectContaining({ choice, text: choice.fallbackText }));
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockOutboxClaim).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      text: choice.fallbackText,
      choice,
      metadata: expect.objectContaining({ dispatchKind: 'pipeline_choice' }),
    }));
    expect(mockCompleteClaimedAction).toHaveBeenCalledTimes(1);
    expect(result.metadata?.deliveryStatus).toBe('sent');
  });

  it('delivers handoff Yes/No instead of an interrupted playbook choice or voice reply', async () => {
    const ctx = {
      message: { userId: 9, conversationId: 68, channel: 'whatsapp', senderIdentifier: 'recipient',
        inboundText: 'Question without verified information', rawMessageId: 'handoff-offer', messageId: 100,
        phoneNumberId: 'phone-id', metadata: { voiceReplyRequested: true } },
      confidence: 1, policyViolations: [], metadata: { playbookDirective: { runId: 42, nodeId: 'collect-purpose', choice } },
    } as PipelineContext;
    prepareHandoffOffer(ctx);
    const handoffChoice=ctx.metadata!.handoffChoice;
    await new DeliveryStage().execute(ctx);
    expect(mockSendChoice).toHaveBeenCalledWith(expect.objectContaining({choice:handoffChoice,text:handoffChoice.fallbackText}));
    expect(mockOutboxClaim).toHaveBeenCalledWith(expect.anything(),expect.objectContaining({choice:handoffChoice}));
    expect(mockSendText).not.toHaveBeenCalled();
    expect(ctx.metadata?.deliveryStatus).toBe('sent');
    expect(ctx.metadata?.suppressBusinessEffects).toBe(true);
  });

  it('resumes the native playbook choice only after explicit media is provider-acknowledged', async () => {
    const ctx = {
      message: {
        userId: 9,
        conversationId: 68,
        channel: 'whatsapp',
        senderIdentifier: '917337877475',
        inboundText: 'Show Premium Club photos',
        rawMessageId: 'wamid.media',
        messageId: 102,
        phoneNumberId: 'phone-id',
        metadata: {},
      },
      agentResult: {
        replyText: 'I found matching images for your request.',
        mediaDecision: { intent: 'explicit' },
      },
      verifiedMedia: [{ assetId: 10, evidenceId: 'media:10' }],
      confidence: 1,
      policyViolations: [],
      metadata: {
        mediaOnlyResponse: true,
        playbookDirective: { runId: 42, nodeId: 'collect-purpose', choice },
      },
    } as any;

    await new DeliveryStage().execute(ctx);

    expect(mockSendText).toHaveBeenCalledWith(expect.objectContaining({
      text: 'I found matching images for your request.',
    }));
    expect(mockDeliverDirect).toHaveBeenCalledTimes(1);
    expect(mockSendChoice).toHaveBeenCalledWith(expect.objectContaining({ choice, text: choice.fallbackText }));
    const dispatchKinds = mockOutboxClaim.mock.calls.map((call) => (call[1] as any).metadata.dispatchKind);
    expect(dispatchKinds).toEqual(['pipeline_message', 'post_media_resume']);
  });

  it('never delivers a virtual media node instruction as customer-visible text', async () => {
    const internalInstruction = 'Deliver only authorized, published media relevant to the customer request.';
    const resumeQuestion = 'How many children will stay? Reply 0 if none.';
    const ctx = {
      message: {
        userId: 9,
        conversationId: 68,
        channel: 'whatsapp',
        senderIdentifier: '917337877475',
        inboundText: 'Show room photos',
        rawMessageId: 'wamid.media-no-choice',
        messageId: 103,
        phoneNumberId: 'phone-id',
        metadata: {},
      },
      agentResult: {
        replyText: 'I found matching images for your request.',
        mediaDecision: { intent: 'explicit' },
      },
      verifiedMedia: [{ assetId: 10, evidenceId: 'media:10' }],
      confidence: 1,
      policyViolations: [],
      metadata: {
        mediaOnlyResponse: true,
        playbookDirective: {
          runId: 42,
          nodeId: 'collect-stay:media-interruption',
          instruction: internalInstruction,
          resumeQuestion,
        },
      },
    } as any;

    await new DeliveryStage().execute(ctx);

    const deliveredParts = mockOutboxClaim.mock.calls.map((call) => (call[1] as { text: string }).text);
    expect(deliveredParts).toEqual(['I found matching images for your request.', resumeQuestion]);
    expect(deliveredParts.join('\n')).not.toContain(internalInstruction);
  });

  it('reports an explicit media failure truthfully and does not send the playbook resume choice', async () => {
    mockDeliverDirect.mockResolvedValueOnce({ status: 'sent_media_degraded', sent: 0, failed: 1 });
    const ctx = {
      message: {
        userId: 9,
        conversationId: 68,
        channel: 'whatsapp',
        senderIdentifier: '917337877475',
        inboundText: 'Show Premium Club photos',
        rawMessageId: 'wamid.media-failure',
        messageId: 104,
        phoneNumberId: 'phone-id',
        metadata: {},
      },
      agentResult: {
        replyText: 'I found matching images for your request.',
        mediaDecision: { intent: 'explicit' },
      },
      verifiedMedia: [{ assetId: 10, evidenceId: 'media:10' }],
      confidence: 1,
      policyViolations: [],
      metadata: {
        mediaOnlyResponse: true,
        playbookDirective: { runId: 42, nodeId: 'collect-purpose', choice },
      },
    } as any;

    const result = await new DeliveryStage().execute(ctx);

    expect(mockSendChoice).not.toHaveBeenCalled();
    const deliveredParts = mockOutboxClaim.mock.calls.map((call) => (call[1] as { text: string }).text);
    expect(deliveredParts).toEqual([
      'I found matching images for your request.',
      'I found matching images, but this channel could not attach them right now. Please try again later or use another connected channel.',
    ]);
    expect(result.agentResult?.mediaDeliverySucceeded).toBe(false);
    expect(result.metadata?.mediaFailureNoticeSent).toBe(true);
  });

  it('delivers the configured external booking URL as a server-built WhatsApp CTA', async () => {
    const handoff = {
      mode: 'external_booking', propertyId: 1, roomTypeId: 2,
      checkIn: '2026-09-10', checkOut: '2026-09-12', guests: 2, rooms: 1,
      url: 'https://bookings.example.test/?propertyId=10955', title: 'Book now', customerConfirmed: true,
    } as const;
    const ctx = {
      message: {
        userId: 9, conversationId: 68, channel: 'whatsapp', senderIdentifier: '917337877475',
        inboundText: 'Yes', rawMessageId: 'wamid.confirm', messageId: 101, phoneNumberId: 'phone-id', metadata: {},
      },
      agentResult: { replyText: 'Untrusted draft', externalBookingHandoff: handoff },
      metadata: {},
    } as any;
    await new DeliveryStage().execute(ctx);
    expect(mockSendCtaUrl).toHaveBeenCalledWith(expect.objectContaining({
      url: handoff.url, title: 'Book now', allowTextFallback: true,
    }));
    expect(mockSendText).not.toHaveBeenCalled();
    expect(mockCompleteClaimedAction).toHaveBeenCalledWith(expect.anything(), 'wamid.cta');
  });

  it('delivers the exact server-owned booking URL in Instagram DM text', async () => {
    const handoff = {
      mode: 'external_booking', propertyId: 1, roomTypeId: 2,
      checkIn: '2026-09-10', checkOut: '2026-09-12', guests: 2, rooms: 1,
      url: 'https://bookings.orocircle.com/?propertyId=10955', title: 'Book now', customerConfirmed: true,
    } as const;
    await new DeliveryStage().execute({
      message: {
        userId: 9, conversationId: 160, channel: 'instagram', senderIdentifier: 'ig-scoped-sender',
        inboundText: 'Yes', rawMessageId: 'ig.confirm', messageId: 201,
        metadata: { providerAccountId: 'ig-account' },
      },
      agentResult: { replyText: 'Model URL must not be used.', externalBookingHandoff: handoff },
      metadata: {},
    } as any);

    expect(mockSendInstagramDM).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: 'ig-scoped-sender',
      message: expect.stringContaining(handoff.url),
    }));
    expect((mockSendInstagramDM.mock.calls[0][0] as { message: string }).message)
      .not.toContain('Model URL must not be used.');
    expect(mockCompleteClaimedAction).toHaveBeenCalledWith(expect.anything(), 'ig.booking');
  });

  it('delivers the exact server-owned booking URL as a Facebook web URL action', async () => {
    const handoff = {
      mode: 'external_booking', propertyId: 1, roomTypeId: 2,
      checkIn: '2026-09-10', checkOut: '2026-09-12', guests: 2, rooms: 1,
      url: 'https://bookings.orocircle.com/?propertyId=10955', title: 'Book now', customerConfirmed: true,
    } as const;
    await new DeliveryStage().execute({
      message: {
        userId: 9, conversationId: 162, channel: 'facebook', senderIdentifier: 'fb-scoped-sender',
        inboundText: 'Yes', rawMessageId: 'fb.confirm', messageId: 202,
        metadata: { providerAccountId: 'fb-page' },
      },
      agentResult: { replyText: 'Model URL must not be used.', externalBookingHandoff: handoff },
      metadata: {},
    } as any);

    expect(mockSendFacebookDM).toHaveBeenCalledWith(expect.objectContaining({
      recipientId: 'fb-scoped-sender',
      message: expect.stringContaining(handoff.url),
      webUrlAction: { title: 'Book now', url: handoff.url },
    }));
    expect((mockSendFacebookDM.mock.calls[0][0] as { message: string }).message)
      .not.toContain('Model URL must not be used.');
    expect(mockCompleteClaimedAction).toHaveBeenCalledWith(expect.anything(), 'fb.booking');
  });
});

describe('active playbook selection policy precedence', () => {
  it('lets an exact callback choice reach the active playbook without disabling fixed safety', async () => {
    const graph = INDUSTRY_SUPPORT_PLAYBOOKS.find((item) => item.key === 'hospitality-sales-enquiries-v2')!.graph;
    mockDbExecute.mockResolvedValueOnce({ rows: [{
      id: 9,
      current_node_id: 'collect-stay-next',
      graph,
      state: initializeJourneyState(graph),
    }] });
    const ctx = {
      message: {
        userId: 9,
        conversationId: 68,
        channel: 'whatsapp',
        senderIdentifier: '916382775774',
        inboundText: 'Request a callback',
        metadata: {},
      },
      nlu: {
        intent: 'speak_to_human',
        secondaryIntents: [],
        needsHuman: true,
        riskLevel: 'low',
        riskFactors: [],
        classificationConfidence: 0.98,
      },
      confidence: 0.98,
      policyViolations: [],
      metadata: {
        agentConfig: {
          escalationRules: [{
            id: 'human-intents', type: 'auto_escalate_intent', enabled: true,
            config: { intents: ['speak_to_human'] },
          }],
        },
      },
    } as any;

    const selected = await new ActivePlaybookSelectionStage().execute(ctx);
    expect(selected.metadata?.activePlaybookSelection).toEqual(expect.objectContaining({
      runId: 9,
      nodeId: 'collect-stay-next',
      fieldKey: 'stay.nextStep',
      value: 'callback',
    }));
    await expect(new PostClassificationPolicyStage().execute(selected)).resolves.toBe(selected);
    await expect(new CanAIHandleGate().execute(selected)).resolves.toBe(selected);
    selected.agentResult = {
      replyText: 'What is your full name?',
      confidence: 1,
      escalated: false,
      toolCallsExecuted: [],
    };
    await expect(new ConfidenceGate().execute(selected)).resolves.toBe(selected);
    expect(selected.metadata?.playbookSelectionPolicyOverride).toBe('auto_escalate_intent');
    expect(selected.confidence).toBe(1);
    expect(selected.policyViolations).toEqual([]);
  });

  it('does not bypass human escalation for text that is not the exact active choice', async () => {
    mockDbExecute.mockResolvedValueOnce({ rows: [] });
    const ctx = {
      message: {
        userId: 9, conversationId: 68, channel: 'whatsapp', senderIdentifier: '916382775774',
        inboundText: 'Please connect me to a human now', metadata: {},
      },
      nlu: {
        intent: 'speak_to_human', secondaryIntents: [], needsHuman: true,
        riskLevel: 'low', riskFactors: [], classificationConfidence: 0.98,
      },
      confidence: 0.98,
      policyViolations: [],
      metadata: {},
    } as any;
    const selected = await new ActivePlaybookSelectionStage().execute(ctx);
    expect(selected.metadata?.activePlaybookSelection).toBeUndefined();
    await expect(new CanAIHandleGate().execute(selected)).rejects.toMatchObject({ outcome: 'human_handoff' });
  });
});
