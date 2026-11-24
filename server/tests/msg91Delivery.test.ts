import { describe, expect, it, jest } from '@jest/globals';

const transaction = jest.fn();
jest.unstable_mockModule('../models/db.js', () => ({ db: { transaction } }));
const { normalizeMSG91DeliveryReports, processMSG91DeliveryReports, MSG91DeliveryError } = await import('../services/MSG91DeliveryService.js');

const report = { requestId: 'request-42', senderId: 'ABCDEF', telNum: '+91 98765 43210', status: '1' };

describe('MSG91 delivery callback contract', () => {
  it('normalizes customizable OnReportReceived fields and timestamps', () => {
    expect(normalizeMSG91DeliveryReports({ ...report, deliveryTime: '2026-09-29 12:00:00' })).toEqual([
      { requestId: 'request-42', senderId: 'ABCDEF', phone: '919876543210', status: 'delivered', occurredAt: new Date('2026-09-29T06:30:00Z') },
    ]);
  });
  it('accepts the legacy V4 data envelope and multiple recipient reports', () => {
    expect(normalizeMSG91DeliveryReports({ data: JSON.stringify([{ requestId: 'request-42', senderId: 'ABCDEF', report: [
      { number: '919876543210', status: '0' }, { number: '919876543211', status: '2', failedReason: 'Delivery failed' },
    ] }]) })).toMatchObject([
      { phone: '919876543210', status: 'sent' }, { phone: '919876543211', status: 'failed', failureReason: 'Delivery failed' },
    ]);
  });
  it.each(['2', '9', '16', '17', '20', '25', 'FAILED', 'REJECTED', 'BLOCKED'])('records failure status %s', status => {
    expect(normalizeMSG91DeliveryReports({ ...report, status })[0].status).toBe('failed');
  });
  it.each([
    null, [], { data: 'not-json' }, { ...report, status: 'unknown' }, { ...report, senderId: 'bad' },
    { ...report, telNum: 'invalid' }, { ...report, requestId: '' }, { ...report, deliveryTime: 'not-a-date' },
    Array.from({ length: 201 }, () => report),
  ])('rejects malformed or oversized report %j', payload => {
    expect(() => normalizeMSG91DeliveryReports(payload)).toThrow(MSG91DeliveryError);
  });
  it('does not access tenant data outside the authenticated callback business scope', async () => {
    await expect(processMSG91DeliveryReports(9, report)).rejects.toMatchObject({ status: 403, code: 'SMS_CALLBACK_SCOPE_REQUIRED' });
    expect(transaction).not.toHaveBeenCalled();
  });
});
