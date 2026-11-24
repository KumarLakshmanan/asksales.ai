import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * WhatsApp platform billing ("we pay Meta"): pricing maths, the reserve/accept/
 * fail lifecycle around a send, and settlement from delivery webhooks.
 * The database and wallet are replaced by in-memory fakes.
 */

type Row = Record<string, unknown>;
const state = {
  platform: true,
  market: 'India' as string | null,
  rates: { marketing: 0.8631, utility: 0.115, authentication: 0.115, service: 0.115 } as Record<string, number | undefined>,
  templateCategory: 'UTILITY' as string | null,
  charge: null as Row | null,
  updates: [] as string[],
  cap: null as number | null,
  spentToday: 0,
  fees: {} as Record<string, number>,
  balance: 100,
  paymentFlagged: false,
};

function sqlText(query: { queryChunks?: unknown[] }): { text: string; params: unknown[] } {
  const params: unknown[] = [];
  const text = (query.queryChunks || []).map((chunk) => {
    if (chunk && typeof chunk === 'object' && Array.isArray((chunk as { value?: unknown }).value)) return (chunk as { value: string[] }).value.join('');
    params.push(chunk);
    return '?';
  }).join('');
  return { text: text.replace(/\s+/g, ' '), params };
}

const execute = jest.fn(async (query: { queryChunks?: unknown[] }): Promise<{ rows: Row[] }> => {
  const { text, params } = sqlText(query);
  if (text.includes('UPDATE whatsapp_billing_accounts')) {
    state.updates.push(text);
    return { rows: state.paymentFlagged && text.includes('payment_issue_at = now()') ? [{ waba_id: 'waba-1', user_id: 7 }] : [] };
  }
  if (text.includes('FROM whatsapp_billing_accounts')) {
    return { rows: state.platform ? [{ waba_id: 'waba-1', currency: 'INR', daily_spend_cap_credits: state.cap === null ? null : String(state.cap) }] : [] };
  }
  if (text.includes('AS total FROM whatsapp_message_charges')) return { rows: [{ total: String(state.spentToday) }] };
  if (text.includes('SELECT calling_code, market FROM whatsapp_rate_markets')) return { rows: [{ calling_code: '91', market: 'India' }, { calling_code: '1', market: 'North America' }] };
  if (text.includes('FROM whatsapp_rate_markets')) return { rows: state.market ? [{ market: state.market }] : [] };
  if (text.includes('SELECT DISTINCT ON (market, category)')) {
    return { rows: Object.entries(state.rates).filter(([, rate]) => rate !== undefined).map(([category, rate]) => ({ market: 'India', category, rate: String(rate) })) };
  }
  if (text.includes('FROM whatsapp_rate_cards')) {
    const rate = state.rates[String(params[1])];
    return { rows: rate === undefined ? [] : [{ rate: String(rate) }] };
  }
  if (text.includes('FROM whatsapp_templates')) return { rows: state.templateCategory ? [{ category: state.templateCategory }] : [] };
  if (text.includes('INSERT INTO whatsapp_message_charges')) return { rows: [{ id: 42 }] };
  if (text.includes('SELECT reservation_transaction_id')) return { rows: [{ reservation_transaction_id: state.charge?.reservation_transaction_id ?? null }] };
  if (text.includes('SELECT id, user_id, status')) return { rows: state.charge ? [state.charge] : [] };
  if (text.startsWith(' UPDATE whatsapp_message_charges') || text.startsWith('UPDATE whatsapp_message_charges')) {
    state.updates.push(text);
    return { rows: [] };
  }
  throw new Error(`Unexpected SQL: ${text}`);
});

const deductForEvent = jest.fn<(...args: unknown[]) => Promise<Row>>();
const deductOnceForResource = jest.fn<(...args: unknown[]) => Promise<Row>>();
const settleReservation = jest.fn<(...args: unknown[]) => Promise<Row>>();
const refundDeduction = jest.fn<(...args: unknown[]) => Promise<Row>>();

jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/CreditService.js', () => ({
  creditService: { deductForEvent, deductOnceForResource, settleReservation, refundDeduction },
}));
jest.unstable_mockModule('../models/creditPricing/functions.js', () => ({
  getPricingByKey: async (key: string) => key === 'whatsapp_margin_marketing' ? { isActive: true, creditsPerUnit: '20' }
    : key in state.fees ? { isActive: true, creditsPerUnit: String(state.fees[key]) } : undefined,
  getRechargeRate: async () => 10,
}));
jest.unstable_mockModule('../utils/currency.js', () => ({ getUsdToInrRate: () => 85 }));
const resolveCreds = jest.fn<(...args: unknown[]) => Promise<Row | null>>();
jest.unstable_mockModule('../services/whatsappApiService.js', () => ({ whatsappApiService: { resolveCreds } }));
jest.unstable_mockModule('../models/wallets/functions.js', () => ({ getBalance: async () => state.balance }));
const notifyAllAdmins = jest.fn<(...args: unknown[]) => Promise<void>>(async () => undefined);
jest.unstable_mockModule('../models/adminNotifications/functions.js', () => ({ notifyAllAdmins }));

const billing = await import('../services/whatsapp/WhatsAppBillingService.js');

const templatePayload = { to: '919876543210', type: 'template', template: { name: 'order_update', language: { code: 'en' } } };
const sendInput = { userId: 7, wabaId: 'waba-1', phoneNumberId: 'phone-1', payload: templatePayload };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WHATSAPP_PLATFORM_BILLING_ENABLED = 'true';
  Object.assign(state, {
    platform: true, market: 'India', templateCategory: 'UTILITY', charge: null, updates: [],
    rates: { marketing: 0.8631, utility: 0.115, authentication: 0.115, service: 0.115 },
    cap: null, spentToday: 0, fees: {}, balance: 100, paymentFlagged: false,
  });
  resolveCreds.mockResolvedValue({ businessAccountId: 'waba-1', phoneNumberId: 'phone-1' });
  deductForEvent.mockResolvedValue({ success: true, transactionId: 501 });
  deductOnceForResource.mockResolvedValue({ success: true, transactionId: 777 });
  settleReservation.mockResolvedValue({ success: true });
  refundDeduction.mockResolvedValue({ success: true });
});
afterEach(() => { delete process.env.WHATSAPP_PLATFORM_BILLING_ENABLED; });

describe('pricing helpers', () => {
  it('matches the longest calling-code prefix', () => {
    const markets = [{ callingCode: '1', market: 'North America' }, { callingCode: '1242', market: 'Rest of Latin America' }, { callingCode: '91', market: 'India' }];
    expect(billing.matchMarket('12425551234', markets)).toBe('Rest of Latin America');
    expect(billing.matchMarket('+1 415 555 0100', markets)).toBe('North America');
    expect(billing.matchMarket('919876543210', markets)).toBe('India');
    expect(billing.matchMarket('4420', markets)).toBeNull();
  });

  it('rounds to 0.01 credit instead of whole credits', () => {
    expect(billing.creditsForRate({ rate: 0.115, currency: 'INR', marginPercent: 0, creditsPerInr: 10, usdToInr: 85 })).toBe(1.15);
    expect(billing.creditsForRate({ rate: 0.8631, currency: 'INR', marginPercent: 20, creditsPerInr: 10, usdToInr: 85 })).toBe(10.36);
    expect(billing.creditsForRate({ rate: 0.01, currency: 'USD', marginPercent: 0, creditsPerInr: 10, usdToInr: 85 })).toBe(8.5);
    expect(() => billing.creditsForRate({ rate: 1, currency: 'BRL', marginPercent: 0, creditsPerInr: 10, usdToInr: 85 })).toThrow('Unsupported');
  });

  it('classifies payloads and categories', () => {
    expect(billing.messageKindOf(templatePayload)).toEqual({ kind: 'template', templateName: 'order_update', templateLanguage: 'en' });
    expect(billing.messageKindOf({ type: 'interactive' })).toEqual({ kind: 'service' });
    expect(billing.normalizeCategory('MARKETING')).toBe('marketing');
    expect(billing.normalizeCategory('authentication_international')).toBeNull();
  });
});

