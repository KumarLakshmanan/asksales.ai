import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const complete = jest.fn<(userId: number, options: { loggingContext: { purpose: string } }) => Promise<{ success: boolean; content?: string }>>();
jest.unstable_mockModule('../services/agents/LLMProviderFactory.js', () => ({
  LLMProviderFactory: { createChatCompletionWithFallback: complete },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const { looksEnglish, replyTargetLanguage, localizeGovernedReply } = await import('../services/agents/orchestration/ReplyLanguage.js');
const { ReplyLanguageStage } = await import('../services/agents/pipeline/stages/ReplyLanguageStage.js');

const tamil = { code: 'ta', name: 'Tamil', confidence: 0.95 };
const english = 'I’m not sure about that from the confirmed information available. Would you like me to connect you with a human support agent?';
const translated = 'உறுதிப்படுத்தப்பட்ட தகவலில் அது பற்றி எனக்குத் தெரியவில்லை. மனித உதவியாளருடன் இணைக்கவா?';

function respond(draft: unknown, review: unknown) {
  complete.mockImplementation(async (_user, options) => options.loggingContext.purpose === 'reply_localization'
    ? { success: true, content: JSON.stringify(draft) }
    : { success: true, content: JSON.stringify(review) });
}
const approved = { faithful: true, languageMatches: true, noAdditions: true, confidence: 0.97 };

function ctx(overrides: Record<string, any> = {}) {
  return {
    message: { userId: 4, conversationId: 9, channel: 'whatsapp', senderIdentifier: 'x', inboundText: 'x' },
    nlu: { customerLanguage: tamil },
    agentResult: { replyText: english, escalated: false },
    confidence: 1, policyViolations: [], metadata: {},
    ...overrides,
  } as any;
}

beforeEach(() => { complete.mockReset(); });

describe('reply language detection', () => {
  it('targets confident non-English customers only', () => {
    expect(replyTargetLanguage(tamil)).toEqual(tamil);
    expect(replyTargetLanguage({ code: 'en-IN', name: 'English', confidence: 0.99 })).toBeNull();
    expect(replyTargetLanguage({ code: 'ta', name: 'Tamil', confidence: 0.6 })).toBeNull();
    expect(replyTargetLanguage(undefined)).toBeNull();
  });

  it.each([
    [english, true],
    ['Please confirm the check-in and check-out dates.', true],
    [translated, false],
    ['Ungalukku room venuma? Naan check panren.', false],
    ['https://book.example.com/?propertyId=1', false],
  ])('looksEnglish(%s) is %s', (text, expected) => expect(looksEnglish(text)).toBe(expected));
});

describe('localizeGovernedReply', () => {
  it('returns a translation only after an approving review', async () => {
    respond({ reply: translated }, approved);
    await expect(localizeGovernedReply({ userId: 4, text: english, language: tamil })).resolves.toBe(translated);
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['a rejecting review', { reply: translated }, { ...approved, faithful: false }],
    ['a low-confidence review', { reply: translated }, { ...approved, confidence: 0.5 }],
    ['an empty translation', { reply: '' }, approved],
  ])('keeps English after %s', async (_label, draft, review) => {
    respond(draft, review);
    await expect(localizeGovernedReply({ userId: 4, text: english, language: tamil })).resolves.toBeNull();
  });

  it('rejects a translation that alters a link or redaction token', async () => {
    const text = 'Book here: https://book.example.com/?propertyId=1 for [NAME_12].';
    respond({ reply: 'இங்கே பதிவு செய்யவும்: https://book.example.com/ [NAME_12]' }, approved);
    await expect(localizeGovernedReply({ userId: 4, text, language: tamil })).resolves.toBeNull();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('keeps English when the provider fails', async () => {
    complete.mockRejectedValue(new Error('provider down'));
    await expect(localizeGovernedReply({ userId: 4, text: english, language: tamil })).resolves.toBeNull();
  });
});

describe('ReplyLanguageStage', () => {
  it('translates a fixed reply and keeps playbook verbatim compliance aligned', async () => {
    respond({ reply: translated }, approved);
    const context = ctx({ metadata: { playbookDirective: { compliance: { verbatim: english } } } });
    await new ReplyLanguageStage().execute(context);
    expect(context.agentResult.replyText).toBe(translated);
    expect(context.metadata.playbookDirective.compliance.verbatim).toBe(translated);
    expect(context.metadata.replyLanguage).toEqual({ target: 'ta', status: 'translated' });
  });

  it.each([
    ['a grounded knowledge answer', ctx({ agentResult: { replyText: english, answerVerification: { mayDeliver: true } } })],
    ['an English-speaking customer', ctx({ nlu: { customerLanguage: { code: 'en', name: 'English', confidence: 1 } } })],
    ['required playbook phrases', ctx({ metadata: { playbookDirective: { compliance: { requiredPhrases: ['human support agent'] } } } })],
    ['a reply that only contains the verbatim text', ctx({ metadata: { playbookDirective: { compliance: { verbatim: 'connect you' } } } })],
    ['a reply already in Tamil', ctx({ agentResult: { replyText: translated } })],
  ])('does not call the model for %s', async (_label, context) => {
    const before = context.agentResult.replyText;
    await new ReplyLanguageStage().execute(context);
    expect(complete).not.toHaveBeenCalled();
    expect(context.agentResult.replyText).toBe(before);
  });

  it('keeps the English reply and records why when translation is not verified', async () => {
    respond({ reply: translated }, { ...approved, noAdditions: false });
    const context = ctx();
    await new ReplyLanguageStage().execute(context);
    expect(context.agentResult.replyText).toBe(english);
    expect(context.metadata.replyLanguage).toEqual({ target: 'ta', status: 'kept_english' });
  });
});

describe('NLU customer language parsing', () => {
  it('accepts well-formed language tags and rejects anything else', async () => {
    const { parseCustomerLanguage } = await import('../services/agents/NLUService.js');
    expect(parseCustomerLanguage({ code: 'ta-Latn', name: 'Tamil written in English letters', confidence: 0.9 }))
      .toEqual({ code: 'ta-Latn', name: 'Tamil written in English letters', confidence: 0.9 });
    expect(parseCustomerLanguage({ code: 'Tamil', name: 'Tamil', confidence: 0.9 })).toBeUndefined();
    expect(parseCustomerLanguage({ code: 'ta', name: 'Tamil', confidence: 2 })).toBeUndefined();
    expect(parseCustomerLanguage({ code: 'ta', name: '', confidence: 0.9 })).toBeUndefined();
    expect(parseCustomerLanguage('ta')).toBeUndefined();
  });
});
