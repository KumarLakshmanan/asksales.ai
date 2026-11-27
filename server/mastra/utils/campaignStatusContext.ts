/**
 * Where the campaign really stands, for the Coordinator's status answers.
 *
 * The router otherwise only sees chat history and the agent snapshot, so it
 * could say "ready for outreach" while the lead search had failed, or ask for
 * an imported audience when leads were already selected.
 */
import type { ActionButton } from '../state.js';
import { leadSearchFailureMessage } from '../../services/leadSearchFailureMessage.js';
import { logger } from '../../utils/logger.js';

export interface CampaignRunSnapshot {
  stage: string;
  status: string;
  context?: Record<string, unknown> | null;
}

const STAGE_SUMMARY: Record<string, string> = {
  icp_draft: 'The ideal customer profile is being drafted.',
  icp_awaiting_approval: 'The ideal customer profile is waiting for the user to approve it.',
  agent_selection: 'The profile is approved; the next step is choosing which agents to hire.',
  agent_running: 'A specialist agent is working on the campaign.',
  lead_strategy_awaiting_approval: 'A lead search strategy is waiting for the user to choose it.',
  lead_inputs_generating: 'Search settings for the lead search are being prepared.',
  lead_inputs_awaiting_approval: 'Search settings are ready and waiting for the user to approve the search.',
  lead_executing: 'The lead search is running.',
  leads_awaiting_review: 'Leads were found and are waiting for the user to review them.',
  outreach_ready: 'Leads are chosen; the next step is preparing outreach.',
  outreach_awaiting_approval: 'An outreach review is waiting for the user to confirm it.',
  outreach_running: 'Outreach messages are being sent.',
  content_awaiting_review: 'Generated content is waiting for the user to review it.',
  ad_draft: 'An ad is being drafted.',
  ad_awaiting_approval: 'An ad review is waiting for the user to confirm it.',
  ad_publishing: 'An ad is being published.',
  completed: 'The campaign steps are finished.',
};

/** Next-step buttons by campaign step. They only open a tab; they never run anything. */
const STAGE_BUTTONS: Record<string, Array<{ label: string; tabType: string }>> = {
  icp_awaiting_approval: [{ label: 'Review the profile', tabType: 'icp' }],
  agent_selection: [{ label: 'Choose agents', tabType: 'agentchoose' }],
  lead_inputs_awaiting_approval: [{ label: 'Review search settings', tabType: 'leadInputs' }],
  leads_awaiting_review: [{ label: 'Review leads', tabType: 'leads' }],
  outreach_ready: [{ label: 'Prepare outreach', tabType: 'outreach' }],
  needs_attention: [{ label: 'Open leads', tabType: 'leads' }],
};

function leadSearchProblem(run: CampaignRunSnapshot): string | null {
  const raw = run.context?.leadGenerationError;
  if (run.stage !== 'needs_attention' || typeof raw !== 'string' || !raw.trim()) return null;
  return leadSearchFailureMessage(raw);
}

export function describeCampaignStatus(run: CampaignRunSnapshot | null | undefined, selectedLeadCount = 0): string {
  const lines: string[] = [];
  if (run) {
    const problem = leadSearchProblem(run);
    if (problem) lines.push(`Needs attention: ${problem}`);
    else if (run.stage === 'needs_attention') lines.push('Needs attention: the last campaign step did not finish.');
    else if (STAGE_SUMMARY[run.stage]) lines.push(`Current step: ${STAGE_SUMMARY[run.stage]}`);
  }
  if (selectedLeadCount > 0) {
    lines.push(`The user already selected ${selectedLeadCount} existing ${selectedLeadCount === 1 ? 'lead' : 'leads'} for this campaign; do not ask them to import or upload an audience.`);
  }
  if (!lines.length) return '';
  return [
    'CAMPAIGN STATUS (from saved records):',
    ...lines.map(line => `- ${line}`),
    '- When the user asks where the campaign stands or what to do next, answer from these facts: say what is done, what failed or is blocked and why in plain words, what is waiting on the user, and the one next step.',
  ].join('\n');
}

export function campaignNextStepButtons(run: CampaignRunSnapshot | null | undefined): ActionButton[] {
  if (!run) return [];
  return (STAGE_BUTTONS[run.stage] || []).map(({ label, tabType }) => ({
    id: `next_step_${tabType}`,
    label,
    action: 'OPEN_TAB',
    type: 'secondary',
    data: { tabType },
  }));
}

export async function loadCampaignRun(userId: number, threadId: number): Promise<CampaignRunSnapshot | null> {
  if (!userId || !threadId) return null;
  try {
    const { getLatestConversationWorkflowRun } = await import('../../models/conversationWorkflow/functions.js');
    const run = await getLatestConversationWorkflowRun(userId, threadId);
    return run ? { stage: run.stage, status: run.status, context: run.context } : null;
  } catch (err) {
    logger.warn({ err, threadId }, '[campaignStatus] Could not load the campaign step');
    return null;
  }
}
