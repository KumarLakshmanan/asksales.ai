import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

/**
 * WhatsApp platform billing administration: rate-card and market CSV parsing,
 * the hourly maintenance job (stale-charge sweep, reconciliation with Meta),
 * an administrator resolving a flagged charge, and the credit-line revoke
 * after a customer disconnects. Database, wallet and Meta are fakes.
 */

type Row = Record<string, unknown>;

function sqlText(query: { queryChunks?: unknown[] }): string {
  return (query.queryChunks || []).map((chunk) => {
    if (chunk && typeof chunk === 'object' && Array.isArray((chunk as { value?: unknown }).value)) return (chunk as { value: string[] }).value.join('');
    return '?';
  }).join('').replace(/\s+/g, ' ');
}

const state = {
  swept: [] as Row[],
  lastReconciled: null as Date | null,
  accounts: [] as Row[],
  ledger: [] as Row[],
  upserts: [] as string[],
  charge: null as Row | null,
  updates: [] as string[],
  sessions: [] as Row[],
  nextCard: 0,
};

const execute = jest.fn(async (query: { queryChunks?: unknown[] }): Promise<{ rows: Row[] }> => {
  const text = sqlText(query);
  if (text.includes("UPDATE whatsapp_message_charges SET status = 'needs_review'") && text.includes('RETURNING id')) return { rows: state.swept };
  if (text.includes('max(fetched_at)')) return { rows: [{ at: state.lastReconciled }] };
  if (text.includes('FROM whatsapp_billing_accounts')) return { rows: state.accounts };
  if (text.includes('GROUP BY 1, 2')) return { rows: state.ledger };
  if (text.includes('INSERT INTO whatsapp_billing_reconciliation')) { state.upserts.push(text); return { rows: [] }; }
  if (text.includes('SELECT id, user_id, status, reservation_transaction_id')) return { rows: state.charge ? [state.charge] : [] };
  if (text.includes('SELECT reservation_transaction_id')) return { rows: [{ reservation_transaction_id: state.charge?.reservation_transaction_id ?? null }] };
  if (text.includes('UPDATE whatsapp_message_charges')) { state.updates.push(text); return { rows: [] }; }
  if (text.includes('FROM channel_credentials')) return { rows: state.sessions };
  if (text.includes('SUM(settled_rate)')) return { rows: [{ spent: '0' }] };
  if (text.includes('AND effective_from = ?::date')) return { rows: [{ count: String(state.nextCard) }] };
  throw new Error(`Unexpected SQL: ${text}`);
});

const alertAdmins = jest.fn(async (_title: string, _message: string) => undefined);
const getCreditLineConfig = jest.fn(async (): Promise<Row | null> => ({
  creditLineId: '123456', systemToken: 'token', attachOnSignup: true, currency: 'INR', apiVersion: 'v25.0', monthlyLimit: null, alertPercent: 80,
}));
const revokeCreditLinesForUser = jest.fn(async (_userId: number, _wabaIds: string[]) => undefined);
const settleReservation = jest.fn<(...args: unknown[]) => Promise<Row>>();
const refundDeduction = jest.fn<(...args: unknown[]) => Promise<Row>>();

jest.unstable_mockModule('../models/db.js', () => ({ db: { execute } }));
jest.unstable_mockModule('../services/whatsapp/WhatsAppCreditLine.js', () => ({ alertAdmins, getCreditLineConfig, revokeCreditLinesForUser }));
jest.unstable_mockModule('../services/CreditService.js', () => ({ creditService: { settleReservation, refundDeduction } }));
jest.unstable_mockModule('../utils/channelCredentialSecrets.js', () => ({ decryptChannelCredentialSession: (value: unknown) => value }));
jest.unstable_mockModule('../tenancy/businessContext.js', () => ({ withSystemScope: (_reason: string, work: () => unknown) => work() }));

const importer = await import('../services/whatsapp/WhatsAppRateCardImport.js');
const maintenance = await import('../services/whatsapp/WhatsAppBillingMaintenance.js');
const disconnect = await import('../services/whatsapp/WhatsAppCreditLineDisconnect.js');

