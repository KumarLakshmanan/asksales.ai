import {
  getAllActiveAdminCredentials,
  updateAdminCredentialLastUsed,
} from '../../models/adminApiCredentials/functions.js';
import { createOpenAIUsage } from '../../models/openaiUsages/functions.js';
import { getInsightsRuntime } from '../insights/RuntimeService.js';
import { llmPricingSnapshot } from '../insights/PricingService.js';
import { configString, calculateCost, jsonRequest, type CredentialConfig } from './providerRequest.js';
import { assistantModelProviderLabels, platformAIQuotaMessage } from '../../../shared/assistantModelCatalog.js';
import { quotaDisabledAIProviders } from '../assistants/AssistantModelCatalogService.js';

/** The AI engines each GEO question is put to. All four are asked through OpenRouter. */
export const AI_VISIBILITY_OBSERVATION_PROVIDERS = ['openai', 'gemini', 'perplexity', 'claude'] as const;
export type ObservationProvider = (typeof AI_VISIBILITY_OBSERVATION_PROVIDERS)[number];

export interface ProviderObservation {
  provider: ObservationProvider;
  model: string;
  fidelity: 'live_api';
  status: 'completed' | 'failed';
  answer?: string;
  citations: Array<{ url: string; title?: string }>;
  inputTokens?: number;
  outputTokens?: number;
  costCents: number;
  error?: string;
}

function uniqueCitations(
  values: Array<{ url?: unknown; title?: unknown }>,
): Array<{ url: string; title?: string }> {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    if (typeof value.url !== 'string' || !/^https?:\/\//i.test(value.url) || seen.has(value.url))
      return [];
    seen.add(value.url);
    return [
      {
        url: value.url,
        ...(typeof value.title === 'string' ? { title: value.title } : {}),
      },
    ];
  });
}

const GROUNDING_REDIRECT_HOST = 'vertexaisearch.cloud.google.com';

/**
 * Gemini's Google Search grounding cites `vertexaisearch.cloud.google.com/grounding-api-redirect/…`
 * links instead of the pages themselves. Citation analysis compares domains, so follow each
 * redirect once to store the real page. A link that can't be resolved is kept as it was.
 */
export async function resolveGroundingRedirects(
  citations: Array<{ url: string; title?: string }>,
  fetcher: typeof fetch = fetch,
): Promise<Array<{ url: string; title?: string }>> {
  const resolved = await Promise.all(
    citations.map(async (citation) => {
      let host = '';
      try {
        host = new URL(citation.url).hostname;
      } catch {
        return citation;
      }
      if (host !== GROUNDING_REDIRECT_HOST) return citation;
      try {
        const response = await fetcher(citation.url, {
          method: 'GET',
          redirect: 'manual',
          signal: AbortSignal.timeout(5_000),
        });
        const location = response.headers.get('location');
        const target = location ? new URL(location, citation.url) : null;
        return target && /^https?:$/.test(target.protocol) && target.hostname !== GROUNDING_REDIRECT_HOST
          ? { ...citation, url: target.href }
          : citation;
      } catch {
        return citation;
      }
    }),
  );
  return uniqueCitations(resolved);
}

/**
 * Each engine is asked through OpenRouter with web search on, so it searches the way it does
 * for its own users (OpenAI, Google and Anthropic models use their own search there; Perplexity
 * always searches). Admins can change any model on the OpenRouter credential.
 *
 * `lowReasoning`: GPT-6 and Claude 5 think before answering. At their default effort the thinking
 * used most of the token budget and the answer was cut off; low effort answers in full in
 * 15 to 20 seconds.
 */
const OPENROUTER_MODEL: Record<ObservationProvider, { key: string; fallback: string; lowReasoning?: boolean }> = {
  openai: { key: 'aiVisibilityOpenAiModel', fallback: 'openai/gpt-6-luna', lowReasoning: true },
  gemini: { key: 'aiVisibilityGeminiModel', fallback: 'google/gemini-3.1-flash-lite' },
  perplexity: { key: 'aiVisibilityPerplexityModel', fallback: 'perplexity/sonar' },
  claude: { key: 'aiVisibilityClaudeModel', fallback: 'anthropic/claude-haiku-5.5', lowReasoning: true },
};

export function openRouterModel(provider: ObservationProvider, config: CredentialConfig) {
  const { key, fallback } = OPENROUTER_MODEL[provider];
  return configString(config, key, fallback);
}

const NOT_CONFIGURED =
  'An AskSales administrator needs to add an OpenRouter API key before AI engines can be asked.';

/** OpenRouter reports the billed amount in US dollars; fall back to configured token rates. */
function openRouterCostCents(
  usage: Record<string, unknown>,
  config: CredentialConfig,
  inputTokens?: number,
  outputTokens?: number,
): number {
  const billedDollars = Number(usage.cost);
  return Number.isFinite(billedDollars) && billedDollars >= 0
    ? billedDollars * 100
    : calculateCost(config, inputTokens, outputTokens);
}

export class ProviderObservationService {
  async readiness() {
    const models = await Promise.all(AI_VISIBILITY_OBSERVATION_PROVIDERS.map(provider => this.getConfiguredModel(provider)));
    const quotaProviders = models.includes(null)
      ? await quotaDisabledAIProviders(['openrouter'])
      : [];
    return AI_VISIBILITY_OBSERVATION_PROVIDERS.map((provider, index) => {
        const model = models[index];
        const affected = quotaProviders.filter(label => label === assistantModelProviderLabels.openrouter);
        const quotaBlocked = model === null && affected.length > 0;
        return {
          provider,
          model,
          configured: model !== null,
          status: model ? 'configured' : 'unavailable',
          quotaBlocked,
          reason: model
            ? 'It is asked in the next analysis. Whether it answers is known only once that analysis runs.'
            : quotaBlocked ? platformAIQuotaMessage(affected) : NOT_CONFIGURED,
        };
    });
  }

