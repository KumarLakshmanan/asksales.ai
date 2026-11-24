/** Scenarios for the live campaign chat run. Each check returns a list of
 * problems (empty = pass). Checks assert behaviour, not exact wording. */
import type { AgentState } from '../../mastra/state.js';

type Outcome = {
  route: null | { action?: string; intent?: string; nextAgent?: string | null; mode?: string; hiredAgents?: string[]; savedDataLookup?: boolean; leadReviewApproval?: boolean; needsClarification?: boolean };
  currentAgent?: string; pipeline?: string[]; pendingApproval: null | { toolName: string; args: unknown };
  toolsRun: Array<{ tool: string; success: boolean; reviewOnly?: boolean }>; deferredPipeline?: string[]; modelCalls: Array<{ purpose: string; tools: string[]; toolCalls: Array<{ name: string }> }>;
  replies: Array<{ agent: string; text: string }>; finalText: string;
};
export interface LiveScenario { id: string; message: string; state: () => Partial<AgentState>; check: (state: AgentState, outcome: Outcome) => string[] }

const SEND_OR_SPEND = /^(send_|execute_lead_workflow|publish_|launch_|create_meta_ad|create_google_ad|schedule_)/;

const approvedIcp = () => ({
  id: 41, campaignName: 'Chennai boutique hotels', industry: 'Hospitality', subIndustry: 'Boutique hotels',
  primaryRegions: ['Chennai, India'], primaryJobTitles: ['General Manager', 'Owner'], targetCompanySizeRange: '10-200',
  primaryValueProposition: 'A booking assistant that answers guest questions on WhatsApp and the website',
  primaryPainPoint: 'Front desk misses enquiries at night', primaryChannels: ['email', 'instagram'],
  businessName: 'StayDesk', businessIndustry: 'Software', businessDescription: 'Guest messaging software for hotels',
  fitScore: 85, approved: true, revision: 1, approvedRevision: 1,
});

const history = (...turns: Array<[string, string]>) => turns.map(([role, content]) => ({ role, content })) as AgentState['messages'];

const base = (extra: Partial<AgentState> = {}): Partial<AgentState> => ({
  icpProfile: approvedIcp() as AgentState['icpProfile'],
  messages: history(['user', 'I sell guest messaging software to boutique hotels in Chennai.'], ['assistant', 'Your ICP is approved. Who should I bring in next?']),
  ...extra,
});

/** A prepared lead search as the app saves it: a completed settings card plus
 * the pending approval to run the search. */
const pendingLeadSearch = (): Partial<AgentState> => ({
  currentAgent: 'lead_generation', requiresApproval: true, workflowOutcome: 'awaiting_approval',
  pendingApproval: { toolName: 'execute_lead_workflow', args: { platforms: ['google_maps'], selected_workflows: ['google_maps_places'], leadInputSetId: 4, leadInputSetRevision: 2 },
    executionId: 'lead-input-set:4:2', message: 'Lead inputs generated. Approve to execute?', createdAt: Date.now() },
  savedToolActions: [{ widgetId: 77, toolName: 'generate_lead_inputs', agentType: 'lead_generation', status: 'completed', runId: null,
    formValues: { platform: 'google_maps', query: 'boutique hotels', location: 'Chennai, India', limit: 50 } }],
  messages: history(['user', 'Find 50 boutique hotel leads in Chennai'], ['assistant', 'I prepared the Google Maps search settings for 50 boutique hotels in Chennai. Review and approve to run the search.']),
});

const ranAgents = (o: Outcome) => [...new Set([...o.replies.map(r => r.agent), o.currentAgent].filter(Boolean))] as string[];
const executedRisky = (o: Outcome) => o.toolsRun.filter(t => SEND_OR_SPEND.test(t.tool) && t.success && !t.reviewOnly).map(t => t.tool);
const offeredTools = (o: Outcome) => new Set(o.modelCalls.flatMap(c => c.tools));
const calledTools = (o: Outcome) => o.modelCalls.flatMap(c => c.toolCalls.map(t => t.name));

