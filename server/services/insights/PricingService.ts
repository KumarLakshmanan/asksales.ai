import { calcPrice, findProvider } from '@pydantic/genai-prices';
import { getAllApiPricing, getApiPricingByKey } from '../../models/apiPricing/functions.js';
import { getModelPrice } from '../GenAIPricingService.js';
import { getRechargeRate, getUsageRate } from '../../models/creditPricing/functions.js';
import { getUsdToInrRate } from '../../utils/currency.js';
import { currentUsageContext } from './UsageContext.js';
import { getInsightsRuntime } from './RuntimeService.js';
import type { InsightsPricingSnapshot } from '../../../shared/insightsBilling.js';

export class PricingUnavailableError extends Error {
  readonly code = 'PRICING_UNAVAILABLE';
  readonly statusCode = 409;
  constructor(readonly model: string, readonly provider: string) {
    super(`Pricing is not configured for ${model}. Ask an administrator to configure its rate.`);
  }
}
export interface VerifiedModelRate {
  model: string; provider: string; input: number; output: number; cachedInput?: number; audioInput?: number;
  source: 'catalog' | 'admin_override'; sourceReference: string; catalogModel?: string;
}
/** Published Standard rates; no wildcard fallback to another model's price.
 * Source verified 2026-09-29: https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite
 */