describe('reserving before a send', () => {
  it('does nothing while the feature flag is off', async () => {
    delete process.env.WHATSAPP_PLATFORM_BILLING_ENABLED;
    await expect(billing.reserveWhatsAppSend(sendInput)).resolves.toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it('does nothing for a WABA that pays Meta itself', async () => {
    state.platform = false;
    await expect(billing.reserveWhatsAppSend(sendInput)).resolves.toBeNull();
    expect(deductForEvent).not.toHaveBeenCalled();
  });

  it('reserves the template category rate for the recipient market', async () => {
    const charge = await billing.reserveWhatsAppSend(sendInput);
    expect(charge).toEqual({ id: 42, userId: 7, credits: 1.15 });
    expect(deductForEvent).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7, eventKey: 'outreach_whatsapp_meta', overrideAmount: 1.15,
      referenceType: 'whatsapp_message_charge', referenceId: '42',
    }));
    expect(state.updates.some(text => text.includes('reservation_transaction_id ='))).toBe(true);
  });

  it('prices a free-form reply as a service message', async () => {
    await billing.reserveWhatsAppSend({ ...sendInput, payload: { to: '919876543210', type: 'text' } });
    expect(deductForEvent).toHaveBeenCalledWith(expect.objectContaining({ overrideAmount: 1.15, description: 'WhatsApp service message (India)' }));
  });

  it('reserves an unknown template at the marketing rate plus margin', async () => {
    state.templateCategory = null;
    const charge = await billing.reserveWhatsAppSend(sendInput);
    expect(charge?.credits).toBe(10.36);
  });

  it('refuses to send when the wallet cannot cover the message', async () => {
    deductForEvent.mockResolvedValue({ success: false, error: 'Insufficient credits. Please recharge your wallet.' });
    await expect(billing.reserveWhatsAppSend(sendInput)).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDITS', outcomeUncertain: false, deliveryAttempted: false, retryable: false,
    });
    expect(state.updates.some(text => text.includes("status = 'refunded'"))).toBe(true);
  });

  it('refuses to send when there is no rate to price it', async () => {
    state.rates.utility = undefined;
    await expect(billing.reserveWhatsAppSend(sendInput)).rejects.toMatchObject({ code: 'WHATSAPP_RATE_MISSING' });
    state.market = null;
    await expect(billing.reserveWhatsAppSend(sendInput)).rejects.toMatchObject({ code: 'WHATSAPP_RATE_MARKET_MISSING' });
    expect(deductForEvent).not.toHaveBeenCalled();
  });

  it('never blocks a support reply: no Service rate, unknown country or empty wallet', async () => {
    const reply = { ...sendInput, payload: { to: '9999123', type: 'text' } };
    state.rates.service = undefined;
    state.market = null;
    await expect(billing.reserveWhatsAppSend(reply)).resolves.toMatchObject({ credits: 0 });
    expect(execute.mock.calls.map(([query]) => sqlText(query)).find(({ text }) => text.includes('INSERT INTO whatsapp_message_charges'))?.params)
      .toEqual(expect.arrayContaining(['service', 'Unknown', 0]));

    state.rates.service = 0.115;
    state.market = 'India';
    deductForEvent.mockResolvedValue({ success: false, error: 'Insufficient credits. Please recharge your wallet.' });
    await expect(billing.reserveWhatsAppSend(reply)).resolves.toMatchObject({ credits: 0 });
    expect(state.updates.some(text => text.includes("status = 'refunded'"))).toBe(false);
    expect(state.updates.some(text => text.includes('reserved_credits = 0'))).toBe(true);
  });

  it('still refuses a template when the wallet is empty or the country is unknown', async () => {
    state.market = null;
    await expect(billing.reserveWhatsAppSend(sendInput)).rejects.toMatchObject({ code: 'WHATSAPP_RATE_MARKET_MISSING' });
    state.market = 'India';
    deductForEvent.mockResolvedValue({ success: false, error: 'Insufficient credits. Please recharge your wallet.' });
    await expect(billing.reserveWhatsAppSend(sendInput)).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDITS' });
  });

  it("refuses a send that would pass the account's daily limit", async () => {
    state.cap = 5;
    state.spentToday = 4.5;
    await expect(billing.reserveWhatsAppSend(sendInput)).rejects.toMatchObject({ code: 'WHATSAPP_DAILY_SPEND_CAP', status: 429, deliveryAttempted: false });
    expect(deductForEvent).not.toHaveBeenCalled();
    state.spentToday = 3;
    await expect(billing.reserveWhatsAppSend(sendInput)).resolves.toMatchObject({ credits: 1.15 });
  });
});

describe('the per-message platform fee', () => {
  it('uses the admin fee for accounts billed through our credit line', async () => {
    await expect(billing.whatsappOutreachFeeKey(7, 'phone-1')).resolves.toBe('outreach_whatsapp_platform');
    expect(resolveCreds).toHaveBeenCalledWith(7, 'phone-1');
  });

  it('keeps the normal fee for accounts that pay Meta, while the flag is off, or when the account cannot be resolved', async () => {
    state.platform = false;
    await expect(billing.whatsappOutreachFeeKey(7)).resolves.toBe('outreach_whatsapp');
    state.platform = true;
    delete process.env.WHATSAPP_PLATFORM_BILLING_ENABLED;
    await expect(billing.whatsappOutreachFeeKey(7)).resolves.toBe('outreach_whatsapp');
    process.env.WHATSAPP_PLATFORM_BILLING_ENABLED = 'true';
    resolveCreds.mockRejectedValue(new Error('no credentials'));
    await expect(billing.whatsappOutreachFeeKey(7)).resolves.toBe('outreach_whatsapp');
  });
});

