/** Model/retrieval-only regression probe. No channel delivery or journey writes. */
import { sql } from 'drizzle-orm';
import { db, pgPool } from '../models/db.js';
import { knowledgeGateway } from '../services/knowledge/KnowledgeGateway.js';
import { recoverExtractiveKnowledgeAnswer } from '../services/knowledge/KnowledgeExtractiveAnswer.js';
import type { KnowledgeQuery } from '../services/knowledge/types.js';

async function main() {
  const row = (await db.execute(sql`SELECT system_prompt FROM ai_agent_configs
    WHERE user_id=9 AND id=6 AND agent_type='hotel_sales' AND enabled=true`)).rows[0];
  if (!row || !String(row.system_prompt).includes('breakfast-hours entry')) throw new Error('Expected Oro guidance is not active.');
  for (const [question, expected] of [
    ['What time does breakfast start and finish?', 'uncertainty'],
    ['What are the check-in and check-out times?', 'answer'],
  ] as const) {
    const query: KnowledgeQuery = { tenantId: 9, purpose: 'hotel_policy', channel: 'web',
      audience: 'customer', risk: 'low', intent: 'faq', redactedText: question };
    const retrieval = await knowledgeGateway.retrieve(query);
    const answer = await recoverExtractiveKnowledgeAnswer({ query, retrieval,
      answerRestrictions: [String(row.system_prompt), 'Answer only the customer’s direct question from authorized published knowledge.'] });
    const passed = expected === 'uncertainty' ? answer === null
      : Boolean(answer?.verification.mayDeliver && /2:00\s*PM/i.test(answer.replyText) && /11:00\s*AM/i.test(answer.replyText));
    console.log(JSON.stringify({ question, expected, retrieval: retrieval.status, passed,
      reply: answer?.replyText || null, verification: answer?.verification.reason || null }));
    if (!passed) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; })
  .finally(async () => {
    await pgPool?.end();
    // This one-shot probe must not stay alive on shared provider-cache timers.
    process.exit(process.exitCode || 0);
  });
