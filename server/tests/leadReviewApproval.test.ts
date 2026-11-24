import { createLeadAgent, isExplicitReviewedLeadApproval } from '../mastra/agents/leadAgent.js';
import {
  blockPrematureOutreach,
  prepareLeadReviewPipeline,
  sanitizeLeadReviewPipeline,
} from '../mastra/orchestrator.js';
import { getCompletedLeadOutreachGate, normalizeReviewedLeadIds } from '../mastra/leadReview.js';

describe('lead review approval gate', () => {
  it.each([
    'Do not approve the reviewed leads.', 'I do not approve these leads.',
    'I don’t approve these leads.', 'Can I approve these leads?',
    'I approve these leads if the emails are verified.', 'I might approve the leads later.',
    'The client approved the leads.', '"I approve the leads" is an example.',
    'I approve these leads except lead 101.',
    'Approve lead 101.', 'I approve leads 101 and 102.', 'I approve these leads but only the first one.',
  ])('does not interpret ambiguous or negative wording as approval: %s', (message) => {
    expect(isExplicitReviewedLeadApproval(message)).toBe(false);
    const state = { leadWorkflowExecuted: true, selectedLeadIds: [101], leadReviewApproved: false, agentPipeline: ['lead_generation', 'outreach'] } as any;
    prepareLeadReviewPipeline(state, message);
    expect(state.leadReviewApproved).toBe(false);
  });

  it('preserves exact decimal IDs without coercing booleans, objects or unsafe integers', () => {
    expect(normalizeReviewedLeadIds([101, '102', ' 102 ', true, [103], { valueOf: () => 104 }, '0x69', '1e2', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]))
      .toEqual([101, 102]);
    expect(getCompletedLeadOutreachGate({ leadWorkflowExecuted: true, leadReviewApproved: true, selectedLeadIds: [true] })?.status).toBe('no_leads');
  });
  it('never tells the model that execution alone proves leads exist', () => {
    const agent = createLeadAgent() as any;
    const prompt = agent.buildSystemPrompt({ messages: [], leadWorkflowExecuted: true, leadReviewApproved: true, selectedLeadIds: [] });
    expect(prompt).toContain('NO VERIFIED LEAD IDS');
    expect(prompt).toContain('Execution alone is NOT evidence');
    expect(prompt).not.toContain('REVIEWED LEADS APPROVED:');
    expect(prompt).not.toContain('Leads have been generated, but');
  });

  it('identifies the exact nonempty selection without claiming a workspace-wide count', () => {
    const agent = createLeadAgent() as any;
    const prompt = agent.buildSystemPrompt({ messages: [], leadWorkflowExecuted: true, leadReviewApproved: false, selectedLeadIds: [101, 102] });
    expect(prompt).toContain('VERIFIED CURRENT LEAD IDS (2): 101, 102');
    expect(prompt).toContain('not a count of every lead in the workspace');
    expect(prompt).toContain('NOT approved for outreach');
    expect(prompt).not.toContain('NO VERIFIED LEAD IDS');
  });

  it('requires approval language tied to the reviewed lead set', () => {
    expect(isExplicitReviewedLeadApproval('I approve the reviewed leads.')).toBe(true);
    expect(isExplicitReviewedLeadApproval('Approve these leads')).toBe(true);
    expect(isExplicitReviewedLeadApproval('Looks good')).toBe(false);
    expect(isExplicitReviewedLeadApproval('I am satisfied')).toBe(false);
    expect(isExplicitReviewedLeadApproval('Done')).toBe(false);
  });

  it('blocks pipeline completion after generation until reviewed leads are explicitly approved', () => {
    const agent = createLeadAgent() as any;
    const state = { leadWorkflowExecuted: true, leadReviewApproved: false, selectedLeadIds: [101], leadInputs: [] };

    expect(agent._handleToolCall('tasks_completed', {}, state)).toBe(false);
    expect(agent._handleToolCall('tasks_completed', {}, { ...state, leadReviewApproved: true })).toBe(true);
    expect(agent._handleToolCall('tasks_completed', {}, {
      ...state,
      leadReviewApproved: true,
      selectedLeadIds: [],
    })).toBe(false);
  });

  it('blocks direct orchestration to outreach until the generated leads are approved', () => {
    const state = {
      leadWorkflowExecuted: true,
      leadReviewApproved: false,
      selectedLeadIds: [101],
      nextAgent: 'outreach',
    } as any;

    expect(blockPrematureOutreach(state, 'outreach')?.content).toMatch(/approve/i);
    expect(state.nextAgent).toBeNull();
    expect(blockPrematureOutreach({ ...state, leadReviewApproved: true }, 'outreach')).toBeNull();
  });

  it('does not assemble outreach into a lead-generation pipeline before review approval', () => {
    const pipeline = ['icp_generation', 'lead_generation', 'outreach'] as any;
    const state = { leadReviewApproved: false, selectedLeadIds: [] } as any;

    expect(sanitizeLeadReviewPipeline(state, pipeline))
      .toEqual(['icp_generation', 'lead_generation']);
    expect(state.deferredLeadReviewPipeline).toEqual(pipeline);
    expect(sanitizeLeadReviewPipeline({ leadReviewApproved: true, selectedLeadIds: [101] } as any, pipeline))
      .toEqual(pipeline);
    expect(blockPrematureOutreach({ agentPipeline: pipeline, leadReviewApproved: false } as any, 'outreach'))
      .not.toBeNull();
  });

  it('restores the exact deferred pipeline after reviewed-lead approval', () => {
    const deferredPipeline = ['icp_generation', 'lead_generation', 'content_studio', 'outreach', 'performance_marketing'] as any;
    const state = {
      leadWorkflowExecuted: true,
      leadReviewApproved: false,
      selectedLeadIds: [101],
    } as any;

    expect(sanitizeLeadReviewPipeline(state, deferredPipeline))
      .toEqual(['icp_generation', 'lead_generation', 'content_studio', 'performance_marketing']);

    state.leadReviewApproved = true;
    expect(sanitizeLeadReviewPipeline(state, ['icp_generation', 'lead_generation'] as any))
      .toEqual(deferredPipeline);
    expect(state.deferredLeadReviewPipeline).toEqual([]);
  });

  it('recognizes explicit approval before sanitizing the pending outreach handoff', () => {
    const state = {
      leadWorkflowExecuted: true,
      leadReviewApproved: false,
      selectedLeadIds: [101, 102],
      agentPipeline: ['icp_generation', 'lead_generation', 'outreach'],
      agentPipelineIndex: 1,
    } as any;

    prepareLeadReviewPipeline(state, 'I explicitly approve all six reviewed leads for outreach handoff.');

    expect(state.leadReviewApproved).toBe(true);
    expect(state.agentPipeline).toEqual(['icp_generation', 'lead_generation', 'outreach']);
    expect(state.agentPipelineIndex).toBe(1);
  });

  it('restores a pipeline deferred on an earlier turn when approval arrives', () => {
    const state = {
      leadWorkflowExecuted: true,
      leadReviewApproved: false,
      selectedLeadIds: [101, 102],
      agentPipeline: ['icp_generation', 'lead_generation', 'outreach'],
      agentPipelineIndex: 1,
    } as any;

    prepareLeadReviewPipeline(state, 'Show me the generated leads.');
    expect(state.agentPipeline).toEqual(['icp_generation', 'lead_generation']);
    expect(state.deferredLeadReviewPipeline).toEqual(['icp_generation', 'lead_generation', 'outreach']);

    prepareLeadReviewPipeline(state, 'I approve the reviewed leads.');
    expect(state.leadReviewApproved).toBe(true);
    expect(state.agentPipeline).toEqual(['icp_generation', 'lead_generation', 'outreach']);
    expect(state.deferredLeadReviewPipeline).toEqual([]);
  });

  it('removes reviewed-lead approval buttons after approval', () => {
    const agent = createLeadAgent() as any;
    const buttons = agent.buildActionButtons({
      leadWorkflowExecuted: true,
      leadReviewApproved: true,
      selectedLeadIds: [101],
    }, []);

    expect(buttons).toEqual([]);
  });

  it('never approves or completes an empty lead result', () => {
    const state = {
      leadWorkflowExecuted: true,
      leadReviewApproved: true,
      selectedLeadIds: [],
      agentPipeline: ['lead_generation', 'outreach'],
      agentPipelineIndex: 0,
    } as any;

    prepareLeadReviewPipeline(state, 'I approve the reviewed leads.');

    expect(state.leadReviewApproved).toBe(false);
    expect(blockPrematureOutreach(state, 'outreach')?.content).toMatch(/no persisted lead ids/i);
    expect(getCompletedLeadOutreachGate(state)).toEqual({
      status: 'no_leads',
      error: 'No persisted lead IDs are available for outreach. Generate or import leads before continuing.',
    });
  });

  it('prioritizes a fresh retry strategy over stale review actions', () => {
    const agent = createLeadAgent() as any;
    const buttons = agent.buildActionButtons({
      leadWorkflowExecuted: true,
      leadReviewApproved: false,
      selectedLeadIds: [],
    }, [{
      toolName: 'list_available_workflows',
      success: true,
      result: {
        output: {
          recommendations: {
            google_maps: { id: 'google_maps' },
            justdial: { id: 'justdial' },
          },
        },
      },
    }]);

    expect(buttons.map((button: any) => button.label)).toEqual([
      'Prepare Search Settings',
      'Show All Strategies',
    ]);
    expect(buttons[0].data.selectedWorkflows).toEqual(['google_maps', 'justdial']);
  });

  it('shows reviewed-lead approval only when exact persisted IDs exist', () => {
    const agent = createLeadAgent() as any;

    expect(agent.buildActionButtons({
      leadWorkflowExecuted: true,
      leadReviewApproved: false,
      selectedLeadIds: [],
    }, [])).toEqual([]);

    expect(agent.buildActionButtons({
      leadWorkflowExecuted: true,
      leadReviewApproved: false,
      selectedLeadIds: [101, 102],
    }, []).map((button: any) => button.label)).toEqual([
      'Approve reviewed leads',
      'Adjust search',
    ]);
  });
});