  private async openRouterCredentials() {
    return (await getAllActiveAdminCredentials('openrouter')).filter((credential) =>
      Boolean(credential.apiKey?.trim()),
    );
  }

  async getConfiguredModel(provider: ObservationProvider): Promise<string | null> {
    const [openRouter] = await this.openRouterCredentials();
    return openRouter
      ? `${openRouterModel(provider, openRouter.config as CredentialConfig)} via openrouter`
      : null;
  }

  async collect(
    provider: ObservationProvider,
    prompt: string,
    locale: string,
    context: { userId: number; auditId: number },
  ): Promise<ProviderObservation> {
    const attempts = await this.openRouterCredentials();
    if (!attempts.length) {
      return {
        provider,
        model: 'unconfigured',
        fidelity: 'live_api',
        status: 'failed',
        citations: [],
        costCents: 0,
        error: NOT_CONFIGURED,
      };
    }
    const failures: string[] = [];
    let lastFailure: ProviderObservation | null = null;
    for (const [credentialIndex, credential] of attempts.entries()) {
      const startedAt = Date.now();
      let observation: ProviderObservation;
      const config = credential.config as CredentialConfig;
      const requestedModel = openRouterModel(provider, config);
      try {
        if ((await getInsightsRuntime()).pricingGuardEnabled)
          await llmPricingSnapshot(requestedModel, 'openrouter');
        observation = await this.viaOpenRouter(provider, credential.apiKey, config, prompt, locale);
      } catch (error) {
        const message = error instanceof Error ? error.message : `${provider} request failed`;
        failures.push(message);
        observation = {
          provider,
          model: `${requestedModel} via openrouter`,
          fidelity: 'live_api',
          status: 'failed',
          citations: [],
          costCents: 0,
          error: message,
        };
        lastFailure = observation;
      }
      await Promise.allSettled([
        updateAdminCredentialLastUsed(credential.id),
        createOpenAIUsage({
          userId: context.userId,
          model: observation.model,
          provider,
          purpose: 'ai_visibility_provider_observation',
          service: 'AIVisibilityAudit',
          action: `Audit ${context.auditId} provider observation`,
          promptTokens: observation.inputTokens,
          completionTokens: observation.outputTokens,
          totalTokens: (observation.inputTokens || 0) + (observation.outputTokens || 0),
          estimatedCostCents: observation.costCents,
          requestSummary: `AI Visibility ${provider} observation (${locale})`,
          responseSuccess: observation.status === 'completed' ? 1 : 0,
          errorMessage: observation.error,
          durationMs: Date.now() - startedAt,
          metadata: {
            auditId: context.auditId,
            fidelity: observation.fidelity,
            citationCount: observation.citations.length,
            credentialAttempt: credentialIndex + 1,
            credentialCount: attempts.length,
            transport: 'openrouter',
          },
        }),
      ]);
      if (observation.status === 'completed') return observation;
    }
    return {
      ...(lastFailure || {
        provider,
        model: 'unknown',
        fidelity: 'live_api' as const,
        citations: [],
        costCents: 0,
      }),
      status: 'failed',
      error: [...new Set(failures)].join(' | ') || `${provider} request failed`,
    };
  }

  private async viaOpenRouter(
    provider: ObservationProvider,
    apiKey: string,
    config: CredentialConfig,
    prompt: string,
    locale: string,
  ): Promise<ProviderObservation> {
    const requestedModel = openRouterModel(provider, config);
    const data = await jsonRequest('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://asksales.ai',
        'X-Title': 'AskSales AI Visibility',
      },
      body: JSON.stringify({
        model: requestedModel,
        messages: [
          {
            role: 'user',
            content: `Answer for a user whose locale is ${locale}. Use current web sources where available.\n\n${prompt}`,
          },
        ],
        // The provider's own search where OpenRouter supports it, otherwise OpenRouter's.
        plugins: [{ id: 'web', max_results: 5 }],
        max_tokens: 6000,
        ...(OPENROUTER_MODEL[provider].lowReasoning ? { reasoning: { effort: 'low' } } : {}),
      }),
    });
    const choices = Array.isArray(data.choices) ? (data.choices as Array<Record<string, unknown>>) : [];
    const message = (choices[0]?.message || {}) as Record<string, unknown>;
    const answer = typeof message.content === 'string' ? message.content : '';
    if (!answer.trim()) throw new Error(`OpenRouter returned no ${provider} answer.`);
    const annotations = Array.isArray(message.annotations)
      ? (message.annotations as Array<Record<string, unknown>>)
      : [];
    const citations = await resolveGroundingRedirects(
      uniqueCitations(
        annotations.map((annotation) => {
          const citation = (annotation.url_citation || {}) as Record<string, unknown>;
          return { url: citation.url, title: citation.title };
        }),
      ),
    );
    const usage = (data.usage || {}) as Record<string, unknown>;
    const inputTokens = Number(usage.prompt_tokens || 0) || undefined;
    const outputTokens = Number(usage.completion_tokens || 0) || undefined;
    const servedModel =
      typeof data.model === 'string' && data.model.trim() ? data.model.trim() : requestedModel;
    return {
      provider,
      model: `${servedModel} via openrouter`,
      fidelity: 'live_api',
      status: 'completed',
      answer,
      citations,
      inputTokens,
      outputTokens,
      costCents: openRouterCostCents(usage, config, inputTokens, outputTokens),
    };
  }
}

export const providerObservationService = new ProviderObservationService();
