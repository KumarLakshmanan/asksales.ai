import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

// These verify Hotel's transaction boundary against the requested helper
// interface. They do not replace the combined real-helper PostgreSQL tests.
const order: string[] = [];
const execute = jest.fn<(query: unknown) => Promise<{ rows: Record<string, unknown>[] }>>();
const tx = { execute };
const transaction = async (work: (value: typeof tx) => Promise<unknown>) => {
  order.push('begin');
  try { const result = await work(tx); order.push('commit'); return result; }
  catch (error) { order.push('rollback'); throw error; }
};
jest.unstable_mockModule('../models/db.js', () => ({ db: { execute, transaction } }));
const evidence = jest.fn<(value: unknown, executor?: unknown) => Promise<void>>();
jest.unstable_mockModule('../services/insights/SalesEvidence.js', () => ({ recordPaymentEvidence: evidence }));
jest.unstable_mockModule('../utils/logger.js', () => ({ logger: {
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
} }));
const { BookingService } = await import('../services/booking/BookingService.js');
const row = { id:41,user_id:7,business_profile_id:11,status:'pending_payment',payment_status:'pending',
  total_price:'200.00',currency:'INR',hotel_property_id:3,room_type_id:9,check_in_date:'2030-01-01',
  check_out_date:'2030-01-03',nights:2,number_of_rooms:1,inventory_reserved_at:new Date(),inventory_released_at:null };
const receipt = {paymentId:'manual:synthetic_receipt',amountMinor:20000,currency:'INR',source:'manual' as const,occurredAt:'2026-10-23T12:00:00Z'};

describe('Hotel confirmation transaction contract', () => {
  let selected: Record<string, unknown>;
  let service: InstanceType<typeof BookingService>;
  const effects = jest.fn<(id: number) => Promise<void>>();
  beforeEach(() => {
    order.length=0; selected={...row}; service=new BookingService();
    // Only the external postcommit boundary is replaced.
    Object.assign(service,{processConfirmationSideEffects:effects});
    effects.mockReset().mockImplementation(async () => { order.push('effects'); });
    evidence.mockReset().mockImplementation(async () => { order.push('ledger'); });
    execute.mockReset().mockImplementation(async query => {
      const text = new PgDialect().sqlToQuery(query as SQL).sql;
      if (/SELECT \*\s+FROM bookings/.test(text)) return {rows:[selected]};
      if (/UPDATE bookings\s+SET status = 'confirmed'/.test(text)) return {rows:[{...selected,status:'confirmed',payment_status:'paid',payment_id:receipt.paymentId}]};
      throw new Error(`Unexpected contract query: ${text}`);
    });
  });
  it('uses the same executor and commits ledger evidence before postcommit effects', async () => {
    expect((await service.confirmBookingById(41,7,'manual_dashboard',receipt))?.status).toBe('confirmed');
    expect(evidence).toHaveBeenCalledWith(expect.objectContaining({bookingId:41,...receipt}),tx);
    expect(order).toEqual(['begin','ledger','commit','effects']);
  });
  it('propagates ledger rejection through rollback without starting CRM effects', async () => {
    evidence.mockImplementation(async () => { order.push('ledger'); throw new Error('Synthetic ledger rejection'); });
    await expect(service.confirmBookingById(41,7,'manual_dashboard',receipt)).rejects.toThrow('Synthetic ledger rejection');
    expect(order).toEqual(['begin','ledger','rollback']);
    expect(effects).not.toHaveBeenCalled();
  });
  it('validates and records evidence for an already-confirmed receipt replay under the same transaction', async () => {
    selected={...row,status:'confirmed',payment_id:receipt.paymentId};
    expect((await service.confirmBookingById(41,7,'manual_dashboard',receipt))?.status).toBe('confirmed');
    expect(evidence).toHaveBeenCalledWith(expect.objectContaining({bookingId:41,paymentId:receipt.paymentId}),tx);
    expect(order).toEqual(['begin','ledger','commit','effects']);
  });
  it('rejects a supplied receipt that omits its evidence source instead of silently bypassing the ledger', async () => {
    const incomplete = {...receipt,source:undefined} as unknown as typeof receipt;
    await expect(service.confirmBookingById(41,7,'manual_dashboard',incomplete)).rejects.toThrow('Captured payment evidence is incomplete');
    expect(evidence).not.toHaveBeenCalled();
    expect(effects).not.toHaveBeenCalled();
    expect(order).toEqual(['begin','rollback']);
  });
});