const realFetch = global.fetch;
beforeEach(() => {
  jest.clearAllMocks();
  process.env.WHATSAPP_PLATFORM_BILLING_ENABLED = 'true';
  Object.assign(state, { swept: [], lastReconciled: null, accounts: [], ledger: [], upserts: [], charge: null, updates: [], sessions: [], nextCard: 0 });
  settleReservation.mockResolvedValue({ success: true });
  refundDeduction.mockResolvedValue({ success: true });
});
afterEach(() => {
  delete process.env.WHATSAPP_PLATFORM_BILLING_ENABLED;
  global.fetch = realFetch;
});

describe('rate card CSV', () => {
  it("reads Meta's wide layout after title lines, with currency symbols and extra columns", () => {
    const csv = [
      'WhatsApp Business Platform rates,,,,,',
      'Effective 1 January 2027,,,,,',
      'Market,Currency,Marketing,Utility,Authentication,Authentication-International,Service',
      'India,INR,"₹0.8631",₹0.1150,₹0.1150,₹2.3000,₹0.1150',
      '"Rest of Latin America",INR,"0,7400",0.30,0.30,n/a,0.30',
    ].join('\n');
    const { rows, warnings } = importer.parseRateCardCsv(csv);
    expect(rows).toContainEqual({ market: 'India', category: 'marketing', rate: 0.8631 });
    expect(rows).toContainEqual({ market: 'Rest of Latin America', category: 'marketing', rate: 0.74 });
    expect(rows.filter(row => row.market === 'India')).toHaveLength(4);
    expect(rows.some(row => row.rate === 2.3)).toBe(false);
    expect(warnings).toEqual([]);
  });

  it('reads the long layout and skips categories the app does not bill', () => {
    const { rows, warnings } = importer.parseRateCardCsv('market;category;rate\nIndia;Marketing;0.86\nIndia;marketing_lite;0.5\nIndia;Utility;');
    expect(rows).toEqual([{ market: 'India', category: 'marketing', rate: 0.86 }]);
    expect(warnings.join(' ')).toMatch(/marketing_lite.*skipped/);
    expect(warnings.join(' ')).toMatch(/no utility rate for India/);
  });

  it('warns about a missing category column and duplicate markets', () => {
    const { rows, warnings } = importer.parseRateCardCsv('Country,Marketing,Utility\nIndia,1,2\nIndia,3,4');
    expect(rows).toEqual([{ market: 'India', category: 'marketing', rate: 1 }, { market: 'India', category: 'utility', rate: 2 }]);
    expect(warnings).toEqual(expect.arrayContaining([
      'No authentication column; authentication rates were not imported.',
      'Line 3: India marketing appears twice; the first value was kept.',
    ]));
  });

  it('refuses a file without a market header', () => {
    expect(importer.parseRateCardCsv('a,b\n1,2')).toEqual({ rows: [], warnings: ['No header row with a "Market" column was found.'] });
  });
});

describe('calling-code CSV', () => {
  it('normalizes codes, keeps the first market for a repeated code and skips the header', () => {
    const { rows, warnings } = importer.parseMarketsCsv('Calling code,Market\n+91,India\n+1-242,Rest of Latin America\n91,Pakistan\nfoo');
    expect(rows).toEqual([{ callingCode: '91', market: 'India' }, { callingCode: '1242', market: 'Rest of Latin America' }]);
    expect(warnings).toEqual([
      'Line 4: +91 is listed for both India and Pakistan; the first was kept.',
      'Line 5: needs a calling code and a market name; skipped.',
    ]);
  });
});

