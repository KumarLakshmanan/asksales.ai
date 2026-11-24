import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { withBusinessScope } from '../tenancy/businessContext.js';

const lead = { id: 7, name: 'Fixture', phone: '+919900000001', whatsapp: '+91 (99000) 00002' };
let selectedLead: typeof lead | (Omit<typeof lead, 'whatsapp'> & { whatsapp: null });
const suppressed = jest.fn(async (_user: number, _channel: string, _addresses: string[]) => new Set(['919900000002']));
jest.unstable_mockModule('../models/db.js', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [selectedLead] }) }) }) }) } }));
jest.unstable_mockModule('../models/emailSenders/functions.js', () => ({ listByUser: jest.fn(), getById: jest.fn(), getDefault: jest.fn() }));
jest.unstable_mockModule('../services/outreach/ProviderBindingService.js', () => ({ resolveOfficialProviderBinding: async () => ({ providerAccountId: 'fixture' }) }));
jest.unstable_mockModule('../services/assistants/CustomerDeliveryGate.js', () => ({ assertCustomerDeliveryRuntime: jest.fn(), customerDeliveryReadiness: async () => ({ ready: true }), deliverySetupFailure: jest.fn() }));
jest.unstable_mockModule('../services/whatsappServiceWindow.js', () => ({ hasActiveWhatsAppWindow: jest.fn(), activeWhatsAppWindows: async () => new Set([7]) }));
jest.unstable_mockModule('../services/socialFollowUpService.js', () => ({ parseUtcDatabaseTimestamp: jest.fn() }));
jest.unstable_mockModule('../services/outreach/RecipientSuppressionService.js', () => ({ getSuppressedRecipients: suppressed, normalizeOutreachDestination: (_channel: string, value: string) => value.replace(/\D/g, '') }));
const { getCreationRecipients } = await import('../services/outreach/CreationService.js');
const select = () => withBusinessScope({ userId: 1, businessProfileId: 1 }, () => getCreationRecipients(1, 'whatsapp', { providerAccountId: 'fixture' }, { ids: [7] }));

beforeEach(() => {
  selectedLead = { ...lead };
  suppressed.mockReset().mockResolvedValue(new Set(['919900000002']));
});

describe('WhatsApp reviewed recipient identity', () => {
  it('checks the selected WhatsApp address rather than the separate phone', async () => {
    const result = await select();
    expect(suppressed).toHaveBeenCalledWith(1, 'whatsapp', ['919900000002']);
    expect(result.recipients[0]).toMatchObject({ recipient: '919900000002', eligible: false, reason: 'This destination is suppressed for outreach.' });
  });
  it.each([null, ''])('checks and blocks the actual phone fallback when WhatsApp is %j', async whatsapp => {
    selectedLead = { ...lead, whatsapp };
    suppressed.mockResolvedValue(new Set(['919900000001']));
    const result = await select();
    expect(suppressed).toHaveBeenCalledWith(1, 'whatsapp', ['919900000001']);
    expect(result.recipients[0]).toMatchObject({ recipient: '919900000001', phone: lead.phone,
      eligible: false, reason: 'This destination is suppressed for outreach.' });
  });
  it('allows a clear WhatsApp destination when only the separate phone is suppressed', async () => {
    suppressed.mockResolvedValue(new Set(['919900000001']));
    const result = await select();
    expect(suppressed).toHaveBeenCalledWith(1, 'whatsapp', ['919900000002']);
    expect(result.recipients[0]).toMatchObject({ recipient: '919900000002', eligible: true, reason: null });
  });
  it('does not substitute a clear phone when the chosen WhatsApp destination is suppressed', async () => {
    const result = await select();
    expect(suppressed).toHaveBeenCalledTimes(1);
    expect(result.recipients).toHaveLength(1);
    expect(result.recipients[0]).toMatchObject({ recipient: '919900000002', phone: lead.whatsapp, eligible: false });
  });
  it('does not reuse an earlier clear result after destination suppression changes', async () => {
    suppressed.mockResolvedValueOnce(new Set()).mockResolvedValueOnce(new Set(['919900000002']));
    expect((await select()).recipients[0].eligible).toBe(true);
    expect((await select()).recipients[0].eligible).toBe(false);
    expect(suppressed).toHaveBeenCalledTimes(2);
  });
});
