import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockDbExecute = jest.fn<(query: unknown) => Promise<{ rowCount: number; rows?: Array<{lead_id:number}> }>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute: mockDbExecute } }));
jest.unstable_mockModule('drizzle-orm', () => ({
  sql: Object.assign((strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }), { join: (values: unknown[]) => values }),
}));

const { hasActiveWhatsAppWindow, activeWhatsAppWindows } = await import('../services/whatsappServiceWindow.js');

describe('WhatsApp service window', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('requires a recent inbound message on the exact conversation account', async () => {
    mockDbExecute.mockResolvedValue({ rowCount: 1 });

    await expect(hasActiveWhatsAppWindow(4, 18, 'phone-number-a')).resolves.toBe(true);

    const query = mockDbExecute.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    const text = query.strings.join('?');
    expect(text).toContain("conversation.channel = 'whatsapp'");
    expect(text).toContain('conversation.provider_account_id = ?');
    expect(text).toContain('inbound.direction = \'inbound\'');
    expect(text).toContain("NOW() - INTERVAL '24 hours'");
    expect(query.values).toContain('phone-number-a');
  });

  it('fails closed without a sending account and when the account has no recent reply', async () => {
    mockDbExecute.mockResolvedValue({ rowCount: 0 });

    await expect(hasActiveWhatsAppWindow(4, 18, '')).resolves.toBe(false);
    expect(mockDbExecute).not.toHaveBeenCalled();

    await expect(hasActiveWhatsAppWindow(4, 18, 'phone-number-b')).resolves.toBe(false);
    expect(mockDbExecute).toHaveBeenCalledTimes(1);
  });

  it('batches recipient windows while retaining owner, account, direction and time boundaries', async () => {
    mockDbExecute.mockResolvedValue({ rowCount: 2, rows: [{ lead_id: 18 }, { lead_id: 20 }] });
    await expect(activeWhatsAppWindows(4, [18, 19, 20], 'phone-number-a')).resolves.toEqual(new Set([18, 20]));
    expect(mockDbExecute).toHaveBeenCalledTimes(1);
    const query = mockDbExecute.mock.calls[0][0] as { strings: string[]; values: unknown[] };
    const text = query.strings.join('?');
    expect(text).toContain('SELECT DISTINCT conversation.lead_id');
    expect(text).toContain('conversation.user_id = ?');
    expect(text).toContain("conversation.channel = 'whatsapp'");
    expect(text).toContain('conversation.provider_account_id IS NULL AND inbound.phone_number_id = ?');
    expect(text).toContain("inbound.direction = 'inbound'");
    expect(text).toContain("NOW() - INTERVAL '24 hours'");
    expect(query.values).toContain('phone-number-a');
  });
  it('skips empty batch queries and missing accounts', async () => {
    expect(await activeWhatsAppWindows(4, [], 'a')).toEqual(new Set());
    expect(await activeWhatsAppWindows(4, [18], '')).toEqual(new Set());
    expect(mockDbExecute).not.toHaveBeenCalled();
  });
});
