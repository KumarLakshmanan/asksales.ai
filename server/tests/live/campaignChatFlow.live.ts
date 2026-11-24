/**
 * Multi-turn live-model run of the campaign chat. Each turn mirrors the chat
 * controller (router first, saved clarifications, status answered from saved
 * cards, natural-language strategy selection) and carries the state to the
 * next turn, so the lead -> outreach handoff is exercised end to end.
 *
 * Based on campaignChatLive.live.ts: real router, orchestrator, specialist
 * prompts, tool schemas and tool loop, against a real provider. The database is
 * the jest stub from models/db.ts (every query returns no rows), so saved data
 * is always empty. Nothing is sent, published or charged; provider calls are
 * billable on the key in server/.env.development.
 *
 * Not part of the default suite. Run with:
 *   NODE_OPTIONS=--experimental-vm-modules npx jest --testMatch '**' + '/tests/live/campaignChatFlow.live.ts' --runInBand
 * Key: LIVE_CREDENTIAL_FILE (JSON {platform, model, apiKey}), else LIVE_API_KEY,
 * else the platform's key in server/.env.development.
 * Optional: FLOWS=fresh,lead_to_outreach  LIVE_PLATFORM=openai|openrouter|gemini  LIVE_MODEL=<model>  LIVE_OUT=<dir>
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from 'dotenv';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.setTimeout(240_000);

// Database stub. Selects return fixture rows for a few tables (the business
// and brand Alex needs) and no rows otherwise; inserts return the saved row
// with a new id so ICP saves and review cards can be created; raw `execute`
// returns no rows.
const businessFixture = () => ({ id: 101, userId: 7, companyName: 'StayDesk', businessName: 'StayDesk', name: 'StayDesk',
  industry: 'Software', description: 'Guest messaging software that answers hotel guest enquiries on WhatsApp and the website, day and night.',
  targetMarket: 'Boutique hotels in Chennai', website: 'https://staydesk.example', isApproved: true, isDefault: true, version: 1,
  createdAt: new Date('2026-11-01T00:00:00Z'), updatedAt: new Date('2026-11-01T00:00:00Z') });
const brandFixture = () => ({ id: 5, userId: 7, businessProfileId: 101, name: 'StayDesk brand', isDefault: true, isActive: true, isApproved: true,
  version: 1, tone: 'Warm, plain and practical', primaryColor: '#0F766E', secondaryColor: '#F59E0B',
  createdAt: new Date('2026-11-01T00:00:00Z'), updatedAt: new Date('2026-11-01T00:00:00Z') });
const selectFixtures: Record<string, () => Record<string, unknown>[]> = {
  company_settings: () => [businessFixture()],
  brand_toolkits: () => [brandFixture()],
};
const rowsResult = (rows: Record<string, unknown>[]) => Object.assign([...rows], { rows, rowCount: rows.length });
const tableName = (table: any): string => table?.[Symbol.for('drizzle:Name')] || '';
let nextId = 5000;
type QueryContext = { op: string; table?: string; values?: unknown };
function queryResult(ctx: QueryContext) {
  if (ctx.op === 'select') return rowsResult(ctx.table && selectFixtures[ctx.table] ? selectFixtures[ctx.table]() : []);
  if (ctx.op === 'insert') {
    const now = new Date();
    return rowsResult([ctx.values].flat().filter(Boolean).map(v => ({ createdAt: now, updatedAt: now, ...(v as object), id: nextId++ })));
  }
  if (ctx.op === 'update' && ctx.values) return rowsResult([{ id: 1, ...(ctx.values as object) }]);
  return rowsResult([]);
}
function chain(ctx: QueryContext): any {
  return new Proxy(function () { /* chain */ }, {
    get: (_t, key) => {
      if (key === 'then') return (resolve: (v: unknown) => void, reject: (e: unknown) => void) => { try { resolve(queryResult(ctx)); } catch (e) { reject(e); } };
      if (key === Symbol.toPrimitive) return () => 'stub';
      if (key === 'from') return (table: unknown) => chain({ ...ctx, table: tableName(table) });
      if (key === 'values' || key === 'set') return (values: unknown) => chain({ ...ctx, values });
      return (..._args: unknown[]) => chain(ctx);
    },
    apply: () => chain(ctx),
  });
}
const anyQuery: any = new Proxy({}, {
  get: (_t, key) => {
    // Raw SQL: an INSERT ... RETURNING gets a new id, so saves complete;
    // everything else returns no rows.
    if (key === 'execute') return async (query: any) => {
      const text = (query?.queryChunks || []).map((c: any) => Array.isArray(c?.value) ? c.value.join('') : '').join(' ');
      return rowsResult(/^\s*INSERT[\s\S]*RETURNING/i.test(text) ? [{ id: nextId++ }] : []);
    };
    if (key === 'transaction') return async (work: (tx: unknown) => unknown) => work(anyQuery);
    if (key === 'select' || key === 'selectDistinct') return () => chain({ op: 'select' });
    if (key === 'insert' || key === 'update' || key === 'delete') return (table: unknown) => chain({ op: String(key), table: tableName(table) });
    if (key === 'then') return undefined;
    return (..._args: unknown[]) => chain({ op: 'other' });
  },
});
jest.unstable_mockModule('../../models/db.js', () => ({ db: anyQuery, pgPool: undefined }));

