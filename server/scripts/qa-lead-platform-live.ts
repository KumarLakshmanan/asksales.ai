/** Explicit opt-in live smoke test. Uses real providers and saves at most 3 leads.
 * Run: pnpm --dir server exec tsx scripts/qa-lead-platform-live.ts <platform> --execute
 * No outreach is performed. Reusing the same run key reuses its durable receipt.
 */
import '../env.js';
import { readFile } from 'node:fs/promises';
import { eq, sql } from 'drizzle-orm';
import { db } from '../models/db.js';
import { createChatThread } from '../models/chatThreads/functions.js';
import { createChatMessage } from '../models/chatMessages/functions.js';
import { createLeadInput } from '../models/leadInputs/functions.js';
import { leadInputsTable } from '../models/leadInputs/schema.js';
import { getExecutionById, updateWorkflowExecution } from '../models/workflowLogs/functions.js';
import { createIcpData } from '../models/icpData/functions.js';
import { icpProfilesTable } from '../models/icpData/schema.js';
import { getLeadGenerationProviderRunsByExecution } from '../models/leadGenerationProviderRuns/functions.js';
import { leadsTable } from '../models/leads/schema.js';
import { WorkflowExecutorService } from '../services/WorkflowExecutorService.js';
import { readLeadSaveReceipt } from '../mastra/utils/leadSaveReceipt.js';

const cases: Record<string, { workflow: string; base?: string; cap?: number; inputs: Record<string, unknown> }> = {
  facebook: { workflow: 'facebook_post_authors', inputs: { query: 'software company Bangalore', maxResults: 3, recent_posts: true } },
  twitter: { workflow: 'twitter_post_authors', inputs: { query: '(software OR "IT services") (Bangalore OR Bengaluru) -filter:retweets', maxResults: 15, searchType: 'Top' } },
  instagram: { workflow: 'instagram_post_authors', inputs: { hashtags: ['bangaloresoftwarecompany'], resultsLimit: 3, resultsType: 'posts', keywordSearch: false } },
  google_maps: { workflow: 'google_maps', inputs: { searchStringsArray: ['software company'], locationQuery: 'Bengaluru, Karnataka, India', maxCrawledPlacesPerSearch: 3 } },
  justdial: { workflow: 'justdial', inputs: { city: 'Bangalore', search: 'Software Companies', maxItems: 3 } },
  linkedin: { workflow: 'linkedin_company_search', inputs: { searchQuery: 'software', locations: ['Bengaluru, Karnataka, India'], maxItems: 3, scraperMode: 'full', startPage: 1 } },
  facebook_more: { base: 'facebook', cap: 2, workflow: 'facebook_post_authors', inputs: { query: '"web development" "Bangalore"', maxResults: 10, recent_posts: true } },
  instagram_more: { base: 'instagram', cap: 2, workflow: 'instagram_post_authors', inputs: { hashtags: ['webdevelopmentbangalore'], resultsLimit: 2, resultsType: 'posts', keywordSearch: false } },
  // Category URL verified against the live public JustDial page, not inferred.
  justdial_url: { base: 'justdial', workflow: 'justdial', inputs: { startUrls: ['https://www.justdial.com/Bangalore/Computer-Software-Development-Companies/nct-10801033'], maxItems: 3 } },
  twitter_fixed: { base: 'twitter', workflow: 'twitter_post_authors', inputs: { query: '"software development" (Bangalore OR Bengaluru) -filter:retweets', maxResults: 15, searchType: 'Top' } },
  twitter_profiles: { base: 'twitter', workflow: 'twitter_competitor_users', inputs: { searchTerms: ['software Bangalore'], maxItems: 3 } },
  twitter_replacement: { base: 'twitter', cap: 1, workflow: 'twitter_competitor_users', inputs: { searchTerms: ['Zinavo'], maxItems: 1 } },
};

