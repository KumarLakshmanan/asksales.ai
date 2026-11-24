import { describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';

// Two CRM contacts share one WhatsApp number; a third has its own.
const leads = [
  { id: 1, name: 'Asha', phone: '+91 99000 00001', whatsapp: null },
  { id: 2, name: 'Asha', phone: '919900000001', whatsapp: null },
  { id: 3, name: 'Ravi', phone: '919900000003', whatsapp: null },
];
let page: typeof leads = leads;
jest.unstable_mockModule('../models/db.js', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => page }) }) }) }) } }));
jest.unstable_mockModule('../models/emailSenders/functions.js', () => ({ listByUser: jest.fn(), getById: jest.fn(), getDefault: jest.fn() }));
jest.unstable_mockModule('../services/outreach/ProviderBindingService.js', () => ({ resolveOfficialProviderBinding: async () => ({ providerAccountId: 'fixture' }) }));
jest.unstable_mockModule('../services/assistants/CustomerDeliveryGate.js', () => ({ assertCustomerDeliveryRuntime: jest.fn(), customerDeliveryReadiness: async () => ({ ready: true }), deliverySetupFailure: jest.fn() }));
jest.unstable_mockModule('../services/whatsappServiceWindow.js', () => ({ hasActiveWhatsAppWindow: jest.fn(), activeWhatsAppWindows: async () => new Set<number>() }));
jest.unstable_mockModule('../services/socialFollowUpService.js', () => ({ parseUtcDatabaseTimestamp: jest.fn() }));
jest.unstable_mockModule('../services/outreach/RecipientSuppressionService.js', () => ({ getSuppressedRecipients: async () => new Set(), normalizeOutreachDestination: (_channel: string, value: string) => value.replace(/\D/g, '') }));
const { getCreationRecipients } = await import('../services/outreach/CreationService.js');
const check = (ids: number[], sentTo?: Map<string, string>) => withBusinessScope({ userId: 1, businessProfileId: 1 },
  () => getCreationRecipients(1, 'whatsapp', { providerAccountId: 'fixture' }, { ids, sentTo }));

describe('one message per destination', () => {
  it('sends once to a number shared by two contacts and says why the other is held', async () => {
    page = leads;
    const { recipients } = await check([1, 2, 3]);
    expect(recipients.map((recipient) => recipient.eligible)).toEqual([true, false, true]);
    expect(recipients[1].reason).toBe('Duplicate contact: another Asha has the same number, so this is sent once.');
  });

  it('holds a duplicate found in a later review chunk', async () => {
    const sentTo = new Map<string, string>();
    page = [leads[0]];
    expect((await check([1], sentTo)).recipients[0].eligible).toBe(true);
    page = [leads[1], leads[2]];
    expect((await check([2, 3], sentTo)).recipients.map((recipient) => recipient.eligible)).toEqual([false, true]);
  });
});
