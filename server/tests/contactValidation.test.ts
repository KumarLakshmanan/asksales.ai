import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';

// Contact-verification tests exercise the privacy-protection path with PII.
// Keep the fixture key disposable while preserving the production fail-closed
// requirement enforced by PrivacyVaultService.
process.env.SUPPORT_PII_ENCRYPTION_KEY = 'test-only-support-privacy-key-at-least-32-characters';

// Mocks
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockLeadRecord: any = null;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockDbExecute = jest.fn<any>().mockImplementation((sqlObj: any) => {
  const queryStr = sqlObj.strings ? sqlObj.strings.join(' ') : '';
  if (queryStr.includes('SELECT metadata FROM outreach_conversations')) {
    return Promise.resolve({ rows: [{ metadata: { salesAgent: { slots: {} } } }] });
  }
  if (queryStr.includes('FROM leads') && queryStr.includes('WHERE id =')) {
    return Promise.resolve({ rows: mockLeadRecord ? [mockLeadRecord] : [] });
  }
  if (queryStr.includes('FROM leads') && queryStr.includes('WHERE user_id =')) {
    return Promise.resolve({ rows: mockLeadRecord ? [mockLeadRecord] : [] });
  }
  if (queryStr.includes('SELECT') && queryStr.includes('FROM hotels')) {
    return Promise.resolve({ rows: [{ name: 'Grand Palace', city: 'Mumbai', amenities: ['wifi'], check_in_time: '14:00', check_out_time: '11:00' }] });
  }
  if (queryStr.includes('SELECT direction, content FROM outreach_messages')) {
    return Promise.resolve({ rows: [] });
  }
  return Promise.resolve({ rows: [] });
});

