import { beforeEach, describe, expect, it, jest } from '@jest/globals';

process.env.SUPPORT_PII_ENCRYPTION_KEY = 'test-only-support-pii-key-0123456789abcdef';

const updates: Array<Record<string, unknown>> = [];
const chain = <T>(result: T) => {
  const node: Record<string, unknown> = {};
  for (const step of ['from', 'where', 'values', 'onConflictDoNothing']) node[step] = () => node;
  node.limit = async () => result;
  node.returning = async () => result;
  return node;
};
const tx = {
  insert: () => chain([{ id: 55 }]),
  update: () => ({
    set: (values: Record<string, unknown>) => { updates.push(values); return chain([{ id: 91 }]); },
  }),
  execute: async () => ({ rows: [{ id: 1 }] }),
};
jest.unstable_mockModule('../models/db.js', () => ({
  db: {
    select: () => chain([]),
    transaction: async (work: (t: typeof tx) => Promise<void>) => work(tx),
  },
}));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn(), info: jest.fn(), debug: jest.fn(), error: jest.fn() } }));
const { privacyVaultService } = await import('../services/agents/orchestration/PrivacyVaultService.js');

const form = 'Full name: Priya Shah\nPhone number: +91 98765 43210\nEmail: priya@example.com\nCard: 4242 4242 4242 4242';

describe('protectInbound stored text', () => {
  beforeEach(() => { updates.length = 0; });

  it('stores WhatsApp contact details for people and keeps the model copy masked', async () => {
    const result = await privacyVaultService.protectInbound({
      userId: 7, conversationId: 29, channel: 'whatsapp', rawText: form,
      providerMessageId: 'wamid.1', messageId: 91, entityType: 'outreach_message', entityId: 91,
    });
    expect(result.vaultId).toBe(55);
    const stored = updates[0];
    expect(stored.content).toContain('Priya Shah');
    expect(stored.content).toContain('+91 98765 43210');
    expect(stored.content).toContain('priya@example.com');
    expect(stored.content).not.toContain('4242');
    expect(stored.redactedContent).not.toContain('Priya Shah');
    expect(stored.redactedContent).not.toContain('98765');
    expect(stored.redactedContent).not.toContain('priya@example.com');
  });

  it.each(['sms', 'instagram', 'email'])('keeps %s stored text masked', async channel => {
    await privacyVaultService.protectInbound({
      userId: 7, conversationId: 29, channel, rawText: form,
      providerMessageId: `id-${channel}`, messageId: 91, entityType: 'outreach_message', entityId: 91,
    });
    expect(updates[0].content).toBe(updates[0].redactedContent);
    expect(updates[0].content).not.toContain('Priya Shah');
  });
});
