import { describe, expect, it } from '@jest/globals';
import { crmActivitySchema, crmContactCreateSchema } from '../middleware/schemas.js';
import { crmImportPatch } from '../utils/crmImportPatch.js';

describe('CRM mutation DTO integrity', () => {
  it.each(['id', 'userId', 'businessProfileId', 'contactId', 'metadata', 'idempotencyKey', 'outreachMessageId'])('rejects forged activity field %s', key => {
    expect(crmActivitySchema.partial().safeParse({ subject: 'Synthetic note', [key]: key === 'metadata' ? { actorUserId: 99 } : 99 }).success).toBe(false);
  });
  it('allows public task dates and rejects creation/editing of system event types', () => {
    expect(crmActivitySchema.safeParse({ type: 'task', dueAt: '2030-01-02T10:00:00+05:30', priority: 'high' }).success).toBe(true);
    expect(crmActivitySchema.partial().safeParse({ dueAt: null, completedAt: '2030-01-03T00:00:00Z' }).success).toBe(true);
    expect(crmActivitySchema.safeParse({ type: 'pipeline_change', subject: 'Forged event' }).success).toBe(false);
  });
  it('does not accept an ignored update-version field on creation', () => {
    expect(crmContactCreateSchema.safeParse({ email: 'fixture@example.test', expectedUpdatedAt: '2030-01-02T00:00:00Z' }).success).toBe(false);
  });
  it('preserves unmapped import fields and applies explicitly mapped clears only', () => {
    expect(crmImportPatch({ email: 'fixture@example.test', company: 'Updated' }, { Email: 'email', Company: 'company' }, 'new'))
      .toEqual({ company: 'Updated' });
    expect(crmImportPatch({ notes: null, tags: null, dealValue: null }, { Notes: 'notes', Tags: 'tags', Value: 'dealValue' }, 'new'))
      .toEqual({ notes: null, tags: [], dealValue: null });
    expect(crmImportPatch({ status: 'qualified' }, { Stage: 'status' }, 'qualified')).toEqual({ pipelineStatus: 'qualified' });
  });
});
