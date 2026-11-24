import { describe, expect, it, jest } from '@jest/globals';
import { fitPublishedQuote } from '../services/knowledge/KnowledgeQuoteFormatting.js';
import { guardrailService } from '../services/agents/pipeline/GuardrailService.js';
import type { VerifiedKnowledgeAnswer } from '../services/knowledge/types.js';
import type { PipelineContext } from '../services/agents/pipeline/ChannelGateway.js';

jest.unstable_mockModule('../services/agents/pipeline/HandoffService.js', () => ({
  handoffService: { customerAcknowledgement: jest.fn(() => 'Human review required.') },
}));

const paragraphs = ['First package: Rs. 3,499 + GST with lunch and activities.',
  'Second package: Rs. 4,299 + GST with breakfast and lunch.',
  'Terms & Conditions\nPrices exclude GST and vary on holidays.'];
const verification: VerifiedKnowledgeAnswer = { reason: 'verbatim_published_evidence', mayDeliver: true,
  answerGrounding: 'grounded', unsupportedClaims: [], claims: paragraphs.map((claim, i) => ({
    claimId: String(i), claim, origin: 'knowledge', evidenceIds: ['KB-1'], verdict: 'supported',
  })) };
const full = `From the published knowledge base:\n\n${paragraphs.join('\n\n')}\n\nPlease choose a package.`;

