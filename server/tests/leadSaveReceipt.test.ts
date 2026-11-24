import { expect, it } from '@jest/globals';
import { readLeadSaveReceipt } from '../mastra/utils/leadSaveReceipt.js';

it('counts unique saved identities rather than repeated upserts', () => {
  expect(readLeadSaveReceipt({ leadsCount: 4, leadIds: [12, '12', 14] })).toEqual({ leadIds: [12, 14], leadsCount: 2 });
});
it('accepts a valid empty receipt', () => {
  expect(readLeadSaveReceipt({ leadsCount: 0, leadIds: [] })).toEqual({ leadIds: [], leadsCount: 0 });
});
it('accepts an explicitly empty workflow that skipped saving', () => {
  expect(readLeadSaveReceipt(undefined, 'succeeded_empty')).toEqual({ leadIds: [], leadsCount: 0 });
});
it.each([undefined, null, {}, [], 'complete'])('rejects missing or malformed receipt %s without an explicit empty outcome', receipt => {
  expect(() => readLeadSaveReceipt(receipt, 'succeeded')).toThrow('no verifiable save receipt');
});
it('rejects a positive count without an actionable selection', () => {
  expect(() => readLeadSaveReceipt({ leadsCount: 5 })).toThrow('without saved lead IDs');
});
it.each([0, -1, true, '1e2', Number.MAX_SAFE_INTEGER + 1])('rejects invalid saved identity %s', id => {
  expect(() => readLeadSaveReceipt({ leadIds: [id] })).toThrow('invalid IDs');
});