describe('reconciliation with Meta', () => {
  const day = (offset: number) => { const date = new Date(); date.setUTCHours(0, 0, 0, 0); date.setUTCDate(date.getUTCDate() - offset); return date; };
  const point = (offset: number, category: string, volume: number, type = 'REGULAR') => ({
    start: Math.floor(day(offset).getTime() / 1000), end: Math.floor(day(offset).getTime() / 1000) + 86400, pricing_category: category.toUpperCase(), pricing_type: type, volume,
  });

  it('keeps only billable points, summed per day and category', () => {
    const volumes = maintenance.billableVolumes({ pricing_analytics: { data: [{ data_points: [
      point(2, 'marketing', 5), point(2, 'marketing', 3), point(2, 'service', 900, 'FREE_CUSTOMER_SERVICE'), { ...point(2, 'utility', 4), cost: 0.46 },
    ] }] } });
    expect(volumes).toEqual([
      { day: day(2).toISOString().slice(0, 10), category: 'marketing', volume: 8, cost: null },
      { day: day(2).toISOString().slice(0, 10), category: 'utility', volume: 4, cost: 0.46 },
    ]);
  });

  it('treats small differences as noise', () => {
    expect(maintenance.isVariance(100, 98)).toBe(false);
    expect(maintenance.isVariance(1000, 985)).toBe(false);
    expect(maintenance.isVariance(100, 90)).toBe(true);
    expect(maintenance.isVariance(0, 3)).toBe(true);
  });

  it('records every day and alerts only for settled days that differ', async () => {
    state.accounts = [{ waba_id: 'waba-1', currency: 'INR' }];
    state.ledger = [
      { day: day(2).toISOString().slice(0, 10), category: 'marketing', volume: '40', cost: '34.52' },
      { day: day(0).toISOString().slice(0, 10), category: 'utility', volume: '1', cost: '0.115' },
    ];
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ pricing_analytics: { data: [{ data_points: [point(2, 'marketing', 50), point(0, 'utility', 20)] }] } }), { status: 200 })) as typeof fetch;
    const result = await maintenance.reconcileWhatsAppBilling({ force: true });
    expect(result).toMatchObject({ wabas: 1, errors: [] });
    expect(result.variances).toEqual([`waba-1 ${day(2).toISOString().slice(0, 10)} marketing: Meta 50, ledger 40`]);
    expect(state.upserts).toHaveLength(2);
    expect(alertAdmins).toHaveBeenCalledWith('WhatsApp billing does not match Meta', expect.stringContaining('Meta 50, ledger 40'));
  });

  it('waits 6 hours between runs unless forced, and skips without a credit line', async () => {
    state.lastReconciled = new Date(Date.now() - 3600_000);
    await expect(maintenance.reconcileWhatsAppBilling()).resolves.toMatchObject({ wabas: 0 });
    getCreditLineConfig.mockResolvedValueOnce(null);
    await expect(maintenance.reconcileWhatsAppBilling({ force: true })).resolves.toMatchObject({ wabas: 0 });
  });

  it('reports a WABA Meta refuses to read without stopping the others', async () => {
    state.accounts = [{ waba_id: 'waba-1', currency: 'INR' }, { waba_id: 'waba-2', currency: 'INR' }];
    global.fetch = jest.fn(async (url: string | URL | Request) => String(url).includes('waba-1')
      ? new Response(JSON.stringify({ error: { message: 'Unsupported get request' } }), { status: 400 })
      : new Response(JSON.stringify({ pricing_analytics: { data: [] } }), { status: 200 })) as typeof fetch;
    const result = await maintenance.reconcileWhatsAppBilling({ force: true });
    expect(result.wabas).toBe(2);
    expect(result.errors).toEqual(['waba-1: Unsupported get request']);
  });
});

