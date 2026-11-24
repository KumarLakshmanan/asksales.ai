import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { SupportMemberNotificationService, supportNotificationDeliveryJob, supportNotificationSubmissionIsUncertain } from '../services/SupportMemberNotificationService.js';
import { db } from '../models/db.js';
import { queueRegistry } from '../queues/index.js';
import { readFileSync } from 'node:fs';

describe('durable support notification retry scheduling', () => {
  const now = Date.parse('2026-09-04T21:00:00Z');
  afterEach(() => { jest.restoreAllMocks(); });
  it('deduplicates repeated recovery passes but not a later attempt', () => {
    const first = supportNotificationDeliveryJob(1, 9, 0, '2026-09-04 21:00:03', now);
    expect(first).toEqual(supportNotificationDeliveryJob(1, 9, 0, '2026-09-04 21:00:03', now));
    expect(first.delay).toBe(3000);
    expect(first.attempts).toBe(1);
    expect(supportNotificationDeliveryJob(1, 9, 1, '2026-09-04 21:00:06', now).jobId).not.toBe(first.jobId);
  });
  it('allows an explicit later retry after resetting the attempt counter and isolates tenants', () => {
    const original = supportNotificationDeliveryJob(1, 9, 0, '2026-09-04 21:00:03', now);
    expect(supportNotificationDeliveryJob(1, 9, 0, '2026-09-05 21:00:03', now).jobId).not.toBe(original.jobId);
    expect(supportNotificationDeliveryJob(1, 10, 0, '2026-09-04 21:00:03', now).jobId).not.toBe(original.jobId);
    expect(supportNotificationDeliveryJob(1, 9, 2, '2026-09-04 20:59:00', now).delay).toBe(0);
  });
  it('does not recover already accepted notifications and requires reconciliation after a crash', () => {
    const service = readFileSync('services/SupportMemberNotificationService.ts', 'utf8');
    const queue = service.slice(service.indexOf('private async queueDelivery'), service.indexOf('async processPendingEvents'));
    expect(queue).toContain("status IN ('pending','retry') AND attempt_count < max_attempts");
    expect(queue).toContain("status='uncertain', error_code='WORKER_OUTCOME_UNKNOWN'");
    expect(queue).toContain('if (!pending) return');
  });
  it('does not override the configured sender with an unverified deployment default', () => {
    const compose = readFileSync('../docker-compose.production.yml', 'utf8');
    expect(compose).not.toContain('SUPPORT_NOTIFICATION_FROM_EMAIL: noreply@asksales.ai');
  });
  it('recovers a due ledger retry as a new single-attempt BullMQ job', async () => {
    jest.spyOn(db, 'execute')
      .mockResolvedValueOnce({ rows: [{ id: 1, user_id: 9 }] })
      .mockResolvedValueOnce({ rows: [] }) // transaction-local tenant identity
      .mockResolvedValueOnce({ rows: [] }) // reconcile abandoned submissions
      .mockResolvedValueOnce({ rows: [{ attempt_count: 3, next_attempt_at: '2026-09-04 21:00:00' }] });
    const enqueue = jest.spyOn(queueRegistry, 'addJob').mockResolvedValue('queued-test');
    await new SupportMemberNotificationService().processDueDeliveries();
    expect(enqueue).toHaveBeenCalledWith('general', 'support-member-notification', expect.objectContaining({
      userId: 9, deliveryId: 1,
    }), expect.objectContaining({ jobId: `support-member-notification-9-1-3-${now}`, attempts: 1 }));
  });
  it('skips a recovery candidate that another worker already delivered', async () => {
    jest.spyOn(db, 'execute')
      .mockResolvedValueOnce({ rows: [{ id: 1, user_id: 9 }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    const enqueue = jest.spyOn(queueRegistry, 'addJob').mockResolvedValue('unused');
    await new SupportMemberNotificationService().processDueDeliveries();
    expect(enqueue).not.toHaveBeenCalled();
  });
  it('does not retry ambiguous Meta submissions, while Resend retains provider idempotency', () => {
    for (const error of [new Error('fetch failed'), { name: 'TimeoutError' }, { code: 'ECONNRESET' }]) {
      expect(supportNotificationSubmissionIsUncertain('whatsapp', error)).toBe(true);
      expect(supportNotificationSubmissionIsUncertain('email', error)).toBe(false);
    }
    expect(supportNotificationSubmissionIsUncertain('whatsapp', new Error('Template rejected'))).toBe(false);
  });
});
