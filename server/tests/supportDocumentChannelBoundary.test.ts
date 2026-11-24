import { describe, expect, it, jest } from '@jest/globals';

jest.unstable_mockModule('../models/db.js', () => ({ db: {} }));
jest.unstable_mockModule('../services/StorageService.js', () => ({ storageService: {} }));
const { requestedDocumentService } = await import('../services/supportDocuments/ApprovedSupportDocuments.js');
const semanticRequest = { action: 'document' as const, service: 'day_outing' as const,
  explicit: true, topicSwitch: true, pricingRequested: false, media: 'none' as const, confidence: 0.99 };

describe('approved-PDF channel authorization boundary', () => {
  it('selects an explicit approved-document topic on WhatsApp', () => {
    expect(requestedDocumentService({ channel: 'whatsapp', semanticRequest })).toBe('day_outing');
  });
  it('allows an authenticated widget without opening unauthenticated web delivery', () => {
    expect(requestedDocumentService({ channel: 'web', authenticatedWidget: true, semanticRequest })).toBe('day_outing');
    expect(requestedDocumentService({ channel: 'web', authenticatedWidget: false, semanticRequest })).toBeNull();
  });
  it.each(['web', 'instagram', 'facebook'])('does not authorize unverified document delivery on %s', channel => {
    expect(requestedDocumentService({ channel, semanticRequest })).toBeNull();
  });
  it.each([{ publicReply: true }, { outboundFirstTouch: true }])('blocks public or unsolicited widget delivery: %o', surface => {
    expect(requestedDocumentService({ channel: 'web', authenticatedWidget: true, semanticRequest, ...surface })).toBeNull();
  });
});
