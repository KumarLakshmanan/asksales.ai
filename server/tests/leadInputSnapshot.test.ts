import { describe, expect, it } from '@jest/globals';
import { assertLeadInputsUnchanged, readLeadInputSnapshot, snapshotLeadInput } from '../models/conversationWorkflow/leadInputSnapshot.js';
import type { LeadInputRecord } from '../models/leadInputs/schema.js';

const row: LeadInputRecord = {
  id: 81, userId: 1, businessProfileId: 11, threadId: 42, messageId: null,
  platform: 'linkedin', inputs: { currentJobTitles: ['CTO'], maxItems: 3 },
  schema: { requestedLeadTotal: 3 }, actorId: 'harvestapi/linkedin-profile-search',
  actorName: 'LinkedIn', workflowId: 'linkedin_b2b', category: 'Profiles',
  recommendedSubWorkflows: ['linkedin'], createdAt: new Date(),
};
const review = () => ({ userId: 1, threadId: 42, inputIds: [81], snapshot: { inputs: [snapshotLeadInput(row)] } });

describe('immutable lead input review', () => {
  it('retains the exact reviewed records and rejects mutable edits before approval', () => {
    const saved = review();
    const approved = readLeadInputSnapshot(saved);
    expect(() => assertLeadInputsUnchanged(approved, [row])).not.toThrow();
    expect(() => assertLeadInputsUnchanged(approved, [{ ...row, inputs: { currentJobTitles: ['CEO'], maxItems: 1000 } }])).toThrow(/changed/);
    expect(approved[0].inputs).toEqual({ currentJobTitles: ['CTO'], maxItems: 3 });
  });

  it('compares values independently of JSON property order or non-execution timestamps', () => {
    const approved = readLeadInputSnapshot(review());
    expect(() => assertLeadInputsUnchanged(approved, [{ ...row, inputs: { maxItems: 3, currentJobTitles: ['CTO'] }, createdAt: new Date(0) }])).not.toThrow();
  });

  it('rejects deleted, cross-thread, and cross-account records', () => {
    expect(() => assertLeadInputsUnchanged(readLeadInputSnapshot(review()), [])).toThrow(/changed/);
    expect(() => readLeadInputSnapshot({ ...review(), userId: 2 })).toThrow(/conversation/);
    expect(() => readLeadInputSnapshot({ ...review(), threadId: 43 })).toThrow(/conversation/);
    expect(() => readLeadInputSnapshot({ ...review(), inputIds: [99] })).toThrow(/conversation/);
  });

  it('requires a fresh review for legacy sets that lack an immutable execution snapshot', () => {
    expect(() => readLeadInputSnapshot({ ...review(), snapshot: { schemas: [] } })).toThrow(/review.*again/);
  });
});
