/** Live-model, synthetic multi-turn intent canary. Never dispatches agents or
 * tools. Provider calls are billable; local model-usage logs may be persisted.
 * Requires an explicitly selected loopback QA database, user and --execute.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import type { AgentState } from '../mastra/state.js';
import type { RouterOutput } from '../mastra/routerSchema.js';

const arg = (name: string) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

async function main() {
  const userId = Number(arg('--user-id'));
  const database = process.env.DB_NAME;
  if (!process.argv.includes('--execute') || !Number.isSafeInteger(userId) || userId <= 0
    || !database?.startsWith('salesmarketing_live_qa_') || process.env.DB_HOST !== '127.0.0.1') {
    throw new Error('Requires DB_HOST=127.0.0.1, DB_NAME=salesmarketing_live_qa_<suffix>, --user-id <id> and --execute.');
  }
  await import('../env.js');
  // Load only the encryption key needed by the copied provider configuration.
  // Never replace the database boundary or print secret/provider error values.
  const secretsFile = arg('--decryption-env');
  if (secretsFile) {
    const values = parse(readFileSync(secretsFile));
    if (values.CHANNEL_AUTH_ENCRYPTION_KEY) process.env.CHANNEL_AUTH_ENCRYPTION_KEY = values.CHANNEL_AUTH_ENCRYPTION_KEY;
  }
  const { logger } = await import('../utils/logger.js');
  logger.level = 'silent';
  const { pgPool } = await import('../models/db.js');
  assert.ok(pgPool);
  assert.equal((await pgPool.query('select current_database() as name')).rows[0].name, database);
  assert.equal((await pgPool.query('select id from users where id = $1', [userId])).rowCount, 1);
  const { createInitialState } = await import('../mastra/state.js');
  const { runUnifiedRouter } = await import('../mastra/unifiedRouter.js');
  const { getIntentClassifierSelection } = await import('../services/agents/intent/IntentClassifierService.js');
  console.log(JSON.stringify({ database, classifier: await getIntentClassifierSelection(), synthetic: true, agentDispatch: false }));

  const base = (): AgentState => {
    const state = createInitialState(userId, 0);
    state.currentAgent = 'lead_generation';
    state.icpProfile = { businessName: 'Example Retreat', campaignObjective: 'Corporate overnight offsites',
      primaryRegions: ['Chennai'], primaryJobTitles: ['HR Manager', 'People Operations Manager'],
      targetCompanySizeRange: '50–200', primaryChannels: ['linkedin', 'google_maps'],
      revision: 2, approvedRevision: 2, approved: true };
    state.selectedWorkflows = ['linkedin_company_search_employees', 'google_maps'];
    state.messages = [
      { role: 'user', content: 'Plan corporate offsite leads in Chennai for HR and People Operations managers at companies with 50–200 employees. No search or outreach yet.' },
      { role: 'assistant', content: 'The ICP is approved. I recommend LinkedIn Company Employee Extraction and Google Maps Business Search. Choose the strategy to prepare; no search has run.' },
    ];
    return state;
  };
  const results: Array<{ id: string; passed: boolean }> = [];
  const check = async (id: string, state: AgentState, prompt: string, verify: (result: RouterOutput) => void) => {
    state.messages.push({ role: 'user', content: prompt });
    const result = await runUnifiedRouter(state);
    let passed = true;
    try { verify(result); } catch { passed = false; }
    results.push({ id, passed });
    console.log(JSON.stringify({ id, passed, prompt, decision: {
      action: result.action, agent: result.nextAgent, hiredAgents: result.hiredAgents,
      needsClarification: result.needsClarification, leadSettingsRequested: result.leadSettingsRequested,
      channels: result.leadChannels, semantic: result.semanticRequest, response: result.response,
    } }));
    return result;
  };
  const state = base();
  const first = await check('narrow_strategy', state,
    'Use only LinkedIn Company Employee Extraction, not Google Maps. Prepare its search settings for Chennai companies with 50–200 employees and HR or People Operations managers. Cap the saved results at 5. Show the review card only; do not run the search.', result => {
      assert.equal(result.needsClarification, false);
      assert.equal(result.nextAgent, 'lead_generation');
      assert.equal(result.leadSettingsRequested, true);
      assert.deepEqual(result.semanticRequest?.lead.strategySelection, { status: 'selected', workflowIds: ['linkedin_company_search_employees'] });
      assert.equal(result.semanticRequest?.lead.limit, 5);
    });
  // Simulate the persisted review context, not actual tool execution.
  state.selectedWorkflows = ['linkedin_company_search_employees'];
  state.messages.push({ role: 'assistant', content: first.response },
    { role: 'assistant', content: 'Synthetic fixture: LinkedIn-only search settings are now awaiting review. No search has run.' });
  await check('revise_settings', state, 'Make that 3 results instead and change Chennai to Hyderabad. Keep the same strategy; still do not search.', result => {
    assert.equal(result.nextAgent, 'lead_generation'); assert.equal(result.leadSettingsRequested, true);
    assert.equal(result.semanticRequest?.lead.limit, 3); assert.equal(result.semanticRequest?.lead.location, 'Hyderabad');
    assert.notEqual(result.action, 'approve');
  });
  await check('explain_not_execute', base(), 'Why did you recommend those two strategies? Do not prepare settings or search.', result => {
    assert.equal(result.action, 'question'); assert.equal(result.leadSettingsRequested, false);
    assert.notEqual(result.semanticRequest?.lead.strategySelection?.status, 'selected');
  });
  await check('outreach_switch', base(), 'Leave the lead search unstarted. Switch to Emily: for leads already selected in this campaign, prepare email and WhatsApp outreach reviews. Do not borrow leads from other campaigns or send anything.', result => {
    assert.equal(result.needsClarification, false); assert.equal(result.nextAgent, 'outreach');
    assert.equal(result.leadSettingsRequested, false);
  });
  const emptyRecipients = base();
  emptyRecipients.currentAgent = 'outreach';
  emptyRecipients.selectedLeadIds = [];
  emptyRecipients.messages.push({ role: 'assistant', content: 'There are leads in the account, but none are linked to this conversation. Select existing leads, upload CSV, or generate new leads.' });
  await check('outreach_readiness_not_receipts', emptyRecipients, 'Keep the recipient selection empty. Do not select or import any account leads. For this campaign only, can we currently send email or WhatsApp, and what exact prerequisite is missing? Answer only; do not prepare or send anything.', result => {
    assert.equal(result.needsClarification, false); assert.equal(result.action, 'question');
    assert.equal(result.semanticRequest?.status, 'none'); assert.equal(result.nextAgent, 'outreach');
    assert.equal(result.semanticRequest?.scope, 'current_campaign'); assert.equal(result.leadSettingsRequested, false);
  });
  const pendingSearch = base();
  pendingSearch.requiresApproval = true;
  pendingSearch.pendingApproval = { toolName: 'execute_lead_workflow', args: {}, executionId: 'synthetic-pending-search', message: 'Review search settings' };
  pendingSearch.selectedLeadIds = [];
  pendingSearch.messages.push({ role: 'assistant', content: 'LinkedIn search settings for Hyderabad, capped at 3, await approval. No search has run.' });
  await check('readiness_side_question_preserves_pending_search', pendingSearch,
    'Leave the search review unapproved and keep recipients empty. Emily, for this campaign only, can we currently send email or WhatsApp, and what exact prerequisite is missing? Answer only. Do not select or import account leads, prepare a send review, run the search, or send anything.', result => {
      assert.equal(result.action, 'question'); assert.equal(result.nextAgent, 'outreach');
      assert.equal(result.leadSettingsRequested, false); assert.equal(result.needsClarification, false);
    });
  await check('social_draft', base(), 'Leave the search alone. Alex, draft a LinkedIn post for our corporate retreats. Friendly and concise; no publishing or scheduling yet.', result => {
    assert.equal(result.nextAgent, 'content_studio'); assert.equal(result.leadSettingsRequested, false);
  });
  const schedule = base();
  schedule.currentAgent = 'content_studio';
  schedule.messages.push({ role: 'assistant', content: 'Synthetic fixture: the reviewed LinkedIn text post was generated and saved as draft asset #274. No publication was prepared or run.' });
  await check('new_schedule_review_not_saved_asset_lookup', schedule, 'For the saved LinkedIn post asset #274, prepare a scheduling review for 25 September 2026 at 10:00 AM Asia/Kolkata. Keep the saved text unchanged. Show the exact account, date, time and timezone for review, and tell me if any connection or approval is missing. Do not create a scheduled delivery job, publish, or approve the review.', result => {
    assert.equal(result.nextAgent, 'content_studio'); assert.equal(result.needsClarification, false);
    assert.equal(result.semanticRequest?.contentOperation, 'publish_new');
    assert.notEqual(result.action, 'question'); assert.equal(result.contentManagementRequested, false);
  });
  await check('paid_campaign_review', base(), 'Switch to Sarah. Draft a Meta lead ad for our corporate retreats with a daily budget of INR 500. Show the audience and budget for review only. Do not publish or spend.', result => {
    assert.equal(result.nextAgent, 'performance_marketing'); assert.equal(result.leadSettingsRequested, false);
  });
  await check('campaign_status', base(), 'Which actions are still awaiting my review, and have any messages actually been sent? Do not execute anything.', result => {
    assert.equal(result.action, 'question'); assert.equal(result.semanticRequest?.status, 'campaign_actions');
    assert.equal(result.leadSettingsRequested, false);
  });
  console.log(JSON.stringify({ passed: results.filter(result => result.passed).length, total: results.length, agentDispatch: false }));
  await pgPool.end();
  process.exit(results.every(result => result.passed) ? 0 : 2);
}
main().catch(() => { console.error('Synthetic intent canary unavailable; no secret/provider error details printed.'); process.exit(1); });