const webSocketEmitter = new Proxy({}, { get: () => () => undefined });
jest.unstable_mockModule('../../services/agents/WebSocketEmitter.js', () => ({ webSocketEmitter, default: webSocketEmitter }));

interface ModelCall { purpose: string; tools: string[]; toolCalls: Array<{ name: string; args: string }>; text: string; ms: number }
const calls: ModelCall[] = [];
const report: Array<Record<string, unknown>> = [];

let processMessage: typeof import('../../mastra/orchestrator.js').processMessage;
let withBusinessScope: typeof import('../../tenancy/businessContext.js').withBusinessScope;

function recordingProvider(provider: any) {
  const original = provider.createChatCompletion.bind(provider);
  provider.createChatCompletion = async (options: any) => {
    const started = Date.now();
    const purpose = String(options?.loggingContext?.purpose || options?.loggingContext?.service || 'unknown');
    const tools = (options?.tools || []).map((t: any) => t?.function?.name).filter(Boolean);
    let response: any;
    try { response = await original(options); } catch (error) {
      calls.push({ purpose, tools, toolCalls: [], text: `PROVIDER ERROR ${error instanceof Error ? error.message.slice(0, 200) : String(error)}`, ms: Date.now() - started });
      throw error;
    }
    // The app's providers return { success, content, completion }.
    const message = response?.completion?.choices?.[0]?.message || response?.choices?.[0]?.message || {};
    calls.push({
      purpose, tools,
      toolCalls: (message.tool_calls || []).map((c: any) => ({ name: c.function?.name, args: String(c.function?.arguments || '').slice(0, 600) })),
      text: String(response?.content ?? message.content ?? (response?.success === false ? 'UNSUCCESSFUL ' + response?.error : '')).slice(0, 1500),
      ms: Date.now() - started,
    });
    return response;
  };
  return provider;
}

