/** Synthetic, classification-only live canary. Never dispatches tools, creates
 * campaigns/bookings, sends messages, or publishes. Requires --execute because
 * calls consume provider credits. Uses existing settings and admin credentials. */
import '../env.js';
import assert from 'node:assert/strict';
import { createInitialState } from '../mastra/state.js';
import { runUnifiedRouter } from '../mastra/unifiedRouter.js';
import { NLUService } from '../services/agents/NLUService.js';
import { getIntentClassifierSelection } from '../services/agents/intent/IntentClassifierService.js';

async function main() {
  const userId = Number(process.argv[process.argv.indexOf('--user-id') + 1]);
  if (!process.argv.includes('--execute') || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('Usage: pnpm exec tsx scripts/verify-intent-classifier.ts --user-id <local user ID> --execute');
  }
  const selection = await getIntentClassifierSelection();
  console.log(JSON.stringify({ classifierProvider: selection?.provider ?? null, classifierModel: selection?.model ?? null, externalActions: false }));
  const results: Array<{ id: string; passed: boolean; result?: unknown; error?: string }> = [];
  const check = async (id: string, run: () => Promise<unknown>) => {
    try { const result = await run(); results.push({ id, passed: true, result }); }
    catch (error) { results.push({ id, passed: false, error: error instanceof assert.AssertionError ? error.message : 'Classification unavailable' }); }
    console.log(JSON.stringify(results.at(-1)));
  };
  const campaigns: Array<[string, string, string, string[]]> = [
    ['campaign_copy', 'We have selected leads for later outreach.', 'For now, only write a reusable email template. Do not prepare outreach.', ['content_studio']],
    ['campaign_outreach', 'The existing selected leads are ready.', 'Prepare an email sequence for those selected leads, with subject and body. Do not send anything.', ['outreach']],
    ['campaign_compound', 'Which work do you want?', 'Find leads and then write a social post. No outreach and no paid ads.', ['lead_generation', 'content_studio']],
    ['campaign_paid_analytics', 'We are discussing paid Meta campaigns.', 'Show the performance analytics of my existing paid campaigns.', ['performance_marketing']],
  ];
  for (const [id, previous, latest, agents] of campaigns) await check(id, async () => {
    const state = createInitialState(userId, 0);
    state.messages = [{ role: 'assistant', content: previous }, { role: 'user', content: latest }];
    const result = await runUnifiedRouter(state);
    assert.deepEqual(result.hiredAgents, agents);
    assert.equal(result.needsClarification, false);
    assert.equal(result.intent, 'task');
    assert.equal(state.pendingApproval, null);
    return { agents: result.hiredAgents, action: result.action, contentOperation: result.semanticRequest?.contentOperation, outreachOperation: result.semanticRequest?.outreachOperation };
  });
  await check('campaign_status', async () => {
    const state = createInitialState(userId, 0);
    state.messages = [{ role: 'assistant', content: 'Your reviews remain pending.' }, { role: 'user', content: 'What is still waiting on me? Do not run anything.' }];
    const result = await runUnifiedRouter(state);
    assert.equal(result.semanticRequest?.status, 'campaign_actions');
    assert.equal(result.action, 'question');
    assert.deepEqual(result.hiredAgents, []);
    return { action: result.action, status: result.semanticRequest?.status };
  });
  const nlu = new NLUService();
  const support: Array<[string, string, string, string, string]> = [
    ['support_topic_switch', 'Agent: How many nights for the corporate event?', 'Actually I would like to book a spa appointment instead.', 'booking', 'spa'],
    ['support_slot_continue', 'Customer: Book a spa appointment.\nAgent: What date and time?', '24 September 2026 at 4 PM', 'continue', 'spa'],
    ['support_brochure', 'Agent: Shall we start the corporate booking?', 'No booking. Please share the existing corporate brochure and one-day pricing.', 'document', 'corporate'],
    ['support_tamil', 'Agent: How can we help?', 'மசாஜ் செய்ய நேரம் ஒதுக்க முடியுமா?', 'booking', 'spa'],
    ['support_human', 'Agent: Which date for the spa?', 'Please connect me to a person instead.', 'human', 'spa'],
  ];
  for (const [id, history, latest, action, service] of support) await check(id, async () => {
    const result = await nlu.analyze(userId, latest, history);
    assert.equal(result.semanticRequest?.action, action);
    if (action !== 'human') assert.equal(result.semanticRequest?.service, service);
    if (action === 'human') assert.equal(result.needsHuman, true);
    if (action === 'continue') assert.ok(result.entities['service.dateTime']);
    return { intent: result.intent, semanticRequest: result.semanticRequest, needsHuman: result.needsHuman, entities: result.entities };
  });
  console.log(JSON.stringify({ passed: results.filter(r => r.passed).length, total: results.length }));
  process.exit(results.every(r => r.passed) ? 0 : 2);
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Canary unavailable'); process.exit(1); });
