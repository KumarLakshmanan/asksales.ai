/**
 * Live-model run of the campaign chat: real router, orchestrator, specialist
 * prompts, tool schemas and tool loop, against a real provider. The database is
 * the jest stub from models/db.ts (every query returns no rows), so saved data
 * is always empty. Nothing is sent, published or charged; provider calls are
 * billable on the key in server/.env.development.
 *
 * Not part of the default suite. Run with:
 *   NODE_OPTIONS=--experimental-vm-modules npx jest --testMatch '**' + '/tests/live/*.live.ts' --runInBand
 * Key: LIVE_CREDENTIAL_FILE (JSON {platform, model, apiKey}), else LIVE_API_KEY,
 * else the platform's key in server/.env.development.
 * Optional: LIVE_SCENARIOS=id1,id2  LIVE_PLATFORM=openai|openrouter|gemini  LIVE_MODEL=<model>  LIVE_OUT=<dir>
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from 'dotenv';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scenarios, type LiveScenario } from './campaignChatScenarios.js';

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
    if (key === 'execute') return async () => rowsResult([]);
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

const selected = (process.env.LIVE_SCENARIOS || '').split(',').map(s => s.trim()).filter(Boolean);
const toRun = selected.length ? scenarios.filter(s => selected.includes(s.id)) : scenarios;

async function runScenario(scenario: LiveScenario) {
  calls.length = 0;
  const started = Date.now();
  const threadId = 900_000 + toRun.indexOf(scenario);
  let state: any; let failure: string | undefined;
  try {
    state = await withBusinessScope({ userId: 7, businessProfileId: 101 },
      () => processMessage(7, threadId, scenario.message, scenario.state()));
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const replies = [
    ...((state?._intermediateResponses || []) as any[]).map(r => ({ agent: r.agentType, text: String(r.content || '').slice(0, 500) })),
  ];
  const finalText = String(state?.finalResponse || state?.messages?.at(-1)?.content || '').slice(0, 800);
  const outcome = {
    id: scenario.id,
    message: scenario.message,
    failure,
    route: state?.intentAnalysis ? {
      action: state.intentAnalysis.action, intent: state.intentAnalysis.intent, nextAgent: state.intentAnalysis.nextAgent,
      mode: state.intentAnalysis.mode, hiredAgents: state.intentAnalysis.hiredAgents, savedDataLookup: state.intentAnalysis.savedDataLookup,
      leadReviewApproval: state.intentAnalysis.leadReviewApproval, needsClarification: state.intentAnalysis.needsClarification,
      cancellationScope: state.intentAnalysis.cancellationScope, cancellationReviewId: state.intentAnalysis.cancellationReviewId,
    } : null,
    currentAgent: state?.currentAgent,
    pipeline: state?.agentPipeline, pipelineIndex: state?.agentPipelineIndex, deferredPipeline: state?.deferredLeadReviewPipeline,
    workflowOutcome: state?.workflowOutcome, error: state?.error,
    pendingApproval: state?.pendingApproval ? { toolName: state.pendingApproval.toolName, args: state.pendingApproval.args } : null,
    toolsRun: (state?.toolResults || []).map((t: any) => ({ tool: t.toolName, success: t.success, code: t.result?.code || t.result?.error?.code,
      reviewOnly: Boolean(t.result?.pendingWidget || t.result?.requiresApproval || ['requires_review', 'pending_review', 'awaiting_approval'].includes(t.result?.output?.status)) })),
    modelCalls: calls.map(c => ({ ...c })),
    replies, finalText,
    elapsedMs: Date.now() - started,
  };
  report.push(outcome);
  return { outcome, state };
}

describe('campaign chat with a live model', () => {
  for (const scenario of toRun) {
    it(scenario.id, async () => {
      const { outcome, state } = await runScenario(scenario);
      console.log(JSON.stringify({ id: outcome.id, failure: outcome.failure, error: outcome.error, route: outcome.route, currentAgent: outcome.currentAgent,
        pipeline: outcome.pipeline, pendingApproval: outcome.pendingApproval?.toolName, toolsRun: outcome.toolsRun.map((t: any) => t.tool),
        modelCalls: outcome.modelCalls.map(c => `${c.purpose}${c.toolCalls.length ? ' -> ' + c.toolCalls.map(t => t.name).join('+') : ''}`),
        finalText: outcome.finalText.slice(0, 300) }, null, 1));
      const problems = outcome.failure ? [`threw ${outcome.failure}`] : scenario.check(state, outcome);
      expect(problems).toEqual([]);
    });
  }
});