jest.unstable_mockModule('../models/db.js', () => ({
  db: {
    execute: mockDbExecute,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    select: jest.fn<any>().mockReturnValue({
      from: jest.fn<any>().mockReturnValue({
        where: jest.fn<any>().mockReturnValue({ limit: jest.fn<any>().mockResolvedValue([]) }),
      }),
    }),
    // SafeToolExecutor persists an idempotency claim around high-risk tools.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    insert: jest.fn<any>().mockReturnValue({
      values: jest.fn<any>().mockReturnValue({
        onConflictDoNothing: jest.fn<any>().mockReturnValue({
          returning: jest.fn<any>().mockResolvedValue([{ id: 1 }]),
        }),
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    update: jest.fn<any>().mockReturnValue({
      set: jest.fn<any>().mockReturnValue({ where: jest.fn<any>().mockResolvedValue([]) }),
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
  sql: Object.assign(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (strings: TemplateStringsArray, ...values: any[]) => ({ _tag: 'raw', strings, values }),
    { raw: jest.fn() }
  ),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockCreateChatCompletion = jest.fn<any>().mockResolvedValue({ success: true, content: 'Please confirm your details.' });
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
    getSemanticContext: jest.fn<any>().mockResolvedValue('Info'),
  },
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockNluAnalyze = jest.fn<any>().mockResolvedValue({
  intent: 'greeting',
  secondaryIntents: [],
  entities: {},
  sentiment: { label: 'neutral', score: 0 },
  urgency: 'low',
  summary: '',
});
jest.unstable_mockModule('../services/agents/NLUService.js', () => ({
  nluService: { analyze: mockNluAnalyze },
}));

jest.unstable_mockModule('../services/agents/SalesIntelligence.js', () => ({
  salesIntelligence: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loadMemory: jest.fn<any>().mockResolvedValue({}),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    saveMemory: jest.fn<any>().mockResolvedValue(undefined),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    computeIntelligence: jest.fn<any>().mockReturnValue({ leadScore: 50, bookingProbability: 10, value: 'low' }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mergeMemory: jest.fn<any>().mockReturnValue({}),
  },
}));

// Load the agent
const { hotelSalesAgent: whatsAppSalesAgent } = await import('../services/agents/HotelSalesAgent');
const { BookingSubAgent } = await import('../services/agents/subagents/BookingSubAgent');
const { NegotiationSubAgent } = await import('../services/agents/subagents/NegotiationSubAgent');
const handleInBusiness = (input: Parameters<typeof whatsAppSalesAgent.handle>[0]) =>
  withBusinessScope({ userId: input.userId, businessProfileId: 2 }, () => whatsAppSalesAgent.handle({ ...input, businessProfileId: 2 }));

describe('WhatsAppSalesAgent Contact Verification', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLeadRecord = null;
  });

  it('should identify a placeholder name correctly', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const isPlaceholder = (whatsAppSalesAgent as any).isPlaceholderName;
    expect(isPlaceholder('Guest')).toBe(true);
    expect(isPlaceholder('Instagram User')).toBe(true);
    expect(isPlaceholder('@john_doe')).toBe(true);
    expect(isPlaceholder('FB User 12345')).toBe(true);
    expect(isPlaceholder('WhatsApp Guest')).toBe(true);
    expect(isPlaceholder('John Doe')).toBe(false);
  });

  it('should look up lead by ID if provided, and seed slots', async () => {
    mockLeadRecord = { id: 101, name: 'John Doe', first_name: 'John', phone: '+123456' };

    await handleInBusiness({
      userId: 1,
      conversationId: 58,
      phoneNumberId: '109',
      inboundText: 'hello',
      leadId: 101,
      recipientPhone: '+123456',
      channel: 'whatsapp',
    });

    expect(mockCreateChatCompletion).toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = mockCreateChatCompletion.mock.calls[0] as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sysPrompt = calls[0].messages.find((m: any) => m.role === 'system').content;
    // Name is John Doe, phone is +123456. So both are known. Validation block should NOT be present.
    expect(sysPrompt).not.toContain('MANDATORY CONTACT VERIFICATION RULE');
  });

  it('should inject validation block when name is placeholder or a contact method is missing', async () => {
    mockLeadRecord = { id: 101, name: 'Guest', first_name: 'Guest', phone: null };

    await handleInBusiness({
      userId: 1,
      conversationId: 58,
      phoneNumberId: '109',
      inboundText: 'hello',
      leadId: 101,
      recipientPhone: 'ig_handle',
      channel: 'instagram',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const calls = mockCreateChatCompletion.mock.calls[0] as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sysPrompt = calls[0].messages.find((m: any) => m.role === 'system').content;
    expect(sysPrompt).toContain('MANDATORY CONTACT VERIFICATION RULE');
    expect(sysPrompt).toContain('You do not have their real name');
    expect(sysPrompt).toContain('You do not have a contact method');
  });

  it('keeps booking guest details separate from the sender contact identity', async () => {
    const mockCtx = {
      userId: 1,
      conversationId: 58,
      channel: 'whatsapp',
      inboundText: 'hello',
      nlu: { intent: 'booking' },
      slots: {},
      memory: {},
      intel: {},
      lead: { id: 101, recipientPhone: '+123456' },
      agentConfig: null,
      history: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    const out = await new BookingSubAgent().execute(
      'save_booking_details',
      { guest_name: 'Jane Doe', guest_phone: '+987654' },
      mockCtx,
    );

    expect(out.effectProposals).toEqual([]);
    expect(out.slotsUpdate).toMatchObject({ guestName: 'Jane Doe', guestPhone: '+987654' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateCall = mockDbExecute.mock.calls.find((call: any) => {
      const q = call[0].strings ? call[0].strings.join(' ') : '';
      return q.includes('UPDATE leads') && q.includes('SET name =');
    });
    expect(updateCall).toBeUndefined();
  });

  it.each([
    { name: 'Guest', phone: '+123456', missingName: true, missingContact: false },
    { name: 'John Doe', phone: null, missingName: false, missingContact: true },
  ])('requires each missing identity field independently: %j', async ({ name, phone, missingName, missingContact }) => {
    mockLeadRecord = { id: 101, name, phone };
    await handleInBusiness({ userId: 1, conversationId: 58, phoneNumberId: '109', leadId: 101, inboundText: 'hello', channel: 'instagram', recipientPhone: 'ig_handle' });
    const options = mockCreateChatCompletion.mock.calls[0][0] as { messages: { role: string; content: string }[] };
    const prompt = options.messages.find(message => message.role === 'system')!.content;
    expect(prompt).toContain('MANDATORY CONTACT VERIFICATION RULE');
    expect(prompt.includes('You do not have their real name')).toBe(missingName);
    expect(prompt.includes('You do not have a contact method')).toBe(missingContact);
    expect(prompt).toContain('before transactional booking actions');
  });

  it('should use dynamic stay-specific availability price as base price in quote_or_negotiate_price', async () => {
    const mockCtx = {
      userId: 1,
      conversationId: 58,
      channel: 'whatsapp',
      inboundText: 'how much is it?',
      nlu: { intent: 'pricing_question' },
      slots: {
        checkIn: '2026-06-25',
        checkOut: '2026-06-26',
        guests: 1,
        rooms: 1,
      },
      memory: {},
      intel: {},
      lead: { id: 101, recipientPhone: '+123456' },
      agentConfig: null,
      history: [],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;

    // First DB query: the tenant-owned room type.
    // Second DB query: the full-stay aggregate availability/rate query.
    mockDbExecute
      .mockResolvedValueOnce({ rows: [{ id: 202, hotel_id: 1, capacity: 2, base_price: 125000, min_price: 80000, max_discount_pct: 20, name: 'Deluxe Suite', currency: 'INR', amenities: [] }] })
      .mockResolvedValueOnce({ rows: [{ id: 202, hotel_id: 1, capacity: 2, base_price: 125000, min_price: 80000, max_discount_pct: 20, name: 'Deluxe Suite', currency: 'INR', amenities: [], highest_nightly_rate: 100000, stay_rate: 100000, available_count: 5 }] });

    const out = await new NegotiationSubAgent().execute(
      'quote_or_negotiate_price',
      { room_type_id: 202 },
      mockCtx,
    );

    // basePrice in deal should be 100000 (from room_availability) instead of 125000 (from room_types base_price)
    const result = out.toolResults?.[0]?.result as Record<string, unknown>;
    expect(result.base_price).toBe(100000);
    expect(result.offer_price_per_night).toBe(100000); // round 0 concession is base price
  });
});