describe('published quotation length integrity', () => {
  it('does not slice a natural answer and lose its qualification', async () => {
    const text = 'Spa services cost INR 2000, excluding tax and subject to the published cancellation conditions.';
    const ctx = { message: { userId: 9, conversationId: -1, channel: 'whatsapp', senderIdentifier: 'qa', inboundText: 'Spa information?' },
      confidence: 1, policyViolations: [], agentResult: { replyText: text, escalated: false,
        answerVerification: { ...verification, reason: 'verified_natural_knowledge_answer' } },
      metadata: { agentConfig: { escalationRules: [{ id: 'length', type: 'max_response_length', enabled: true,
        config: { maxChars: 40, action: 'truncate' } }] } },
    } as PipelineContext;
    const result = await guardrailService.checkOutbound(text, ctx);
    expect(result.safe).toBe(false);
    expect(result.modifications.some(modification => modification.type === 'length_truncated')).toBe(false);
  });
  it('keeps all quotes and terms across owner-preview bubbles instead of dropping options', async () => {
    const ctx = { message: { userId: 9, conversationId: -1, channel: 'whatsapp', senderIdentifier: 'qa', inboundText: 'All package options?',
      metadata: { executionMode: 'advisory', conversationKind: 'owner_support' } }, confidence: 1, policyViolations: [],
      agentResult: { replyText: full, escalated: false, answerVerification: verification },
      metadata: { agentConfig: { escalationRules: [{ id: 'length', type: 'max_response_length', enabled: true,
        config: { maxChars: 100, action: 'truncate' } }] } },
    } as PipelineContext;
    const result = await guardrailService.checkOutbound(full, ctx);
    expect(result.safe).toBe(true);
    expect(result.finalText.split('|||').every(part => part.length <= 100)).toBe(true);
    for (const paragraph of paragraphs) expect(result.finalText).toContain(paragraph);
    expect(ctx.agentResult?.answerVerification?.claims).toHaveLength(3);
  });
  it('retains complete paragraphs, all terms, and the follow-up within the limit', () => {
    const fitted = fitPublishedQuote(full, verification, 200)!;
    expect(fitted.text.length).toBeLessThanOrEqual(200);
    expect(fitted.text).toContain(paragraphs[0]);
    expect(fitted.text).not.toContain(paragraphs[1]);
    expect(fitted.text).toContain(paragraphs[2]);
    expect(fitted.text).toContain('Please choose a package.');
    expect(fitted.verification.claims).toHaveLength(2);
    expect(fitted.text).not.toMatch(/Published excerpt|knowledge base/);
  });

  it('keeps a complete package, source terms, and ticket ownership under a 900-character policy', async () => {
    const sourceClaims = [
  {
    "claim": "O R O T H E E S T A T E | NANDI HILLS, BENGALURU\nOro The Estate • Day Out Packages • Page 1\nO R O T H E E S T AT E\nDAY OUT PACKAGES\nAn indulgent day of dining, leisure and play amidst the hills of Nandi\nRs. 4,299 + GST\nBreakfast, Lunch & Hi-Tea\n• Welcome breakfast spread\n• Multi-cuisine lunch buffet\n• Evening hi-tea with snacks",
    "origin": "knowledge",
    "claimId": "KB-18-V2-C0:paragraph:0",
    "verdict": "supported",
    "evidenceIds": [
      "KB-18-V2-C0"
    ]
  },
  {
    "claim": "Rs. 3,499 + GST\nLunch, Hi-Tea & Activities\n• Multi-cuisine lunch buffet\n• Evening hi-tea with snacks\n• Access to indoor, outdoor & kids' activities",
    "origin": "knowledge",
    "claimId": "KB-18-V2-C0:paragraph:1",
    "verdict": "supported",
    "evidenceIds": [
      "KB-18-V2-C0"
    ]
  },
  {
    "claim": "Rs. 5,499 + GST\nLunch, Hi-Tea, Dinner & Activities\n• Multi-cuisine lunch buffet\n• Evening hi-tea with snacks\n• Multi-cuisine dinner buffet\n• Access to indoor, outdoor & kids' activities\nACTIVITIES AT THE PROPERTY\nIndoor\n• Billiards\n• Foosball\n• Table Tennis\n• Air Hockey\n• Carrom\n• Poker & Chess\nOutdoor\n• Beach Volleyball\n• Mini Golf\n• Tennis Court\n• Basketball Court\n• Multi-Sports Turf\n• Spa & Wellness (additional\ncost)\nKids\n• Swimming Pool & Water Slide\n• Adventure Playground\n• Multi-Sports Turf\n• Nature Exploration\nDAY-OUTING PRIVILEGES",
    "origin": "knowledge",
    "claimId": "KB-18-V2-C0:paragraph:2",
    "verdict": "supported",
    "evidenceIds": [
      "KB-18-V2-C0"
    ]
  },
  {
    "claim": "O R O T H E E S T A T E | NANDI HILLS, BENGALURU\nOro The Estate • Day Out Packages • Page 2\nPrivilege Discount\nDay Use Rooms (12 Noon – 9 PM) 25% off regular tariff\nSpa Treatments 25% off\nSoft Beverages & Liquor 20% off\nTerms & Conditions\n• Day outing timings: 10:00 AM to 6:00 PM, unless a day use room is booked.\n• Prices are per person and exclusive of applicable GST.\n• Activities are subject to weather conditions and availability.\n• Spa & Wellness services are chargeable separately, with the privilege discount applied.\n• Packages and pricing are subject to change without prior notice and may vary on weekends,\nlong weekends and holidays.",
    "origin": "knowledge",
    "claimId": "KB-18-V2-C0:paragraph:3",
    "verdict": "supported",
    "evidenceIds": [
      "KB-18-V2-C0"
    ]
  }
];
    const verified = { ...verification, claims: sourceClaims } as VerifiedKnowledgeAnswer;
    const reply = `From the published knowledge base:\n\n${sourceClaims.map(claim => claim.claim).join('\n\n')}`;
    const ctx = {
      message: { userId: 9, conversationId: -1, channel: 'instagram', senderIdentifier: 'qa', inboundText: 'Day-out packages and terms?' },
      nlu: { intent: 'faq', secondaryIntents: [], entities: {}, sentiment: { label: 'neutral', score: 0 },
        urgency: 'low', needsHuman: false, summary: '', riskLevel: 'low', riskFactors: [], classificationConfidence: 1 }, confidence: 1, policyViolations: [],
      agentResult: { replyText: reply, escalated: false, answerVerification: verified, claimEvidence: sourceClaims },
      metadata: { ticketReadOnlyAnswer: true, activeHandoff: { id: 1 },
        agentConfig: { escalationRules: [{ id: 'length', type: 'max_response_length', enabled: true, config: { maxChars: 900, action: 'truncate' } }] } },
    } as PipelineContext;
    const { TicketAwareResponseStage } = await import('../services/agents/pipeline/stages/TicketAwareResponseStage.js');
    await new TicketAwareResponseStage().execute(ctx);
    const result = await guardrailService.checkOutbound(ctx.agentResult!.replyText, ctx);
    expect(result.safe).toBe(true);
    expect(result.finalText.length).toBeLessThanOrEqual(900);
    expect(result.finalText).toContain(sourceClaims[1].claim);
    expect(result.finalText).toContain(sourceClaims[3].claim);
    expect(result.finalText).toContain('Your support ticket remains open for the team to review.');
    expect(ctx.agentResult?.effectProposals).toEqual([]);
    expect(ctx.agentResult?.toolCallsExecuted).toEqual([]);
  });
  it('fails closed when full terms and a factual paragraph cannot fit', () => {
    expect(fitPublishedQuote(full, verification, 60)).toBeNull();
  });
  it('never reconstructs text that privacy filtering changed', () => {
    expect(fitPublishedQuote(full.replace('First package', '[REDACTED]'), verification, 200)).toBeNull();
  });
  it('enforces the policy through the actual outbound guardrail without cutting terms', async () => {
    const ctx: PipelineContext = { message: { userId: 9, conversationId: -1, channel: 'web',
      senderIdentifier: 'test', inboundText: 'Packages?' }, confidence: 1, policyViolations: [],
      agentResult: { replyText: full, escalated: false, answerVerification: verification },
      metadata: { agentConfig: { escalationRules: [{ id: 'length', type: 'max_response_length',
        enabled: true, config: { maxChars: 200, action: 'truncate' } }] } },
    };
    const result = await guardrailService.checkOutbound(full, ctx);
    expect(result.safe).toBe(true);
    expect(result.finalText.length).toBeLessThanOrEqual(200);
    expect(result.finalText).toContain(paragraphs[2]);
    expect(ctx.agentResult?.answerVerification?.claims).toHaveLength(2);
  });
});
