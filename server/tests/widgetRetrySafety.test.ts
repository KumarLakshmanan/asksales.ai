/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { syntheticApprovalDb } from './helpers/syntheticApprovalDb.js';
import { widgetStatesTable as widgets } from '../models/widgetStates/schema.js';
let database: any;
const proxy = new Proxy({}, { get: (_target, key) => (...args: any[]) => database[key](...args) });
jest.unstable_mockModule('../models/db.js', () => ({ db: proxy }));
const { WidgetStateModel } = await import('../models/widgetStates/functions.js');
beforeEach(() => { database = syntheticApprovalDb([widgets]); });
afterEach(() => { database.close(); });
async function seed(receipt: any, status = 'failed') {
  await database.insert(widgets).values({ id: 1, userId: 7, threadId: 42, toolName: 'generate_image',
    widgetType: 'image_generation', status, executionResult: receipt, executionAttemptCount: status === 'active' ? 0 : 1 }).returning();
}
describe('atomic widget retry policy', () => {
  it.each([
    { retrySafe: true, ambiguous: true },
    { retrySafe: true, output: { queuedCount: 1 } },
    { retrySafe: true, sideEffectsMayHaveOccurred: true },
    { retrySafe: true, output: { status: 'partial_success' } },
    { retrySafe: true, results: [{ success: true }] },
  ])('does not reclaim accepted or ambiguous work: %j', async receipt => {
    await seed(receipt);
    const result = await WidgetStateModel.claimSubmissionForUser(1, 7, {});
    expect(result.claimed).toBe(false); expect(database.rows(widgets)[0].status).toBe('failed');
    expect(database.rows(widgets)[0].executionResult).toEqual(receipt);
  });
  it('allows one retry of a verified pre-effect failure', async () => {
    await seed({ success: false, output: { retrySafe: true, status: 'failed_before_side_effect' } });
    const results = await Promise.all([WidgetStateModel.claimSubmissionForUser(1, 7, {}), WidgetStateModel.claimSubmissionForUser(1, 7, {})]);
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect(database.rows(widgets)[0]).toMatchObject({ status: 'running', executionAttemptCount: 2 });
  });
  it('retains initial submission and owner isolation', async () => {
    await seed(null, 'active');
    expect((await WidgetStateModel.claimSubmissionForUser(1, 8, {})).claimed).toBe(false);
    expect((await WidgetStateModel.claimSubmissionForUser(1, 7, {})).claimed).toBe(true);
  });
});
