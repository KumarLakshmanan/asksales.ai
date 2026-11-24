import { beforeEach, describe, expect, it, jest } from '@jest/globals';
const find = jest.fn<any>();
jest.unstable_mockModule('../models/leads/functions.js', () => ({ LeadModel: { findByIdForUser: find } }));
const { createLeadShortlistTools } = await import('../mastra/tools/leadShortlistTools.js');
const { createLeadAgent } = await import('../mastra/agents/leadAgent.js');
const call = (tool: any, args = {}) => tool.execute(args, {});
beforeEach(() => { find.mockReset().mockImplementation(async (id: number) => ({ id, name: `Lead ${id}`, role: id === 101 ? 'Dental clinic owner' : 'Supplier', userId: 7 })); });
describe('saved lead shortlist operations', () => {
  it('blocks new searches, settings, and handoffs during shortlist refinement', () => {
    const agent = createLeadAgent() as any;
    const state = { intentAnalysis: { leadShortlistRequested: true }, leadReviewApproved: true, leadWorkflowExecuted: true, selectedLeadIds: [101] };
    for (const tool of ['generate_lead_inputs', 'execute_lead_workflow', 'list_available_workflows', 'tasks_completed']) {
      expect(agent._handleToolCall(tool, {}, state)).toBe(false);
    }
    expect(agent._handleToolCall('get_lead_shortlist', {}, state)).toBe(true);
    expect(agent._handleToolCall('revise_lead_shortlist', {}, state)).toBe(true);
  });
  it('returns the full current selection, including classification facts, with tenant checks', async () => {
    const tools = createLeadShortlistTools({ userId: 7, threadId: 9 }, () => [101, 104]);
    const result = await call(tools.get_lead_shortlist);
    expect(result.output.leadIds).toEqual([101, 104]);
    expect(result.output.leads[1].role).toBe('Supplier');
    expect(find.mock.calls).toEqual([[101, 7], [104, 7]]);
  });
  it('requires a current-turn read before any selection change', async () => {
    const tools = createLeadShortlistTools({ userId: 7, threadId: 9 }, () => [101, 104]);
    expect(await call(tools.revise_lead_shortlist, { expectedLeadIds: [101, 104], keepLeadIds: [101] })).toMatchObject({ success: false });
    expect(find).not.toHaveBeenCalled();
  });
  it('keeps exact IDs after category review without deleting records or granting approval', async () => {
    const tools = createLeadShortlistTools({ userId: 7, threadId: 9 }, () => [101, 104]);
    await call(tools.get_lead_shortlist);
    expect(await call(tools.revise_lead_shortlist, { expectedLeadIds: [101, 104], keepLeadIds: [101] })).toMatchObject({ success: true, output: { leadIds: [101], removedLeadIds: [104], leadReviewApproved: false } });
  });
  it('rejects stale snapshots and IDs outside the current shortlist', async () => {
    let selected = [101, 104];
    const tools = createLeadShortlistTools({ userId: 7, threadId: 9 }, () => selected);
    await call(tools.get_lead_shortlist);
    expect(await call(tools.revise_lead_shortlist, { expectedLeadIds: selected, keepLeadIds: [999] })).toMatchObject({ success: false });
    selected = [101];
    expect(await call(tools.revise_lead_shortlist, { expectedLeadIds: [101, 104], keepLeadIds: [101] })).toMatchObject({ success: false });
  });
  it.each([undefined, { id: 101, deletedAt: new Date() }])('rejects unavailable or deleted records', async record => {
    find.mockResolvedValue(record);
    const tools = createLeadShortlistTools({ userId: 7, threadId: 9 }, () => [101]);
    expect(await call(tools.get_lead_shortlist)).toMatchObject({ success: false });
  });
  it('allows intentionally clearing the shortlist without restoring the old selection', async () => {
    const agent = createLeadAgent() as any;
    const state = { userId: 7, threadId: 9, selectedLeadIds: [101], leadReviewApproved: true, leadWorkflowExecuted: true, messages: [] };
    await agent.preProcess(state);
    const tools = agent.getTools({ userId: 7, threadId: 9 });
    await call(tools.get_lead_shortlist);
    const result = await call(tools.revise_lead_shortlist, { expectedLeadIds: [101], keepLeadIds: [] });
    agent._handleToolResult('revise_lead_shortlist', result, state, {});
    expect(agent.buildReturnState(state, {})).toMatchObject({ selectedLeadIds: [], leadReviewApproved: false });
    expect(agent._handleToolCall('tasks_completed', {}, state)).toBe(false);
  });
  it('invalidates previous reviewed-lead approval after retaining a nonempty subset', async () => {
    const agent = createLeadAgent() as any;
    const state = { userId: 7, threadId: 9, selectedLeadIds: [101, 104], leadReviewApproved: true, leadWorkflowExecuted: true, messages: [] };
    await agent.preProcess(state);
    agent._handleToolResult('revise_lead_shortlist', { success: true, output: { leadIds: [101] } }, state, {});
    expect(agent.buildReturnState(state, {})).toMatchObject({ selectedLeadIds: [101], leadReviewApproved: false });
    expect(agent._handleToolCall('tasks_completed', {}, state)).toBe(false);
  });
});