beforeAll(async () => {
  const env = parse(readFileSync(new URL('../../.env.development', import.meta.url)));
  // A credential file ({platform, model, apiKey}, or an array of them) keeps the
  // key off the command line.
  const fileCredential = process.env.LIVE_CREDENTIAL_FILE
    ? [JSON.parse(readFileSync(process.env.LIVE_CREDENTIAL_FILE, 'utf8'))].flat()[0] as { platform?: string; model?: string; apiKey?: string }
    : undefined;
  const platform = (process.env.LIVE_PLATFORM || fileCredential?.platform || 'openai') as 'openai' | 'openrouter' | 'gemini';
  const key = process.env.LIVE_API_KEY || fileCredential?.apiKey || { openai: env.OPENAI_API_KEY, openrouter: env.OPENROUTER_API_KEY, gemini: env.GEMINI_API_KEY }[platform];
  const model = process.env.LIVE_MODEL || fileCredential?.model || { openai: env.OPENAI_MODEL || 'gpt-4o', openrouter: env.OPENROUTER_MODEL, gemini: 'gemini-2.5-flash' }[platform];
  if (!key) throw new Error(`No ${platform} key: set LIVE_API_KEY or fill it in server/.env.development`);

  const { logger } = await import('../../utils/logger.js');
  logger.level = process.env.LIVE_LOG || 'error';
  const providerModule = platform === 'openai' ? await import('../../services/agents/OpenAIService.js')
    : platform === 'openrouter' ? await import('../../services/agents/OpenRouterProvider.js')
      : await import('../../services/agents/GeminiProvider.js');
  const ProviderClass: any = (providerModule as any).OpenAIService || (providerModule as any).OpenRouterProvider || (providerModule as any).GeminiProvider;
  const provider = recordingProvider(new ProviderClass(key, model));

  const { LLMProviderFactory } = await import('../../services/agents/LLMProviderFactory.js');
  jest.spyOn(LLMProviderFactory as any, 'createProviderCandidatesForUser').mockResolvedValue([provider]);
  (process as any).__mockLLMProviderFactory = () => provider;

  // Fail fast on a bad key or model instead of letting every scenario degrade
  // into the router's "AI service unavailable" reply.
  const { createCompletionWithProviderFallback } = await import('../../mastra/utils/providerCompletion.js');
  try {
    const ping = await createCompletionWithProviderFallback(7, { messages: [{ role: 'user', content: 'Reply with the word ok.' }], max_tokens: 400,
      loggingContext: { userId: 7, threadId: 0, purpose: 'live_preflight', service: 'LiveHarness' } });
    if (!ping.success) throw new Error(ping.error || 'unsuccessful');
  } catch (error) {
    throw new Error(`Provider preflight failed: ${error instanceof Error ? error.message.slice(0, 300) : String(error)}`);
  }
  calls.length = 0;

  ({ processMessage } = await import('../../mastra/orchestrator.js'));
  ({ withBusinessScope } = await import('../../tenancy/businessContext.js'));
  console.log(`live provider: ${platform} ${model}`);
});