async function main() {
  const platform = process.argv[2];
  const test = cases[platform];
  if (!test || !process.argv.includes('--execute')) throw new Error(`Choose ${Object.keys(cases).join(', ')} and pass --execute to authorize a live test.`);
  const executionId = `qa-six-platform-20260922-${platform}-v1`;
  await WorkflowExecutorService.initialize();
  const workflow = JSON.parse(await readFile(new URL(`../data/workflows/${test.workflow}.json`, import.meta.url), 'utf8'));
  const existing = await getExecutionById(executionId);
  if (existing) {
    const priorRuns = await getLeadGenerationProviderRunsByExecution(executionId);
    if (priorRuns.some(run => run.status === 'cancelled' || run.status === 'failed')) {
      throw new Error('This QA case has a failed/cancelled provider receipt. Do not replay its dataset as leads; use a separately reviewed replacement case.');
    }
  }
  const baseExecution = test.base ? await getExecutionById(`qa-six-platform-20260922-${test.base}-v1`) : undefined;
  let threadId = existing?.threadId || baseExecution?.threadId;
  let inputParams: Record<string, unknown> | undefined;
  if (threadId && existing) {
    // Execution logs are redacted diagnostics, not replayable actor inputs.
    const [review] = await db.select().from(leadInputsTable).where(eq(leadInputsTable.id, Number(existing.inputParams?.__leadInputId)));
    if (!review) throw new Error('Existing QA execution has no saved input snapshot.');
    inputParams = { ...(review.inputs as Record<string, unknown>), __leadInputId: review.id, __requestedLeadLimit: test.cap || 3, __leadReviewConstraints: { regions: ['Bengaluru'], industry: 'software IT technology' } };
  }
  if (!existing) {
    if (!threadId) threadId = (await createChatThread(1, `QA Sep 22 · ${platform} · Bengaluru software · max 3`)).id;
    const message = await createChatMessage({ userId: 1, threadId, role: 'assistant', agentType: 'lead_generation', content: 'User-authorized live QA: discover up to 3 software/IT businesses in Bengaluru. This is a direct production-workflow smoke test, not an LLM routing test. No outreach will be sent.' });
    const first = workflow.nodes.find((node: {type: string}) => node.type === 'actor');
    const inputs = { ...test.inputs, ...first.data.finalValues };
    const review = await createLeadInput({ userId: 1, threadId, messageId: message.id, platform: workflow.platform, workflowId: workflow.workflow_id, actorId: first.data.actorId, actorName: first.data.actorName, inputs, schema: { requestedLeadTotal: test.cap || 3, qa: true } });
    inputParams = { ...inputs, __leadInputId: review.id, __requestedLeadLimit: test.cap || 3, __leadReviewConstraints: { regions: ['Bengaluru'], industry: 'software IT technology' } };
  }
  console.log('QA_START', JSON.stringify({ platform, executionId, threadId }));
  let [icp] = await db.select().from(icpProfilesTable).where(eq(icpProfilesTable.threadId, threadId!));
  if (!icp) icp = await createIcpData({ userId: 1, threadId: threadId!, campaignName: `QA Sep 22 ${platform} — Bengaluru software`, campaignObjective: 'Bounded live provider QA only; no outreach', targetAudience: 'Software and IT businesses', industry: 'Software / IT', primaryRegions: ['Bengaluru'], primaryChannels: [platform], approved: false });
  await db.update(leadsTable).set({ promptId: icp.id }).where(sql`${leadsTable.userId} = 1 AND ${leadsTable.campaignData}->>'threadId' = ${String(threadId)} AND ${leadsTable.promptId} IS NULL`);
  if (process.argv.includes('--replay') && existing?.status === 'completed') {
    // Reconcile this QA execution from its immutable provider datasets.
    await updateWorkflowExecution(executionId, { status: 'running' });
  }
  let result;
  try {
    result = await WorkflowExecutorService.executeWorkflow(workflow, inputParams!, '1', threadId!, executionId, icp.id);
  } catch (error) {
    result = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  const runs = await getLeadGenerationProviderRunsByExecution(executionId);
  const receipt = 'results' in result ? readLeadSaveReceipt(result.results.db_save_results, result.status) : { leadIds: [], leadsCount: 0 };
  const leads = await Promise.all(receipt.leadIds.map(async id => {
    const [lead] = await db.select().from(leadsTable).where(eq(leadsTable.id, id));
    return { id, name: lead.fullName || lead.name || lead.companyName, source: lead.source, profileUrl: lead.profileUrl, website: lead.website, location: lead.location, bio: lead.bio, industry: lead.industry, email: lead.email, phone: lead.phone };
  }));
  const summary = { platform, executionId, threadId, status: result.status, error: 'error' in result ? result.error : undefined, receipt, leads, runs: runs.map(r => ({ id: r.id, actorId: r.actorId, actorRunId: r.actorRunId, datasetId: r.datasetId, status: r.status, fetched: r.fetchedCount, accepted: r.acceptedCount, persisted: r.persistedCount, duplicates: r.duplicateCount, rejected: r.rejectedCount, error: r.error })) };
  await createChatMessage({ userId: 1, threadId: threadId!, role: 'assistant', agentType: 'lead_generation', content: `Live workflow QA: ${result.status}. Saved lead IDs: ${receipt.leadIds.join(', ') || 'none'}. Target: Bengaluru software/IT businesses. Leads still require manual relevance verification. No outreach sent.`, metadata: { qaResult: summary } });
  console.log('QA_RESULT', JSON.stringify(summary));
  process.exit(result.status === 'failed' ? 1 : 0);
}

main().catch(error => { console.error('QA_ERROR', error.message); process.exit(1); });