const verifiedGoogleRates: Record<string, { input: number; output: number; cachedInput: number; audioInput: number }> = {
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cachedInput: 0.025, audioInput: 0.5 },
  'gemini-3.1-flash-lite-preview': { input: 0.25, output: 1.5, cachedInput: 0.025, audioInput: 0.5 },
};
const verifiedEmbeddingRates: Record<string, Record<string, { input: number; sourceReference: string }>> = {
  openai: {
    'text-embedding-3-small': { input: 0.02, sourceReference: 'https://developers.openai.com/api/docs/models/text-embedding-3-small@2026-09-29' },
    'text-embedding-3-large': { input: 0.13, sourceReference: 'https://developers.openai.com/api/docs/models/text-embedding-3-large@2026-09-29' },
  },
  gemini: { 'gemini-embedding-001': { input: 0.15, sourceReference: 'https://ai.google.dev/gemini-api/docs/pricing@2026-09-29' } },
};
function nonnegative(value: unknown): number | undefined {
  const number = Number(value);
  return value !== null && value !== undefined && Number.isFinite(number) && number >= 0 ? number : undefined;
}
export function modelCandidates(model: string, provider?: string): string[] {
  const candidates = [model.trim()];
  if (model.startsWith('models/')) candidates.push(model.slice(7));
  if (model.startsWith('google/') && provider !== 'openrouter') candidates.push(model.slice(7));
  // OpenRouter rates are not interchangeable with a direct provider's rates.
  return [...new Set(candidates)];
}
export async function resolveVerifiedModelRate(model: string, provider: string, kind: 'text' | 'embedding' = 'text'): Promise<VerifiedModelRate | null> {
  const candidates = modelCandidates(model, provider);
  const entries = await getAllApiPricing();
  const override = entries.find(entry => entry.isActive && entry.provider === provider
    && candidates.includes(String(entry.metadata?.model || entry.pricingKey.replace(/^llm_model:/, '')))
    && entry.category === (kind === 'embedding' ? 'embedding' : 'llm') && entry.metadata?.verified === true);
  if (override) {
    const input = nonnegative(override.metadata?.inputUsdPerMillion ?? override.originalPromptCostPerMillion ?? override.promptCostPerMillion);
    const output = nonnegative(override.metadata?.outputUsdPerMillion ?? override.originalCompletionCostPerMillion ?? override.completionCostPerMillion);
    if (input !== undefined && output !== undefined) {
      return { model, provider, input, output, cachedInput: nonnegative(override.metadata?.cachedInputUsdPerMillion),
        audioInput: nonnegative(override.metadata?.audioInputUsdPerMillion), source: 'admin_override',
        sourceReference: `api_pricing:${override.id}:${override.updatedAt.toISOString()}` };
    }
  }
  if (kind === 'text' && provider === 'gemini') {
    const published = candidates.map(candidate => verifiedGoogleRates[candidate]).find(Boolean);
    if (published) return { model, provider, ...published, source: 'catalog',
      sourceReference: 'https://ai.google.dev/gemini-api/docs/pricing#gemini-3.1-flash-lite@2026-09-29' };
  }
  const embedding=kind === 'embedding' ? verifiedEmbeddingRates[provider]?.[model] : undefined;
  if(embedding)return { model,provider,input:embedding.input,output:0,source:'catalog',sourceReference:embedding.sourceReference };
  if (kind === 'embedding') return null;
  const catalogProvider={openai:'openai',gemini:'google',openrouter:'openrouter'}[provider];
  const catalogModels=catalogProvider?findProvider({providerId:catalogProvider})?.models:undefined;
  for (const candidate of candidates) {
    const rate = getModelPrice(candidate);
    if (rate && catalogModels?.some(entry=>entry.id===candidate)) return { model, provider, input: rate.inputPerMillion, output: rate.outputPerMillion,
      source: 'catalog', sourceReference: '@pydantic/genai-prices', catalogModel: candidate };
  }
  return null;
}
export async function embeddingPricingSnapshot(model:string,provider:string):Promise<InsightsPricingSnapshot|undefined>{
  const rate=await resolveVerifiedModelRate(model,provider,'embedding');
  if(!rate){if((await getInsightsRuntime()).pricingGuardEnabled)throw new PricingUnavailableError(model,provider);return undefined;}
  const margin=await getApiPricingByKey('embedding_margin');
  return {version:1,capturedAt:new Date().toISOString(),source:rate.source,sourceReference:rate.sourceReference,
    model,provider,inputUsdPerMillion:rate.input,outputUsdPerMillion:0,
    marginPercentage:margin?.isActive===false?0:nonnegative(margin?.marginPercentage)??0,
    usdToInr:getUsdToInrRate(),creditsPerInr:await getRechargeRate(),usageCreditsPerInr:await getUsageRate(),minimumCredits:1,rounding:'ceil_whole'};
}
export async function assertMediaPrice(model:string,provider:string,kind:'image'|'video'):Promise<void>{
  if(!(await getInsightsRuntime()).pricingGuardEnabled)return;
  const entries=await getAllApiPricing();
  const verified=entries.some(entry=>entry.isActive&&entry.provider===provider&&entry.category===kind
    && entry.metadata?.verified===true&&entry.metadata?.model===model
    // A verified base unit covers requests whose resolution is chosen by the provider.
    // Optional tier overrides refine it; a tier-only record would leave other requests unpriced.
    && nonnegative(entry.metadata?.unitUsd)!==undefined);
  if(!verified)throw new PricingUnavailableError(model,provider);
}
export async function llmPricingSnapshot(model: string, provider: string): Promise<InsightsPricingSnapshot | undefined> {
  const rate = await resolveVerifiedModelRate(model, provider);
  if (!rate) {
    if ((await getInsightsRuntime()).pricingGuardEnabled) throw new PricingUnavailableError(model, provider);
    return undefined; // Compatibility only while the audited rollout is disabled.
  }
  const margin = await getApiPricingByKey('llm_margin');
  return { version: 1, capturedAt: new Date().toISOString(), source: rate.source, sourceReference: rate.sourceReference,
    model, provider, inputUsdPerMillion: rate.input, outputUsdPerMillion: rate.output, cachedInputUsdPerMillion: rate.cachedInput,
    audioInputUsdPerMillion: rate.audioInput,
    marginPercentage: margin?.isActive === false ? 0 : nonnegative(margin?.marginPercentage) ?? 0,
    usdToInr: getUsdToInrRate(), creditsPerInr: await getRechargeRate(), usageCreditsPerInr: await getUsageRate(), minimumCredits: 1, rounding: 'ceil_whole' };
}
export async function calculateMeteredLLMCost(model: string, tokens: { promptTokens: number; completionTokens: number; totalTokens?: number }, original = false): Promise<number> {
  const context = currentUsageContext();
  const provider = context?.provider || 'openai';
  const snapshot = context?.pricing || await llmPricingSnapshot(model, provider);
  const input = Math.max(0, tokens.promptTokens);
  const output = Math.max(0, tokens.completionTokens);
  const cached = Math.min(input, context?.cachedTokens || 0);
  const audio = Math.min(input - cached, context?.inputAudioTokens || 0);
  let baseUsd = 0;
  if (snapshot) {
    if (snapshot.sourceReference === '@pydantic/genai-prices') {
      for (const candidate of modelCandidates(model, provider)) {
        const result = calcPrice({ input_tokens: input - cached - audio, output_tokens: output,
          cache_read_tokens: cached, input_audio_tokens: audio }, candidate);
        if (result) { baseUsd = result.total_price; break; }
      }
    } else {
      baseUsd = ((input - cached - audio) * (snapshot.inputUsdPerMillion || 0)
        + cached * (snapshot.cachedInputUsdPerMillion ?? snapshot.inputUsdPerMillion ?? 0)
        + audio * (snapshot.audioInputUsdPerMillion ?? snapshot.inputUsdPerMillion ?? 0)
        + output * (snapshot.outputUsdPerMillion || 0)) / 1_000_000;
    }
    if (!input && !output && (tokens.totalTokens || 0) > 0) {
      baseUsd = (tokens.totalTokens || 0) * ((snapshot.inputUsdPerMillion || 0) + (snapshot.outputUsdPerMillion || 0)) / 2_000_000;
    }
    const chargedUsd = baseUsd * (1 + (snapshot.marginPercentage || 0) / 100);
    if (context) context.pricing = { ...snapshot, providerCostUsd: baseUsd.toFixed(10), chargedCostUsd: chargedUsd.toFixed(10) };
    return (original ? baseUsd : chargedUsd) * 100;
  }
  // Old pricing remains available only until the forward-only guard is enabled.
  const base = ((input * 2.5) + (output * 10)) / 1_000_000;
  return base * 100;
}
