import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { withBusinessScope } from '../tenancy/businessContext.js';

const execute = jest.fn<(query: SQL) => Promise<{ rows: Array<{ id: number }> }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: { warn: jest.fn(), info: jest.fn() } }));
const { privacyVaultService, redactPiiWithStableTokens, redactSensitiveInboxEmailText, whatsappDisplayText, hasContactDetailTokens } =
  await import('../services/agents/orchestration/PrivacyVaultService.js');
const { inboxEmailDisplayText, inboxWhatsAppDisplayText } = await import('../services/outreach/InboxEmailPresentation.js');
const reveal = jest.spyOn(privacyVaultService, 'reveal');
const original = "Thanks for reaching out. Yes, I'm interested in a conversation.\nOn Thu, Oct 15, 2026 Priya Shah <priya@example.com> wrote:";

beforeEach(() => {
  jest.clearAllMocks();
  execute.mockResolvedValue({ rows: [{ id: 73 }] });
  reveal.mockResolvedValue({ rawText: original, piiTypes: ['email'], expiresAt: new Date(Date.now() + 60_000) });
});

describe('email reply contact presentation', () => {
  it.each(["Yes, I'm interested", "Yes, I'm interested in a conversation.", 'Yes, I’m interested', 'I am interested in learning more.'])('preserves ordinary interest text: %s', text => {
    expect(redactPiiWithStableTokens(text)).toEqual({ redactedText: text, piiTypes: [], tokenCount: 0 });
  });

  it('still protects actual names and addresses in model text', () => {
    const text = "I'm Priya Shah. Email me at priya@example.com.";
    expect(redactPiiWithStableTokens(text).redactedText).toBe("I'm [NAME_1]. Email me at [EMAIL_1].");
    expect(redactSensitiveInboxEmailText(text, { userId: 7, conversationId: 29 })).toBe(text);
  });

  it('restores the retained reply and quoted sender without guessing from the contact profile', async () => {
    expect(await inboxEmailDisplayText(7, 7, 29, 91)).toBe(original);
    expect(reveal).toHaveBeenCalledWith(7, 73, {
      conversationId: 29, messageId: 91, actor: 'user:7', purpose: 'outreach_inbox_email_contact_display',
    });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.params).toEqual([7, 29, 91]);
    expect(query.sql).toContain('c.user_id=m.user_id');
    expect(query.sql).toContain('v.user_id=m.user_id');
    expect(query.sql).toContain('v.conversation_id=m.conversation_id AND v.message_id=m.id');
    expect(query.sql).toContain("c.channel IN ('email','gmail') AND m.direction='inbound'");
  });

  it.each([undefined, 8])('does not reveal to an absent or non-owner viewer: %s', async actor => {
    expect(await inboxEmailDisplayText(7, actor, 29, 91)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
    expect(reveal).not.toHaveBeenCalled();
  });

  it('respects the current business actor and does not reveal missing messages', async () => {
    await withBusinessScope({ userId: 7, actorUserId: 8, businessProfileId: 12, role: 'member' }, async () => {
      expect(await inboxEmailDisplayText(7, 7, 29, 91)).toBeNull();
      expect(await inboxEmailDisplayText(7, 8, 29, 91)).toBeNull();
    });
    expect(await inboxEmailDisplayText(7, 7, 29, undefined)).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('keeps other sensitive values protected, even inside a name-labelled line', async () => {
    reveal.mockResolvedValue({ rawText: 'Name: Priya Shah password: violet-secret\nEmail: priya@example.com\nPhone: +91 98765 43210\nCard: 4242 4242 4242 4242', piiTypes: [], expiresAt: new Date() });
    const display = await inboxEmailDisplayText(7, 7, 29, 91);
    expect(display).toContain('Priya Shah');
    expect(display).toContain('priya@example.com');
    expect(display).not.toContain('violet-secret');
    expect(display).not.toContain('98765');
    expect(display).not.toContain('4242');
    expect(display).toMatch(/\[CREDENTIAL_\d+\]/);
  });

  it('falls back when originals are missing, expired, or unavailable', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    expect(await inboxEmailDisplayText(7, 7, 29, 91)).toBeNull();
    expect(reveal).not.toHaveBeenCalled();
    reveal.mockResolvedValueOnce(null);
    expect(await inboxEmailDisplayText(7, 7, 29, 91)).toBeNull();
    reveal.mockRejectedValueOnce(new Error('key unavailable'));
    expect(await inboxEmailDisplayText(7, 7, 29, 91)).toBeNull();
  });
});

describe('WhatsApp contact presentation', () => {
  const form = 'Full name: Priya Shah\nPhone number: +91 98765 43210\nEmail: priya@example.com\nAddress: 12 MG Road, Bengaluru';

  it('shows name, phone, email and address unmasked while the model copy stays masked', () => {
    expect(whatsappDisplayText(form)).toBe(form);
    const model = redactPiiWithStableTokens(form).redactedText;
    expect(model).not.toContain('Priya Shah');
    expect(model).not.toContain('98765');
    expect(hasContactDetailTokens(model)).toBe(true);
    expect(hasContactDetailTokens(form)).toBe(false);
  });

  it('still masks payment cards and credentials', () => {
    const display = whatsappDisplayText('Card: 4242 4242 4242 4242 password: violet-secret');
    expect(display).not.toContain('4242');
    expect(display).not.toContain('violet-secret');
  });

  it('restores older tokenised WhatsApp rows for any member of the business', async () => {
    reveal.mockResolvedValue({ rawText: form, piiTypes: ['name', 'phone'], expiresAt: new Date(Date.now() + 60_000) });
    await withBusinessScope({ userId: 7, actorUserId: 8, businessProfileId: 12, role: 'member' }, async () => {
      expect(await inboxWhatsAppDisplayText(7, 8, 29, 91)).toBe(form);
    });
    expect(reveal).toHaveBeenCalledWith(7, 73, {
      conversationId: 29, messageId: 91, actor: 'user:8', purpose: 'outreach_inbox_whatsapp_contact_display',
    });
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.params).toEqual([7, 29, 91]);
    expect(query.sql).toContain("c.channel='whatsapp'");
  });

  it('does not reveal without a viewer, a message, or for another business', async () => {
    expect(await inboxWhatsAppDisplayText(7, undefined, 29, 91)).toBeNull();
    expect(await inboxWhatsAppDisplayText(7, 7, 29, undefined)).toBeNull();
    await withBusinessScope({ userId: 9, actorUserId: 9, businessProfileId: 13, role: 'owner' }, async () => {
      expect(await inboxWhatsAppDisplayText(7, 9, 29, 91)).toBeNull();
    });
    expect(execute).not.toHaveBeenCalled();
  });
});