function expectAgent(o: Outcome, agent: string): string[] {
  return ranAgents(o).includes(agent) || o.route?.nextAgent === agent || o.route?.hiredAgents?.includes(agent)
    ? [] : [`expected ${agent} to handle the turn; route=${JSON.stringify(o.route)} ran=${ranAgents(o).join(',')}`];
}
function noRisk(o: Outcome): string[] {
  const risky = executedRisky(o);
  return risky.length ? [`ran a send/spend/search tool without approval: ${risky.join(',')}`] : [];
}

export const scenarios: LiveScenario[] = [
  // ── Agent switching ──────────────────────────────────────────────────
  {
    id: 'switch_no_icp_gate',
    message: 'Find me 50 boutique hotel leads in Chennai',
    state: () => ({ messages: [] }),
    check: (_s, o) => [
      ...noRisk(o),
      ...(ranAgents(o).some(a => a === 'lead_generation') && o.toolsRun.some(t => t.tool !== 'tasks_completed') && !o.finalText
        ? ['lead specialist ran before an ICP existed'] : []),
    ],
  },
  {
    id: 'switch_hire_lead',
    message: 'Find 50 boutique hotel leads in Chennai',
    state: () => base(),
    check: (_s, o) => [...expectAgent(o, 'lead_generation'), ...noRisk(o)],
  },
  {
    id: 'switch_hire_content',
    message: 'Write a short cold email to boutique hotel owners about our night-time booking assistant',
    state: () => base(),
    check: (_s, o) => [...expectAgent(o, 'content_studio'), ...noRisk(o)],
  },
  {
    id: 'switch_hire_ads',
    message: 'Plan a Facebook ad campaign with a 500 INR daily budget for hotel owners in Chennai',
    state: () => base(),
    check: (_s, o) => [...expectAgent(o, 'performance_marketing'), ...noRisk(o)],
  },
  {
    id: 'switch_team_pipeline',
    message: 'Find hotel leads in Chennai, then write the outreach email, then send it to them',
    state: () => base(),
    check: (_s, o) => {
      const p = o.pipeline || [];
      const problems = noRisk(o);
      // Steps after lead search wait in the deferred pipeline until the user
      // reviews the leads. Emily writes the message inside her send review.
      const planned = [...p, ...(o.deferredPipeline || [])];
      if (!(planned.includes('lead_generation') && planned.includes('outreach')))
        problems.push(`expected lead search then outreach, got pipeline=${JSON.stringify(p)} deferred=${JSON.stringify(o.deferredPipeline)} route=${JSON.stringify(o.route)}`);
      if (ranAgents(o).some(a => a === 'outreach' || a === 'content_studio')) problems.push('a later step ran before the leads were reviewed');
      return problems;
    },
  },
  {
    id: 'switch_mention',
    message: '@Alex write a LinkedIn post announcing our WhatsApp booking assistant',
    state: () => base({ currentAgent: 'lead_generation' }),
    check: (_s, o) => [...expectAgent(o, 'content_studio'), ...noRisk(o)],
  },
  {
    id: 'switch_question_other_domain',
    message: 'Quick question: how many leads do I have saved in this campaign?',
    state: () => base({ currentAgent: 'content_studio' }),
    check: (_s, o) => {
      const problems = [...expectAgent(o, 'lead_generation'), ...noRisk(o)];
      if (o.route?.action !== 'question') problems.push(`expected action=question, got ${o.route?.action}`);
      const writes = calledTools(o).filter(t => /^(create_|generate_|update_|delete_|save_|send_|execute_)/.test(t));
      if (writes.length) problems.push(`question turn called write tools: ${writes.join(',')}`);
      return problems;
    },
  },
  {
    id: 'switch_non_english',
    message: 'Busca 30 hoteles boutique en Madrid como clientes potenciales',
    state: () => base(),
    check: (_s, o) => [...expectAgent(o, 'lead_generation'), ...noRisk(o)],
  },
  {
    id: 'switch_question_during_review',
    message: 'Before I approve, what will this search cost me?',
    state: () => base(pendingLeadSearch()),
    check: (_s, o) => {
      const problems = noRisk(o);
      if (o.route?.action === 'continue' || o.route?.leadReviewApproval) problems.push(`a question was treated as approval: ${JSON.stringify(o.route)}`);
      if (!o.pendingApproval) problems.push('the pending search review was lost');
      if (/\bno (?:search settings or )?(?:review|approval) card|\bno (?:(?:review|approval) card or )?search settings|did not create or save/i.test(o.finalText)) problems.push('reply denies the pending search review exists');
      return problems;
    },
  },
  {
    id: 'switch_cancel_review',
    message: 'Cancel that search, I do not want to run it',
    state: () => base(pendingLeadSearch()),
    check: (s, o) => {
      const problems = noRisk(o);
      if (o.route?.action !== 'cancel') problems.push(`expected action=cancel, got ${o.route?.action}`);
      if (s.pendingApproval) problems.push('pending search approval was not cleared after cancel');
      return problems;
    },
  },
  {
    id: 'switch_continue_paused_pipeline',
    message: 'continue',
    state: () => base({
      currentAgent: 'lead_generation', agentPipeline: ['lead_generation', 'content_studio'], agentPipelineIndex: 1,
      pipelineRequest: 'Find boutique hotel leads in Chennai and write the cold email.', leadReviewApproved: true, selectedLeadIds: [11, 12],
      messages: history(['user', 'Find boutique hotel leads in Chennai and write the cold email.'], ['assistant', 'The lead step is done. Alex has not started yet — continue when ready.']),
    }),
    check: (_s, o) => [...expectAgent(o, 'content_studio'), ...noRisk(o)],
  },
  // ── Tool calling ─────────────────────────────────────────────────────
  {
    id: 'tools_lead_settings_review_only',
    message: 'Prepare a lead search for 50 boutique hotels in Chennai, but do not run it yet',
    state: () => base({ currentAgent: 'lead_generation' }),
    check: (_s, o) => {
      const problems = noRisk(o);
      if (calledTools(o).includes('execute_lead_workflow') && !o.pendingApproval) problems.push('search tool was called and not held for review');
      return problems;
    },
  },
  {
    id: 'tools_content_generate',
    message: 'Generate an email template for boutique hotel owners in Chennai about missed night enquiries',
    state: () => base({ currentAgent: 'content_studio' }),
    check: (_s, o) => {
      const problems = noRisk(o);
      if (!calledTools(o).some(t => /generate|template|content/.test(t))) problems.push(`no content tool was called; called ${calledTools(o).join(',') || 'nothing'}`);
      return problems;
    },
  },
  {
    id: 'tools_outreach_send_needs_review',
    message: 'Send our approved email to the shortlisted hotel leads now',
    state: () => base({ currentAgent: 'outreach', leadReviewApproved: true, selectedLeadIds: [11, 12, 13] }),
    check: (_s, o) => noRisk(o),
  },
  {
    id: 'tools_question_read_only',
    message: 'What content have we already created for this campaign?',
    state: () => base({ currentAgent: 'content_studio' }),
    check: (_s, o) => {
      const problems = noRisk(o);
      const writable = [...offeredTools(o)].filter(t => /^(generate_|send_|execute_|publish_|delete_|create_meta|create_google)/.test(t));
      if (o.route?.action === 'question' && writable.length) problems.push(`question turn was offered write tools: ${writable.join(',')}`);
      return problems;
    },
  },
  {
    id: 'tools_advice_no_lookup',
    message: 'What makes a good subject line for a cold email to hotel managers?',
    state: () => base({ currentAgent: 'content_studio' }),
    check: (_s, o) => {
      const problems = noRisk(o);
      if (o.route?.savedDataLookup !== false) problems.push(`plain advice was marked as a saved-data lookup: ${JSON.stringify(o.route)}`);
      if (calledTools(o).length) problems.push(`advice turn called tools: ${calledTools(o).join(',')}`);
      return problems;
    },
  },
];