describe('quoting a batch before launch', () => {
  it('adds Meta cost per category, the platform fee, and checks the wallet', async () => {
    state.fees.outreach_whatsapp_platform = 3;
    state.balance = 10;
    const quote = await billing.quoteWhatsAppBatch({ userId: 7, phoneNumberId: 'phone-1', items: [
      { recipient: '919876543210', templateName: 'order_update' },
      { recipient: '+91 98765 43211', templateName: 'order_update' },
      { recipient: '4420 7946 0000' },
    ] });
    expect(quote).toMatchObject({
      platformBilled: true, messages: 3, messageCredits: 3.45, platformFeeCredits: 9, totalCredits: 12.45,
      estimatedRecipients: 1, missingRates: [], walletBalance: 10, sufficient: false,
    });
    expect(quote.byCategory).toEqual({ utility: { messages: 2, credits: 2.3 }, service: { messages: 1, credits: 1.15 } });
  });

  it('is not sufficient while a rate is missing, even with credits', async () => {
    state.rates.utility = undefined;
    const quote = await billing.quoteWhatsAppBatch({ userId: 7, items: [{ recipient: '919876543210', templateName: 'order_update' }] });
    expect(quote.missingRates).toEqual(['utility / India']);
    expect(quote.sufficient).toBe(false);
  });

  it('quotes nothing for an account that pays Meta itself', async () => {
    state.platform = false;
    await expect(billing.quoteWhatsAppBatch({ userId: 7, items: [{ recipient: '919876543210' }] }))
      .resolves.toMatchObject({ platformBilled: false, totalCredits: 0, sufficient: true });
  });
});

describe('after the Meta request', () => {
  const charge = { id: 42, userId: 7, credits: 1.15 };

  it('binds the wamid when Meta accepts', async () => {
    await billing.markWhatsAppSendAccepted(charge, 'wamid.ABC');
    expect(state.updates[0]).toContain("status = 'sent'");
  });

  it('refunds a definitive rejection', async () => {
    state.charge = { reservation_transaction_id: 501 };
    await billing.markWhatsAppSendFailed(charge, { outcomeUncertain: false });
    expect(refundDeduction).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, transactionId: 501 }));
  });

  it('keeps the reservation when the outcome is unknown', async () => {
    await billing.markWhatsAppSendFailed(charge, new Error('timeout') as { outcomeUncertain?: boolean });
    expect(refundDeduction).not.toHaveBeenCalled();
    expect(state.updates[0]).toContain("status = 'needs_review'");
  });

  it('flags the account and alerts admins when Meta refuses for a payment problem', async () => {
    state.paymentFlagged = true;
    await billing.markWhatsAppSendFailed(charge, Object.assign(new Error('Business eligibility payment issue'), { code: 131042, outcomeUncertain: false }));
    expect(state.updates.some(text => text.includes('payment_issue_at = now()'))).toBe(true);
    expect(notifyAllAdmins).toHaveBeenCalledWith(expect.objectContaining({ title: 'WhatsApp credit line payment problem' }));
    expect(state.updates.some(text => text.includes("status = 'refunded'"))).toBe(true);
  });

  it('does not alert for other Meta errors, or again within 6 hours', async () => {
    await billing.markWhatsAppSendFailed(charge, Object.assign(new Error('Template paused'), { code: 132015, outcomeUncertain: false }));
    expect(state.updates.some(text => text.includes('payment_issue_at'))).toBe(false);
    state.paymentFlagged = false; // the update matched no row: alerted recently
    await billing.markWhatsAppSendFailed(charge, Object.assign(new Error('payment'), { code: 131042, outcomeUncertain: false }));
    expect(state.updates.find(text => text.includes('payment_issue_at = now()'))).toContain("interval '6 hours'");
    expect(notifyAllAdmins).not.toHaveBeenCalled();
  });
});