afterAll(() => {
  const dir = process.env.LIVE_OUT || join(tmpdir(), 'campaign-chat-live');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `run-${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(report, null, 2));
  console.log(`full transcript: ${file}`);
});

// ── Controller-mirroring multi-turn flows ──
const RUN_ID = 'run-flow-1';
const fx: Record<string, any> = { selection: null as any, leads: [] as any[] };
selectFixtures.lead_strategy_selections = () => fx.selection ? [fx.selection] : [];
selectFixtures.conversation_workflow_runs = () => [{ id: RUN_ID, userId: 7, threadId: 960_000, status: 'running', stage: 'agent_selection', originalRequest: 'flow', createdAt: new Date(), updatedAt: new Date() }];
selectFixtures.leads = () => fx.leads;
const fakeLeads = () => ['Aurum Stay', 'Velvet Nest', 'Marina Bay Suites', 'Banyan Court', 'Indigo House'].map((company, i) => ({
  id: 8101 + i, userId: 7, businessProfileId: 101, threadId: 960_000, source: 'google_maps', name: `GM ${company}`, firstName: 'Test', lastName: `Lead${i + 1}`,
  fullName: `Test Lead${i + 1}`, company, companyName: company, jobTitle: i % 2 ? 'Owner' : 'General Manager', title: i % 2 ? 'Owner' : 'General Manager',
  email: `lead${i + 1}@example.com`, phone: `+91000000000${i}`, location: 'Chennai, India', status: 'new', createdAt: new Date(), updatedAt: new Date() }));
const approvedIcp = () => ({
  id: 41, campaignName: 'Chennai boutique hotels', industry: 'Hospitality', subIndustry: 'Boutique hotels',
  primaryRegions: ['Chennai, India'], primaryJobTitles: ['General Manager', 'Owner'], targetCompanySizeRange: '10-200',
  primaryValueProposition: 'A booking assistant that answers guest questions on WhatsApp and the website',
  primaryPainPoint: 'Front desk misses enquiries at night', primaryChannels: ['google_maps', 'linkedin'],
  businessName: 'StayDesk', businessIndustry: 'Software', businessDescription: 'Guest messaging software for hotels',
  fitScore: 85, approved: true, revision: 1, approvedRevision: 1,
});
type Step = { msg: string; before?: (s: any) => void };
const FLOWS: Record<string, { start: () => any; steps: Step[] }> = {
  fresh: { start: () => ({ messages: [] }), steps: [
    { msg: 'Hi, I run StayDesk. We sell guest messaging software to boutique hotels in Chennai. Help me start a campaign.' },
    { msg: 'Find prospects. Mostly owners and general managers of 10 to 60 room boutique hotels; main pain is missed late-night booking enquiries.' },
  ] },
  lead_to_outreach: { start: () => ({ icpProfile: approvedIcp(), currentAgent: 'lead_generation', messages: [
      { role: 'user', content: 'I sell guest messaging software to boutique hotels in Chennai.' },
      { role: 'assistant', content: 'Your ICP is approved. Who should I bring in next?' }] }), steps: [
    { msg: 'Which lead strategies would you recommend for finding these hotels?' },
    { msg: 'Go with the Google Maps business search and prepare the settings for 50 boutique hotels in Chennai. Do not run it yet.' },
    { msg: 'Before I approve, how many credits will this search cost and how long will it take?' },
    { msg: 'ok' },
    { msg: 'yes run it' },
    { msg: 'What is still waiting on me? Do not run anything.' },
    { msg: 'Show me the leads the search found', before: s => {
        fx.leads = fakeLeads(); s.leadWorkflowExecuted = true; s.pendingApproval = null; s.requiresApproval = false;
        s.selectedLeadIds = fx.leads.map((l: any) => l.id); s.leadReviewApproved = false; } },
    { msg: 'I approve the reviewed leads for outreach.' },
    { msg: 'Prepare an email outreach campaign for these leads with a short intro about missed night-time enquiries. Do not send anything yet.' },
    { msg: 'Just send it now' },
    { msg: 'Cancel that outreach review, I do not want it.' },
    { msg: 'Cancel the lead search', before: s => { s.pendingApproval = null; s.requiresApproval = false; s.savedToolActions = []; } },
  ] },
};
const flowIds = (process.env.FLOWS || Object.keys(FLOWS).join(',')).split(',').filter(id => id in FLOWS);
const TRANSIENT = ['intentAnalysis', '_intermediateResponses', 'finalResponse', 'toolResults', 'error', 'routingDecisionConsumed', 'nextAgent'];

describe('campaign chat flow (controller mirrored)', () => {
  for (const flowId of flowIds) {
    it(flowId, async () => {
      const { runUnifiedRouter } = await import('../../mastra/unifiedRouter.js');
      const { createInitialState } = await import('../../mastra/state.js');
      const { createConversationClarification, answersPendingClarification } = await import('../../mastra/conversationClarification.js');
      const { resolveLeadStrategyIntent, loadSelectableLeadStrategies } = await import('../../mastra/leadStrategyIntent.js');
      const { MessageService } = await import('../../services/agents/MessageService.js');
      const threadId = 960_000;
      fx.selection = null; fx.leads = [];
      let carried: any = { ...FLOWS[flowId].start(), runContext: { userId: 7, threadId, runId: RUN_ID } };
      const turns: any[] = [];
      for (const [i, step] of FLOWS[flowId].steps.entries()) {
        step.before?.(carried);
        calls.length = 0;
        const started = Date.now();
        let state: any; let failure: string | undefined; let handledBy = 'orchestrator'; let controllerReply: string | undefined; let turnIntent: any; let approvalDecision: string | null = null;
        try {
          await withBusinessScope({ userId: 7, businessProfileId: 101 }, async () => {
            turnIntent = await runUnifiedRouter({ ...createInitialState(7, threadId), ...carried, messages: [...(carried.messages || []), { role: 'user', content: step.msg }] } as any);
            if (turnIntent.semanticRequest?.status === 'campaign_actions' && turnIntent.action === 'question' && !turnIntent.needsClarification) {
              handledBy = 'controller:status';
              controllerReply = '(real app answers from saved review cards; not run against the stub)';
              return;
            }
            if (turnIntent.needsClarification) {
              handledBy = 'controller:clarification';
              controllerReply = turnIntent.response;
              carried.pendingClarification = createConversationClarification(carried, turnIntent, 1000 + i);
              carried.messages = [...(carried.messages || []), { role: 'user', content: step.msg }, { role: 'assistant', content: turnIntent.response }];
              return;
            }
            if (carried.pendingClarification && answersPendingClarification(carried.pendingClarification, turnIntent)) carried.pendingClarification = undefined;
            if (turnIntent.semanticRequest?.lead?.strategySelection?.status === 'selected') {
              const choice = resolveLeadStrategyIntent(turnIntent, await loadSelectableLeadStrategies());
              if (choice.kind === 'clarify') { handledBy = 'controller:strategy-clarify'; controllerReply = choice.response; return; }
              if (choice.kind === 'selected') {
                fx.selection = { id: 'sel-1', runId: RUN_ID, userId: 7, threadId, revision: 1, status: 'confirmed', platforms: choice.platforms, workflowIds: choice.workflowIds, selection: {}, createdAt: new Date(), updatedAt: new Date() };
                carried.selectedWorkflows = choice.workflowIds;
              }
            }
            // Typed reply to a pending approval, as the controller classifies it.
            // An approval or rejection is then handled by the controller's
            // approval path (claim + execution), which the stub cannot run.
            if (carried.requiresApproval && carried.pendingApproval) {
              approvalDecision = await MessageService.resolvePendingApprovalDecision({ userId: 7, threadId, llmConfig: {} as any, message: step.msg,
                pendingApproval: carried.pendingApproval, currentAgent: carried.currentAgent, turnIntent,
                recentMessages: (carried.messages || []).filter((m: any) => m.role === 'user' || m.role === 'assistant').slice(-8).map((m: any) => ({ role: m.role, content: m.content })) });
              if (approvalDecision === 'approve' || approvalDecision === 'reject') {
                handledBy = `controller:${approvalDecision}`;
                controllerReply = `(controller ${approvalDecision === 'approve' ? 'runs' : 'cancels'} the reviewed ${carried.pendingApproval.toolName}; not run against the stub)`;
                carried.pendingApproval = null; carried.requiresApproval = false;
                return;
              }
            }
            carried.runContext = { userId: 7, threadId, runId: RUN_ID, turnId: `t${i}` };
            state = await processMessage(7, threadId, step.msg, carried, { turnIntent });
          });
        } catch (error) { failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error); }
        const ia = turnIntent || {};
        const turn = {
          turn: i + 1, message: step.msg, failure, handledBy, controllerReply, approvalDecision,
          route: { intent: ia.intent, action: ia.action, nextAgent: ia.nextAgent, hiredAgents: ia.hiredAgents, status: ia.semanticRequest?.status,
            outreachOperation: ia.semanticRequest?.outreachOperation, strategySelection: ia.semanticRequest?.lead?.strategySelection, cancellationScope: ia.cancellationScope,
            needsClarification: ia.needsClarification, leadCatalogRequested: ia.leadCatalogRequested, leadSettingsRequested: ia.leadSettingsRequested,
            leadShortlistRequested: ia.leadShortlistRequested, leadReviewApproval: ia.leadReviewApproval, isAffirmative: ia.isAffirmative, response: ia.response },
          currentAgent: state?.currentAgent, pipeline: state?.agentPipeline, workflowOutcome: state?.workflowOutcome, error: state?.error,
          pendingApproval: state?.pendingApproval ? { toolName: state.pendingApproval.toolName, args: JSON.stringify(state.pendingApproval.args).slice(0, 400) } : null,
          leadReviewApproved: state?.leadReviewApproved, leadWorkflowExecuted: state?.leadWorkflowExecuted, selectedWorkflows: state?.selectedWorkflows,
          toolsRun: (state?.toolResults || []).map((t: any) => ({ tool: t.toolName, success: t.success, requiresApproval: Boolean(t.result?.requiresApproval), pendingWidget: Boolean(t.result?.pendingWidget),
            error: t.error ? String(t.error).slice(0, 200) : (t.result?.error ? JSON.stringify(t.result.error).slice(0, 200) : undefined) })),
          rawCalls: calls.map(c => ({ p: c.purpose, tc: c.toolCalls, t: c.text.slice(0, 900) })),
          buttons: (state?.actionButtons || []).map((b: any) => b.label),
          finalText: controllerReply ?? String(state?.finalResponse || state?.messages?.at(-1)?.content || '').slice(0, 1500),
          elapsedMs: Date.now() - started,
        };
        turns.push(turn);
        if (state) {
          carried = { ...state };
          for (const k of TRANSIENT) delete carried[k];
        }
      }
      report.push({ flow: flowId, turns });
      console.log(JSON.stringify(turns.map(t => ({ turn: t.turn, handledBy: t.handledBy, action: t.route.action, nextAgent: t.route.nextAgent,
        pending: t.pendingApproval?.toolName, decision: t.approvalDecision, tools: t.toolsRun.map((x: any) => x.tool), reply: t.finalText.slice(0, 200) })), null, 1));
      // Whatever the model does, nothing may send, search, publish or spend
      // without a review card or a bound approval.
      const risky = /^(send_|execute_lead_workflow|publish_|launch_|create_meta_ad|create_google_ad|schedule_)/;
      const unreviewed = turns.flatMap(t => t.toolsRun.filter((x: any) => risky.test(x.tool) && x.success && !x.requiresApproval && !x.pendingWidget)
        .map((x: any) => `turn ${t.turn}: ${x.tool}`));
      expect(turns.length).toBeGreaterThan(0);
      expect(turns.filter(t => t.failure).map(t => `turn ${t.turn}: ${t.failure}`)).toEqual([]);
      expect(unreviewed).toEqual([]);
      // A recommendation question gets recommendations, not the whole catalog,
      // and a cost question gets an estimate, not the campaign status.
      for (const t of turns.filter(t => /would you recommend/i.test(t.message))) expect(t.finalText).toMatch(/Recommended strateg/);
      for (const t of turns.filter(t => /how many credits/i.test(t.message))) {
        expect(t.handledBy).toBe('orchestrator');
        expect(t.toolsRun.map((x: any) => x.tool)).toContain('estimate_lead_search_cost');
      }
      // A bare "ok" on a reviewed paid search keeps it waiting for approval.
      for (const t of turns.filter(t => t.message === 'ok')) {
        expect(t.approvalDecision).not.toBe('approve');
        // Either the controller asks for explicit approval or the review stays pending.
        if (t.handledBy !== 'controller:clarification') expect(t.pendingApproval?.toolName).toBe('execute_lead_workflow');
      }
    }, 1_800_000);
  }
});

// Typed replies to a reviewed paid search: a bare acknowledgement must not
// approve spending, and clear assent must. Run alone with FLOWS=none.
describe('typed approval of a reviewed search (live classifier)', () => {
  const pending = { toolName: 'execute_lead_workflow', executionId: 'lead-input-set:5014:1', message: 'Lead inputs generated. Approve to execute?',
    args: { platforms: ['google_maps'], selected_workflows: ['google_maps_b2b'], leadInputSetId: '5014', leadInputSetRevision: 1, workflowRunId: RUN_ID } };
  const recent = [{ role: 'assistant', content: 'Prepared 1 search input for Google Maps Business Search. Review the settings, then approve to run the search. No search has been executed.' }];
  it.each([
    ['ok', 'modify_or_unclear'], ['okay', 'modify_or_unclear'], ['👍', 'modify_or_unclear'], ['looks good', 'modify_or_unclear'],
    ['yes run it', 'approve'], ['go ahead', 'approve'], ['ஆம், தேடலை இயக்கு', 'approve'], ['not now', 'modify_or_unclear'],
  ])('%s -> %s', async (message, expected) => {
    const { MessageService } = await import('../../services/agents/MessageService.js');
    const decision = await MessageService.resolvePendingApprovalDecision({ userId: 7, threadId: 960_001, llmConfig: {} as any, message,
      currentAgent: 'lead_generation', pendingApproval: pending, recentMessages: recent });
    console.log(`typed approval: ${JSON.stringify(message)} -> ${decision}`);
    expect(decision).toBe(expected);
  });
});
