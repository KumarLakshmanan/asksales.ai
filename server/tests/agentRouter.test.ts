import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { semanticIntent } from './helpers/supportSemanticFixture.js';

// ── Mocks ──────────────────────────────────────────────────────────────
let contactExists = false;
let modelDecision: Record<string, unknown> = {};

jest.unstable_mockModule('../services/whatsappApiService.js', () => ({
  whatsappApiService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendText: jest.fn<any>().mockResolvedValue({ success: true, messages: [{ id: 'wamid.reply123' }] }),
  },
}));

jest.unstable_mockModule('../services/instagramService.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendInstagramDM: jest.fn<any>().mockResolvedValue({ success: true, externalMessageId: 'ig.reply123' }),
}));

jest.unstable_mockModule('../services/FacebookMessengerService.js', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendFacebookDM: jest.fn<any>().mockResolvedValue({ success: true, externalMessageId: 'fb.reply123' }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDbExecute = jest.fn<any>().mockImplementation((sqlObj: any) => {
  const queryStr = sqlObj.strings ? sqlObj.strings.join(' ') : '';
  const values = sqlObj.values || [];
  
  if (queryStr.includes('crm_contacts')) {
    const leadId = values[0];
    if (leadId === 100) {
      // Tech support test: contact already exists
      return Promise.resolve({ rows: [{ id: 42 }] });
    }
    if (leadId === 200) {
      // Lead qualifier test: returns existing contact id if contactExists is true
      return Promise.resolve({ rows: contactExists ? [{ id: 42 }] : [] });
    }
  }
  
  if (queryStr.includes('SELECT created_at FROM leads')) {
    const leadId = values[0];
    if (leadId === 100) {
      return Promise.resolve({ rows: [{ created_at: new Date(Date.now() - 3600000).toISOString() }] });
    }
    if (leadId === 200) {
      return Promise.resolve({ rows: [{ created_at: new Date().toISOString() }] });
    }
  }

  return Promise.resolve({ rows: [] });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockEnsureContactForInbound = jest.fn<any>().mockImplementation(() => {
  contactExists = true;
  return Promise.resolve(undefined);
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockUpdatePipelineStatus = jest.fn<any>().mockResolvedValue(undefined);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateActivityReminder = jest.fn<any>().mockResolvedValue(undefined);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockFireEvent = jest.fn<any>().mockResolvedValue(undefined);

jest.unstable_mockModule('../models/db.js', () => ({
  db: {
    execute: mockDbExecute,
    transaction: jest.fn(async (callback: (tx: { execute: typeof mockDbExecute }) => Promise<unknown>) => callback({ execute: mockDbExecute })),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select: jest.fn<any>().mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      from: jest.fn<any>().mockReturnValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: jest.fn<any>().mockReturnValue({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          limit: jest.fn<any>().mockResolvedValue([]),
        }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insert: jest.fn<any>().mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      values: jest.fn<any>().mockReturnValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        returning: jest.fn<any>().mockResolvedValue([{ id: 1 }]),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: jest.fn<any>().mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      set: jest.fn<any>().mockReturnValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        where: jest.fn<any>().mockReturnValue({
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          returning: jest.fn<any>().mockResolvedValue([{ id: 1 }]),
        }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete: jest.fn<any>().mockReturnValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: jest.fn<any>().mockReturnValue({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        returning: jest.fn<any>().mockResolvedValue([{ id: 1 }]),
      }),
    }),
  },
}));

jest.unstable_mockModule('drizzle-orm', () => ({
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  eq: jest.fn<any>().mockReturnValue('eq'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ne: jest.fn<any>().mockReturnValue('ne'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  and: jest.fn<any>().mockReturnValue('and'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  or: jest.fn<any>().mockReturnValue('or'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  not: jest.fn<any>().mockReturnValue('not'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  like: jest.fn<any>().mockReturnValue('like'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ilike: jest.fn<any>().mockReturnValue('ilike'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gte: jest.fn<any>().mockReturnValue('gte'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lte: jest.fn<any>().mockReturnValue('lte'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  gt: jest.fn<any>().mockReturnValue('gt'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  lt: jest.fn<any>().mockReturnValue('lt'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  between: jest.fn<any>().mockReturnValue('between'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isNull: jest.fn<any>().mockReturnValue('isNull'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  isNotNull: jest.fn<any>().mockReturnValue('isNotNull'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  exists: jest.fn<any>().mockReturnValue('exists'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  notExists: jest.fn<any>().mockReturnValue('notExists'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  desc: jest.fn<any>().mockReturnValue('desc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  asc: jest.fn<any>().mockReturnValue('asc'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inArray: jest.fn<any>().mockReturnValue('inArray'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  count: jest.fn<any>().mockReturnValue('count'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sum: jest.fn<any>().mockReturnValue('sum'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  avg: jest.fn<any>().mockReturnValue('avg'),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  max: jest.fn<any>().mockReturnValue('max'),
  sql: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (strings: TemplateStringsArray, ...values: any[]) => ({ _tag: 'raw', strings, values }),
    { raw: jest.fn() }
  ),
}));

jest.unstable_mockModule('../services/CRMService.js', () => ({
  lockCrmContactResolution: jest.fn(async () => undefined),
  crmService: {
    ensureContactForInbound: mockEnsureContactForInbound,
    updatePipelineStatus: mockUpdatePipelineStatus,
  },
}));

jest.unstable_mockModule('../services/ReminderService.js', () => ({
  reminderService: {
    createActivityReminder: mockCreateActivityReminder,
  },
}));

jest.unstable_mockModule('../services/AlertService.js', () => ({
  alertService: {
    fireEvent: mockFireEvent,
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateChatCompletion = jest.fn<any>().mockResolvedValue({
  success: true,
  content: 'Default mock agent reply.',
});
// The production agents now use the governed cross-provider entry point after
// resolving a provider only for its default-model metadata.
const mockCreateChatCompletionWithFallback = jest.fn<any>().mockImplementation(
  (_userId: number, options: unknown) => mockCreateChatCompletion(options),
);

jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    createProviderForUser: jest.fn<any>().mockResolvedValue({
      defaultModel: 'gpt-4o-mini',
      createChatCompletion: mockCreateChatCompletion,
      getProviderName: () => 'mock',
    }),
    createChatCompletionWithFallback: mockCreateChatCompletionWithFallback,
  },
}));

jest.unstable_mockModule('../services/KnowledgeBaseService.js', () => ({
  knowledgeBaseService: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getSemanticContext: jest.fn<any>().mockResolvedValue('Product documentation context.'),
  },
}));

jest.unstable_mockModule('../services/SentimentAnalysisService.js', () => ({
  sentimentAnalysisService: {
    analyzeSentiment: jest.fn<any>().mockResolvedValue({ sentiment: 'neutral', score: 0, keywords: [] }),
  },
}));

jest.unstable_mockModule('../services/agents/NLUService.js', () => ({
  nluService: {
    analyze: jest.fn<any>().mockImplementation(() => Promise.resolve({
      intent: 'support_request',
      secondaryIntents: [],
      entities: {},
      sentiment: { label: 'neutral', score: 0 },
      urgency: 'low',
      needsHuman: false,
      summary: 'Routine customer request',
      riskLevel: 'low',
      riskFactors: [],
      classificationConfidence: 0.99,
      ...modelDecision,
    })),
  },
}));

jest.unstable_mockModule('../services/agents/orchestration/PlaybookEngine.js', () => ({
  playbookEngine: { resolve: jest.fn<any>().mockResolvedValue(null), evaluateCompliance: jest.fn<any>() },
}));

jest.unstable_mockModule('../services/agents/orchestration/DeliveryOutboxService.js', () => ({
  deliveryOutboxService: {
    claim: jest.fn<any>().mockResolvedValue({
      state: 'claimed',
      action: { id: 501, providerMessageId: null, status: 'sending' },
    }),
    markSent: jest.fn<any>().mockResolvedValue(undefined),
    markFailed: jest.fn<any>().mockResolvedValue(undefined),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockAgentConfigs: any[] = [];
jest.unstable_mockModule('../models/aiAgentConfigs/functions.js', () => ({
  getActiveAiAgentConfig: jest.fn<any>().mockImplementation(() =>
    Promise.resolve(mockAgentConfigs.find((config) => config.enabled) || null)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAiAgentConfigs: jest.fn<any>().mockImplementation(() => Promise.resolve(mockAgentConfigs)),
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getAiAgentConfigByType: jest.fn<any>().mockImplementation((userId: number, type: string) =>
    Promise.resolve(mockAgentConfigs.find((c) => c.agentType === type) || null)
  ),
}));

// Load dependencies
const { agentRouter } = await import('../services/agents/AgentRouter.js');
const { techSupportAgent } = await import('../services/agents/TechSupportAgent.js');
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { leadQualifierAgent } = await import('../services/agents/LeadQualifierAgent.js');
const { customerSuccessAgent } = await import('../services/agents/CustomerSuccessAgent.js');
const { generalServiceAgent } = await import('../services/agents/GeneralServiceAgent.js');

describe('AgentRouter & Specialized Agents Unit Tests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockAgentConfigs = [];
    contactExists = false;
    modelDecision = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (process as any).__mockLLMProviderFactory = jest.fn<any>().mockResolvedValue({
      defaultModel: 'gpt-4o-mini',
      createChatCompletion: mockCreateChatCompletion,
    });
  });

  describe('AgentRouter dispatch and post-processing', () => {
    it('refuses a business-global tech-support config without a published account assignment', async () => {
      // 1. Setup config for tech_support active on whatsapp
      mockAgentConfigs = [
        {
          id: 1,
          enabled: true,
          agentType: 'tech_support',
          channelScope: ['whatsapp'],
          priority: 1,
          systemPrompt: 'Resolve user issues patienty.',
        },
      ];

      mockCreateChatCompletion.mockResolvedValue({
        success: true,
        content: 'Have you tried resetting your device?',
      });

      const res = await agentRouter.handle({
        userId: 1,
        conversationId: 10,
        channel: 'whatsapp',
        inboundText: 'App is crashing on start',
        leadId: 100,
        leadName: 'John Doe',
        recipientPhone: '+123456',
        rawMessageId: 'wamid.tech-inbound',
        sentiment: { sentiment: 'negative', score: -0.8, keywords: [] },
        metadata: { dryRun: true },
      });

      expect(res).toBeDefined();
      expect(res?.replyText).toBe('');
      expect(res?.deliveryOutcome).toBe('no_op');
      expect(res?.escalated).toBe(false);
      expect(mockEnsureContactForInbound).not.toHaveBeenCalled();
      expect(mockUpdatePipelineStatus).not.toHaveBeenCalled();
      expect(mockCreateActivityReminder).not.toHaveBeenCalled();
    });

    it('does not use a business-global lead qualifier as a simulator fallback', async () => {
      modelDecision = { intent: 'purchase_intent', entities: { budgetAmount: 10000, timeline: 'ASAP' } };
      mockAgentConfigs = [
        {
          id: 2,
          enabled: true,
          agentType: 'lead_qualifier',
          channelScope: ['instagram'],
          priority: 1,
        },
      ];

      mockCreateChatCompletion.mockResolvedValue({
        success: true,
        content: 'Tell me more about your team size and timeline.',
      });

      const res = await agentRouter.handle({
        userId: 1,
        conversationId: 20,
        channel: 'instagram',
        inboundText: 'Interested in buying. Timeline is ASAP, budget is $10k.',
        leadId: 200,
        leadName: 'Jane Smith',
        recipientPhone: 'jane_inst',
        rawMessageId: 'ig.lead-inbound',
        metadata: { dryRun: true },
      });

      expect(res).toBeDefined();
      expect(res?.deliveryOutcome).toBe('no_op');
      expect(res?.crmPipelineStatus).toBeUndefined();

      expect(mockFireEvent).not.toHaveBeenCalled();
      expect(mockEnsureContactForInbound).not.toHaveBeenCalled();
    });
  });

  describe('Specialized Agents unit behaviors', () => {
    it('TechSupportAgent uses the model confirmation of resolution', async () => {
      modelDecision = { semanticRequest: semanticIntent('resolution_confirmed', 'technical_support') };
      mockCreateChatCompletion.mockResolvedValue({
        success: true,
        content: 'Awesome! Glad it is fixed.',
      });

      const result = await techSupportAgent.handle({
        userId: 1,
        conversationId: 30,
        channel: 'whatsapp',
        phoneNumberId: null,
        inboundText: 'Thank you, it works now!',
        sentiment: { sentiment: 'positive', score: 0.9, keywords: [] },
        agentConfig: null,
      });

      expect(result.crmPipelineStatus).toBe('ticket_closed');
      expect(result.scheduleReminder).toBeUndefined(); // Should not schedule follow-up if resolved
    });

    it('CustomerSuccessAgent should not schedule a reminder without explicit consent', async () => {
      mockCreateChatCompletion.mockResolvedValue({
        success: true,
        content: 'I am so sorry to hear that.',
      });

      const result = await customerSuccessAgent.handle({
        userId: 1,
        conversationId: 40,
        channel: 'email',
        phoneNumberId: null,
        inboundText: 'Very unhappy with service.',
        sentiment: { sentiment: 'negative', score: -0.7, keywords: [] },
        agentConfig: null,
      });

      expect(result.crmPipelineStatus).toBe('ticket_open');
      expect(result.scheduleReminder).toBeUndefined();
      expect(result.followUp).toEqual({ eligible: true, consent: 'unknown' });
    });

    it('GeneralServiceAgent should mark an unresolved inquiry follow-up as consent pending', async () => {
      modelDecision = { intent: 'pricing_question' };
      mockCreateChatCompletion.mockResolvedValue({
        success: true,
        content: 'I apologize, but I do not know the pricing structure.',
      });

      const result = await generalServiceAgent.handle({
        userId: 1,
        conversationId: 50,
        channel: 'facebook',
        phoneNumberId: null,
        inboundText: 'How much for enterprise plan?',
        agentConfig: null,
      });

      expect(result.crmPipelineStatus).toBe('contacted');
      expect(result.scheduleReminder).toBeUndefined();
      expect(result.outcome).toBe('insufficient_information');
      expect(result.followUp).toEqual({ eligible: true, consent: 'unknown' });
    });
  });
});