describe('hourly maintenance', () => {
  it('moves stale charges to review and alerts administrators', async () => {
    state.swept = [{ id: 1 }, { id: 2 }];
    await expect(maintenance.sweepStaleWhatsAppCharges()).resolves.toBe(2);
    expect(alertAdmins).toHaveBeenCalledWith('WhatsApp charges need review', expect.stringContaining('2 WhatsApp message charge(s)'));
  });

  it('does nothing while the feature flag is off', async () => {
    delete process.env.WHATSAPP_PLATFORM_BILLING_ENABLED;
    await expect(maintenance.runWhatsAppBillingMaintenance()).resolves.toEqual({ skipped: 'disabled' });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('next quarter rate card reminder', () => {
  it('finds the next quarter start', () => {
    expect(maintenance.nextQuarterStart(new Date('2026-11-18T10:00:00Z'))).toBe('2027-01-01');
    expect(maintenance.nextQuarterStart(new Date('2027-01-01T00:00:00Z'))).toBe('2027-04-01');
  });

  it('reminds admins in the last three weeks until the new card is imported', async () => {
    await expect(maintenance.checkNextRateCard(new Date('2026-11-18T10:00:00Z'))).resolves.toBe(false);
    expect(alertAdmins).not.toHaveBeenCalled();
    await expect(maintenance.checkNextRateCard(new Date('2026-12-20T10:00:00Z'))).resolves.toBe(true);
    expect(alertAdmins).toHaveBeenCalledWith('Import the next WhatsApp rate card', expect.stringContaining('2027-01-01'));
    state.nextCard = 188;
    await expect(maintenance.checkNextRateCard(new Date('2026-12-20T10:00:00Z'))).resolves.toBe(false);
  });
});

describe('resolving a flagged charge', () => {
  const flagged = { id: 9, user_id: 7, status: 'needs_review', reservation_transaction_id: 501, reserved_credits: '10.36' };

  it('refunds the reservation', async () => {
    state.charge = flagged;
    await expect(maintenance.resolveWhatsAppCharge(9, 'refund', 3)).resolves.toEqual({ status: 'refunded' });
    expect(refundDeduction).toHaveBeenCalledWith(expect.objectContaining({ userId: 7, transactionId: 501 }));
  });

  it('keeps the reservation as the final charge', async () => {
    state.charge = flagged;
    await expect(maintenance.resolveWhatsAppCharge(9, 'charge', 3)).resolves.toEqual({ status: 'settled' });
    expect(settleReservation).toHaveBeenCalledWith(expect.objectContaining({ transactionId: 501, actualCredits: 10.36 }));
    expect(state.updates.at(-1)).toContain("status = 'settled'");
  });

  it('only resolves charges that need review', async () => {
    state.charge = { ...flagged, status: 'settled' };
    await expect(maintenance.resolveWhatsAppCharge(9, 'refund', 3)).rejects.toMatchObject({ status: 409 });
    state.charge = null;
    await expect(maintenance.resolveWhatsAppCharge(9, 'refund', 3)).rejects.toMatchObject({ status: 404 });
    expect(refundDeduction).not.toHaveBeenCalled();
  });
});

describe('revoking the credit line after a disconnect', () => {
  it('reads the WABA IDs from active WhatsApp credentials', async () => {
    state.sessions = [{ session_data: { businessAccountId: 'waba-1' } }, { session_data: {} }, { session_data: { wabaId: 'waba-2' } }];
    await expect(disconnect.activeWhatsAppWabaIds({ execute } as never, 7)).resolves.toEqual(['waba-1', 'waba-2']);
  });

  it("keeps the credit line on a WABA another of the owner's businesses still uses", async () => {
    state.sessions = [{ session_data: { businessAccountId: 'waba-2' } }];
    await disconnect.revokeWhatsAppCreditLinesAfterDisconnect(7, ['waba-1', 'waba-2', 'waba-1', '']);
    expect(revokeCreditLinesForUser).toHaveBeenCalledWith(7, ['waba-1']);
  });

  it('does nothing when every WABA is still in use, and never throws', async () => {
    state.sessions = [{ session_data: { businessAccountId: 'waba-1' } }];
    await disconnect.revokeWhatsAppCreditLinesAfterDisconnect(7, ['waba-1']);
    expect(revokeCreditLinesForUser).not.toHaveBeenCalled();
    execute.mockRejectedValueOnce(new Error('database down'));
    await expect(disconnect.revokeWhatsAppCreditLinesAfterDisconnect(7, ['waba-1'])).resolves.toBeUndefined();
  });
});
