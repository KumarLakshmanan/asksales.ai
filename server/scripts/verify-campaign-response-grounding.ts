/** Synthetic response-grounding canary. No specialist dispatch, tools, campaign
 * writes or provider mutations. Model calls are billable and locally logged. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'dotenv';
import type { AgentState } from '../mastra/state.js';
import type { ToolCallResult } from '../mastra/utils/toolCallingLoop.js';

const arg = (name: string) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
async function main() {
  const userId = Number(arg('--user-id'));
  const database = process.env.DB_NAME;
  assert.ok(process.argv.includes('--execute') && Number.isSafeInteger(userId) && userId > 0
    && database?.startsWith('salesmarketing_live_qa_') && process.env.DB_HOST === '127.0.0.1');
  await import('../env.js');
  const secretsFile = arg('--decryption-env');
  if (secretsFile) {
    const values = parse(readFileSync(secretsFile));
    if (values.CHANNEL_AUTH_ENCRYPTION_KEY) process.env.CHANNEL_AUTH_ENCRYPTION_KEY = values.CHANNEL_AUTH_ENCRYPTION_KEY;
  }
  const { logger } = await import('../utils/logger.js'); logger.level = 'silent';
  const { pgPool } = await import('../models/db.js'); assert.ok(pgPool);
  assert.equal((await pgPool.query('select current_database() as name')).rows[0].name, database);
  assert.equal((await pgPool.query('select id from users where id = $1', [userId])).rowCount, 1);
  const { groundAgentResponse } = await import('../mastra/utils/responseGrounding.js');
  const state = { userId, threadId: 0, messages: [] } as unknown as AgentState;
  const receipt = (toolName: string, output: unknown): ToolCallResult => ({ toolName, toolCallId: 'synthetic', success: true, result: { success: true, output } });
  const cases = [
    { id: 'unsaved_budget_plan', draft: 'Unsaved plan only: INR 300 daily budget, targeting HR and People Operations managers in Chennai. A suitable saved Meta creative is needed before an executable campaign review can be prepared. I have not changed any saved settings or created a review in this turn.', results: [] },
    { id: 'empty_creative_prerequisite', draft: 'No matching saved creatives were returned by this lookup. A suitable saved creative is needed before preparing its campaign review. No review was created in this turn.', results: [receipt('query_content_assets', { assets: [] })] },
    { id: 'disconnected_linkedin', draft: 'LinkedIn is not connected. Connect it in Settings → Integrations before publishing through this platform. No scheduling review was created in this turn.', results: [receipt('check_integration_status', { platform: 'linkedin', connected: false })] },
    { id: 'empty_campaign_analytics', draft: 'No saved paid campaigns were returned for this conversation. Performance measurements are unavailable; this does not establish zero spend or prove that no historical activity occurred.', results: [receipt('analytics_query', { queryType: 'campaign', scope: 'current_campaign', threadId: 210, data: [] })] },
  ];
  let preserved = 0;
  for (const test of cases) {
    const started = Date.now();
    const response = await groundAgentResponse(state, test.draft, test.results);
    const passed = response === test.draft;
    if (passed) preserved++;
    console.log(JSON.stringify({ id: test.id, preserved: passed, elapsedMs: Date.now() - started, response }));
  }
  console.log(JSON.stringify({ preserved, total: cases.length, agentDispatch: false }));
  await pgPool.end(); process.exit(preserved === cases.length ? 0 : 2);
}
main().catch(() => { console.error('Synthetic grounding canary unavailable; no secret/provider error details printed.'); process.exit(1); });