describe('settling from the delivery webhook', () => {
  const sentCharge = (over: Row = {}) => ({
    id: 42, user_id: 7, status: 'sent', recipient_market: 'India', currency: 'INR', reserved_credits: '10.36',
    reservation_transaction_id: 501, expected_category: 'marketing', ...over,
  });
  const status = (name: string, pricing?: Row) => ({ phoneNumberId: 'phone-1', wamid: 'wamid.ABC', status: name, pricing });

  it('never settles on sent, because Meta bills on delivery', async () => {
    state.charge = sentCharge();
    await expect(billing.settleWhatsAppChargeFromStatus(status('sent', { billable: true, category: 'marketing' }))).resolves.toBe('skipped');
    expect(settleReservation).not.toHaveBeenCalled();
  });

  it('settles a delivered message at the category Meta charged', async () => {
    state.charge = sentCharge();
    await expect(billing.settleWhatsAppChargeFromStatus(status('delivered', { billable: true, pricing_model: 'PMP', type: 'regular', category: 'utility' })))
      .resolves.toBe('settled');
    expect(settleReservation).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, transactionId: 501, actualCredits: 1.15 }));
    expect(deductOnceForResource).not.toHaveBeenCalled();
  });

  it('charges nothing when Meta reports the message as free', async () => {
    state.charge = sentCharge();
    await billing.settleWhatsAppChargeFromStatus(status('delivered', { billable: false, type: 'free_customer_service', category: 'service' }));
    expect(settleReservation).toHaveBeenCalledWith(expect.objectContaining({ actualCredits: 0 }));
  });

  it('charges the admin fee for a message Meta delivered free', async () => {
    state.charge = sentCharge();
    state.fees.whatsapp_free_message_fee = 0.25;
    await billing.settleWhatsAppChargeFromStatus(status('delivered', { billable: false, type: 'free_entry_point', category: 'marketing' }));
    expect(settleReservation).toHaveBeenCalledWith(expect.objectContaining({ actualCredits: 0.25 }));
  });

  it('takes the difference once when Meta charged more than was reserved', async () => {
    state.charge = sentCharge({ reserved_credits: '1.15', expected_category: 'utility' });
    await billing.settleWhatsAppChargeFromStatus(status('delivered', { billable: true, type: 'regular', category: 'marketing' }));
    expect(settleReservation).toHaveBeenCalledWith(expect.objectContaining({ actualCredits: 1.15 }));
    expect(deductOnceForResource).toHaveBeenCalledWith(expect.objectContaining({
      overrideAmount: 9.21, referenceType: 'whatsapp_message_charge_topup', referenceId: '42',
    }));
  });

  it('flags the charge when the wallet cannot cover the difference', async () => {
    state.charge = sentCharge({ reserved_credits: '1.15' });
    deductOnceForResource.mockResolvedValue({ success: false });
    await expect(billing.settleWhatsAppChargeFromStatus(status('read', { billable: true, category: 'marketing' }))).resolves.toBe('needs_review');
  });

  it('refunds a failed delivery', async () => {
    state.charge = sentCharge();
    await expect(billing.settleWhatsAppChargeFromStatus(status('failed'))).resolves.toBe('refunded');
    expect(refundDeduction).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 501 }));
    expect(notifyAllAdmins).not.toHaveBeenCalled();
  });

  it('alerts admins when a delivery fails for a payment problem, and clears it once billing works', async () => {
    state.charge = sentCharge();
    state.paymentFlagged = true;
    await expect(billing.settleWhatsAppChargeFromStatus({ ...status('failed'), errors: [{ code: 131042, title: 'Business eligibility payment issue' }] }))
      .resolves.toBe('refunded');
    expect(notifyAllAdmins).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining('waba-1') }));

    state.charge = sentCharge();
    await billing.settleWhatsAppChargeFromStatus(status('delivered', { billable: true, pricing_model: 'PMP', type: 'regular', category: 'utility' }));
    expect(state.updates.some(text => text.includes('payment_issue_at = NULL'))).toBe(true);
  });

  it('accepts a repeated webhook after the charge already settled', async () => {
    state.charge = sentCharge();
    settleReservation.mockResolvedValue({ success: true, alreadyRefunded: true });
    await expect(billing.settleWhatsAppChargeFromStatus(status('read', { billable: true, category: 'utility' }))).resolves.toBe('settled');
  });

  it('ignores messages that were not platform billed', async () => {
    state.charge = null;
    await expect(billing.settleWhatsAppChargeFromStatus(status('delivered', { billable: true, category: 'utility' }))).resolves.toBe('skipped');
  });

  it('holds a billable category with no rate for review instead of guessing', async () => {
    state.charge = sentCharge();
    await expect(billing.settleWhatsAppChargeFromStatus(status('delivered', { billable: true, category: 'authentication_international' })))
      .resolves.toBe('needs_review');
    expect(settleReservation).not.toHaveBeenCalled();
  });
});
