/** Billable synthetic classification only. No campaigns, lead imports, sends,
 * publications, opt-out mutations, bookings, or CRM transitions are executed. */
import '../env.js';
import assert from 'node:assert/strict';
import { ICPGenerationService } from '../services/ICPGenerationService.js';
import { sentimentAnalysisService } from '../services/SentimentAnalysisService.js';
import { NLUService } from '../services/agents/NLUService.js';
import { rerankKnowledgeCandidates } from '../services/knowledge/KnowledgeReranker.js';
import { classifyJevLeadSemanticsBatch } from '../services/lead-generation/JevLeadSemanticService.js';

async function main() {
  const index = process.argv.indexOf('--user-id');
  const userId = index >= 0 ? Number(process.argv[index + 1]) : NaN;
  if (!process.argv.includes('--execute') || !Number.isSafeInteger(userId) || userId <= 0) {
    throw new Error('Usage: pnpm exec tsx scripts/verify-intent-extensions.ts --user-id <test-user-id> --execute');
  }
  let passed = 0;
  let total = 0;
  const check = async (id: string, run: () => Promise<void>) => {
    total++;
    try { await run(); passed++; console.log(JSON.stringify({ id, passed: true })); }
    catch (error) { console.log(JSON.stringify({ id, passed: false, reason: error instanceof assert.AssertionError ? error.message : 'Classification unavailable' })); }
  };
  const icp = new ICPGenerationService();
  await check('icp_copy_no_send', async () => {
    assert.equal(await icp.detectUserIntent('Only write a reusable email template, no recipient campaign.', [
      { role: 'assistant', content: 'The leads are ready for outreach.' },
    ], userId), 'content_creation');
  });
  await check('icp_paid_analytics', async () => {
    assert.equal(await icp.detectUserIntent('Show the performance of my existing paid Meta campaigns.', [], userId), 'performance_marketing');
  });
  await check('sentiment_frustrated', async () => {
    const result = await sentimentAnalysisService.analyzeSentiment(userId, 'Wonderful, my THIRD request has been ignored. I am extremely frustrated and angry about this repeated failure.');
    assert.equal(result.sentiment, 'negative'); assert.ok(result.score < -0.5);
  });
  await check('sentiment_not_a_sale', async () => {
    const result = await sentimentAnalysisService.analyzeSentiment(userId, 'Thank you, that was helpful!');
    assert.equal(result.sentiment, 'positive');
    assert.equal(sentimentAnalysisService.mapSentimentToStatus(result.sentiment, 'demo'), 'demo');
  });
  const nlu = new NLUService();
  await check('english_opt_out', async () => {
    const result = await nlu.analyze(userId, 'Please leave me alone and never send me another message.', 'Agent: Would you like another offer?');
    assert.equal(result.contactPreference, 'opt_out'); assert.equal(result.contactPreferenceVerified, true);
  });
  await check('tamil_opt_out', async () => {
    const result = await nlu.analyze(userId, 'இனிமேல் எனக்கு எந்த செய்தியும் அனுப்ப வேண்டாம். என்னை தொடர்பு கொள்ள வேண்டாம்.', 'Agent: Can we send you updates?');
    assert.equal(result.contactPreference, 'opt_out'); assert.equal(result.contactPreferenceVerified, true);
  });
  await check('booking_cancellation_not_opt_out', async () => {
    const result = await nlu.analyze(userId, 'Cancel my spa booking, but please keep sending me updates.', 'Agent: Your spa appointment is pending.');
    assert.notEqual(result.contactPreference, 'opt_out');
  });
  await check('quoted_opt_out_not_withdrawal', async () => {
    const result = await nlu.analyze(userId, 'Your help page says "stop contacting me". What does that phrase mean? I am not asking to unsubscribe.');
    assert.notEqual(result.contactPreference, 'opt_out');
  });
  await check('knowledge_relevance', async () => {
    const result = await rerankKnowledgeCandidates({ tenantId: userId, purpose: 'support_answer', channel: 'web', audience: 'customer',
      redactedText: 'How can I reset my Acme device?', risk: 'high' }, [
      { evidenceId: 'synthetic-unrelated', title: 'Office parking', excerpt: 'Parking is available in the east lot.', authority: 'owner_authored', fusedScore: 0.9 },
      { evidenceId: 'synthetic-direct', title: 'Acme reset', excerpt: 'To reset the Acme device, hold its reset button for ten seconds.', authority: 'official_product', fusedScore: 0.7 },
    ]);
    assert.equal(result.candidates[0].evidenceId, 'synthetic-direct');
    assert.equal(result.candidates.length, 2);
  });
  await check('lead_semantic_conflict', async () => {
    const result = await classifyJevLeadSemanticsBatch(userId, [
      { name: 'Example Hotel Training School', description: 'We are a hotel management training college. We are not a hotel or resort and offer no accommodation.' },
    ], { industry: 'Hotels', targetAudience: 'Hotel properties offering guest accommodation, not schools or consultants.' });
    assert.equal(result.get(0)?.industry, 'conflict');
  });
  console.log(JSON.stringify({ passed, total, externalActions: false }));
  process.exit(passed === total ? 0 : 2);
}
main().catch(() => { console.error('Classification-only canary failed; no secret/provider error details printed.'); process.exit(1); });
