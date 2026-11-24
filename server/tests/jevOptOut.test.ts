import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { PgDialect } from 'drizzle-orm/pg-core';
const execute = jest.fn<(...args: any[]) => Promise<any>>();
const transaction = jest.fn<(...args: any[]) => Promise<any>>();
jest.unstable_mockModule('../models/db.js', () => ({ db: { transaction } }));
const { OptOutStage, SemanticOptOutStage } = await import('../services/agents/pipeline/stages/OptOutStage.js');
const context = (text: string, preference = 'opt_out', confidence = 0.99) => ({
  message: { userId: 8, conversationId: 19, channel: 'whatsapp', inboundText: text, metadata: { dryRun: true } },
  nlu: { contactPreference: preference, classificationConfidence: confidence, contactPreferenceVerified: true }, metadata: {},
} as any);
beforeEach(() => {
  jest.resetAllMocks();
  transaction.mockImplementation(async callback => callback({ execute }));
  execute.mockResolvedValue({ rows: [{ id: 19 }] });
});
describe('semantic opt-out reuses canonical withdrawal, never re-opt-in', () => {
  it.each(['STOP', 'unsubscribe me', 'Please stop messaging'])('retains immediate %s handling without any model output', async text => {
    const ctx = context(text); delete ctx.nlu;
    await new OptOutStage().execute(ctx);
    expect(ctx.metadata.systemDirective).toBe('opt_out_confirmation');
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each(['Please leave me alone and never contact me again.', 'இனிமேல் எனக்கு செய்திகள் அனுப்ப வேண்டாம்.'])('honors confident semantic withdrawal: %s', async text => {
    const ctx = context(text);
    await new SemanticOptOutStage().execute(ctx);
    expect(ctx.metadata).toMatchObject({ systemDirective: 'opt_out_confirmation', skipAgentGeneration: true, suppressBusinessEffects: true });
    expect(transaction).not.toHaveBeenCalled();
  });
  it.each([
    ['Cancel my reservation', 'unchanged', 0.99],
    ['The documentation says "unsubscribe"', 'unchanged', 0.99],
    ['Please connect me to someone', 'unchanged', 0.99],
    ['Not interested', 'uncertain', 0.99],
    ['Maybe stop?', 'opt_out', 0.6],
    ['Contact me again', 'unchanged', 0.99],
    ['Stop', 'opt_out', NaN],
  ])('does not change contact permission from %s / %s', async (text, preference, confidence) => {
    const ctx = context(text as string, preference as string, confidence as number);
    await new SemanticOptOutStage().execute(ctx);
    expect(ctx.agentResult).toBeUndefined();
    expect(transaction).not.toHaveBeenCalled();
  });
  it('uses tenant and conversation ownership in the same transaction', async () => {
    const ctx = context('Please stop all future contact'); ctx.message.metadata.dryRun = false;
    await new SemanticOptOutStage().execute(ctx);
    expect(transaction).toHaveBeenCalledTimes(1);
    const query = new PgDialect().sqlToQuery(execute.mock.calls[0][0]);
    expect(query.sql).toContain('user_id');
    expect(query.params).toEqual([19, 8]);
    expect(execute).toHaveBeenCalledTimes(2);
  });
  it('never uses confidence in unrelated fields as withdrawal evidence', async () => {
    const ctx = context('Maybe later'); delete ctx.nlu.contactPreferenceVerified;
    await new SemanticOptOutStage().execute(ctx);
    expect(transaction).not.toHaveBeenCalled();
    expect(ctx.agentResult).toBeUndefined();
  });
  it('fails closed if the target is not owned, without claiming unsubscribe success', async () => {
    execute.mockResolvedValueOnce({ rows: [] });
    const ctx = context('Please stop contact'); ctx.message.metadata.dryRun = false;
    await expect(new SemanticOptOutStage().execute(ctx)).rejects.toThrow('ownership');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(ctx.agentResult).toBeUndefined();
  });
});
