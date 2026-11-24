import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const responses: unknown[][] = [];
const update = jest.fn();
const insert = jest.fn();
const select = jest.fn(() => {
  const query = { from: () => query, where: () => query, for: () => query,
    limit: async () => responses.shift() ?? [] };
  return query;
});
const tx = { select, update, insert };
jest.unstable_mockModule('../models/db.js', () => ({ db: {
  transaction: async (callback: (value: unknown) => unknown) => callback(tx),
} }));
const { approveIcpRevision, transitionConversationWorkflowRun } = await import('../models/conversationWorkflow/functions.js');

describe('ICP approval receipt replay', () => {
  beforeEach(() => { responses.length = 0; jest.clearAllMocks(); });
  const profile = { id: 128, userId: 1, threadId: 171, revision: 1, approvedRevision: 1, approved: true, fitScore: 81 };
  const input = { userId: 1, threadId: 171, icpId: 128, revision: 1, runId: 'recorded-run' };

  it.each(['lead_executing', 'ad_awaiting_approval', 'completed'])('preserves advanced stage %s without duplicate writes', async stage => {
    const run = { id: 'recorded-run', stage, status: stage === 'completed' ? 'succeeded' : 'running' };
    responses.push([profile], [{ runId: run.id }], [run]);
    expect(await approveIcpRevision(input)).toEqual({ run, icp: profile, replayed: true });
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });
  it('rejects a changed revision before resolving an old receipt', async () => {
    responses.push([{ ...profile, revision: 2 }]);
    await expect(approveIcpRevision(input)).rejects.toThrow('changed');
    expect(select).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });
  it('does not invent a workflow when the recorded run is unavailable', async () => {
    responses.push([profile], [{ runId: 'missing' }], []);
    await expect(approveIcpRevision(input)).rejects.toThrow('workflow is unavailable');
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it('records validated draft readiness before accepting approval of a legacy saved ICP', async () => {
    const draft = { id: input.runId, stage: 'icp_draft', status: 'awaiting_input', context: {}, version: 1 };
    responses.push([{ ...profile, approved: false, approvedRevision: null }], [], [draft]);
    const writes: Record<string, unknown>[] = [];
    update.mockImplementation(() => ({ set: (data: Record<string, unknown>) => {
      writes.push(data);
      return { where: () => ({ returning: async () => [data.stage ? { ...draft, ...data } : profile] }) };
    } }));
    insert.mockImplementation(() => ({ values: () => ({ onConflictDoNothing: async () => undefined }) }));
    const result = await approveIcpRevision(input);
    expect(result.run.stage).toBe('agent_selection');
    expect(writes.map(write => write.stage).filter(Boolean)).toEqual(['icp_awaiting_approval', 'agent_selection']);
    expect(writes[1].context).toEqual({ icpId: 128, icpRevision: 1 });
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it.each([
    { icpId: 999 }, { icpRevision: 2 },
  ])('rejects draft readiness bound to a different ICP: %j', async context => {
    responses.push([profile], [], [{ id: input.runId, stage: 'icp_draft', context }]);
    update.mockImplementation(() => ({ set: () => ({ where: () => ({ returning: async () => [profile] }) }) }));
    await expect(approveIcpRevision(input)).rejects.toThrow('Workflow ICP changed');
    expect(insert).not.toHaveBeenCalled();
  });

  it('rejects an incomplete saved profile before any write', async () => {
    responses.push([{ ...profile, fitScore: 49 }]);
    await expect(approveIcpRevision(input)).rejects.toThrow('incomplete');
    expect(update).not.toHaveBeenCalled();
  });

  it('does not fabricate an explicitly requested missing workflow', async () => {
    responses.push([profile], [], []);
    update.mockImplementation(() => ({ set: () => ({ where: () => ({ returning: async () => [profile] }) }) }));
    await expect(approveIcpRevision(input)).rejects.toThrow('requested ICP approval workflow is unavailable');
    expect(insert).not.toHaveBeenCalled();
  });
  it.each(['ad_awaiting_approval', 'cancelled'])('does not overwrite a tool or cancellation transition to %s', async stage => {
    const current = { id: 'recorded-run', stage, status: 'awaiting_approval', version: 4 };
    responses.push([current]);
    expect(await transitionConversationWorkflowRun({ runId: 'recorded-run', userId: 1, threadId: 171,
      onlyFromStage: 'agent_running', toStage: 'ad_draft', status: 'awaiting_input' })).toEqual(current);
    expect(update).not.toHaveBeenCalled();
  });
});
